import { confirmAction } from "@/lib/confirm-action"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
  Wrench,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Trash2,
  RotateCcw,
  Clock,
  HelpCircle,
  ChevronDown,
  ChevronUp,
  BookOpen,
  Users,
  Lightbulb,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { ChatModelSelector } from "@/components/chat/chat-model-selector"
import { useWikiStore } from "@/stores/wiki-store"
import { getFirstAvailableModelKey, getEffectiveSavedModels } from "@/lib/llm-model-keys"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { normalizePath } from "@/lib/path-utils"
import { resolveDefaultModel, resolveModelConfig } from "@/lib/novel/model-resolver"
import { missingDedupSlugs, runDuplicateDetection, type DedupScanStage } from "@/lib/dedup-runner"
import { addNotDuplicate } from "@/lib/dedup-storage"
import {
  loadDedupScanCache,
  saveDedupScanCache,
  type DedupScanCacheEntry,
} from "@/lib/dedup-scan-cache"
import {
  loadDedupModelPrefs,
  saveDedupModelPrefs,
} from "@/lib/dedup-model-prefs"
import { registerDedupScanSessionApi } from "@/lib/dedup-scan-session"
import { toast } from "@/lib/toast"
import {
  enqueueMerge,
  enqueueMergeBatch,
  cancelAllMerges,
  resumePausedMerges,
  cancelTask,
  retryTask,
  getQueue,
  getMergeProgress,
  getMergeCounts,
  getMergeLogs,
  groupKey,
  ensureQueueActive,
  onDedupMergeComplete,
  type DedupTask,
} from "@/lib/dedup-queue"
import {
  cancelForeshadowingCleanupTask,
  ensureForeshadowingCleanupQueueActive,
  getForeshadowingCleanupQueue,
  retryForeshadowingCleanupTask,
  type ForeshadowingCleanupTask,
} from "@/lib/foreshadowing-cleanup-queue"
import type { DedupMergeStage } from "@/lib/dedup-runner"
import type { WikiProject } from "@/types/wiki"
import { confidenceLabels, DedupReviewList, ReviewPageNav, useReviewPage } from "./dedup-review-list"
import { MemoryCleanupTool } from "@/components/settings/sections/memory-cleanup-tool"
import { ContextCacheMaintenance } from "@/components/settings/sections/context-cache-maintenance"

type GroupUiEntry = DedupScanCacheEntry

interface MaintenanceScanState {
  projectId: string | null
  projectPath: string | null
  scanning: boolean
  scanError: string | null
  groups: GroupUiEntry[]
  scanCompleted: boolean
  scannedPageCount: number | null
  coverage?: string
  manualReview?: string[]
  progress?: string
}

const emptyScanState: MaintenanceScanState = {
  projectId: null,
  projectPath: null,
  scanning: false,
  scanError: null,
  groups: [],
  scanCompleted: false,
  scannedPageCount: null,
}

function normalizeProjectPath(path: string): string {
  return normalizePath(path).replace(/\/+$/, "")
}

function scanStateBelongsToProject(
  state: Pick<MaintenanceScanState, "projectId" | "projectPath">,
  project: WikiProject,
): boolean {
  if (state.projectId && state.projectId === project.id) return true
  if (!state.projectPath) return false
  return normalizeProjectPath(state.projectPath) === normalizeProjectPath(project.path)
}

function setSharedScanState(patch: Partial<MaintenanceScanState>): void {
  const normalizedPatch = patch.projectPath
    ? { ...patch, projectPath: normalizeProjectPath(patch.projectPath) }
    : patch
  sharedScanState = { ...sharedScanState, ...normalizedPatch }
  for (const listener of scanListeners) listener(sharedScanState)
}

function replaceSharedScanState(state: MaintenanceScanState): void {
  sharedScanState = {
    ...state,
    projectPath: state.projectPath ? normalizeProjectPath(state.projectPath) : state.projectPath,
  }
  for (const listener of scanListeners) listener(sharedScanState)
}

function toScanCache(
  state: MaintenanceScanState,
  projectId: string,
  detectModelId: string,
  mergeModelId: string,
): Parameters<typeof saveDedupScanCache>[1] {
  return {
    version: 1,
    projectId,
    scannedAt: Date.now(),
    scannedPageCount: state.scannedPageCount,
    coverage: state.coverage,
    manualReview: state.manualReview,
    modelId: detectModelId.trim() || undefined,
    mergeModelId: mergeModelId.trim() || undefined,
    groups: state.groups,
  }
}

let activeScan: { projectId: string; controller: AbortController } | undefined
let sharedScanState: MaintenanceScanState = emptyScanState
const scanListeners = new Set<(state: MaintenanceScanState) => void>()

function subscribeScanState(listener: (state: MaintenanceScanState) => void): () => void {
  scanListeners.add(listener)
  listener(sharedScanState)
  return () => scanListeners.delete(listener)
}

// Both queues mutate their tasks in place. Hold snapshots so an idle poll keeps
// the same array, but status changes on the same task still trigger a render.
function snapshotTasks<T extends { id: string; status: string; error: string | null }>(previous: readonly T[], current: readonly T[]): readonly T[] {
  if (previous.length === current.length && current.every((task, i) =>
    task.id === previous[i].id && task.status === previous[i].status && task.error === previous[i].error)) return previous
  return current.map((task) => ({ ...task }))
}

