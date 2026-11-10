import { describe, expect, it, vi } from "vitest"

import { createPayOrder } from "./pay-api"

/**
 * 下单对瞬时网络故障的容忍。
 *
 * ## 为什么要有重试（2026-11-09 用户实测）
 *
 * 「支付宝和微信一上来就报『网络不可用』，点重试之后才正常。」
 *
 * 这是**首次请求的瞬时失败**：Tauri 的 `plugin-http` 要经 IPC 到 Rust 侧，
 * 首次调用在 WebView2 上偶尔失败一次；也可能只是 DNS/连接的抖动。
 *
 * 让用户为一次几百毫秒的抖动手动点「重试」是错的 —— 他会以为软件坏了。
 *
 * ## 但只能重试网络层
 *
 * 有 HTTP 响应但状态码不对（401/400/500）是**确定性失败**，重试一百次
 * 也一样，只会让用户白等。所以这里必须钉住「不重试」的行为。
 */

const BASE = "https://account.qmai.pro"
const TOKEN = "tok"

const OK_BODY = {
  success: true,
  data: {
    ok: true,
    outTradeNo: "QM261109200000ABCDEF",
    qrCode: "weixin://wxpay/bizpayurl?pr=abc",
    amount: "0.50",
  },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** 一个「网络层失败」—— 和 Tauri plugin-http 失败时抛的一样 */
function networkError(): Error {
  const e = new TypeError("Failed to fetch")
  return e
}

describe("createPayOrder · 瞬时网络失败自动重试", () => {
  it("首次网络失败、第二次成功 → 正常返回（用户看不到错误）", async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw networkError()
      return jsonResponse(OK_BODY)
    })

    const r = await createPayOrder(BASE, TOKEN, { plan: "month", payType: "wxpay" }, fetchImpl as never)

    expect(r.ok).toBe(true)
    expect(r.outTradeNo).toBe("QM261109200000ABCDEF")
    expect(r.qrCode).toBe("weixin://wxpay/bizpayurl?pr=abc")
    expect(calls).toBe(2)
  })

  it("两次都失败 → 抛出网络错误（不无限重试）", async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      throw networkError()
    })

    await expect(
      createPayOrder(BASE, TOKEN, { plan: "month", payType: "wxpay" }, fetchImpl as never),
    ).rejects.toMatchObject({ code: "NETWORK" })
    expect(calls).toBe(2)
  })

  it("HTTP 401 不重试 —— 确定性失败，重试也是同样结果", async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      return jsonResponse(
        { success: false, code: "TOKEN_EXPIRED", message: "登录已过期，请重新登录。" },
        401,
      )
    })

    await expect(
      createPayOrder(BASE, TOKEN, { plan: "month", payType: "wxpay" }, fetchImpl as never),
    ).rejects.toMatchObject({ code: "TOKEN_EXPIRED" })
    // 关键：只请求了一次，没有白重试
    expect(calls).toBe(1)
  })

  it("HTTP 500 不重试", async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      return jsonResponse({ success: false, message: "服务异常" }, 500)
    })

    await expect(
      createPayOrder(BASE, TOKEN, { plan: "month", payType: "wxpay" }, fetchImpl as never),
    ).rejects.toBeTruthy()
    expect(calls).toBe(1)
  })

  it("首次成功不重试（正常路径只请求一次）", async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      return jsonResponse(OK_BODY)
    })

    await createPayOrder(BASE, TOKEN, { plan: "year", payType: "alipay" }, fetchImpl as never)
    expect(calls).toBe(1)
  })
})

describe("createPayOrder · 请求内容", () => {
  it("接收服务端毫秒有效期，缺省时不猜测到期时间", async () => {
    const expiresAt = Date.now() + 1800000
    const fetchImpl = vi.fn(async () => jsonResponse({ ...OK_BODY, data: { ...OK_BODY.data, expiresAt } }))
    expect((await createPayOrder(BASE, TOKEN, { plan: "month", payType: "wxpay" }, fetchImpl as never)).expiresAt).toBe(expiresAt)
    const legacy = vi.fn(async () => jsonResponse(OK_BODY))
    expect((await createPayOrder(BASE, TOKEN, { plan: "month", payType: "wxpay" }, legacy as never)).expiresAt).toBeNull()
  })
  it("支付方式与套餐按传入值发给服务端", async () => {
    let sent = ""
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      sent = String(init?.body ?? "")
      return jsonResponse(OK_BODY)
    })

    await createPayOrder(BASE, TOKEN, { plan: "quarter", payType: "alipay" }, fetchImpl as never)

    const body = JSON.parse(sent) as { plan: string; payType: string }
    expect(body.plan).toBe("quarter")
    expect(body.payType).toBe("alipay")
  })
})
