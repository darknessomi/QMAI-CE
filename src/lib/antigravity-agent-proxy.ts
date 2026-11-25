/**
 * Antigravity CLI（agy）主 Agent 代理的前端入口。
 *
 * 本机 OpenAI 兼容代理通过 ACP 创建会话，经 HTTP MCP 把工具请求交回 QMAI。
 */
import type { LlmConfig } from "@/stores/wiki-store"
import type { RequestOverrides } from "./llm-providers"

/** 用户没选模型时，主 Agent 默认用 medium 档（有思考，工具调用更稳）。 */
export const DEFAULT_ANTIGRAVITY_AGENT_MODEL = "gemini-3.8-flash-medium"

export interface AntigravityAgentProxyStatus {
  baseUrl: string
  token: string
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

async function defaultInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<T>(command, args)
}

let cached: Promise<AntigravityAgentProxyStatus> | null = null

export function resolveAntigravityAgentModel(model?: string | null): string {
  const trimmed = (model ?? "").trim()
  return trimmed || DEFAULT_ANTIGRAVITY_AGENT_MODEL
}

/** 这次请求是否要走主 Agent 代理：只有带工具的 Antigravity 请求才走。 */
export function shouldUseAntigravityAgentProxy(
  config: Pick<LlmConfig, "provider">,
  overrides?: RequestOverrides,
): boolean {
  return config.provider === "antigravity-cli"
    && overrides?.toolChoice !== "none"
    && Array.isArray(overrides?.tools)
    && overrides.tools.length > 0
}

export async function ensureAntigravityAgentProxy(invoke: Invoke = defaultInvoke): Promise<AntigravityAgentProxyStatus> {
  if (!cached) {
    cached = invoke<AntigravityAgentProxyStatus>("antigravity_agent_proxy_ensure").catch((error) => {
      cached = null
      throw new Error(`无法启动 Antigravity 主 Agent 代理：${error instanceof Error ? error.message : String(error)}`)
    })
  }
  return cached
}

export function withAntigravityAgentProxy(config: LlmConfig, proxy: AntigravityAgentProxyStatus): LlmConfig {
  return {
    ...config,
    customEndpoint: proxy.baseUrl,
    apiKey: proxy.token,
    apiMode: "chat_completions",
    model: resolveAntigravityAgentModel(config.model),
  }
}

/** Agent 被停止时，结束仍在等这些工具结果的 agy 进程。 */
export async function cancelAntigravityToolCalls(toolCallIds: string[], invoke: Invoke = defaultInvoke): Promise<void> {
  if (toolCallIds.length === 0) return
  await invoke<number>("antigravity_agent_cancel", { toolCallIds }).catch(() => 0)
}

export function resetAntigravityAgentProxyCacheForTests(): void {
  cached = null
}
