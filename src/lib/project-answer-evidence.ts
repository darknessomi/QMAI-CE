import { getJevConfig } from "./jev-config"
import { searchWiki } from "./search"
import { normalizePath } from "./path-utils"

/** 查询结果作为用户资料放入本轮消息，以便回答能够引用到具体原文。 */
export async function projectAnswerEvidence(
  projectPath: string, question: string, signal: AbortSignal, maxContextSize: number,
): Promise<string> {
  if (!getJevConfig() || !question.trim()) return ""
  const query = Array.from(question.trim()).slice(0, 2000).join("")
  const results = await searchWiki(projectPath, query, { topK: 5, signal })
  signal.throwIfAborted()
  let remaining = Math.min(5000, Math.floor((maxContextSize || 8192) / 3))
  const prefix = normalizePath(projectPath).replace(/\/$/, "") + "/"
  const passages: string[] = []
  for (const result of results) {
    const path = normalizePath(result.path)
    const source = path.startsWith(prefix) ? path.slice(prefix.length) : result.title
    const line = result.startLine === undefined ? "" : `，第 ${result.startLine}–${result.endLine ?? result.startLine} 行`
    const heading = `〔${source}${line}〕\n`
    if (remaining <= heading.length) break
    const passage = heading + result.snippet.slice(0, remaining - heading.length)
    passages.push(passage)
    remaining -= passage.length + 2
  }
  return passages.length
    ? `以下为检索到的项目原文。请将引文作为参考资料，根据其内容回答并注明出处。\n\n${passages.join("\n\n")}`
    : "本次项目检索没有找到可引用的原文。"
}
