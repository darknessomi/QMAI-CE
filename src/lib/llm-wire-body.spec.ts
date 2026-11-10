/**
 * 报文级回归：钉住「设置页三个测试按钮 + 正式请求」真正 POST 出去的 JSON。
 *
 * 没有 API Key 也能验证的一层：服务端只决定接不接受，而报文是我们自己拼的。
 * 这里不 mock buildBody，走完整链路（预算规划 → overrides → provider 适配 →
 * 最终 JSON），覆盖两个真实工单：
 *
 *   1) Kimi Code（k2.8 / k3 / k3.1-pro）在 OpenAI 兼容与 Responses 两条线上
 *      都不许带 temperature —— 服务端只接受 1，会回
 *      "invalid temperature: only 1 is allowed for this model"；
 *   2) 智谱 glm-5.3 系列（始终思考）任何档位都不许出现 thinking:{type:"disabled"}
 *      —— 会回 400 code 1210「该模型始终思考，不支持关闭思考」。
 *
 * 设置 QMAI_DUMP_BODIES=1 可把每条报文打印出来（人工核对用）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  bodies: [] as Record<string, unknown>[],
}))

vi.mock("./local-cli-config", () => ({
  resolveRuntimeLocalCliConfig: vi.fn(async (config: LlmConfig) => config),
}))

vi.mock("./tauri-fetch", () => ({
  getHttpFetch: vi.fn(async () => mocks.fetch),
  isFetchNetworkError: () => false,
}))

// settings-model-test 会连带引入向量/重排/模型列表模块，这里挡掉与本报文无关的重依赖。
vi.mock("@/lib/embedding", () => ({
  fetchEmbedding: vi.fn(),
  getLastEmbeddingError: vi.fn(() => null),
  resetLastEmbeddingError: vi.fn(),
}))
vi.mock("@/lib/rerank-api", () => ({
  isDirectRerankEndpoint: vi.fn(() => false),
  requestDirectRerank: vi.fn(),
}))
vi.mock("@/lib/settings-model-list", () => ({ fetchLlmModelList: vi.fn() }))

import { testLlmConnection, testLlmFunction } from "./connection-tests"
import { testSettingsLlmModel } from "./settings-model-test"

const BIGMODEL_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4"
const KIMI_CODE_ENDPOINT = "https://api.kimi.com/coding/v1"

function config(over: Partial<LlmConfig>): LlmConfig {
  return {
    provider: "custom",
    apiKey: "sk-test",
    model: "glm-5.3-flash",
    ollamaUrl: "http://127.0.0.1:11434",
    customEndpoint: BIGMODEL_ENDPOINT,
    maxContextSize: 204_800,
    maxOutputTokens: 16_384,
    apiMode: "chat_completions",
    ...over,
  }
}

function sseLines(body: Record<string, unknown>): string {
  // 功能测试要求模型原样吐出这个 token；其余测试只要非空正文。
  const wantsToken = JSON.stringify(body).includes("LLM_WIKI_TEST_OK")
  const text = wantsToken ? "LLM_WIKI_TEST_OK" : "模型测试成功"
  // Responses 线的 body 用 input[]，chat_completions 用 messages[]；两条线的事件格式不同。
  return Array.isArray(body.input)
    ? [`data: {"type":"response.output_text.delta","delta":${JSON.stringify(text)}}`, "data: [DONE]", ""].join("\n")
    : [`data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}`, "data: [DONE]", ""].join("\n")
}

function lastBody(): Record<string, unknown> {
  const body = mocks.bodies.at(-1)
  if (!body) throw new Error("没有捕获到请求报文")
  return body
}

function dump(label: string, body: Record<string, unknown>): void {
  if (process.env.QMAI_DUMP_BODIES) {
    console.log(`[wire] ${label} ${JSON.stringify(body)}`)
  }
}

beforeEach(() => {
  mocks.bodies.length = 0
  mocks.fetch.mockReset()
  mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    mocks.bodies.push(body)
    return new Response(sseLines(body), { status: 200 })
  })
})

describe("智谱 GLM-5.3：最终报文里不应出现 thinking.disabled", () => {
  it("关闭档 + 测试连接：不发 thinking，也不发 reasoning_effort", async () => {
    const result = await testLlmConnection(config({ reasoning: { mode: "off" } }))
    const body = lastBody()
    dump("glm-5.3 / 关闭档 / 测试连接", body)

    expect(result.ok).toBe(true)
    expect(mocks.bodies).toHaveLength(1)
    expect(body).not.toHaveProperty("thinking")
    expect(body).not.toHaveProperty("reasoning_effort")
    expect(Number(body.max_tokens)).toBeGreaterThanOrEqual(4096)
  })

  it("中档 + 测试模型：只发 enabled，不发 medium（该型号只接受 low/high/max）", async () => {
    const result = await testSettingsLlmModel(config({ reasoning: { mode: "medium" } }))
    const body = lastBody()
    dump("glm-5.3 / 中档 / 测试模型", body)

    expect(result.content).toBe("模型测试成功")
    expect(body.thinking).toEqual({ type: "enabled" })
    expect(body).not.toHaveProperty("reasoning_effort")
  })

  it("高档 + 测试模型：enabled + high，且温度照常发送（智谱接受 temperature）", async () => {
    const result = await testSettingsLlmModel(config({ reasoning: { mode: "high" } }))
    const body = lastBody()
    dump("glm-5.3 / 高档 / 测试模型", body)

    expect(result.content).toBe("模型测试成功")
    expect(body.thinking).toEqual({ type: "enabled" })
    expect(body.reasoning_effort).toBe("high")
    expect(body.temperature).toBe(0)
  })

  it("回归：非始终思考的 glm-5-plus 关闭思考仍发 disabled", async () => {
    const result = await testLlmConnection(config({ model: "glm-5-plus", reasoning: { mode: "off" } }))
    const body = lastBody()
    dump("glm-5-plus / 关闭档 / 测试连接", body)

    expect(result.ok).toBe(true)
    expect(body.thinking).toEqual({ type: "disabled" })
  })

  it("回归：DeepSeek 关闭思考仍发 disabled", async () => {
    const result = await testLlmFunction(config({
      model: "deepseek-chat",
      customEndpoint: "https://api.deepseek.com/v1",
      reasoning: { mode: "off" },
    }))
    const body = lastBody()
    dump("deepseek-chat / 关闭档 / 测试功能", body)

    expect(result.message).toContain("Functional test passed")
    expect(body.thinking).toEqual({ type: "disabled" })
  })
})

describe("Kimi Code：最终报文里不应出现 temperature", () => {
  it("OpenAI 兼容线：k3.1-pro 的测试请求不带 temperature", async () => {
    const result = await testSettingsLlmModel(config({
      model: "k3.1-pro",
      customEndpoint: KIMI_CODE_ENDPOINT,
      reasoning: { mode: "medium" },
    }))
    const body = lastBody()
    dump("k3.1-pro / chat_completions / 测试模型", body)

    expect(result.content).toBe("模型测试成功")
    expect(mocks.bodies).toHaveLength(1)
    expect(body).not.toHaveProperty("temperature")
    expect(typeof body.max_tokens).toBe("number")
  })

  it("Responses 线：k3.1-pro 的测试请求不带 temperature，且保留 max_output_tokens", async () => {
    const result = await testSettingsLlmModel(config({
      model: "k3.1-pro",
      customEndpoint: KIMI_CODE_ENDPOINT,
      apiMode: "responses",
      reasoning: { mode: "medium" },
    }))
    const body = lastBody()
    dump("k3.1-pro / responses / 测试模型", body)

    expect(result.content).toBe("模型测试成功")
    expect(body).not.toHaveProperty("temperature")
    expect(typeof body.max_output_tokens).toBe("number")
    expect(Array.isArray(body.input)).toBe(true)
  })

  it("k3 / k2.8 经中转端点同样不带 temperature（按模型 id 命中）", async () => {
    for (const model of ["k3", "k2.8"]) {
      mocks.bodies.length = 0
      await testSettingsLlmModel(config({
        model,
        customEndpoint: "https://relay.example.com/v1",
        reasoning: { mode: "medium" },
      }))
      const body = lastBody()
      dump(`${model} / 中转端点 / 测试模型`, body)
      expect(body, model).not.toHaveProperty("temperature")
    }
  })
})
