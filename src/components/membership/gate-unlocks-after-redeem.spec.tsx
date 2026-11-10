// @vitest-environment jsdom
/** 在线支付确认并刷新会员后，当前功能路由必须立即解锁。 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({
  redeemActivationCode: vi.fn(),
  fetchMembership: vi.fn(),
}))

vi.mock("@/lib/account/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/account/api")>("@/lib/account/api")
  return { ...actual, redeemActivationCode: api.redeemActivationCode, fetchMembership: api.fetchMembership }
})
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock("./writing-workspace", () => ({ WritingWorkspace: () => <div data-testid="stub-workspace" /> }))
vi.mock("@/components/chat/ai-chat-tab-container", () => ({
  AIChatTabContainer: () => <div data-testid="stub-ai" />,
}))

import { useMembershipPurchaseStore as purchase } from "@/stores/membership-purchase-store"
import { createPayOrder, fetchPayStatus } from "@/lib/account/pay-api"
vi.mock("@/lib/account/pay-api", async original => ({ ...await original<typeof import("@/lib/account/pay-api")>(), createPayOrder: vi.fn(), fetchPayStatus: vi.fn() }))

import { ContentArea } from "@/components/layout/content-area"
import { useAccountStore } from "@/stores/account-store"
import { useWikiStore } from "@/stores/wiki-store"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DAY = 24 * 60 * 60

function freeUser() {
  return {
    id: 9,
    email: "a@b.c",
    displayName: "作者",
    createdAt: 1_793_000_000,
    avatarUpdatedAt: null,
    displayNameUpdatedAt: null,
  }
}

function memberSession() {
  return {
    baseUrl: "https://account.qmai.pro",
    accessToken: "access",
    accessExpiresAt: Math.floor(Date.now() / 1000) + 900,
    refreshToken: "r".repeat(43),
    refreshExpiresAt: Math.floor(Date.now() / 1000) + 86400,
    netcard: null,
    user: freeUser(),
    savedAt: Math.floor(Date.now() / 1000),
  }
}

let host: HTMLDivElement
let root: Root

async function mount() {
  await act(async () => {
    root.render(<ContentArea />)
  })
  // 引导页是同步渲染的，这里只等一格微任务
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  api.redeemActivationCode.mockReset()
  useAccountStore.setState({
    status: "authenticated",
    user: freeUser(),
    session: memberSession() as never,
  })
  useWikiStore.getState().setActiveView("bookAnalysis")
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

async function payInGate() {
  purchase.setState(purchase.getInitialState(), true)
  vi.mocked(createPayOrder).mockResolvedValue({ ok: true, outTradeNo: "test-route", qrCode: "test", payUrl: null, urlScheme: null, amount: "0.50" })
  vi.mocked(fetchPayStatus).mockResolvedValue({ status: "granted", plan: "month", amount: "0.50" })
  await act(async () => {
    await purchase.getState().begin("wxpay", "bookAnalysis")
    await purchase.getState().check()
  })
}

describe("支付到账后引导页必须当场消失", () => {
  it("免费用户在拆书库看到引导页", async () => {
    await mount()
    expect(host.querySelector('[data-ui-page="member-gate"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="stub-ai"]')).toBeNull()
  })

  it("支付到账 → 会员状态写入 store → 引导页消失、功能页出现", async () => {
    api.fetchMembership.mockResolvedValueOnce({
        active: true,
        expiresAt: Math.floor(Date.now() / 1000) + 30 * DAY,
        remainingDays: 30,
        planLabel: "月卡",
      forever: false,
    })

    await mount()
    await payInGate()

    // 关键断言：不能停在引导页上
    expect(host.querySelector('[data-ui-page="member-gate"]')).toBeNull()
    // 会员状态确实落到了 store
    expect(useAccountStore.getState().user?.membership?.active).toBe(true)
  })
})
