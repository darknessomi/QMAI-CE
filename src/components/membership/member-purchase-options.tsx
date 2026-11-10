import { BookOpen, CloudUpload, Drama, Sparkles, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MEMBER_FEATURES, MEMBER_FEATURE_LABELS, type MemberFeature } from "@/lib/membership/access"
import { PLAN_DISPLAYS, SINGLE_DEVICE_NOTE } from "@/lib/membership/purchase-channels"
import { useMembership } from "@/lib/membership/use-membership"
import { hasUnsettledOrder, useMembershipPurchaseStore } from "@/stores/membership-purchase-store"
import type { PayPlanId } from "@/lib/account/pay-api"
import type { MembershipInfo } from "@/lib/account/types"

const FEATURES = {
  soul: { icon: Sparkles, text: "沉淀角色、世界观与文风，写作时随时调用。" },
  bookAnalysis: { icon: BookOpen, text: "拆解参考书的结构、节奏与人物，积累创作素材。" },
  storySimulation: { icon: Drama, text: "动笔前试演剧情走向，提前发现逻辑与冲突问题。" },
  modelSync: { icon: Zap, text: "加密同步模型配置，换设备后继续使用。" },
  cloudBackup: { icon: CloudUpload, text: "开启自动备份后，作品保存到云端，会员云空间 5 GB。" },
} satisfies Record<MemberFeature, { icon: typeof Sparkles; text: string }>

export const PLAN_DAYS: Record<PayPlanId, number> = { month: 30, quarter: 90, year: 365 }

export function renewalDate(membership: MembershipInfo, plan: PayPlanId, now = Date.now()): string {
  const from = Math.max(now, (membership.expiresAt ?? 0) * 1000)
  return new Date(from + PLAN_DAYS[plan] * 86400000).toLocaleDateString("zh-CN")
}

export function MemberBenefits({ feature, onUse }: { feature?: MemberFeature; onUse?: (feature: MemberFeature) => void }) {
  return <div className="member-benefits" data-ui="member-benefits">
    {MEMBER_FEATURES.map((item) => {
      const Icon = FEATURES[item].icon
      return <div className={`member-benefit${item === feature ? " is-current" : ""}`} data-ui={`member-feature-${item}`} key={item}>
        <Icon size={17} aria-hidden="true" />
        <div><strong>{MEMBER_FEATURE_LABELS[item]}</strong>{!onUse && <p>{FEATURES[item].text}</p>}</div>
        {item === feature && <span className="member-current-label">当前功能</span>}
        {onUse && <Button variant="ghost" size="sm" aria-label={"打开" + MEMBER_FEATURE_LABELS[item]} onClick={() => onUse(item)}>打开</Button>}
      </div>
    })}
  </div>
}

export function MemberPurchaseOptions({ feature, hideCheckout = false }: { feature?: MemberFeature; hideCheckout?: boolean }) {
  const { active, membership } = useMembership()
  const plan = useMembershipPurchaseStore(s => s.plan)
  const order = useMembershipPurchaseStore(s => s.order)
  const busy = useMembershipPurchaseStore(s => s.creating || s.checking)
  const selectPlan = useMembershipPurchaseStore(s => s.selectPlan)
  const show = useMembershipPurchaseStore(s => s.show)
  const pending = hasUnsettledOrder(order)
  if (active && membership.forever) return <div className="member-note">您已是永久会员，无需续费。</div>
  return <section className="member-purchase-options" data-ui="member-purchase-box">
    <div className="member-section-heading"><strong>{active || membership.expiresAt ? "续费会员" : "选择会员套餐"}</strong><span>{active ? "剩余时长继续保留" : "一次开通，解锁 5 项权益"}</span></div>
    {pending && <div className="member-pending-banner" role="status">
      <div><strong>{order?.status === "granted" ? "有一笔付款正在更新权益" : "有一笔待确认订单"}</strong><p>当前暂不能更换套餐或支付方式，请先查询订单结果。</p></div>
      <Button variant="outline" size="sm" onClick={() => show(feature)}>查看订单</Button>
    </div>}
    <div className="member-plan-grid" data-ui="member-plan-cards" role="group" aria-label="会员套餐">
      {PLAN_DISPLAYS.map(item => <button type="button" key={item.id} data-ui={`member-plan-${item.id}`}
        className="member-plan" aria-pressed={plan === item.id} disabled={pending || busy} onClick={() => selectPlan(item.id)}>
        <span>{item.name}</span><strong><small>¥</small>{item.price}</strong><span>{PLAN_DAYS[item.id]} 天会员</span>
        <span className="member-plan-check" aria-hidden="true">{plan === item.id ? "✓" : ""}</span>
      </button>)}
    </div>
    {!hideCheckout && <MemberCheckout feature={feature} />}
    <p className="member-fine-print">展示价格供选择参考，实付金额以生成的订单为准。{SINGLE_DEVICE_NOTE}</p>
  </section>
}

export function MemberCheckout({ feature }: { feature?: MemberFeature }) {
  const { active, membership } = useMembership()
  const plan = useMembershipPurchaseStore(s => s.plan)
  const pending = useMembershipPurchaseStore(s => hasUnsettledOrder(s.order))
  const busy = useMembershipPurchaseStore(s => s.creating || s.checking)
  const begin = useMembershipPurchaseStore(s => s.begin)
  const preferredPayType = useMembershipPurchaseStore(s => s.preferredPayType)
  const selected = PLAN_DISPLAYS.find(p => p.id === plan)!
  return <div>
    {preferredPayType && <p className="member-resume-note" role="status">已保留所选套餐与{preferredPayType === "wxpay" ? "微信" : "支付宝"}支付方式，请确认后继续付款。</p>}
    <div className="member-checkout" data-ui="member-checkout">
      <div><span>{selected.name} · {PLAN_DAYS[plan]} 天</span><strong>¥{selected.price.toFixed(2)}</strong>
        <p>{active ? `预计续费至 ${renewalDate(membership, plan)}` : "付款确认后，权益同步至当前账号"}</p>
      </div>
      <div className="member-payment-methods">
        <Button variant={preferredPayType === "alipay" ? "outline" : "default"} data-ui="member-pay-wxpay" disabled={pending || busy} onClick={() => void begin("wxpay", feature)}><span className="member-pay-dot is-wechat" aria-hidden="true" />微信支付</Button>
        <Button variant={preferredPayType === "alipay" ? "default" : "outline"} data-ui="member-pay-alipay" disabled={pending || busy} onClick={() => void begin("alipay", feature)}><span className="member-pay-dot is-alipay" aria-hidden="true" />支付宝</Button>
      </div>
    </div>
  </div>
}
