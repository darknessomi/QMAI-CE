/**
 * VIP 文字徽标。
 *
 * ## 为什么用文字胶囊而不是皇冠图标
 *
 * 皇冠是「猜」—— 用户要看到形状才反应过来这是什么。而「VIP」三个字母
 * 在任何语言、任何尺寸下都直接可读，侧栏 14px 的小角标尤其明显：
 * 皇冠缩到 10px 就糊成一团，VIP 仍然认得出。
 *
 * ## 金色为什么用三层渐变
 *
 * 单色金（比如 #e0a83a）在浅色背景上会「发飘」，看不出是金属。
 * 顶部高光 + 中段主色 + 底部暗金的三段式，才让它看起来像一块牌子。
 * 顶部再加一道 1px 白色内阴影，模拟金属反光。
 *
 * ## 尺寸档位
 *
 * 只有三档，且高度都写死 —— 让徽标在任意容器里都不被拉伸变形。
 */

export type VipBadgeSize = "sm" | "md" | "lg"

/** 各档位的高度与字号（px） */
const SIZE_STYLE: Record<VipBadgeSize, { height: number; padding: string; fontSize: number; radius: number; letter: string }> = {
  sm: { height: 14, padding: "0 4px", fontSize: 8, radius: 3, letter: "0.08em" },
  md: { height: 17, padding: "0 6px", fontSize: 9.5, radius: 4, letter: "0.1em" },
  lg: { height: 21, padding: "0 8px", fontSize: 11, radius: 5, letter: "0.12em" },
}

export interface VipBadgeProps {
  size?: VipBadgeSize
  /**
   * 未激活/未开通时用灰金。
   *
   * 不是「禁用」语义，而是「这个功能有会员要求，但你还没满足」——
   * 亮金色会让人以为已经拥有，灰金才不会误导。
   */
  muted?: boolean
  className?: string
  /** 悬浮提示；不传时按 muted 给默认文案 */
  title?: string
}

export function VipBadge({ size = "md", muted = false, className = "", title }: VipBadgeProps) {
  const s = SIZE_STYLE[size]

  return (
    <span
      data-ui="vip-badge"
      data-size={size}
      data-muted={muted ? "true" : "false"}
      title={title ?? (muted ? "这是会员功能，开通后可用" : "青幕 VIP 会员")}
      aria-label={muted ? "VIP 会员功能" : "VIP 会员"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        height: `${s.height}px`,
        padding: s.padding,
        borderRadius: `${s.radius}px`,
        fontSize: `${s.fontSize}px`,
        fontWeight: 800,
        letterSpacing: s.letter,
        lineHeight: 1,
        flexShrink: 0,
        userSelect: "none",
        color: muted ? "var(--ui-gold, #835c27)" : "var(--ui-vip-ink, #624312)",
        background: muted ? "var(--ui-gold-bg, #f7f0df)" : "var(--ui-vip-bg, #dcc18a)",
        border: "1px solid var(--ui-gold-line, #cfb377)",
      }}
      className={className}
    >
      VIP
    </span>
  )
}
