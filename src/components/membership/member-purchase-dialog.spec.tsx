// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useAccountStore } from "@/stores/account-store"
import { useMembershipPurchaseStore as purchase } from "@/stores/membership-purchase-store"
import { useSyncQuotaStore } from "@/stores/sync-quota-store"
import { createPayOrder, fetchPayStatus } from "@/lib/account/pay-api"
import { openExternalUrl } from "@/lib/open-external-url"
import { MemberPurchaseDialog } from "./member-purchase-dialog"
import { renewalDate } from "./member-purchase-options"
import type { MembershipInfo } from "@/lib/account/types"
import QRCode from "qrcode"
import { useWikiStore } from "@/stores/wiki-store"

vi.mock("@/lib/account/pay-api", async original => ({ ...await original<typeof import("@/lib/account/pay-api")>(), createPayOrder: vi.fn(), fetchPayStatus: vi.fn() }))
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "data:image/png;base64,RENDERED") } }))
vi.mock("@/lib/open-external-url", () => ({ openExternalUrl: vi.fn(async () => undefined) }))
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children, finalFocus: _finalFocus, ...rest }: React.HTMLAttributes<HTMLDivElement> & { finalFocus?: unknown }) => <div {...rest}>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}))
vi.mock("./activation-code-form", () => ({ ActivationCodeForm: () => <div>已有兑换码表单</div> }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const member: MembershipInfo = { active: true, expiresAt: Math.floor(Date.now() / 1000) + 86400 * 30, remainingDays: 30, planLabel: "月卡", forever: false }
let host: HTMLDivElement, root: Root
beforeEach(() => {
  localStorage.clear()
  vi.mocked(createPayOrder).mockReset()
  vi.mocked(fetchPayStatus).mockReset()
  vi.clearAllMocks(); purchase.setState(purchase.getInitialState(), true)
  const user = { id: 1, email: "test@example.test", displayName: "测试作者", createdAt: 1, avatarUpdatedAt: null, displayNameUpdatedAt: null }
  useAccountStore.setState({ user, session: { user, baseUrl: "https://example.test", accessToken: "test-only", refreshToken: "test-only", accessExpiresAt: 9999999999, refreshExpiresAt: 9999999999, savedAt: 1 }, refreshMembership: vi.fn(async () => { useAccountStore.setState({ user: { ...user, membership: member } }); return true }) })
  useSyncQuotaStore.setState({ quota: null, refresh: vi.fn(async () => undefined) })
  vi.mocked(createPayOrder).mockResolvedValue({ ok: true, outTradeNo: "test-order", qrCode: "test-qr-content", payUrl: null, urlScheme: null, amount: "0.73" })
  vi.mocked(fetchPayStatus).mockResolvedValue({ status: "pending", plan: "month", amount: "0.73" })
  purchase.getState().syncAccount()
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })
async function mount() { await act(async () => { root.render(<MemberPurchaseDialog />) }) }
async function begin() { await act(async () => { await purchase.getState().begin("alipay", "soul") }) }
async function click(text: string) { await act(async () => { [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes(text))!.click() }) }

describe("统一会员中心", () => {
  it("打开只选套餐，不自动下单，五项权益与双渠道齐全", async () => {
    purchase.getState().show(); await mount()
    expect(createPayOrder).not.toHaveBeenCalled()
    expect(host.querySelectorAll(".member-plan")).toHaveLength(3)
    expect(host.querySelectorAll(".member-benefit")).toHaveLength(5)
    expect(host.textContent).toContain("微信支付"); expect(host.textContent).toContain("支付宝")
    expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  })
  it("二维码文本编码并显示服务端返回金额", async () => {
    await begin(); await mount()
    expect(QRCode.toDataURL).toHaveBeenCalledWith("test-qr-content", expect.objectContaining({ width: 240 }))
    expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,RENDERED")
    expect(host.textContent).toContain("¥0.73")
  })
  it("服务端图片二维码直接展示，不重复编码", async () => {
    vi.mocked(createPayOrder).mockResolvedValueOnce({ ok: true, outTradeNo: "test-image-order", qrCode: "data:image/png;base64,SOURCE", payUrl: null, urlScheme: null, amount: "0.50" })
    await begin(); await mount()
    expect(QRCode.toDataURL).not.toHaveBeenCalled()
    expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,SOURCE")
  })
  it("关闭重开恢复原订单，结果不随功能解锁销毁", async () => {
    await begin(); await mount()
    await act(async () => { purchase.getState().close() })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => { purchase.getState().show("bookAnalysis") })
    expect(host.textContent).toContain("test-order")
    expect(createPayOrder).toHaveBeenCalledTimes(1)
    vi.mocked(fetchPayStatus).mockResolvedValue({ status: "granted", plan: "month", amount: "0.73" })
    await act(async () => { await purchase.getState().check() })
    expect(host.textContent).toContain("会员权益已更新")
    expect(host.textContent).toContain("返回拆书库")
    await click("返回拆书库")
    expect(purchase.getState().open).toBe(false)
  })
  it("最近的已完成订单从中心仍能查看", async () => {
    await begin(); await mount()
    vi.mocked(fetchPayStatus).mockResolvedValue({ status: "granted", plan: "month", amount: "0.73" })
    await act(async () => { await purchase.getState().check(); purchase.getState().close(); purchase.getState().show() })
    expect(host.textContent).toContain("最近订单 · 权益已到账")
    await click("查看结果")
    expect(host.textContent).toContain("会员权益已更新")
  })
  it("付款确认后权益刷新失败不显示成功", async () => {
    await begin(); await mount()
    useAccountStore.setState({ refreshMembership: vi.fn(async () => false) })
    vi.mocked(fetchPayStatus).mockResolvedValue({ status: "granted", plan: "month", amount: "0.73" })
    await act(async () => { await purchase.getState().check() })
    expect(host.textContent).toContain("无需再次付款")
    expect(host.textContent).not.toContain("会员权益已更新")
  })
  it("支付链接使用系统打开方式，失败可重试", async () => {
    vi.mocked(createPayOrder).mockResolvedValueOnce({ ok: true, outTradeNo: "link-order", qrCode: null, payUrl: "https://pay.example.test/order", urlScheme: null, amount: "0.50" })
    await begin(); await mount()
    vi.mocked(openExternalUrl).mockRejectedValueOnce(new Error("blocked"))
    await click("打开支付宝支付页面")
    expect(openExternalUrl).toHaveBeenCalledWith("https://pay.example.test/order")
    expect(host.textContent).toContain("暂时无法打开支付页面")
  })
  it("永久会员没有套餐和续费支付按钮", async () => {
    useAccountStore.setState({ user: { ...useAccountStore.getState().user!, membership: { ...member, forever: true } } })
    purchase.getState().show(); await mount()
    expect(host.textContent).toContain("无需续费")
    expect(host.querySelector('[data-ui="member-pay-wxpay"]')).toBeNull()
  })
  it("有效会员先展示权益入口，主动展开才显示续费套餐", async () => {
    useAccountStore.setState({ user: { ...useAccountStore.getState().user!, membership: member } })
    purchase.getState().show(); await mount()
    expect(host.textContent).toContain("我的会员权益")
    expect(host.querySelectorAll('[aria-label^="打开"]')).toHaveLength(5)
    expect(host.querySelector(".member-plan")).toBeNull()
    await click("续费会员")
    expect(host.querySelectorAll(".member-plan")).toHaveLength(3)
    expect(host.querySelector(".member-center-footer [data-ui=member-checkout]")).not.toBeNull()
    await click("收起续费套餐")
    expect(host.querySelector(".member-plan")).toBeNull()
  })
  it("会员权益入口进入已有工作台，云备份进入已有设置分区", async () => {
    useAccountStore.setState({ user: { ...useAccountStore.getState().user!, membership: member } })
    purchase.getState().show(); await mount()
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="打开灵魂库"]')!.click())
    expect(useWikiStore.getState().activeView).toBe("soul")
    expect(purchase.getState().open).toBe(false)
    await act(async () => purchase.getState().show())
    await click("管理云备份")
    expect(useWikiStore.getState().activeView).toBe("settings")
    expect(useWikiStore.getState().activeSettingsCategory).toBe("memberCloud")
  })
  it("二维码倒计时结束后隐藏付款入口、查询状态，不自动创建新单", async () => {
    vi.useFakeTimers()
    vi.mocked(createPayOrder).mockResolvedValueOnce({ ok: true, outTradeNo: "short-order", qrCode: "short-qr", payUrl: "https://pay.example.test/order", urlScheme: null, amount: "0.50", expiresAt: Date.now() + 2000 })
    await begin(); await mount()
    expect(host.textContent).toContain("00:02")
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(host.textContent).toContain("支付有效时间已结束")
    expect(host.querySelector("img")).toBeNull()
    expect(host.textContent).not.toContain("打开支付宝支付页面")
    expect(purchase.getState().order?.status).toBe("pending")
    expect(fetchPayStatus).toHaveBeenCalledTimes(2)
    expect(createPayOrder).toHaveBeenCalledTimes(1)
  })
  it("登录成功只恢复选择，不自动付款", async () => {
    const { user, session } = useAccountStore.getState()
    useAccountStore.setState({ user: null, session: null, dialogOpen: false })
    await mount()
    await act(async () => purchase.getState().selectPlan("year"))
    await act(async () => { await purchase.getState().begin("alipay", "bookAnalysis") })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => { useAccountStore.setState({ user, session, dialogOpen: false }) })
    expect(host.textContent).toContain("已保留所选套餐与支付宝支付方式")
    expect(host.querySelector('[data-ui="member-plan-year"]')?.getAttribute("aria-pressed")).toBe("true")
    expect(createPayOrder).not.toHaveBeenCalled()
  })
  it("登出即时隐藏当前账号订单", async () => {
    await begin(); await mount()
    await act(async () => { useAccountStore.setState({ session: null, user: null }) })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(purchase.getState().order).toBeNull()
  })
  it("续费保留剩余时长，到期账号从当前日期计算", () => {
    const now = new Date("2026-11-10T12:00:00+08:00").getTime()
    const expiresAt = now / 1000 + 20 * 86400
    expect(renewalDate({ ...member, expiresAt }, "month", now)).toBe(new Date(now + 50 * 86400000).toLocaleDateString("zh-CN"))
    expect(renewalDate({ ...member, expiresAt: now / 1000 - 10 }, "quarter", now)).toBe(new Date(now + 90 * 86400000).toLocaleDateString("zh-CN"))
  })
})
