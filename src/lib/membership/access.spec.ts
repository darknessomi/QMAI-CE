import { describe, expect, it } from "vitest"

import type { AccountUser } from "@/lib/account/types"
import {
  FREE_FEATURES,
  MEMBER_FEATURES,
  MEMBER_FEATURE_LABELS,
  MEMBER_FEATURE_VIEWS,
  canUseMemberFeature,
  isMemberLockedView,
  isMembershipActive,
  memberExpiryLabel,
  memberRemainingLabel,
  membershipOf,
} from "./access"

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

function userWith(membership: AccountUser["membership"]): AccountUser {
  return {
    id: 1,
    email: "a@b.com",
    displayName: "作者",
    createdAt: 1_793_000_000,
    avatarUpdatedAt: null,
    displayNameUpdatedAt: null,
    membership,
  }
}

const ACTIVE = { active: true, expiresAt: NOW / 1000 + 30 * 24 * 60 * 60, remainingDays: 30, planLabel: "月卡" }

describe("isMembershipActive", () => {
  it("服务端说 active 且没到期才算会员", () => {
    expect(isMembershipActive(ACTIVE, NOW)).toBe(true)
  })

  it("本地时钟已跨过到期时间：即便快照写着 active 也不再算会员", () => {
    /*
     * 这条是这层的**核心价值**：快照是登录那一刻算的，用户可能开着软件跨过到期点。
     * 不加本地比对，睡一晚醒来的人第二天仍然享有会员功能。
     */
    const expired = { ...ACTIVE, expiresAt: NOW / 1000 - 1 }
    expect(isMembershipActive(expired, NOW)).toBe(false)
  })

  it("服务端说不是会员时，即使到期时间在未来也不算（不信任本地编造的状态）", () => {
    expect(isMembershipActive({ ...ACTIVE, active: false }, NOW)).toBe(false)
  })

  it("缺失 / 没有到期时间一律非会员", () => {
    expect(isMembershipActive(null, NOW)).toBe(false)
    expect(isMembershipActive(undefined, NOW)).toBe(false)
    expect(isMembershipActive({ ...ACTIVE, expiresAt: null }, NOW)).toBe(false)
  })
})

describe("membershipOf", () => {
  it("老会话没有会员字段时按非会员处理，不抛错", () => {
    const legacy = userWith(undefined)
    expect(membershipOf(legacy)).toEqual({ active: false, expiresAt: null, remainingDays: 0, planLabel: null, forever: false })
    expect(membershipOf(null)).toEqual({ active: false, expiresAt: null, remainingDays: 0, planLabel: null, forever: false })
  })
})

describe("功能闸门", () => {
  it("五个会员功能：非会员全锁、会员全开", () => {
    /*
     * 2026-11-09：从 4 项变成 5 项，补进 `cloudBackup`。
     *
     * 云备份**一直**有 `isMembershipActive` 硬闸门（在 member-cloud-store 里），
     * 但没被登记进这份清单 —— 于是账号页说「4 项」、用户实际被拦的是 5 项。
     * 现在这份清单是唯一权威口径。
     *
     * 顺带钉住**顺序**：有独立操作面板的两项在前（云备份 / 模型同步），
     * 与账号页会员态的上下两张卡对应。
     */
    expect(MEMBER_FEATURES).toEqual([
      "cloudBackup",
      "modelSync",
      "soul",
      "bookAnalysis",
      "storySimulation",
    ])
    const free = userWith(undefined)
    const member = userWith(ACTIVE)
    for (const feature of MEMBER_FEATURES) {
      expect(canUseMemberFeature(feature, free, NOW), feature).toBe(false)
      expect(canUseMemberFeature(feature, member, NOW), feature).toBe(true)
    }
  })

  it("章节与大纲永远可用（不在会员清单里）", () => {
    const free = userWith(undefined)
    // 清单本身是「哪些要会员」的白名单：FREE_FEATURES 里的东西不该出现在 MEMBER_FEATURES。
    for (const name of FREE_FEATURES) {
      expect(MEMBER_FEATURES).not.toContain(name)
    }
    // 不认识的 feature 也放行：新增功能不会被无意锁死。
    expect(canUseMemberFeature("anything" as never, free, NOW)).toBe(true)
  })

  it("视图映射只覆盖三个整页功能，模型同步不在其中（它在设置里）", () => {
    expect(MEMBER_FEATURE_VIEWS).toEqual({
      soul: "soul",
      bookAnalysis: "bookAnalysis",
      storySimulation: "storySimulation",
    })
  })

  it("isMemberLockedView：会员功能未开通时锁，其余视图不锁", () => {
    const free = userWith(undefined)
    expect(isMemberLockedView("bookAnalysis", free, NOW)).toBe(true)
    expect(isMemberLockedView("storySimulation", free, NOW)).toBe(true)
    expect(isMemberLockedView("soul", free, NOW)).toBe(true)
    // 章节 / 大纲 / 其它视图一律不受会员影响。
    expect(isMemberLockedView("wiki", free, NOW)).toBe(false)
    expect(isMemberLockedView("sources", free, NOW)).toBe(false)
    expect(isMemberLockedView("settings", free, NOW)).toBe(false)
    expect(isMemberLockedView(null, free, NOW)).toBe(false)
  })

  it("每个会员功能都有中文名（引导页与徽标要用）", () => {
    for (const feature of MEMBER_FEATURES) {
      expect(MEMBER_FEATURE_LABELS[feature].length).toBeGreaterThan(0)
    }
  })
})

