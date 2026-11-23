import type { ChapterSnapshot, CharacterDetail, LocationDetail, OrganizationDetail, ItemDetail, EventDetail, ValidationWarning } from "./chapter-ingest"
import { parseChapterNumber } from "./chapter-meta"
import { normalizeItemCategoryRecord } from "./item-category"

function normalizeSnapshotText(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const parsed = parseChapterNumber(value)
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

function normalizeSnapshotList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeSnapshotText(item).trim())
      .filter(Boolean)
  }

  const single = normalizeSnapshotText(value).trim()
  return single ? [single] : []
}

function normalizeSnapshotAliasRecord(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined

  const aliases = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([name, rawAliases]) => [name.trim(), normalizeSnapshotList(rawAliases)] as const)
      .filter(([name, names]) => name.length > 0 && names.length > 0),
  )

  return Object.keys(aliases).length > 0 ? aliases : undefined
}

function normalizeValidationWarnings(value: unknown): ValidationWarning[] | undefined {
  if (!Array.isArray(value)) return undefined
  const warnings = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    const rawType = (item as { type?: unknown }).type
    const message = normalizeSnapshotText((item as { message?: unknown }).message).trim()
    if (!message) return []
    if (rawType === "entity_new" || rawType === "canon_conflict") {
      return [{ type: rawType as ValidationWarning["type"], message }]
    }
    return []
  })
  return warnings.length > 0 ? warnings : undefined
}

function normalizeSnapshotDetailRecord<T extends object>(value: unknown): Record<string, T> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, T>
}

export function normalizeChapterSnapshot(
  value: unknown,
  fallback: Partial<Pick<ChapterSnapshot, "chapterId" | "chapterNumber">> = {},
): ChapterSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null

  const raw = value as Record<string, unknown>
  const chapterNumber = parseChapterNumber(raw.chapterNumber) ?? fallback.chapterNumber ?? 0
  const normalizedChapterId = normalizeSnapshotText(raw.chapterId).trim()
  const chapterId = normalizedChapterId || fallback.chapterId || `chapter-${chapterNumber}`

  return {
    chapterId,
    chapterNumber,
    sourceHash: normalizeSnapshotText(raw.sourceHash) || undefined,
    chapterTitle: normalizeSnapshotText(raw.chapterTitle) || undefined,
    summary: normalizeSnapshotText(raw.summary),
    characters: normalizeSnapshotList(raw.characters),
    characterAliases: normalizeSnapshotAliasRecord(raw.characterAliases),
    locations: normalizeSnapshotList(raw.locations),
    organizations: normalizeSnapshotList(raw.organizations),
    items: normalizeSnapshotList(raw.items),
    events: normalizeSnapshotList(raw.events),
    characterStateChanges: normalizeSnapshotList(raw.characterStateChanges),
    relationshipChanges: normalizeSnapshotList(raw.relationshipChanges),
    knowledgeChanges: normalizeSnapshotList(raw.knowledgeChanges),
    foreshadowingChanges: normalizeSnapshotList(raw.foreshadowingChanges),
    newCanonFacts: normalizeSnapshotList(raw.newCanonFacts),
    timelineEvents: normalizeSnapshotList(raw.timelineEvents),
    conflicts: normalizeSnapshotList(raw.conflicts),
    endingHook: normalizeSnapshotText(raw.endingHook),
    graphNodes: normalizeSnapshotList(raw.graphNodes),
    graphEdges: normalizeSnapshotList(raw.graphEdges),
    sourceType: raw.sourceType === "chapter" || raw.sourceType === "outline" ? raw.sourceType : undefined,
    sourceSequence: normalizePositiveInteger(raw.sourceSequence),
    revision: normalizePositiveInteger(raw.revision),
    snapshotId: normalizeSnapshotText(raw.snapshotId) || undefined,
    supersedes: normalizeSnapshotText(raw.supersedes) || undefined,
    isHistorical: typeof raw.isHistorical === "boolean" ? raw.isHistorical : undefined,
    validationWarnings: normalizeValidationWarnings(raw.validationWarnings),
    memorySyncedAt: normalizeSnapshotText(raw.memorySyncedAt) || undefined,
    characterDetails: normalizeSnapshotDetailRecord<CharacterDetail>(raw.characterDetails),
    locationDetails: normalizeSnapshotDetailRecord<LocationDetail>(raw.locationDetails),
    organizationDetails: normalizeSnapshotDetailRecord<OrganizationDetail>(raw.organizationDetails),
    itemDetails: normalizeSnapshotDetailRecord<ItemDetail>(raw.itemDetails),
    // 用专门的归一化器而不是 normalizeSnapshotDetailRecord：分类是**闭集**，
    // 模型偶尔会回「其他」「重要」这类词，直接落盘会在读取侧变成无意义的键。
    itemCategories: normalizeItemCategoryRecord(raw.itemCategories),
    eventDetails: normalizeSnapshotDetailRecord<EventDetail>(raw.eventDetails),
  }
}

export function buildSourceHash(content: string): string {
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return String(hash)
}
