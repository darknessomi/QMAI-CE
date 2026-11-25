import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(),
}))

import { streamChat } from "@/lib/llm-client"
import { testSettingsLlmModel } from "@/lib/settings-model-test"

const baseLlmConfig: LlmConfig = {
  provider: "custom",
  apiKey: "test-key",
  model: "main-model",
  ollamaUrl: "http://127.0.0.1:11434",
  customEndpoint: "https://example.com/v1",
  maxContextSize: 8192,
  apiMode: "chat_completions",
  reasoning: { mode: "auto" },
}

describe("settings model test helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("tests llm models with a real chat request", async () => {
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken("模型测试成功")
      callbacks.onDone()
    })

    const result = await testSettingsLlmModel(baseLlmConfig)

    expect(result).toEqual({
      model: "main-model",
      content: "模型测试成功",
    })
    expect(vi.mocked(streamChat).mock.calls[0]?.[0].model).toBe("main-model")
  })
})
