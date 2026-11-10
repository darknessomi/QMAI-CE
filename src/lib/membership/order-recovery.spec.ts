// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readPendingOrder, savePendingOrder } from "./order-recovery"

const order = { outTradeNo: "ORDER-1", plan: "month" as const, payType: "wxpay" as const, amount: "0.50", createdAt: 1790000000000, expiresAt: 1790001800000 }
beforeEach(() => { localStorage.clear(); vi.restoreAllMocks() })

describe("未完成订单恢复记录", () => {
  it("白名单保存查询信息，不保存凭证、二维码和支付链接", () => {
    savePendingOrder("account-a", { ...order, accessToken: "test-token", qrCode: "test-qr", payUrl: "https://example.test" } as typeof order)
    expect(readPendingOrder("account-a")).toEqual(order)
    const saved = localStorage.getItem(localStorage.key(0)!)!
    expect(saved).not.toContain("test-token"); expect(saved).not.toContain("test-qr"); expect(saved).not.toContain("payUrl")
  })
  it("按账号隔离，并在终态时移除恢复记录", () => {
    savePendingOrder("account-a", order)
    expect(readPendingOrder("account-b")).toBeNull()
    savePendingOrder("account-a", null)
    expect(readPendingOrder("account-a")).toBeNull()
  })
  it.each(["invalid", "null", '{"plan":"month"}', JSON.stringify({ ...order, plan: "admin" }), JSON.stringify({ ...order, createdAt: "yesterday" })])("忽略损坏记录 %s", raw => {
    savePendingOrder("account-a", order)
    localStorage.setItem(localStorage.key(0)!, raw)
    expect(readPendingOrder("account-a")).toBeNull()
  })
  it("存储不可用时返回失败而不打断支付查询", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full") })
    expect(savePendingOrder("account-a", order)).toBe(false)
  })
})
