import { parseFrontmatter } from "@/lib/frontmatter"
import { parsePersonaProjectionFrontmatter } from "./persona-projection"

/**
 * 「选中（AI 不读取）」的唯一数据口径。
 *
 * 用户需求：在大纲 / MD / HTML 三处工具栏点「选中」后，这篇内容**不再加入模型**，
 * AI 任何时候都不读取。状态落在文件**自己的 frontmatter** 里：
 *
 * ```yaml
 * ---
 * type: outline
 * ai_exclude: true
 * ---
 * ```
 *
 * 为什么写在文件里，而不是另建一份排除清单：
 * 1. `outline-context-index.ts#createOutlineDocumentIndex` 本来就要对每份大纲
 *    `parseFrontmatter`，过滤是一行的事；章节读取链同样先解析 frontmatter。
 * 2. 用户复制 / 移动 / 备份文件时状态跟着走，不会像外部清单那样失联。
 * 3. 不新增第二个真相源，也就不需要同步逻辑。
 *
 * ⚠️ 值读回来是**字符串** `"true"` 而不是布尔：`frontmatter.ts#normalize` 把所有
 * 标量都 `stringifyScalar` 了（见该文件），所以这里必须同时接受 `true` / `"true"` /
 * `1` / `"1"` / `"yes"`。只认布尔会让磁盘上明明写着 `ai_exclude: true` 的文件
 * 判定为「没排除」—— 那正是本功能最不能出的错。
 */
export const AI_EXCLUDE_KEY = "ai_exclude"

const TRUE_VALUES = new Set(["true", "yes", "y", "1", "on"])
const AI_EXCLUDE_LINE_RE = /^ai_exclude:[ \t]*.*$/m
const OPEN_FENCE_RE = /^---[ \t]*\r?\n/

/** 插入新行时跟随文件自身的换行风格，避免在 CRLF 文件里混入一个 LF。 */
function detectEol(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n"
}

function toBooleanLike(value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value === 1
  if (typeof value === "string") return TRUE_VALUES.has(value.trim().toLowerCase())
  return false
}

/** 解析出来的 frontmatter 是否带「不参与 AI」标记。 */
export function isAiExcluded(frontmatter: Record<string, unknown> | null | undefined): boolean {
  if (!frontmatter) return false
  return toBooleanLike(frontmatter[AI_EXCLUDE_KEY])
}

/**
 * 直接看文件全文是否被选中排除。
 *
 * 给「读到就拦」的闸口用（Agent 工具、章节回退读取）：它们手上只有原始文本，
 * 没有解析好的 frontmatter。
 */
export function isAiExcludedContent(content: string): boolean {
  if (!content) return false
  return isAiExcluded(parsePersonaProjectionFrontmatter(content).frontmatter)
}

/**
 * 在文件全文上写入 / 撤销「不参与 AI」标记。
 *
 * 只碰 `ai_exclude` 这一行，其余 YAML、正文、换行风格原样保留 ——
 * 这个函数会被「点按钮立刻落盘」的路径调用，改动面越小越好：
 * 没有这一层保证，用户点一下「选中」就会得到一份被重排过的 frontmatter。
 */
export function setAiExcluded(content: string, excluded: boolean): string {
  const parsed = parseFrontmatter(content)
  const rawBlock = parsed.rawBlock

  const eol = detectEol(content)

  if (!rawBlock) {
    if (!excluded) return content
    // 没有 frontmatter 的文件：补一个最小的块，其余内容一字不动。
    return `---${eol}${AI_EXCLUDE_KEY}: true${eol}---${eol}${content.replace(/^(?:\r?\n)+/, "")}`
  }

  if (!excluded) {
    if (!AI_EXCLUDE_LINE_RE.test(rawBlock)) return content
    return rawBlock.replace(/^ai_exclude:[ \t]*.*\r?\n?/m, "") + parsed.body
  }

  const nextRawBlock = AI_EXCLUDE_LINE_RE.test(rawBlock)
    ? rawBlock.replace(AI_EXCLUDE_LINE_RE, `${AI_EXCLUDE_KEY}: true`)
    : rawBlock.replace(OPEN_FENCE_RE, (fence) => `${fence}${AI_EXCLUDE_KEY}: true${eol}`)

  return nextRawBlock + parsed.body
}
