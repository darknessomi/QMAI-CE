import { streamChat } from "@/lib/llm-client"
import { fetchLlmModelList } from "@/lib/settings-model-list"
import type { LlmConfig } from "@/stores/wiki-store"

const TEST_TIMEOUT_MS = 30_000

interface LlmModelTestResult {
  model: string
  content: string
}

function ensureModel(model: string, emptyMessage: string): string {
  const trimmed = model.trim()
  if (!trimmed) {
    throw new Error(emptyMessage)
  }
  return trimmed
}

export function normalizeModelTestError(error: Error): Error {
  const message = error.message

  if (message === "Load failed" || /failed to fetch|networkerror|load failed/i.test(message)) {
    return new Error(
      "无法连接模型接口（Load failed）。若使用 Cursor CLI，请先在设置中重新检查 CLI 状态，确认 proxy 已拉起后再测。",
    )
  }

  if (/insufficient account balance/i.test(message)) {
    return new Error("当前中转站账户余额不足，或该模型没有可用额度，请先充值或切换可用模型。")
  }

  if (/client not allowed/i.test(message)) {
    return new Error("当前中转站限制了客户端来源，拒绝了桌面端、浏览器或常见 SDK 请求。请联系中转站放开通用 OpenAI 兼容 API，或切换可直连的中转站。")
  }

  const unsupportedModel = extractUnsupportedModel(message)
  if (unsupportedModel || (/HTTP 404/i.test(message) && /模型|model/i.test(message))) {
    return new Error(
      `当前接口不支持所选模型${unsupportedModel ? ` ${unsupportedModel}` : ""}。请从模型下拉框选择已拉取到的模型，或向中转站确认正确模型 ID。`,
    )
  }

  return error
}

function extractUnsupportedModel(message: string): string | null {
  const patterns = [
    /不支持所选模型\s*["“]?([^"”\s，,]+)/i,
    /unsupported(?: selected)? model\s*["']?([^"'\s,}]+)/i,
    /model\s+["']?([^"'\s,}]+)["']?\s+(?:is\s+)?(?:not found|not supported)/i,
  ]

  for (const pattern of patterns) {
    const matched = message.match(pattern)?.[1]?.trim()
    if (matched) return matched
  }
  return null
}

async function resolveChatModelConfig(config: LlmConfig): Promise<{ config: LlmConfig; model: string }> {
  const explicitModel = config.model.trim()
  if (explicitModel) {
    return { config, model: explicitModel }
  }

  if (config.provider === "claude-code" || config.provider === "codex-cli") {
    const result = await fetchLlmModelList(config)
    const model = ensureModel(
      result.models[0] ?? "",
      "请先在本地 CLI 中设置默认模型，或在软件里手动填写模型后再测试。",
    )
    return {
      config: { ...config, model },
      model,
    }
  }

  return {
    config,
    model: ensureModel(explicitModel, "请先填写模型名称后再测试。"),
  }
}

async function runChatModelTest(config: LlmConfig, prompt: string): Promise<LlmModelTestResult> {
  const resolved = await resolveChatModelConfig(config)
  let content = ""
  let streamError: Error | null = null

  await streamChat(
    resolved.config,
    [{ role: "user", content: prompt }],
    {
      onToken: (token) => {
        content += token
      },
      onDone: () => undefined,
      onError: (error) => {
        streamError = error
      },
    },
    AbortSignal.timeout(TEST_TIMEOUT_MS),
    {
      temperature: 0,
      max_tokens: 80,
    },
  )

  if (streamError) {
    throw normalizeModelTestError(streamError)
  }

  const trimmed = content.trim()
  if (!trimmed) {
    throw new Error("模型已连接，但没有返回可用内容。")
  }

  return {
    model: resolved.model,
    content: trimmed,
  }
}

export async function testSettingsLlmModel(config: LlmConfig): Promise<LlmModelTestResult> {
  return runChatModelTest(
    config,
    "你正在执行模型连通性测试。请只回答“模型测试成功”。",
  )
}
