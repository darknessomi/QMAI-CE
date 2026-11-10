// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 会员卡片 / 弹窗 / VIP 徽标。
 *
 * ## 为什么这几条必须钉死
 *
 * 会员卡片是整个付费转化路径的入口，它出错的代价是「用户看不到会员能干什么」，
 * 而不是「界面丑一点」。这里守四件事：
 *
 *   1. 未登录不渲染卡片（没账号就没有会员状态，露出来只会让人困惑）
 *   2. 未开通时 4 项功能必须全部出现（这是唯一的「值不值得买」依据）
 *   3. 已开通时显示剩余天数，且**不再出现「立即开通」**（老会员不该被反复推销）
 *   4. 永久卡显示「永不过期」，不能算成两万多天
 */

const state = vi.hoisted(() => ({
  user: null as null | { id: number; email: string; displayName?: string },
  active: false,
  membership: null as null | {
    active: boolean
    expiresAt: number | null
    remainingDays: number | null
    planLabel: string | null
    forever: boolean
  },
}))

const mocks = vi.hoisted(() => ({
  refreshMembership: vi.fn(async () => true),
  onRedeemed: vi.fn(),
}))

vi.mock("@/lib/membership/use-membership", () => ({
  useMembership: () => ({
    user: state.user,
    active: state.active,
    membership: state.membership,
    canUse: () => state.active,
    isLockedView: () => !state.active,
  }),
}))

vi.mock("@/stores/account-store", () => ({
  useAccountStore: (selector: (s: { refreshMembership: typeof mocks.refreshMembership }) => unknown) =>
    selector({ refreshMembership: mocks.refreshMembership }),
}))

vi.mock("./activation-code-form", () => ({
  ActivationCodeForm: () => <div data-ui="mock-activation-form" />,
}))

/*
 * 2026-11-08：额度并入会员卡（方案 A1）。
 * 卡片下半部分要显示「云同步空间 剩 X」，所以这里把 store 与 formatBytes 打桩，
 * 让用例能控制「有多少额度」而不必真的去请求网关。
 */
const quotaState = vi.hoisted(() => ({
  quota: null as null | {
    tier: string
    usedBytes: number
    usedFiles: number
    limitBytes: number
    limitFiles: number
    memberOnly?: boolean
  },
  error: null as string | null,
  refresh: vi.fn(async () => {}),
}))

vi.mock("@/stores/sync-quota-store", async () => {
  const actual = await vi.importActual<typeof import("@/stores/sync-quota-store")>(
    "@/stores/sync-quota-store",
  )
  return {
    ...actual,
    useSyncQuotaStore: (selector: (s: unknown) => unknown) =>
      selector({
        quota: quotaState.quota,
        error: quotaState.error,
        loading: false,
        refresh: quotaState.refresh,
      }),
  }
})

vi.mock("@/lib/qmai-sync/client", () => ({
  // 用固定格式，避免依赖真实实现的取整规则
  formatBytes: (n: number) => `${(n / (1024 * 1024)).toFixed(0)} MB`,
}))

