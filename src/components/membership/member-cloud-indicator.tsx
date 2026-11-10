/**
 * 右上角的会员云同步图标。
 *
 * ## 为什么要有这个图标
 *
 * 用户 2026-11-08 的原话：「针对会员的云同步，需要在右上角有一个专门的云同步
 * 图标，用于显示专门的备份内容」。
 *
 * 之前的问题是：会员云空间只能从「设置 › 会员云空间」进，用户不知道它是否
 * 在工作、有没有失败。同步失败时更是只有翻日志才知道。
 *
 * 这个图标把三件事变成「扫一眼就知道」：
 *   · 正在备份 → 呼吸动画
 *   · 有文件没传上去 → 变红 + 角标数字
 *   · 一切正常 → 静默的云
 *
 * ## 与右边那个云图标的区别
 *
 * 右边已有的 `CloudSyncIndicator` 是「同步到你自己的网盘」（GitHub / WebDAV 等），
 * 数据在用户自己的盘里。这个图标是「备份到青幕服务器」，用的是会员空间配额。
 * 两者是两套完全独立的功能，所以给两个图标，不合并。
 *
 * ## 什么时候不显示
 *
 *   · 未登录 —— 没有账号就没有云空间
 *   · 云同步插件被关闭 —— 用户明确表示不要这个功能（见 builtin.ts 的 cloud-sync）
 *
 * 这两种情况都不渲染，而不是渲染成灰色禁用态：占着位置却不给用，
 * 只会让用户反复点它。
 */

import { useEffect, useState } from "react"
import { Check, Cloud, CloudUpload } from "lucide-react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ensureProjectId } from "@/lib/project-identity"
import { useAccountStore } from "@/stores/account-store"
import { memberCloudOwnerKey, readFailedUploads, useMemberCloudStore, type FailedUpload } from "@/stores/member-cloud-store"
import { useWikiStore } from "@/stores/wiki-store"

export function MemberCloudIndicator() {
  const session = useAccountStore((s) => s.session)

  const running = useMemberCloudStore((s) => s.running)
  const lastRunAt = useMemberCloudStore((s) => s.lastRunAt)
  const lastResult = useMemberCloudStore((s) => s.lastResult)

  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setActiveSettingsCategory = useWikiStore((s) => s.setActiveSettingsCategory)
  const projectPath = useWikiStore((s) => s.project?.path ?? null)

  const [persistedFailed, setPersistedFailed] = useState<FailedUpload[]>([])
  const [persistedContext, setPersistedContext] = useState<string | null>(null)
  const context = JSON.stringify([memberCloudOwnerKey(session), projectPath])
  /** 成功后短暂显示对勾，2 秒后回落成常态云 */
  const [justSucceeded, setJustSucceeded] = useState(false)

  /*
   * 读落盘的失败清单。
   *
   * `lastResult` 关掉软件就没了，而「哪几个文件没传上去」必须跨重启可见 ——
   * 否则用户第二天打开软件，角标数字消失，就以为已经好了。
   */
  useEffect(() => {
    setPersistedFailed([])
    const owner = memberCloudOwnerKey(session)
    if (!projectPath) {
      setPersistedFailed([])
      return
    }
    let cancelled = false
    void ensureProjectId(projectPath)
      .then((projectId) => {
        if (!cancelled) {
          setPersistedFailed(readFailedUploads(projectId, owner))
          setPersistedContext(context)
        }
      })
      .catch(() => {
        if (!cancelled) setPersistedFailed([])
      })
    return () => {
      cancelled = true
    }
  }, [projectPath, lastRunAt, session, context])

  /*
   * 刚跑完且没有失败 → 亮 2 秒对勾。
   *
   * 只在「确实传了东西」时亮：`uploaded === 0` 说明这次没变化，
   * 每次都闪一下对勾会变成噪音，用户很快就不再相信这个信号。
   */
  useEffect(() => {
    if (!lastRunAt || !lastResult) return
    if (lastResult.failed.length > 0 || lastResult.uploaded === 0) return
    setJustSucceeded(true)
    const timer = setTimeout(() => setJustSucceeded(false), 2_000)
    return () => clearTimeout(timer)
  }, [lastRunAt, lastResult])

  /*
   * 只判登录。
   *
   * ⚠️ 这里**不**判 `cloud-sync` 插件开关：那个插件管的是「同步到用户自己的
   * 网盘」，与会员云空间毫无关系。第一版我把两者混在一起，用户明确纠正过 ——
   * 「会员云空间是不能删除的……两者没有任何关系」。
   */
  if (!session) return null

  const failedItems =
    lastResult && lastResult.failed.length > 0 ? lastResult.failed : persistedContext === context ? persistedFailed : []
  const hasFailure = failedItems.length > 0

  const openMemberCloud = () => {
    setActiveView("settings")
    setActiveSettingsCategory("memberCloud")
  }

  const label = running
    ? "正在备份到云空间…"
    : hasFailure
      ? `云同步：${failedItems.length} 个文件没传上去，点击查看`
      : justSucceeded
        ? "云同步：备份完成"
        : "云同步空间"

  const Icon = justSucceeded && !running && !hasFailure ? Check : running ? CloudUpload : Cloud

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-ui="member-cloud-indicator"
            data-state={running ? "running" : hasFailure ? "failed" : justSucceeded ? "success" : "idle"}
            className={`ui-test-icon-btn relative${hasFailure ? " text-destructive" : ""}`}
            aria-label={label}
            title={label}
            onClick={openMemberCloud}
          >
            <Icon className={running ? "animate-pulse" : undefined} />
            {/* 失败角标：数字比一个红点更能说明「有几件事没做完」 */}
            {hasFailure ? (
              <span
                className="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-destructive px-1 text-[0.5625rem] font-bold leading-none text-white"
                aria-hidden="true"
              >
                {failedItems.length > 99 ? "99+" : failedItems.length}
              </span>
            ) : null}
          </button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
