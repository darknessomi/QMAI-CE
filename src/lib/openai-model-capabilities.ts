import type { ChatMessage, RequestOverrides } from "./llm-providers"
import type { LlmConfig, ReasoningMode } from "@/stores/wiki-store"

// https://developers.openai.com/api/docs/models
export const OPENAI_OFFICIAL_MAX_OUTPUT_TOKENS = 128_000

// https://developers.openai.com/api/docs/guides/deployment-checklist
const openAiModels = {
  "gpt-6.2-astra": { none: false, max: true, toolWire: "responses" },
  "gpt-6.2-sol": { none: false, max: true, toolWire: "responses" },
  "gpt-6.1-terra": { none: true, max: true, toolWire: "responses" },
  // Luna 在 none 档也允许 Chat 函数调用；QMAI 的 GPT-6 工具轮统一使用 Responses。
  "gpt-6-luna": { none: true, max: true, toolWire: "responses" },
  "gpt-5.5": { none: true, max: false, toolWire: "chat-if-off" },
} as const

export function openAiCapabilities(config: Pick<LlmConfig, "provider" | "model">) {
  if (config.provider !== "openai") return undefined
  const model = config.model.trim().toLowerCase()
  if (model === "gpt-5.5-2026-04-23") return openAiModels["gpt-5.5"]
  if (!Object.prototype.hasOwnProperty.call(openAiModels, model)) return undefined
  return openAiModels[model as keyof typeof openAiModels]
}

export function openAiReasoningMode(config: Pick<LlmConfig, "provider" | "model">, mode: ReasoningMode): ReasoningMode {
  const capabilities = openAiCapabilities(config)
  if (!capabilities) return mode === "xhigh" ? "high" : mode
  if (mode === "off" && !capabilities.none) return "low"
  if (mode === "max" && !capabilities.max) return "xhigh"
  // 旧配置中的自定义 token 预算没有相应的 OpenAI 参数，沿用历史高档。
  return mode === "custom" ? "high" : mode
}

export function modelOffersReasoningMode(config: Pick<LlmConfig, "provider" | "model"> | undefined, mode: ReasoningMode): boolean {
  if (!config || !openAiCapabilities(config)) return mode !== "xhigh"
  return mode === openAiReasoningMode(config, mode)
}

export function requiresOpenAiResponses(config: LlmConfig, overrides?: RequestOverrides, messages?: readonly ChatMessage[]): boolean {
  const capabilities = openAiCapabilities(config)
  if (!capabilities) return false
  if (messages?.some((message) => message.responsesOutput?.length)) return true
  const withTools = overrides?.tools?.length || messages?.some((message) => message.role === "tool" || message.tool_calls?.length)
  if (!withTools) return false
  const mode = overrides?.reasoning?.mode ?? config.reasoning?.mode
  return capabilities.toolWire === "responses" || mode !== "off"
}
