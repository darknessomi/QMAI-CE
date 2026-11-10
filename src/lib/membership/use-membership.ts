/**
 * 会员判定的 React 绑定。
 *
 * 之所以还要一个 hook，而不是让每个组件直接 `useAccountStore((s) => s.user)`：
 *   · 「是否会员」要额外做一次**本地到期时间比对**（见 `lib/membership/access`），
 *     每个调用点各写一遍必然有人漏掉；
 *   · 跨过到期时刻时界面要自己变灰。这里用一个每分钟重算的 `now`，
 *     避免用户开着软件过夜后第二天仍然看到「会员可用」。
 *
 * `now` 用 60 秒节流：会员到期是「天」级别的变化，秒级刷新毫无意义，
 * 反而会让侧栏每分钟重渲染很多次。
 */

import { useEffect, useState } from "react"

import type { AccountUser } from "@/lib/account/types"
import {
  canUseMemberFeature,
  isMemberLockedView,
  isMembershipActive,
  membershipOf,
  type MemberFeature,
} from "./access"
import { useAccountStore } from "@/stores/account-store"

const TICK_MS = 60_000

/** 每分钟更新一次的「当前时间」，供到期判定使用。 */
export function useMembershipClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

export interface MembershipView {
  /** 当前登录用户（未登录为 null）。 */
  user: AccountUser | null
  /** 此刻是否会员（服务端说有效 + 本地未过期）。 */
  active: boolean
  /** 会员快照（可能为 null；展示用）。 */
  membership: ReturnType<typeof membershipOf>
  /** 某个会员功能是否可用。 */
  canUse: (feature: MemberFeature) => boolean
  /** 某个视图是否应该显示「需开通会员」页。 */
  isLockedView: (view: string | undefined | null) => boolean
}

export function useMembership(): MembershipView {
  const user = useAccountStore((state) => state.user)
  const now = useMembershipClock()
  const membership = membershipOf(user)
  const active = isMembershipActive(membership, now)

  return {
    user,
    active,
    membership,
    canUse: (feature) => canUseMemberFeature(feature, user, now),
    isLockedView: (view) => isMemberLockedView(view, user, now),
  }
}
