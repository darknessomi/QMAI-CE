/**
 * Per-project preferences for duplicate-detection / merge models.
 * Kept separate from the scan-result cache so model choices survive
 * even when there is no completed scan yet.
 */
import { readFile, writeFileAtomic, fileExists } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { withProjectLock } from "./project-mutex"

const FILE_NAME = ".qmai/dedup-models.json"

interface DedupModelPrefs {
  detectModelId?: string
  mergeModelId?: string
}

function prefsFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${FILE_NAME}`
}

function parsePrefs(raw: unknown): DedupModelPrefs | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  const detectModelId =
    typeof obj.detectModelId === "string" ? obj.detectModelId.trim() || undefined : undefined
  const mergeModelId =
    typeof obj.mergeModelId === "string" ? obj.mergeModelId.trim() || undefined : undefined
  // Backward compat: older caches only had modelId (= detect).
  const legacy =
    typeof obj.modelId === "string" ? obj.modelId.trim() || undefined : undefined
  return {
    detectModelId: detectModelId || legacy,
    mergeModelId,
  }
}

export async function loadDedupModelPrefs(
  projectPath: string,
): Promise<DedupModelPrefs | null> {
  const filePath = prefsFilePath(projectPath)
  return withProjectLock(filePath, async () => {
    try {
      if (!(await fileExists(filePath))) return null
      return parsePrefs(JSON.parse(await readFile(filePath)))
    } catch {
      return null
    }
  })
}

export async function saveDedupModelPrefs(
  projectPath: string,
  prefs: DedupModelPrefs,
): Promise<void> {
  const payload: DedupModelPrefs = {
    detectModelId: prefs.detectModelId?.trim() || undefined,
    mergeModelId: prefs.mergeModelId?.trim() || undefined,
  }
  const path = prefsFilePath(projectPath)
  await withProjectLock(path, () => writeFileAtomic(path, JSON.stringify(payload, null, 2)))
}
