import { useEffect, useState } from "react"
import QRCode from "qrcode"
import { Check, LoaderCircle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { PAY_POLL_INTERVAL_MS, PAY_POLL_MAX_MS } from "@/lib/account/pay-api"
import { MEMBER_FEATURES, MEMBER_FEATURE_LABELS, memberExpiryLabel, memberRemainingLabel, type MemberFeature } from "@/lib/membership/access"
import { PLAN_DISPLAYS } from "@/lib/membership/purchase-channels"
import { useMembership } from "@/lib/membership/use-membership"
import { openExternalUrl } from "@/lib/open-external-url"
import { useAccountStore } from "@/stores/account-store"
import { hasUnsettledOrder, membershipReturnFocus, useMembershipPurchaseStore } from "@/stores/membership-purchase-store"
import { useSyncQuotaStore } from "@/stores/sync-quota-store"
import { useWikiStore } from "@/stores/wiki-store"
import { ActivationCodeForm } from "./activation-code-form"
import { MemberBenefits, MemberCheckout, MemberPurchaseOptions } from "./member-purchase-options"
import { MemberCloudSummary } from "./member-cloud-summary"
import { VipBadge } from "./vip-badge"
import "./membership.css"

/** 唯一挂在外壳的会员中心：切换功能或解锁页面时不会销毁支付结果。 */
export function MemberPurchaseDialog() {
  const state = useMembershipPurchaseStore()
  const { user, active, membership } = useMembership()
  const [qr, setQr] = useState("")
  const [qrError, setQrError] = useState(false)
  const [qrRetry, setQrRetry] = useState(0)
  const [linkError, setLinkError] = useState("")
  const [pollPaused, setPollPaused] = useState(false)
  const [clock, setClock] = useState(Date.now)
  const [renewing, setRenewing] = useState(false)
  const { order, open, view, check, syncAccount } = state
  const expiredByClock = order?.status === "pending" && !!order.expiresAt && clock >= order.expiresAt
  const remainingSeconds = Math.max(0, Math.ceil(((order?.expiresAt ?? clock) - clock) / 1000))
  const showPlans = !active || ((renewing || hasUnsettledOrder(order)) && !membership.forever)
  const daysLeft = membership.expiresAt ? Math.ceil((membership.expiresAt * 1000 - clock) / 86400000) : null

  useEffect(() => {
    syncAccount()
    return useAccountStore.subscribe(() => syncAccount())
  }, [syncAccount])
  useEffect(() => {
    if (open && active) void useSyncQuotaStore.getState().refresh()
  }, [open, active])
  useEffect(() => { if (open) setRenewing(!!state.preferredPayType) }, [open, state.owner, state.preferredPayType])
  useEffect(() => {
    let cancelled = false
    setQr(""); setQrError(false); setLinkError("")
    if (order?.qrCode && order.status === "pending") {
      if (order.qrCode.startsWith("data:image/")) setQr(order.qrCode)
      else void QRCode.toDataURL(order.qrCode, { width: 240, margin: 1, errorCorrectionLevel: "M" })
        .then(value => { if (!cancelled) setQr(value) })
        .catch(() => { if (!cancelled) setQrError(true) })
    }
    return () => { cancelled = true }
  }, [order?.outTradeNo, order?.qrCode, order?.status, qrRetry])
  useEffect(() => {
    setPollPaused(false)
    setClock(Date.now())
    if (!open || !hasUnsettledOrder(order)) return
    const startedAt = Date.now()
    let lastCheckAt = startedAt
    let deadlineChecked = false
    void check()
    const timer = setInterval(() => {
      const now = Date.now()
      setClock(now)
      if (order?.status === "pending" && order.expiresAt && now >= order.expiresAt) {
        if (!deadlineChecked) { deadlineChecked = true; setPollPaused(false); void check() }
        clearInterval(timer)
        // 倒计时只影响支付展示，不能自行把订单改成过期或允许再次付款。
        return
      }
      if (now - startedAt >= PAY_POLL_MAX_MS) { setPollPaused(true); if (!order?.expiresAt || order.status === "granted") clearInterval(timer); return }
      if (now - lastCheckAt >= PAY_POLL_INTERVAL_MS) { lastCheckAt = now; void check() }
    }, 1000)
    return () => clearInterval(timer)
  }, [open, order?.outTradeNo, order?.status, order?.membershipUpdated, order?.expiresAt, check])

  const completed = order?.membershipUpdated === true
  const channel = order?.payType === "wxpay" ? "微信" : "支付宝"
  const expiry = memberExpiryLabel(membership)
  const title = view === "plans" ? "会员中心" : state.creating ? "正在创建订单" : completed ? order?.historical ? "历史订单已完成" : "会员权益已更新"
    : order?.status === "granted" ? "正在更新会员权益" : order?.status === "expired" ? "订单已过期"
    : order?.status === "failed" ? "订单未完成" : expiredByClock ? "确认订单状态" : order?.restored ? "恢复订单查询" : order ? channel + "扫码支付" : "订单未创建"
  function useFeature(feature: MemberFeature) {
    state.close()
    const wiki = useWikiStore.getState()
    if (feature === "cloudBackup" || feature === "modelSync") {
      wiki.setActiveSettingsCategory(feature === "cloudBackup" ? "memberCloud" : "account")
      wiki.setActiveView("settings")
    } else wiki.setActiveView(feature)
  }
  async function openPayment() {
    const url = order?.payUrl || order?.urlScheme
    if (!url) return
    setLinkError("")
    try { await openExternalUrl(url) } catch { setLinkError("暂时无法打开支付页面，请使用二维码或稍后重试。") }
  }
  return <Dialog open={open} onOpenChange={value => { if (!value) state.close() }}>
    <DialogContent className="member-center-dialog" data-ui="member-center-dialog" data-pay-type={order?.payType}
      finalFocus={membershipReturnFocus}>
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>
        {view === "plans" ? "权益、有效期与开通方式，在这里统一管理。" : completed ? order?.historical ? "这笔订单的权益已发放，当前会员有效期已结束。" : "会员状态已同步到当前账号。" : "订单与当前账号绑定，可从会员入口继续查询付款结果。"}
      </DialogDescription></DialogHeader>
      <div className="member-center-body">
        {view === "plans" ? <>
          <div className="member-identity" data-state={active ? "active" : membership.expiresAt ? "expired" : "inactive"}>
            <div>{active ? <VipBadge /> : <span className="membership-status-label">{membership.expiresAt ? "已到期" : "免费版"}</span>}<strong>{user?.displayName || "我的账号"}</strong><span>{active ? membership.planLabel || "会员" : membership.expiresAt ? "会员已到期" : "免费用户"}</span></div>
            {active ? <p><strong>{memberRemainingLabel(membership)}</strong><span>{membership.forever ? "永久有效" : expiry + " 到期"}</span></p>
              : <p>{membership.expiresAt ? `${expiry} 已到期，续费后恢复 5 项会员权益。` : "章节与大纲始终免费，会员提供 5 项进阶权益。"}</p>}
          </div>
          {active ? <>
            <MemberCloudSummary onManage={() => useFeature("cloudBackup")} />
            <section className="member-owned-benefits" aria-label="我的会员权益"><div className="member-section-heading"><strong>我的会员权益</strong><span>已开通 5 项</span></div><MemberBenefits onUse={useFeature} /></section>
            <details className="member-details"><summary>查看权益说明</summary><MemberBenefits /></details>
            {membership.forever ? <p className="member-note">您已是永久会员，无需续费。</p> : <div className="member-renewal-entry">
              <div><strong>{daysLeft !== null && daysLeft <= 7 ? "会员即将到期" : "按需续费"}</strong><p>续费时保留当前剩余时长。</p></div>
              <Button variant="outline" size="sm" aria-expanded={renewing} aria-controls="member-renewal-options" onClick={() => setRenewing(value => !value)}>{renewing ? "收起续费套餐" : "续费会员"}</Button>
            </div>}
          </> : <details className="member-details member-free-details"><summary><span>{MEMBER_FEATURES.map(feature => MEMBER_FEATURE_LABELS[feature]).join(" · ")}</span><span>查看权益详情</span></summary><MemberBenefits /></details>}
          {showPlans && <div id="member-renewal-options"><MemberPurchaseOptions feature={state.origin ?? undefined} hideCheckout /></div>}
          {order && !hasUnsettledOrder(order) && <div className="member-recent-order"><span>最近订单 · {order.historical ? "历史订单已完成" : order.membershipUpdated ? "权益已到账" : order.status === "expired" ? "已过期" : "未完成"}</span><Button variant="link" size="sm" onClick={state.showOrder}>查看结果</Button></div>}
          <details className="member-details member-redeem"><summary>已有兑换码</summary><ActivationCodeForm /></details>
        </> : <>
          {state.creating ? <div className="member-order-status" role="status"><LoaderCircle className="animate-spin" size={30} /><strong>正在准备支付信息…</strong><p>请稍候，无需重复点击。</p></div>
            : order ? <>
              <div className="member-order-meta"><span>{PLAN_DISPLAYS.find(p => p.id === order.plan)?.name} · {channel}支付</span><strong>¥{order.amount || "—"}</strong><small>订单金额</small></div>
              {completed ? <div className="member-order-status is-success" role="status"><Check size={30} /><strong>{order.historical ? "这笔订单已完成" : memberRemainingLabel(membership)}</strong><p>{order.historical ? `当前会员已于 ${expiry} 到期，可返回会员中心续费。` : membership.forever ? "永久有效" : expiry + " 到期"}</p></div>
                : order.status === "pending" ? <div className="member-qr-area">
                  {expiredByClock ? <div className="member-order-status" role="status"><strong>支付有效时间已结束</strong><p>正在核实最终状态。若仍未确认，请重新查询；付款结果以服务端为准。</p></div>
                    : order.restored ? <div className="member-order-status" role="status"><strong>已恢复上次未完成订单</strong><p>可查询付款结果；本机不保存支付二维码。如尚未付款，可在原支付页面继续，或待订单确认过期后重新选择。</p></div>
                    : qr && !qrError ? <img src={qr} width={220} height={220} alt={channel + "支付二维码"} onError={() => setQrError(true)} />
                    : <div className="member-qr-placeholder" role="status">{qrError ? "二维码暂时无法显示" : order.qrCode ? "正在生成二维码…" : "请通过支付页面完成付款"}</div>}
                  {!expiredByClock && !order.restored && <>
                    {qrError && <Button variant="outline" size="sm" onClick={() => setQrRetry(v => v + 1)}>重新加载二维码</Button>}
                    <p>请使用{channel}扫码，付款后自动查询结果。</p>
                    {(order.payUrl || order.urlScheme) && <Button variant="link" onClick={() => void openPayment()}>打开{channel}支付页面</Button>}
                    {!order.qrCode && !order.payUrl && !order.urlScheme && <p role="alert">支付信息暂不可用，请先查询订单状态，避免重复下单。</p>}
                  </>}
                  {!expiredByClock && order.expiresAt && <p className="member-order-countdown" data-ui="member-order-countdown">支付剩余时间 <strong>{Math.floor(remainingSeconds / 60).toString().padStart(2, "0")}:{(remainingSeconds % 60).toString().padStart(2, "0")}</strong></p>}
                  {!order.expiresAt && <p>有效时间以支付页面和订单查询结果为准。</p>}
                </div> : <div className="member-order-status" role="status">
                  {order.status === "granted" && <LoaderCircle className="animate-spin" size={30} />}
                  <strong>{order.status === "granted" ? "付款已确认，正在同步账号权益" : order.status === "expired" ? "二维码已失效" : "支付未完成"}</strong>
                  <p>{order.status === "granted" ? "无需再次付款，可重新查询会员状态。" : "如您已付款，请先重新查询；未付款可更换方案。"}</p>
                </div>}
              <p className="member-order-number">创建于 {new Date(order.createdAt).toLocaleString("zh-CN")}<br />订单号：{order.outTradeNo}</p>
            </> : null}
          {(state.error || linkError) && <p className="member-error" role="alert">{state.error || linkError}</p>}
          {pollPaused && !completed && <p className="member-note" role="status">自动查询已暂停，您可以点击重新查询。订单有效性以查询结果为准。</p>}
          {state.storageError && <p className="member-error" role="status">本机暂时无法保存订单查询信息，请保留上方订单号，关闭软件前先确认付款结果。</p>}
          {order?.status === "pending" && <p className="member-fine-print">关闭窗口不会取消订单。当前订单确认完成或过期后，才能更换套餐和支付方式。</p>}
        </>}
      </div>
      <div className="member-center-footer">
        {view === "plans" ? showPlans ? <MemberCheckout feature={state.origin ?? undefined} /> : <Button variant="outline" onClick={state.close}>完成</Button>
          : <div className="member-order-actions">
            {completed ? order?.historical ? <Button onClick={() => state.show()}>返回会员中心</Button> : <Button onClick={() => state.origin ? useFeature(state.origin) : state.close()}>{state.origin ? "返回" + MEMBER_FEATURE_LABELS[state.origin] : "完成"}</Button> : <>
              {order && <Button disabled={state.checking} onClick={() => void check()}><RefreshCw size={15} className={state.checking ? "animate-spin" : ""} />{state.checking ? "正在查询…" : "重新查询支付结果"}</Button>}
              <Button variant="outline" disabled={state.creating || state.checking} onClick={() => void state.showPlans()}>{hasUnsettledOrder(order) ? "查看套餐（暂不可更换）" : "重新选择套餐"}</Button>
            </>}
          </div>}
      </div>
    </DialogContent>
  </Dialog>
}
