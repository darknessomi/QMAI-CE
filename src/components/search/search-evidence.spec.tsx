// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { SearchView } from "./search-view"

vi.mock("@tauri-apps/api/core", async importOriginal => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
  invoke: vi.fn(),
}))
vi.mock("@/commands/fs", () => ({
  listDirectory: async (dir: string) => [1, 2, 3].map(n => ({ path: `${dir}/${n}.md`, name: `${n}.md`, is_dir: false })),
  readFile: async (path: string) => {
    if (path === "/book/wiki/1.md") return "# 渡口\n\n林青交还了旧信。\n\n![码头平面图](https://example.invalid/map.png)"
    const n = path.match(/(\d+)\.md$/)![1]
    return `---\ntype: chapter\nchapter_number: ${n}\nchapter_status: ${n === "3" ? "draft" : "final"}\ntitle: 第${n}章寄信\n---\n林青交还了旧信。`
  },
}))

it("SAG2 命中带图片引用的页面时只展示原文搜索结果", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const initial = useWikiStore.getState()
  useWikiStore.setState({
    project: { id: "book", path: "/book", name: "书" }, novelMode: true,
    jevConfig: { endpoint: "https://example.invalid/decisions", model: "回放" },
  })
  vi.mocked(invoke).mockResolvedValue([{ path: "/book/wiki/1.md", title: "渡口", content: "林青交还了旧信。", startLine: 3, endLine: 3, score: 1 }])
  const host = document.createElement("div")
  const root = createRoot(host)
  try {
    act(() => root.render(<SearchView />))
    await act(async () => { useWikiStore.getState().setSearchTrigger({ query: "旧信", ts: 1 }) })
    await vi.waitFor(() => {
      const hit = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("渡口"))
      expect(hit?.textContent).toContain("林青交还了旧信。")
    })
    expect(host.querySelector("img")).toBeNull()
    expect(host.textContent).not.toMatch(/图片|显示全部/)
    expect(invoke).toHaveBeenCalledWith("sag_search", expect.objectContaining({ query: "旧信" }))
  } finally {
    act(() => root.unmount())
    useWikiStore.setState(initial)
    vi.unstubAllGlobals()
  }
})

it("从定稿查证面板设定范围，打开引用所指的章节", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const book = { id: "book", path: "/book", name: "书" }
  useWikiStore.setState({ project: book, novelMode: true })
  const host = document.createElement("div")
  const root = createRoot(host)
  const open = vi.fn()
  try {
    act(() => root.render(<SearchView onOpenFile={open} />))
    act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    const from = host.querySelector<HTMLInputElement>('input[aria-label="起始章号"]')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(from, "2")
      from.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => { useWikiStore.getState().setSearchTrigger({ query: "旧信", ts: 1 }) })
    await vi.waitFor(() => expect(host.querySelector('[role="status"]')?.textContent).toContain("已核对 1 份"))
    const hit = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("林青交还了旧信。"))
    expect(hit?.textContent).toContain("第2章寄信")
    act(() => hit!.click())
    expect(open).toHaveBeenCalledWith({ path: "/book/wiki/chapters/2.md" })
  } finally {
    act(() => root.unmount())
    useWikiStore.setState({ project: null, searchTrigger: null })
    vi.unstubAllGlobals()
  }
})
