import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type {
  ForeshadowingImportance,
  ForeshadowingStatus,
} from "./tracking-types"

export interface Foreshadowing {
  manual?: boolean
  id: string
  name: string
  description: string
  status: ForeshadowingStatus
  plantedChapter: number
  advancedChapters: number[]
  resolvedChapter?: number
  relatedCharacters: string[]
  relatedEvents: string[]
  notes: string
  /** 预计回收章节 */
  expectedResolveChapter?: number
  /** 重要度 */
  importance?: ForeshadowingImportance
}

export interface ForeshadowingStore {
  items: Foreshadowing[]
  lastSerial?: number
  lastUpdated: string
}

export function createEmptyForeshadowingStore(): ForeshadowingStore {
  return { items: [], lastUpdated: new Date().toISOString() }
}

export async function loadForeshadowingTracker(
  projectPath: string,
): Promise<ForeshadowingStore> {
  const pp = normalizePath(projectPath)
  try {
    const raw = await readFile(`${pp}/.qmai/novel/foreshadowing-tracker.json`)
    return JSON.parse(raw)
  } catch {
    return createEmptyForeshadowingStore()
  }
}
