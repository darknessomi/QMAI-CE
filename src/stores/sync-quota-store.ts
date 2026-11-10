/**
 * 云同步额度的共享状态。
 *
 * ## 为什么需要单独的 store
 *
 * 额度要在**两个地方**同时显示：
 *   · 侧栏底部的迷你条（时刻可见）
 *   · 设置 › 会员云空间的详情卡片
 *
 * 如果各自 `fetch`，打开设置时会打两次请求，而且两处数字可能不一致
 * （一次刷新早、一次刷新晚）—— 用户看到「侧栏剩 138MB、设置页剩 137MB」
 * 只会觉得软件在乱算。
 *
 * 所以合成一份：谁先挂载谁触发拉取，另一处直接读同一份数据。
 *
 * ## 为什么不做定时轮询
 *
 * 额度只在**上传/删除文件**时变化，而这两件事都发生在软件内部，
 * 我们能在动作完成后主动 `refresh()`。定时轮询（比如每分钟）纯属浪费 ——
 * 云同步不是高频操作，轮询 99% 的请求都是「没变化」。
 *
 * 唯一的例外是「多设备」：另一台电脑传了东西，这边不会立刻知道。
 * 所以加一个「超过 5 分钟就允许重新拉」的软过期，但不主动轮询。
 */

import { create } from "zustand"

import { resolveSyncBaseUrl } from "@/lib/builtin-models/relay-endpoints"
import { netcardOf } from "@/lib/builtin-models/netcard"
import { fetchSyncQuota, SyncError, type SyncQuota } from "@/lib/qmai-sync/client"
import { useAccountStore } from "@/stores/account-store"

/** 软过期：超过这个时间，下次读取会顺手刷新一次（不阻塞渲染） */
const STALE_MS = 5 * 60 * 1000

export interface SyncQuotaState {
  quota: SyncQuota | null
  loading: boolean
  /** 拉取失败的原因；与「额度为 0」是两回事，不要混为一谈 */
  error: string | null
  lastFetchedAt: number

  /**
   * 拉取额度。
   *
   * @param options.force 忽略软过期，强制重新请求
   */
  refresh: (options?: { force?: boolean }) => Promise<void>

  /** 登出时清空（避免下一个账号看到上一个账号的额度） */
  reset: () => void
}

/**
 * 同一时刻只允许一个请求在飞。
 *
 * 侧栏和设置页可能同时挂载（比如设置页盖在侧栏上），
 * 两个 useEffect 同时触发就是两次请求。用一个模块级 Promise 去重。
 */
let inFlight: Promise<void> | null = null

export const useSyncQuotaStore = create<SyncQuotaState>((set, get) => ({
  quota: null,
  loading: false,
  error: null,
  lastFetchedAt: 0,

  refresh: async (options) => {
    if (inFlight) return inFlight

    const state = get()
    const fresh = Date.now() - state.lastFetchedAt < STALE_MS
    if (!options?.force && fresh && state.quota) return

    const session = useAccountStore.getState().session
    const netcard = netcardOf(session)
    if (!netcard) {
      // 未登录：清掉旧数据，不要显示别人的额度
      set({ quota: null, loading: false, error: null, lastFetchedAt: 0 })
      return
    }

    set({ loading: true, error: null })

    inFlight = (async () => {
      try {
        const relay = await resolveSyncBaseUrl()
        const quota = await fetchSyncQuota(relay, netcard)
        set({ quota, loading: false, error: null, lastFetchedAt: Date.now() })
      } catch (error) {
        const message =
          error instanceof SyncError
            ? error.message
            : error instanceof Error
              ? error.message
              : "读取云空间额度失败。"
        // 保留上一次的 quota：一次网络抖动不该让界面从「剩 138MB」变成空白
        set({ loading: false, error: message })
      } finally {
        inFlight = null
      }
    })()

    return inFlight
  },

  reset: () => {
    inFlight = null
    set({ quota: null, loading: false, error: null, lastFetchedAt: 0 })
  },
}))

// ── 纯计算辅助（组件与测试共用）──────────────────────────────

/** 剩余字节（不会为负） */
export function remainingBytes(quota: SyncQuota | null): number {
  if (!quota) return 0
  return Math.max(0, quota.limitBytes - quota.usedBytes)
}

/** 剩余文件数（不会为负） */
export function remainingFiles(quota: SyncQuota | null): number {
  if (!quota) return 0
  return Math.max(0, quota.limitFiles - quota.usedFiles)
}

/** 空间使用比例 0–1 */
export function usedRatio(quota: SyncQuota | null): number {
  if (!quota || quota.limitBytes <= 0) return 0
  return Math.min(1, quota.usedBytes / quota.limitBytes)
}

/**
 * 用量档位。
 *
 * 80% 起提醒、95% 起告警 —— 与设计稿确认的阈值一致。
 * 为什么不是 90%：等看到红色时往往已经传不上去了，80% 才是「还来得及处理」。
 *
 * ## `locked` 是 2026-11-09 补的（重要）
 *
 * 在那之前只有 ok/warn/danger/full 四档，而判断是：
 *
 * ```
 * if (ratio >= 1 || remainingBytes(quota) <= 0) return "full"
 * ```
 *
 * 免费用户没有云空间后，网关返回 `limitBytes: 0`，于是
 * `remainingBytes = 0 - 0 = 0` → **必然命中 "full"**。
 *
 * 结果：免费用户被告知「**空间已满，新的改动传不上去。清理云端文件**」——
 * 可他**根本没有云端文件可清理**。他不知道该做什么，只觉得软件坏了。
 *
 * 「没有这项权益」和「空间满了」是**两回事**，界面必须分开：
 *
 * · `locked` → 「云备份是会员功能，开通后可用 5 GB」+ 开通入口
 * · `full`   → 「空间已满，清理云端文件」+ 清理入口
 */
export type QuotaLevel = "locked" | "ok" | "warn" | "danger" | "full"

/**
 * 是否「未开通」而不是「满了」。
 *
 * 优先信服务端的 `memberOnly` 标记；老版本网关不返回它时，
 * 回退到 `limitBytes <= 0`（额度为 0 意味着根本没有可用空间，
 * 那个状态下**任何用量都是 100%**，报「已满」是误诊）。
 */
export function isQuotaLocked(quota: SyncQuota | null): boolean {
  if (!quota) return false
  if (quota.memberOnly === true) return true
  return quota.limitBytes <= 0
}

export function quotaLevel(quota: SyncQuota | null): QuotaLevel {
  if (!quota) return "ok"
  // 必须先判 locked：limitBytes 为 0 时下面的 ratio 计算与已满判定都会误命中
  if (isQuotaLocked(quota)) return "locked"
  const ratio = usedRatio(quota)
  if (ratio >= 1 || remainingBytes(quota) <= 0) return "full"
  if (ratio >= 0.95) return "danger"
  if (ratio >= 0.8) return "warn"
  return "ok"
}
