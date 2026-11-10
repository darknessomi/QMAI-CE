/**
 * 在线支付（码支付 / 易支付协议）的客户端调用。
 *
 * ## 客户端在这条链路里的职责
 *
 * 只有三件：
 *   1. 告诉服务端「我要买哪个卡种、用什么方式付」
 *   2. 把服务端返回的二维码/跳转链接展示出来
 *   3. 轮询订单状态，拿到 `granted` 后刷新会员信息
 *
 * **金额、签名、密钥一律不碰** —— 那三样只要出现在客户端，就等于把
 * 「用 1 分钱买年卡」的能力交给用户。
 *
 * ## 为什么需要轮询而不是等回调
 *
 * 回调是「平台 → 我们的服务端」，客户端完全看不到。用户扫完码后，唯一能
 * 知道结果的途径就是问服务端。而服务端的 `/v1/pay/status` 会顺带主动查单，
 * 所以即使回调丢了，轮询也能拿到正确结果。
 */

import { isAccountApiError } from "./errors"
import { requestAccount } from "./api"
import type { FetchImpl } from "./api"
import { lazyAccountFetch } from "./api"

/** 卡种 */
export type PayPlanId = "month" | "quarter" | "year"

/** 支付方式 */
export type PayType = "alipay" | "wxpay"

/** 下单结果 */
export interface CreatePayOrderResult {
  ok: boolean
  outTradeNo: string
  /** 三选一，按「哪个非空用哪个」处理 */
  payUrl: string | null
  qrCode: string | null
  urlScheme: string | null
  amount: string
  /** 服务端给出的支付有效期，毫秒时间戳；旧服务端可能不返回。 */
  expiresAt?: number | null
  /** 失败原因（可直接展示） */
  message?: string
}

/** 订单状态 */
export type PayOrderStatus = "pending" | "granted" | "expired" | "failed"

export interface PayStatusResult {
  status: PayOrderStatus
  plan: string
  amount: string
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

/**
 * 网络层失败自动重试一次。
 *
 * ## 为什么（2026-11-09 用户实测）
 *
 * 「支付宝和微信一上来就报『网络不可用』，点重试之后才正常。」
 *
 * 这是**首次请求的瞬时失败**，不是真的断网：
 *   · Tauri 的 `plugin-http` 走 IPC 到 Rust 侧，首次调用有一个初始化过程，
 *     在 WebView2 上偶尔会失败一次
 *   · 也可能只是 DNS 首次解析或连接建立的抖动
 *
 * 无论哪种，让用户为一次几百毫秒的抖动手动点「重试」都是不对的 ——
 * 用户会以为软件坏了。
 *
 * ## 只重试网络层
 *
 * HTTP 有响应但状态码不对（401 / 400 / 500）**不重试**：那是确定性失败，
 * 重试一百次也是同样结果，只会让用户多等。只有「根本没连上」才重试。
 *
 * 延迟 300ms 而不是立即重试：立即重试往往撞在同一个瞬时故障上。
 */
async function withNetworkRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(isAccountApiError(error) && error.code === "NETWORK")) throw error
    await new Promise((resolve) => setTimeout(resolve, 300))
    return await run()
  }
}

/**
 * 下单。
 *
 * 服务端返回 `{ success: true, data: {...} }`，这里的 `ok` 是**业务成功**，
 * 与 HTTP 200 不是一回事 —— 下单被支付网关拒绝时 HTTP 仍是 200，
 * 但 `ok: false` 且带 `message`。
 */
export async function createPayOrder(
  baseUrl: string,
  accessToken: string,
  input: { plan: PayPlanId; payType: PayType },
  fetchImpl: FetchImpl = lazyAccountFetch,
): Promise<CreatePayOrderResult> {
  const { data } = await withNetworkRetry(() =>
    requestAccount(baseUrl, {
      method: "POST",
      path: "/v1/pay/create",
      accessToken,
      unauthorizedCode: "TOKEN_EXPIRED",
      fetchImpl,
      body: { plan: input.plan, payType: input.payType },
    }),
  )

  const record = asRecord(data)
  if (!record) throw new Error("支付服务返回格式异常。")

  return {
    ok: record.ok === true,
    outTradeNo: str(record.outTradeNo) ?? "",
    payUrl: str(record.payUrl),
    qrCode: str(record.qrCode),
    urlScheme: str(record.urlScheme),
    amount: str(record.amount) ?? "",
    expiresAt: typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt) && record.expiresAt > 0 ? record.expiresAt : null,
    message: str(record.message) ?? undefined,
  }
}

/** 查单（轮询用）。服务端会顺带主动向支付平台查一次。 */
export async function fetchPayStatus(
  baseUrl: string,
  accessToken: string,
  outTradeNo: string,
  fetchImpl: FetchImpl = lazyAccountFetch,
): Promise<PayStatusResult> {
  /*
   * 查单也走重试。
   *
   * 轮询本身能容忍单次失败（下一次 3 秒后还会来），但如果**首次**查单
   * 就撞上瞬时故障，用户会多等一整个轮询周期才看到「已到账」。
   */
  const { data } = await withNetworkRetry(() =>
    requestAccount(baseUrl, {
      method: "GET",
      path: `/v1/pay/status?outTradeNo=${encodeURIComponent(outTradeNo)}`,
      accessToken,
      unauthorizedCode: "TOKEN_EXPIRED",
      fetchImpl,
    }),
  )

  const record = asRecord(data)
  if (!record) throw new Error("支付服务返回格式异常。")

  const raw = str(record.status) ?? "pending"
  const status: PayOrderStatus =
    raw === "granted" || raw === "expired" || raw === "failed" ? raw : "pending"

  return {
    status,
    plan: str(record.plan) ?? "",
    amount: str(record.amount) ?? "",
  }
}

/** 轮询间隔（毫秒）。3 秒一次，2 分钟内用户基本都能扫完 */
export const PAY_POLL_INTERVAL_MS = 3_000
/** 轮询上限：订单有效期 30 分钟，客户端最多等 10 分钟 */
export const PAY_POLL_MAX_MS = 10 * 60 * 1000
