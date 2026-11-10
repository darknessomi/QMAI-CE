// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useAccountStore } from "@/stores/account-store"
import { useMembershipPurchaseStore as purchase } from "@/stores/membership-purchase-store"
import { createPayOrder } from "@/lib/account/pay-api"
import { MemberGateNotice } from "./member-gate-notice"
vi.mock("@/lib/account/pay-api", async original => ({ ...await original<typeof import("@/lib/account/pay-api")>(), createPayOrder: vi.fn(), fetchPayStatus: vi.fn() }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks(); purchase.setState(purchase.getInitialState(), true)
  const user = { id: 1, email: "test@example.test", displayName: "测试作者", createdAt: 1, avatarUpdatedAt: null, displayNameUpdatedAt: null }
  useAccountStore.setState({ user, session: { user, baseUrl: "https://example.test", accessToken: "test-only", refreshToken: "test-only", accessExpiresAt: 9999999999, refreshExpiresAt: 9999999999, savedAt: 1 } })
  vi.mocked(createPayOrder).mockResolvedValue({ ok: true, outTradeNo: "test-order", qrCode: "test-code", payUrl: null, urlScheme: null, amount: "0.50" })
  purchase.getState().syncAccount()
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })
async function mount(feature: "soul" | "bookAnalysis" = "soul") { await act(async () => { root.render(<MemberGateNotice feature={feature} />) }) }
async function click(ui: string) { await act(async () => { host.querySelector<HTMLButtonElement>('[data-ui="' + ui + '"]')!.click() }) }

it.each(["wxpay", "alipay"] as const)("%s 从当前功能传递套餐和来源到统一中心", async method => {
  await mount("bookAnalysis"); await click("member-plan-quarter"); await click("member-pay-" + method)
  expect(createPayOrder).toHaveBeenCalledWith("https://example.test", "test-only", { plan: "quarter", payType: method })
  expect(purchase.getState().origin).toBe("bookAnalysis")
  expect(purchase.getState().open).toBe(true)
})
it("提前展示单设备限制和实际订单金额说明", async () => {
  await mount(); expect(host.textContent).toContain("同一时间只能在一台设备登录")
  expect(host.textContent).toContain("实付金额以生成的订单为准")
})
