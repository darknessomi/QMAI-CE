import { fileExists } from "@/commands/fs"
import { isAiExcludedContent } from "./ai-exclude"
import { hasReadableHistory } from "./ai-exclude-chapters"
import type { OutlineCharacterBrief } from "./outline-context-index"
import { normalizePath } from "@/lib/path-utils"
import { formatPersonaPersonalityForWriting, splitPersonaSkillDocument, type ParsedPersonaSkillDocument } from "./persona-skill-profile"
import { loadPersonaSkillIndex, loadPersonaSkillIndexStrict, personaSkillDocumentPath, personaSkillIdFor, readPersonaSkillDocument } from "./persona-skill-store"
import {
  PERSONA_INJECT_CHAR_BUDGET,
  PERSONA_INJECT_FIELD_CHARS,
  PERSONA_INJECT_MAX_SKILLS,
  PERSONA_MAJOR_FIELDS,
  PERSONA_MINOR_FIELDS,
  PERSONA_PROFILE_FIELDS,
  PERSONA_LIVE_FIELDS,
  PERSONA_MIN_SUBSTRING_MATCH_CHARS,
  PERSONA_SUPPLEMENT_HEADING,
  normalizePersonaName,
  type PersonaSkillIndex,
  type PersonaSkillMeta,
  type PersonaSkillTier,
} from "./persona-skill-types"

const TIER_RANK: Record<PersonaSkillTier, number> = { major: 0, minor: 1 }

/** 注入顺序：绿勾 → 主要 → 次要 → 出场次数多的优先（D5）。 */
export function comparePersonaSkillMeta(a: PersonaSkillMeta, b: PersonaSkillMeta): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[a.tier] - TIER_RANK[b.tier]
  if (a.appearanceCount !== b.appearanceCount) return b.appearanceCount - a.appearanceCount
  return a.characterName.localeCompare(b.characterName, "zh-Hans-CN")
}

/**
 * 名字匹配：精确相等 / 别名命中 / 双向包含。
 * 包含匹配要求两边都 ≥ 2 个字，否则单姓（「林」）会把全库都匹配上。
 */
export function matchesPersonaName(normalizedQuery: string, names: readonly string[]): boolean {
  for (const name of names) {
    const normalized = normalizePersonaName(name)
    if (!normalized) continue
    if (normalizedQuery === normalized) return true
    if (normalizedQuery.length < PERSONA_MIN_SUBSTRING_MATCH_CHARS) continue
    if (normalized.length < PERSONA_MIN_SUBSTRING_MATCH_CHARS) continue
    if (normalizedQuery.includes(normalized) || normalized.includes(normalizedQuery)) return true
  }
  return false
}

/**
 * 从 index 里挑出本次该注入的候选：名字出现在本次文本里的人。
 *
 * ⚠️ 刻意**不**按 status（潜伏/归档）过滤。原因：status 由「连续 N 章未出场」
 * 推出，而它拦不住的恰恰是最需要档案的场景——「第 1~3 章出场、消失 50 章、
 * 第 54 章回归」的角色，回归那一章 status 还是归档，但他的名字就在本章文本里。
 * 此时写作提示词不带他的档案，AI 只能凭空写这个老角色，写完摄取再 refine 也
 * 是在「写歪了」的基础上修。名字命中 = 他出场了 = 档案必须在场。
 * 预算仍由 PERSONA_INJECT_MAX_SKILLS 与字符预算兜底，排序保证重要人物优先。
 */
