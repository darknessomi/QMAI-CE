/**
 * 设置 → 会员云空间。
 *
 * ## 与「云同步」的区别（用户最容易混淆的一点）
 *
 * 设置里已经有一个「云同步」，那个是把作品同步到**用户自己的**网盘
 * （GitHub / 百度网盘 / WebDAV），凭证是用户自己的。
 *
 * 这里是把作品备份到**我们的服务器**，用的是会员凭证（网关卡），
 * 空间按会员等级分配。两个功能并存，不互相替代。
 *
 * ## 自动同步只传改动过的文件
 *
 * 每次保存后 8 秒触发一次，但**不会重传整个工程** —— 靠
 * `member-cloud-store` 里按工程保存的清单（路径 → 大小 + 修改时间）判断
 * 哪些文件真的变了。否则一个上百文件的工程，每次保存都要传上百次请求。
 *
 * 恢复保留原文件，需要下载的同名云端内容存入独立恢复目录。
 */

import { useCallback, useEffect, useState } from "react"
import { CloudDownload, CloudUpload, FileText, HardDrive } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useAccountStore } from "@/stores/account-store"
import { useWikiStore } from "@/stores/wiki-store"
import {
  memberCloudOwnerKey,
  readFailedUploads,
  useMemberCloudStore,
  type FailedUpload,
} from "@/stores/member-cloud-store"
import { ensureProjectId } from "@/lib/project-identity"
import { MemberCloudLogDialog } from "./member-cloud-log-dialog"
import { netcardOf } from "@/lib/builtin-models/netcard"
import { resolveSyncBaseUrl } from "@/lib/builtin-models/relay-endpoints"
import { gatewayFetchQuota, type GatewayQuota } from "@/lib/builtin-models/gateway-api"
import { formatBytes } from "@/lib/qmai-sync/client"
import { useSyncQuotaStore } from "@/stores/sync-quota-store"
import { SyncQuotaRing } from "@/components/membership/sync-quota"


/**
 * 内置模型今日额度条。
 *
 * 与上面的云空间配额分开显示：那个是「备份文件占多少盘」，这个是
 * 「今天还能调多少次模型」。混在一起用户会以为是同一件事。
 *
 * 免费档额外给一句升级提示 —— 3 万 token 用几次就见底，
 * 不提示的话用户会以为是软件坏了。
 */
