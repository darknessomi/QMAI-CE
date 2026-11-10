/**
 * 云备份面板（2026-11-09 从「会员云空间」改名并改为方案②）。
 *
 * ## 名字：云空间 → 云备份
 *
 * 用户在这一屏真正要做的事只有一件：**把作品备份到云端**。
 * 「云空间」听起来像在管一块磁盘，而这里没有任何磁盘管理动作
 * （不能删文件、不能建目录）。改成「云备份」直说功能。
 *
 * ## 布局：方案②（主按钮 + 图标组）
 *
 * ```
 * 会员态
 * ┌─ ☁ 云备份 ────────────────────[开] ─┐
 * │ 已用 0% · 共 5120 MB               │
 * │ [⬆ 立即备份        ] [⬇] [📄] [⚠②] │
 * │                      恢复  日志  失败 │
 * └────────────────────────────────────┘
 *
 * 免费态
 * ┌─ 🔒 云备份 ────────────────────────┐
 * │ 会员专属功能          [开通会员]    │
 * ├────────────────────────────────────┤
 * │ 开通后解锁 云空间 5 GB · 自动备份 …  │
 * │ ¥39/月起                 [立即开通] │
 * └────────────────────────────────────┘
 * ```
 *
 * ## 为什么「立即备份」占满剩余宽度
 *
 * 它是这一区**唯一的高频动作**（其余三个是低频的排查手段）。
 * 四个等宽按钮会让用户看不出哪个是主操作 —— 等宽意味着「一样重要」，
 * 但事实不是。主按钮占大头，其余收成带微标签的图标方块。
 *
 * ## 失败明细不再常驻（用户 2026-11-09 要求）
 *
 * 原来失败块直接铺在下面，即使只有一条也占一整块的高度。
 * 现在收进「失败」图标背后的面板：**有失败时图标变红带数字角标**，
 * 点它才展开明细。没有失败时角标不显示，不占任何版面。
 *
 * ## 金色只出现在会员态
 *
 * 免费态用中性灰 + 虚线边 —— 如果也用金，用户会以为「我已经是会员了」，
 * 然后发现什么都用不了，落差比完全不用金更大。
 * **金色只服务于「说服」，不服务于「装饰」。**
 */

