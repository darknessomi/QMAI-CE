/**
 * Persistent serial queue for duplicate-merge operations.
 *
 * Why a queue (and not just kicking off `executeMerge` from the click
 * handler):
 *   - Merges rewrite cross-references across the entire wiki. Two
 *     concurrent merges race on the same files, last write wins, and
 *     half the rewrites silently disappear.
 *   - LLM calls take seconds; the user wants to queue several merges
 *     and walk away. The queue must survive app close so an
 *     interrupted merge can be continued explicitly on next launch.
 *
 * Mirrors `ingest-queue.ts` almost line-for-line: same lifecycle
 * (pause / restore on project switch), same persistence file shape,
 * same retry-up-to-3 policy, same registry-based path resolution so
 * a relocated project still finds its tasks.
 */
import { readFile, writeFileAtomic } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import { getProjectPathById } from "@/lib/project-identity"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { resolveDefaultModel, resolveModelConfig } from "@/lib/novel/model-resolver"
import { removeGroupFromDedupScanCache } from "@/lib/dedup-scan-cache"
import { removeMergedDedupGroupFromSession } from "@/lib/dedup-scan-session"
import { executeMerge, type DedupMergeStage } from "@/lib/dedup-runner"
import type { DedupMergeBatch, PreparedMerge } from "./dedup-merge-batch"
import { DedupRollbackError, normalizeGroupKey as groupKey, type DuplicateGroup } from "@/lib/dedup"
import { withProjectLock } from "@/lib/project-mutex"

// ── Types ─────────────────────────────────────────────────────────────────

export interface DedupTask {
  id: string
  projectId: string
  group: DuplicateGroup
  canonicalSlug: string | null
  modelId?: string
  /** 旧版队列字段。重新打开项目时，未完成的合并统一等待手动继续。 */
  autoResume?: true
  status: "pending" | "processing" | "done" | "failed" | "awaiting_resume"
  addedAt: number
  error: string | null
  retryCount: number
}

// ── State ─────────────────────────────────────────────────────────────────

const emptyCounts = { merged: 0, skipped: 0, cancelled: 0 }
type StoredTask = DedupTask & { progressCounts?: typeof emptyCounts }
let counts = emptyCounts
let committedTask: DedupTask | null = null
let queue: DedupTask[] = []
let processing = false
let restoring: Promise<void> | undefined
let bindingVersion = 0
let currentProjectId = ""
let currentProjectPath = ""
let currentAbortController: AbortController | null = null
let inFlightMerge: ReturnType<typeof executeMerge> | null = null
interface MergeProgress {
  taskId: string
  stage: DedupMergeStage
  requestGroups?: number
  requestedAt?: number
}
let currentMergeProgress: MergeProgress | null = null
let currentMergeLogs: string[] = []
let batchDrafts = new Map<string, PreparedMerge>()
let draftModel = ""

type MergeCompleteListener = (task: DedupTask) => void
const mergeCompleteListeners = new Set<MergeCompleteListener>()

/** Fires once when a merge task finishes successfully and leaves the queue. */
export function onDedupMergeComplete(listener: MergeCompleteListener): () => void {
  mergeCompleteListeners.add(listener)
  return () => mergeCompleteListeners.delete(listener)
}

function notifyMergeComplete(task: DedupTask): void {
  for (const listener of mergeCompleteListeners) {
    try {
      listener(task)
    } catch (err) {
      console.error("[Dedup Queue] mergeComplete listener failed:", err)
    }
  }
}

// ── Persistence ───────────────────────────────────────────────────────────

function queueFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.qmai/dedup-queue.json`
}

async function saveQueue(projectPath: string): Promise<void> {
  const path = queueFilePath(projectPath)
  const previousQueue = queue
  const previousCounts = counts
  try {
    await withProjectLock(path, () => currentProjectPath === projectPath ? writeQueue(path, queue) : writeQueue(path, previousQueue, previousCounts))
  } catch (error) {
    console.error("[Dedup Queue] 保存任务状态失败", error)
  }
}

function writeQueue(path: string, tasks: readonly DedupTask[], snapshot = counts): Promise<void> {
  // Keep the legacy array format. One checkpoint travels with the first remaining task.
  const saved: StoredTask[] = tasks.filter((task) => task.status !== "done")
  if (saved.length && (snapshot.merged || snapshot.skipped || snapshot.cancelled)) {
    saved[0] = { ...saved[0], progressCounts: snapshot }
  }
  return writeFileAtomic(path, JSON.stringify(saved, null, 2))
}

async function loadQueue(
  projectPath: string,
  projectId: string,
): Promise<StoredTask[]> {
  try {
    const path = queueFilePath(projectPath)
    const raw = await withProjectLock(path, () => readFile(path))
    const tasks = JSON.parse(raw) as StoredTask[]
    return tasks.map((t) => ({
      ...t,
      projectId: t.projectId ?? projectId,
    }))
  } catch {
    return []
  }
}

// ── Queue Operations ──────────────────────────────────────────────────────

function generateId(): string {
  return `dedup-${crypto.randomUUID()}`
}

export { groupKey }

type MergeChoice = Pick<DedupTask, "group" | "canonicalSlug">

function holdUnfinishedMerges(tasks: DedupTask[]) {
  for (const task of tasks) {
    if (task.status === "pending" || task.status === "processing") task.status = "awaiting_resume"
  }
}

/** One durable admission per batch. The worker sees new tasks only after the write succeeds. */
async function enqueueMerges(projectId: string, choices: readonly MergeChoice[], modelId?: string) {
  const active = useWikiStore.getState().project
  if (active?.id !== projectId) throw new Error("当前项目已切换，请重新选择候选组")
  await ensureQueueActive(projectId, active.path)

  const projectPath = normalizePath(active.path)
  const path = queueFilePath(projectPath)
  const result = await withProjectLock(path, async () => {
    if (currentProjectId !== projectId || currentProjectPath !== projectPath || useWikiStore.getState().project?.id !== projectId) {
      throw new Error("当前项目已切换，请重新选择候选组")
    }
    const version = bindingVersion
    const idsByGroup = new Map(queue.filter((task) => task.status !== "done").map((task) => [groupKey(task.group.slugs), task.id]))
    const added: DedupTask[] = []
    const ids = choices.map(({ group, canonicalSlug }) => {
      const key = groupKey(group.slugs)
      const existing = idsByGroup.get(key)
      if (existing) return existing
      const task: DedupTask = {
        id: generateId(), projectId, group, canonicalSlug, modelId: modelId?.trim() || undefined,
        status: "pending", addedAt: Date.now(), error: null, retryCount: 0,
      }
      idsByGroup.set(key, task.id)
      added.push(task)
      return task.id
    })
    if (added.length) {
      const startsNewRun = queue.length === 0
      await writeQueue(path, [...queue, ...added], startsNewRun ? emptyCounts : counts)
      if (version === bindingVersion) {
        if (startsNewRun) counts = emptyCounts
        queue.push(...added)
      }
    }
    return { ids, added: added.length }
  })
  if (result.added) void processNext(projectId)
  return result
}

export async function enqueueMerge(projectId: string, group: DuplicateGroup, canonicalSlug: string, modelId?: string): Promise<string> {
  const { ids } = await enqueueMerges(projectId, [{ group, canonicalSlug }], modelId)
  return ids[0]
}

export async function enqueueMergeBatch(projectId: string, groups: readonly DuplicateGroup[], modelId?: string): Promise<number> {
  const choices = groups.map((group) => ({ group, canonicalSlug: null }))
  return (await enqueueMerges(projectId, choices, modelId)).added
}

/** Persist each user action once, even when it affects hundreds of groups. */
async function changeMergeTasks(projectId: string, action: "resume" | "cancel", taskId?: string, modelId?: string): Promise<void> {
  const active = useWikiStore.getState().project
  if (active?.id !== projectId) return
  await ensureQueueActive(projectId, active.path)
  const version = bindingVersion
  const path = queueFilePath(active.path)
  const change = await withProjectLock(path, async () => {
    if (version !== bindingVersion || currentProjectId !== projectId || useWikiStore.getState().project?.id !== projectId) return
    const selected = new Set(queue.filter((task) => {
      if (task.projectId !== projectId || (taskId !== undefined && task.id !== taskId)) return false
      if (action === "cancel") return task !== committedTask
      return task.status === "awaiting_resume" || (taskId !== undefined && task.status === "failed")
    }))
    if (!selected.size) return

    const resumed = { status: "pending" as const, retryCount: 0, error: null, modelId: modelId?.trim() || undefined }
    const updated = action === "cancel"
      ? queue.filter((task) => !selected.has(task))
      : queue.map((task) => selected.has(task) ? { ...task, ...resumed } : task)
    await writeQueue(path, updated, action === "cancel" ? { ...counts, cancelled: counts.cancelled + selected.size } : counts)
    if (version !== bindingVersion) return
    if (action === "resume") {
      for (const task of selected) {
        Object.assign(task, resumed)
        batchDrafts.delete(task.id)
      }
      return { cancelledWorker: false, draining: null }
    }
    const removed = new Set(queue.filter(task => selected.has(task) && task !== committedTask))
    const cancelledWorker = [...removed].some(task => task.status === "processing")
    const draining = cancelledWorker ? inFlightMerge : null
    counts = { ...counts, cancelled: counts.cancelled + removed.size }
    queue = queue.filter((task) => !removed.has(task))
    for (const task of removed) batchDrafts.delete(task.id)
    if (cancelledWorker) {
      currentAbortController?.abort()
      currentAbortController = null
      currentMergeProgress = null
    }
    if (taskId === undefined) currentMergeLogs = []
    return { cancelledWorker, draining }
  })
  if (!change) return
  // A cancelled write can still be rolling back. Keep the worker slot until it settles.
  let rollbackError: DedupRollbackError | undefined
  if (change.draining) {
    try { await change.draining } catch (error) {
      if (error instanceof DedupRollbackError) rollbackError = error
    }
  }
  if (version !== bindingVersion || currentProjectId !== projectId) return
  if (change.cancelledWorker) processing = false
  if (rollbackError) {
    holdUnfinishedMerges(queue)
    await saveQueue(active.path)
    throw rollbackError
  }
  void processNext(projectId)
}

export function resumePausedMerges(projectId: string, modelId?: string): Promise<void> {
  return changeMergeTasks(projectId, "resume", undefined, modelId)
}

export function cancelAllMerges(projectId: string): Promise<void> {
  return changeMergeTasks(projectId, "cancel")
}

export async function retryTask(taskId: string, modelId?: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (task) await changeMergeTasks(task.projectId, "resume", taskId, modelId)
}

export async function cancelTask(taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (task) await changeMergeTasks(task.projectId, "cancel", taskId)
}

export function getMergeCounts(projectId?: string) {
  return currentProjectId === projectId ? counts : emptyCounts
}

export function getQueue(): readonly DedupTask[] {
  return queue
}

/** In-memory merge stage for the currently processing task (not persisted). */
export function getMergeProgress() {
  return currentMergeProgress
}

/** In-memory process logs for the currently processing merge (not persisted). */
export function getMergeLogs(): readonly string[] {
  return currentMergeLogs
}

/**
 * Project-switch handshake: flush the active project's queue to disk
 * (holding unfinished tasks for manual resume), then clear in-memory state.
 */
export async function pauseQueue(): Promise<void> {
  const version = bindingVersion
  if (restoring) await restoring
  if (version !== bindingVersion || !currentProjectId || !currentProjectPath) return

  const pausedProjectPath = currentProjectPath
  const writing = currentMergeProgress?.stage === "writing" ? inFlightMerge : null

  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
  }
  processing = false
  currentMergeProgress = null
  currentMergeLogs = []

  holdUnfinishedMerges(queue)

  if (writing) await Promise.allSettled([writing])
  if (version !== bindingVersion) return
  await saveQueue(pausedProjectPath)
  if (version !== bindingVersion) return

  queue = []
  currentProjectId = ""
  currentProjectPath = ""
  batchDrafts.clear()
}

/**
 * Ensure the in-memory dedup queue is bound to the given project.
 * No-op when already active; otherwise loads from disk via restoreQueue.
 */
export async function ensureQueueActive(
  projectId: string,
  projectPath: string,
): Promise<void> {
  const pp = normalizePath(projectPath)
  if (currentProjectId === projectId && currentProjectPath === pp) return restoring
  await restoreQueue(projectId, projectPath)
}

/**
 * Load the queue without starting model work, including after an abrupt exit.
 */
export async function restoreQueue(
  projectId: string,
  projectPath: string,
): Promise<void> {
  const pp = normalizePath(projectPath)
  if (currentProjectId === projectId && currentProjectPath === pp && restoring) return restoring
  const pending = loadProjectQueue(projectId, pp, ++bindingVersion)
  restoring = pending
  try { await pending } finally { if (restoring === pending) restoring = undefined }
}

async function loadProjectQueue(projectId: string, pp: string, version: number): Promise<void> {
  currentAbortController?.abort()
  queue = []
  counts = emptyCounts
  committedTask = null
  processing = false
  currentAbortController = null
  currentProjectId = projectId
  currentProjectPath = pp
  inFlightMerge = null
  currentMergeProgress = null
  currentMergeLogs = []
  batchDrafts = new Map()

  const saved = await loadQueue(pp, projectId)
  if (version !== bindingVersion || saved.length === 0) return

  const mine = saved.filter((t) => t.projectId === projectId)
  if (mine.length !== saved.length) {
    console.warn(
      `[Dedup Queue] Dropped ${saved.length - mine.length} cross-project tasks during restore`,
    )
  }

  const savedCounts = mine[0]?.progressCounts
  if (savedCounts && [savedCounts.merged, savedCounts.skipped, savedCounts.cancelled].every(n => Number.isSafeInteger(n) && n >= 0)) {
    counts = savedCounts
  }
  for (const task of mine) {
    delete task.progressCounts
    delete task.autoResume
  }
  holdUnfinishedMerges(mine)
  queue = mine
  await saveQueue(pp)
}

// ── Processing ────────────────────────────────────────────────────────────

const MAX_RETRIES = 3

async function processNext(projectId: string): Promise<void> {
  if (processing) return
  if (currentProjectId !== projectId) return

  const next = queue.find(
    (t) => t.projectId === projectId && t.status === "pending",
  )
  if (!next) return

  const version = bindingVersion
  const registryPath = await getProjectPathById(projectId)
  const pp = registryPath ? normalizePath(registryPath) : ""
  if (currentProjectId !== projectId || processing || !queue.includes(next) || next.status !== "pending") return

  if (!pp) {
    next.status = "failed"
    next.error = "项目未在注册表中找到（可能已被删除？）"
    await saveQueue(currentProjectPath)
    processNext(projectId)
    return
  }

  processing = true
  next.status = "processing"
  await saveQueue(pp)
  if (currentProjectId !== projectId || !queue.includes(next) || next.status !== "processing") return

  const state = useWikiStore.getState()
  const llmConfig = next.modelId?.trim()
    ? resolveModelConfig(next.modelId, state.llmConfig, state.providerConfigs)
    : resolveDefaultModel(state.llmConfig)

  if (!hasUsableLlm(llmConfig, state.providerConfigs)) {
    next.status = "failed"
    next.error = "LLM 未配置，请在设置中配置大模型提供方"
    holdUnfinishedMerges(queue)
    processing = false
    currentMergeProgress = null
    currentMergeLogs = [
      `${new Date().toLocaleTimeString()}  LLM 未配置，请在设置中配置大模型提供方`,
    ]
    await saveQueue(pp)
    return
  }

  console.log(
    `[Dedup Queue] Processing: merge ${next.group.slugs.join(",")} → ${next.canonicalSlug ?? "由模型选择主条目"}`,
  )

  const controller = new AbortController()
  currentAbortController = controller
  currentMergeProgress = { taskId: next.id, stage: "loading" }
  currentMergeLogs = []

  const appendMergeLog = (message: string) => {
    if (version !== bindingVersion || controller.signal.aborted) return
    const stamp = new Date().toLocaleTimeString()
    currentMergeLogs = [...currentMergeLogs, `${stamp}  ${message}`]
    console.log(`[Dedup Queue] ${message}`)
  }

  appendMergeLog(
    next.modelId?.trim()
      ? `合并模型 id：${next.modelId.trim()}`
      : "任务未指定合并 modelId，回退默认模型",
  )

  const model = JSON.stringify([next.modelId, llmConfig.provider, llmConfig.model, llmConfig.customEndpoint, llmConfig.ollamaUrl])
  if (model !== draftModel) {
    draftModel = model
    batchDrafts = new Map()
  }
  const batch: DedupMergeBatch | undefined = next.canonicalSlug === null ? {
    current: next,
    drafts: batchDrafts,
    isPending: (id) => queue.some((task) => task.id === id),
    following: function* () {
      // Retry an invalid/truncated reply with this group alone. Valid sibling
      // drafts can still be consumed when those tasks reach the front.
      if (next.retryCount) return
      for (const task of queue) {
        if (task.status !== "pending") continue
        if (task.projectId !== projectId || task.modelId !== next.modelId || task.canonicalSlug !== null) break
        yield task
      }
    },
  } : undefined

  try {
    const running = executeMerge(pp, next.group, next.canonicalSlug, llmConfig, {
      batch,
      signal: controller.signal,
      onProgress: (stage, requestGroups) => {
        if (version !== bindingVersion || controller.signal.aborted) return
        currentMergeProgress = { taskId: next.id, stage, requestGroups, requestedAt: stage === "merging" ? Date.now() : undefined }
      },
      onLog: appendMergeLog,
    })
    inFlightMerge = running
    try {
      await running
      if (version === bindingVersion) committedTask = next
    } finally {
      if (inFlightMerge === running) inFlightMerge = null
    }

    // Merge already wrote to disk. Always drop the candidate group from
    // scan cache + live UI session — even if the active project changed
    // mid-flight (otherwise the card stays and a second merge 404s).
    await removeGroupFromDedupScanCache(pp, next.group.slugs).catch((err) => {
      console.error("[Dedup Queue] failed to update scan cache after merge:", err)
    })
    if (version !== bindingVersion || currentProjectId !== projectId) return
    const completing = queue.includes(next) && next.status === "processing"
    if (completing) {
      counts = { ...counts, merged: counts.merged + 1 }
      queue = queue.filter((task) => task !== next)
    }
    committedTask = null
    removeMergedDedupGroupFromSession(projectId, next.group.slugs)
    useWikiStore.getState().bumpDataVersion()
    if (!completing) return

    currentAbortController = null
    currentMergeProgress = null
    // Keep logs until the next task starts so the UI can show completion briefly.
    const completedTask = { ...next }
    await saveQueue(pp)
    if (version !== bindingVersion) return

    console.log(`[Dedup Queue] Done: ${next.group.slugs.join(",")}`)
    notifyMergeComplete(completedTask)
  } catch (err) {
    if (currentProjectId !== projectId || !queue.includes(next) || next.status !== "processing") return
    currentAbortController = null
    currentMergeProgress = null
    const message = err instanceof Error ? err.message : String(err)
    appendMergeLog(`失败：${message}`)

    // Stale candidate after a prior successful merge (UI/list not cleared):
    // drop it so the user cannot keep retrying a deleted page.
    const missingPage =
      /not found on disk|ENOENT|No such file|文件不存在|未找到实体或概念条目|was the page deleted/i.test(
        message,
      )
    if (missingPage) {
      batch?.drafts.delete(next.id)
      await removeGroupFromDedupScanCache(pp, next.group.slugs).catch(() => {})
      if (currentProjectId !== projectId || !queue.includes(next) || next.status !== "processing") return
      counts = { ...counts, skipped: counts.skipped + 1 }
      queue = queue.filter((t) => t.id !== next.id)
      removeMergedDedupGroupFromSession(projectId, next.group.slugs)
      await saveQueue(pp)
      if (version !== bindingVersion) return
      appendMergeLog("候选页面已不存在，已从列表移除")
      processing = false
      processNext(projectId)
      return
    }

    next.retryCount++
    next.error = message

    if (next.retryCount >= MAX_RETRIES) {
      batch?.drafts.delete(next.id)
      next.status = "failed"
      console.log(
        `[Dedup Queue] Failed (${next.retryCount}x): ${next.group.slugs.join(",")} — ${message}`,
      )
    } else {
      next.status = "pending"
      console.log(
        `[Dedup Queue] Error (retry ${next.retryCount}/${MAX_RETRIES}): ${next.group.slugs.join(",")} — ${message}`,
      )
    }
    await saveQueue(pp)
  }

  if (version !== bindingVersion) return
  processing = false
  processNext(projectId)
}
