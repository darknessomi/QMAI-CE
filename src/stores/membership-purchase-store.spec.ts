// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPayOrder, fetchPayStatus, type CreatePayOrderResult } from "@/lib/account/pay-api"
import type { AccountUser, MembershipInfo, StoredAccountSession } from "@/lib/account/types"
import { useAccountStore } from "./account-store"
import { useSyncQuotaStore } from "./sync-quota-store"
import { useMembershipPurchaseStore as purchase } from "./membership-purchase-store"
import { readPendingOrder } from "@/lib/membership/order-recovery"
import { AccountApiError } from "@/lib/account/errors"

vi.mock("@/lib/account/pay-api", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/account/pay-api")>(), createPayOrder: vi.fn(), fetchPayStatus: vi.fn(),
}))
const member: MembershipInfo = { active: true, expiresAt: Math.floor(Date.now() / 1000) + 86400 * 30, remainingDays: 30, planLabel: "月卡", forever: false }
function login(id = 1, baseUrl = "https://example.test") {
  const user: AccountUser = { id, email: "test@example.test", displayName: "测试作者", createdAt: 1, avatarUpdatedAt: null, displayNameUpdatedAt: null }
  const session: StoredAccountSession = { user, baseUrl, accessToken: "test-only", accessExpiresAt: 9999999999, refreshToken: "test-only", refreshExpiresAt: 9999999999, savedAt: 1 }
  useAccountStore.setState({ user, session })
}
const result: CreatePayOrderResult = { ok: true, outTradeNo: "test-order", qrCode: "test-qr", payUrl: null, urlScheme: null, amount: "0.73" }
const refresh = vi.fn(async () => true)
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.mocked(createPayOrder).mockReset()
  vi.mocked(fetchPayStatus).mockReset()
  purchase.setState(purchase.getInitialState(), true)
  login()
  refresh.mockReset().mockImplementation(async () => {
    useAccountStore.setState({ user: { ...useAccountStore.getState().user!, membership: member } }); return true
  })
  useAccountStore.setState({ refreshMembership: refresh, dialogOpen: false })
  useSyncQuotaStore.setState({ refresh: vi.fn(async () => undefined) })
  vi.mocked(createPayOrder).mockResolvedValue(result)
  vi.mocked(fetchPayStatus).mockResolvedValue({ status: "pending", plan: "month", amount: "0.73" })
})

