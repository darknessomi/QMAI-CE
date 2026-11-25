/** Antigravity 文本请求。Rust 驱动 ACP 会话，Tauri 只转发可见正文、用量和终态。 */
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { LlmConfig } from "@/stores/wiki-store"
import type { LlmUsage } from "@/lib/llm-usage"
import type { ChatMessage, RequestOverrides } from "./llm-providers"
import type { StreamCallbacks } from "./llm-client"

type SpawnPayload = Record<string, unknown> & {
  streamId: string
  model: string
  messages: ChatMessage[]
}

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
        console.warn(`[antigravity-cli] 忽略不支持的参数 "${key}"：agy 没有对应开关`)
      }
    }
  }

  const streamId = crypto.randomUUID()
  let unlistenData: UnlistenFn | (() => void) | undefined
  let unlistenDone: UnlistenFn | (() => void) | undefined
  let finished = false
  let aborted = signal?.aborted ?? false
  let emittedToken = false
  let resolveCompletion: () => void = () => {}
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })

  const cleanup = () => {
    unlistenData?.()
    unlistenDone?.()
  }

  const finishWith = (cb: () => void) => {
    if (finished) return
    finished = true
    cleanup()
    cb()
    resolveCompletion()
  }

  const abortListener = () => {
    aborted = true
    void invoke("antigravity_cli_kill", { streamId }).catch(() => {})
    finishWith(onDone)
  }
  if (aborted) {
    finishWith(onDone)
    return
  }
  signal?.addEventListener("abort", abortListener)

  try {
    unlistenData = await listen<string>(`antigravity-cli:${streamId}`, (event) => {
      if (finished) return
      const data: { text?: string; usage?: LlmUsage } = JSON.parse(event.payload)
      if (data.usage) onUsage?.(data.usage)
      if (data.text) {
        emittedToken = true
        onToken(data.text)
      }
    })
    if (aborted || finished) {
      cleanup()
      return
    }

    unlistenDone = await listen<{ code: number | null; stderr: string }>(
      `antigravity-cli:${streamId}:done`,
      (event) => {
        const code = event.payload?.code
        if (code !== 0) {
          finishWith(() => onError(new Error(event.payload?.stderr || "Antigravity ACP 会话意外结束。")))
          return
        }
        if (!emittedToken) {
          finishWith(() => onError(new Error("Antigravity ACP 没有返回正文。")))
          return
        }
        finishWith(onDone)
      },
    )
    if (aborted || finished) {
      cleanup()
      return
    }

    const payload: SpawnPayload = {
      streamId,
      model: config.model,
      messages,
    }
    await invoke("antigravity_cli_spawn", payload)

    if (aborted || signal?.aborted) {
      aborted = true
      await invoke("antigravity_cli_kill", { streamId }).catch(() => {})
      finishWith(onDone)
      return
    }
    await completion
  } catch (err) {
    finishWith(() => {
      const message = err instanceof Error ? err.message : String(err)
      if (/not found|No such file|executable file not found|未找到 agy/i.test(message)) {
        onError(new Error("未找到 Antigravity CLI。请安装 agy，或在设置里改用其他模型源。"))
      } else {
        onError(err instanceof Error ? err : new Error(message))
      }
    })
  } finally {
    signal?.removeEventListener("abort", abortListener)
  }
}
