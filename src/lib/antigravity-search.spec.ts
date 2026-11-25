import { describe, expect, it, vi } from "vitest"
import {
  AntigravitySearchError,
  antigravitySearchDetailed,
  resolveAntigravitySearchTimeoutSecs,
} from "./antigravity-search"

const reply = { queries: ["IANA example domains"], summary: "摘要", outputs: [] }

describe("反重力 ACP 联网搜索", () => {
  it("从工具输出提取、去重和限制来源，保留实际搜索词及摘要", async () => {
    const invoke = vi.fn().mockResolvedValue({ ...reply, outputs: [
      [{ type: "content", content: { type: "text", text: "参见 https://example.org/a" } }],
      { results: [{ url: "https://example.org/a" }, { title: "报告", url: "https://example.org/b" }, { url: "https://example.org/c" }] },
    ] })
    const out = await antigravitySearchDetailed("问题", { invoke, model: " m ", maxResults: 2 })
    expect(invoke).toHaveBeenCalledWith("antigravity_cli_search", { query: "问题", model: "m", maxResults: 2, timeoutSecs: 180 })
    expect(out.queries).toEqual(reply.queries)
    expect(out.summary).toBe("摘要")
    expect(out.results.map(r => r.url)).toEqual(["https://example.org/a", "https://example.org/b"])
  })

  it("工具未附来源时保留空列表，模型摘要中的链接不作为来源", async () => {
    const invoke = vi.fn().mockResolvedValue({ ...reply, summary: "摘要 https://example.org/" })
    expect((await antigravitySearchDetailed("问题", { invoke })).results).toEqual([])
  })

  it("登录、超时和工具错误保留原始原因，无有效搜索记录时报错", async () => {
    for (const reason of ["需要登录", "搜索超时", "没有成功执行的联网搜索"]) {
      const invoke = vi.fn().mockRejectedValue(reason)
      await expect(antigravitySearchDetailed("问题", { invoke })).rejects.toThrow(reason)
    }
    const invoke = vi.fn().mockResolvedValue({ ...reply, queries: [] })
    await expect(antigravitySearchDetailed("问题", { invoke })).rejects.toBeInstanceOf(AntigravitySearchError)
  })
})

describe("antigravity search default model", () => {
  it("搜索模型留空时使用 Gemini 4 Hydrogen (Low)，显式选择优先", async () => {
    const { resolveAntigravitySearchModel, DEFAULT_ANTIGRAVITY_SEARCH_MODEL, ANTIGRAVITY_AGY_DEFAULT_MODEL, antigravityModelLabel } = await import("./antigravity-search")
    expect(DEFAULT_ANTIGRAVITY_SEARCH_MODEL).toBe("gemini-4-hydrogen-low")
    expect(resolveAntigravitySearchModel(undefined)).toBe(DEFAULT_ANTIGRAVITY_SEARCH_MODEL)
    expect(resolveAntigravitySearchModel("  ")).toBe(DEFAULT_ANTIGRAVITY_SEARCH_MODEL)
    expect(resolveAntigravitySearchModel(ANTIGRAVITY_AGY_DEFAULT_MODEL)).toBeNull()
    expect(resolveAntigravitySearchModel(" gemini-3.8-flash-low ")).toBe("gemini-3.8-flash-low")
    expect(antigravityModelLabel(DEFAULT_ANTIGRAVITY_SEARCH_MODEL)).toBe("Gemini 4 Hydrogen (Low)")
    expect(antigravityModelLabel("gpt-oss-120b-medium")).toBe("GPT OSS 120b (Medium)")
  })
})

describe("resolveAntigravitySearchTimeoutSecs", () => {
  it("旧配置缺字段或非法值回落 180 秒", () => {
    for (const v of [undefined, null, "", "abc", 0, -5, Number.NaN]) expect(resolveAntigravitySearchTimeoutSecs(v)).toBe(180)
  })
  it("限制在 30–900 秒并取整", () => {
    expect(resolveAntigravitySearchTimeoutSecs(5)).toBe(30)
    expect(resolveAntigravitySearchTimeoutSecs(5000)).toBe(900)
    expect(resolveAntigravitySearchTimeoutSecs("300")).toBe(300)
    expect(resolveAntigravitySearchTimeoutSecs(120.6)).toBe(121)
  })
  it("自定义超时传给 Rust 命令", async () => {
    const invoke = vi.fn().mockResolvedValue(reply)
    await antigravitySearchDetailed("问题", { invoke, timeoutSecs: 600 })
    expect(invoke).toHaveBeenCalledWith("antigravity_cli_search", expect.objectContaining({ model: "gemini-4-hydrogen-low", timeoutSecs: 600 }))
    await antigravitySearchDetailed("问题", { invoke, timeoutSecs: 9999 })
    expect(invoke).toHaveBeenLastCalledWith("antigravity_cli_search", expect.objectContaining({ timeoutSecs: 900 }))
  })
})
