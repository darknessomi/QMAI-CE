import { formatToolResultForModel } from "./tool-result"
import { trustDeclaredContextWindow } from "@/lib/llm-context-size"
import { estimateContextTokens } from "@/lib/context-hub/token-estimator"
import { computeNovelContextTokenBudget } from "@/lib/context-budget"
import { fitChapterOutline } from "@/lib/novel/chapter-outline-excerpt"
import { isChapterOutlineRead } from "@/lib/novel/outline-context-index"

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableValue(item)]))
}

function resultHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

export class ToolEvidenceLedger {
  private readonly entries = new Map<string, { id: string; resultHash: string }>()
  private sequence = 0

  constructor(private readonly resultLimit?: number, private readonly windowTokens?: number) {}

  format(toolName: string, params: Record<string, unknown>, result: string): string {
    const key = `${toolName}:${JSON.stringify(stableValue(params))}`
    const hash = resultHash(result)
    const existing = this.entries.get(key)
    if (existing?.resultHash === hash) {
      return `工具证据引用：${existing.id}。本次结果与先前相同，不再重复注入全文。`
    }
    const id = `evidence-${String(++this.sequence).padStart(3, "0")}`
    this.entries.set(key, { id, resultHash: hash })
    // 显式配置仍按调用方字符限额。默认的章纲读取则使用本轮模型的资料预算。
    let content: string
    if (toolName === "read_outline" && this.resultLimit === undefined
      && isChapterOutlineRead(params.path ?? params.name, result)) {
      const window = trustDeclaredContextWindow(this.windowTokens)
      const budget = Math.min(computeNovelContextTokenBudget(window), Math.floor(window * 0.75))
      content = estimateContextTokens(result) <= budget ? result : fitChapterOutline(result, budget)
    } else {
      content = formatToolResultForModel(toolName, result, this.resultLimit)
    }
    return [
      `工具证据 ID：${id}`,
      content,
    ].join("\n")
  }
}