export function selectPersonaSkillCandidates(
  index: PersonaSkillIndex,
  matchingText: string,
  backgroundText = "",
  projectionIds: ReadonlySet<string> = new Set(),
): PersonaSkillMeta[] {
  const query = normalizePersonaName(matchingText)
  const background = normalizePersonaName(backgroundText)
  const primary: PersonaSkillMeta[] = []
  const secondary: PersonaSkillMeta[] = []
  for (const meta of index.skills) {
    const names = [meta.characterName, ...meta.aliases]
    if (projectionIds.has(meta.id) || matchesPersonaName(query, names)) primary.push(meta)
    else if (matchesPersonaName(background, names)) secondary.push(meta)
  }
  // 用户要求和本章章纲点名的人物先占预算，其次才用此前章节状态补足。
  return [...primary.sort(comparePersonaSkillMeta), ...secondary.sort(comparePersonaSkillMeta)]
    .slice(0, PERSONA_INJECT_MAX_SKILLS)
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** 按主次档位渲染演技字段，同时保留性格与补充。 */
export function renderPersonaSkillBlock(meta: PersonaSkillMeta, document: ParsedPersonaSkillDocument): string {
  const order = meta.tier === "major" ? PERSONA_MAJOR_FIELDS : PERSONA_MINOR_FIELDS
  const parts: string[] = []
  const personality = formatPersonaPersonalityForWriting(document.fields["性格"] ?? "")
  if (personality) parts.push(`人物性格：${personality}`)
  for (const field of order) {
    const value = (document.fields[field] ?? "").replace(/\s*\n\s*/g, " ").trim()
    if (!value) continue
    parts.push(`${field}：${truncate(value, PERSONA_INJECT_FIELD_CHARS)}`)
  }
  // 新档案只有一个补充段；老档案可能还留着多个「补充（第 N 章）」。
  // 倒序拼接，截断时先丢最早的，而不是把最新的观察截掉。
  const supplements = document.extras
    .filter(({ heading }) => heading.startsWith(PERSONA_SUPPLEMENT_HEADING))
    .map(({ body }) => body.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .reverse()
  if (supplements.length > 0) {
    const joined = truncate(supplements.join(" "), PERSONA_INJECT_FIELD_CHARS)
    parts.push(`${PERSONA_SUPPLEMENT_HEADING}：${joined}`)
  }
  if (parts.length === 0) return ""
  const tags = [
    meta.tier === "major" ? "主要人物" : "次要人物",
    meta.pinned ? "★重点" : "",
    `出场 ${meta.appearanceCount} 次`,
  ].filter(Boolean)
  return `- 【人物 Skill · ${meta.characterName}（${tags.join(" / ")}）】${parts.join(" ")}`
}

/**
 * 写作用演技段和可替换生成小传的档案事实。
 * 先只用 index 元数据做名字匹配（几十条，很便宜），命中后才读那一份 SKILL.md。
 */
export async function buildPersonaSkillContext(
  projectPath: string,
  matchingText: string,
  backgroundText = "",
  briefs: readonly OutlineCharacterBrief[] = [],
  readable?: ReadonlyMap<number, string>,
): Promise<{ skills: string; profileFacts: Map<string, string> }> {
  const profileFacts = new Map<string, string>()
  if (!matchingText.trim() && !backgroundText.trim()) return { skills: "", profileFacts }

  const pp = normalizePath(projectPath)
  const index = await loadPersonaSkillIndex(pp)
  const excluded = new Set(briefs.filter((brief) => brief.excluded).map((brief) => brief.personaId ?? brief.authorPersonaId))
  const projectionIds = new Set(briefs.flatMap((brief) => brief.personaId && !brief.excluded ? [brief.personaId] : []))
  const indexed = new Set(index.skills.map((meta) => meta.id))
  const orphans = [...projectionIds].filter((id) => !indexed.has(id) && id === personaSkillIdFor(id))
  if (orphans.length && await loadPersonaSkillIndexStrict(pp).catch(() => null)) {
    // 从有效索引移除/退回候选时旧文件仍在磁盘，不应把其投影当作旧书唯一资料复活。
    for (const id of orphans) {
      if (await fileExists(personaSkillDocumentPath(pp, id))) profileFacts.set(id, "")
    }
  }
  const candidates = selectPersonaSkillCandidates(index, matchingText, backgroundText, projectionIds)
  const actingIds = new Set(candidates.map((meta) => meta.id))
  // 排在演技名额之外的角色仍取最新小传事实，避免通过旧投影把过期演技塞回提示词。
  const factsOnly = index.skills.filter((meta) => projectionIds.has(meta.id) && !actingIds.has(meta.id))
  const blocks: string[] = []
  let used = 0
  for (const meta of [...candidates, ...factsOnly]) {
    const through = Math.max(meta.lastLearnedChapter, meta.asOfChapter ?? 0)
    if (excluded.has(meta.id) || (readable && through > 0 && !hasReadableHistory(through, readable))) {
      profileFacts.set(meta.id, "")
      continue
    }
    const markdown = await readPersonaSkillDocument(pp, meta.id)
    if (!markdown.trim()) continue
    if (isAiExcludedContent(markdown)) {
      profileFacts.set(meta.id, "")
      continue
    }
    const document = splitPersonaSkillDocument(markdown)
    const block = actingIds.has(meta.id) ? renderPersonaSkillBlock(meta, document) : ""
    if (block && used + block.length <= PERSONA_INJECT_CHAR_BUDGET) {
      blocks.push(block)
      used += block.length + 1
    }
    const sourceText = briefs.filter((brief) => !brief.personaId && brief.authorPersonaId === meta.id)
      .map((brief) => brief.content).join("\n").replace(/[\s|*：:]/g, "")
    const facts = [...PERSONA_PROFILE_FIELDS, ...PERSONA_LIVE_FIELDS].flatMap((field) => {
      const value = document.fields[field]
      if (field === "性格" || !value) return []
      const compact = value.replace(/[\s|*：:]/g, "")
      if (sourceText.includes(field + compact) || (compact.length >= 4 && sourceText.includes(compact))) return []
      return [`${field}：${value}`]
    })
    if (meta.roleType && !sourceText.includes(meta.roleType)) facts.unshift(`定位：${meta.roleType}`)
    profileFacts.set(meta.id, facts.length ? [meta.characterName, ...facts].join("\n") : "")
  }
  return { skills: blocks.join("\n"), profileFacts }
}
