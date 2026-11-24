import { describe, expect, it, vi } from "vitest"
import type { LlmConfig, ReasoningMode } from "@/stores/wiki-store"
import { modelOffersReasoningMode } from "./openai-model-capabilities"
import { getProviderConfig, type RequestOverrides } from "./llm-providers"
import { AgentRunner } from "./agent/runner"
import { ToolRegistry } from "./agent/registry"
import { streamChat } from "./llm-client"

const fetch = vi.hoisted(() => vi.fn())
vi.mock("./tauri-fetch", () => ({ getHttpFetch: async () => fetch, isFetchNetworkError: () => false }))
vi.mock("./local-cli-config", () => ({ resolveRuntimeLocalCliConfig: async (config: LlmConfig) => config }))

const tools: RequestOverrides["tools"] = [
  { type: "function", function: { name: "read_chapter", description: "读章节", parameters: { type: "object" } } },
]

function config(model: string, mode: ReasoningMode): LlmConfig {
  return { provider: "openai", model, reasoning: { mode }, apiKey: "", ollamaUrl: "", customEndpoint: "", maxContextSize: 272_000 }
}

function events(...frames: object[]) {
  return new Response(frames.map((frame) => "data: " + JSON.stringify(frame)).join("\n\n") + "\n")
}

describe("OpenAI 官方写作模型", () => {
  it.each([
    ["gpt-6.2-sol", false, true, false], ["gpt-6.2-astra", false, true, false],
    ["gpt-6.1-terra", true, true, false], ["gpt-6-luna", true, true, false],
    ["gpt-5.5", true, false, true],
  ] as const)("%s 的设置、旧配置和请求协议一致", (model, none, max, chatToolsWithNone) => {
    const cfg = config(model, "off")
    expect(modelOffersReasoningMode(cfg, "off")).toBe(none)
    expect(modelOffersReasoningMode(cfg, "max")).toBe(max)
    expect(modelOffersReasoningMode(cfg, "xhigh")).toBe(true)
    expect(modelOffersReasoningMode(cfg, "custom")).toBe(false)
    const wire = getProviderConfig(cfg)
    expect(wire.url).toMatch(/chat\/completions$/)
    const body = wire.buildBody([], { temperature: 0.1, max_tokens: 4096 })
    expect(body).toMatchObject({ reasoning_effort: none ? "none" : "low", max_completion_tokens: 4096 })
    expect(body).not.toHaveProperty("max_tokens")
    expect(wire.buildBody([], { max_tokens: 200_000 })).toHaveProperty("max_completion_tokens", 128_000)
    const followup = { tools, reasoning: { mode: "high" as const }, max_tokens: 200_000 }
    expect(getProviderConfig(cfg, followup).buildBody([], followup)).toHaveProperty("max_output_tokens", 128_000)
    if (!none) expect(body).not.toHaveProperty("temperature")
    expect(wire.buildBody([], { reasoning: { mode: "max" } })).toHaveProperty("reasoning_effort", max ? "max" : "xhigh")
    expect(getProviderConfig(cfg, { tools }).url.endsWith("/chat/completions")).toBe(chatToolsWithNone)
    expect(getProviderConfig(cfg, { tools, reasoning: { mode: "high" } }).url).toMatch(/\/responses$/)
  })

  it("相似名称的第三方模型保留自己的协议", () => {
    const cfg = { ...config("gpt-6.2-sol", "off"), provider: "custom", customEndpoint: "https://example.test/v1" } as LlmConfig
    expect(getProviderConfig(cfg, { tools }).url).toMatch(/chat\/completions$/)
    expect(getProviderConfig(cfg).buildBody([], { max_tokens: 4096, temperature: 0.1 })).toMatchObject({
      max_tokens: 4096, temperature: 0.1,
    })
  })

  it("工具执行后，Responses 按原顺序回传加密推理、阶段、调用和对应结果", async () => {
    fetch.mockReset()
    const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_chapter", arguments: '{"number":42}' }
    const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "test-cipher" }
    const message = { type: "message", id: "msg_1", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "读取" }] }
    fetch
      .mockResolvedValueOnce(events(
        { type: "response.output_item.done", output_index: 0, item: reasoning },
        { type: "response.output_item.done", output_index: 1, item: message },
        { type: "response.output_item.added", output_index: 2, item: { ...call, arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 2, delta: '{"number":' },
        { type: "response.function_call_arguments.delta", output_index: 2, delta: "42}" },
        { type: "response.output_item.done", output_index: 2, item: call },
        { type: "response.completed", response: { output: [reasoning, message, call] } },
      ))
      .mockResolvedValueOnce(events({ type: "response.output_text.delta", delta: "第42章已读" }, { type: "response.completed" }))
    const registry = new ToolRegistry()
    const execute = vi.fn(async () => "第42章：雨")
    registry.register({ name: "read_chapter", description: "读章节", category: "read", parameters: { number: { type: "number", description: "章号", required: true } }, execute })
    const onError = vi.fn()
    const result = await new AgentRunner().run({
      llmConfig: config("gpt-6.2-sol", "max"), maxRounds: 2, systemPrompt: "小说编辑", tools: registry.list(),
    }, registry, [{ role: "user", content: "读第42章" }], {
      onToolCall: vi.fn(), onToolResult: vi.fn(), onToolError: vi.fn(), onText: vi.fn(), onDone: vi.fn(), onError,
    })
    expect(onError).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]).toContainEqual({ number: 42 })
    expect(result.finalText).toBe("第42章已读")
    expect(result.requestTraces?.map((trace) => trace.apiMode)).toEqual(["responses", "responses"])
    const [first, next] = fetch.mock.calls.map(([url, init]) => {
      expect(url).toBe("https://api.openai.com/v1/responses")
      return JSON.parse(init.body)
    })
    expect(first.tools[0]).toMatchObject({ name: "read_chapter", type: "function", strict: false })
    expect(first).toMatchObject({ store: false, reasoning: { effort: "max" }, include: ["reasoning.encrypted_content"] })
    expect(first).not.toHaveProperty("max_tokens")
    expect(next.reasoning).toEqual({ effort: "max" })
    expect(next.input.slice(-4)).toEqual([reasoning, message, call, { type: "function_call_output", call_id: "call_1", output: expect.stringContaining("第42章：雨") }])
  })

  it("官方流在完成前断开时不会执行半截工具", async () => {
    fetch.mockReset().mockResolvedValue(events({
      type: "response.output_item.done", output_index: 0,
      item: { type: "function_call", call_id: "call_1", name: "read_chapter", arguments: "{}" },
    }))
    const onToolCallDelta = vi.fn()
    const onError = vi.fn()
    await streamChat(config("gpt-6.2-sol", "high"), [{ role: "user", content: "读章节" }], {
      onToken: vi.fn(), onDone: vi.fn(), onError, onToolCallDelta,
    }, undefined, { tools })
    expect(onError.mock.calls[0][0].message).toMatch(/中断/)
    expect(onToolCallDelta).not.toHaveBeenCalled()
  })

  it("收到流内错误立刻取消传输", async () => {
    const cancel = vi.fn()
    fetch.mockReset().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.failed","response":{"error":{"message":"请求失败"}}}\n'))
      },
      cancel,
    })))
    const onError = vi.fn()
    await streamChat(config("gpt-6.2-sol", "medium"), [{ role: "user", content: "写一段" }], {
      onToken: vi.fn(), onDone: vi.fn(), onError,
    }, undefined, { tools })
    expect(onError.mock.calls[0][0].message).toBe("请求失败")
    expect(cancel).toHaveBeenCalledOnce()
  })
})
