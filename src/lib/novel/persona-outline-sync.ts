import { characterProfileDataFromMarkdown } from "./character-profile-template"
import { parseCharacterRoleFileName } from "./extract-established-context"
import { createPersonaSkillByUser } from "./persona-skill-learning"
import type { OutlineSaveRequest, SavedOutlineSource } from "./outline-save-request"
import { normalizeVolumeOutlineData } from "./volume-outline-template"

/** §13 表头的固定列名。第一列一定叫「角色」，这一列的内容才是人名。 */
const CAST_TABLE_HEADER = "角色"

/** 不是人名的单元格内容。 */
const NOT_A_NAME = new Set(["人物小传", "角色小传", "人物", "角色", "姓名", "未命名角色", "无", "-", "—", "/", "未定", "待定"])

function acceptName(name: string, into: string[]): void {
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 40) return
  if (NOT_A_NAME.has(trimmed)) return
  if (into.includes(trimmed)) return
  into.push(trimmed)
}

/**
 * 从章纲正文的 §13 表格里抽第一列。
 * 只认「| 角色 | ...」开头的那张表：别的表格（事件链、伏笔）第一列不是人名。
 */
function collectFromCastTable(content: string, into: string[]): void {
  let inCastTable = false
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("|")) { inCastTable = false; continue }
    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim())
    if (cells[0] === CAST_TABLE_HEADER) { inCastTable = true; continue }
    if (!inCastTable) continue
    // 分隔行 | --- | --- |
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === "")) continue
    acceptName(cells[0], into)
  }
}

/** 当前卷纲人物写在环节的 who，老卷纲还有 cast 或 volumes[].roles。 */
function collectFromVolume(data: string | undefined, names: string[]): void {
  if (!data) return
  let raw: unknown
  try { raw = JSON.parse(data) } catch { return }
  const volume = normalizeVolumeOutlineData(raw)
  for (const story of volume?.stories ?? []) {
    for (const stage of story.st) {
      for (const item of (stage.who ?? "").split(/[＋+、]/)) {
        // 标准写法为「姓名（本环节作用）＋ 姓名（本环节作用）」，不把自由叙述当成人名。
        const match = item.trim().match(/^([^（）()，,。；;：:|]{1,40}?)[（(][^（）()]*[）)]$/)
        if (match) acceptName(match[1], names)
      }
    }
  }
  for (const member of volume?.cast ?? []) acceptName(member.n, names)
  if (!raw || typeof raw !== "object" || !("volumes" in raw) || !Array.isArray(raw.volumes)) return
  for (const legacy of raw.volumes) {
    if (!Array.isArray(legacy?.roles)) continue
    for (const role of legacy.roles) {
      if (typeof role?.name === "string") acceptName(role.name, names)
    }
  }
}

function isCharacterOutline(request: OutlineSaveRequest): boolean {
  return request.fileType === "character" || request.targetFolder.trim() === "人物小传"
}

function characterIdentity(request: OutlineSaveRequest): { name: string; roleType: string } {
  if (request.character) return request.character
  const encoded = parseCharacterRoleFileName(request.fileName)
  if (encoded) return { name: encoded.name, roleType: encoded.role }

  const stem = request.fileName.replace(/\.md$/i, "").replace(/^(?:人物小传|角色小传|角色)(?:-角色)?[-_：:]\s*/, "").trim()
  const profile = characterProfileDataFromMarkdown(request.content)
  const name = profile?.name && !NOT_A_NAME.has(profile.name) && (profile.roleType || !stem || NOT_A_NAME.has(stem))
    ? profile.name
    : stem
  return { name, roleType: profile?.roleType ?? "" }
}

export function collectOutlineCharacters(request: OutlineSaveRequest): Array<{ name: string; roleType: string }> {
  const names: string[] = []
  if (isCharacterOutline(request)) {
    const character = characterIdentity(request)
    acceptName(character.name, names)
    return names.map((name) => ({ name, roleType: character.roleType }))
  }
  if (request.fileType === "volume-outline") collectFromVolume(request.structuredData, names)
  if (request.fileType === "chapter-outline") collectFromCastTable(request.content, names)
  return names.map((name) => ({ name, roleType: "" }))
}

export async function syncPersonaFromOutlineSave(input: {
  projectPath: string
  savedSources: readonly SavedOutlineSource[]
}): Promise<boolean> {
  let synced = false
  // 同批次先登记完整小传，后处理仅提及姓名的章纲，避免为同一人物先造空投影。
  const sources = [...input.savedSources].sort((a, b) => Number(isCharacterOutline(b.request)) - Number(isCharacterOutline(a.request)))
  for (const { request, relativePath } of sources) {
    const biography = isCharacterOutline(request)
    const oldName = biography ? request.fileName.replace(/\.md$/i, "").trim() : ""
    for (const { name, roleType } of collectOutlineCharacters(request)) {
      try {
        await createPersonaSkillByUser({
          projectPath: input.projectPath,
          characterName: name,
          roleType,
          fields: {},
          origin: "auto",
          outlineRef: relativePath,
          legacyOutlineName: oldName && oldName !== name ? oldName : undefined,
          skipProjection: biography,
        })
        synced = true
      } catch (error) {
        console.warn(`[persona-sync] 同步「${relativePath}」中的「${name}」失败：`, error)
      }
    }
  }
  return synced
}
