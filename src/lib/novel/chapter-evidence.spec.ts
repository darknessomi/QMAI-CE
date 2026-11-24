import { expect, it, vi } from "vitest"
import { searchChapterEvidence } from "./chapter-evidence"
import { createSearchChaptersTool } from "@/lib/agent/tools/search-chapters"
vi.mock("@/commands/fs", () => ({
  listDirectory: async () => [
    { name: "卷一", path: "/book/卷一", is_dir: true, children:
      Array.from({ length: 4 }, (_, i) => ({ name: `章节${i+1}.md`, path: String(i+1), is_dir: false })) },
  ],
  readFile: async () => "",
}))
const read = async (p: string) => `---\ntype: chapter\nchapter_number: ${p}\nchapter_status: ${p === "1" ? "draft" : "final"}\nai_exclude: ${p === "3"}\ntitle: 原文未用的词\n---\n第一句。林青  拆开了信。最后一句。`
it("限定定稿章号、排除禁读资料与元数据，引用原句空白", async () => {
  const result = await searchChapterEvidence("/book", "拆开", { read, to: 3 })
  expect(result.hits.map(hit => [hit.number, hit.quote])).toEqual([[2, "林青  拆开了信。"]])
  expect(result.coverage).toContain("已核对 1 份")
  expect((await searchChapterEvidence("/book", "原文未用", { read })).hits).toEqual([])
  expect(await createSearchChaptersTool("/book", read).execute({ keyword: "拆开", toChapter: 2 })).toContain("章 · 2")
  await expect(searchChapterEvidence("/book", "信", { from: 8, to: 2 })).rejects.toThrow("结束章号")
})
