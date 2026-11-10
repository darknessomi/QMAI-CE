/**
 * 工程备份编排。
 *
 * 这里守的是几条「出错代价很高」的行为：
 *   · 只同步文本，别把图片/依赖目录也传上去吃配额
 *   · 单个文件失败不能中断整次备份
 *   · 文件数/体积上限要生效，否则误选一个巨大目录会卡死
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

import { testManifest, testFile, testReceipt, testStamp } from "./test-fixtures"

import type { FileNode } from "@/types/wiki"

const mockListDirectory = vi.fn()
const mockReadFile = vi.fn()

vi.mock("@/commands/fs", () => ({
  listDirectory: (...args: unknown[]) => mockListDirectory(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}))

/*
 * 注意：必须把 SyncError 一起 mock 出来。
 * backup.ts 用它区分「服务端明确拒绝」和「传输层抖动」来决定要不要重试，
 * 漏掉这个导出会让所有上传错误都变成
 * `[vitest] No "SyncError" export is defined on the mock`，
 * 从而掩盖真正的错误信息。
 */
vi.mock("./client", async () => {
  const actual = await vi.importActual<typeof import("./client")>("./client")
  return {
    ...actual,
    uploadSyncFile: vi.fn(),
    fetchSyncManifest: async (_base: string, _card: string, projectId: string) => testManifest(projectId),
    SyncError: actual.SyncError,
  }
})

import { backupProject, collectProjectFiles, looksBinary } from "./backup"

function file(name: string, size = 100, parent = "/proj"): FileNode {
  return { name, path: `${parent}/${name}`, is_dir: false, size, mtimeMs: 1 }
}

function dir(name: string, children: FileNode[], parent = "/proj"): FileNode {
  return { name, path: `${parent}/${name}`, is_dir: true, children }
}

beforeEach(() => {
  mockListDirectory.mockReset()
  mockReadFile.mockReset()
})

describe("collectProjectFiles", () => {
  it("只收文本文件，图片与二进制跳过", async () => {
    mockListDirectory.mockResolvedValue([
      file("ch1.md"),
      file("outline.json"),
      file("cover.png"),
      file("data.zip"),
    ])

    const result = await collectProjectFiles("/proj")
    expect(result.files.map((f) => f.relPath)).toEqual(["ch1.md", "outline.json"])
    expect(result.skipped).toBe(2)
  })

  it("跳过 .git / node_modules / .trash 等目录", async () => {
    mockListDirectory.mockResolvedValue([
      dir(".git", [file("config", 10, "/proj/.git")]),
      dir("node_modules", [file("index.js", 10, "/proj/node_modules")]),
      dir(".trash", [file("old.md", 10, "/proj/.trash")]),
      dir("chapters", [file("ch1.md", 100, "/proj/chapters")]),
    ])

    const result = await collectProjectFiles("/proj")
    expect(result.files.map((f) => f.relPath)).toEqual(["chapters/ch1.md"])
  })

  it("子目录路径用 / 拼接", async () => {
    mockListDirectory.mockResolvedValue([
      dir("vol1", [dir("ch1", [file("a.md", 10, "/proj/vol1/ch1")], "/proj/vol1")]),
    ])

    const result = await collectProjectFiles("/proj")
    expect(result.files[0].relPath).toBe("vol1/ch1/a.md")
  })

  it("超过单文件体积上限的跳过", async () => {
    mockListDirectory.mockResolvedValue([file("big.md", 20 * 1024 * 1024), file("ok.md", 100)])

    const result = await collectProjectFiles("/proj")
    expect(result.files.map((f) => f.relPath)).toEqual(["ok.md"])
    expect(result.skipped).toBe(1)
  })

  it("达到文件数上限时截断并标记", async () => {
    const many = Array.from({ length: 20 }, (_, i) => file(`f${i}.md`))
    mockListDirectory.mockResolvedValue(many)

    const result = await collectProjectFiles("/proj", { maxFiles: 5 })
    expect(result.files).toHaveLength(5)
    expect(result.truncated).toBe(true)
  })
})

