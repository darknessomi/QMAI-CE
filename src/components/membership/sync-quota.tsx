/**
 * 云同步额度的环形卡片（设置 › 会员云空间）。
 *
 * ## 额度还在哪些地方显示
 *
 *   · `MembershipCard` —— 头像菜单里的会员卡，额度并在下半部分（方案 A1）
 *   · 这里 —— 设置页的环形卡片，看得更细，且带升级引导
 *
 * 2026-11-08 之前还有一条「侧栏底部迷你条」，用户反馈「放在那里不合适，
 * 应该放进点头像弹出的菜单里」，已删除 —— 信息分散在两处，用户看得到
 * 空间却不知道自己是会员，反之亦然。
 *
 * ## 为什么两处都读同一个 store
 *
 * 见 `stores/sync-quota-store.ts`：各自请求会导致数字不一致。
 *
 * ## 为什么显示「剩余」而不是「已用」
 *
 * 用户的问题是「我还能传多少」，不是「我已经用了多少」。原来的实现写
 * 「已用 62 MB / 100 MB」，用户还得自己做减法。现在剩余量是最大的字。
 */

import { useEffect } from "react"

import { formatBytes } from "@/lib/qmai-sync/client"
import {
  quotaLevel,
  remainingBytes,
  useSyncQuotaStore,
  usedRatio,
  type QuotaLevel,
} from "@/stores/sync-quota-store"
import { useAccountStore } from "@/stores/account-store"

/** 各档位对应的文字色 / 进度条色（Tailwind 类名） */
const LEVEL_STYLE: Record<QuotaLevel, { text: string; bar: string; ring: string }> = {
  /*
   * `locked` = 没有这项权益（2026-11-09 新增）。
   *
   * 不再是红色 —— 红色是「出问题了」。免费用户没有云备份**不是问题**，
   * 只是一个还没做的选择，所以用中性的文字色 + 金色引导。
   */
  locked: { text: "text-muted-foreground", bar: "bg-muted", ring: "stroke-muted" },
  ok: { text: "text-foreground", bar: "bg-primary", ring: "stroke-primary" },
  warn: { text: "text-amber-600 dark:text-amber-400", bar: "bg-amber-500", ring: "stroke-amber-500" },
  danger: { text: "text-destructive", bar: "bg-destructive", ring: "stroke-destructive" },
  full: { text: "text-destructive", bar: "bg-destructive", ring: "stroke-destructive" },
}

/** 环形进度的半径与周长（viewBox 100×100，r=38 留出描边空间） */
const RING_R = 38
const RING_C = 2 * Math.PI * RING_R

/**
 * 设置页的环形额度卡片。
 *
 * 剩余量用整张卡片里最大的字号 —— 这是用户唯一真正想看的数字。
 */
