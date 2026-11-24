import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFile } from "@/commands/fs"
import { searchWiki } from "@/lib/search"
import { searchByEmbedding } from "@/lib/embedding"
import { useWikiStore } from "@/stores/wiki-store"
import { novelMixedSearch } from "./search-adapter"

vi.mock("@/commands/fs", () => ({ readFile: vi.fn() }))
vi.mock("@/lib/search", () => ({ searchWiki: vi.fn() }))
vi.mock("@/lib/embedding", () => ({ searchByEmbedding: vi.fn() }))
vi.mock("@/lib/rerank", () => ({
  rerankCandidates: vi.fn(async (_query, candidates, options) =>
    candidates.slice(0, options?.topK ?? candidates.length)),
}))
vi.mock("./chapter-ingest", () => ({
  listSnapshots: vi.fn(async () => []),
  loadSnapshot: vi.fn(async () => null),
}))

const mockReadFile = vi.mocked(readFile)
const mockSearchWiki = vi.mocked(searchWiki)
const mockSearchByEmbedding = vi.mocked(searchByEmbedding)

describe("novelMixedSearch vector noise control", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWikiStore.setState({
      embeddingConfig: {
        enabled: true,
        endpoint: "http://localhost:11434/api/embeddings",
        apiKey: "",
        model: "nomic-embed-text",
      },
    })
    mockSearchWiki.mockResolvedValue([])
  })

  it("keeps the keyword branch lexical-only", async () => {
    mockSearchByEmbedding.mockResolvedValue([])

    await novelMixedSearch({
      projectPath: "/project",
      query: "semantic memory",
      topK: 2,
      includeKeyword: true,
      includeVector: true,
      includeGraph: false,
      includeRecentChapters: false,
      includeCanon: false,
    })

    expect(mockSearchWiki).toHaveBeenCalledWith(
      "/project",
      "semantic memory",
      { includeVector: false },
    )
  })

  it("rejects a high blended page score when the best raw chunk score is weak", async () => {
    mockSearchByEmbedding.mockResolvedValue([{
      id: "wiki/memory/noisy-hit",
      score: 0.99,
      matchedChunks: [{ text: "weak semantic neighbor", headingPath: "Noise", score: 0.4 }],
    }])
    mockReadFile.mockResolvedValue("# Noisy Hit\n\nUnrelated page text.")

    const results = await novelMixedSearch({
      projectPath: "/project",
      query: "current chapter goal",
      topK: 2,
      includeKeyword: true,
      includeVector: true,
      includeGraph: false,
      includeRecentChapters: false,
      includeCanon: false,
    })

    expect(results).toEqual([])
    expect(mockReadFile).not.toHaveBeenCalled()
  })

  it("uses the actual matched chunk as the vector result snippet", async () => {
    mockSearchByEmbedding.mockResolvedValue([{
      id: "wiki/memory/seal-memory",
      score: 0.92,
      matchedChunks: [{
        text: "Lin discovers that the northern faction owns the seal.",
        headingPath: "Chapter 12 / Seal",
        score: 0.82,
      }],
    }])
    mockReadFile.mockResolvedValue("# Unrelated Page Introduction\n\nThe relevant detail appears much later.")

    const results = await novelMixedSearch({
      projectPath: "/project",
      query: "who controls the seal",
      topK: 2,
      includeKeyword: true,
      includeVector: true,
      includeGraph: false,
      includeRecentChapters: false,
      includeCanon: false,
    })

    expect(results).toHaveLength(1)
    expect(results[0].snippet).toContain("Chapter 12 / Seal")
    expect(results[0].snippet).toContain("northern faction owns the seal")
    expect(results[0].snippet).not.toContain("Unrelated Page Introduction")
  })

  /*
   * 「选中（AI 不读取）」：检索命中也不能把被排除的内容当"参考资料"送进模型。
   * 语义检索这一路是模型最容易被"顺手泄漏"的入口 —— 它不经过大纲/正文注入，
   * 命中就直接进上下文。
   */
  it("被选中（AI 不读取）的文档不会作为检索结果返回", async () => {
    mockSearchByEmbedding.mockResolvedValue([{
      id: "wiki/memory/seal-memory",
      score: 0.92,
      matchedChunks: [{
        text: "Lin discovers that the northern faction owns the seal.",
        headingPath: "Chapter 12 / Seal",
        score: 0.82,
      }],
    }])
    mockReadFile.mockResolvedValue("---\ntitle: Seal\ntype: concept\nai_exclude: true\n---\n\n# Seal\n\nnorthern faction owns the seal")

    const results = await novelMixedSearch({
      projectPath: "/project",
      query: "who controls the seal",
      topK: 2,
      includeKeyword: true,
      includeVector: true,
      includeGraph: false,
      includeRecentChapters: false,
      includeCanon: false,
    })

    expect(results).toEqual([])
  })
})
