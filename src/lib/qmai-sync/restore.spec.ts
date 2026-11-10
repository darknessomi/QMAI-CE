// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 从云端恢复。
 *
 * ## 这个功能为什么必须有测试
 *
 * 恢复会**往用户的作品目录里写文件**。写错了不是「功能不好用」，
 * 而是直接毁数据 —— 而且是那种用户自己很难发现的毁法
 * （覆盖掉刚写的章节、写到作品目录外面去）。
 *
 * 所以这几条必须钉死：
 *   · 本地比云端新的文件绝不能被覆盖
 *   · 云端返回的恶意路径（../..）必须被拒
 *   · 单个文件失败不能中断整体，也不能算成成功
 *   · 云端为空时不能谎报「恢复了 N 个」
 */

const writes = vi.hoisted(() => [] as Array<{ path: string; content: string }>)

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(async () => [
    {
      name: "chapters",
      is_dir: true,
      children: [
        { name: "第001章.md", is_dir: false, size: 10, mtimeMs: 2_000 },
        { name: "第002章.md", is_dir: false, size: 10, mtimeMs: 1_000 },
      ],
    },
    { name: "outline.md", is_dir: false, size: 5, mtimeMs: 500 },
  ]),
  createDirectory: vi.fn(async () => {}),
  fileExists: vi.fn(async () => true),
  writeFileIfAbsent: vi.fn(async (path: string, content: string) => {
    if (writes.some(item => item.path === path)) return false
    writes.push({ path, content })
    return true
  }),
}))

vi.mock("@/lib/qmai-sync/log", () => ({
  appendSyncLog: vi.fn(async () => {}),
}))

vi.mock("@/lib/path-utils", () => ({
  normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, ""),
}))

import { restoreProject } from "./restore"
import type { SyncFileEntry } from "./client"

const PROJECT = "/data/proj"

function entry(path: string, mtime: number, size = 10): SyncFileEntry {
  return { path, size, mtime }
}

beforeEach(() => {
  writes.length = 0
})

describe("恢复：基本流程", () => {
  it("把云端文件写回本地", async () => {
    const result = await restoreProject({
      baseUrl: "https://relay-home.qmai.work",
      netcard: "card",
      projectId: "proj1",
      projectPath: PROJECT,
      listRemote: async () => [entry("chapters/第003章.md", 9_000)],
      download: async (_b, _n, _p, rel) => `内容:${rel}`,
    })

    expect(result.restored).toBe(1)
    expect(result.failed).toHaveLength(0)
    expect(writes[0].path).toBe("/data/proj/chapters/第003章.md")
    expect(writes[0].content).toBe("内容:chapters/第003章.md")
  })

  it("云端为空时如实报告 0，不谎报", async () => {
    const result = await restoreProject({
      baseUrl: "https://relay-home.qmai.work",
      netcard: "card",
      projectId: "proj1",
      projectPath: PROJECT,
      listRemote: async () => [],
      download: async () => "x",
    })

    expect(result.restored).toBe(0)
    expect(result.remoteTotal).toBe(0)
  })
})

describe("恢复：不覆盖本地更新的文件", () => {
  it("本地 mtime 比云端新 → 跳过", async () => {
    // 本地 第001章.md 的 mtime 是 2000，云端给 1000（更旧）
    const download = vi.fn(async () => "云端旧内容")

    const result = await restoreProject({
      baseUrl: "https://relay-home.qmai.work",
      netcard: "card",
      projectId: "proj1",
      projectPath: PROJECT,
      listRemote: async () => [entry("chapters/第001章.md", 1_000)],
      download,
    })

    expect(result.restored).toBe(0)
    expect(result.skippedNewer).toBe(1)
    // 关键：根本没去下载，更没写盘
    expect(download).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
  })

  it("云端比本地新 → 下载并保存", async () => {
    const result = await restoreProject({
      baseUrl: "https://relay-home.qmai.work",
      netcard: "card",
      projectId: "proj1",
      projectPath: PROJECT,
      // 本地 1000，云端 9000
      listRemote: async () => [entry("chapters/第002章.md", 9_000)],
      download: async () => "云端新内容",
    })

    expect(result.restored).toBe(1)
    expect(result.skippedNewer).toBe(0)
  })

  it("本地不存在该文件 → 正常下载", async () => {
    const result = await restoreProject({
      baseUrl: "https://relay-home.qmai.work",
      netcard: "card",
      projectId: "proj1",
      projectPath: PROJECT,
      listRemote: async () => [entry("全新目录/新文件.md", 1_000)],
      download: async () => "新内容",
    })

    expect(result.restored).toBe(1)
  })
})

describe("恢复：安全", () => {
  it("拒绝路径穿越", async () => {
    const download = vi.fn(async () => "x")

    const result = await restoreProject({
      baseUrl: "https://relay-home.qmai.work",
      netcard: "card",
      projectId: "proj1",
      projectPath: PROJECT,
      listRemote: async () => [entry("../../etc/passwd", 9_000)],
      download,
    })

    expect(result.restored).toBe(0)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].message).toContain("不合法")
    expect(download).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
  })

  it("拒绝绝对路径", async () => {
    const result = await restoreProject({
      baseUrl: "https://relay-home.qmai.work",
      netcard: "card",
      projectId: "proj1",
      projectPath: PROJECT,
      listRemote: async () => [entry("/etc/passwd", 9_000)],
      download: async () => "x",
    })

    expect(result.restored).toBe(0)
    expect(result.failed).toHaveLength(1)
  })
})

describe("恢复：容错", () => {
  it("单个文件下载失败不中断整体", async () => {
    const result = await restoreProject({
      baseUrl: "https://relay-home.qmai.work",
      netcard: "card",
      projectId: "proj1",
      projectPath: PROJECT,
      listRemote: async () => [
        entry("a.md", 9_000),
        entry("b.md", 9_000),
        entry("c.md", 9_000),
      ],
      download: async (_b, _n, _p, rel) => {
        if (rel === "b.md") throw new Error("网络中断")
        return `内容-${rel}`
      },
    })

    expect(result.restored).toBe(2)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].path).toBe("b.md")
    expect(result.failed[0].message).toContain("网络中断")
  })

  it("清单拉取失败时抛出，不吞掉", async () => {
    await expect(
      restoreProject({
        baseUrl: "https://relay-home.qmai.work",
        netcard: "card",
        projectId: "proj1",
        projectPath: PROJECT,
        listRemote: async () => {
          throw new Error("401 网卡无效")
        },
        download: async () => "x",
      }),
    ).rejects.toThrow("401 网卡无效")
  })
})