export function SyncQuotaRing({ onUpgrade }: { onUpgrade?: () => void }) {
  const quota = useSyncQuotaStore((s) => s.quota)
  const error = useSyncQuotaStore((s) => s.error)
  const loading = useSyncQuotaStore((s) => s.loading)
  const refresh = useSyncQuotaStore((s) => s.refresh)
  // 同迷你条：登录状态变化要重拉，否则先挂载后登录会一直空着
  const session = useAccountStore((s) => s.session)

  useEffect(() => {
    void refresh()
  }, [refresh, session])

  if (!quota) {
    return (
      <div
        className="rounded-xl border p-4 text-sm text-muted-foreground"
        data-ui="sync-quota-ring-empty"
      >
        {loading ? "正在读取云空间额度…" : (error ?? "暂无云空间额度信息")}
      </div>
    )
  }

  const level = quotaLevel(quota)
  const style = LEVEL_STYLE[level]
  const ratio = usedRatio(quota)
  const percent = Math.round(ratio * 100)
  const isMember = quota.tier === "member"

  /*
   * ── 免费态：两行对比卡（2026-11-09 用户确认）──
   *
   * ## 为什么不沿用环形卡
   *
   * 环形卡画的是「用了多少 / 还剩多少」—— 免费用户**没有额度**，
   * 那些数字全无意义（`0%`、`共 0 B`）。
   *
   * ## 为什么是对比而不是一句说明
   *
   * 用户到这一页是带着「**我该不该开通**」的问题来的。对比直接回答它：
   * 左边是我现在的，右边是开通后的。而一句「开通会员扩容到 5 GB」
   * 只说了结果，没说清我**现在**是什么状态。
   *
   * ## 「无云备份」而不是「0 B」
   *
   * 如实描述当前状态。`0 B` 会让人以为「我有额度，只是用完了」。
   */
  if (level === "locked") {
    return (
      <div className="rounded-xl border p-4" data-ui="sync-quota-ring" data-level={level}>
        <div className="mb-2.5 flex items-center gap-2">
          <span className="text-[0.8125rem] font-semibold">☁ 云备份</span>
        </div>

        <div className="space-y-2">
          {/* 当前 */}
          <div
            className="flex items-center gap-2.5 rounded-lg bg-muted/60 px-3 py-2.5 text-[0.71875rem] text-muted-foreground"
            data-ui="quota-row-free"
          >
            <span className="min-w-12 font-semibold">当前</span>
            <span>免费版</span>
            <span className="ml-auto font-bold">无云备份</span>
          </div>

          {/* 会员 */}
          <div
            className="flex items-center gap-2.5 rounded-lg border border-[rgba(245,207,107,0.34)] bg-[linear-gradient(100deg,#fffdf4,#fef9e8)] px-3 py-2.5 text-[0.71875rem] dark:border-[rgba(180,130,40,0.4)] dark:bg-[#1d1a12]"
            data-ui="quota-row-member"
          >
            <span className="min-w-12 font-semibold text-[#7a4a05] dark:text-[#f0d089]">会员</span>
            <span className="text-[#7a4a05] dark:text-[#f0d089]">云空间</span>
            <span className="ml-auto font-bold text-[#a97a1c] dark:text-[#f5cf6b]">5 GB</span>
          </div>
        </div>

        <p className="mt-2.5 text-[0.65625rem] leading-relaxed text-muted-foreground">
          开通后作品保存约 8 秒自动备份一次，换设备或重装都不丢稿。
        </p>

        {onUpgrade ? (
          <button
            type="button"
            onClick={onUpgrade}
            className="mt-3 h-9 w-full rounded-lg border border-[#c9942c] bg-gradient-to-b from-[#f3c95f] to-[#d9a334] text-[0.75rem] font-bold text-[#3d2a05] transition-colors hover:from-[#f6d27a] hover:to-[#e0ae44]"
            data-ui="quota-open-purchase"
          >
            开通会员
          </button>
        ) : null}

        {error ? (
          <div className="mt-3 rounded-md bg-muted px-2.5 py-1.5 text-[0.6875rem] text-muted-foreground">
            额度数据可能已过期：{error}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="rounded-xl border p-4" data-ui="sync-quota-ring" data-level={level}>
      <div className="flex items-center gap-4">
        {/* 环形进度 */}
        <div className="relative size-[5.75rem] shrink-0">
          <svg viewBox="0 0 100 100" className="size-full -rotate-90">
            <circle cx="50" cy="50" r={RING_R} fill="none" strokeWidth="9" className="stroke-muted" />
            <circle
              cx="50"
              cy="50"
              r={RING_R}
              fill="none"
              strokeWidth="9"
              strokeLinecap="round"
              strokeDasharray={RING_C}
              // 用「已用」驱动填充长度：环填满 = 空间用完，与直觉一致
              strokeDashoffset={RING_C * (1 - ratio)}
              className={`transition-[stroke-dashoffset] duration-500 ${style.ring}`}
            />
          </svg>
          <div className="absolute inset-0 grid place-items-center text-center leading-tight">
            <div>
              <div className="text-[1.1875rem] font-extrabold tracking-tight tabular-nums">
                {percent}%
              </div>
              <div className="text-[0.625rem] text-muted-foreground">已用</div>
            </div>
          </div>
        </div>

        {/* 数字区 */}
        <div className="min-w-0 flex-1">
          <div className="text-[0.8125rem] font-semibold">云同步空间</div>
          <div className={`text-[1.375rem] font-extrabold leading-tight tracking-tight ${style.text}`}>
            {level === "full" ? "已满" : formatBytes(remainingBytes(quota))}
            {level === "full" ? null : (
              <span className="ml-0.5 text-xs font-semibold text-muted-foreground">可用</span>
            )}
          </div>
          {/* 只讲空间：文件数不是真实约束，见 miniHint 的说明 */}
          <div className="mt-0.5 text-[0.71875rem] text-muted-foreground">
            共 {formatBytes(quota.limitBytes)} · 已用 {formatBytes(quota.usedBytes)}
          </div>

          <div className="mt-2">
            {isMember ? (
              <span className="inline-flex items-center rounded bg-gradient-to-b from-amber-200 to-amber-500 px-1.5 py-px text-[0.625rem] font-extrabold tracking-wide text-amber-950">
                VIP 会员空间
              </span>
            ) : onUpgrade ? (
              <button
                type="button"
                onClick={onUpgrade}
                className="inline-flex items-center rounded bg-accent px-1.5 py-px text-[0.625rem] font-semibold text-primary hover:underline"
              >
                免费版 · 开通会员扩容到 5 GB
              </button>
            ) : (
              <span className="inline-flex items-center rounded bg-accent px-1.5 py-px text-[0.625rem] font-semibold text-primary">
                免费版 · 开通会员扩容到 5 GB
              </span>
            )}
          </div>
        </div>
      </div>

      {error ? (
        <div className="mt-3 rounded-md bg-muted px-2.5 py-1.5 text-[0.6875rem] text-muted-foreground">
          额度数据可能已过期：{error}
        </div>
      ) : null}

      {level === "warn" || level === "danger" ? (
        <div className="mt-3 rounded-md bg-amber-500/10 px-2.5 py-2 text-[0.71875rem] leading-relaxed text-amber-700 dark:text-amber-400">
          空间已用到 {percent}%，建议清理云端不再需要的文件
          {isMember ? "。" : "，或开通会员扩容到 5 GB。"}
        </div>
      ) : null}

      {level === "full" ? (
        <div className="mt-3 rounded-md bg-destructive/10 px-2.5 py-2 text-[0.71875rem] leading-relaxed text-destructive">
          空间已满，新的改动传不上去。清理云端文件
          {isMember ? "后才能继续同步。" : "，或开通会员扩容到 5 GB。"}
        </div>
      ) : null}
    </div>
  )
}
