import { Button } from "@/components/ui/button"
import { MemberBenefits } from "@/components/membership/member-purchase-options"
import { VipBadge } from "@/components/membership/vip-badge"
import { useMembershipPurchaseStore } from "@/stores/membership-purchase-store"

export function AccountBenefitsFree() {
  const show = useMembershipPurchaseStore(s => s.show)
  return <section className="member-account-benefits" data-ui="account-benefits-free">
    <div className="member-section-heading"><strong><VipBadge muted /> 会员专属功能</strong><span>共 5 项</span></div>
    <MemberBenefits />
    <div className="member-account-cta" data-ui="account-benefits-cta"><div><strong>解锁完整的创作工具</strong><p>章节与大纲始终免费 · 支持微信、支付宝</p></div>
      <Button onClick={() => show()} data-ui="account-open-purchase">开通会员</Button>
    </div>
  </section>
}