export function MaintenanceSection() {
  const { t } = useTranslation()
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const providerConfigs = useWikiStore((s) => s.providerConfigs)
  const novelConfig = useWikiStore((s) => s.novelConfig)
  const defaultLlmModel = novelConfig.defaultLlmModel
  const aiChatModel = useWikiStore((s) => s.aiChatModel)
  const project = useWikiStore((s) => s.project)

  const [detectModelId, setDetectModelId] = useState("")
  const [mergeModelId, setMergeModelId] = useState("")
  const [hydratedProject, setHydratedProject] = useState<typeof project>(null)
  const modelsHydrated = !!project && hydratedProject?.id === project.id && hydratedProject.path === project.path
  const [isScanning, setIsScanning] = useState(false)
  const [scanStage, setScanStage] = useState<DedupScanStage | null>(null)
  const [scanLogs, setScanLogs] = useState<string[]>([])
  const [scanState, setScanState] = useState<MaintenanceScanState>(sharedScanState)
  const [localScanState, setLocalScanState] = useState<MaintenanceScanState | null>(null)

  useEffect(() => subscribeScanState(setScanState), [])

  useEffect(() => {
    if (!project) {
      setLocalScanState(null)
      setHydratedProject(null)
      return
    }
    let cancelled = false
    setHydratedProject(null)
    void (async () => {
      const [cached, prefs] = await Promise.all([
        loadDedupScanCache(project.path),
        loadDedupModelPrefs(project.path),
      ])
      if (cancelled) return

      const detectFromDisk =
        prefs?.detectModelId?.trim() ||
        cached?.modelId?.trim() ||
        ""
      const mergeFromDisk =
        prefs?.mergeModelId?.trim() ||
        cached?.mergeModelId?.trim() ||
        ""
      // Prefer disk prefs on project open (overwrite empty / stale session).
      setDetectModelId(detectFromDisk)
      setMergeModelId(mergeFromDisk)

      // Only keep the in-memory session while a scan is actively running.
      // Otherwise prefer disk cache — it is updated by the merge queue even
      // when this section was unmounted, so remount must not revive stale groups.
      if (
        scanStateBelongsToProject(sharedScanState, project) &&
        sharedScanState.scanning
      ) {
        setLocalScanState({ ...sharedScanState })
        setHydratedProject(project)
        return
      }
      if (!cached || cached.projectId !== project.id) {
        if (
          scanStateBelongsToProject(sharedScanState, project) &&
          sharedScanState.scanCompleted
        ) {
          setLocalScanState({ ...sharedScanState })
        } else {
          setLocalScanState(null)
        }
        setHydratedProject(project)
        return
      }
      const hydrated: MaintenanceScanState = {
        projectId: project.id,
        projectPath: normalizeProjectPath(project.path),
        scanning: false,
        scanError: null,
        groups: cached.groups,
        scanCompleted: true,
        scannedPageCount: cached.scannedPageCount,
        coverage: cached.coverage,
        manualReview: cached.manualReview,
      }
      replaceSharedScanState(hydrated)
      setLocalScanState(hydrated)
      setHydratedProject(project)
    })()
    return () => {
      cancelled = true
    }
  }, [project?.id, project?.path])

  useEffect(() => {
    if (!project) {
      setIsScanning(false)
      return
    }
    const activeState =
      localScanState && scanStateBelongsToProject(localScanState, project)
        ? localScanState
        : scanStateBelongsToProject(scanState, project)
          ? scanState
          : null
    setIsScanning(!!activeState?.scanning)
  }, [project, localScanState, scanState])

  useEffect(() => {
    if (!modelsHydrated) return
    const preferred = defaultLlmModel.trim() || aiChatModel.trim()
    const fallback = preferred || getFirstAvailableModelKey(providerConfigs)
    setDetectModelId((current) => current.trim() || fallback)
    setMergeModelId((current) => current.trim() || fallback)
  }, [modelsHydrated, defaultLlmModel, aiChatModel, providerConfigs])

  // Persist model choices per project after initial hydrate.
  useEffect(() => {
    if (!project || !modelsHydrated) return
    if (!detectModelId.trim() && !mergeModelId.trim()) return
    void saveDedupModelPrefs(project.path, {
      detectModelId: detectModelId.trim() || undefined,
      mergeModelId: mergeModelId.trim() || undefined,
    }).catch((err) => {
      console.error("[Maintenance] save model prefs failed:", err)
    })
  }, [project?.id, project?.path, modelsHydrated, detectModelId, mergeModelId])

  const hasAvailableModels = useMemo(() => {
    for (const key of Object.keys(providerConfigs)) {
      const config = providerConfigs[key]
      if (key.startsWith("custom-")) {
        if (config.enabled === false) continue
      } else {
        // 内置预设：已启用，或有有效配置（apiKey + model/savedModels）
        const hasConfig = config.enabled === true
          || Boolean((config.apiKey || config.savedModels?.length) && (config.model || config.savedModels?.length))
        if (!hasConfig) continue
      }
      if (getEffectiveSavedModels(config).length > 0) {
        return true
      }
    }
    return false
  }, [providerConfigs])

  // Poll the local queues for status changes while this panel is mounted.
  const [tasks, setTasks] = useState<readonly DedupTask[]>([])
  const [legacyCleanupTasks, setLegacyCleanupTasks] = useState<readonly ForeshadowingCleanupTask[]>([])
  const [mergeProgress, setMergeProgress] = useState<ReturnType<typeof getMergeProgress>>(null)
  const [mergeCounts, setMergeCounts] = useState(() => getMergeCounts(project?.id))
  const [mergeLogs, setMergeLogs] = useState<readonly string[]>([])
  const [enqueueingKeys, setEnqueueingKeys] = useState<ReadonlySet<string> | null>(null)
  const [queueAction, setQueueAction] = useState<"resume" | "cancel" | null>(null)
  const submitting = useRef(false)
  const [mergeErrors, setMergeErrors] = useState<Record<string, string>>({})

  const refreshTasks = useCallback(() => {
    const projectId = useWikiStore.getState().project?.id
    setMergeCounts(getMergeCounts(projectId))
    const current = getQueue().filter((task) => task.projectId === projectId)
    setTasks((previous) => snapshotTasks(previous, current))
  }, [])

  useEffect(() => {
    if (!project) {
      setTasks([])
      setMergeCounts(getMergeCounts())
      setLegacyCleanupTasks([])
      setMergeProgress(null)
      setMergeLogs([])
      return
    }
    let cancelled = false
    const refresh = () => {
      if (cancelled) return
      refreshTasks()
      const legacy = getForeshadowingCleanupQueue().filter((task) => task.projectId === project.id && task.legacyRecovery)
      setLegacyCleanupTasks((previous) => snapshotTasks(previous, legacy))
      setMergeProgress(getMergeProgress())
      setMergeLogs(getMergeLogs())
    }
    void Promise.all([
      ensureQueueActive(project.id, project.path),
      ensureForeshadowingCleanupQueueActive(project.id, project.path),
    ]).then(refresh).catch((err) => { console.error("[Maintenance] 恢复维护队列失败：", err) })
    const id = setInterval(refresh, 500)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [project?.id, project?.path, refreshTasks])

  const effectiveDetectConfig = useMemo(
    () =>
      detectModelId.trim()
        ? resolveModelConfig(detectModelId, llmConfig, providerConfigs)
        : resolveDefaultModel(llmConfig),
    [detectModelId, llmConfig, providerConfigs],
  )
  const selectedMergeModelId = mergeModelId.trim() || detectModelId.trim() || undefined
  const effectiveMergeConfig = useMemo(
    () => selectedMergeModelId
      ? resolveModelConfig(selectedMergeModelId, llmConfig, providerConfigs)
      : resolveDefaultModel(llmConfig),
    [selectedMergeModelId, llmConfig, providerConfigs],
  )
  const jevConfig = useWikiStore(state => state.jevConfig)
  const jevLoadError = useWikiStore(state => state.jevConfigLoadError)
  const detectLlmReady = hasUsableLlm(effectiveDetectConfig, providerConfigs)
  const mergeLlmReady = modelsHydrated && hasUsableLlm(effectiveMergeConfig, providerConfigs)
  const llmReady = !jevLoadError && (!!jevConfig || detectLlmReady)
  const projectReady = !!project
  const activeScanState = useMemo(() => {
    if (!project) return emptyScanState
    if (localScanState && scanStateBelongsToProject(localScanState, project)) {
      return localScanState
    }
    if (scanStateBelongsToProject(scanState, project)) {
      return scanState
    }
    return emptyScanState
  }, [project, localScanState, scanState])
  const manualReview = activeScanState.manualReview ?? []
  const reviewPage = useReviewPage(manualReview.length)
  const scanning = isScanning || activeScanState.scanning
  const { scanError, groups, scanCompleted, scannedPageCount } = activeScanState

  const applyScanState = useCallback(
    (patch: Partial<MaintenanceScanState>, options?: { persist?: boolean }) => {
      setSharedScanState(patch)
      const next = { ...sharedScanState }
      setLocalScanState({ ...next })
      if (
        options?.persist !== false &&
        project &&
        next.projectId === project.id &&
        next.scanCompleted &&
        !next.scanning
      ) {
        void saveDedupScanCache(
          project.path,
          toScanCache(next, project.id, detectModelId, mergeModelId),
        ).catch((err) => {
          console.error("[Maintenance] save scan cache failed:", err)
        })
      }
    },
    [project, detectModelId, mergeModelId],
  )

  const removeMergedGroup = useCallback(
    (projectId: string, slugs: readonly string[]) => {
      if (sharedScanState.projectId !== projectId) return
      refreshTasks()
      const key = groupKey(slugs)
      const remaining = sharedScanState.groups.filter((g) => groupKey(g.group.slugs) !== key)
      if (remaining.length === sharedScanState.groups.length) return
      applyScanState({ groups: remaining })
    },
    [applyScanState, refreshTasks],
  )

  // Keep a live bridge so the merge queue can drop cards while this
  // section is mounted (and disk cache is always updated by the queue).
  useEffect(() => {
    registerDedupScanSessionApi({ removeGroup: removeMergedGroup })
    return () => registerDedupScanSessionApi(null)
  }, [removeMergedGroup])

  useEffect(() => {
    if (!project) return
    return onDedupMergeComplete((task) => {
      if (task.projectId !== project.id) return
      // Session API already removes the group; refresh queue chips.
      refreshTasks()
    })
  }, [project?.id, refreshTasks])

  const handleScan = useCallback(async () => {
    if (!project) return
    const projectPath = normalizeProjectPath(project.path)
    const projectId = project.id

    if (jevLoadError || (!jevConfig && !hasUsableLlm(effectiveDetectConfig, providerConfigs))) {
      applyScanState({
        projectId,
        projectPath,
        scanning: false,
        scanError: jevLoadError || t("settings.sections.maintenance.dedup.selectDetectModel", {
          defaultValue: "请先选择检测模型。",
        }),
        groups: [],
        scanCompleted: false,
        scannedPageCount: null,
      })
      return
    }

    if (activeScan?.projectId === projectId) return
    activeScan?.controller.abort()
    const controller = new AbortController()
    activeScan = { projectId, controller }
    const appendScanLog = (message: string) => {
      if (activeScan?.controller !== controller) return
      setSharedScanState({ progress: message })
      const stamp = new Date().toLocaleTimeString()
      const line = `${stamp}  ${message}`
      setScanLogs((prev) => [...prev, line])
      console.log(`[Maintenance Dedup] ${message}`)
    }

    setIsScanning(true)
    setScanStage("loading")
    setScanLogs([])
    appendScanLog(
      jevConfig ? `SAG2 决策模型：${jevConfig.model}` : detectModelId.trim()
        ? `检测模型 id：${detectModelId.trim()}`
        : "未选择检测模型 id，使用默认模型",
    )
    appendScanLog(
      mergeModelId.trim()
        ? `合并模型 id：${mergeModelId.trim()}（入队时使用）`
        : "未单独设置合并模型，入队时回退检测模型",
    )
    applyScanState({
      projectId,
      projectPath,
      scanning: true,
      coverage: undefined,
      manualReview: undefined,
      progress: undefined,
      scanError: null,
      groups: [],
      scanCompleted: false,
      scannedPageCount: null,
    })
    try {
      const { groups: detected, scannedPageCount, coverage, manualReview } = await runDuplicateDetection(
        projectPath,
        effectiveDetectConfig,
        {
          signal: controller.signal,
          onProgress: setScanStage,
          onLog: appendScanLog,
        },
      )
      if (activeScan?.controller !== controller) return
      applyScanState({
        projectId,
        projectPath,
        scanning: false,
        coverage,
        manualReview,
        groups: detected.map((g) => ({
          group: g,
          canonicalSlug: g.slugs[0],
          skipped: false,
        })),
        scanCompleted: true,
        scannedPageCount,
      })
    } catch (err) {
      if (activeScan?.controller !== controller) return
      const message = err instanceof Error ? err.message : String(err)
      appendScanLog(`失败：${message}`)
      applyScanState({
        projectId,
        projectPath,
        scanning: false,
        scanError: message,
        scanCompleted: false,
        scannedPageCount: null,
      })
    } finally {
      if (activeScan?.controller === controller) {
        activeScan = undefined
        setIsScanning(false)
        setScanStage(null)
      }
    }
  }, [
    project,
    jevConfig,
    jevLoadError,
    effectiveDetectConfig,
    providerConfigs,
    t,
    applyScanState,
    detectModelId,
    mergeModelId,
  ])

  const handleCanonicalChange = useCallback(
    (entry: GroupUiEntry, slug: string) => {
      applyScanState({ groups: sharedScanState.groups.map((g) => g === entry ? { ...g, canonicalSlug: slug } : g) })
    },
    [applyScanState],
  )

  const handleEnqueue = async (entries: GroupUiEntry[], batch: boolean) => {
    if (!project || !entries.length || submitting.current) return
    if (!mergeLlmReady) {
      toast.error(t("settings.sections.maintenance.dedup.selectMergeModel", { defaultValue: "请先选择合并模型。" }))
      return
    }
    const currentProject = () =>
      useWikiStore.getState().project?.id === project.id && scanStateBelongsToProject(sharedScanState, project)
    const keys = new Set(entries.map(({ group }) => groupKey(group.slugs)))
    submitting.current = true
    setEnqueueingKeys(keys)
    try {
      if (batch) {
        const counts = { high: 0, medium: 0, low: 0 }
        for (const { group } of entries) counts[group.confidence]++
        const confirmed = await confirmAction(
          `将合并选中的 ${entries.length} 组候选（高 ${counts.high}、中 ${counts.medium}、低 ${counts.low}）。\n` +
          "模型会从每组现有条目中选择主条目，合并正文并更新引用。确认加入队列？",
        )
        if (!confirmed) return
      }
      if (!currentProject()) return
      const slugs = [...new Set(entries.flatMap(({ group }) => group.slugs))]
      const missing = new Set(await missingDedupSlugs(project.path, slugs))
      if (!currentProject()) return
      const current = new Set(sharedScanState.groups.filter((g) => !g.skipped).map((g) => g.group))
      const ready: GroupUiEntry[] = []
      const staleGroups = new Set<GroupUiEntry["group"]>()
      for (const entry of entries) {
        if (!current.has(entry.group)) continue
        if (entry.group.slugs.some((slug) => missing.has(slug))) staleGroups.add(entry.group)
        else ready.push(entry)
      }
      if (staleGroups.size) {
        applyScanState({ groups: sharedScanState.groups.filter(({ group }) => !staleGroups.has(group)) })
        toast.info(`${staleGroups.size} 组候选的页面已不存在，已从列表移除。`)
      }
      if (!ready.length) return
      if (batch) {
        const added = await enqueueMergeBatch(project.id, ready.map(({ group }) => group), selectedMergeModelId)
        if (currentProject()) toast.success(`${added} 组已加入合并队列。`)
      } else {
        await enqueueMerge(project.id, ready[0].group, ready[0].canonicalSlug, selectedMergeModelId)
      }
      refreshTasks()
      setMergeErrors((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => !keys.has(key))))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (currentProject()) {
        if (!batch) setMergeErrors((previous) => ({ ...previous, [groupKey(entries[0].group.slugs)]: message }))
        toast.error(`加入合并队列失败：${message}`)
      }
    } finally {
      submitting.current = false
      setEnqueueingKeys(null)
    }
  }

  const handleCancel = useCallback(async (taskId: string) => {
    try { await cancelTask(taskId) } catch (error) { toast.error(`取消合并失败：${String(error)}`) }
    refreshTasks()
  }, [refreshTasks])

  const handleRetry = useCallback(async (taskId: string) => {
    if (!mergeLlmReady) return
    try { await retryTask(taskId, selectedMergeModelId) } catch (error) { toast.error(`继续合并失败：${String(error)}`) }
    refreshTasks()
  }, [refreshTasks, mergeLlmReady, selectedMergeModelId])

  async function handleQueueAction(action: "resume" | "cancel") {
    if (!project || submitting.current) return
    submitting.current = true
    setQueueAction(action)
    try {
      if (action === "cancel") await cancelAllMerges(project.id)
      else await resumePausedMerges(project.id, selectedMergeModelId)
    } catch (error) {
      toast.error(`更新合并队列失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      submitting.current = false
      setQueueAction(null)
      refreshTasks()
      setMergeProgress(getMergeProgress())
      setMergeLogs(getMergeLogs())
    }
  }

  const handleNotDuplicate = useCallback(
    async (entry: GroupUiEntry) => {
      if (!project) return
      try {
        await addNotDuplicate(project.path, entry.group.slugs)
        if (useWikiStore.getState().project?.id !== project.id || !scanStateBelongsToProject(sharedScanState, project)) return
        applyScanState({ groups: sharedScanState.groups.map((g) => g.group === entry.group ? { ...g, skipped: true } : g) })
      } catch (err) {
        toast.error(`标记失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [project, applyScanState],
  )

  const visibleGroups = useMemo(() => groups.filter((entry) => !entry.skipped), [groups])
  const tasksByGroup = useMemo(() => new Map(tasks.map((task) => [groupKey(task.group.slugs), task])), [tasks])
  const pausedCount = useMemo(() => tasks.filter((task) => task.status === "awaiting_resume").length, [tasks])
  const failedCount = useMemo(() => tasks.filter(task => task.status === "failed").length, [tasks])
  const activeTask = useMemo(() => tasks.find(task => task.status === "processing"), [tasks])
  const stage = activeTask?.id === mergeProgress?.taskId ? mergeProgress?.stage : undefined
  const total = tasks.length + mergeCounts.merged + mergeCounts.skipped + mergeCounts.cancelled
  const percent = total ? Math.floor(mergeCounts.merged * 100 / total) : 0
  const waiting = tasks.length - failedCount - pausedCount - Number(!!activeTask)
  const stageText = queueAction === "cancel" ? "正在取消合并…"
    : activeTask ? (stage === "merging" ? `等待模型回复（本次请求 ${mergeProgress?.requestGroups ?? 1} 组）`
      : stage === "writing" ? "正在备份并写入文件" : "正在读取页面")
    : waiting ? "等待开始下一组"
    : pausedCount ? "等待手动继续"
    : failedCount ? "等待重试失败组"
    : mergeCounts.cancelled ? "本轮已结束" : "本轮处理完毕"
  const controlsBusy = queueAction !== null || enqueueingKeys !== null

  // Pending position helper: "queued (N ahead)" — count pending tasks
  // before this one in arrival order.
  const pendingPositionByTaskId = useMemo(() => {
    const positions = new Map<string, number>()
    let position = 0
    for (const t of tasks) {
      if (t.status === "pending") {
        positions.set(t.id, position)
        position++
      }
    }
    return positions
  }, [tasks])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.maintenance.title", { defaultValue: "维护工具" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.maintenance.description", {
            defaultValue:
              "用于维护写作记忆与资料库：从来源清理重复、噪声记忆，同步派生文档，并检测和合并重复实体/概念。",
          })}
        </p>
      </div>

      <MemoryCleanupTool />
      {legacyCleanupTasks.length > 0 && (
        <section className="space-y-2 rounded-lg border border-border/60 p-3">
          <h3 className="text-sm font-semibold">旧版伏笔清理任务</h3>
          <p className="text-xs text-muted-foreground">继续清理会更新伏笔的来源记录。</p>
          {legacyCleanupTasks.map((task) => (
            <div key={task.id} className="flex flex-wrap items-center gap-2 text-xs">
              <span>{task.issue.ids.join("、")} · {task.issue.reason}</span>
              {task.status === "awaiting_resume" || task.status === "failed" ? (
                <Button size="sm" onClick={() => void retryForeshadowingCleanupTask(task.id).catch((err) => toast.error(String(err)))}>
                  {task.status === "awaiting_resume" ? "继续清理" : "重试"}
                </Button>
              ) : <span>{task.status === "processing" ? "清理中" : "已排队"}</span>}
              <Button variant="ghost" size="sm" onClick={() => void cancelForeshadowingCleanupTask(task.id).catch((err) => toast.error(String(err)))}>移除任务</Button>
              {task.status === "failed" && <span>{task.error}</span>}
            </div>
          ))}
        </section>
      )}

      <ContextCacheMaintenance />

      <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">
            {t("settings.sections.maintenance.dedup.title", {
              defaultValue: "检测重复实体 / 概念",
            })}
          </h3>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("settings.sections.maintenance.dedup.description", {
            defaultValue:
              "分批复核名称不同、可能属于同一人物或概念的条目。配置 JEV 后，SAG 检索相关条目并根据双方原文复核身份。每组由你确认后才进入合并队列。",
          })}
        </p>

        {/* 小说写作场景详细说明 */}
        <NovelScenarioHelp />

        {!projectReady && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t("settings.sections.maintenance.noProject", {
              defaultValue: "请先打开一个项目。",
            })}
          </p>
        )}
        {projectReady && jevLoadError && (
          <p role="alert" className="text-xs text-destructive">{jevLoadError}</p>
        )}
        {projectReady && !jevLoadError && !jevConfig && !hasAvailableModels && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t("settings.sections.maintenance.dedup.noModel", {
              defaultValue: "请先在「设置 → 大语言模型」中添加并启用一个模型。",
            })}
          </p>
        )}
        {projectReady && !jevLoadError && !jevConfig && hasAvailableModels && !detectLlmReady && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {detectModelId.trim()
              ? t("settings.sections.maintenance.noLlm", {
                  defaultValue: "请先配置大模型提供方。",
                })
              : t("settings.sections.maintenance.dedup.selectDetectModel", {
                  defaultValue: "请先选择检测模型。",
                })}
          </p>
        )}
        {projectReady && hasAvailableModels && detectLlmReady && !mergeLlmReady && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t("settings.sections.maintenance.dedup.selectMergeModel", {
              defaultValue: "请先选择合并模型。",
            })}
          </p>
        )}

        {projectReady && hasAvailableModels && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">
                {t("settings.sections.maintenance.dedup.detectModelLabel", {
                  defaultValue: "检测模型",
                })}
              </Label>
              <ChatModelSelector
                value={detectModelId}
                onChange={setDetectModelId}
                disabled={scanning || !!jevConfig}
              />
              <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
                {jevConfig ? `当前使用 SAG2 决策模型 ${jevConfig.model} 复核候选。` : t("settings.sections.maintenance.dedup.detectModelHint", {
                  defaultValue: "扫描分组用。实体多时上下文更大，建议用更强、上下文更长的模型。",
                })}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">
                {t("settings.sections.maintenance.dedup.mergeModelLabel", {
                  defaultValue: "合并模型",
                })}
              </Label>
              <ChatModelSelector
                value={mergeModelId}
                onChange={setMergeModelId}
                disabled={scanning}
              />
              <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
                {t("settings.sections.maintenance.dedup.mergeModelHint", {
                  defaultValue: "写合并正文用。输入通常更短，可用相对便宜的模型。",
                })}
              </p>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => void handleScan()}
            disabled={scanning || controlsBusy || !projectReady || !llmReady}
          >
            {scanning ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("settings.sections.maintenance.dedup.scanning", {
                  defaultValue: "扫描中...",
                })}
              </>
            ) : (
              t("settings.sections.maintenance.dedup.scanButton", {
                defaultValue: "开始扫描重复项",
              })
            )}
          </Button>
          {scanning && activeScan?.projectId === project?.id && (
            <Button variant="outline" onClick={() => activeScan?.controller.abort()}>取消扫描</Button>
          )}
        </div>
        {scanning && (
          <div className="flex items-start gap-1.5 rounded border border-border/60 bg-background/80 px-2 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
            <div>
              {scanState.progress || (scanStage === "loading"
                ? t("settings.sections.maintenance.dedup.scanStageLoading", {
                    defaultValue: "正在读取实体 / 概念页面…",
                  })
                : scanStage === "detecting"
                  ? t("settings.sections.maintenance.dedup.scanStageDetecting", {
                      defaultValue: "正在调用模型分析…",
                    })
                  : t("settings.sections.maintenance.dedup.scanningHint", {
                      defaultValue:
                        "正在扫描实体 / 概念页面并调用模型分析，可能需要一会儿…",
                    }))}
            </div>
          </div>
        )}

        {(scanning || scanLogs.length > 0) && (
          <ProcessLogPanel
            title={t("settings.sections.maintenance.dedup.processLogTitle", {
              defaultValue: "分析过程日志",
            })}
            lines={scanLogs}
            live={scanning}
          />
        )}

        {scanError && (
          <div className="flex items-start gap-1.5 rounded border border-rose-500/40 bg-rose-500/5 px-2 py-1.5 text-xs text-rose-700 dark:text-rose-400">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>{scanError}</div>
          </div>
        )}

        {scanCompleted && activeScanState.coverage && (
          <p className="text-xs text-muted-foreground">{activeScanState.coverage}</p>
        )}
        {scanCompleted && manualReview.length > 0 && (
          <details className="space-y-2 text-xs">
            <summary>证据不足，需人工核对（{manualReview.length} 对）</summary>
            <ul className="space-y-2 whitespace-pre-line">{manualReview.slice(reviewPage.start, reviewPage.end).map((note, i) => (
              <li key={reviewPage.start + i}>{note}</li>
            ))}</ul>
            <ReviewPageNav {...reviewPage} />
          </details>
        )}
        {scanCompleted && visibleGroups.length > 0 && !scanError && (
          <div className="flex items-start gap-1.5 rounded border border-sky-500/40 bg-sky-500/5 px-2 py-1.5 text-xs text-sky-800 dark:text-sky-300">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              {t("settings.sections.maintenance.dedup.groupsFound", {
                count: visibleGroups.length,
                defaultValue: "发现 {{count}} 组重复候选，请在下方确认是否合并。",
              })}
            </div>
          </div>
        )}

        {scanCompleted && scannedPageCount !== null && scannedPageCount < 2 && !scanError && (
          <div className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              {t("settings.sections.maintenance.dedup.insufficientPages", {
                count: scannedPageCount,
                defaultValue: "至少需要 2 个实体 / 概念页面才能检测重复，当前只有 {{count}} 个。",
              })}
            </div>
          </div>
        )}

        {scanCompleted && manualReview.length === 0 && visibleGroups.length === 0 && groups.length === 0 && !scanError && scannedPageCount !== null && scannedPageCount >= 2 && (
          <div className="flex items-start gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/5 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              {t("settings.sections.maintenance.dedup.noneFound", {
                defaultValue: "本次检测未发现重复候选。",
              })}
            </div>
          </div>
        )}
      </div>

      {(total > 0 || queueAction) && (
        <section aria-label="合并队列" className="space-y-2 rounded-lg border border-border/60 p-3">
          <div className="flex min-h-8 flex-wrap items-center gap-2">
            <h3 className="mr-auto text-sm font-semibold">本轮合并进度</h3>
            {pausedCount > 0 && (
              <Button size="sm" disabled={controlsBusy || !mergeLlmReady} onClick={() => void handleQueueAction("resume")}>
                继续合并（{pausedCount} 组）
              </Button>
            )}
            {tasks.length > 0 && (
              <Button size="sm" variant="outline" disabled={controlsBusy} onClick={() => void handleQueueAction("cancel")}>
                取消全部合并
              </Button>
            )}
          </div>
          <div className="flex justify-between gap-2 text-sm tabular-nums">
            <span>已合并 {mergeCounts.merged} / {total} 组</span>
            <span>{percent}%</span>
          </div>
          <progress aria-label="已合并组数" value={mergeCounts.merged} max={total || 1}
            className="block h-2 w-full overflow-hidden rounded-full bg-muted accent-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary" />
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="truncate" title={activeTask?.group.slugs.join("、")}>
              {stageText}{activeTask && ` · ${activeTask.group.slugs.join("、")}`}
            </span>
            {stage === "merging" && mergeProgress?.requestedAt && (
              <ModelWaitTime key={mergeProgress.requestedAt} since={mergeProgress.requestedAt} />
            )}
          </div>
          <p className="text-xs tabular-nums text-muted-foreground">
            {[
              `排队 ${waiting} 组`,
              pausedCount > 0 && `${pausedCount} 组已暂停`,
              failedCount > 0 && `失败 ${failedCount} 组`,
              mergeCounts.skipped > 0 && `已跳过 ${mergeCounts.skipped} 组`,
              mergeCounts.cancelled > 0 && `已取消 ${mergeCounts.cancelled} 组`,
            ].filter(Boolean).join(" · ")}
          </p>
        </section>
      )}

      <QueueOrphanList
        tasks={tasks}
        busy={controlsBusy}
        mergeReady={mergeLlmReady}
        groups={groups}
        mergeProgress={mergeProgress}
        onCancel={(id) => void handleCancel(id)}
        onRetry={(id) => void handleRetry(id)}
        pendingPositionByTaskId={pendingPositionByTaskId}
      />

      {(mergeLogs.length > 0 || tasks.some(task => task.status === "processing" || task.status === "pending")) && (
        <ProcessLogPanel
          fixedHeight
          title={t("settings.sections.maintenance.dedup.mergeLogTitle", {
            defaultValue: "合并过程日志",
          })}
          lines={mergeLogs}
          live={!!mergeProgress}
        />
      )}

      {visibleGroups.length > 0 && (
        <DedupReviewList
          key={project?.id}
          entries={visibleGroups}
          queued={tasksByGroup}
          busy={controlsBusy}
          mergeReady={mergeLlmReady}
          onBatchMerge={(entries) => void handleEnqueue(entries, true)}
          renderCard={(entry, key, checkbox) => {
            const task = tasksByGroup.get(key)
            return (
              <DuplicateGroupCard
                key={key}
                entry={entry}
                checkbox={checkbox}
                task={task}
                mergeProgress={mergeProgress}
                enqueueing={enqueueingKeys?.has(key) ?? false}
                busy={controlsBusy}
                mergeReady={mergeLlmReady}
                mergeError={mergeErrors[key] ?? null}
                pendingPosition={task ? pendingPositionByTaskId.get(task.id) ?? 0 : 0}
                onCanonicalChange={(slug) => handleCanonicalChange(entry, slug)}
                onEnqueue={() => void handleEnqueue([entry], false)}
                onCancel={() => task && void handleCancel(task.id)}
                onRetry={() => task && void handleRetry(task.id)}
                onNotDuplicate={() => void handleNotDuplicate(entry)}
              />
            )
          }}
        />
      )}
    </div>
  )
}

