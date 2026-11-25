/** Antigravity 文本请求。Rust 驱动 ACP 会话，Tauri 只转发可见正文、用量和终态。 */
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { LlmConfig } from "@/stores/wiki-store"
import type { LlmUsage } from "@/lib/llm-usage"
import type { ChatMessage, RequestOverrides } from "./llm-providers"
import type { StreamCallbacks } from "./llm-client"

type TextEvent =
  | { type: "text"; text: string }
  | { type: "usage"; usage: LlmUsage }
  | { type: "done" }
  | { type: "error"; message: string }

export async function streamAntigravityCli(
  config: LlmConfig,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  overrides?: RequestOverrides,
): Promise<void> {
  const { onToken, onDone, onError, onUsage } = callbacks

  if (import.meta.env?.DEV && overrides) {
    for (const key of ["temperature", "top_p", "top_k", "max_tokens", "stop"] as const) {
      if (overrides[key] !== undefined) {
        // eslint-disable-next-line no-console
        console.warn(`[antigravity-acp] 文本请求不支持参数 "${key}"`)
      }
    }
  }

  if (signal?.aborted) {
    onDone()
    return
  }

  const streamId = crypto.randomUUID()
  let unlisten: UnlistenFn | undefined
  let spawned = false
  let finished = false
  let emittedText = false
  let resolveCompletion!: () => void
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve })

  const finish = (callback: () => void) => {
    if (finished) return
    finished = true
    resolveCompletion()
    callback()
  }
  const cancel = () => invoke("antigravity_cli_kill", { streamId }).catch(() => {})
  const onAbort = () => {
    if (finished) return
    if (spawned) void cancel()
    finish(onDone)
  }
  signal?.addEventListener("abort", onAbort)
  try {
    unlisten = await listen<TextEvent>(`antigravity-cli:${streamId}`, ({ payload }) => {
      if (finished) return
      switch (payload.type) {
        case "text":
          if (payload.text) {
            emittedText = true
            onToken(payload.text)
          }
          break
        case "usage":
          onUsage?.(payload.usage)
          break
        case "done":
          finish(emittedText ? onDone : () => onError(new Error("Antigravity ACP 没有返回正文。")))
          break
        case "error":
          finish(() => onError(new Error(payload.message)))
          break
      }
    })
    if (finished) return
    await invoke("antigravity_cli_spawn", { streamId, model: config.model, messages })
    spawned = true
    if (signal?.aborted) {
      await cancel()
      return
    }
    await completion
  } catch (err) {
    finish(() => {
      const message = err instanceof Error ? err.message : String(err)
      if (/not found|No such file|executable file not found|未找到 agy/i.test(message)) {
        onError(new Error("未找到 Antigravity CLI。请安装 agy，或在设置里改用其他模型源。"))
      } else {
        onError(err instanceof Error ? err : new Error(message))
      }
    })
  } finally {
    unlisten?.()
    signal?.removeEventListener("abort", onAbort)
  }
}
