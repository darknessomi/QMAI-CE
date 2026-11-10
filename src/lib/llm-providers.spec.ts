import { describe, expect, it } from "vitest"
import { getCustomCompatibleHeaders, getProviderConfig, modelAlwaysThinks, modelSupportsReasoningControl, parseGoogleLine, parseOpenAiSseError, reasoningOutputFloor, withCustomOriginHeader } from "./llm-providers"
import type { ChatMessage } from "./llm-providers"
import { filterDeAiOutput } from "./novel/de-ai-output"
import type { LlmConfig, ReasoningConfig, ReasoningMode } from "@/stores/wiki-store"

function customConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "custom",
    apiKey: "sk-test",
    model: "gpt-5.4",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "https://example.test/v1",
    maxContextSize: 204800,
    apiMode: "chat_completions",
    reasoning: { mode: "auto" },
    ...overrides,
  }
}

function requestBody(config: LlmConfig): Record<string, unknown> {
  return getProviderConfig(config).buildBody([
    { role: "user", content: "请回答。" },
  ]) as Record<string, unknown>
}

describe("OpenAI SSE error lines", () => {
  it("reads cursor-api-proxy agent_exit errors instead of treating them as empty content", () => {
    expect(
      parseOpenAiSseError(
        'data: {"error":{"message":"The Cursor agent process exited with code 1. See server logs for details.","code":"cursor_cli_error"}}',
      ),
    ).toBe("The Cursor agent process exited with code 1. See server logs for details.")
    expect(parseOpenAiSseError("data: [DONE]")).toBeNull()
    expect(parseOpenAiSseError('data: {"choices":[{"delta":{"content":"hi"}}]}')).toBeNull()
  })
})

