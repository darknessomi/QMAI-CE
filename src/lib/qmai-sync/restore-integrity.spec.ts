// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  tree: [] as Array<{ name: string; is_dir: boolean; mtimeMs?: number }>,
  listError: false,
  failCreate: false,
}))
vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(async () => { if (state.listError) throw new Error("目录读取失败"); return state.tree }),
  fileExists: vi.fn(async () => true),
  createDirectory: vi.fn(async () => {}),
  writeFileAtomic: vi.fn(async (path: string, content: string) => { state.files.set(path, content) }),
  writeFileIfAbsent: vi.fn(async (path: string, content: string) => {
    if (state.failCreate) throw new Error("磁盘写入失败")
    if (state.files.has(path)) return false
    state.files.set(path, content); return true
  }),
}))
vi.mock("./log", () => ({ appendSyncLog: vi.fn(async () => {}) }))
import { restoreProject } from "./restore"
import { writeFileIfAbsent } from "@/commands/fs"

const options = {
  baseUrl: "https://synthetic.test", netcard: "synthetic-card", projectId: "project", projectPath: "C:/synthetic",
  listRemote: async () => [{ path: "chapter.md", mtime: 2000, size: 6 }],
  download: async () => "云端",
}
beforeEach(() => { state.files.clear(); state.tree = []; state.listError = false; state.failCreate = false; vi.clearAllMocks() })

describe("恢复保留本地内容", () => {
  it("本地目录无法读取时中止，零内容写入", async () => {
    state.listError = true; state.files.set("C:/synthetic/chapter.md", "本地新稿")
    await expect(restoreProject(options)).rejects.toThrow("目录读取失败")
    expect(state.files.get("C:/synthetic/chapter.md")).toBe("本地新稿")
    expect(writeFileIfAbsent).not.toHaveBeenCalled()
  })

  it("下载期间编辑不被覆盖，云端存到独立副本", async () => {
    state.tree = [{ name: "chapter.md", is_dir: false, mtimeMs: 1000 }]
    state.files.set("C:/synthetic/chapter.md", "原内容")
    const result = await restoreProject({ ...options, download: async () => {
      state.files.set("C:/synthetic/chapter.md", "刚写的新稿"); return "云端"
    } })
    expect(state.files.get("C:/synthetic/chapter.md")).toBe("刚写的新稿")
    expect(result.restored).toBe(1)
    expect(result.conflicts).toHaveLength(1)
    const copy = result.conflicts![0].savedPath
    expect(copy).toMatch(/^\.qmai\/restores\/[^/]+\/chapter\.md$/)
    expect(state.files.get("C:/synthetic/" + copy)).toBe("云端")
  })

  it("清单中不存在、下载间隙新建的文件也保留", async () => {
    const result = await restoreProject({ ...options, download: async () => {
      state.files.set("C:/synthetic/chapter.md", "新建本地稿"); return "云端"
    } })
    expect(state.files.get("C:/synthetic/chapter.md")).toBe("新建本地稿")
    expect(result.conflicts).toHaveLength(1)
    expect(result.failed).toHaveLength(0)
  })

  it("同mtime不同内容不覆盖，中文大小按UTF-8字节计数", async () => {
    state.tree = [{ name: "chapter.md", is_dir: false, mtimeMs: 2000 }]
    state.files.set("C:/synthetic/chapter.md", "本地")
    const result = await restoreProject(options)
    expect(state.files.get("C:/synthetic/chapter.md")).toBe("本地")
    expect(result.totalBytes).toBe(6)
    expect(result.conflicts).toHaveLength(1)
  })

  it("目标不存在时仍直接恢复原路径", async () => {
    const result = await restoreProject(options)
    expect(state.files.get("C:/synthetic/chapter.md")).toBe("云端")
    expect(result.conflicts).toEqual([])
    expect(result.restored).toBe(1)
  })

  it("写入失败不算成功，已有内容保持", async () => {
    state.failCreate = true; state.files.set("C:/synthetic/chapter.md", "保留")
    const result = await restoreProject(options)
    expect(result.restored).toBe(0); expect(result.failed).toHaveLength(1)
    expect(state.files.get("C:/synthetic/chapter.md")).toBe("保留")
  })

  it("副本创建也遇到同名时拒绝，不覆盖任何一份", async () => {
    const createFile = vi.fn(async () => false)
    const result = await restoreProject({ ...options, createFile })
    expect(result.restored).toBe(0); expect(result.conflicts).toEqual([])
    expect(result.failed[0].message).toContain("恢复副本已存在")
    expect(createFile).toHaveBeenCalledTimes(2)
  })

  it("并行恢复由独占创建决定归属，双方内容均保存", async () => {
    const [a, b] = await Promise.all([
      restoreProject({ ...options, download: async () => "内容A" }),
      restoreProject({ ...options, download: async () => "内容B" }),
    ])
    expect(a.restored + b.restored).toBe(2)
    expect(a.conflicts!.length + b.conflicts!.length).toBe(1)
    expect([...state.files.values()].sort()).toEqual(["内容A", "内容B"])
  })

  it.each(["chapter.md:secret", "dir./chapter.md", "CON.txt", ".qmai/config.json", "dir/../chapter.md", "chapter.md "])("拒绝特殊路径 %s", async path => {
    const download = vi.fn(async () => "云端")
    const result = await restoreProject({ ...options, listRemote: async () => [{ path, size: 6, mtime: 2000 }], download })
    expect(result.failed).toHaveLength(1); expect(download).not.toHaveBeenCalled(); expect(state.files.size).toBe(0)
  })
})
