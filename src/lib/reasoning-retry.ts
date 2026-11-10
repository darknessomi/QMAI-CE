import type { LlmConfig, ReasoningConfig } from "@/stores/wiki-store"
import type { ChatMessage, RequestOverrides } from "./llm-providers"

const REASONING_ONLY_RESPONSE_RE = /模型只输出了[\s\S]*思考内容[\s\S]*没有输出正文/

function isToolAssistant(message: ChatMessage): boolean {
  return message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0
}

/** DeepSeek thinking 把空串当成没回传；缺字段或空字段都无法续轮。 */
export function hasUnreplayableToolAssistantReasoning(messages: ChatMessage[]): boolean {
  return messages.some((message) => isToolAssistant(message) && !message.reasoning_content?.trim())
}

export function stripEmptyReasoningContent(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.reasoning_content === undefined || message.reasoning_content.trim()) {
      return message
    }
    const { reasoning_content: _dropped, ...rest } = message
    return rest
  })
}

export function isReasoningOnlyResponseError(error: Error): boolean {
  return REASONING_ONLY_RESPONSE_RE.test(error.message)
}

export function isReasoningDisabled(
  config: Pick<LlmConfig, "reasoning">,
  overrides?: RequestOverrides,
): boolean {
  const effectiveReasoning: ReasoningConfig | undefined = overrides?.reasoning ?? config.reasoning
  return effectiveReasoning?.mode === "off"
}

export function withReasoningDisabled(overrides?: RequestOverrides): RequestOverrides {
  return {
    ...(overrides ?? {}),
    reasoning: { mode: "off" },
  }
}

/** 当前请求是否压根没要求思考档位（auto）。用于避免对 auto 请求重复重试。 */
export function isReasoningAuto(
  config: Pick<LlmConfig, "reasoning">,
  overrides?: RequestOverrides,
): boolean {
  const effectiveReasoning: ReasoningConfig | undefined = overrides?.reasoning ?? config.reasoning
  return !effectiveReasoning || effectiveReasoning.mode === "auto"
}

/** 回到 auto：请求体既不发 thinking，也不发 reasoning_effort。 */
export function withReasoningAuto(overrides?: RequestOverrides): RequestOverrides {
  return {
    ...(overrides ?? {}),
    reasoning: { mode: "auto" },
  }
}

/** 去掉 temperature：交给服务端用它的默认值（Kimi 要求必须是 1）。 */
export function withTemperatureStripped(overrides?: RequestOverrides): RequestOverrides {
  const { temperature: _temperature, ...rest } = overrides ?? {}
  return rest
}

const ALWAYS_THINKING_REJECTION_RE =
  /始终思考|不支持关闭思考|always[- ]thinking|cannot be disabled|does not support disabling thinking/i
const ZHIPU_INVALID_PARAM_RE = /"code"\s*:\s*"?1210"?/

/**
 * 服务端明确表示「这个型号始终思考，关不掉」（智谱 code 1210）。
 *
 * 静态识别（`modelAlwaysThinks`）只覆盖我们确认过的型号；这条判定负责兜住
 * 未列出的新 id，让请求自动降级为「不发思考参数」而不是把 400 甩给用户。
 */
export function isAlwaysThinkingRejection(errorDetail: string): boolean {
  if (ALWAYS_THINKING_REJECTION_RE.test(errorDetail)) return true
  return ZHIPU_INVALID_PARAM_RE.test(errorDetail) && /思考|thinking/i.test(errorDetail)
}

const TEMPERATURE_REJECTION_RE =
  /invalid temperature|only 1 is allowed|temperature (?:is )?not supported|unsupported parameter[^a-z]*temperature/i

/** 服务端明确表示 temperature 不被接受（Kimi 系只允许 1）。 */
export function isTemperatureRejected(errorDetail: string): boolean {
  return TEMPERATURE_REJECTION_RE.test(errorDetail)
}
