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

it.each(["soul", "bookAnalysis"] as const)("%s 没有购码入口，显示五项权益与双支付方式", async feature => {
  await mount(feature)
  for (const label of ["灵魂库", "拆书库", "剧情推演室", "模型同步", "云备份", "章节与大纲始终免费", "微信支付", "支付宝"]) expect(host.textContent).toContain(label)
  for (const label of ["购买激活码", "发卡站", "联系客服发码"]) expect(host.textContent).not.toContain(label)
  expect(host.querySelector('input[aria-label="激活码"]')).toBeNull()
})
it("未登录点击付款进入登录流程，不发起订单", async () => {
  useAccountStore.setState({ session: null, user: null }); await mount(); await click("member-pay-wxpay")
  expect(useAccountStore.getState().authMode).toBe("login"); expect(createPayOrder).not.toHaveBeenCalled()
})
it("读取会员失败在原位给出反馈", async () => {
  useAccountStore.setState({ refreshMembership: vi.fn(async () => false) }); await mount()
  await act(async () => { [...host.querySelectorAll("button")].find(b => b.textContent?.includes("刷新会员状态"))!.click() })
  expect(host.textContent).toContain("暂时无法读取会员状态")
})
