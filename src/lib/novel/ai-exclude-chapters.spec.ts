import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/search", () => ({
  searchWiki: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
}))

import { readFile } from "@/commands/fs"
import { searchWiki } from "@/lib/search"
import { isChapterNumberAiExcluded, listAiExcludedChapterNumbers } from "./ai-exclude-chapters"

const PROJECT = "C:/book"

function chapterFile(chapterNumber: number, extra = "") {
  return `---\ntype: chapter\nchapter_number: ${chapterNumber}\n${extra}---\n\n第${chapterNumber}章正文\n`
}

describe("按章号判断「选中（AI 不读取）」", () => {
  beforeEach(() => {
    vi.mocked(searchWiki).mockReset()
    vi.mocked(readFile).mockReset()
  })

  it("章号一致且带标记 → 已排除", async () => {
    vi.mocked(searchWiki).mockResolvedValue([{ path: `${PROJECT}/wiki/chapters/007.md` } as never])
    vi.mocked(readFile).mockResolvedValue(chapterFile(7, "ai_exclude: true\n"))

    await expect(isChapterNumberAiExcluded(PROJECT, 7)).resolves.toBe(true)
  })

  it("章号一致但没有标记 → 未排除（不改变原有行为）", async () => {
    vi.mocked(searchWiki).mockResolvedValue([{ path: `${PROJECT}/wiki/chapters/007.md` } as never])
    vi.mocked(readFile).mockResolvedValue(chapterFile(7))

    await expect(isChapterNumberAiExcluded(PROJECT, 7)).resolves.toBe(false)
  })

  /*
   * 这条是安全阀：`searchWiki` 是全文检索，`chapter_number:7` 同样会命中
   * 17 / 70 的正文。若不复核文件自己的章号，就容易把"第 17 章被排除"
   * 算到第 7 章头上 —— 那会让无辜章节的快照一起消失。
   */
  it("检索串号（命中 17 章却查 7 章）时不认标记", async () => {
    vi.mocked(searchWiki).mockResolvedValue([
      { path: `${PROJECT}/wiki/chapters/017.md` } as never,
      { path: `${PROJECT}/wiki/chapters/007.md` } as never,
    ])
    vi.mocked(readFile).mockImplementation(async (path) => (
      String(path).endsWith("017.md") ? chapterFile(17, "ai_exclude: true\n") : chapterFile(7)
    ))

    await expect(isChapterNumberAiExcluded(PROJECT, 7)).resolves.toBe(false)
  })

  it("检索没有结果 / 读盘失败时按未排除处理（不让故障砍掉整本书的快照）", async () => {
    vi.mocked(searchWiki).mockResolvedValue([])
    await expect(isChapterNumberAiExcluded(PROJECT, 7)).resolves.toBe(false)

    vi.mocked(searchWiki).mockResolvedValue([{ path: `${PROJECT}/wiki/chapters/007.md` } as never])
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"))
    await expect(isChapterNumberAiExcluded(PROJECT, 7)).resolves.toBe(false)

    vi.mocked(searchWiki).mockRejectedValue(new Error("index down"))
    await expect(isChapterNumberAiExcluded(PROJECT, 7)).resolves.toBe(false)
  })

  it("批量版只返回被排除的章号，且去重", async () => {
    vi.mocked(searchWiki).mockImplementation(async (_pp, query) => {
      const number = Number(String(query).replace("chapter_number:", ""))
      return [{ path: `${PROJECT}/wiki/chapters/${number}.md` } as never]
    })
    vi.mocked(readFile).mockImplementation(async (path) => {
      const number = Number(String(path).match(/(\d+)\.md$/)?.[1] ?? "0")
      return number === 2 ? chapterFile(number, "ai_exclude: true\n") : chapterFile(number)
    })

    const excluded = await listAiExcludedChapterNumbers(PROJECT, [1, 2, 2, 3, 0, -1])
    expect([...excluded]).toEqual([2])
  })
})
