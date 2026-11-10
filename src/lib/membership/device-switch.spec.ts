// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 换设备后的会员显示（2026-11-07 用户要求：「剩多长时间就显示多长时间」）。
 *
 * ## 为什么这条值得单独钉
 *
 * 会员时长记在**账号**上，不在这台机器上。所以「换一台设备登录」之后：
 *   · 剩余天数必须按**服务端的 expiresAt + 本机当前时间**重算；
 *   · 不能沿用上一台设备的缓存，也不能显示成「新开通的 30 天」。
 *
 * 这里用真实 store，验证三件事：
 *   1. 新设备登录（响应里带会员）→ 立刻显示真实剩余天数；
 *   2. 服务端说「已过期」→ 显示未开通，而不是继续展示旧天数；
 *   3. 老设备留下的会话里有旧快照时，启动后拉一次最新状态覆盖它
 *      （否则换设备/长期不用后界面会停在旧数字上）。
 */

const api = vi.hoisted(() => ({
  fetchMembership: vi.fn(),
}))

vi.mock("@/lib/account/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/account/api")>("@/lib/account/api")
  return { ...actual, fetchMembership: api.fetchMembership }
})
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const { memberExpiryLabel, memberRemainingLabel, isMembershipActive, membershipOf } = await import(
  "@/lib/membership/access"
)
const { useAccountStore } = await import("@/stores/account-store")

const DAY = 24 * 60 * 60 * 1000

function userWith(expiresInMs: number | null) {
  return {
    id: 9,
    email: "a@b.c",
    displayName: "作者",
    createdAt: 1_793_000_000,
    avatarUpdatedAt: null,
    displayNameUpdatedAt: null,
    membership:
      expiresInMs === null
        ? undefined
        : {
            active: true,
            expiresAt: Math.floor((Date.now() + expiresInMs) / 1000),
            remainingDays: Math.ceil(expiresInMs / DAY),
            planLabel: "年卡",
          },
  }
}

beforeEach(() => {
  api.fetchMembership.mockReset()
  useAccountStore.setState({ status: "authenticated", user: null, session: null })
})

describe("换设备后剩余天数如实显示", () => {
  it("新设备登录：剩余 12 天就显示 12 天（不是完整的 365 天）", () => {
    const user = userWith(12 * DAY - 60_000)
    useAccountStore.setState({ user: user as never })
    const membership = membershipOf(useAccountStore.getState().user)

    expect(memberRemainingLabel(membership)).toBe("剩余 12 天")
    expect(isMembershipActive(membership)).toBe(true)
  })

  it("同一张年卡在中途换设备：显示的是「还剩多少」，不是卡面天数", () => {
    // 年卡，已经用了 200 天 → 应显示约 165 天
    const remaining = 365 * DAY - 200 * DAY
    const user = userWith(remaining)
    const membership = membershipOf(user as never)

    expect(memberRemainingLabel(membership)).toBe("剩余 165 天")
    // 到期日也必须与服务端一致
    expect(memberExpiryLabel(membership)).toBe(
      new Date(user.membership!.expiresAt * 1000).toLocaleDateString("zh-CN"),
    )
  })

  it("会员已过期：显示空字符串（界面显示「未开通」），不再报剩余天数", () => {
    const membership = membershipOf(userWith(-DAY) as never)
    expect(memberRemainingLabel(membership)).toBe("")
    expect(isMembershipActive(membership)).toBe(false)
  })

  it("启动后拉到最新状态：用服务端值覆盖本机旧快照（换设备/长期不用）", async () => {
    // 本机存着「还剩 300 天」的旧快照
    useAccountStore.setState({
      user: userWith(300 * DAY) as never,
      session: {
        baseUrl: "https://account.qmai.pro",
        accessToken: "access",
        accessExpiresAt: Math.floor(Date.now() / 1000) + 900,
        refreshToken: "r".repeat(43),
        refreshExpiresAt: Math.floor(Date.now() / 1000) + 86400,
        netcard: "card",
        user: userWith(300 * DAY),
        savedAt: Math.floor(Date.now() / 1000),
      } as never,
    })
    // 服务端说只剩 5 天
    api.fetchMembership.mockResolvedValueOnce({
      active: true,
      expiresAt: Math.floor((Date.now() + 5 * DAY) / 1000),
      remainingDays: 5,
      planLabel: "年卡",
    })

    await expect(useAccountStore.getState().refreshMembership()).resolves.toBe(true)

    expect(memberRemainingLabel(membershipOf(useAccountStore.getState().user))).toBe("剩余 5 天")
  })

  it("拉取失败：保留原快照、返回 false（不把天数清零，也不谎报成功）", async () => {
    useAccountStore.setState({
      user: userWith(300 * DAY) as never,
      session: {
        baseUrl: "https://account.qmai.pro",
        accessToken: "access",
        accessExpiresAt: Math.floor(Date.now() / 1000) + 900,
        refreshToken: "r".repeat(43),
        refreshExpiresAt: Math.floor(Date.now() / 1000) + 86400,
        netcard: "card",
        user: userWith(300 * DAY),
        savedAt: Math.floor(Date.now() / 1000),
      } as never,
    })
    api.fetchMembership.mockRejectedValueOnce(new Error("network"))

    await expect(useAccountStore.getState().refreshMembership()).resolves.toBe(false)
    expect(memberRemainingLabel(membershipOf(useAccountStore.getState().user))).toBe("剩余 300 天")
  })
})
