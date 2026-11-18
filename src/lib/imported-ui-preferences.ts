import { appDataDir, join } from "@tauri-apps/api/path"
import { readFile } from "@/commands/fs"
import { isTauri } from "@/lib/platform"
import { readGuideSnapshot, writeGuideSnapshot } from "@/lib/guide/guide-store"
import { THEME_KEY } from "@/lib/project-store"
import { getStore } from "@/lib/web-store"
import {
  UI_TEST_SKIN_KEY, normalizeUiTestSkin, writeUiTestSkin,
  writeUiTestAiHintDismissed, writeUiTestDirectoryHintDismissed,
} from "@/lib/ui-test"

const APPLIED = "qmai-ce-imported-ui-v1"

interface ImportRecord {
  imported: boolean
  skin?: unknown
  guide?: { status?: string; finishedAt?: number; stepIndex?: number } | null
}

export async function restoreImportedUiPreferences(): Promise<void> {
  if (!isTauri()) return
  const store = await getStore()
  if (localStorage.getItem(APPLIED)) {
    // 旧 CE 仅在 WebView 缓存记录迁移完成。
    if (!await store.get(APPLIED)) await store.set(APPLIED, true)
    return
  }
  const file = await join(await appDataDir(), ".original-config-imported-v1")
  const record: ImportRecord = JSON.parse(await readFile(file))
  // 旧后端的标记只是数字 1，留待新版后端补全。
  if (typeof record?.imported !== "boolean") return
  if (record.imported) await applyImportedUiPreferences(record, store)
  await store.set(APPLIED, true)
  await store.save()
  localStorage.setItem(APPLIED, "1")
}

async function applyImportedUiPreferences(record: ImportRecord, store: Awaited<ReturnType<typeof getStore>>): Promise<void> {
  const guide = readGuideSnapshot()
  const automaticFirstStep = guide.status === "running" && guide.stepIndex === 0
    && !guide.skippedChapters.length && !guide.finishedAt
  if (!await store.get(APPLIED)) {
    await restoreImportedSkin(record.skin, automaticFirstStep, store)
  }
  if (guide.status === "new" || automaticFirstStep) {
    const old = record.guide
    writeGuideSnapshot(old?.status === "done"
      ? { status: "done", finishedAt: old.finishedAt, stepIndex: old.stepIndex ?? 0, skippedChapters: [] }
      : { status: "off", stepIndex: 0, skippedChapters: [] })
  }
  writeUiTestDirectoryHintDismissed()
  writeUiTestAiHintDismissed()
}

async function restoreImportedSkin(value: unknown, automaticFirstStep: boolean, store: Awaited<ReturnType<typeof getStore>>): Promise<void> {
  const chosen = normalizeUiTestSkin(await store.get("uiTestSkin"))
  const local = localStorage.getItem(UI_TEST_SKIN_KEY)
  const importedSkin = normalizeUiTestSkin(value)
  let skin = normalizeUiTestSkin(local)
  if (chosen) {
    skin = chosen
  } else if (importedSkin && (!skin || (automaticFirstStep && local === "jing"))) {
    skin = importedSkin
  }
  if (skin) {
    writeUiTestSkin(skin)
    await store.set(THEME_KEY, skin)
  }
}