describe("llm provider reasoning options", () => {
  it("keeps Anthropic thinking inside the caller's max_tokens budget", () => {
    const body = getProviderConfig(customConfig({
      apiMode: "anthropic_messages",
      reasoning: { mode: "high" },
    })).buildBody(
      [{ role: "user", content: "请回答。" }],
      { max_tokens: 4_096 },
    ) as {
      max_tokens: number
      thinking?: { type: string; budget_tokens: number }
    }

    expect(body.max_tokens).toBe(4_096)
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 3_584 })
  })

  it("defaults Anthropic max_tokens to the window-fraction reserve, not 4096", () => {
    const body = getProviderConfig(customConfig({
      apiMode: "anthropic_messages",
      maxContextSize: 204_800,
    })).buildBody(
      [{ role: "user", content: "请回答。" }],
    ) as { max_tokens: number }

    expect(body.max_tokens).toBe(30_720)
  })

  it("does not inflate an Anthropic output budget too small for explicit thinking", () => {
    const body = getProviderConfig(customConfig({
      apiMode: "anthropic_messages",
      reasoning: { mode: "high" },
    })).buildBody(
      [{ role: "user", content: "请回答。" }],
      { max_tokens: 512 },
    ) as Record<string, unknown>

    expect(body.max_tokens).toBe(512)
    expect(body).not.toHaveProperty("thinking")
  })

  it("omits empty assistant reasoning_content instead of replaying an empty string", () => {
    const body = getProviderConfig(customConfig()).buildBody([
      { role: "user", content: "写第一章" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "read_chapter", arguments: "{}" },
        }],
        reasoning_content: "",
      },
      { role: "tool", content: "章节内容", tool_call_id: "call_1", name: "read_chapter" },
    ]) as { messages: Array<{ reasoning_content?: string }> }

    expect(body.messages[1]).not.toHaveProperty("reasoning_content")
  })

  it("replays non-empty assistant reasoning_content", () => {
    const body = getProviderConfig(customConfig()).buildBody([
      { role: "user", content: "写第一章" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "read_chapter", arguments: "{}" },
        }],
        reasoning_content: "先读章节",
      },
    ]) as { messages: Array<{ reasoning_content?: string }> }

    expect(body.messages[1]?.reasoning_content).toBe("先读章节")
  })

  it("sends reasoning_effort for explicit custom OpenAI-compatible reasoning mode", () => {
    const body = requestBody(customConfig({ reasoning: { mode: "high" } }))

    expect(body.reasoning_effort).toBe("high")
  })

  it("enables Qwen3 thinking when explicit reasoning is enabled", () => {
    const body = requestBody(customConfig({
      model: "qwen3-235b-a22b",
      reasoning: { mode: "high" },
    }))

    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true })
    expect(body.reasoning_effort).toBe("high")
  })

  it("keeps Qwen3 thinking disabled when reasoning is off", () => {
    const body = requestBody(customConfig({
      model: "qwen3-235b-a22b",
      reasoning: { mode: "off" },
    }))

    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(body).not.toHaveProperty("reasoning_effort")
  })

  it("enables MiMo thinking via model name when reasoning is enabled", () => {
    const body = requestBody(customConfig({
      model: "mimo-v2.5-pro",
      reasoning: { mode: "high" },
    }))

    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true })
  })

  it("disables MiMo thinking via model name when reasoning is off", () => {
    const body = requestBody(customConfig({
      model: "MiMo-v2-pro",
      reasoning: { mode: "off" },
    }))

    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it("enables MiMo thinking via xiaomimimo.com endpoint even with custom model name", () => {
    const body = requestBody(customConfig({
      model: "custom-model-alias",
      customEndpoint: "https://api.xiaomimimo.com/v1",
      reasoning: { mode: "high" },
    }))

    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true })
  })

  it("disables MiMo thinking via xiaomimimo.com endpoint when reasoning is off", () => {
    const body = requestBody(customConfig({
      model: "some-alias",
      customEndpoint: "https://token-plan-cn.xiaomimimo.com/v1",
      reasoning: { mode: "off" },
    }))

    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it("enables GLM-5 thinking on bigmodel.cn when reasoning is enabled", () => {
    const body = requestBody(customConfig({
      model: "glm-5-plus",
      customEndpoint: "https://open.bigmodel.cn/api/paas/v4",
      reasoning: { mode: "high" },
    }))

    expect(body.thinking).toEqual({ type: "enabled" })
  })

  it("disables GLM-5 thinking on bigmodel.cn when reasoning is off", () => {
    const body = requestBody(customConfig({
      model: "GLM-5",
      customEndpoint: "https://open.bigmodel.cn/api/paas/v4",
      reasoning: { mode: "off" },
    }))

    expect(body.thinking).toEqual({ type: "disabled" })
  })

  it("does not send GLM thinking object for non-Zhipu endpoints", () => {
    const body = requestBody(customConfig({
      model: "glm-5-self-hosted",
      customEndpoint: "https://my-vllm.example.com/v1",
      reasoning: { mode: "high" },
    }))

    expect(body).not.toHaveProperty("thinking")
  })

  it("leaves max_tokens absent for MiMo thinking when the caller did not set one", () => {
    const body = requestBody(customConfig({
      model: "mimo-v2.5-pro",
      reasoning: { mode: "high" },
    }))

    expect(body).not.toHaveProperty("max_tokens")
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true })
  })

  it("leaves max_tokens absent for MiMo detected by endpoint", () => {
    const body = requestBody(customConfig({
      model: "custom-alias",
      customEndpoint: "https://token-plan-cn.xiaomimimo.com/v1",
      reasoning: { mode: "medium" },
    }))

    expect(body).not.toHaveProperty("max_tokens")
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true })
  })

  it("never rewrites an explicit max_tokens for MiMo thinking", () => {
    const bodyWithOverride = getProviderConfig(customConfig({
      model: "mimo-v2.5-pro",
      reasoning: { mode: "high" },
    })).buildBody(
      [{ role: "user", content: "test" }],
      { max_tokens: 32000 },
    ) as Record<string, unknown>

    expect(bodyWithOverride.max_tokens).toBe(32000)
    expect(bodyWithOverride.chat_template_kwargs).toEqual({ enable_thinking: true })
  })

  it("turns MiMo thinking off when the planned output cannot hold it", () => {
    const body = getProviderConfig(customConfig({
      model: "mimo-v2.5-pro",
      reasoning: { mode: "high" },
    })).buildBody(
      [{ role: "user", content: "test" }],
      { max_tokens: 2048 },
    ) as Record<string, unknown>

    expect(body.max_tokens).toBe(2048)
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(body).not.toHaveProperty("reasoning_effort")
  })

  it("turns GLM-5 thinking off when the planned output cannot hold it", () => {
    const body = getProviderConfig(customConfig({
      model: "glm-5-plus",
      customEndpoint: "https://open.bigmodel.cn/api/paas/v4",
      reasoning: { mode: "high" },
    })).buildBody(
      [{ role: "user", content: "test" }],
      { max_tokens: 2048 },
    ) as Record<string, unknown>

    expect(body.max_tokens).toBe(2048)
    expect(body.thinking).toEqual({ type: "disabled" })
    expect(body).not.toHaveProperty("reasoning_effort")
  })

  it("does not set max_tokens for MiMo when thinking is off", () => {
    const body = requestBody(customConfig({
      model: "mimo-v2.5-pro",
      reasoning: { mode: "off" },
    }))

    expect(body).not.toHaveProperty("max_tokens")
  })

  it("does not set max_tokens for MiMo in auto mode", () => {
    const body = requestBody(customConfig({
      model: "mimo-v2.5-pro",
      reasoning: { mode: "auto" },
    }))

    expect(body).not.toHaveProperty("max_tokens")
  })

  it("leaves max_tokens absent for Qwen3 thinking at medium level", () => {
    const body = requestBody(customConfig({
      model: "qwen3-235b-a22b",
      reasoning: { mode: "medium" },
    }))

    expect(body).not.toHaveProperty("max_tokens")
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true })
  })

  it("leaves max_tokens absent for DeepSeek thinking at low level", () => {
    const body = requestBody(customConfig({
      model: "deepseek-v4-flash",
      reasoning: { mode: "low" },
    }))

    expect(body.thinking).toEqual({ type: "enabled" })
    expect(body).not.toHaveProperty("max_tokens")
  })

  it("turns DeepSeek thinking off when the planned output cannot hold it", () => {
    const body = getProviderConfig(customConfig({
      model: "deepseek-v4-flash",
      reasoning: { mode: "high" },
    })).buildBody(
      [{ role: "user", content: "test" }],
      { max_tokens: 2048 },
    ) as Record<string, unknown>

    expect(body.max_tokens).toBe(2048)
    expect(body.thinking).toEqual({ type: "disabled" })
    expect(body).not.toHaveProperty("reasoning_effort")
  })

  it.each<ReasoningMode>(["max", "custom"])("maps Responses API %s reasoning to high effort", (mode) => {
    const body = requestBody(customConfig({
      apiMode: "responses",
      customEndpoint: "https://example.test/v1",
      reasoning: mode === "custom" ? { mode, budgetTokens: 12000 } : { mode },
    }))

    expect(body.reasoning).toEqual({ effort: "high" })
  })
})

