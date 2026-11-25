import { beforeEach, describe, expect, it, vi } from "vitest"
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
      for (const line of scripted.lines) tauriMock.emit(`antigravity-cli:${streamId}`, line)
      tauriMock.emit(`antigravity-cli:${streamId}:done`, scripted.exit)
    }, 0)
  }),
}))

const scripted: { lines: string[]; exit: { code: number | null; stderr: string } } = {
  lines: [],
  exit: { code: 0, stderr: "" },
}

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
  scripted.lines = []
  scripted.exit = { code: 0, stderr: "" }
})

describe("streamAntigravityCli", () => {
  it("delivers ACP text chunks once and forwards the measured usage", async () => {
    const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5, cachedInputTokens: 1 }
    scripted.lines = [JSON.stringify({ text: "苹" }), JSON.stringify({ text: "果" }), JSON.stringify({ usage })]
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
    scripted.lines = [JSON.stringify({ text: "半段" })]
    scripted.exit = { code: 1, stderr: "Antigravity ACP 达到生成上限，本回合输出不完整。" }
    const onDone = vi.fn()
    const onError = vi.fn()
    await streamAntigravityCli(config, [{ role: "user", content: "ping" }], {
      onToken: vi.fn(), onDone, onError,
    })
    expect(onError).toHaveBeenCalledWith(new Error(scripted.exit.stderr))
    expect(onDone).not.toHaveBeenCalled()
  })

  it("reports an empty response", async () => {
    const onError = vi.fn()
    await streamAntigravityCli(config, [{ role: "user", content: "ping" }], {
      onToken: vi.fn(), onDone: vi.fn(), onError,
    })
    expect(onError).toHaveBeenCalledWith(new Error("Antigravity ACP 没有返回正文。"))
  })
})