describe("展示文案", () => {
  it("剩余天数向上取整，最后不足一天也显示 1 天", () => {
    expect(memberRemainingLabel(ACTIVE, NOW)).toBe("剩余 30 天")
    expect(memberRemainingLabel({ ...ACTIVE, expiresAt: NOW / 1000 + 0.5 }, NOW)).toBe("剩余 1 天")
  })

  it("非会员不给剩余天数文案", () => {
    expect(memberRemainingLabel(userWith(undefined).membership, NOW)).toBe("")
  })

  it("到期日按本地时区日期展示", () => {
    const label = memberExpiryLabel({ ...ACTIVE, expiresAt: NOW / 1000 })
    expect(label).toBe(new Date(NOW).toLocaleDateString("zh-CN"))
    expect(memberExpiryLabel(null)).toBe("")
  })

  it("30 天就是 30 天：不会因为时区或取整变成 29", () => {
    const expiresAt = NOW / 1000 + (30 * DAY) / 1000
    expect(memberRemainingLabel({ ...ACTIVE, expiresAt }, NOW)).toBe("剩余 30 天")
  })
})

describe("永久会员（forever）", () => {
  const FOREVER = {
    active: true,
    // 与 account-worker 的 FOREVER_EXPIRES_AT 对齐：一个极远的固定时间戳
    expiresAt: 4_102_444_799,
    remainingDays: null,
    planLabel: "永久卡",
    forever: true,
  }

  it("剩余天数显示「永不过期」，不是「剩余 27000 天」", () => {
    expect(memberRemainingLabel(FOREVER, NOW)).toBe("永不过期")
  })

  it("到期日不显示具体日期（2099/12/31 这种假到期日只会让人困惑）", () => {
    expect(memberExpiryLabel(FOREVER)).toBe("")
  })

  it("永久卡判定为有效，且所有会员功能可用", () => {
    expect(isMembershipActive(FOREVER, NOW)).toBe(true)
    const user = userWith(FOREVER)
    for (const feature of MEMBER_FEATURES) {
      expect(canUseMemberFeature(feature, user, NOW), feature).toBe(true)
    }
  })

  it("老服务端不返回 forever 字段时按非永久处理，退回按天数显示", () => {
    // 老服务端：有真实到期时间，且**没有** forever 字段
    const legacy = {
      active: true,
      expiresAt: NOW / 1000 + 30 * 24 * 60 * 60,
      remainingDays: 30,
      planLabel: "月卡",
      forever: false,
    }
    expect(memberRemainingLabel(legacy, NOW)).toBe("剩余 30 天")
    expect(memberExpiryLabel(legacy)).not.toBe("")
  })
})