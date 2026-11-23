import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { StateChangeRecord } from "./tracking-types"

export interface CharacterState {
  /** 用户单独维护的记录。 */
  manual?: boolean
  /** 上次从快照得到的状态，用于保留用户随后改写的状态。 */
  generatedStatus?: string
  characterName: string
  currentLocation: string
  status: string
  equipment: string[]
  abilities: string[]
  relationships: Record<string, string>
  lastUpdatedChapter: number
  lastUpdatedAt: string
  /** 公众形象 */
  publicImage?: string
  /** 待回收伏笔ID列表 */
  pendingForeshadowing?: string[]
  /** 状态变更记录（最近10条） */
  stateChangeHistory?: StateChangeRecord[]
}

export interface CharacterStateStore {
  characters: CharacterState[]
  lastUpdated: string
}

export function createEmptyCharacterStateStore(): CharacterStateStore {
  return { characters: [], lastUpdated: new Date().toISOString() }
}

export async function loadCharacterStates(
  projectPath: string,
): Promise<CharacterStateStore> {
  const pp = normalizePath(projectPath)
  try {
    const raw = await readFile(`${pp}/.qmai/novel/character-states.json`)
    return JSON.parse(raw)
  } catch {
    return createEmptyCharacterStateStore()
  }
}

export function characterStatesToContextText(store: CharacterStateStore): string {
  if (store.characters.length === 0) return ""
  return store.characters
    .map(
      (c) =>
        `- ${c.characterName}：位于${c.currentLocation}，状态：${c.status}，装备：${c.equipment.join("、") || "无"}，能力：${c.abilities.join("、") || "无"}`,
    )
    .join("\n")
}