describe("Kimi Code（k2.8 / k3 / k3.1-pro）不发 temperature", () => {
  function kimiCode(overrides: Partial<LlmConfig> = {}): LlmConfig {
    return customConfig({
      model: "k3.1-pro",
      customEndpoint: "https://api.kimi.com/coding/v1",
      ...overrides,
    })
  }

  it("OpenAI 兼容线上删掉 temperature，max_tokens 原样保留", () => {
    const body = getProviderConfig(kimiCode()).buildBody(
      [{ role: "user", content: "hi" }],
      { temperature: 0, max_tokens: 4096 },
    ) as Record<string, unknown>

    expect(body.temperature).toBeUndefined()
    expect(body.max_tokens).toBe(4096)
  })

  it("Responses 线上同样删掉 temperature（此前完全没有适配）", () => {
    const body = getProviderConfig(kimiCode({ apiMode: "responses" })).buildBody(
      [{ role: "user", content: "hi" }],
      { temperature: 0, max_tokens: 4096 },
    ) as Record<string, unknown>

    expect(body.temperature).toBeUndefined()
    expect(body.max_output_tokens).toBe(4096)
  })

  it("模型 id 经中转端点也命中（端点不是 kimi.com/moonshot 时）", () => {
    for (const model of ["k3", "k2.8", "k3.1-pro"]) {
      const body = getProviderConfig(customConfig({
        model,
        customEndpoint: "https://relay.example.com/v1",
      })).buildBody(
        [{ role: "user", content: "hi" }],
        { temperature: 0.1 },
      ) as Record<string, unknown>

      expect(body.temperature, model).toBeUndefined()
    }
  })

  it("不改动非 Kimi 型号：智谱 glm-5.3-flash 仍按调用方给的 temperature 发送", () => {
    const body = getProviderConfig(customConfig({
      model: "glm-5.3-flash",
      customEndpoint: "https://open.bigmodel.cn/api/paas/v4",
      reasoning: { mode: "auto" },
    })).buildBody(
      [{ role: "user", content: "hi" }],
      { temperature: 0 },
    ) as Record<string, unknown>

    expect(body.temperature).toBe(0)
  })
})

