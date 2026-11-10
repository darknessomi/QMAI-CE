/**
 * 会员云空间的运行状态（zustand）。
 *
 * ## 为什么单独一个 store
 *
 * 备份要同时读三个地方：账号（网卡）、工程（路径）、网关（地址）。
 * 全塞进 UI 组件里会让「什么时候会触发一次上传」变得很难看清 ——
 * 而自动同步恰恰最需要能一眼看懂「现在会不会传、上次传了什么」。
 *
 * ## 清单存在哪
 *
 * 每个账号、目标存储和工程一份清单（相对路径 → 大小 + 修改时间），存 localStorage。
 * 它的唯一作用是让下一次备份知道「哪些文件没变，不用重传」。
 * 丢了不影响正确性，只是下一次会全量传一遍。
 */

import { create } from "zustand"
import type { StoredAccountSession } from "@/lib/account/types"

import { netcardOf } from "@/lib/builtin-models/netcard"
import { resolveSyncBaseUrl } from "@/lib/builtin-models/relay-endpoints"
import { ensureProjectId } from "@/lib/project-identity"
import { backupProject, type BackupOutcome, type SyncManifest } from "@/lib/qmai-sync/backup"
import { isMembershipActive } from "@/lib/membership/access"
import { SyncError } from "@/lib/qmai-sync/client"
import { restoreProject, type RestoreOutcome } from "@/lib/qmai-sync/restore"
import { useAccountStore } from "@/stores/account-store"
import { useWikiStore } from "@/stores/wiki-store"

/** 自动同步开关的存储键 */
const AUTO_KEY = "qmai.memberCloud.auto.v2."

/** 每个工程的清单键前缀 */
const MANIFEST_PREFIX = "qmai.memberCloud.manifest.v2."

/** 稳定账号归属；不保存邮箱、登录令牌或网关卡。 */
export function memberCloudOwnerKey(session: StoredAccountSession | null | undefined): string | null {
  if (!session?.user || session.user.id == null || !session.baseUrl) return null
  return JSON.stringify(["qingmu", session.baseUrl.replace(/\/+$/, ""), String(session.user.id)])
}

function currentOwner(): string | null {
  return memberCloudOwnerKey(useAccountStore.getState().session)
}

let taskGeneration = 0

function startTask(session: StoredAccountSession, projectPath: string) {
  const generation = ++taskGeneration
  const owner = memberCloudOwnerKey(session)
  const active = () => generation === taskGeneration && currentOwner() === owner &&
    netcardOf(useAccountStore.getState().session) === netcardOf(session) &&
    useWikiStore.getState().project?.path === projectPath
  return {
    active,
    assertActive: () => { if (!active()) throw new Error("账号或作品已切换，原同步任务已停止。") },
  }
}

/** 清单最多记多少个文件，防止 localStorage 无限膨胀 */
const MANIFEST_MAX_ENTRIES = 8000

function readAutoEnabled(): boolean {
  const owner = currentOwner()
  if (!owner) return false
  try {
    return localStorage.getItem(AUTO_KEY + owner) === "1"
  } catch {
    return false
  }
}

function writeAutoEnabled(value: boolean): void {
  const owner = currentOwner()
  if (!owner) return
  try {
    localStorage.setItem(AUTO_KEY + owner, value ? "1" : "0")
  } catch {
    // 存不进去不影响本次会话，只是下次启动恢复默认
  }
}

function manifestKey(projectId: string): string {
  return MANIFEST_PREFIX + projectId
}

/*
 * ── 失败清单持久化（2026-11-08 加）──────────────────────────
 *
 * 用户的抱怨是「同步失败的内容只会在同步日志里显示」。根本原因不只是
 * 界面位置 —— `lastResult` 只活在内存里，**关掉软件就没了**，
 * 下次打开必须去翻 JSONL 日志才知道哪几个文件没传上去。
 *
 * 所以把失败清单按工程落盘。它和 manifest 是一对：
 *   · manifest 记「传成功过的」（下次跳过）
 *   · failed 记「还没传上去的」（要提醒用户）
 * 两者必须同时更新，否则会出现「清单里有、实际没传上去」的静默丢文件。
 */
const FAILED_PREFIX = "qmai.memberCloud.failed.v2."
/** 只留最近一批，避免 localStorage 被历史失败撑爆 */
const FAILED_MAX_ENTRIES = 200

export interface FailedUpload {
  path: string
  message: string
}

function failedKey(projectId: string, owner: string): string {
  return FAILED_PREFIX + JSON.stringify([owner, projectId])
}

export function readFailedUploads(projectId: string, owner = currentOwner()): FailedUpload[] {
  if (!owner) return []
  try {
    const raw = localStorage.getItem(failedKey(projectId, owner))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is FailedUpload =>
        Boolean(item) &&
        typeof (item as FailedUpload).path === "string" &&
        typeof (item as FailedUpload).message === "string",
    )
  } catch {
    return []
  }
}

