import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFile } from "@/commands/fs"
import { searchWiki } from "@/lib/search"
import { useWikiStore } from "@/stores/wiki-store"
import { novelMixedSearch } from "./search-adapter"
import { listSnapshots, loadSnapshot } from "./chapter-ingest"

vi.mock("@/commands/fs", () => ({ readFile: vi.fn() }))
vi.mock("@/lib/search", () => ({ searchWiki: vi.fn() }))
vi.mock("./ai-exclude-chapters", () => ({ listAiExcludedChapterNumbers: vi.fn(async () => new Set()) }))
vi.mock("./chapter-ingest", () => ({ listSnapshots: vi.fn(), loadSnapshot: vi.fn() }))
const hit = (path: string, title: string) => ({ path, title, snippet: title, titleMatch: true, score: 1, images: [] })

describe("基础混合检索", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWikiStore.setState({ jevConfig: null })
  })
  it("关键词和正史来源的同一文件按原有排名融合", async () => {
    const canon = "/book/wiki/canon.md"
    vi.mocked(readFile).mockResolvedValue("设定")
    vi.mocked(searchWiki).mockResolvedValue([hit("/book/wiki/concepts/a.md", "页面"), hit(canon, "正史")])
    const hits = await novelMixedSearch({ projectPath: "/book", query: "设定", includeCanon: true })
    expect(hits.map(item => item.path)).toEqual([canon, "/book/wiki/concepts/a.md"])
  })
  it("近期快照限制在目标章之前，并按原顺序输出", async () => {
    vi.mocked(listSnapshots).mockResolvedValue([1, 3, 5, 7])
    vi.mocked(loadSnapshot).mockImplementation(async (_path, n) => ({ summary: `摘要${n}` } as Awaited<ReturnType<typeof loadSnapshot>>))
    const hits = await novelMixedSearch({ projectPath: "/book", query: "前情", chapterNumber: 5, includeKeyword: false, includeRecentChapters: true })
    expect(hits.map(item => item.snippet)).toEqual(["摘要3", "摘要1"])
  })
  it("一个本地来源超时不会阻断其它来源", async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(searchWiki).mockImplementation(() => new Promise(() => {}))
      vi.mocked(readFile).mockResolvedValue("正史")
      const hits = novelMixedSearch({ projectPath: "/book", query: "正史", includeCanon: true })
      await vi.advanceTimersByTimeAsync(2600)
      expect((await hits).map(item => item.type)).toEqual(["canon"])
    } finally { vi.useRealTimers() }
  })
})
