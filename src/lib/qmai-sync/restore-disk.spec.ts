// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, open, readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"

// 真实磁盘适配：只在本批备份目录创建合成文件，保留测试产物供核对。
vi.mock("@/commands/fs", () => ({
  listDirectory: async (root: string) => Promise.all((await readdir(root, { withFileTypes: true })).map(async item => ({
    name: item.name, is_dir: item.isDirectory(), mtimeMs: (await stat(path.join(root, item.name))).mtimeMs,
  }))),
  writeFileIfAbsent: async (target: string, content: string) => {
    await mkdir(path.dirname(target), { recursive: true })
    const handle = await open(target, "wx").catch(error => {
      if (error.code === "EEXIST") return null
      throw error
    })
    if (!handle) return false
    try { await handle.writeFile(content, "utf8"); await handle.sync(); return true }
    finally { await handle.close() }
  },
}))
vi.mock("./log", () => ({ appendSyncLog: vi.fn(async () => {}) }))
import { restoreProject } from "./restore"

describe("恢复流程真实文件系统验证", () => {
  it("保留下载间隙编辑的原稿，重复恢复不会覆盖上一份副本", async () => {
    const base = path.resolve(".backup/backend-implementation-20261110/wave-4a-restore/disk-fixtures")
    await mkdir(base, { recursive: true })
    const root = await mkdtemp(path.join(base, "restore-"))
    const local = path.join(root, "chapter.md")
    await writeFile(local, "合成原稿", "utf8")
    const options = {
      baseUrl: "https://synthetic.test", netcard: "synthetic-card", projectId: "synthetic-project", projectPath: root,
      listRemote: async () => [{ path: "chapter.md", mtime: Date.now() + 100000, size: 18 }],
      download: async () => { await writeFile(local, "下载期间的新稿", "utf8"); return "云端合成稿" },
    }
    const first = await restoreProject(options)
    const second = await restoreProject(options)
    expect(await readFile(local, "utf8")).toBe("下载期间的新稿")
    expect(first.conflicts).toHaveLength(1); expect(second.conflicts).toHaveLength(1)
    const firstCopy = first.conflicts![0].savedPath, secondCopy = second.conflicts![0].savedPath
    expect(firstCopy).not.toBe(secondCopy)
    expect(await readFile(path.join(root, firstCopy), "utf8")).toBe("云端合成稿")
    expect(await readFile(path.join(root, secondCopy), "utf8")).toBe("云端合成稿")
    expect(first.failed).toEqual([]); expect(second.failed).toEqual([])
  })
})