function TokenQuotaBar({ quota }: { quota: GatewayQuota }) {
  const ratio = quota.tokensLimit > 0 ? Math.min(1, quota.tokensUsed / quota.tokensLimit) : 0
  const percent = Math.round(ratio * 100)
  const low = quota.tokensRemaining <= 0
  const nearLow = !low && quota.tokensRemaining < quota.tokensLimit * 0.2

  const fmt = (n: number) => {
    if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`
    return String(n)
  }

  return (
    <div className="space-y-1.5" data-ui="token-quota">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">内置模型 · 今日额度</span>
        <span className="tabular-nums text-muted-foreground">
          {fmt(quota.tokensUsed)} / {fmt(quota.tokensLimit)} token
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${
            low ? "bg-destructive" : nearLow ? "bg-amber-500" : "bg-primary"
          }`}
          style={{ width: `${Math.max(percent, quota.tokensUsed > 0 ? 2 : 0)}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {low
            ? "今日额度已用完，明天 0 点自动恢复。"
            : `剩余 ${fmt(quota.tokensRemaining)} token`}
          {quota.requestsLimit > 0 ? `（今日已用 ${quota.requestsUsed}/${quota.requestsLimit} 次）` : ""}
        </span>
        {quota.tier === "free" ? (
          <span className="text-amber-600 dark:text-amber-400">开通会员可提升至 100 万/天</span>
        ) : null}
      </div>
    </div>
  )
}

export function MemberCloudSection() {
  const session = useAccountStore((state) => state.session)
  const projectPath = useWikiStore((state) => state.project?.path ?? null)
  const projectName = useWikiStore((state) => state.project?.name ?? "")

  const autoEnabled = useMemberCloudStore((s) => s.autoEnabled)
  const setAutoEnabled = useMemberCloudStore((s) => s.setAutoEnabled)
  const running = useMemberCloudStore((s) => s.running)
  const lastRunAt = useMemberCloudStore((s) => s.lastRunAt)
  const lastResult = useMemberCloudStore((s) => s.lastResult)
  const lastError = useMemberCloudStore((s) => s.lastError)
  const runBackup = useMemberCloudStore((s) => s.runBackup)
  const runRestore = useMemberCloudStore((s) => s.runRestore)
  const lastRestore = useMemberCloudStore((s) => s.lastRestore)
  const lastRestoreError = useMemberCloudStore((s) => s.lastRestoreError)

  const netcard = netcardOf(session)
  const loggedIn = Boolean(session)
  const [relay, setRelay] = useState<string | null>(null)

  /*
   * 落盘的失败清单。
   *
   * `lastResult` 只活在内存里，关掉软件就没了 —— 这是「失败只能去日志里翻」
   * 的真正原因。这里从 localStorage 读回来，让「哪几个文件没传上去」
   * 跨重启仍然可见，直到重试成功为止。
   *
   * `lastRunAt` 进依赖：每跑完一次备份就重读，重试成功后清单自然清空。
   * （`lastRunAt` 在上面的 store 订阅里已经取过了，这里直接用。）
   */
  const [persistedFailed, setPersistedFailed] = useState<FailedUpload[]>([])
  const [persistedContext, setPersistedContext] = useState<string | null>(null)
  const context = JSON.stringify([memberCloudOwnerKey(session), projectPath])

  useEffect(() => {
    setPersistedFailed([])
    if (!projectPath) {
      setPersistedFailed([])
      return
    }
    let cancelled = false
    void ensureProjectId(projectPath)
      .then((projectId) => {
        if (!cancelled) {
          setPersistedFailed(readFailedUploads(projectId, memberCloudOwnerKey(session)))
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
   * 云同步额度改由 `useSyncQuotaStore` 统一管理。
   *
   * 侧栏迷你条和这里的环形卡片读同一份数据 —— 各自请求会出现
   * 「侧栏剩 138MB、设置页剩 137MB」这种自相矛盾（见 store 的说明）。
   *
   * 这里只需要 `refresh`：`SyncQuotaRing` 自己订阅 `quota` / `error` 并渲染，
   * 本组件只负责在「备份完成后」通知它刷新。
   */
  const refreshQuota = useSyncQuotaStore((s) => s.refresh)
  const [tokenQuota, setTokenQuota] = useState<GatewayQuota | null>(null)
  const [logOpen, setLogOpen] = useState(false)

  /*
   * 失败清单：本次结果优先，没有本次结果时用落盘的历史。
   *
   * 每次备份结束都会把结果写进 localStorage（见 member-cloud-store 的
   * writeFailedUploads），所以「本次」和「历史」不会打架 ——
   * 有本次就用本次，重启后自然回落到历史。
   */
  const failedItems: FailedUpload[] =
    lastResult && lastResult.failed.length > 0 ? lastResult.failed : persistedContext === context ? persistedFailed : []

  useEffect(() => {
    let cancelled = false
    /*
     * 用 resolveSyncBaseUrl 而不是 resolveRelayBaseUrl：
     * 同步配额与额度查询这两个接口**只存在于家庭网关**，Cloudflare Worker
     * 上没有。用通用选路会在家庭网关不可用时退到 Worker，拿到
     * 「404 接口不存在」—— 用户完全看不懂（2026-11-08 实际发生）。
     * 这条路径在家庭网关不可用时会给出说人话的错误。
     */
    void resolveSyncBaseUrl()
      .then((url) => {
        if (!cancelled) setRelay(url)
      })
      .catch(() => {
        /*
         * 选路失败时什么都不做 —— 错误已经由 `useSyncQuotaStore` 自己记录并展示，
         * 这里再写一遍会和 store 的错误互相覆盖（一边说「网关未响应」，
         * 一边说「读取失败」，用户不知道该信哪个）。
         *
         * 这里只负责给「内置模型额度」拿到 relay，拿不到就不显示那一块。
         */
      })
    return () => {
      cancelled = true
    }
  }, [])


  /*
   * 拉取内置模型今日额度。
   * 与云空间配额并行拉，互不阻塞：额度查不到不影响备份功能的展示。
   */
  useEffect(() => {
    if (!netcard || !relay) return
    let cancelled = false
    void gatewayFetchQuota(relay, netcard).then((q) => {
      if (!cancelled) setTokenQuota(q)
    })
    return () => {
      cancelled = true
    }
  }, [netcard, relay])

  const handleBackup = useCallback(async () => {
    const started = await runBackup()
    // 备份会改变用量，强制刷新（跳过软过期）
    if (started) await refreshQuota({ force: true })
  }, [runBackup, refreshQuota])

  /** 结果摘要 */
  const summary = (() => {
    if (lastError) return { kind: "err" as const, text: lastError }
    if (!lastResult) return null

    const { uploaded, skippedUnchanged, failed, totalBytes } = lastResult
    // 防御：历史结果或测试注入的对象可能没有这个字段
    const binarySkipped = lastResult.binarySkipped ?? []
    // 被判定为非文本的文件要单独提一句：用户可能真的把一个 .exe 改名成了 .txt，
    // 不说清楚他会以为「同步漏了文件」。
    const binaryNote =
      binarySkipped.length > 0 ? `，${binarySkipped.length} 个文件不是纯文本已跳过` : ""

    if (failed.length === 0) {
      if (uploaded === 0) {
        return {
          kind: binarySkipped.length > 0 ? ("warn" as const) : ("ok" as const),
          text: `没有新改动（${skippedUnchanged} 个文件已是最新）${binaryNote}。`,
        }
      }
      return {
        kind: binarySkipped.length > 0 ? ("warn" as const) : ("ok" as const),
        text: `已备份 ${uploaded} 个文件（${formatBytes(totalBytes)}）${
          skippedUnchanged > 0 ? `，${skippedUnchanged} 个无改动已跳过` : ""
        }${binaryNote}。`,
      }
    }
    return {
      kind: "warn" as const,
      text: `已备份 ${uploaded} 个文件，${failed.length} 个失败${binaryNote}。`,
    }
  })()

  const messageClass = (kind: "ok" | "err" | "warn") =>
    kind === "ok"
      ? "text-emerald-600 dark:text-emerald-400"
      : kind === "err"
        ? "text-destructive"
        : "text-amber-600 dark:text-amber-400"

  /*
   * 从云端恢复。
   *
   * 必须先确认：这个操作会往本地写文件，用户如果只是想看看云端有什么，
   * 不该被写一地的文件。文案里说清楚「本地更新的文件不会被覆盖」，
   * 让用户知道这不是全量覆盖、风险可控。
   */
  const handleRestore = useCallback(async () => {
    const confirmed = window.confirm(
      "从云端恢复到本地？\n\n" +
        "· 会把云端已有的文件写回当前作品目录\n" +
        "· 本地已有文件保持不变，同名云端文件另存恢复副本\n" +
        "· 本地有、云端没有的文件不会删除\n\n" +
        "建议恢复前先备份一次当前作品。",
    )
    if (!confirmed) return
    await runRestore()
  }, [runRestore])

  /** 恢复结果摘要 */
  const restoreSummary = (() => {
    if (lastRestoreError) return { kind: "err" as const, text: lastRestoreError }
    if (!lastRestore) return null
    const { restored, skippedNewer, failed, totalBytes, remoteTotal } = lastRestore
    if (remoteTotal === 0) {
      return { kind: "warn" as const, text: "云端还没有这个作品的文件。" }
    }
    if (failed.length === 0) {
      if (restored === 0) {
        return {
          kind: "ok" as const,
          text: `云端 ${remoteTotal} 个文件，本地都是更新的，没有覆盖任何文件。`,
        }
      }
      return {
        kind: "ok" as const,
        text: `已恢复 ${restored} 个文件（${formatBytes(totalBytes)}）${
          skippedNewer > 0 ? `，${skippedNewer} 个本地更新已跳过` : ""
        }。`,
      }
    }
    return {
      kind: "warn" as const,
      text: `已恢复 ${restored} 个文件，${failed.length} 个失败。`,
    }
  })()

  return (
    <section className="space-y-4" data-ui="member-cloud-section">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-base font-medium">
          <HardDrive className="h-4 w-4" aria-hidden="true" />
          会员云空间
        </h2>
        <p className="text-sm text-muted-foreground">
          把当前作品备份到青幕的服务器。与上面的「云同步」不同 ——
          那个同步到你自己的网盘，这里用的是会员空间。
        </p>
      </header>

      {!loggedIn ? (
        <div
          className="rounded-lg border p-4 text-sm text-muted-foreground"
          data-ui="member-cloud-login-required"
        >
          请先在「账号」里登录，登录后即可使用云空间备份。
        </div>
      ) : !projectPath ? (
        <div
          className="rounded-lg border p-4 text-sm text-muted-foreground"
          data-ui="member-cloud-no-project"
        >
          当前没有打开的作品。打开一个作品后再来备份。
        </div>
      ) : (
        <>
          {/*
           * 同步失败区域（2026-11-08 用户要求「专门的区域」）。
           *
           * 放在额度卡片**之前**：失败比「还剩多少空间」紧急得多 ——
           * 用户此刻最想知道的是「我写的字有没有丢」，不是配额数字。
           *
           * 数据源合并两处：
           *   · lastResult.failed —— 本次备份的结果（最新）
           *   · persistedFailed   —— 落盘的清单（跨重启仍在）
           * 取本次的即可，因为每次备份结束都会把结果写进 localStorage。
           */}
          {failedItems.length > 0 ? (
            <div
              className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs"
              data-ui="member-cloud-failed"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-medium text-destructive">
                  {failedItems.length} 个文件没传上去
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={handleBackup}
                  disabled={running || !relay}
                >
                  {running ? "重试中…" : "重试"}
                </Button>
              </div>
              <ul className="space-y-0.5">
                {failedItems.slice(0, 20).map((item) => (
                  <li key={item.path} className="text-muted-foreground">
                    <span className="font-mono">{item.path}</span>：{item.message}
                  </li>
                ))}
              </ul>
              {failedItems.length > 20 && (
                <div className="mt-1.5 text-muted-foreground">
                  仅显示前 20 个，完整列表见下方「查看同步日志」。
                </div>
              )}
              <div className="mt-2 text-muted-foreground">
                这些文件本地已保存，只是还没传上云端。它们没有记入同步清单，
                下次备份会自动重试；点上方「重试」可立即重传。
              </div>
            </div>
          ) : null}

          {/*
           * 环形额度卡片（方案 A）。
           * 数据来自共享 store，与侧栏迷你条是同一份 —— 不会出现两处数字不一致。
           * 组件内部自己处理「加载中 / 无数据 / 失败」三种状态。
           */}
          <SyncQuotaRing />

          {tokenQuota ? (
            <div className="space-y-3 rounded-lg border p-4">
              <TokenQuotaBar quota={tokenQuota} />
            </div>
          ) : null}

          <div className="space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">自动同步</div>
                <p className="text-xs text-muted-foreground">
                  保存后约 8 秒自动备份，只上传改动过的文件。
                </p>
              </div>
              <Switch
                checked={autoEnabled}
                label={autoEnabled ? "关闭自动同步" : "开启自动同步"}
                data-ui="member-cloud-auto-switch"
                onChange={(checked) => setAutoEnabled(checked)}
              />
            </div>

            <div className="border-t pt-3 text-sm">
              <span className="text-muted-foreground">当前作品：</span>
              <span className="font-medium">{projectName || "未命名"}</span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={handleBackup} disabled={running || !relay}>
                <CloudUpload className="mr-1.5 h-4 w-4" aria-hidden="true" />
                {running ? "正在备份…" : "立即备份到云端"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => void refreshQuota({ force: true })}
                disabled={running}
              >
                刷新空间信息
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleRestore}
                disabled={running || !relay}
                data-ui="member-cloud-restore"
              >
                <CloudDownload className="mr-1.5 h-4 w-4" aria-hidden="true" />
                {running ? "正在恢复…" : "从云端恢复"}
              </Button>              <Button
                type="button"
                variant="ghost"
                onClick={() => setLogOpen(true)}
                data-ui="member-cloud-log-button"
              >
                <FileText className="mr-1.5 h-4 w-4" aria-hidden="true" />
                查看同步日志
              </Button>
              {lastRunAt && (
                <span className="text-xs text-muted-foreground">
                  上次：{new Date(lastRunAt).toLocaleTimeString("zh-CN")}
                </span>
              )}
            </div>

            {summary && (
              <div
                className={`text-sm ${messageClass(summary.kind)}`}
                data-ui="member-cloud-message"
              >
                {summary.text}
              </div>
            )}

            {restoreSummary && (
              <div
                className={`text-sm ${messageClass(restoreSummary.kind)}`}
                data-ui="member-cloud-restore-message"
              >
                {restoreSummary.text}
              </div>
            )}

            {lastRestore && lastRestore.failed.length > 0 && (
              <details
                className="text-xs text-muted-foreground"
                data-ui="member-cloud-restore-failed"
              >
                <summary className="cursor-pointer">
                  查看恢复失败的 {lastRestore.failed.length} 个文件
                </summary>
                <ul className="mt-1.5 space-y-0.5 pl-4">
                  {lastRestore.failed.slice(0, 20).map((item) => (
                    <li key={item.path} className="list-disc">
                      <span className="font-mono">{item.path}</span>：{item.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {lastRestore?.conflicts?.length ? (
              <details className="text-xs text-muted-foreground" data-ui="member-cloud-restore-conflicts">
                <summary className="cursor-pointer">原文件已保留，查看 {lastRestore.conflicts.length} 个云端副本位置（相对作品目录）</summary>
                <ul className="mt-1.5 space-y-1 break-all">
                  {lastRestore.conflicts.map(item => <li key={item.savedPath}>{item.path} → {item.savedPath}</li>)}
                </ul>
              </details>
            ) : null}

            <p className="text-xs text-muted-foreground">
              只备份正文、大纲、设定等文本文件；图片与依赖目录不会上传。
            </p>
          </div>
        </>
      )}

      <MemberCloudLogDialog open={logOpen} onOpenChange={setLogOpen} projectPath={projectPath} />
    </section>
  )
}
