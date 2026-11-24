import { normalizeComparablePath, normalizePath } from "@/lib/path-utils"
import type { ProjectPathIndex } from "@/lib/wiki-page-resolver"
import { updatePersonaSkillIndex } from "./persona-skill-store"
import type { PersonaSkillMeta } from "./persona-skill-types"

/** 新引用按大纲相对路径匹配。旧文件名必须能在本书的大纲中唯一定位。 */
export function resolvePersonaOutlineRef(projectPath: string, ref: string, index: ProjectPathIndex): string | undefined {
  const root = `${normalizeComparablePath(projectPath)}/wiki/outlines/`
  const name = ref.split("/").pop()!
  const matches = (index.filesByName.get(name) ?? []).map((entry) => normalizePath(entry.path))
    .filter((path) => path.startsWith(root) && (!ref.includes("/") || path.slice(root.length) === ref))
  return matches.length === 1 ? matches[0] : undefined
}

export function outlineSourceRefs(projectPath: string, filePath: string, index: ProjectPathIndex): string[] {
  const root = `${normalizeComparablePath(projectPath)}/wiki/outlines/`
  const path = normalizePath(filePath)
  if (!path.startsWith(root)) return []
  const relative = path.slice(root.length)
  const name = relative.split("/").pop()!
  const unique = resolvePersonaOutlineRef(projectPath, name, index) === path
  if (relative === name) return unique ? [name] : []
  return unique ? [relative, name] : [relative]
}

export type PersonaKeepReason = "manual" | "pinned" | "referenced"

export interface PersonaDetachPlan {
  /** 已确认可连带移除的具体档案。 */
  removals: Array<Pick<PersonaSkillMeta, "id" | "characterName">>
  /** 必须保留的角色，附原因（用于向用户说明「这几位为什么没删」）。 */
  kept: Array<{ characterName: string; reason: PersonaKeepReason; otherRefs?: string[] }>
}

/**
 * 判据顺序即优先级：
 * 1. manual —— 用户手建的，永不连带移除。
 * 2. pinned（绿勾）—— 用户标记过的重点人物，永不连带移除。
 * 3. 仍被别的大纲引用 —— 移除会造成别的大纲「指向不存在的角色」。
 * 三条都过不了才进入移除集合。
 */
export function planPersonaDetach(input: {
  refs: readonly string[]
  skills: readonly PersonaSkillMeta[]
}): PersonaDetachPlan {
  const removals: PersonaDetachPlan["removals"] = []
  const kept: PersonaDetachPlan["kept"] = []
  for (const meta of input.skills) {
    if (!meta.outlineRefs.some((ref) => input.refs.includes(ref))) continue
    if (meta.origin === "manual") {
      kept.push({ characterName: meta.characterName, reason: "manual" })
      continue
    }
    if (meta.pinned) {
      kept.push({ characterName: meta.characterName, reason: "pinned" })
      continue
    }
    const otherRefs = meta.outlineRefs.filter((ref) => !input.refs.includes(ref))
    if (otherRefs.length > 0) {
      kept.push({ characterName: meta.characterName, reason: "referenced", otherRefs })
      continue
    }
    removals.push({ id: meta.id, characterName: meta.characterName })
  }
  return { removals, kept }
}

/** 文件操作成功后，在同一份最新索引上改引用，并复核用户确认过的可删除角色。 */
export async function updatePersonaOutlineRefs(
  projectPath: string,
  refs: readonly string[],
  options: { replacement?: string; remove?: readonly string[]; keepDormant?: boolean } = {},
): Promise<boolean> {
  if (!refs.length) return false
  let changed = false
  await updatePersonaSkillIndex(projectPath, (index) => {
    const eligible = new Set(planPersonaDetach({ refs, skills: index.skills }).removals.map((item) => item.id))
    const skills = index.skills.flatMap((meta) => {
      if (!meta.outlineRefs.some((ref) => refs.includes(ref))) return [meta]
      changed = true
      if (eligible.has(meta.id) && options.remove?.includes(meta.id)) return []
      const remaining = meta.outlineRefs.filter((ref) => !refs.includes(ref))
      if (options.replacement && !remaining.includes(options.replacement)) remaining.push(options.replacement)
      const next = { ...meta, outlineRefs: remaining, updatedAt: new Date().toISOString() }
      if (options.keepDormant && eligible.has(meta.id)) {
        next.status = "dormant"
        next.asOfChapter = meta.lastChapter || meta.asOfChapter
      }
      return [next]
    })
    if (changed) return { ...index, skills }
  })
  return changed
}

/**
 * 从 index 里移除角色（archive 语义：只移除索引条目，档案目录留在磁盘）。
 */
export function removePersonaFromIndex(
  skills: readonly PersonaSkillMeta[],
  ids: readonly string[],
): { removed: string[]; next: PersonaSkillMeta[] } {
  const targets = new Set(ids)
  const removed: string[] = []
  const next = skills.filter((meta) => {
    if (!targets.has(meta.id)) return true
    removed.push(meta.id)
    return false
  })
  return { removed, next }
}

export async function removePersonaFromProject(
  projectPath: string,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return []
  let removed: string[] = []
  await updatePersonaSkillIndex(projectPath, (current) => {
    const result = removePersonaFromIndex(current.skills, ids)
    removed = result.removed
    if (result.removed.length === 0) return
    return { version: 1, skills: result.next }
  })
  return removed
}

/** 整个目录改名时，相对路径可直接迁移；老文件名须在原目录树中唯一。 */
export async function renamePersonaOutlineFolderRefs(
  projectPath: string,
  oldFolder: string,
  newFolder: string,
  previousIndex: ProjectPathIndex,
): Promise<boolean> {
  const root = `${normalizeComparablePath(projectPath)}/wiki/outlines/`
  if (!oldFolder.startsWith(root) || !newFolder.startsWith(root)) return false
  const oldPrefix = oldFolder.slice(root.length) + "/"
  const newPrefix = newFolder.slice(root.length) + "/"
  let changed = false
  await updatePersonaSkillIndex(projectPath, (index) => {
    const skills = index.skills.map((meta) => {
      const refs = meta.outlineRefs.map((ref) => {
        const relative = ref.includes("/") ? ref : resolvePersonaOutlineRef(projectPath, ref, previousIndex)?.slice(root.length)
        return relative?.startsWith(oldPrefix) ? newPrefix + relative.slice(oldPrefix.length) : ref
      })
      if (refs.every((ref, i) => ref === meta.outlineRefs[i])) return meta
      changed = true
      return { ...meta, outlineRefs: [...new Set(refs)], updatedAt: new Date().toISOString() }
    })
    if (changed) return { ...index, skills }
  })
  return changed
}
