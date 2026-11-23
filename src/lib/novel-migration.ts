import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { isTauri } from "./platform"

export interface MigrationView {
  path: string
  phase: "preparing" | "running" | "failed"
  stage: string
  detail: string
  completed: number
  total: number
  canLeave: boolean
  ioFrozen?: boolean
}

type FailureAction = "retry" | "rollback" | "leave"

let current: MigrationView | null = null
const observers = new Set<() => void>()
let task: { path: string; promise: Promise<void> } | null = null
let answer: ((action: FailureAction) => void) | undefined

let returnToShelf: (() => Promise<void>) | undefined
let preserveCurrentEditor = false
export function setMigrationShelfReturn(callback?: () => Promise<void>) { returnToShelf = callback }
export function migrationReturnLabel() { return preserveCurrentEditor ? "返回原工作区" : "返回书架" }

export class MigrationReturned extends Error {}
export const getMigrationView = () => current
export function subscribeMigration(listener: () => void) {
  observers.add(listener)
  return () => { observers.delete(listener) }
}
function show(view: MigrationView | null) {
  current = view
  for (const listener of observers) listener()
}
export function chooseMigrationAction(action: FailureAction) {
  const resolve = answer
  if (!resolve || current?.phase !== "failed" || (action === "leave" && !current.canLeave)) return
  answer = undefined
  resolve(action)
}

async function flushBeforeMigration() {
  const { runPreCloseFlushes } = await import("./pre-close-flush")
  const { flushPendingChapterSave } = await import("./chapter-save-flush")
  const { flushAppState } = await import("./web-store")
  const { useWikiStore } = await import("@/stores/wiki-store")
  const project = useWikiStore.getState().project
  preserveCurrentEditor = Boolean(project)
  if (project) {
    const { useChatStore } = await import("@/stores/chat-store")
    const { useOutlineChatStore } = await import("@/stores/outline-chat-store")
    const chat = useChatStore.getState()
    const outline = useOutlineChatStore.getState()
    if (Object.keys(chat.streamingContents).length || Object.keys(outline.streamingContents).length) {
      throw new Error("当前项目仍有写作任务，等待任务结束后可重试。")
    }
    const { saveChatHistory } = await import("./persist")
    const { flushQueuedReviewBeforeMigration } = await import("./auto-save")
    await flushPendingChapterSave()
    if (chat.conversations.length) {
      await saveChatHistory(project.path, chat.conversations, chat.messages, chat.maxHistoryMessages, chat.runStates)
    }
    await flushQueuedReviewBeforeMigration(project.path)
    if (outline.loaded) await outline.saveToDisk()
  }
  if ((await runPreCloseFlushes()).failed > 0) throw new Error("仍有修改保存失败，请检查可用磁盘空间及写入权限。")
  await flushAppState()
  const { flushMigrationReaders } = await import("./migration-reader-flush")
  await flushMigrationReaders()
  preserveCurrentEditor = false
  if (project) {
    const [ingest, dedup, cleanup, watcher, scheduled] = await Promise.all([
      import("./ingest-queue"), import("./dedup-queue"), import("./foreshadowing-cleanup-queue"),
      import("./project-file-sync"), import("./scheduled-import"),
    ])
    scheduled.stopScheduledImport()
    await Promise.all([ingest.pauseQueue(), dedup.pauseQueue(), cleanup.pauseForeshadowingCleanupQueue(), watcher.stopProjectFileSync()])
  }
}

const status = () => invoke<MigrationView | null>("novel_migration_status")

async function migrate(view: MigrationView) {
  show(view)
  let prepared = Boolean(view.ioFrozen) || view.phase === "running"
  let rollback = false
  let stop: () => void
  try {
    stop = await listen<MigrationView | null>("novel-migration-state", ({ payload }) => show(payload))
  } catch {
    // 事件通道短暂不可用时仍能看到原生任务的实际状态。
    let listening = true
    const timer = setInterval(() => {
      void status().then((value) => { if (listening) show(value) }).catch(() => undefined)
    }, 500)
    stop = () => { listening = false; clearInterval(timer) }
  }
  try {
    // A reloaded webview can attach while the native worker is already running.
    let state = await status()
    while (state?.phase === "running") {
      show(state)
      await new Promise((resolve) => setTimeout(resolve, 250))
      state = await status()
    }
    while (state) {
      if (state.phase === "failed") {
        const action = await new Promise<FailureAction>((resolve) => {
          answer = resolve
          show(state)
        })
        if (action === "leave") {
          try {
            await invoke("leave_novel_migration")
          } catch (error) {
            state = await status()
            if (!state || state.phase !== "failed") throw error
            continue
          }
          if (!preserveCurrentEditor) await returnToShelf?.()
          throw new MigrationReturned("已离开迁移流程。")
        }
        rollback = action === "rollback"
      }
      show({ ...state, phase: "preparing", stage: rollback ? "正在恢复原项目" : "正在准备迁移", detail: "" })
      if (!prepared) {
        try {
          await flushBeforeMigration()
          prepared = true
        } catch (error) {
          await invoke("fail_novel_migration_preparation", { detail: String(error) })
          state = await status()
          continue
        }
      }
      try {
        const warnings = await invoke<string[]>("run_novel_migration", { rollback })
        if (warnings?.length) {
          const { toast } = await import("./toast")
          toast.info(warnings.join("\n"), { title: "项目已迁移，部分旧记录已跳过", persistent: true })
        }
      } catch (error) {
        state = await status()
        if (!state || state.phase !== "failed") throw error
        continue
      }
      if (rollback) {
        await returnToShelf?.()
        throw new MigrationReturned("已恢复项目，返回书架。")
      }
      return
    }
  } finally {
    stop()
    answer = undefined
    preserveCurrentEditor = false
    show(await status())
  }
}

export function ensureProjectMigrated(path: string): Promise<void> {
  if (!isTauri()) return Promise.resolve()
  if (task) {
    if (task.path === path) return task.promise
    return Promise.reject(new Error("正在检查或迁移另一个项目，请稍后重试。"))
  }
  const promise = invoke<MigrationView | null>("inspect_novel_migration", { path })
    .then((view) => view ? migrate(view) : undefined)
    .finally(() => { task = null })
  task = { path, promise }
  return promise
}

export async function restoreDesktopMigration(): Promise<string | null> {
  if (!isTauri()) return null
  const view = await status()
  if (!view) return null
  await ensureProjectMigrated(view.path)
  return view.path
}
