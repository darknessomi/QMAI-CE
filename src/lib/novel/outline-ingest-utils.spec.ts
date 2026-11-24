import { describe, expect, it, vi } from "vitest"
import { getOutlineFileName, getOutlineIngestIdentity, outlineSnapshotExists, resolveOutlineIngestIdentity, legacyOutlineNumber } from "./outline-ingest-utils"

vi.mock("@/commands/fs", () => ({
  fileExists: vi.fn(), listDirectory: vi.fn(), readFile: vi.fn(), writeFileAtomic: vi.fn(),
}))

import { fileExists, listDirectory, readFile, writeFileAtomic } from "@/commands/fs"

describe("getOutlineIngestIdentity", () => {
  it("derives a stable negative chapter number and snapshot path from outline filename", () => {
    const identity = getOutlineIngestIdentity("/proj", "/proj/wiki/outlines/vol-1-outline.md")
    expect(identity.outlineName).toBe("vol-1-outline")
    expect(identity.chapterNumber).toBeLessThan(0)
    expect(identity.snapshotJsonPath).toMatch(/\.qmai\/novel\/snapshots\/outline-\d{4,}\.snapshot\.json$/)
  })

  it("returns the same identity for the same outline path", () => {
    const left = getOutlineIngestIdentity("/proj", "/proj/wiki/outlines/plot.md")
    const right = getOutlineIngestIdentity("/proj", "/proj/wiki/outlines/plot.md")
    expect(left).toEqual(right)
  })
})

describe("getOutlineFileName", () => {
  it("strips extension and falls back when path is empty", () => {
    expect(getOutlineFileName("/a/b/story-outline.md")).toBe("story-outline")
    expect(getOutlineFileName("")).toBe("大纲")
  })
})

describe("outlineSnapshotExists", () => {
  it("checks the derived snapshot json path", async () => {
    vi.mocked(fileExists).mockResolvedValueOnce(true)
    await expect(outlineSnapshotExists("/proj", "/proj/wiki/outlines/plot.md")).resolves.toBe(true)
    expect(fileExists).toHaveBeenCalledWith(expect.stringContaining("/proj/.qmai/novel/snapshots/outline-"))
  })
})

it("两个同名大纲在不同目录独立，QM 和 wiki 路径一致", () => {
  const id = (path: string) => getOutlineIngestIdentity("/proj", path).chapterNumber
  expect(id("/proj/wiki/outlines/卷一/人物.md")).not.toBe(id("/proj/wiki/outlines/卷二/人物.md"))
  expect(id("/proj/wiki/outlines/卷一/wiki/outlines/人物.md")).not.toBe(id("/proj/wiki/outlines/人物.md"))
  expect(id("QM/outlines/卷一/人物.md")).toBe(id("/proj/wiki/outlines/卷一/人物.md"))
  expect(id("/proj/wiki/outlines/卷一/人物.md")).toBe(id("/relocated/QM/outlines/卷一/人物.md"))
  expect(id("/proj/wiki/outlines/第1章-章纲.md")).not.toBe(id("/proj/wiki/outlines/第82章-章纲.md"))
})

it("旧快照可唯一认领即沿用编号和历史，歧义决定在删除同名页后仍有效", async () => {
  const path = "/proj/wiki/outlines/卷一/人物.md"
  const path2 = "/proj/wiki/outlines/卷二/人物.md"
  const n = legacyOutlineNumber(path)
  const old = `/proj/.qmai/novel/snapshots/outline-${Math.abs(n)}.snapshot.json`
  const files = new Map([[old, JSON.stringify({ chapterId: "outline-人物", chapterTitle: "人物" })]])
  let paths = [path, path2]
  vi.mocked(fileExists).mockImplementation(async p => files.has(p))
  vi.mocked(listDirectory).mockImplementation(async () => paths.map(p => ({ name: "人物.md", path: p, is_dir: false })))
  vi.mocked(readFile).mockImplementation(async p => files.get(p)!)
  vi.mocked(writeFileAtomic).mockImplementation(async (p, v) => { files.set(p, v) })
  expect((await resolveOutlineIngestIdentity("/proj", path)).chapterNumber).not.toBe(n)
  paths = [path]
  expect((await resolveOutlineIngestIdentity("/proj", path)).chapterNumber).not.toBe(n)
  files.delete(old.replace(".snapshot.json", ".owner.json"))
  expect((await resolveOutlineIngestIdentity("/proj", path)).chapterNumber).toBe(n)
  expect(files.has(old)).toBe(true)
})

it("旧编号冲突时按标题与修订记录认领，先访问另一份大纲也不影响结果", async () => {
  const a = "/proj/QM/outlines/卷一/Aa.md"
  const b = "/proj/QM/outlines/卷二/BB.md"
  const n = legacyOutlineNumber(a)
  expect(legacyOutlineNumber(b)).toBe(n)
  const prefix = `outline-${String(-n).padStart(3, "0")}`
  const base = "/proj/.qmai/novel/snapshots"
  const history = `${base}/history/${prefix}`
  const rev = `${history}/yesterday.snapshot.json`
  const saved = JSON.stringify({ chapterId: "outline-Aa" })
  const files = new Map([[`${base}/${prefix}.snapshot.json`, saved], [rev, saved]])
  vi.mocked(fileExists).mockImplementation(async p => p === history || files.has(p))
  vi.mocked(listDirectory).mockImplementation(async dir => (dir === history ? [rev] : [a, b]).map(path => ({
    name: path.split("/").pop()!, path, is_dir: false,
  })))
  vi.mocked(readFile).mockImplementation(async p => files.get(p)!)
  vi.mocked(writeFileAtomic).mockImplementation(async (p, v) => { files.set(p, v) })
  expect((await resolveOutlineIngestIdentity("/proj", b)).chapterNumber).not.toBe(n)
  expect((await resolveOutlineIngestIdentity("/proj", a)).chapterNumber).toBe(n)
  files.delete(`${base}/${prefix}.owner.json`)
  files.set(rev, JSON.stringify({ chapterTitle: "BB" }))
  expect((await resolveOutlineIngestIdentity("/proj", a)).chapterNumber).not.toBe(n)
  expect(files.has(rev)).toBe(true)
})
