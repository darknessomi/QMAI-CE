import type { LlmConfig } from "@/stores/wiki-store"
import { estimateChatMessagesTokens } from "./chat-request-budget"
import { LlmContextBudgetError, MIN_LLM_OUTPUT_TOKENS, planLlmRequestBudget } from "./context-budget"
import { estimateContextTokens } from "./context-hub/token-estimator"
import { MERGER_RULES, type DuplicateGroup, type MergeRequest, type MergeResult } from "./dedup"
import { createMergeRedirect, rewritePageLinks } from "./dedup-links"
import { parseFrontmatter } from "./frontmatter"
import { OUTPUT_TRUNCATED_ERROR_MARKER } from "./llm-client"
import { trustDeclaredContextWindow } from "./llm-context-size"
import { getEffectiveMaxOutputTokens, reasoningOutputFloor } from "./llm-providers"

const DEDUP_BATCH_WINDOW_TOKENS = 50_000
const SYSTEM = `你是维基维护助手。输入是多组已确认重复的页面。每个 id 是一个独立的合并任务，事实、来源、名称均限于该组。请根据正文和书中惯用称呼从本组选择一个现有 slug 作为主条目，候选顺序不表示优先级。
${MERGER_RULES}
每组返回一份完整文件，含 YAML frontmatter 和正文。只输出一个 JSON 对象，格式为 {"results":[{"id":1,"canonicalSlug":"组内已有的 slug","content":"完整 Markdown 文件"}]}。照抄输入的数字 id，每组恰好一次。`

type Pages = MergeRequest["group"]
interface Candidate { id: string; group: DuplicateGroup }
export interface PreparedMerge {
  sources: Pages
  canonicalSlug: string
  content: string
}

export interface DedupMergeBatch {
  current: Candidate
  following: () => Iterable<Candidate>
  drafts: Map<string, PreparedMerge>
  isPending: (id: string) => boolean
}

interface RequestGroup {
  task: Candidate
  sources: Pages
  json: string
  estimatedOutput: number
}

class IncompleteBatchReply extends Error {}

function parseBatchReply(raw: string, groups: RequestGroup[]): Map<number, PreparedMerge> {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(raw)
  let result: { results?: unknown } | null
  try { result = JSON.parse(fenced?.[1] ?? raw) } catch { throw new IncompleteBatchReply("批量合并回复不是完整 JSON，原文件已保留") }
  if (!Array.isArray(result?.results)) throw new IncompleteBatchReply("批量合并回复缺少结果列表，原文件已保留")
  const seen = new Set<number>()
  const valid = new Map<number, PreparedMerge>()
  for (const row of result.results) {
    if (!row || !Number.isInteger(row.id) || row.id < 1 || row.id > groups.length) continue
    if (seen.has(row.id)) {
      valid.delete(row.id)
      continue
    }
    seen.add(row.id)
    const { sources } = groups[row.id - 1]
    if (typeof row.content === "string" && sources.some((p) => p.slug === row.canonicalSlug)) {
      const { frontmatter, body } = parseFrontmatter(row.content)
      if (frontmatter && body.trim()) {
        valid.set(row.id, { sources, canonicalSlug: row.canonicalSlug, content: row.content })
      }
    }
  }
  return valid
}