vi.mock("@/stores/member-cloud-store", () => ({ useMemberCloudStore: (selector: (s: { autoEnabled: boolean }) => unknown) => selector({ autoEnabled: false }) }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { MembershipCard } from "./membership-card"
import { VipBadge } from "./vip-badge"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  state.user = { id: 1, email: "u@example.com", displayName: "青幕用户" }
  state.active = false
  state.membership = { active: false, expiresAt: null, remainingDays: 0, planLabel: null, forever: false }
  mocks.refreshMembership.mockClear()
  // 额度每个用例单独设，默认没有（卡片只显示身份部分）
  quotaState.quota = null
  quotaState.error = null
  quotaState.refresh = vi.fn(async () => {})

  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(node: React.ReactElement) {
  await act(async () => {
    root.render(node)
  })
}

describe("VipBadge", () => {
  it("渲染 VIP 三个字母", async () => {
    await render(<VipBadge />)
    expect(container.textContent).toBe("VIP")
  })

  it("尺寸档位写进 data-size", async () => {
    await render(<VipBadge size="lg" />)
    expect(container.querySelector('[data-ui="vip-badge"]')?.getAttribute("data-size")).toBe("lg")
  })

  it("muted 与正常态用不同的 data-muted（供 CSS/测试区分）", async () => {
    await render(<VipBadge muted />)
    expect(container.querySelector('[data-ui="vip-badge"]')?.getAttribute("data-muted")).toBe("true")
  })
})

describe("会员卡片", () => {
  it("未登录时不渲染", async () => {
    state.user = null
    await render(<MembershipCard onOpen={() => {}} />)
    expect(container.querySelector('[data-ui="membership-card"]')).toBeNull()
  })

  it("未开通：显示免费身份与开通入口", async () => {
    await render(<MembershipCard onOpen={() => {}} />)
    const text = container.textContent ?? ""
    expect(text).toContain("免费用户")
    expect(text).toContain("开通会员")
    /*
     * 2026-11-08 改：4 项功能清单从卡片上移除了（用户明确要求）。
     * 那 4 项在会员弹窗里有详细说明，塞在菜单里只是把卡片撑到 130px。
     */
    expect(text).not.toContain("灵魂库")
  })

  it("未开通时不应出现「剩余」字样", async () => {
    await render(<MembershipCard onOpen={() => {}} />)
    expect(container.textContent).not.toContain("剩余")
  })

  it("已开通：显示剩余天数与 4 项功能，且不再有「立即开通」", async () => {
    const in328Days = Math.floor(Date.now() / 1000) + 328 * 86400
    state.active = true
    state.membership = {
      active: true,
      expiresAt: in328Days,
      remainingDays: 328,
      planLabel: "年卡",
      forever: false,
    }

    await render(<MembershipCard onOpen={() => {}} />)
    const text = container.textContent ?? ""
    expect(text).toContain("年卡")
    expect(text).toContain("328")
    // 老会员不该被反复推销（4 项清单已移除，见上一个用例的说明）
    expect(text).not.toContain("开通会员")
  })

  /*
   * 额度并入卡片（方案 A1，2026-11-08）。
   *
   * 用户原来的抱怨：「云同步空间已用放在侧栏底部是不合适的，应该放在
   * 点头像弹出的这个页面里」。这两条守住合并后的效果 —— 卡片必须同时
   * 讲清「我是谁」和「我还有多少空间」。
   */
  it("会员卡下半部分显示云空间额度与到期日", async () => {
    state.active = true
    state.membership = {
      active: true,
      expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400,
      remainingDays: 30,
      planLabel: "月卡",
      forever: false,
    }
    quotaState.quota = {
      tier: "member",
      usedBytes: 512 * 1024 * 1024,
      usedFiles: 1204,
      limitBytes: 5 * 1024 * 1024 * 1024,
      limitFiles: 50000,
    }

    await render(<MembershipCard onOpen={() => {}} />)
    const text = container.textContent ?? ""
    // 2026-11-09：标签从「云同步空间」简化为「云空间」（与账号页口径统一）
    expect(text).toContain("云空间")
    // 剩余 = 5GB - 512MB ≈ 4608MB
    expect(text).toContain("剩 4608 MB")
    expect(text).toContain("已用 10%")
    expect(text).toContain("共 5120 MB")
    // 到期日与顶部「剩余 N 天」呼应
    expect(text).toMatch(/到期/)
  })

  it("免费用户：显示未开通状态与可得额度，且不出现「已满」", async () => {
    /*
     * 2026-11-09 重写。这条测试原来喂的是**免费 100 MB 额度**
     * （`limitBytes: 100MB`，断言「剩 88 MB」）—— 那个产品逻辑已经取消：
     * 免费用户不再拥有云空间，网关卡返回 `{ limitBytes: 0, memberOnly: true }`。
     *
     * 而旧代码在这种情况下会把 `remainingBytes` 算成 0 → `level` 落进
     * `"full"` → 卡片显示「空间已满，新的改动传不上去。清理云端文件」，
     * 可免费用户**根本没有云端文件可清理**。
     *
     * 所以新契约有三条：
     *   ① 显示「云备份 / 未开通」与「会员可得 5 GB」（用户要求显示出来）
     *   ② **绝不出现**「已满」或「新的改动传不上去」
     *   ③ 免费用户没有到期这回事
     */
    quotaState.quota = {
      tier: "free",
      usedBytes: 0,
      usedFiles: 0,
      limitBytes: 0,
      limitFiles: 0,
      memberOnly: true,
    }

    await render(<MembershipCard onOpen={() => {}} />)
    const text = container.textContent ?? ""

    expect(text).toContain("免费用户")
    expect(text).toContain("开通会员")

    // ① 状态与可得额度都要看得见
    expect(text).toContain("云备份")
    expect(text).toContain("未开通")
    expect(text).toContain("会员可得 5 GB")

    // ② 这两句对免费用户是**误诊**，一个字都不能出现
    expect(text).not.toContain("已满")
    expect(text).not.toContain("新的改动传不上去")
    expect(text).not.toContain("清理云端文件")

    // ③ 免费用户没有到期这回事
    expect(text).not.toContain("到期")
  })

  it("额度拉取失败时仍显示会员有效期（不因一次请求失败丢掉身份信息）", async () => {
    state.active = true
    state.membership = {
      active: true,
      expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400,
      remainingDays: 30,
      planLabel: "月卡",
      forever: false,
    }
    quotaState.quota = null
    quotaState.error = "网络错误"

    await render(<MembershipCard onOpen={() => {}} />)
    const text = container.textContent ?? ""
    expect(text).toContain("月卡")
    expect(text).toContain("到期")
    // 没有额度数据时不该出现「云同步空间」这一行
    expect(text).not.toContain("云同步空间")
  })

  it("永久卡显示「永久有效」，不算成两万多天", async () => {
    state.active = true
    state.membership = {
      active: true,
      expiresAt: 4102444799,
      remainingDays: null,
      planLabel: "永久卡",
      forever: true,
    }

    await render(<MembershipCard onOpen={() => {}} />)
    const text = container.textContent ?? ""
    expect(text).toContain("永久有效")
    expect(text).toContain("永久卡")
  })

  it("点击卡片会回调 onOpen", async () => {
    const onOpen = vi.fn()
    await render(<MembershipCard onOpen={onOpen} />)
    const card = container.querySelector<HTMLButtonElement>('[data-ui="membership-card"]')
    await act(async () => {
      card?.click()
    })
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})