describe("智谱 GLM-5.3：始终思考的型号不发 thinking.disabled", () => {
  function glm53(reasoning: ReasoningConfig, overrides: Partial<LlmConfig> = {}): LlmConfig {
    return customConfig({
      model: "glm-5.3-flash",
      customEndpoint: "https://open.bigmodel.cn/api/paas/v4",
      reasoning,
      ...overrides,
    })
  }

  it("关闭档整个不发 thinking（发 disabled 会被 400 / code 1210 拒）", () => {
    const body = requestBody(glm53({ mode: "off" }))

    expect(body).not.toHaveProperty("thinking")
    expect(body).not.toHaveProperty("reasoning_effort")
  })

  it("低档发 enabled + low", () => {
    const body = requestBody(glm53({ mode: "low" }))

    expect(body.thinking).toEqual({ type: "enabled" })
    expect(body.reasoning_effort).toBe("low")
  })

  it("中档只发 enabled，不发 medium（该型号只接受 low/high/max）", () => {
    const body = requestBody(glm53({ mode: "medium" }))

    expect(body.thinking).toEqual({ type: "enabled" })
    expect(body).not.toHaveProperty("reasoning_effort")
  })

  it("最高档发 max", () => {
    const body = requestBody(glm53({ mode: "max" }))

    expect(body.thinking).toEqual({ type: "enabled" })
    expect(body.reasoning_effort).toBe("max")
  })

  it("输出预算装不下思考时整个不发，而不是降级成 disabled", () => {
    const body = getProviderConfig(glm53({ mode: "high" })).buildBody(
      [{ role: "user", content: "hi" }],
      { max_tokens: 2048 },
    ) as Record<string, unknown>

    expect(body.max_tokens).toBe(2048)
    expect(body).not.toHaveProperty("thinking")
    expect(body).not.toHaveProperty("reasoning_effort")
  })

  it("Responses 线同样只发 low/high/max", () => {
    const medium = requestBody(glm53({ mode: "medium" }, { apiMode: "responses" }))
    const high = requestBody(glm53({ mode: "high" }, { apiMode: "responses" }))

    expect(medium).not.toHaveProperty("reasoning")
    expect(high.reasoning).toEqual({ effort: "high" })
  })

  it("modelAlwaysThinks / reasoningOutputFloor 只对官方端点的 5.3 生效", () => {
    expect(modelAlwaysThinks(glm53({ mode: "off" }))).toBe(true)
    expect(modelAlwaysThinks(customConfig({
      model: "glm-5.3-flash",
      customEndpoint: "https://api.atlascloud.ai/v1",
    }))).toBe(false)
    expect(modelAlwaysThinks(customConfig({
      model: "glm-4.7",
      customEndpoint: "https://open.bigmodel.cn/api/paas/v4",
    }))).toBe(false)

    expect(reasoningOutputFloor(glm53({ mode: "off" }))).toBe(4096)
    expect(reasoningOutputFloor(glm53({ mode: "high" }))).toBe(16384)
    expect(reasoningOutputFloor(customConfig({
      model: "glm-4.7",
      customEndpoint: "https://open.bigmodel.cn/api/paas/v4",
      reasoning: { mode: "off" },
    }))).toBe(0)
  })
})

describe("internal request overrides", () => {
  it.each([
    ["OpenAI-compatible", customConfig()],
    ["Responses API", customConfig({ apiMode: "responses" })],
    ["Anthropic Messages", customConfig({ apiMode: "anthropic_messages" })],
    ["Gemini", customConfig({ provider: "google", model: "gemini-2.5-pro" })],
  ])("does not send user-memory control fields through %s", (_label, config) => {
    const body = getProviderConfig(config).buildBody(
      [{ role: "user", content: "测试请求" }],
      {
        temperature: 0.2,
        skipUserMemory: true,
        userMemorySurface: "ai-chat",
        userMemoryProjectKey: "project-1",
        userMemorySessionKey: "session-1",
      },
    ) as Record<string, unknown>
    const serialized = JSON.stringify(body)

    expect(serialized).not.toContain("skipUserMemory")
    expect(serialized).not.toContain("userMemorySurface")
    expect(serialized).not.toContain("userMemoryProjectKey")
    expect(serialized).not.toContain("userMemorySessionKey")
  })

  it("sends snake_case tool_choice without leaking camelCase toolChoice", () => {
    const tools = [{
      type: "function",
      function: {
        name: "read_chapter",
        description: "read",
        parameters: { type: "object", properties: {} },
      },
    }]
    const body = getProviderConfig(customConfig()).buildBody(
      [{ role: "user", content: "测试请求" }],
      {
        temperature: 0.2,
        tools,
        toolChoice: "auto",
      },
    ) as Record<string, unknown>

    expect(body.tools).toEqual(tools)
    expect(body.tool_choice).toBe("auto")
    expect(body).not.toHaveProperty("toolChoice")
    expect(JSON.stringify(body)).not.toContain("toolChoice")
  })
})

describe("custom provider headers", () => {
  it("clears Origin for remote custom gateways", () => {
    expect(getCustomCompatibleHeaders("sk-test", "https://example.test/v1/chat/completions")).toMatchObject({
      Authorization: "Bearer sk-test",
      Origin: "",
    })
  })

  it("keeps localhost Origin only for local endpoints", () => {
    expect(getCustomCompatibleHeaders("", "http://localhost:11434/v1/chat/completions")).toMatchObject({
      Origin: "http://localhost",
    })
  })

  it("preserves existing auth headers when clearing Origin", () => {
    expect(withCustomOriginHeader({ "x-api-key": "sk-test" }, "https://example.test/v1/messages")).toEqual({
      "x-api-key": "sk-test",
      Origin: "",
    })
  })

  it("clears Origin for actual custom OpenAI-compatible chat requests", () => {
    expect(getProviderConfig(customConfig()).headers).toMatchObject({
      Authorization: "Bearer sk-test",
      Origin: "",
    })
  })

  it("clears Origin for actual custom Responses API requests", () => {
    expect(getProviderConfig(customConfig({ apiMode: "responses" })).headers).toMatchObject({
      Authorization: "Bearer sk-test",
      Origin: "",
    })
  })

  it("clears Origin for actual custom Anthropic-compatible requests", () => {
    expect(getProviderConfig(customConfig({ apiMode: "anthropic_messages" })).headers).toMatchObject({
      "x-api-key": "sk-test",
      Origin: "",
    })
  })
})

