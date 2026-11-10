import { useState } from "react"
import { Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MEMBER_FEATURE_LABELS, isMembershipActive, membershipOf, type MemberFeature } from "@/lib/membership/access"
import { useAccountStore } from "@/stores/account-store"
import { useMembershipPurchaseStore } from "@/stores/membership-purchase-store"
import { MemberBenefits, MemberPurchaseOptions } from "./member-purchase-options"
import { VipBadge } from "./vip-badge"
import "./membership.css"

export function MemberGateNotice({ feature }: { feature: MemberFeature }) {
  const loggedIn = useAccountStore(s => Boolean(s.session))
  const refresh = useAccountStore(s => s.refreshMembership)
  const [refreshing, setRefreshing] = useState(false)
  const [feedback, setFeedback] = useState("")
  async function refreshStatus() {
    setRefreshing(true)
    try {
      const refreshed = await refresh()
      setFeedback(!refreshed ? "暂时无法读取会员状态，请稍后重试。"
        : isMembershipActive(membershipOf(useAccountStore.getState().user)) ? "会员已生效，可以继续使用当前功能。" : "当前账号还没有有效会员。如已付款，请到会员中心查询订单。")
    }
    catch { setFeedback("暂时无法读取会员状态，请稍后重试。") }
    finally { setRefreshing(false) }
  }
  return <section className="member-gate" data-ui="member-gate-notice" data-ui-page="member-gate">
    <div className="member-gate-inner">
      <header className="member-gate-header">
        <div className="member-gate-icon"><Sparkles size={23} aria-hidden="true" /></div>
        <div><div className="member-eyebrow"><VipBadge muted /> 会员专属创作空间</div>
          <h1>{MEMBER_FEATURE_LABELS[feature]}</h1>
          <p>让积累成为下一次创作的起点。开通会员后，即可使用当前功能与全部会员权益。</p>
        </div>
      </header>
      <div className="member-gate-grid">
        <section className="member-gate-benefits"><div className="member-section-heading"><strong>会员权益</strong><span>覆盖创作与云端</span></div>
          <MemberBenefits feature={feature} />
          <p className="member-note">章节与大纲始终免费，基础写作不受会员状态影响。</p>
        </section>
        <div><MemberPurchaseOptions feature={feature} />
          <div className="member-gate-footer">
            {loggedIn ? <Button variant="ghost" size="sm" disabled={refreshing} onClick={() => void refreshStatus()}>{refreshing ? "正在读取…" : "已开通？刷新会员状态"}</Button>
              : <Button variant="ghost" size="sm" onClick={() => useMembershipPurchaseStore.getState().show(feature)}>已有账号？登录后开通</Button>}
            <span role="status">{feedback}</span>
          </div>
        </div>
      </div>
    </div>
  </section>
}
