import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import { searchSagProject } from "@/lib/sag-search"
import { searchWiki } from "@/lib/search"
import { eligibleLocalSource, novelMixedSearch } from "./search-adapter"

vi.mock("@/lib/sag-search", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/sag-search")>(), searchSagProject: vi.fn(),
}))
vi.mock("@/lib/search", () => ({ searchWiki: vi.fn() }))
beforeEach(() => {
  vi.clearAllMocks()
  useWikiStore.setState({ jevConfig: { endpoint: "http://test", model: "model" } })
})

describe("小说剧情检索", () => {
  it("配置后只走 SAG2，同一章多个不同段落均保留", async () => {
    vi.mocked(searchSagProject).mockResolvedValue([2, 9].map(startLine => ({
      title: "前情", path: "/book/QM/chapters/one.md", score: 0.9, content: "原文", startLine, endLine: startLine,
    })))
    const hits = await novelMixedSearch({ projectPath: "/book", query: "前情", chapterNumber: 12, authoritativeOnly: true })
    expect(hits.map(hit => hit.startLine)).toEqual([2, 9])
    expect(searchSagProject).toHaveBeenCalledWith("/book", "前情", 5, expect.objectContaining({ beforeChapter: 12 }))
    expect(searchWiki).not.toHaveBeenCalled()
  })
  it("服务出错时不静默执行关键词检索", async () => {
    vi.mocked(searchSagProject).mockRejectedValue(new Error("失败"))
    await expect(novelMixedSearch({ projectPath: "/book", query: "问题" })).rejects.toThrow("失败")
    expect(searchWiki).not.toHaveBeenCalled()
  })
  it("本地写作检索接受 QM 布局，并且仅允许前文定稿", async () => {
    const content = "---\nchapter_number: 3\nchapter_status: final\n---\n原文"
    const path = "/book/QM/chapters/three.md"
    expect(await eligibleLocalSource(path, content, 4)).toBe(true)
    expect(await eligibleLocalSource(path, content, 3)).toBe(false)
    expect(await eligibleLocalSource(path, content.replace("final", "draft"), 4)).toBe(false)
    expect(await eligibleLocalSource(path, content.replace("chapter_status", "ai_exclude: true\nchapter_status"), 4)).toBe(false)
  })
})