describe("prompt caching cache_control breakpoints", () => {
  const cachedMessage = [{
    role: "user" as const,
    content: [
      { type: "text" as const, text: "STABLE_PREFIX", cacheControl: true },
      { type: "text" as const, text: "STAGE_SPECIFIC" },
    ],
  }]

  it("emits Anthropic cache_control on the flagged prefix block and leaves the rest plain", () => {
    const body = getProviderConfig(customConfig({ apiMode: "anthropic_messages" }))
      .buildBody(cachedMessage) as Record<string, unknown>
    const messages = body.messages as Array<{ role: string; content: unknown }>

    expect(messages[0].content).toEqual([
      { type: "text", text: "STABLE_PREFIX", cache_control: { type: "ephemeral" } },
      { type: "text", text: "STAGE_SPECIFIC" },
    ])
  })

  it("preserves a cache breakpoint in Anthropic top-level system content", () => {
    const body = getProviderConfig(customConfig({ apiMode: "anthropic_messages" }))
      .buildBody([{
        role: "system",
        content: [
          { type: "text", text: "软件规则\n" },
          { type: "text", text: "稳定项目核心", cacheControl: true },
          { type: "text", text: "\n动态上下文" },
        ],
      }]) as Record<string, unknown>

    expect(body.system).toEqual([
      { type: "text", text: "软件规则\n" },
      { type: "text", text: "稳定项目核心", cache_control: { type: "ephemeral" } },
      { type: "text", text: "\n动态上下文" },
    ])
  })

  it("keeps legacy Anthropic system strings unchanged without a breakpoint", () => {
    const body = getProviderConfig(customConfig({ apiMode: "anthropic_messages" }))
      .buildBody([{ role: "system", content: "原有系统提示词" }]) as Record<string, unknown>

    expect(body.system).toBe("原有系统提示词")
  })

  it("ignores cache markers safely on Gemini while preserving all text", () => {
    const body = getProviderConfig(customConfig({
      provider: "google",
      model: "gemini-2.5-pro",
    })).buildBody([{
      role: "system",
      content: [
        { type: "text", text: "稳定项目核心", cacheControl: true },
        { type: "text", text: "动态上下文" },
      ],
    }]) as { systemInstruction: { parts: Array<{ text: string }> } }

    expect(body.systemInstruction.parts).toEqual([{ text: "稳定项目核心动态上下文" }])
  })

  it("collapses the same blocks to a byte-identical string for OpenAI-compatible wires (cache marker ignored)", () => {
    const body = getProviderConfig(customConfig({ apiMode: "chat_completions" }))
      .buildBody(cachedMessage) as Record<string, unknown>
    const messages = body.messages as Array<{ role: string; content: unknown }>

    // OpenAI/DeepSeek 走自动前缀缓存：纯文本块折叠回与原字符串逐字节一致的内容。
    expect(messages[0].content).toBe("STABLE_PREFIXSTAGE_SPECIFIC")
  })

  it("keeps the legacy string-collapse path when no block is flagged for caching", () => {
    const plainBlocks = [{
      role: "user" as const,
      content: [
        { type: "text" as const, text: "A" },
        { type: "text" as const, text: "B" },
      ],
    }]
    const body = getProviderConfig(customConfig({ apiMode: "anthropic_messages" }))
      .buildBody(plainBlocks) as Record<string, unknown>
    const messages = body.messages as Array<{ role: string; content: unknown }>

    expect(messages[0].content).toBe("AB")
  })
})