// --- helpers ---------------------------------------------------------------

function ModelWaitTime({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  return <span className="shrink-0 tabular-nums text-muted-foreground">已等待 {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>
}

function ProcessLogPanel({
  title,
  lines,
  live,
  fixedHeight,
}: {
  title: string
  lines: readonly string[]
  live?: boolean
  fixedHeight?: boolean
}) {
  return (
    <div className="space-y-1.5 rounded border border-border/60 bg-background/80 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[0.6875rem] font-medium text-muted-foreground">
        {live ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        <span>{title}</span>
      </div>
      <pre className={`${fixedHeight ? "h-40" : "max-h-40"} overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 px-2 py-1.5 font-mono text-[0.6875rem] leading-relaxed text-foreground/90`}>
        {lines.length > 0
          ? lines.join("\n")
          : "…"}
      </pre>
    </div>
  )
}

interface QueueOrphanListProps {
  mergeReady: boolean
  busy: boolean
  tasks: readonly DedupTask[]
  groups: GroupUiEntry[]
  mergeProgress: { taskId: string; stage: DedupMergeStage } | null
  onCancel: (taskId: string) => void
  onRetry: (taskId: string) => void
  pendingPositionByTaskId: Map<string, number>
}

/**
 * Render queued tasks that don't have a matching card on screen. This
 * happens after the user closes the Maintenance pane and re-opens it,
 * or after an app restart with pending tasks: those tasks are real
 * but the user hasn't re-scanned, so without this list they'd be
 * invisible.
 */
function QueueOrphanList({
  mergeReady,
  tasks,
  busy,
  groups,
  mergeProgress,
  onCancel,
  onRetry,
  pendingPositionByTaskId,
}: QueueOrphanListProps) {
  const { t } = useTranslation()
  const groupKeys = useMemo(() => new Set(groups.map((g) => groupKey(g.group.slugs))), [groups])
  const orphans = useMemo(() => tasks.filter((t) => !groupKeys.has(groupKey(t.group.slugs))), [tasks, groupKeys])
  const pagination = useReviewPage(orphans.length)

  if (orphans.length === 0) return null

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-muted/10 p-4">
      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">
          {t("settings.sections.maintenance.dedup.queueTitle", {
            defaultValue: "进行中的合并任务",
          })}
        </h3>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("settings.sections.maintenance.dedup.queueDescription", {
          defaultValue:
            "这里显示上一次扫描后仍未完成的任务。合并会逐个排队执行。",
        })}
      </p>
      <ReviewPageNav {...pagination} />
      {orphans.slice(pagination.start, pagination.end).map((task) => (
        <div
          key={task.id}
          className="flex flex-wrap items-center gap-2 rounded border border-border/40 bg-background px-3 py-2 text-xs"
        >
          <code className="font-mono">{task.group.slugs.join(" + ")}</code>
          <span className="text-muted-foreground">
            →{" "}
            <code className="font-mono">{task.canonicalSlug ?? "由模型选择主条目"}</code>
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            <TaskStatusChip
              task={task}
              pendingPosition={pendingPositionByTaskId.get(task.id) ?? 0}
              mergeStage={
                mergeProgress?.taskId === task.id ? mergeProgress.stage : null
              }
            />
            {(task.status === "failed" || task.status === "awaiting_resume") && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !mergeReady}
                onClick={() => onRetry(task.id)}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {task.status === "awaiting_resume" ? "继续合并" : t("settings.sections.maintenance.dedup.retry", {
                  defaultValue: "重试",
                })}
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onCancel(task.id)}>
              <Trash2 className="h-3.5 w-3.5" />
              {t("settings.sections.maintenance.dedup.delete", {
                defaultValue: "删除",
              })}
            </Button>
          </span>
          {task.error && task.status === "failed" && (
            <div className="basis-full rounded border border-rose-500/40 bg-rose-500/5 px-2 py-1 text-rose-700 dark:text-rose-400">
              {task.error}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

interface ChipProps {
  task: DedupTask
  pendingPosition: number
  mergeStage?: DedupMergeStage | null
}

function mergeStageLabel(
  stage: DedupMergeStage,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  switch (stage) {
    case "loading":
      return t("settings.sections.maintenance.dedup.mergeStageLoading", {
        defaultValue: "正在读取 wiki…",
      })
    case "merging":
      return t("settings.sections.maintenance.dedup.mergeStageMerging", {
        defaultValue: "正在合并内容（LLM）…",
      })
    case "writing":
      return t("settings.sections.maintenance.dedup.mergeStageWriting", {
        defaultValue: "正在写入文件…",
      })
  }
}

function TaskStatusChip({ task, pendingPosition, mergeStage }: ChipProps) {
  const { t } = useTranslation()
  if (task.status === "processing") {
    const label =
      mergeStage != null
        ? mergeStageLabel(mergeStage, t)
        : t("settings.sections.maintenance.dedup.merging", {
            defaultValue: "合并中...",
          })
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase text-amber-700 dark:text-amber-400">
        <Loader2 className="h-3 w-3 animate-spin" />
        {label}
      </span>
    )
  }
  if (task.status === "awaiting_resume") {
    return <span className="text-xs text-muted-foreground">已暂停，等待继续</span>
  }
  if (task.status === "pending") {
    if (pendingPosition === 0) {
      return (
        <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase text-muted-foreground">
          {t("settings.sections.maintenance.dedup.queued", {
            defaultValue: "已排队",
          })}
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase text-muted-foreground">
        {t("settings.sections.maintenance.dedup.queuedAhead", {
          defaultValue: "已排队（前方还有 {{n}} 项）",
          n: pendingPosition,
        })}
      </span>
    )
  }
  if (task.status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-rose-500/15 px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase text-rose-700 dark:text-rose-400">
        <AlertTriangle className="h-3 w-3" />
        {t("settings.sections.maintenance.dedup.failed", {
          defaultValue: "失败（{{retries}}/3）",
          retries: task.retryCount,
        })}
      </span>
    )
  }
  return null
}

interface CardProps {
  checkbox: ReactNode
  busy: boolean
  entry: GroupUiEntry
  task: DedupTask | undefined
  mergeProgress: { taskId: string; stage: DedupMergeStage } | null
  enqueueing: boolean
  mergeReady: boolean
  mergeError: string | null
  pendingPosition: number
  onCanonicalChange: (slug: string) => void
  onEnqueue: () => void
  onCancel: () => void
  onRetry: () => void
  onNotDuplicate: () => void
}

function DuplicateGroupCard({
  checkbox,
  busy,
  entry,
  task,
  mergeProgress,
  enqueueing,
  mergeReady,
  mergeError,
  pendingPosition,
  onCanonicalChange,
  onEnqueue,
  onCancel,
  onRetry,
  onNotDuplicate,
}: CardProps) {
  const { t } = useTranslation()
  const { group, canonicalSlug, skipped } = entry

  const inFlight = !!task && (task.status === "pending" || task.status === "processing")
  const failed = !!task && task.status === "failed"
  const awaitingResume = task?.status === "awaiting_resume"
  const finished = skipped

  const confidenceClass =
    group.confidence === "high"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
      : group.confidence === "medium"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
        : "bg-muted text-muted-foreground"

  return (
    <div
      className={`space-y-3 rounded-lg border px-4 py-3 ${
        finished ? "border-border/40 bg-muted/10 opacity-60" : "border-border bg-background"
      }`}
    >
      <div className="flex items-center gap-2">
        {checkbox}
        <span className={`rounded px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase ${confidenceClass}`}>
          {confidenceLabels[group.confidence]}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("settings.sections.maintenance.dedup.candidates", {
            defaultValue: "{{n}} 个候选",
            n: group.slugs.length,
          })}
        </span>
        {skipped && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
            {t("settings.sections.maintenance.dedup.skipped", { defaultValue: "已标记为不重复" })}
          </span>
        )}
        {task && !finished && (
          <span className="ml-auto">
            <TaskStatusChip
              task={task}
              pendingPosition={pendingPosition}
              mergeStage={
                mergeProgress?.taskId === task.id ? mergeProgress.stage : null
              }
            />
          </span>
        )}
      </div>

      {group.reason && (
        <div className="whitespace-pre-line text-xs italic leading-relaxed text-muted-foreground">{group.reason}</div>
      )}

      {!finished && (
        <>
          <div className="space-y-1.5">
            <Label className="text-xs">
              {task?.canonicalSlug === null ? "模型将从以下条目中选择主条目" : "单组合并时保留的主条目"}
            </Label>
            {group.slugs.map((slug) => (
              <label
                key={slug}
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent"
              >
                <input
                  type="radio"
                  name={`canonical-${groupKey(group.slugs)}`}
                  checked={task ? task.canonicalSlug === slug : canonicalSlug === slug}
                  onChange={() => onCanonicalChange(slug)}
                  disabled={busy || !!task}
                />
                <code className="font-mono text-xs">{slug}</code>
              </label>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {!task && (
              <>
                <Button size="sm" onClick={onEnqueue} disabled={busy || !mergeReady}>
                  {enqueueing ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {t("settings.sections.maintenance.dedup.enqueueing", {
                        defaultValue: "加入队列...",
                      })}
                    </>
                  ) : (
                    t("settings.sections.maintenance.dedup.mergeButton", {
                      defaultValue: "合并到 {{slug}}",
                      slug: canonicalSlug,
                    })
                  )}
                </Button>
                <Button size="sm" variant="ghost" onClick={onNotDuplicate} disabled={busy}>
                  {t("settings.sections.maintenance.dedup.notDuplicates", {
                    defaultValue: "不是重复",
                  })}
                </Button>
              </>
            )}
            {inFlight && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
                <Trash2 className="h-3.5 w-3.5" />
                {t("settings.sections.maintenance.dedup.cancel", {
                  defaultValue: "取消",
                })}
              </Button>
            )}
            {(failed || awaitingResume) && (
              <>
                <Button size="sm" disabled={busy || !mergeReady} onClick={onRetry}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  {awaitingResume ? "继续合并" : t("settings.sections.maintenance.dedup.retry", {
                    defaultValue: "重试",
                  })}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("settings.sections.maintenance.dedup.delete", {
                    defaultValue: "删除",
                  })}
                </Button>
              </>
            )}
          </div>
        </>
      )}

      {mergeError && !task && (
        <div className="flex items-start gap-1.5 rounded border border-rose-500/40 bg-rose-500/5 px-2 py-1.5 text-xs text-rose-700 dark:text-rose-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>{mergeError}</div>
        </div>
      )}

      {failed && task?.error && (
        <div className="flex items-start gap-1.5 rounded border border-rose-500/40 bg-rose-500/5 px-2 py-1.5 text-xs text-rose-700 dark:text-rose-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>{task.error}</div>
        </div>
      )}
    </div>
  )
}

// ─── 小说写作场景详细说明 ───────────────────────────────────────────────────────

function NovelScenarioHelp() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <div className="rounded-md border border-border/40 bg-background/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <HelpCircle className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">
          {t("settings.sections.maintenance.dedup.novelHelpTitle", {
            defaultValue: "写小说的话，这个功能有什么用？",
          })}
        </span>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        )}
      </button>
      {open && (
        <div className="space-y-3 border-t border-border/40 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
          <p>
            {t("settings.sections.maintenance.dedup.novelHelpIntro", {
              defaultValue:
                "简单说：当你的角色库、设定库里出现了「同一个人/同一个东西有好几个页面」的情况，这个工具能帮你找出来并合并成一个。",
            })}
          </p>

          <div className="space-y-2">
            <div className="flex items-start gap-2">
              <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/70" />
              <div>
                <div className="font-medium text-foreground/80">
                  {t("settings.sections.maintenance.dedup.novelHelpExample1Title", {
                    defaultValue: "角色重复（最常见）",
                  })}
                </div>
                <p>
                  {t("settings.sections.maintenance.dedup.novelHelpExample1", {
                    defaultValue:
                      "比如 AI 一会儿叫「张三」、一会儿叫「张小三」、一会儿又叫「男主」，其实是同一个人。每出现一个新名字，就会多出一个角色页面。",
                  })}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2">
              <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/70" />
              <div>
                <div className="font-medium text-foreground/80">
                  {t("settings.sections.maintenance.dedup.novelHelpExample2Title", {
                    defaultValue: "设定/功法/地名重复",
                  })}
                </div>
                <p>
                  {t("settings.sections.maintenance.dedup.novelHelpExample2", {
                    defaultValue:
                      "比如「九阳神功」和「九阳真经」、「青云宗」和「青云派」，名字略有不同但说的是一回事，资料库会越攒越乱。",
                  })}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2">
              <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/70" />
              <div>
                <div className="font-medium text-foreground/80">
                  {t("settings.sections.maintenance.dedup.novelHelpHowTitle", {
                    defaultValue: "合并之后会怎样？",
                  })}
                </div>
                <ul className="list-disc space-y-0.5 pl-4">
                  <li>
                    {t("settings.sections.maintenance.dedup.novelHelpHow1", {
                      defaultValue: "两个页面的内容会合二为一，不会丢信息",
                    })}
                  </li>
                  <li>
                    {t("settings.sections.maintenance.dedup.novelHelpHow2", {
                      defaultValue: "所有章节里引用了旧名字的地方，会自动改成新名字，不会有死链",
                    })}
                  </li>
                  <li>
                    {t("settings.sections.maintenance.dedup.novelHelpHow3", {
                      defaultValue: "合并前会自动备份，合并错了也能恢复",
                    })}
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <p className="pt-1 text-[0.6875rem] text-muted-foreground/70">
            {t("settings.sections.maintenance.dedup.novelHelpTip", {
              defaultValue:
                "💡 小提示：扫描结果只是 AI 的猜测，需要你确认后才会真正合并。觉得不是重复的可以点「不是重复」，下次扫描就不会再出现了。",
            })}
          </p>
        </div>
      )}
    </div>
  )
}
