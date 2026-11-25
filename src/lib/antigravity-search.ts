import type { WebSearchResult } from "@/lib/web-search"

/** 联网搜索使用独立的 agy ACP 会话，来源取自已完成的 search_web 工具输出。 */
export const ANTIGRAVITY_SEARCH_TIMEOUT_SECS = 180
/** 设置里允许的搜索超时范围（秒），与 Rust 端 clamp 一致。 */
export const ANTIGRAVITY_SEARCH_TIMEOUT_MIN_SECS = 30
export const ANTIGRAVITY_SEARCH_TIMEOUT_MAX_SECS = 900

/** 把设置里保存的超时（可能缺失/非法，旧配置没有该字段）规范成 30–900 秒的整数，缺省 180。 */
export function resolveAntigravitySearchTimeoutSecs(value?: unknown): number {
  const n = typeof value === "string" ? Number(value.trim()) : typeof value === "number" ? value : NaN
  if (!Number.isFinite(n) || n <= 0) return ANTIGRAVITY_SEARCH_TIMEOUT_SECS
  return Math.min(ANTIGRAVITY_SEARCH_TIMEOUT_MAX_SECS, Math.max(ANTIGRAVITY_SEARCH_TIMEOUT_MIN_SECS, Math.round(n)))
}

/** 搜索模型留空时使用的默认模型：最低档 Flash，避免 agy 默认的 Gemini 4 Argon 额度消耗过高。 */
export const DEFAULT_ANTIGRAVITY_SEARCH_MODEL = "gemini-3.8-flash-low"
/** 设置里显式选择「agy 默认模型」时保存的值：调用时沿用会话默认模型。 */
export const ANTIGRAVITY_AGY_DEFAULT_MODEL = "__agy_default__"

/** 把设置里保存的搜索模型换成ACP 会话的模型 ID，null 表示沿用默认模型。 */
export function resolveAntigravitySearchModel(model?: string | null): string | null {
  const trimmed = model?.trim() ?? ""
  if (!trimmed) return DEFAULT_ANTIGRAVITY_SEARCH_MODEL
  if (trimmed === ANTIGRAVITY_AGY_DEFAULT_MODEL) return null
  return trimmed
}

/** 由 agy 模型 slug 生成展示名，如 gemini-3.8-flash-low → Gemini 3.8 Flash (Low)。 */
export function antigravityModelLabel(slug: string): string {
  const parts = slug.trim().split("-").filter(Boolean)
  if (parts.length === 0) return slug
  const tiers = ["low", "medium", "high"]
  const last = parts[parts.length - 1].toLowerCase()
  const tier = tiers.includes(last) ? parts.pop()! : ""
  const cap = (w: string) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)
  const name = parts.map((w) => (w.toLowerCase() === "gpt" || w.toLowerCase() === "oss" ? w.toUpperCase() : cap(w))).join(" ")
  return tier ? `${name} (${cap(tier)})` : name
}

export interface AntigravitySearchOutcome {
  results: WebSearchResult[]
  queries: string[]
  summary: string
}

export interface AntigravitySearchOptions {
  model?: string
  maxResults?: number
  timeoutSecs?: number
  /** 测试注入；默认用 Tauri invoke。 */
  invoke?: (cmd: string, args: Record<string, unknown>) => Promise<unknown>
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === "string" ? v : "")

function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const body = fenced ? fenced[1] : trimmed
  try {
    return JSON.parse(body)
  } catch {
    const start = body.indexOf("{")
    const end = body.lastIndexOf("}")
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1))
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

/** 从 search_web 的输出里尽量认出来源链接（结构化数组或纯文本里的 URL）。 */
function sourcesFromOutput(output: unknown): WebSearchResult[] {
  const out: WebSearchResult[] = []
  const push = (url: string, title = "", snippet = "") => {
    if (!/^https?:\/\//i.test(url)) return
    out.push({ title: title || hostname(url) || url, url, snippet, source: hostname(url) })
  }
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || value == null) return
    if (typeof value === "string") {
      const parsed = value.trim().startsWith("{") || value.trim().startsWith("[") ? parseJsonLoose(value) : undefined
      if (parsed !== undefined) return visit(parsed, depth + 1)
      for (const match of value.matchAll(/https?:\/\/[^\s)\]"'<>]+/g)) push(match[0].replace(/[.,;，。]+$/, ""))
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1))
      return
    }
    if (isObj(value)) {
      const url = str(value.url) || str(value.link) || str(value.uri)
      if (url) {
        push(url, str(value.title), str(value.snippet) || str(value.content) || str(value.description))
        return
      }
      Object.values(value).forEach((item) => visit(item, depth + 1))
    }
  }
  visit(output, 0)
  return out
}

export class AntigravitySearchError extends Error {}

async function defaultInvoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke(cmd, args)
}

export async function antigravitySearchDetailed(
  query: string,
  options: AntigravitySearchOptions = {},
): Promise<AntigravitySearchOutcome> {
  const maxResults = options.maxResults ?? 10
  let raw: unknown
  try {
    raw = (await (options.invoke ?? defaultInvoke)("antigravity_cli_search", {
      query,
      model: resolveAntigravitySearchModel(options.model),
      maxResults,
      timeoutSecs: resolveAntigravitySearchTimeoutSecs(options.timeoutSecs),
    }))
  } catch (error) {
    throw new AntigravitySearchError(
      `无法调用反重力 CLI 搜索：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!isObj(raw) || !Array.isArray(raw.queries) || !raw.queries.length ||
      !raw.queries.every((q): q is string => typeof q === "string" && !!q.trim()) ||
      typeof raw.summary !== "string" || !raw.summary.trim() || !Array.isArray(raw.outputs)) {
    throw new AntigravitySearchError("反重力 ACP 搜索返回了无效数据。")
  }
  const seen = new Set<string>()
  const results = raw.outputs.flatMap(sourcesFromOutput).filter(({ url }) => {
    if (seen.has(url)) return false
    seen.add(url)
    return true
  }).slice(0, maxResults)
  return { queries: raw.queries, summary: raw.summary, results }
}