describe("Qwen3.5/3.6 leading system coalesce", () => {
  const dualSystem = [
    { role: "system" as const, content: "软件规则" },
    { role: "system" as const, content: "## 任务契约\n写下一章" },
    { role: "user" as const, content: "开始写" },
  ]

  function rolesAndContent(config: LlmConfig, messages: ChatMessage[] = dualSystem) {
    const body = getProviderConfig(config).buildBody(messages) as {
      messages?: Array<{ role: string; content: unknown }>
      input?: Array<{ role: string; content: unknown }>
    }
    return body.messages ?? body.input ?? []
  }

  it("does not invent a system message for user-only Qwen3.6 requests", () => {
    const messages = rolesAndContent(
      customConfig({ model: "qwen3.6-35b-q4km:latest" }),
      [{ role: "user", content: "写第一章" }],
    )
    expect(messages).toEqual([{ role: "user", content: "写第一章" }])
  })

  it("leaves a single leading system in place", () => {
    const messages = rolesAndContent(
      customConfig({ model: "qwen3.6-plus" }),
      [
        { role: "system", content: "软件规则" },
        { role: "user", content: "开始写" },
      ],
    )
    expect(messages).toEqual([
      { role: "system", content: "软件规则" },
      { role: "user", content: "开始写" },
    ])
  })

  it("merges consecutive leading systems for Qwen3.6 OpenAI-compatible requests", () => {
    const messages = rolesAndContent(customConfig({ model: "qwen3.6-35b-q4km:latest" }))
    expect(messages).toEqual([
      { role: "system", content: "软件规则\n\n## 任务契约\n写下一章" },
      { role: "user", content: "开始写" },
    ])
  })

  it("merges a mid-conversation system into the leading system for Qwen3.6", () => {
    const messages = rolesAndContent(
      customConfig({ model: "qwen/qwen3.6-27b" }),
      [
        { role: "system", content: "软件规则" },
        { role: "user", content: "写" },
        { role: "assistant", content: "好" },
        { role: "system", content: "必须调用工具" },
      ],
    )
    expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant"])
    expect(messages[0]?.content).toBe("软件规则\n\n必须调用工具")
    expect(messages[1]?.content).toBe("写")
    expect(messages[2]?.content).toBe("好")
  })

  it("moves a non-leading system to the front for Qwen3.5", () => {
    const messages = rolesAndContent(
      customConfig({ model: "qwen3.5:397b" }),
      [
        { role: "user", content: "写" },
        { role: "system", content: "软件规则" },
      ],
    )
    expect(messages).toEqual([
      { role: "system", content: "软件规则" },
      { role: "user", content: "写" },
    ])
  })

  it("keeps cache-prefixed system text before later system content", () => {
    const messages = rolesAndContent(
      customConfig({ model: "qwen3.6-plus" }),
      [
        {
          role: "system",
          content: [
            { type: "text", text: "软件规则" },
            { type: "text", text: "稳定项目核心", cacheControl: true },
          ],
        },
        { role: "system", content: "任务契约" },
        { role: "user", content: "写" },
      ],
    )
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual({
      role: "system",
      content: "软件规则稳定项目核心\n\n任务契约",
    })
    expect(messages[1]?.role).toBe("user")
  })

  it("also coalesces Qwen3.6 on the native ollama provider", () => {
    const messages = rolesAndContent(customConfig({
      provider: "ollama",
      model: "qwen3.6-35b-q4km:latest",
    }))
    expect(messages.map((message) => message.role)).toEqual(["system", "user"])
    expect(messages[0]?.content).toContain("软件规则")
    expect(messages[0]?.content).toContain("任务契约")
  })

  it("coalesces Qwen3.6 Responses API input the same way", () => {
    const messages = rolesAndContent(customConfig({
      apiMode: "responses",
      model: "qwen3.6-plus",
    }))
    expect(messages).toEqual([
      { role: "system", content: "软件规则\n\n## 任务契约\n写下一章" },
      { role: "user", content: "开始写" },
    ])
  })

  it("does not coalesce dual systems for gpt-4o on openai or custom", () => {
    for (const config of [
      customConfig({ provider: "openai", model: "gpt-4o" }),
      customConfig({ model: "gpt-4o" }),
    ]) {
      const messages = rolesAndContent(config)
      expect(messages.map((message) => message.role)).toEqual(["system", "system", "user"])
      expect(messages[0]?.content).toBe("软件规则")
      expect(messages[1]?.content).toBe("## 任务契约\n写下一章")
    }
  })

  it("does not coalesce dual systems for DeepSeek", () => {
    const messages = rolesAndContent(customConfig({
      model: "deepseek-chat",
      customEndpoint: "https://api.deepseek.com/v1",
    }))
    expect(messages.map((message) => message.role)).toEqual(["system", "system", "user"])
  })

  it("does not coalesce dual systems for plain Qwen3", () => {
    const messages = rolesAndContent(customConfig({ model: "qwen3-235b-a22b" }))
    expect(messages.map((message) => message.role)).toEqual(["system", "system", "user"])
  })

  it("does not coalesce dual systems for Qwen3-Coder or Qwen2.5", () => {
    for (const model of ["qwen3-coder-plus", "qwen2.5-72b"]) {
      const messages = rolesAndContent(customConfig({ model }))
      expect(messages.map((message) => message.role), model).toEqual(["system", "system", "user"])
    }
  })

  it("does not coalesce gpt Responses API input", () => {
    const messages = rolesAndContent(customConfig({
      apiMode: "responses",
      model: "gpt-5.4",
    }))
    expect(messages.map((message) => message.role)).toEqual(["system", "system", "user"])
  })
})