export function writeFailedUploads(projectId: string, failed: FailedUpload[], owner = currentOwner()): void {
  if (!owner) return
  try {
    if (failed.length === 0) {
      localStorage.removeItem(failedKey(projectId, owner))
      return
    }
    localStorage.setItem(
      failedKey(projectId, owner),
      JSON.stringify(failed.slice(0, FAILED_MAX_ENTRIES)),
    )
  } catch {
    /* 存不下就只保留内存态，不影响同步本身 */
  }
}

function readManifest(projectId: string): SyncManifest {
  try {
    const raw = localStorage.getItem(manifestKey(projectId))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    return parsed as SyncManifest
  } catch {
    return {}
  }
}

function writeManifest(projectId: string, manifest: SyncManifest): void {
  try {
    const entries = Object.entries(manifest)
    /*
     * 超过上限时只保存有限条回执；缺少基线的文件仍必须实读云端。
     * 内容不同且没有可信基线时会提示冲突，不能退回无条件覆盖。
     */
    const kept =
      entries.length > MANIFEST_MAX_ENTRIES
        ? entries.slice(0, MANIFEST_MAX_ENTRIES)
        : entries
    localStorage.setItem(manifestKey(projectId), JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // 存不下就放弃：下次会全量传一遍，功能仍然可用
  }
}

export interface MemberCloudState {
  /** 自动同步开关（持久化） */
  autoEnabled: boolean
  /** 是否正在跑一次备份 */
  running: boolean
  operation: "backup" | "restore" | null
  /** 备份反馈只属于执行该次备份的账号和作品；恢复不更新备份时间。 */
  backupContext: { owner: string; projectPath: string } | null
  lastBackupAt: number | null
  /** 上次完成时间 */
  lastRunAt: number | null
  /** 上次结果 */
  lastResult: BackupOutcome | null
  /** 上次失败原因（网络/配额等整体性错误） */
  lastError: string | null

  /** 上次从云端恢复的结果 */
  lastRestore: RestoreOutcome | null
  /** 恢复失败原因 */
  lastRestoreError: string | null

  setAutoEnabled: (value: boolean) => void
  /**
   * 跑一次备份。
   *
   * @returns 是否真的执行了（前置条件不满足时返回 false）
   */
  runBackup: () => Promise<boolean>
  /**
   * 从云端恢复当前作品。
   *
   * 用户主动触发恢复；同名文件保存为独立副本。
   * 前置条件不满足时要明确报错，不能像自动备份那样静默返回。
   */
  runRestore: () => Promise<boolean>
  /** 清空运行时状态（登出时用） */
  resetRuntime: () => void
}

export const useMemberCloudStore = create<MemberCloudState>((set, get) => ({
  autoEnabled: readAutoEnabled(),
  running: false,
  operation: null,
  backupContext: null,
  lastBackupAt: null,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
  lastRestore: null,
  lastRestoreError: null,

  setAutoEnabled: (value) => {
    writeAutoEnabled(value)
    set({ autoEnabled: currentOwner() ? value : false })
  },

  resetRuntime: () => {
    taskGeneration++
    set({
      autoEnabled: readAutoEnabled(),
      running: false,
      operation: null,
      backupContext: null,
      lastBackupAt: null,
      lastRunAt: null,
      lastResult: null,
      lastError: null,
      lastRestore: null,
      lastRestoreError: null,
    })
  },

  runBackup: async () => {

    const { running } = get()
    // 已经在跑就不叠加：连续保存时只保留最早那次
    if (running) return false

    /*
     * 会员专属（2026-11-09 用户要求）。
     *
     * 用户原话：「会员云空间普通用户不能同步，只有开会员的才能使用同步功能。」
     *
     * 界面已经不给免费用户操作入口了，这里再挡一道 —— 防止通过别处调用
     * 绕过界面。服务端网关也会硬拒，三处一致。
     *
     * 静默返回 false 不写 lastError：免费用户本来就不该触发备份，
     * 冒一句「同步失败」只会让人以为出了故障。
     */
    const membership = useAccountStore.getState().user?.membership
    if (!isMembershipActive(membership)) return false

    const session = useAccountStore.getState().session
    const netcard = netcardOf(session)
    const projectPath = useWikiStore.getState().project?.path ?? null

    // 前置条件不满足：静默返回，不写错误
    // （未登录/没开作品时自动同步本来就不该跑，报错只会打扰用户）
    if (!session?.user || !netcard || !projectPath) return false

    const task = startTask(session, projectPath)
    const owner = memberCloudOwnerKey(session)!
    const backupContext = { owner: JSON.stringify([session.baseUrl, session.user.id]), projectPath }
    set({ running: true, operation: "backup", backupContext, lastBackupAt: null, lastError: null, lastResult: null })

    try {
      const [relay, projectId] = await Promise.all([
        resolveSyncBaseUrl(),
        ensureProjectId(projectPath),
      ])

      task.assertActive()
      const scope = JSON.stringify([owner, relay.replace(/\/+$/, ""), projectId])
      const known = readManifest(scope)
      const result = await backupProject({
        baseUrl: relay,
        netcard,
        projectPath,
        projectId,
        known,
        assertActive: task.assertActive,
      })

      task.assertActive()
      // 保留失败文件的上次确认回执，以便下次核对；它不能单独证明当前备份成功。
      // 当次失败不进入result.manifest，界面仍显示失败；下一次必须重新读云端内容。
      writeManifest(scope, { ...known, ...result.manifest })
      /*
       * 失败清单与 manifest 同时落盘。
       *
       * 两者的语义是一对：manifest 记「上次确认的内容」（下次重新核对），
       * failed 记「还没传上去的」（要提醒用户）。少写一个就会出现
       * 「清单里有、实际没传上去」的静默丢文件，或者「已经传上去了
       * 却还在催你重试」。
       */
      writeFailedUploads(projectId, result.failed, owner)

      /*
       * 这里**不**因为「部分文件失败」就写 lastError。
       *
       * lastError 的语义是「整次操作失败」（网络断、凭证失效、空间不足）。
       * 部分文件失败的信息在 lastResult.failed 里更完整 ——
       * 面板要能显示「已备份 5 个，2 个失败」，而不是只剩一句错误。
       * 把两者混在一起，会让「传了大部分但个别失败」看起来像彻底没传。
       */
      if (!task.active()) return true
      set({
        running: false,
        operation: null,
        lastBackupAt: Date.now(),
        lastRunAt: Date.now(),
        lastResult: result,
        lastError: null,
      })
      return true
    } catch (error) {
      const message =
        error instanceof SyncError
          ? error.message
          : error instanceof Error
            ? error.message
            : "同步失败，请稍后重试。"
      if (task.active()) set({ running: false, operation: null, lastBackupAt: Date.now(), lastRunAt: Date.now(), lastError: message })
      return true
    }
  },

  runRestore: async () => {
    const { running } = get()
    if (running) return false

    const session = useAccountStore.getState().session
    const netcard = netcardOf(session)
    const projectPath = useWikiStore.getState().project?.path ?? null

    // 恢复是用户主动点的，前置条件不满足时要说清楚，不能静默
    if (!session?.user || !netcard || !projectPath) {
      set({ lastRestoreError: "请先登录账号并打开一个作品。" })
      return false
    }

    const task = startTask(session, projectPath)
    const owner = memberCloudOwnerKey(session)!
    set({ running: true, operation: "restore", lastRestoreError: null, lastRestore: null })

    try {
      const [relay, projectId] = await Promise.all([
        resolveSyncBaseUrl(),
        ensureProjectId(projectPath),
      ])

      task.assertActive()
      const result = await restoreProject({
        baseUrl: relay,
        netcard,
        projectId,
        projectPath,
        assertActive: task.assertActive,
      })

      /*
       * 恢复完成后把本地清单重置。
       *
       * 恢复会补齐本地文件，之前的本地指纹不能证明当前云端仍保留同一版本。
       * 使本账号/存储/作品的缓存失效，下次重新备份；不触碰其他账号缓存。
       */
      task.assertActive()
      clearMemberCloudManifest(projectId, relay, owner)

      set({
        running: false,
        operation: null,
        lastRunAt: Date.now(),
        lastRestore: result,
        lastRestoreError: null,
      })
      return true
    } catch (error) {
      const message =
        error instanceof SyncError
          ? error.message
          : error instanceof Error
            ? error.message
            : "恢复失败，请稍后重试。"
      if (task.active()) set({ running: false, operation: null, lastRunAt: Date.now(), lastRestoreError: message })
      return true
    }
  },
}))

/** 恢复后仅使当前账号和存储目标的工程清单失效。 */
export function clearMemberCloudManifest(projectId: string, relay: string, owner = currentOwner()): void {
  if (!owner) return
  try {
    localStorage.removeItem(manifestKey(JSON.stringify([owner, relay.replace(/\/+$/, ""), projectId])))
  } catch {
    // ignore
  }
}

// 身份变化即清理反馈；旧异步结果使用任务代次检查，不能回填新账号。
useAccountStore.subscribe((state, previous) => {
  if (memberCloudOwnerKey(state.session) !== memberCloudOwnerKey(previous.session) ||
      netcardOf(state.session) !== netcardOf(previous.session)) useMemberCloudStore.getState().resetRuntime()
})
useWikiStore.subscribe((state, previous) => {
  if (state.project?.path !== previous.project?.path) useMemberCloudStore.getState().resetRuntime()
})