describe("会员订单状态", () => {
  it("打开中心不下单；明确渠道后使用所选套餐和服务器金额", async () => {
    purchase.getState().show("soul")
    expect(createPayOrder).not.toHaveBeenCalled()
    purchase.getState().selectPlan("year")
    await purchase.getState().begin("alipay", "soul")
    expect(createPayOrder).toHaveBeenCalledWith("https://example.test", "test-only", { plan: "year", payType: "alipay" })
    expect(purchase.getState().order?.amount).toBe("0.73")
  })
  it("快速双击及在途关闭重开只创建一笔订单", async () => {
    let resolve!: (value: CreatePayOrderResult) => void
    vi.mocked(createPayOrder).mockReturnValueOnce(new Promise(r => { resolve = r }))
    const first = purchase.getState().begin("wxpay")
    purchase.getState().close()
    await purchase.getState().begin("alipay")
    expect(createPayOrder).toHaveBeenCalledTimes(1)
    resolve(result); await first
    expect(purchase.getState().order?.payType).toBe("wxpay")
  })
  it("待付款订单跨入口保留，返回套餐和重试付款均不重复创建", async () => {
    await purchase.getState().begin("wxpay", "soul")
    purchase.getState().close(); purchase.getState().show("bookAnalysis")
    await purchase.getState().showPlans()
    await purchase.getState().begin("alipay", "bookAnalysis")
    expect(createPayOrder).toHaveBeenCalledTimes(1)
    expect(purchase.getState().order?.outTradeNo).toBe(result.outTradeNo)
    expect(purchase.getState().origin).toBe("bookAnalysis")
  })
  it("手动查询 pending 不授予会员身份", async () => {
    await purchase.getState().begin("wxpay"); await purchase.getState().check()
    expect(refresh).not.toHaveBeenCalled()
    expect(useAccountStore.getState().user?.membership).toBeUndefined()
  })
  it("granted 刷新失败保留已付款状态，可重试权益同步", async () => {
    await purchase.getState().begin("wxpay")
    vi.mocked(fetchPayStatus).mockResolvedValue({ status: "granted", amount: "0.73", plan: "month" })
    refresh.mockResolvedValueOnce(false)
    await purchase.getState().check()
    expect(purchase.getState().order?.membershipUpdated).toBe(false)
    expect(purchase.getState().error).toContain("无需再次付款")
    await purchase.getState().check()
    expect(purchase.getState().order?.membershipUpdated).toBe(true)
    expect(purchase.getState().open).toBe(true)
    expect(useSyncQuotaStore.getState().refresh).toHaveBeenCalledWith({ force: true })
  })
  it("刷新返回 true 但没有有效权限也不能显示已到账", async () => {
    await purchase.getState().begin("wxpay")
    vi.mocked(fetchPayStatus).mockResolvedValue({ status: "granted", amount: "0.73", plan: "month" })
    refresh.mockResolvedValueOnce(true)
    await purchase.getState().check()
    expect(purchase.getState().order?.membershipUpdated).toBe(false)
  })
  it.each(["expired", "failed"] as const)("%s 订单仍可查看，然后重新选择套餐", async status => {
    await purchase.getState().begin("wxpay")
    vi.mocked(fetchPayStatus).mockResolvedValue({ status, plan: "month", amount: "0.73" })
    await purchase.getState().check()
    purchase.getState().close(); purchase.getState().show()
    expect(purchase.getState().order?.status).toBe(status)
    await purchase.getState().begin("alipay")
    expect(createPayOrder).toHaveBeenCalledTimes(2)
  })
  it("查询失败保留原订单，允许重试", async () => {
    await purchase.getState().begin("wxpay")
    vi.mocked(fetchPayStatus).mockRejectedValueOnce(new Error("offline"))
    await purchase.getState().check()
    expect(purchase.getState().error).toContain("请勿重复付款")
    expect(purchase.getState().order?.status).toBe("pending")
    await purchase.getState().check()
    expect(purchase.getState().error).toBe("")
  })
  it("未登录转到登录界面，不调用支付接口", async () => {
    useAccountStore.setState({ user: null, session: null })
    await purchase.getState().begin("wxpay")
    expect(useAccountStore.getState().authMode).toBe("login")
    expect(createPayOrder).not.toHaveBeenCalled()
  })
  it("永久会员不创建续费订单", async () => {
    useAccountStore.setState({ user: { ...useAccountStore.getState().user!, membership: { ...member, forever: true } } })
    await purchase.getState().begin("wxpay")
    expect(createPayOrder).not.toHaveBeenCalled()
  })
  it.each(["账号", "服务地址", "登出"])("切换%s后丢弃迟到的下单结果", async change => {
    let resolve!: (value: CreatePayOrderResult) => void
    vi.mocked(createPayOrder).mockReturnValueOnce(new Promise(r => { resolve = r }))
    const pending = purchase.getState().begin("wxpay")
    if (change === "登出") useAccountStore.setState({ session: null, user: null })
    else login(change === "账号" ? 2 : 1, change === "服务地址" ? "https://other.test" : "https://example.test")
    purchase.getState().syncAccount()
    resolve(result); await pending
    expect(purchase.getState().order).toBeNull()
    expect(purchase.getState().open).toBe(false)
  })
  it("查单期间切换账号不刷新新账号会员", async () => {
    await purchase.getState().begin("wxpay")
    let resolve!: (value: { status: "granted"; plan: string; amount: string }) => void
    vi.mocked(fetchPayStatus).mockReturnValueOnce(new Promise(r => { resolve = r }))
    const pending = purchase.getState().check()
    login(2); purchase.getState().syncAccount()
    resolve({ status: "granted", plan: "month", amount: "0.73" }); await pending
    expect(refresh).not.toHaveBeenCalled()
    expect(purchase.getState().order).toBeNull()
  })
  it("登录后保留刚刚选择的套餐", async () => {
    useAccountStore.setState({ session: null, user: null })
    purchase.getState().syncAccount()
    purchase.getState().selectPlan("year")
    await purchase.getState().begin("wxpay", "soul")
    login(); purchase.getState().syncAccount()
    expect(purchase.getState().plan).toBe("year")
    expect(purchase.getState().preferredPayType).toBe("wxpay")
    expect(purchase.getState().origin).toBe("soul")
    expect(purchase.getState().open).toBe(true)
    expect(createPayOrder).not.toHaveBeenCalled()
  })
  it("取消登录后不在以后登录时意外弹出购买", async () => {
    useAccountStore.setState({ session: null, user: null })
    await purchase.getState().begin("alipay", "bookAnalysis")
    useAccountStore.getState().closeDialog(); purchase.getState().syncAccount()
    login(); purchase.getState().syncAccount()
    expect(purchase.getState().open).toBe(false)
    expect(purchase.getState().loginIntent).toBeNull()
  })
  it("重启后恢复同账号未完成订单，并由服务端核实状态", async () => {
    await purchase.getState().begin("wxpay", "soul")
    purchase.setState(purchase.getInitialState(), true)
    purchase.getState().syncAccount()
    expect(purchase.getState().order).toMatchObject({ outTradeNo: "test-order", restored: true, status: "pending", qrCode: null, membershipUpdated: false })
    expect(refresh).not.toHaveBeenCalled()
    vi.mocked(fetchPayStatus).mockResolvedValueOnce({ status: "granted", plan: "month", amount: "0.73" })
    await purchase.getState().check()
    expect(purchase.getState().order?.membershipUpdated).toBe(true)
    expect(readPendingOrder(purchase.getState().owner!)).toBeNull()
  })
  it("换账号看不到旧订单，切回原账号可恢复查询", async () => {
    await purchase.getState().begin("wxpay")
    login(2); purchase.getState().syncAccount()
    expect(purchase.getState().order).toBeNull()
    login(1); purchase.getState().syncAccount()
    expect(purchase.getState().order?.outTradeNo).toBe("test-order")
  })
  it("恢复的历史已发放订单到期后可结束查询，不阻止正常续费", async () => {
    await purchase.getState().begin("wxpay")
    purchase.setState({ order: { ...purchase.getState().order!, createdAt: Date.now() - 40 * 86400000, restored: true } })
    vi.mocked(fetchPayStatus).mockResolvedValueOnce({ status: "granted", plan: "month", amount: "0.73" })
    refresh.mockImplementationOnce(async () => {
      useAccountStore.setState({ user: { ...useAccountStore.getState().user!, membership: { ...member, active: false, expiresAt: Date.now() / 1000 - 10 * 86400 } } }); return true
    })
    await purchase.getState().check()
    expect(purchase.getState().order).toMatchObject({ membershipUpdated: true, historical: true })
    expect(readPendingOrder(purchase.getState().owner!)).toBeNull()
    await purchase.getState().begin("alipay")
    expect(createPayOrder).toHaveBeenCalledTimes(2)
  })
  it("本机有效期结束仍不允许新下单，确认过期后才释放", async () => {
    vi.mocked(createPayOrder).mockResolvedValueOnce({ ...result, expiresAt: Date.now() - 1000 })
    await purchase.getState().begin("wxpay")
    await purchase.getState().begin("alipay")
    expect(createPayOrder).toHaveBeenCalledTimes(1)
    vi.mocked(fetchPayStatus).mockResolvedValueOnce({ status: "expired", plan: "month", amount: "0.73" })
    await purchase.getState().check()
    expect(readPendingOrder(purchase.getState().owner!)).toBeNull()
    await purchase.getState().begin("alipay")
    expect(createPayOrder).toHaveBeenCalledTimes(2)
  })
  it("登录过期与网络失败显示不同的处理建议", async () => {
    vi.mocked(createPayOrder).mockRejectedValueOnce(new AccountApiError("TOKEN_EXPIRED"))
    await purchase.getState().begin("wxpay")
    expect(purchase.getState().error).toContain("重新登录")
    expect(purchase.getState().error).not.toContain("检查网络")
  })
  it("终态订单正在复查时不创建新单，防止查询锁残留", async () => {
    await purchase.getState().begin("wxpay")
    purchase.setState({ order: { ...purchase.getState().order!, status: "expired" } })
    let resolve!: (value: { status: "expired"; plan: string; amount: string }) => void
    vi.mocked(fetchPayStatus).mockReturnValueOnce(new Promise(r => { resolve = r }))
    const checking = purchase.getState().check()
    purchase.getState().close(); purchase.getState().show()
    await purchase.getState().begin("alipay")
    expect(createPayOrder).toHaveBeenCalledTimes(1)
    resolve({ status: "expired", plan: "month", amount: "0.50" }); await checking
    expect(purchase.getState().checking).toBe(false)
    await purchase.getState().begin("alipay")
    expect(createPayOrder).toHaveBeenCalledTimes(2)
  })
})
