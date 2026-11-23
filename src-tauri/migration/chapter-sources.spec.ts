// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { expect, it, vi } from "vitest"
import { bindStagingRoot, listDirectory, writeFileAtomic } from "./filesystem.mjs"
import { listChapterSources } from "@/lib/novel/refresh-memory"

vi.mock("@/commands/fs", () => import("./filesystem.mjs"))

it("迁移与桌面重建使用相同的可见正文、目录顺序及深度边界", async () => {
  const root = await bindStagingRoot(await mkdtemp(join(tmpdir(), "qmai-migration-chapters-")))
  try {
    const chapters = join(root, "QM/chapters")
    const markdown = (number: number) => `---\ntype: chapter\nchapter_number: ${number}\n---\n正文`
    const deep = Array.from({ length: 29 }, () => "分卷").join("/")
    for (const [file, number] of [
      ["正文.md", 1], ["卷一/正式稿.md", 1], [".archive/旧稿.md", 2],
      [`${deep}/可见.md`, 3], [`${deep}/超出深度/旧稿.md`, 4],
    ] as const) {
      const dest = join(chapters, file)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, markdown(number))
    }
    const logical = join(root, "wiki/chapters")
    await writeFileAtomic(join(logical, ".旧稿.md"), markdown(5))
    const sources = await listChapterSources(root)
    expect([...sources.keys()]).toEqual([1, 3])
    expect(sources.get(1)?.filePath).toBe("wiki/chapters/卷一/正式稿.md")
    const top = await listDirectory(logical, { includeHidden: true, maxDepth: 1 })
    expect(top.map(node => node.name)).toEqual([".archive", "分卷", "卷一", ".旧稿.md", "正文.md"])
    expect(top.every(node => !node.children)).toBe(true)
  } finally {
    await rm(root, { recursive: true })
  }
})
