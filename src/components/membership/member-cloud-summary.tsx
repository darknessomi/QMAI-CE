import { CloudUpload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatBytes } from "@/lib/qmai-sync/client"
import { useAccountStore } from "@/stores/account-store"
import { useMemberCloudStore } from "@/stores/member-cloud-store"
import { useSyncQuotaStore } from "@/stores/sync-quota-store"
import { useWikiStore } from "@/stores/wiki-store"

export function MemberCloudSummary({ onManage }: { onManage: () => void }) {
  const cloud = useMemberCloudStore()
  const quota = useSyncQuotaStore(s => s.quota)
  const session = useAccountStore(s => s.session)
  const projectPath = useWikiStore(s => s.project?.path)
  const owner = session ? JSON.stringify([session.baseUrl, session.user.id]) : null
  const current = cloud.backupContext?.owner === owner && cloud.backupContext?.projectPath === projectPath
  const failed = current && (Boolean(cloud.lastError) || Boolean(cloud.lastResult?.failed.length) || cloud.lastResult?.truncated)
  let feedback = projectPath ? "本次打开后，当前作品尚无备份结果。" : "打开作品后可查看备份结果。"
  if (current) {
    if (cloud.running && cloud.operation === "backup") feedback = "正在备份当前作品…"
    else if (cloud.lastError) feedback = "上次备份未完成，请进入管理查看原因。"
    else if (cloud.lastResult?.failed.length) feedback = `上次备份有 ${cloud.lastResult.failed.length} 个文件未上传，请进入管理查看。`
    else if (cloud.lastResult?.truncated) feedback = "上次备份达到文件数量上限，请进入管理查看。"
    else if (cloud.lastResult && cloud.lastBackupAt) feedback = "最近备份完成：" + new Date(cloud.lastBackupAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
  }
  return <section className="member-cloud-card" aria-label="云备份状态">
    <div className="member-cloud-summary"><CloudUpload size={19} aria-hidden="true" /><div><strong>自动云备份</strong>
      <p>{cloud.autoEnabled ? "已开启" : "未开启"} · {quota ? "已用 " + formatBytes(quota.usedBytes) + " / " + formatBytes(quota.limitBytes) : "云空间额度暂未获取"}</p></div>
      <button type="button" className="member-switch" role="switch" aria-label="自动云备份" aria-checked={cloud.autoEnabled} onClick={() => cloud.setAutoEnabled(!cloud.autoEnabled)}><span /></button>
    </div>
    <div className="member-backup-feedback"><p role="status" data-ui="member-backup-result" data-state={failed ? "failed" : "normal"}>{feedback}</p>
      <Button variant="link" size="sm" onClick={onManage}>管理云备份</Button></div>
  </section>
}