export async function getBatchMergeDraft(
  batch: DedupMergeBatch,
  pages: Pages,
  resolve: (slugs: string[]) => Pages,
  config: LlmConfig,
  request: (system: string, user: string, maxTokens: number, windowTokens: number, groupCount: number) => Promise<string>,
  log?: (message: string) => void,
): Promise<PreparedMerge> {
  const cached = batch.drafts.get(batch.current.id)
  if (cached && pages.length === cached.sources.length && pages.every((page, i) =>
    page.path === cached.sources[i].path && page.content === cached.sources[i].content)) {
    log?.("使用本批模型已生成的合并结果")
    return cached
  }
  batch.drafts.delete(batch.current.id)

  const outputCap = getEffectiveMaxOutputTokens(config)
  const budget = planLlmRequestBudget({
    maxContextSize: trustDeclaredContextWindow(config.maxContextSize),
    desiredOutputTokens: MIN_LLM_OUTPUT_TOKENS,
    maxOutputTokensCap: outputCap,
    thinkingFloorTokens: reasoningOutputFloor(config),
    scaffoldReserveTokens: 0,
  })
  const window = Math.min(DEDUP_BATCH_WINDOW_TOKENS, budget.windowTokens)
  const groups: RequestGroup[] = []
  const usedSlugs = new Set<string>()
  let input = estimateChatMessagesTokens([{ role: "system", content: SYSTEM }, { role: "user", content: "[]" }])
  let output = 0
  function append(task: Candidate, sources: Pages): boolean {
    const id = groups.length + 1
    const json = JSON.stringify({ id, pages: sources.map(({ slug, content }) => ({ slug, content })) })
    const nextInput = input + estimateContextTokens(json + ",")
    // Budget for a whole merged file per group. Most duplicates share some text,
    // but the result should accommodate at least the longest original plus its JSON envelope.
    const sizes = sources.map(({ content }) => estimateContextTokens(JSON.stringify(content)))
    const bodyTokens = Math.max(Math.max(...sizes), Math.ceil(sizes.reduce((a, b) => a + b, 0) * 0.75))
    const slugTokens = Math.max(...sources.map(({ slug }) => estimateContextTokens(JSON.stringify(slug))))
    const estimatedOutput = bodyTokens + slugTokens + 48
    const nextOutput = output + estimatedOutput
    const available = Math.min(outputCap, window - nextInput)
    if (available < budget.outputTokens || (groups.length > 0 && nextOutput > available)) return false
    groups.push({ task, sources, json, estimatedOutput })
    for (const { slug } of sources) usedSlugs.add(slug)
    input = nextInput
    output = nextOutput
    return true
  }

  if (!append(batch.current, pages)) {
    throw new Error(`本组完整正文和必要回复空间超出本次 ${window.toLocaleString("en-US")} token 预算，原文件已保留`)
  }
  for (const task of batch.following()) {
    if (batch.drafts.has(task.id) || task.group.slugs.some((slug) => usedSlugs.has(slug))) continue
    let sources: Pages
    try {
      sources = resolve(task.group.slugs)
    } catch {
      // A stale or ambiguous later task reports its own error when it reaches the queue head.
      continue
    }
    if (!append(task, sources)) break
  }

  let included = groups
  let valid: Map<number, PreparedMerge>
  while (true) {
    const user = "[" + included.map((g) => g.json).join(",") + "]"
    const inputTokens = estimateChatMessagesTokens([{ role: "system", content: SYSTEM }, { role: "user", content: user }])
    const expectedOutput = included.reduce((total, group) => total + group.estimatedOutput, 0)
    const maxTokens = Math.min(outputCap, window - inputTokens, Math.max(budget.outputTokens, Math.ceil(expectedOutput * 1.25) + 512))
    log?.(`本次模型请求合并 ${included.length} 组，预计输入 ${inputTokens} token，最多输出 ${maxTokens} token`)
    try {
      const raw = await request(SYSTEM, user, maxTokens, window, included.length)
      valid = parseBatchReply(raw.trim(), included)
      break
    } catch (error) {
      const canSplit = error instanceof IncompleteBatchReply || error instanceof LlmContextBudgetError ||
        (error instanceof Error && (error.message.includes(OUTPUT_TRUNCATED_ERROR_MARKER) ||
          /context_length_exceeded|maximum context length|prompt is too long/i.test(error.message)))
      if (!canSplit || included.length === 1) throw error
      included = included.slice(0, Math.ceil(included.length / 2))
      log?.(`本次请求超限或回复不完整，缩小到 ${included.length} 组重试`)
    }
  }
  for (const [id, draft] of valid) {
    const key = included[id - 1].task.id
    if (batch.isPending(key)) batch.drafts.set(key, draft)
  }
  const current = valid.get(1)
  if (!current) throw new Error("模型未返回本组唯一且有效的合并结果，请重试")
  return current
}

/** Carry this committed merge's link rewrites into other drafts from the same request.
 * External edits still fail the exact source comparison before those drafts are used. */
export function advanceBatchDrafts(batch: DedupMergeBatch, result: MergeResult, allPaths: string[]) {
  batch.drafts.delete(batch.current.id)
  if (!batch.drafts.size) return
  const redirect = createMergeRedirect(result.pagesToDelete, result.canonicalPath, allPaths)
  const originals = new Map(result.backup.map((page) => [page.path, page.content]))
  const rewrites = new Map(result.rewrites.map((page) => [page.path, page.newContent]))
  for (const draft of batch.drafts.values()) {
    draft.content = rewritePageLinks(draft.content, redirect)
    draft.sources = draft.sources.map((page) => {
      const updated = rewrites.get(page.path)
      return updated !== undefined && originals.get(page.path) === page.content ? { ...page, content: updated } : page
    })
  }
}
