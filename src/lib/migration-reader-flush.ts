import { emitTo, listen } from "@tauri-apps/api/event"
import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window"

const REQUEST = "novel-migration-save-reader"
const RESPONSE = "novel-migration-reader-saved"

export async function registerMigrationReaderFlush(save: () => Promise<boolean>) {
  return listen<string>(REQUEST, async ({ payload: id }) => {
    let ok = false
    try { ok = await save() }
    finally {
      await emitTo("main", RESPONSE, { id, label: getCurrentWindow().label, ok })
    }
  })
}

export async function flushMigrationReaders() {
  const readers = (await getAllWindows()).filter((window) => window.label.startsWith("reader-"))
  if (!readers.length) return
  const id = crypto.randomUUID()
  const pending = new Set(readers.map((window) => window.label))
  let receive: (message: { id: string; label: string; ok: boolean }) => void = () => undefined
  const stop = await listen<Parameters<typeof receive>[0]>(RESPONSE, ({ payload }) => receive(payload))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const saved = new Promise<void>((resolve, reject) => {
      receive = (message) => {
        if (message.id !== id || !pending.delete(message.label)) return
        if (!message.ok) reject(new Error("独立编辑窗口有未保存的修改，请先处理保存冲突。"))
        else if (!pending.size) resolve()
      }
      timer = setTimeout(() => reject(new Error("独立编辑窗口未确认保存，迁移尚未开始。")), 15_000)
    })
    await Promise.all([saved, ...readers.map((window) => emitTo(window.label, REQUEST, id))])
  } finally {
    clearTimeout(timer)
    stop()
  }
}