import { useEffect, useState } from "react"
import {
  CloudUpload,
  Download,
  FileText,
  Lock,
  RotateCw,
  TriangleAlert,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { useMembership } from "@/lib/membership/use-membership"
import { PLAN_DISPLAYS } from "@/lib/membership/purchase-channels"
import { ensureProjectId } from "@/lib/project-identity"
import { formatBytes } from "@/lib/qmai-sync/client"
import { useAccountStore } from "@/stores/account-store"
import { useSyncQuotaStore, usedRatio } from "@/stores/sync-quota-store"
import { memberCloudOwnerKey, readFailedUploads, useMemberCloudStore, type FailedUpload } from "@/stores/member-cloud-store"
import { useWikiStore } from "@/stores/wiki-store"

import { useMembershipPurchaseStore } from "@/stores/membership-purchase-store"

import { MemberCloudLogDialog } from "./member-cloud-log-dialog"

/* ── 视觉常量 ─────────────────────────────────────────────── */

/** 金色块：会员态专用。金色 = 会员身份，整页只用在这里和账号主卡。 */
const GOLD_BLOCK = "member-gold-surface overflow-hidden rounded-[11px] border"

const GOLD_TEXT = "member-gold-text"
const GOLD_NUM = "member-gold-text"
const GOLD_SUB = "text-muted-foreground"
const GOLD_LINE = "member-gold-line"

/** 图标方块：主按钮右边的三个次要操作（金色调，与卡片同色系） */
const ICO_BASE = "member-secondary-action relative grid h-[38px] place-items-center rounded-[9px] border leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-50"

/**
 * 操作条的宽度分配（2026-11-09 用户确认方案 ① 等分）。
 *
 * ## 为什么不让主按钮撑满
 *
 * 撑满时宽约 700px，右边三个图标才 170px —— 比例接近 4:1，视觉上主按钮
 * 像一条横带，把卡片切成了两半（用户反馈「立即备份按钮太宽了」）。
 *
 * ①等分之后主按钮占一半、图标组占一半，形成 **1:1 的对仗**：
 * 既保住了「它是主要动作」的层级，版面也站得住。
 */
const ACTION_ROW = "flex items-center gap-1.5 px-4 pb-3"
/*
 * 主按钮：**固定宽度**（2026-11-09 用户确认「立即备份不做成超宽效果」）。
 *
 * 原来是 `flex-1` —— 宽度由容器决定而不是内容：
 * 单列（980px）时被拉到 470px，两列（470px）时也有 235px。
 * 而「立即备份」四个字 + 一个图标只需要 106px 左右，
 * 多出来的空间全是白撑的，看起来像一条横带。
 *
 * 定宽之后剩余空间交给图标组分配，主按钮始终是它该有的宽度。
 */
const MAIN_BTN = "member-primary-action h-[38px] w-[106px] shrink-0 justify-center text-[0.75rem] font-semibold"
const ICO_GROUP = "flex min-w-0 flex-1 gap-1.5"
const ICO_BOX = "flex min-w-0 flex-1 flex-col gap-px"

type CloudPanel = "restore" | "failed"

export function MemberCloudPanel() {
  const session = useAccountStore((s) => s.session)
  const { active: isMember } = useMembership()

  const quota = useSyncQuotaStore((s) => s.quota)
  const quotaError = useSyncQuotaStore((s) => s.error)
  const refreshQuota = useSyncQuotaStore((s) => s.refresh)

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

  const projectPath = useWikiStore((s) => s.project?.path ?? null)

  const [logOpen, setLogOpen] = useState(false)
  const showMembership = useMembershipPurchaseStore(s => s.show)
  const [persistedFailed, setPersistedFailed] = useState<FailedUpload[]>([])
  const [persistedContext, setPersistedContext] = useState<string | null>(null)
  const context = JSON.stringify([memberCloudOwnerKey(session), projectPath])
  /** 当前展开的图标面板：恢复 / 失败。同一时刻只开一个。 */
  const [panel, setPanel] = useState<CloudPanel | null>(null)

  useEffect(() => {
    setPersistedFailed([])
    const owner = memberCloudOwnerKey(session)
    if (!projectPath) {
      setPersistedFailed([])
      return
    }
    let cancelled = false
    void ensureProjectId(projectPath)
      .then((id) => {
        if (!cancelled) {
          setPersistedFailed(readFailedUploads(id, owner))
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

  // 未登录：不渲染（账号页的登录引导卡已经说明了要登录）
  if (!session) return null

  const failedItems =
    lastResult && lastResult.failed.length > 0 ? lastResult.failed : persistedContext === context ? persistedFailed : []
  const hasFailure = failedItems.length > 0

  const ratio = usedRatio(quota)

  const openPurchase = () => showMembership("cloudBackup")

  const togglePanel = (next: CloudPanel) => setPanel((cur) => (cur === next ? null : next))

  /* ── 免费态：两项权益锁定条 + 底部开通（用户 2026-11-09 确认方案 α） ──
   *
   * 用户原话：「像『模型同步』和『云备份』这些功能，在『免费』板块里也要
   * 设计并加入其中，让其能够显示出来。」
   *
   * ## 为什么要显示
   *
   * 这两项是「会员能买到什么」的核心答案。整块隐藏等于用户永远不知道该
   * 功能存在，也就无从开通。
   *
   * ## 为什么看不到任何额度数字
   *
   * 用户原话：「会员云空间普通用户不能同步，只有开会员的才能使用同步功能。」
   * 显示「剩 88 MB / 共 100 MB」会让人以为「我有 100MB 能用」，实际上
   * 一点都用不了（服务端也会拒）。直接说清「会员专属」更诚实。
   *
   * ## 为什么只给一个「开通会员」
   *
   * 不给禁用按钮 —— 用户会反复去点那个点不动的按钮，看起来像坏了。
   * 整块只留一个明确可操作的入口。
   *
   * 模型同步那一行在这里只是**说明**（它自己的面板在下面还有一份登录引导），
   * 所以不带开关，避免出现两个「模型的开关」让人困惑。
   */
  if (!isMember) {
    const plan = PLAN_DISPLAYS.find((p) => p.id === "month")
    return (
      <section className="space-y-2.5" data-ui="member-cloud-panel">
        <div
          className="overflow-hidden rounded-[11px] border border-dashed border-[rgba(245,207,107,0.75)] bg-[#fffdf8] dark:border-[rgba(180,130,40,0.45)] dark:bg-[#1d1a12]"
          data-ui="member-cloud-locked"
        >
          {[
            {
              key: "cloud",
              icon: "☁",
              name: "云备份",
              desc: "会员专属功能，开通后可备份到云端",
            },
            {
              key: "model",
              icon: "◈",
              name: "模型同步",
              desc: "会员专属功能，可跨设备同步模型配置",
            },
          ].map((item, index) => (
            <div
              key={item.key}
              className={`flex items-center gap-2.5 px-4 py-3 ${
                index > 0 ? "border-t border-dashed border-[rgba(245,207,107,0.62)]" : ""
              }`}
              data-ui={`member-cloud-locked-${item.key}`}
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-md bg-[rgba(245,207,107,0.22)] text-[0.75rem] text-[#7a4a05] dark:text-[#f0d089]">
                {item.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className={`text-[0.75rem] font-semibold ${GOLD_TEXT}`}>{item.name}</div>
                <div className={`mt-0.5 text-[0.65625rem] ${GOLD_SUB}`}>{item.desc}</div>
              </div>
              <Lock className="size-3 shrink-0 text-[#7a4a05]/50 dark:text-[#f0d089]/50" aria-hidden="true" />
            </div>
          ))}

          <div className="flex items-center gap-2.5 border-t border-dashed border-[rgba(245,207,107,0.62)] bg-white/50 px-4 py-3 dark:bg-white/3">
            <p className={`min-w-0 flex-1 text-[0.65625rem] leading-relaxed ${GOLD_SUB}`}>
              开通后解锁 <b>云空间 5 GB</b>、自动备份、跨设备恢复，
              以及灵魂库、拆书库、剧情推演室。
            </p>
            <Button
              type="button"
              size="sm"
              className="shrink-0 border border-[#c9942c] bg-gradient-to-b from-[#f3c95f] to-[#d9a334] text-[0.75rem] font-bold text-[#3d2a05] hover:from-[#f6d27a] hover:to-[#e0ae44]"
              onClick={openPurchase}
              data-ui="member-cloud-open-purchase"
            >
              开通会员
            </Button>
          </div>
        </div>

        {/* 升级引导：价格与套餐入口 */}
        <div
          className="rounded-[11px] border border-dashed border-[rgba(245,207,107,0.75)] bg-[radial-gradient(200px_100px_at_100%_0%,rgba(240,192,86,0.12),transparent_72%),#fffdf8] px-4 py-3 dark:border-[rgba(180,130,40,0.45)] dark:bg-[radial-gradient(200px_100px_at_100%_0%,rgba(240,192,86,0.10),transparent_72%),#1d1a12]"
          data-ui="member-cloud-upsell"
        >
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="inline-flex items-center rounded bg-gradient-to-b from-[#ffe9a8] via-[#f5cf6b] to-[#dda63a] px-1.5 py-px text-[0.625rem] font-extrabold tracking-wide text-[#3d2a05]">
              VIP
            </span>
            <span className={`text-[0.75rem] font-semibold ${GOLD_TEXT}`}>升级会员</span>
          </div>
          <p className={`text-[0.6875rem] leading-relaxed ${GOLD_SUB}`}>
            开通后解锁普通会员的全部权益，云空间从 100 MB 扩容到 <b>5 GB</b>。
          </p>
          <div className={`mt-2 text-[0.9375rem] font-extrabold leading-none ${GOLD_NUM}`}>
            ¥{plan?.price ?? 39}
            <span className="ml-0.5 text-[0.625rem] font-semibold opacity-70">/月起</span>
          </div>
          <Button
            type="button"
            size="sm"
            className="mt-2.5 w-full justify-center border border-[#c9942c] bg-gradient-to-b from-[#f3c95f] to-[#d9a334] text-[0.75rem] font-bold text-[#3d2a05] hover:from-[#f6d27a] hover:to-[#e0ae44]"
            onClick={openPurchase}
          >
            选择套餐
          </Button>
        </div>
      </section>
    )
  }

  return (
    <section className="space-y-2.5" data-ui="member-cloud-panel">
      <div className={GOLD_BLOCK} data-ui="member-cloud-space-card">
        {/* ── 卡头：额度摘要 + 自动备份总开关 ── */}
        <div className="flex items-center gap-2.5 px-4 py-3" data-ui="member-cloud-controls">
          <span className="grid size-6 shrink-0 place-items-center rounded-md bg-[rgba(245,207,107,0.28)]">
            <CloudUpload className={`size-3.5 ${GOLD_TEXT}`} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className={`text-[0.78125rem] font-semibold ${GOLD_TEXT}`}>云备份</div>
            <div className={`mt-0.5 text-[0.65625rem] ${GOLD_SUB}`} data-ui="member-cloud-quota">
              {quota
                ? `已用 ${Math.round(ratio * 100)}% · 共 ${formatBytes(quota.limitBytes)}`
                : (quotaError ?? "正在读取额度…")}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoEnabled}
            aria-label="自动备份"
            title={autoEnabled ? "关闭自动备份（保存后不再自动上传）" : "开启自动备份"}
            data-ui="member-cloud-auto-switch"
            onClick={() => setAutoEnabled(!autoEnabled)}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
              autoEnabled ? "bg-gradient-to-b from-[#f5cf6b] to-[#dda63a]" : "bg-muted"
            }`}
          >
            <span
              className={`absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-all ${
                autoEnabled ? "right-0.5" : "left-0.5"
              }`}
            />
          </button>
        </div>

        {/* ── 操作条：主按钮与图标组各占一半（方案 ① 等分） ── */}
        <div className={ACTION_ROW}>
          <Button
            type="button"
            size="sm"
            className={MAIN_BTN}
            onClick={() => void runBackup()}
            disabled={running || !projectPath}
            data-ui="member-cloud-backup"
          >
            <CloudUpload className="mr-1.5 size-3.5" aria-hidden="true" />
            {running ? "备份中…" : "立即备份"}
          </Button>

          <div className={ICO_GROUP}>
            <button
              type="button"
              className={`${ICO_BASE} ${ICO_BOX}`}
              title="从云端恢复"
              aria-label="从云端恢复"
              aria-expanded={panel === "restore"}
              data-ui="member-cloud-restore"
              onClick={() => togglePanel("restore")}
              disabled={!projectPath}
            >
              <Download className="size-3.5" aria-hidden="true" />
              <span className={`whitespace-nowrap text-[0.5625rem] ${GOLD_SUB}`}>恢复</span>
            </button>

            <button
              type="button"
              className={`${ICO_BASE} ${ICO_BOX}`}
              title="同步日志"
              aria-label="同步日志"
              data-ui="member-cloud-open-log"
              onClick={() => setLogOpen(true)}
            >
              <FileText className="size-3.5" aria-hidden="true" />
              <span className={`whitespace-nowrap text-[0.5625rem] ${GOLD_SUB}`}>日志</span>
            </button>

            {/*
             * 失败图标：**常驻但只在有失败时变红**（用户 2026-11-09 要求
             * 「失败时下面不显示，点击失败图标才能查看」）。
             *
             * 位置固定比「有失败才出现」好：用户知道该去哪找，
             * 不会因为这次没失败就下次找不到入口。
             */}
            <button
              type="button"
              className={`${ICO_BASE} ${ICO_BOX} ${
                hasFailure
                  ? "border-destructive/40 bg-destructive/5 text-destructive hover:border-destructive"
                  : ""
              }`}
              title={hasFailure ? `${failedItems.length} 个文件上传失败` : "没有失败的备份"}
              aria-label={hasFailure ? `失败记录，${failedItems.length} 条` : "失败记录，无"}
              aria-expanded={panel === "failed"}
              data-ui="member-cloud-open-failed"
              onClick={() => togglePanel("failed")}
            >
              <TriangleAlert className="size-3.5" aria-hidden="true" />
              <span
                className={`whitespace-nowrap text-[0.5625rem] ${
                  hasFailure ? "font-semibold text-destructive" : GOLD_SUB
                }`}
              >
                {hasFailure ? `失败${failedItems.length}` : "失败"}
              </span>
            </button>
          </div>
        </div>

        {/* ── 面板：云端恢复 ── */}
        {panel === "restore" ? (
          <div className={`border-t px-4 py-3 ${GOLD_LINE}`} data-ui="member-cloud-restore-panel">
            <div className="mb-2 flex items-center gap-2">
              <span className={`text-[0.71875rem] font-semibold ${GOLD_TEXT}`}>从云端恢复</span>
              <button
                type="button"
                className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-white/70"
                aria-label="关闭恢复面板"
                onClick={() => setPanel(null)}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
            <p className={`mb-2.5 text-[0.65625rem] leading-relaxed ${GOLD_SUB}`}>
              将云端文件恢复到本机。本机已有文件会保留，同名云端文件另存恢复副本；完成后显示副本位置。
            </p>
            <Button
              type="button"
              size="sm"
              className="w-full justify-center border border-[#c9942c] bg-gradient-to-b from-[#f3c95f] to-[#d9a334] text-[0.75rem] font-bold text-[#3d2a05] hover:from-[#f6d27a] hover:to-[#e0ae44]"
              onClick={() => {
                void runRestore()
                setPanel(null)
              }}
              disabled={running || !projectPath}
            >
              <Download className="mr-1.5 size-3.5" aria-hidden="true" />
              {running ? "恢复中…" : "开始恢复"}
            </Button>
          </div>
        ) : null}

        {/* ── 面板：失败记录 ── */}
        {panel === "failed" ? (
          <div className={`border-t px-4 py-3 ${GOLD_LINE}`} data-ui="member-cloud-failed">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[0.71875rem] font-semibold text-destructive">失败记录</span>
              {hasFailure ? (
                <span className="rounded-full bg-destructive px-1.5 text-[0.625rem] font-bold text-white">
                  {failedItems.length}
                </span>
              ) : null}
              {hasFailure ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="ml-auto h-6 px-2 text-[0.6875rem]"
                  onClick={() => void runBackup()}
                  disabled={running || !projectPath}
                >
                  <RotateCw className="mr-1 size-3" aria-hidden="true" />
                  全部重试
                </Button>
              ) : null}
              <button
                type="button"
                className={`rounded p-0.5 text-muted-foreground hover:bg-white/70 ${hasFailure ? "" : "ml-auto"}`}
                aria-label="关闭失败面板"
                onClick={() => setPanel(null)}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>

            {hasFailure ? (
              <ul className="space-y-1.5">
                {failedItems.map((item) => (
                  <li
                    key={item.path}
                    className="rounded-md border border-destructive/35 bg-white/70 px-2.5 py-2 dark:bg-white/5"
                  >
                    <div className="break-all font-mono text-[0.6875rem] font-semibold">
                      {item.path}
                    </div>
                    <div className="mt-0.5 text-[0.625rem] text-muted-foreground">{item.message}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={`py-2 text-center text-[0.6875rem] ${GOLD_SUB}`}>
                没有失败的备份，所有文件都已同步到云端。
              </p>
            )}
          </div>
        ) : null}

        {lastError ? (
          <div className={`border-t px-4 py-2 text-[0.6875rem] text-destructive ${GOLD_LINE}`} data-ui="member-cloud-error">
            {lastError}
          </div>
        ) : null}
        {lastRestoreError ? (
          <p className="border-t px-4 py-2 text-xs text-destructive" role="alert">{lastRestoreError}</p>
        ) : lastRestore ? (
          <div className="border-t px-4 py-2 text-xs" data-ui="member-cloud-restore-result" role="status">
            <p>已保存 {lastRestore.restored} 个文件，跳过 {lastRestore.skippedNewer} 个本地较新文件，失败 {lastRestore.failed.length} 个。</p>
            {lastRestore.conflicts?.length ? (
              <details className="mt-2">
                <summary className="cursor-pointer">原文件已保留，查看 {lastRestore.conflicts.length} 个云端副本位置（相对作品目录）</summary>
                <ul className="mt-1 space-y-1 break-all">
                  {lastRestore.conflicts.map(item => <li key={item.savedPath}>{item.path} → {item.savedPath}</li>)}
                </ul>
              </details>
            ) : null}
            {lastRestore.failed.length > 0 ? <ul className="mt-1 text-destructive">{lastRestore.failed.map(item => <li key={item.path}>{item.path}：{item.message}</li>)}</ul> : null}
          </div>
        ) : null}
      </div>

      {/* ── 额度刷新：额度不实时（5 分钟软 TTL），给一个手动刷新入口 ── */}
      <div className="flex items-center gap-2 px-1">
        <span className={`text-[0.65625rem] ${GOLD_SUB}`}>
          {autoEnabled ? "保存后约 8 秒自动备份" : "自动备份已关闭，需要手动点「立即备份」"}
        </span>
        <button
          type="button"
          className="ml-auto text-[0.65625rem] text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => void refreshQuota({ force: true })}
          data-ui="member-cloud-refresh"
        >
          刷新额度
        </button>
      </div>

      <MemberCloudLogDialog open={logOpen} onOpenChange={setLogOpen} projectPath={projectPath} />
    </section>
  )
}
