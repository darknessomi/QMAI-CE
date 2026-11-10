/**
 * 会员功能的唯一判定入口。
 *
 * ## 为什么单独一个模块
 *
 * 「哪些功能要会员」这件事必须在**一个地方**定义：
 *   · 侧栏徽标（`icon-sidebar`）、顶栏「创作工具」菜单（`ui-test-shell`）、
 *     页面路由（`content-area`）、设置里的模型同步面板，四处都要判；
 *   · 四个地方各写一遍条件，迟早出现「侧栏显示着徽标但点进去能用」这种矛盾。
 *
 * ## 判定依据
 *
 * 服务端下发的 `membership` 是**快照**（登录/刷新那一刻算的）。
 * 用户可能开着软件跨过到期时间，所以这里不能只看 `active`：
 * 必须再按本地时钟比一次 `expiresAt`。宁可多拦（用户可以重新登录刷新），
 * 不可漏放（那是白送会员）。
 *
 * ## 它不能替代服务端
 *
 * 这一层只决定**界面**。真正的硬闸门在 `account-worker`：
 * 兑换激活码、签发网关卡（内置模型）都在服务端按到期时间判。
 * 所以客户端被逆向、被改成本地判定通过，也换不出会员时长与模型凭证。
 */

import type { AccountUser, MembershipInfo } from "@/lib/account/types"

/** 需要会员才能使用的功能。名字即语义，新增会员功能时只在这里加一项。 */
export type MemberFeature =
  | "soul"
  | "bookAnalysis"
  | "storySimulation"
  | "modelSync"
  | "cloudBackup"

/** 功能名称，用于提示文案（「开通后可解锁：拆书库…」）。 */
export const MEMBER_FEATURE_LABELS: Record<MemberFeature, string> = {
  soul: "灵魂库",
  bookAnalysis: "拆书库",
  storySimulation: "剧情推演室",
  modelSync: "模型同步",
  cloudBackup: "云备份",
}

/**
 * 会员功能的完整清单（提示页、徽标、测试共用同一份顺序）。
 *
 * ## 2026-11-09：补进「云备份」
 *
 * 云备份**一直**是会员专属 —— `member-cloud-store.runBackup()` 里有
 * `isMembershipActive` 硬闸门，免费用户根本调不动。但它**没有被登记**
 * 在这份清单和 `MEMBER_BENEFITS`（买卡页文案）里，于是：
 *
 *   · 账号页写「4 项」，而用户实际被拦的是 5 项
 *   · 免费用户看不到「云备份」是会员功能，点进去才发现用不了
 *
 * 现在补上，「类型 / 清单 / 标签 / 买卡页 / 账号页」五处口径一致。
 *
 * ⚠️ 顺序有意义：把有**独立操作面板**的两项（云备份、模型同步）放前面，
 * 与账号页会员态的上下两张卡顺序对应；三个创作功能跟在其后。
 */
export const MEMBER_FEATURES: readonly MemberFeature[] = [
  "cloudBackup",
  "modelSync",
  "soul",
  "bookAnalysis",
  "storySimulation",
]

/** 正常开放、与会员无关的功能。写成常量是为了让「哪些不锁」有据可查。 */
export const FREE_FEATURES = ["chapters", "outlines"] as const

const EMPTY_MEMBERSHIP: MembershipInfo = {
  active: false,
  expiresAt: null,
  remainingDays: 0,
  planLabel: null,
  forever: false,
}

/** 从账号用户对象里取会员快照（缺字段一律按非会员）。 */
export function membershipOf(user: AccountUser | null | undefined): MembershipInfo {
  return user?.membership ?? EMPTY_MEMBERSHIP
}

/**
 * 会员此刻是否有效。
 *
 * 两个条件同时成立才算：
 *   1. 服务端说 active（说明它认识这个会员，不是本地编的）；
 *   2. 到期时间还没到（用本地时钟再核一次，覆盖「开着软件跨过到期点」）。
 *
 * 不用 `remainingDays` 判断：它是展示用的派生值，向上取整，
 * 会在最后一天跨过实到期时间。
 */
export function isMembershipActive(
  membership: MembershipInfo | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!membership || !membership.active) return false
  if (typeof membership.expiresAt !== "number") return false
  return membership.expiresAt * 1000 > now
}

/**
 * 某个功能此刻能不能用。
 *
 * 只有会员功能受会员限制；章节、大纲这些不在清单里的功能永远可用 ——
 * 写成「白名单判定」而不是「黑名单放行」，是怕以后新增功能时被无意锁死。
 */
export function canUseMemberFeature(
  feature: MemberFeature,
  user: AccountUser | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!MEMBER_FEATURES.includes(feature)) return true
  return isMembershipActive(membershipOf(user), now)
}

/**
 * 视图 → 会员功能的映射。
 *
 * 只列**整页**级的功能：侧栏图标、顶栏菜单与路由拦截都查这张表。
 * 模型同步不是一个视图（它在设置 › 账号里），所以不在表内。
 */
export const MEMBER_FEATURE_VIEWS: Partial<Record<string, MemberFeature>> = {
  soul: "soul",
  bookAnalysis: "bookAnalysis",
  storySimulation: "storySimulation",
}

/** 某个视图是否需要「该用户还没开通」的会员拦截（false 表示放行）。 */
export function isMemberLockedView(
  view: string | undefined | null,
  user: AccountUser | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!view) return false
  const feature = MEMBER_FEATURE_VIEWS[view]
  if (!feature) return false
  return !canUseMemberFeature(feature, user, now)
}

/**
 * 会员剩余天数的展示文案；非会员返回空串（调用方据此不显示这一行）。
 *
 * ## 换设备后的正确性（2026-11-07 用户要求：「换设备后剩多长时间就显示多长时间」）
 *
 * 关键在于**用哪一个 `now` 算**。`expiresAt` 是账号服务给的**绝对时间戳**，
 * 与设备无关：换到新设备登录，登录响应里拿到的是同一个 `expiresAt`；
 * 这里再用**本机当前时间**算差，得到的就是真实剩余时长。
 *
 * 所以所有调用点都必须传**实时 now**（`useMembership` 每 60 秒刷新一次），
 * 也不能把算好的字符串跨天复用 —— 那才会出现「换设备后显示的还是一周前的天数」。
 *
 * 向上取整：还剩 3 小时也显示「剩余 1 天」，不显示「剩余 0 天」——
 * 后者会被读成「已到期」。真正到期由 `isMembershipActive`（严格 > now）判定。
 */
export function memberRemainingLabel(
  membership: MembershipInfo | null | undefined,
  now: number = Date.now(),
): string {
  if (!isMembershipActive(membership, now)) return ""
  /*
   * 永久卡（2026-11-07）：显示「永不过期」，不显示天数。
   * 拿 expiresAt 硬算会得到「剩余 27000 天」——用户会以为软件算错了。
   */
  if (membership!.forever) return "永不过期"
  const expiresAt = membership!.expiresAt!
  const days = Math.max(1, Math.ceil((expiresAt * 1000 - now) / (24 * 60 * 60 * 1000)))
  return `剩余 ${days} 天`
}

/** 到期日的可读文案（本地时区，只到日）；永久卡返回空串，由调用方显示「永不过期」。 */
export function memberExpiryLabel(membership: MembershipInfo | null | undefined): string {
  if (!membership || typeof membership.expiresAt !== "number") return ""
  // 永久卡不展示某个具体日期：2099/12/31 这种「假到期日」只会让人困惑。
  if (membership.forever) return ""
  return new Date(membership.expiresAt * 1000).toLocaleDateString("zh-CN")
}
