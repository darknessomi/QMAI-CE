import { beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import type { LlmConfig } from "@/stores/wiki-store"
import { streamAntigravityCli } from "./antigravity-cli-transport"

type EventHandler = (event: { payload: unknown }) => void

const tauriMock = vi.hoisted(() => {
  const listeners = new Map<string, Set<EventHandler>>()
  return {
    listeners,
    emit(topic: string, payload: unknown) {
      for (const handler of listeners.get(topic) ?? []) handler({ payload })
    },
    reset() {
      listeners.clear()
    },
  }
})

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (topic: string, handler: EventHandler) => {
    const handlers = tauriMock.listeners.get(topic) ?? new Set<EventHandler>()
    handlers.add(handler)
    tauriMock.listeners.set(topic, handlers)
    return () => handlers.delete(handler)
  }),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, payload?: Record<string, unknown>) => {
    if (command !== "antigravity_cli_spawn") return
    const streamId = payload?.streamId
    if (typeof streamId !== "string") throw new Error("missing stream id")
    setTimeout(() => {
      for (const event of events) tauriMock.emit(`antigravity-cli:${streamId}`, event)
    }, 0)
  }),
}))

let events: unknown[] = []

const config: LlmConfig = {
  provider: "antigravity-cli",
  apiKey: "",
  model: "",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 204800,
  reasoning: { mode: "auto" },
}

beforeEach(() => {
  tauriMock.reset()
  events = [{ type: "done" }]
})

describe("streamAntigravityCli", () => {
  it("delivers ACP text chunks once and forwards the measured usage", async () => {
    const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5, cachedInputTokens: 1 }
    events = [{ type: "text", text: "苹" }, { type: "text", text: "果" }, { type: "usage", usage }, { type: "done" }]
    const onToken = vi.fn()
    const onUsage = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()
    await streamAntigravityCli(config, [{ role: "user", content: "ping" }], { onToken, onUsage, onDone, onError })
    expect(onToken.mock.calls.flat()).toEqual(["苹", "果"])
    expect(onUsage).toHaveBeenCalledWith(usage)
    expect(onDone).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
  })

  it("reports a failed ACP turn even after partial text has arrived", async () => {
    const message = "Antigravity ACP 达到生成上限，本回合输出不完整。"
    events = [{ type: "text", text: "半段" }, { type: "error", message }, { type: "done" }]
    const onDone = vi.fn()
    const onError = vi.fn()
    await streamAntigravityCli(config, [{ role: "user", content: "ping" }], {
      onToken: vi.fn(), onDone, onError,
    })
    expect(onError).toHaveBeenCalledWith(new Error(message))
    expect(onDone).not.toHaveBeenCalled()
  })

  it("reports an empty response", async () => {
    const onError = vi.fn()
    await streamAntigravityCli(config, [{ role: "user", content: "ping" }], {
      onToken: vi.fn(), onDone: vi.fn(), onError,
    })
    expect(onError).toHaveBeenCalledWith(new Error("Antigravity ACP 没有返回正文。"))
  })

  it("在启动确认前取消时结束一次，并在确认后停止对应的 ACP 请求", async () => {
    let confirm!: () => void
    const confirmation = new Promise<void>(resolve => { confirm = resolve })
    let started!: () => void
    const starting = new Promise<void>(resolve => { started = resolve })
    vi.mocked(invoke).mockImplementationOnce(async () => { started(); await confirmation })
    const controller = new AbortController()
    const callbacks = { onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    const pending = streamAntigravityCli(config, [], callbacks, controller.signal)
    await starting
    const { streamId } = vi.mocked(invoke).mock.lastCall![1] as { streamId: string }
    controller.abort()
    confirm()
    await pending
    expect(invoke).toHaveBeenLastCalledWith("antigravity_cli_kill", { streamId })
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(tauriMock.listeners.get(`antigravity-cli:${streamId}`)?.size).toBe(0)
  })
})
