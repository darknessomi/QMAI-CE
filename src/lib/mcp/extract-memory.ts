import { readFile } from "@/commands/fs"
import { isAiExcludedContent } from "@/lib/novel/ai-exclude"
import { ingestChapter, ingestOutline } from "@/lib/novel/chapter-ingest"
import { requireProjectDocument } from "./paths"

export async function extractProjectMemory(input: {
  projectPath: string
  path: string
  allowDraft?: boolean
}, deps: {
  ingestChapter: typeof ingestChapter
  ingestOutline: typeof ingestOutline
} = { ingestChapter, ingestOutline }): Promise<string> {
  const kind = requireProjectDocument(input.projectPath, input.path)
  /*
   * 「选中（AI 不读取）」：外部 Agent 走 MCP 的 `extract_memory` 也不能读被选中的文档。
   * 提取记忆就是让模型读全文，这一处不拦，界面上禁用的按钮就只防住了 UI。
   *
   * ⚠️ 读不到文件时**不**当成排除（`.catch(() => "")`）：交给下面的摄取按既有语义
   * 报错，否则「路径写错了」会被误报成「已被排除」，排查反而更费劲。
   */
  const sourceContent = await readFile(input.path).catch(() => "")
  if (sourceContent && isAiExcludedContent(sourceContent)) {
    throw new Error("该文档已被作者标记为「选中（AI 不读取）」，不能提取记忆；需要作者在界面上取消选中。")
  }
  if (kind === "outline") {
    const result = await deps.ingestOutline(input.projectPath, input.path)
    if (!result.snapshot) {
      throw new Error(`大纲记忆提取失败：${result.failureReason ?? "未知错误"}`)
    }
    return `大纲记忆提取完成：第 ${result.snapshot.chapterNumber} 章`
  }
  const result = await deps.ingestChapter(
    input.projectPath,
    input.path,
    undefined,
    undefined,
    undefined,
    { allowDraft: input.allowDraft === true },
  )
  if (!result.snapshot) {
    throw new Error(`章节记忆提取失败：${result.error ?? result.failReason ?? "未知错误"}`)
  }
  return `章节记忆提取完成：第 ${result.snapshot.chapterNumber} 章`
}
