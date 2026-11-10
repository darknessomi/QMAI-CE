import type { PayPlanId, PayType } from "@/lib/account/pay-api"

/** 只保存最近一笔未完成订单的查询信息，不保存登录凭证或支付链接。 */
export interface RecoverableOrder {
  outTradeNo: string
  plan: PayPlanId
  payType: PayType
  amount: string
  createdAt: number
  expiresAt?: number | null
}

const PREFIX = "qmai.member-pending-order.v1:"
const key = (owner: string) => PREFIX + encodeURIComponent(owner)

export function readPendingOrder(owner: string): RecoverableOrder | null {
  try {
    const raw = localStorage.getItem(key(owner))
    if (!raw || raw.length > 2048) return null
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object") return null
    const record = value as Record<string, unknown>
    if (typeof record.outTradeNo !== "string" || !record.outTradeNo || record.outTradeNo.length > 128
      || !["month", "quarter", "year"].includes(String(record.plan))
      || !["wxpay", "alipay"].includes(String(record.payType))
      || typeof record.amount !== "string" || !/^\d{1,8}(\.\d{1,2})?$/.test(record.amount)
      || typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt) || record.createdAt <= 0) return null
    return {
      outTradeNo: record.outTradeNo, plan: record.plan as PayPlanId, payType: record.payType as PayType,
      amount: record.amount, createdAt: record.createdAt,
      expiresAt: typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt) && record.expiresAt > 0 ? record.expiresAt : null,
    }
  } catch { return null }
}

export function savePendingOrder(owner: string, order: RecoverableOrder | null): boolean {
  try {
    if (order) {
      const { outTradeNo, plan, payType, amount, createdAt, expiresAt } = order
      localStorage.setItem(key(owner), JSON.stringify({ outTradeNo, plan, payType, amount, createdAt, expiresAt }))
    } else localStorage.removeItem(key(owner))
    return true
  } catch { return false }
}
