import { useEffect } from "react"
import { memberExpiryLabel, memberRemainingLabel } from "@/lib/membership/access"
import { useMembership } from "@/lib/membership/use-membership"
import { formatBytes } from "@/lib/qmai-sync/client"
import { quotaLevel, remainingBytes, useSyncQuotaStore, usedRatio } from "@/stores/sync-quota-store"
import { useMemberCloudStore } from "@/stores/member-cloud-store"
import { VipBadge } from "./vip-badge"
import "./membership.css"

export function MembershipCard({ onOpen }: { onOpen: () => void }) {
  const { user, active, membership } = useMembership()
  const quota = useSyncQuotaStore(s => s.quota)
  const refreshQuota = useSyncQuotaStore(s => s.refresh)
  const autoEnabled = useMemberCloudStore(s => s.autoEnabled)
  useEffect(() => { if (user) void refreshQuota() }, [user, refreshQuota])
  if (!user) return null
  const expired = !active && !!membership.expiresAt
  const level = quotaLevel(quota)
  const percent = Math.round(usedRatio(quota) * 100)
  const expiry = memberExpiryLabel(membership)
  return <button type="button" role="menuitem" onClick={onOpen} data-ui="membership-card"
    data-state={active ? "active" : expired ? "expired" : "inactive"} data-level={active ? level : "ok"} className="membership-card">
    <span className="membership-card-heading">
      {active ? <VipBadge size="sm" /> : <span className="membership-status-label">{expired ? "已到期" : "免费版"}</span>}
      <strong>{active ? membership.planLabel ?? "会员" : expired ? "会员已到期" : "免费用户"}</strong>
      <span className="membership-card-action">{active ? "会员中心 ›" : expired ? "续费会员 ›" : "开通会员 ›"}</span>
    </span>
    {active && <span className="membership-card-validity"><strong>{memberRemainingLabel(membership)}</strong><span>{membership.forever ? "永久有效" : expiry + " 到期"}</span></span>}
    <span className="membership-card-cloud"><span>云备份</span><span>{active ? autoEnabled ? "自动备份已开启" : "自动备份未开启" : "未开通"}</span></span>
    {active ? quota && quota.limitBytes > 0 ? <>
      <span className="membership-card-cloud"><span>云空间</span><strong>{level === "full" ? "已满" : "剩 " + formatBytes(remainingBytes(quota))}</strong></span>
      <span className="membership-quota-track"><span style={{ width: Math.min(100, Math.max(quota.usedBytes > 0 ? 2 : 0, percent)) + "%" }} /></span>
      <span className="membership-card-detail">已用 {percent}% · 共 {formatBytes(quota.limitBytes)}{level === "warn" ? " · 快满了" : level === "full" ? " · 新的改动传不上去" : ""}</span>
    </> : <span className="membership-card-detail">云空间额度暂未获取</span>
      : <span className="membership-card-detail" data-ui="membership-card-free-space">会员可得 5 GB 云空间 · 5 项进阶权益</span>}
  </button>
}