describe("Gemini thought summaries", () => {
  function googleConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
    return customConfig({
      provider: "google",
      model: "gemini-3.7-flash-preview",
      ...overrides,
    })
  }

  function googleLine(...parts: string[]): string {
    return `data: ${JSON.stringify({
      candidates: [{ content: { parts: parts.map((text) => ({ text })) } }],
    })}`
  }

  it("does not return thought:true parts as visible content", () => {
    const line = 'data: {"candidates":[{"content":{"parts":[{"text":"先拆章纲","thought":true},{"text":"雨还在下。"}]}}]}'
    expect(parseGoogleLine(line)).toBe("雨还在下。")
  })

  it("does not return unmarked thought-summary parts as visible content", () => {
    const dump = "**Defining the Request**\\n\\nThe user wants the full text for Chapter 14."
    const line = `data: {"candidates":[{"content":{"parts":[{"text":"${dump}"},{"text":"雨还在下。"}]}}]}`
    expect(parseGoogleLine(line)).toBe("雨还在下。")
  })

  it("filters a thought summary split across Gemini SSE events and parts at the completed-result boundary", () => {
    const body = "地下暗轨深处，空气沉得像一汪死水。叶刃没有回头。"
    const lines = [
      googleLine(
        "I'm currently focused on defining the project scope, prioritizing ",
        "the objective: refining the novel snippet to align with the \"去 AI 味\" skill's instructions.",
      ),
      googleLine(
        "\n\n**Examining the Narrative Details**\n\n",
        "I'm now diving deep into analyzing the source text and preserving its key conflicts.",
      ),
      googleLine(
        "\n\n**Analyzing the Conflict's Dynamics**\n\n",
        "I've been mapping out the escalating conflict within the narrative's framework.",
      ),
      googleLine(`\n\n${body}`),
    ]

    // parseGoogleLine is stateless, so a single event or part cannot reliably
    // identify a summary whose evidence is spread across the completed payload.
    // Do not constrain how much the provider can discard eagerly; the business
    // boundary must still guarantee that only the revised body survives.
    const completed = lines
      .map((line) => parseGoogleLine(line))
      .filter((text): text is string => text !== null)
      .join("")

    expect(filterDeAiOutput(completed)).toBe(body)
  })

  it("hides thought summaries on Gemini 3.x even in auto reasoning mode", () => {
    const body = getProviderConfig(googleConfig()).buildBody(
      [{ role: "user", content: "写第14章" }],
    ) as { generationConfig?: { thinkingConfig?: Record<string, unknown> } }

    expect(body.generationConfig?.thinkingConfig).toEqual({ includeThoughts: false })
  })

  it("keeps thinkingBudget:0 and still hides thoughts when reasoning is off", () => {
    const body = getProviderConfig(googleConfig({ reasoning: { mode: "off" } })).buildBody(
      [{ role: "user", content: "写第14章" }],
    ) as { generationConfig?: { thinkingConfig?: Record<string, unknown> } }

    expect(body.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 0,
      includeThoughts: false,
    })
  })

  it("does not send thinkingConfig for models that do not support it", () => {
    const body = getProviderConfig(googleConfig({ model: "gemini-1.5-pro" })).buildBody(
      [{ role: "user", content: "写第14章" }],
    ) as Record<string, unknown>

    expect(body.generationConfig).toBeUndefined()
  })
})

