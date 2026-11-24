// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { SearchView } from "./search-view"

vi.mock("@/commands/fs", () => ({
  listDirectory: async (dir: string) => [1, 2, 3].map(n => ({ path: `${dir}/${n}.md`, name: `${n}.md`, is_dir: false })),
  readFile: async (path: string) => {
    const n = path.match(/(\d+)\.md$/)![1]
    return `---\ntype: chapter\nchapter_number: ${n}\nchapter_status: ${n === "3" ? "draft" : "final"}\ntitle: 第${n}章寄信\n---\n林青交还了旧信。`
  },
}))

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
