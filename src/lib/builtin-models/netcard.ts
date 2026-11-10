/**
 * 内置模型的凭证层（网关卡版）。
 *
 * ## 与上一版的区别
 *
 * 上一版叫"票据"：30 分钟过期，客户端要反复换 —— 把**认证状态**当**配置数据**同步，天生脆。
 * 现在叫"网关卡"：与账号 session 绑定的长期凭证，**登录一次拿到手，之后永远不用换**。
 *
 * 因此这个文件不再需要：
 *   - 过期判断 / 提前续签
 *   - 并发去重
 *   - 换票失败回退
 * 只剩三件事：从登录结果里取卡、存起来、取出来给请求用。
 *
 * ## 存在哪
 *
 * 存在**账号登录态**里（localStorage 的 account session），不单独开一份。
 * 理由：卡与登录态同生共死 —— 退出登录就该一起清掉，多存一处只会制造不一致。
 * 传输层（Tauri）拿到的是内存里的字符串，不落额外文件。
 */

import type { StoredAccountSession } from "@/lib/account/types"

/** 中转站基址。 */
import { RELAY_ENDPOINTS } from "./relay-endpoints"

export const DEFAULT_RELAY_URL = "https://relay.qmai.work"

/** 账号服务里的签发接口（老用户升级时用一次）。 */
export const NETCARD_ISSUE_PATH = "/v1/netcard"

/**
 * 会员状态变化后的补签接口（2026-11-06）。
 *
 * 兑换激活码后本机手上还没有卡，而卡是登录时才发的。这个端点让客户端
 * 在兑换成功后**当场**换一张，用户不必重新登录 —— 这是「开通即可用」
 * 与「请重新登录一次」之间的差别。
 */
export const NETCARD_REFRESH_PATH = "/v1/netcard/refresh"

/**
 * 从登录/注册/刷新的返回里取出网关卡。
 *
 * 后端可能因未配私钥而返回 null —— 这时不要抛错：登录本身是成功的，
 * 只是"内置模型不可用"，由界面给出提示。
 */
export function netcardFromAuthPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null
  const data = (payload as { data?: unknown }).data
  if (!data || typeof data !== "object") return null
  const card = (data as { netcard?: unknown }).netcard
  return typeof card === "string" && card.length > 0 ? card : null
}

/** 当前会话的网关卡（没有就返回 null）。 */
export function netcardOf(session: StoredAccountSession | null | undefined): string | null {
  const card = session?.netcard
  return typeof card === "string" && card.length > 0 ? card : null
}

/**
 * 读网卡里的 `tier`（`"member"` / `"free"`），读不出来返回 null。
 *
 * ## 为什么需要它（2026-11-09 线上 bug）
 *
 * 网卡是 JWT，`tier` 在**签发那一刻就烘死**了。网关据此决定额度：
 * `free` = 100 MB，`member` = 5 GB。
 *
 * 用户开通会员后，账号服务那边 `membership_expires_at` 已经顺延，界面也
 * 亮了会员标识，但**手里的网卡还是旧的那张 `tier:"free"`** —— 于是空间
 * 额度一直显示 100 MB。补签一次网卡就好了，但前提是得先知道「卡是旧的」。
 *
 * ## 为什么不做签名校验
 *
 * 这里只用来**决定要不要补签**，不用于任何安全判断。卡是假的只会导致
 * 多打一次补签请求，补签由服务端重新签发真卡。真正的校验在网关侧
 * （验签 + 回源），不依赖这个函数。
 */
export function netcardTierOf(
  session: StoredAccountSession | null | undefined,
): "member" | "free" | null {
  const card = netcardOf(session)
  if (!card) return null
  const parts = card.split(".")
  if (parts.length < 2) return null
  try {
    // base64url → base64，补齐 padding
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/")
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
    const json =
      typeof atob === "function"
        ? atob(padded)
        : Buffer.from(padded, "base64").toString("binary")
    const claims = JSON.parse(json) as { tier?: unknown }
    if (claims.tier === "member") return "member"
    if (claims.tier === "free") return "free"
    // 老卡没有 tier 字段：返回 null，由调用方决定要不要补签
    return null
  } catch {
    return null
  }
}

/**
 * 判断某个 provider 配置是否指向内置中转站。
 *
 * 用 URL 判断而不是 provider id：用户可能自己建了同名 provider，
 * 只有真正指向我们中转域名的那一份才该注入网关卡。
 *
 * ## 2026-11-08 修正：必须覆盖全部通道
 *
 * 原来只比较 `https://relay.qmai.work` 一个前缀。加了家庭网关通道
 * （`https://relay-home.qmai.work`）之后，指向家庭网关的配置会被判成
 * 「不是内置中转」→ **网卡不注入 → 内置模型直接 401**。
 *
 * 改成按 origin 精确比对所有已登记端点，顺带修掉了前缀匹配的老问题：
 * `https://relay.qmai.work.evil.com` 这种前缀相同但域名不同的地址
 * 以前会被误判成内置中转，现在不会了。
 */
export function isBuiltinRelayEndpoint(endpoint: string | undefined): boolean {
  const value = (endpoint ?? "").trim()
  if (!value) return false
  try {
    const origin = new URL(value).origin
    return RELAY_ENDPOINTS.some((item) => {
      try {
        return new URL(item.url).origin === origin
      } catch {
        return false
      }
    })
  } catch {
    // 不是合法 URL：退回前缀判断，保持对畸形输入的行为一致
    return value.startsWith(DEFAULT_RELAY_URL)
  }
}

/** 判断内置模型现在能不能用（已登录 + 手上有卡）。 */
export function hasUsableNetcard(session: StoredAccountSession | null | undefined): boolean {
  return netcardOf(session) !== null
}
