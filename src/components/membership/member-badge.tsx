/**
 * 「会员」小徽标。
 *
 * 用在三处：侧栏图标角标、顶栏「创作工具」菜单项后面、设置 › 账号的会员行。
 * 统一一个组件是为了三处长得一样 —— 用户要能一眼认出「这个标记 = 要会员」。
 *
 * ## 2026-11-08 改版：皇冠 → VIP 文字胶囊
 *
 * 原来用 `Crown` 图标。问题是：缩到侧栏 10px 的角标尺寸时，皇冠的三个尖
 * 会糊成一团，用户根本认不出是什么。改成「VIP」三个字母后，即使 8px 也能读出来。
 *
 * 视觉细节全部交给 `VipBadge`，这里只保留「按状态选色调」这一层语义：
 *   · `locked`（默认）：功能还没开通，灰金，表达「需要开通」；
 *   · `active`：会员本人看到，亮金，表达「你已拥有」。
 * 绝不用「锁 + 已开通」这种自相矛盾的组合。
 */

import { VipBadge } from "./vip-badge"

export type MemberBadgeTone = "locked" | "active"

interface MemberBadgeProps {
  tone?: MemberBadgeTone
  /**
   * 是否显示图标。
   *
   * @deprecated VIP 胶囊本身就是图形，没有可单独隐藏的图标了。
   * 保留这个 prop 只是为了让现有调用点（`withIcon={false}`）不用改签名。
   */
  withIcon?: boolean
  className?: string
  /** 悬浮提示的文案；默认按 tone 给出。 */
  title?: string
  /** 尺寸档位；默认小号，与侧栏角标一致。 */
  size?: "sm" | "md"
}

export function MemberBadge({
  tone = "locked",
  className = "",
  title,
  size = "sm",
}: MemberBadgeProps) {
  const locked = tone === "locked"
  return (
    <VipBadge
      size={size}
      muted={locked}
      className={className}
      title={title ?? (locked ? "这是会员功能，开通会员后可用" : "你是会员，这个功能已解锁")}
    />
  )
}
