import { beforeEach, describe, expect, it, vi } from "vitest"
import { searchWiki } from "@/lib/search"
import { useWikiStore } from "@/stores/wiki-store"
import { novelMixedSearch } from "./search-adapter"
import { buildContextPack, searchRelevantContentUnified } from "./context-engine"
import { searchSagProject } from "../sag-search"
import { withMemoryWriteLock } from "./memory-cleanup-policy"

vi.mock("../sag-search", async importOriginal => ({
  ...await importOriginal<typeof import("../sag-search")>(), searchSagProject: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  listDirectory: vi.fn(async () => []),
}))
vi.mock("@/lib/search", () => ({
  tokenizeQuery: (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean),
  searchWiki: vi.fn(),
}))
vi.mock("./search-adapter", () => ({
  novelMixedSearch: vi.fn(),
  eligibleLocalSource: vi.fn(() => true),
  isHistoricalProjectionSnippet: vi.fn(() => false),
  isAuthoritativeGenerationPath: vi.fn((path: string) => path.includes("/wiki/memory/")),
}))

const mockSearchWiki = vi.mocked(searchWiki)
const mockNovelMixedSearch = vi.mocked(novelMixedSearch)

describe("searchRelevantContentUnified retrieval noise control", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWikiStore.setState({ jevConfig: null })
  })

  it("uses local results and emits one result per normalized path", async () => {
    mockNovelMixedSearch.mockResolvedValue([{
      type: "keyword",
      path: "/project/wiki/memory/shared.md",
      title: "Shared Memory",
      snippet: "Matched semantic chunk",
      relevance: 0.9,
    }])
    mockSearchWiki.mockResolvedValue([{
      path: "/project/wiki/memory/shared.md",
      title: "Shared Memory",
      snippet: "Different index excerpt",
      titleMatch: false,
      score: 0.5,
      images: [],
    }])

    const output = await searchRelevantContentUnified(
      "/project",
      "continue the northern faction plot",
      12,
      5,
    )

    expect(output.match(/- Shared Memory:/g)).toHaveLength(1)
    expect(mockSearchWiki).toHaveBeenCalledWith(
      "/project",
      expect.stringContaining("continue the northern faction plot"),
      expect.objectContaining({
        localOnly: true,
        topK: 5,
      }),
    )
  })
})

describe("写作证据", () => {
  const project = "/project"
  const config = { endpoint: "http://test", model: "model" }
  beforeEach(() => {
    vi.clearAllMocks()
    useWikiStore.setState({ novelMode: true, jevConfig: config })
  })
  const options = {
    // 用最小的章纲与章节目标验证实际组包，其他来源采用已知的本地读取逻辑。
    categories: ["outline", "plot_tools"] as ("outline" | "plot_tools")[],
    loadAdapter: {
      async load<T>(source: { name: string }, _context: unknown, direct: () => Promise<T>): Promise<T> {
        return source.name === "chapterOutline" ? "第5章目标：周羽赶赴渡口" as T : direct()
      },
    },
  }

  it("在记忆锁外执行一次检索并保留可定位引文，复用时不重新判定", async () => {
    vi.mocked(searchSagProject).mockImplementation(async () => {
      await withMemoryWriteLock(project, async () => {})
      return [{ path: "/project/QM/chapters/one.md", title: "第一章", content: "船已靠岸。", startLine: 5, endLine: 5, score: 0.9 }]
    })
    const pack = await buildContextPack(project, "继续写第5章", 5, options)
    expect(searchSagProject).toHaveBeenCalledWith(project, expect.stringContaining("周羽赶赴渡口"), expect.any(Number), expect.objectContaining({ beforeChapter: 5 }))
    expect(pack.searchResults).toContain("QM/chapters/one.md 第 5–5 行")
    expect(pack.searchResults).toContain("船已靠岸。")
    const reused = await buildContextPack(project, "完成同一章正文", 5, { ...options, evidence: pack.sagEvidence })
    expect(reused.searchResults).toBe(pack.searchResults)
    expect(searchSagProject).toHaveBeenCalledTimes(1)
    await buildContextPack(project, "写第6章", 6, { ...options, evidence: pack.sagEvidence })
    expect(searchSagProject).toHaveBeenCalledTimes(2)
  })

  it("失败时保留章纲，警告与证据分开", async () => {
    vi.mocked(searchSagProject).mockRejectedValue(new Error("模型服务不可用"))
    const pack = await buildContextPack(project, "写第5章", 5, options)
    expect(pack.outline).toContain("周羽赶赴渡口")
    expect(pack.sagEvidence?.warning).toContain("模型服务不可用")
    expect(pack.searchResults).toBe("")
    expect(novelMixedSearch).not.toHaveBeenCalled()
  })

  it("已保存的配置无法读取时保留本章章纲并告知错误", async () => {
    useWikiStore.setState({ jevConfig: null, jevConfigLoadError: "无法读取决策配置" })
    try {
      const pack = await buildContextPack(project, "写第5章", 5, options)
      expect(pack.outline).toContain("周羽赶赴渡口")
      expect(pack.sagEvidence?.warning).toContain("无法读取决策配置")
      expect(novelMixedSearch).not.toHaveBeenCalled()
      expect(searchSagProject).not.toHaveBeenCalled()
    } finally {
      useWikiStore.setState({ jevConfigLoadError: null })
    }
  })
})
