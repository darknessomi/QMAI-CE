import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { listen } from "@tauri-apps/api/event"
import { chooseMigrationAction, getMigrationView, migrationReturnLabel, subscribeMigration } from "@/lib/novel-migration"

export function NovelMigrationDialog() {
  const state = useSyncExternalStore(subscribeMigration, getMigrationView)
  const dialog = useRef<HTMLDialogElement>(null)
  const [exitAttempts, setExitAttempts] = useState(0)
  const visible = Boolean(state)
  useEffect(() => {
    if (!visible) return
    const element = dialog.current
    element?.showModal()
    const blockShortcut = (event: KeyboardEvent) => {
      const navigation = !event.ctrlKey && !event.metaKey && !event.altKey
        && (event.key === "Tab" || (event.target instanceof Node && element?.contains(event.target) && ["Enter", " "].includes(event.key)))
      if (navigation) return
      event.stopImmediatePropagation()
      event.preventDefault()
    }
    window.addEventListener("keydown", blockShortcut, true)
    const subscription = listen("novel-migration-exit-blocked", () => setExitAttempts((n) => n + 1))
    return () => {
      element?.close()
      window.removeEventListener("keydown", blockShortcut, true)
      void subscription.then((stop) => stop()).catch(() => undefined)
      setExitAttempts(0)
    }
  }, [visible])
  if (!state) return null
  return (
    <dialog ref={dialog} aria-labelledby="migration-title" onCancel={(event) => event.preventDefault()}
      className="fixed inset-0 m-auto w-[min(32rem,90vw)] rounded-lg border border-border bg-background p-6 text-foreground shadow-xl backdrop:bg-black/60">
      <h2 id="migration-title" className="text-lg font-semibold">正在迁移小说项目</h2>
      <p className="mt-2 break-all text-sm text-muted-foreground">{state.path}</p>
      <p className="mt-4" role="status">{state.stage}</p>
      {state.phase !== "failed" && (
        <progress aria-label="当前阶段进度" className="mt-2 w-full" max={state.total || undefined}
          value={state.total > 0 ? state.completed : undefined} />
      )}
      {state.total > 0 && <p className="text-sm">{state.completed} / {state.total}</p>}
      {state.detail && <p className="mt-2 break-words text-sm" role={state.phase === "failed" ? "alert" : undefined}>{state.detail}</p>}
      <p className="mt-4 text-sm">迁移完成前已锁定操作和退出。请勿强制退出、关机或移动项目文件，否则可能导致内容损坏。意外中断后，下次启动会检查并恢复。</p>
      {exitAttempts > 0 && <p role="alert" className="mt-2 text-sm">当前无法退出，请等待迁移或恢复完成。</p>}
      {state.phase === "failed" && (
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" className="rounded border px-3 py-1" onClick={() => chooseMigrationAction("retry")}>重试</button>
          {state.canLeave
            ? <button type="button" onClick={() => chooseMigrationAction("leave")}>{migrationReturnLabel()}</button>
            : <button type="button" onClick={() => chooseMigrationAction("rollback")}>恢复原项目</button>}
        </div>
      )}
    </dialog>
  )
}
