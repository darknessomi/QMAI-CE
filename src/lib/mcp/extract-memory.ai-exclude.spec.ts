import { describe, expect, it, vi } from "vitest"

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
}))

import { readFile } from "@/commands/fs"
import { extractProjectMemory } from "./extract-memory"

/*
 * 《选中（AI 不读取）》在 MCP 侧的口径。
 *
 * 外部 Agent 走 `extract_memory` 是**除了界面按钮之外**唯一能让模型读整章的入口：
 * 只在 UI 上禁用按钮，Agent 换个入口照样能把内容喂给模型，承诺就是假的。
 */
const chapterPath = "/book/QM/chapters/第1章.md"

function deps() {
  return {
    ingestChapter: vi.fn(async () => ({ snapshot: { chapterNumber: 1 } })),
    ingestOutline: vi.fn(async () => ({ snapshot: { chapterNumber: 1 } })),
  } as unknown as Parameters<typeof extractProjectMemory>[1]
}

describe("MCP extract_memory：被选中（AI 不读取）的文档", () => {
  it("拒绝提取，且不把内容交给摄取", async () => {
    vi.mocked(readFile).mockResolvedValue("---\ntype: chapter\nchapter_number: 1\nai_exclude: true\n---\n\n正文")
    const io = deps()

    await expect(extractProjectMemory({ projectPath: "/book", path: chapterPath }, io))
      .rejects.toThrow("AI 不读取")
    expect(io!.ingestChapter).not.toHaveBeenCalled()
    expect(io!.ingestOutline).not.toHaveBeenCalled()
  })

  it("没有标记时照常提取（不改变原有行为）", async () => {
    vi.mocked(readFile).mockResolvedValue("---\ntype: chapter\nchapter_number: 1\nchapter_status: final\n---\n\n正文")
    const io = deps()

    await expect(extractProjectMemory({ projectPath: "/book", path: chapterPath }, io))
      .resolves.toContain("章节记忆提取完成")
    expect(io!.ingestChapter).toHaveBeenCalledTimes(1)
  })

  it("文件读不到时不冒充「已排除」：仍交给摄取走既有报错", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"))
    const io = deps()

    await expect(extractProjectMemory({ projectPath: "/book", path: chapterPath }, io))
      .resolves.toContain("章节记忆提取完成")
    expect(io!.ingestChapter).toHaveBeenCalledTimes(1)
  })
})
