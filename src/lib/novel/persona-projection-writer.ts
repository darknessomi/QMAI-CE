import { createDirectory, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { isAiExcluded, setAiExcluded } from "./ai-exclude"
import { getPersonaProjectionId, parsePersonaProjectionFrontmatter, renderPersonaTableMarkdown } from "./persona-projection"
import { readPersonaDocumentFields } from "./persona-skill-profile"
import type { PersonaSkillMeta } from "./persona-skill-types"

export const PERSONA_PROJECTION_FOLDER = "人物小传"

/** 调用方持有人物锁，使用本次保存的档案版本。只更新本角色自有的投影。 */
export async function projectPersonaToOutline(
  pp: string,
  meta: PersonaSkillMeta,
  document: string,
  onlyExisting = false,
): Promise<void> {
  try {
    await writeProjection(pp, meta, document, onlyExisting)
  } catch (error) {
    console.warn(`人物「${meta.characterName}」的大纲投影未同步`, error)
  }
}

async function writeProjection(pp: string, meta: PersonaSkillMeta, document: string, onlyExisting: boolean): Promise<void> {
  const dir = `${pp}/wiki/outlines/${PERSONA_PROJECTION_FOLDER}`
  // 保留带空格的既有文件名。不能直接作为文件名的人名回退到已校验的档案 ID。
  const fileName = /[\\/:*?"<>|\p{Cc}]/u.test(meta.characterName) ? meta.id : meta.characterName
  const target = `${dir}/${fileName}.md`
  let previous = ""
  let excluded = false
  if (await fileExists(target)) {
    previous = await readFile(target)
    const parsed = parsePersonaProjectionFrontmatter(previous)
    if (getPersonaProjectionId(previous, parsed) !== meta.id) return
    excluded = isAiExcluded(parsed.frontmatter)
  } else {
    if (onlyExisting) return
    await createDirectory(dir)
  }

  let next = renderPersonaTableMarkdown({
    characterName: meta.characterName,
    roleType: meta.roleType,
    personaId: meta.id,
    generatedAt: meta.updatedAt,
    fields: readPersonaDocumentFields(document),
    outlineRefs: meta.outlineRefs,
  })
  if (excluded) next = setAiExcluded(next, true)
  if (next !== previous) await writeFileAtomic(target, next)
}