describe("modelSupportsReasoningControl", () => {
  it("hides the control for local CLI providers that ignore config.reasoning", () => {
    // Claude Code takes no thinking parameter; Cursor CLI reads effort out of
    // the model id (`model[reasoning_effort=high]`) instead.
    expect(modelSupportsReasoningControl(customConfig({
      provider: "claude-code",
      model: "claude-sonnet-4-5",
    }))).toBe(false)
    expect(modelSupportsReasoningControl(customConfig({
      provider: "cursor-cli",
      model: "gpt-5.4",
    }))).toBe(false)
    expect(modelSupportsReasoningControl(customConfig({
      provider: "antigravity-cli",
      model: "gemini-3.8-flash-high",
    }))).toBe(false)
  })

  it("offers the control for Codex CLI, which maps the mode onto turn effort", () => {
    expect(modelSupportsReasoningControl(customConfig({
      provider: "codex-cli",
      model: "gpt-5.4-codex",
    }))).toBe(true)
  })

  it("gates Gemini on the same version check that guards thinkingConfig", () => {
    expect(modelSupportsReasoningControl(customConfig({
      provider: "google",
      model: "gemini-2.5-pro",
    }))).toBe(true)
    expect(modelSupportsReasoningControl(customConfig({
      provider: "google",
      model: "gemini-1.5-pro",
    }))).toBe(false)
  })

  it("requires Claude 3.7+ on the Anthropic wire, since 3.5 rejects thinking", () => {
    expect(modelSupportsReasoningControl(customConfig({
      provider: "anthropic",
      model: "claude-3-7-sonnet-latest",
    }))).toBe(true)
    expect(modelSupportsReasoningControl(customConfig({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    }))).toBe(true)
    expect(modelSupportsReasoningControl(customConfig({
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
    }))).toBe(false)
  })

  it("applies the Anthropic gate to MiniMax and anthropic_messages custom endpoints", () => {
    expect(modelSupportsReasoningControl(customConfig({
      provider: "minimax",
      model: "MiniMax-M2",
    }))).toBe(true)
    expect(modelSupportsReasoningControl(customConfig({
      apiMode: "anthropic_messages",
      model: "claude-opus-4-1",
    }))).toBe(true)
    expect(modelSupportsReasoningControl(customConfig({
      apiMode: "anthropic_messages",
      model: "claude-3-haiku-20240307",
    }))).toBe(false)
  })

  it("offers the control only for reasoning models on the OpenAI wire", () => {
    expect(modelSupportsReasoningControl(customConfig({
      provider: "openai",
      model: "gpt-5.4",
    }))).toBe(true)
    expect(modelSupportsReasoningControl(customConfig({
      provider: "openai",
      model: "o3",
    }))).toBe(true)
    // gpt-4o either ignores reasoning_effort or 400s on it.
    expect(modelSupportsReasoningControl(customConfig({
      provider: "openai",
      model: "gpt-4o",
    }))).toBe(false)
  })

  it("recognises vendor-prefixed reasoning ids served by OpenAI-compatible gateways", () => {
    expect(modelSupportsReasoningControl(customConfig({
      model: "openai/o3",
      customEndpoint: "https://openrouter.ai/api/v1",
    }))).toBe(true)
    expect(modelSupportsReasoningControl(customConfig({
      model: "x-ai/grok-4-reasoning",
      customEndpoint: "https://openrouter.ai/api/v1",
    }))).toBe(true)
    expect(modelSupportsReasoningControl(customConfig({
      model: "meta-llama/llama-3.3-70b-instruct",
      customEndpoint: "https://openrouter.ai/api/v1",
    }))).toBe(false)
  })

  it("covers the vendor-specific thinking branches of buildOpenAiCompatibleBody", () => {
    expect(modelSupportsReasoningControl(customConfig({
      model: "deepseek-chat",
      customEndpoint: "https://api.deepseek.com/v1",
    }))).toBe(true)
    expect(modelSupportsReasoningControl(customConfig({
      model: "qwen3-235b-a22b",
    }))).toBe(true)
    expect(modelSupportsReasoningControl(customConfig({
      model: "glm-5",
      customEndpoint: "https://open.bigmodel.cn/api/paas/v4",
    }))).toBe(true)
  })

  it("does not offer the control for GLM-5 outside the official Zhipu endpoint", () => {
    // Third-party GLM deployments may not accept the top-level thinking
    // object, which is why the body builder gates on the endpoint too.
    expect(modelSupportsReasoningControl(customConfig({
      model: "glm-5",
      customEndpoint: "https://api.atlascloud.ai/v1",
    }))).toBe(false)
  })
})

// ── OpenAI 分支回归：通用适配器抽取后必须逐字保持原行为 ──
//
// T3 把 `case "openai"` 的 url/headers/body 构造抽成了 `openAiCompatibleRequest()`
// （见 llm-providers.ts），让插件 provider 复用同一份线格式。这是纯重构，
// 所以这里用改动前就存在的字面量钉住 OpenAI 的 url / headers / body / 解析器，
// 防止以后「顺手统一一下」把 OpenAI 的行为改掉。
describe("OpenAI 分支回归（抽取通用请求适配器后行为不变）", () => {
  function openAiConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
    return {
      provider: "openai",
      apiKey: "sk-test",
      model: "gpt-4o",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128_000,
      ...overrides,
    }
  }

  it("url 仍是官方 chat/completions", () => {
    expect(getProviderConfig(openAiConfig()).url).toBe("https://api.openai.com/v1/chat/completions")
  })

  it("headers 仍是 Content-Type + Bearer <apiKey>", () => {
    expect(getProviderConfig(openAiConfig()).headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test",
    })
  })

  it("body 仍是 messages + stream + stream_options + model", () => {
    const body = getProviderConfig(openAiConfig()).buildBody([
      { role: "user", content: "hi" },
    ]) as Record<string, unknown>

    expect(body).toEqual({
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
      model: "gpt-4o",
    })
  })

  it("SSE 流与结束原因的解析器仍是 OpenAI 那套", () => {
    const cfg = getProviderConfig(openAiConfig())
    expect(cfg.parseStream('data: {"choices":[{"delta":{"content":"你"}}]}')).toBe("你")
    expect(cfg.parseFinishReason('data: {"choices":[{"finish_reason":"length"}]}')).toBe("length")
  })
})