describe("backupProject", () => {
  const baseArgs = {
    baseUrl: "https://relay-home.qmai.work",
    netcard: "card",
    projectPath: "/proj",
    projectId: "pid",
  }

  it("逐个上传并统计成功数", async () => {
    const upload = vi.fn(testReceipt)
    const read = vi.fn(async (p: string) => "x".repeat(p.endsWith("a.md") ? 10 : 20))
    const collect = vi.fn(async () => ({
      files: [
        { relPath: "a.md", absPath: "/proj/a.md", size: 10 },
        { relPath: "b.md", absPath: "/proj/b.md", size: 20 },
      ],
      skipped: 0,
      truncated: false,
    }))

    const result = await backupProject({ ...baseArgs, upload, read, collect })

    expect(result.uploaded).toBe(2)
    expect(result.failed).toHaveLength(0)
    expect(result.totalBytes).toBe(30)
    expect(upload).toHaveBeenCalledTimes(2)
  })

  it("单个文件失败不中断整体（关键：否则一次卡住全白跑）", async () => {
    const upload = vi.fn(async (args: { projectId: string; relPath: string; content: string }) => {
      if (args.relPath === "bad.md") throw new Error("磁盘读取失败")
      return testReceipt(args)
    })
    const read = vi.fn(async () => "x")
    const collect = vi.fn(async () => ({
      files: [
        { relPath: "a.md", absPath: "/a.md", size: 1 },
        { relPath: "bad.md", absPath: "/bad.md", size: 1 },
        { relPath: "c.md", absPath: "/c.md", size: 1 },
      ],
      skipped: 0,
      truncated: false,
    }))

    const result = await backupProject({ ...baseArgs, upload, read, collect })

    expect(result.uploaded).toBe(2)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].path).toBe("bad.md")
    expect(result.failed[0].message).toContain("磁盘读取失败")
  })

  it("进度回调覆盖每个文件与收尾", async () => {
    const onProgress = vi.fn()
    const upload = vi.fn(testReceipt)
    const read = vi.fn(async () => "x")
    const collect = vi.fn(async () => ({
      files: [
        { relPath: "a.md", absPath: "/a.md", size: 1 },
        { relPath: "b.md", absPath: "/b.md", size: 1 },
      ],
      skipped: 0,
      truncated: false,
    }))

    await backupProject({ ...baseArgs, upload, read, collect, onProgress })

    // 2 个文件各一次 + 收尾一次
    expect(onProgress).toHaveBeenCalledTimes(3)
    expect(onProgress.mock.calls[2][0]).toMatchObject({ done: 2, total: 2 })
  })

  it("空工程也能正常返回（不抛错）", async () => {
    const collect = vi.fn(async () => ({ files: [], skipped: 3, truncated: false }))
    const result = await backupProject({
      ...baseArgs,
      upload: vi.fn(),
      read: vi.fn(),
      collect,
    })
    expect(result.uploaded).toBe(0)
    expect(result.skipped).toBe(3)
  })
})
describe("增量同步", () => {
  const baseArgs = {
    baseUrl: "https://relay-home.qmai.work",
    netcard: "card",
    projectPath: "/proj",
    projectId: "pid",
  }

  function collectOf(files: Array<{ relPath: string; size: number; mtime: number }>) {
    return vi.fn(async () => ({
      files: files.map((f) => ({ ...f, absPath: `/proj/${f.relPath}` })),
      skipped: 0,
      truncated: false,
    }))
  }

  it("清单里没有变化的文件不重传（自动同步的关键）", async () => {
    const upload = vi.fn(testReceipt)
    const read = vi.fn(async () => "x")
    const collect = collectOf([
      { relPath: "a.md", size: 10, mtime: 1000 },
      { relPath: "b.md", size: 20, mtime: 2000 },
    ])

    const result = await backupProject({
      ...baseArgs,
      upload,
      read,
      collect,
      listRemote: async () => testManifest("pid", [testFile("a.md", "x"), testFile("b.md", "x")]),
      known: {
        "a.md": { size: 10, mtime: 1000 },
        "b.md": { size: 20, mtime: 2000 },
      },
    })

    expect(result.uploaded).toBe(0)
    expect(result.skippedUnchanged).toBe(2)
    expect(upload).not.toHaveBeenCalled()
  })

  it("只传变化过的文件，没变的跳过", async () => {
    const upload = vi.fn(testReceipt)
    const read = vi.fn(async () => "x")
    const collect = collectOf([
      { relPath: "unchanged.md", size: 10, mtime: 1000 },
      { relPath: "edited.md", size: 10, mtime: 3000 },
    ])

    const result = await backupProject({
      ...baseArgs,
      upload,
      read,
      collect,
      listRemote: async () => testManifest("pid", [testFile("unchanged.md", "x"), testFile("edited.md", "旧稿")]),
      known: {
        "unchanged.md": testStamp("x", 1000),
        "edited.md": testStamp("旧稿", 2000),
      },
    })

    expect(result.uploaded).toBe(1)
    expect(result.skippedUnchanged).toBe(1)
    expect(upload).toHaveBeenCalledTimes(1)
    expect((upload.mock.calls[0][0] as { relPath: string }).relPath).toBe("edited.md")
  })

  it("大小变了也算变化（哪怕 mtime 相同）", async () => {
    const upload = vi.fn(testReceipt)
    const collect = collectOf([{ relPath: "a.md", size: 99, mtime: 1000 }])

    const result = await backupProject({
      ...baseArgs,
      upload,
      read: vi.fn(async () => "x"),
      collect,
      known: { "a.md": { size: 10, mtime: 1000 } },
    })

    expect(result.uploaded).toBe(1)
  })

  it("失败的文件不进清单（否则下次会被当成已同步而永远传不上去）", async () => {
    const upload = vi.fn(async () => {
      throw new Error("上传失败")
    })
    const collect = collectOf([
      { relPath: "ok.md", size: 1, mtime: 1 },
      { relPath: "bad.md", size: 1, mtime: 1 },
    ])
    upload.mockImplementationOnce(testReceipt)

    const result = await backupProject({
      ...baseArgs,
      upload,
      read: vi.fn(async () => "x"),
      collect,
    })

    expect(result.manifest["ok.md"]).toBeDefined()
    expect(result.manifest["bad.md"]).toBeUndefined()
  })

  it("返回的清单包含本次所有成功文件的最新指纹", async () => {
    const collect = collectOf([
      { relPath: "a.md", size: 11, mtime: 111 },
      { relPath: "b.md", size: 22, mtime: 222 },
    ])

    const result = await backupProject({
      ...baseArgs,
      upload: vi.fn(testReceipt),
      read: vi.fn(async () => "x"),
      collect,
    })

    expect(result.manifest).toEqual({
      "a.md": testStamp("x", 111),
      "b.md": testStamp("x", 222),
    })
  })
})
describe("客户端内容校验（不发请求就拦掉二进制）", () => {
  const baseArgs = {
    baseUrl: "https://relay-home.qmai.work",
    netcard: "card",
    projectPath: "/proj",
    projectId: "pid",
  }

  it("looksBinary：含 NUL 判为二进制", () => {
    expect(looksBinary("正常文本内容")).toBe(false)
    expect(looksBinary("MZ\u0000\u0000\u0000binary")).toBe(true)
    expect(looksBinary("")).toBe(false)
  })

  it("looksBinary：只看前 8KB（后面的 NUL 不误杀）", () => {
    const head = "A".repeat(8192)
    expect(looksBinary(head + "\u0000")).toBe(false)
    expect(looksBinary("A".repeat(100) + "\u0000")).toBe(true)
  })

  it("二进制内容不上传，且不计入失败", async () => {
    const upload = vi.fn(testReceipt)
    const read = vi.fn(async (p: string) =>
      p.includes("fake") ? "MZ\u0000\u0000\u0000" : "正常正文",
    )
    const collect = vi.fn(async () => ({
      files: [
        { relPath: "good.md", absPath: "/proj/good.md", size: 10, mtime: 1 },
        { relPath: "fake.txt", absPath: "/proj/fake.txt", size: 10, mtime: 1 },
      ],
      skipped: 0,
      truncated: false,
    }))

    const result = await backupProject({ ...baseArgs, upload, read, collect })

    // 关键：只传了正常的那个，假文本一个字节都没发出去
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0][0]).toMatchObject({ relPath: "good.md" })
    expect(result.uploaded).toBe(1)
    expect(result.binarySkipped).toEqual(["fake.txt"])
    // 不算失败：这是「判定为非文本」，不是「传错了」
    expect(result.failed).toHaveLength(0)
  })

  it("被跳过的二进制不进清单（下次还要重新判断）", async () => {
    const upload = vi.fn(testReceipt)
    const read = vi.fn(async () => "MZ\u0000\u0000")
    const collect = vi.fn(async () => ({
      files: [{ relPath: "fake.txt", absPath: "/proj/fake.txt", size: 5, mtime: 1 }],
      skipped: 0,
      truncated: false,
    }))

    const result = await backupProject({ ...baseArgs, upload, read, collect })

    expect(result.manifest["fake.txt"]).toBeUndefined()
    expect(upload).not.toHaveBeenCalled()
  })

  it("全部正常时 binarySkipped 为空数组", async () => {
    const upload = vi.fn(testReceipt)
    const read = vi.fn(async () => "正常文本")
    const collect = vi.fn(async () => ({
      files: [{ relPath: "a.md", absPath: "/proj/a.md", size: 4, mtime: 1 }],
      skipped: 0,
      truncated: false,
    }))

    const result = await backupProject({ ...baseArgs, upload, read, collect })
    expect(result.binarySkipped).toEqual([])
    expect(result.uploaded).toBe(1)
  })
})