import type { ChapterSnapshot } from "./chapter-ingest"
import { parseForeshadowingChange, matchForeshadowingNames } from "./foreshadowing-normalize"
import type { CharacterState, CharacterStateStore } from "./character-state"
import type { Foreshadowing, ForeshadowingStore } from "./foreshadowing-tracker"
import type { TimelineEntry } from "./timeline"

const UNCERTAIN_RE = /(可能|也许|似乎|疑似|或许|大概|推测|猜测|尚不确定|未证实)/u
const PUNCTUATION_RE = /[，。；：？！“”‘’（）《》【】<>]/u
const GENERIC_SUBJECT_RE = /^(?:\d+号.+|短发女人|长发女人|老太太|老头|老人|守卫|村民|灰白制服(?:人员|男人|女人)|两名灰白制服人员)$/u
const EVENT_VERB_RE = /(发现|确认|试图|听见|引发|整理|逐步浮现|否定|建立|失踪|审问|追捕|偷听|回收|转送|封存)/u

interface StructuredMemoryDocuments {
  "chapter-snapshots.md": string
  "character-cognition.md": string
  "character-states.md": string
  "foreshadowing-tracker.md": string
  "timeline.md": string
  "canon-facts.md": string
  "conflicts.md": string
}

export function isValidMemorySnapshot(snapshot: ChapterSnapshot | null, actualChapterNumbers: number[]): snapshot is ChapterSnapshot {
  if (!snapshot || !Number.isFinite(snapshot.chapterNumber)) return false
  if (snapshot.chapterNumber <= 0 || snapshot.isHistorical || snapshot.sourceType === "outline") return false
  if (actualChapterNumbers.length === 0) return true
  const maxActual = Math.max(...actualChapterNumbers)
  return snapshot.chapterNumber <= maxActual + 5
}

export function looksLikeStableNovelEntityLabel(kind: "character" | "location" | "organization" | "item" | "event", label: string): boolean {
  const trimmed = label.trim()
  if (!trimmed) return false
  if (PUNCTUATION_RE.test(trimmed)) return false
  if (trimmed.length > 32) return false
  if (kind === "event") {
    if (trimmed.length > 18) return false
    if (EVENT_VERB_RE.test(trimmed)) return false
  }
  return true
}

function chapterLabel(chapterNumber: number): string {
  return `第${chapterNumber}章`
}

function joinChapterLabels(chapters: Iterable<number>): string {
  return Array.from(new Set([...chapters]))
    .sort((a, b) => a - b)
    .map(chapterLabel)
    .join("、")
}

function pageHeader(memoryType: string, title: string): string[] {
  return [
    "---",
    "type: structured-memory",
    `memory_type: ${memoryType}`,
    `title: "${title}"`,
    "---",
    "",
    `# ${title}`,
    "",
  ]
}

function appendCandidateSection(lines: string[], candidates: string[]): void {
  lines.push("## 候选区", "")
  if (candidates.length === 0) {
    lines.push("暂无候选内容。", "")
    return
  }
  for (const item of candidates) {
    lines.push(`- ${item}`)
  }
  lines.push("")
}

function parseSubjectChange(text: string): { subject: string; detail: string } | null {
  const normalized = text.replace(/[：:]/u, ":")
  const index = normalized.indexOf(":")
  if (index <= 0) return null
  return {
    subject: normalized.slice(0, index).trim(),
    detail: normalized.slice(index + 1).trim(),
  }
}

function isImportantSubject(subject: string): boolean {
  const trimmed = subject.trim()
  if (!trimmed) return false
  if (PUNCTUATION_RE.test(trimmed)) return false
  if (GENERIC_SUBJECT_RE.test(trimmed)) return false
  if (/^(读者|角色|旁白)$/u.test(trimmed)) return false
  if (/(通过|补充|借助|利用|经由)/u.test(trimmed)) return false
  if (/^\d+号/u.test(trimmed)) return false
  return trimmed.length <= 12
}

function pickStableSubject(text: string, snapshot: ChapterSnapshot): string | null {
  const parsed = parseSubjectChange(text)
  if (parsed) {
    return isImportantSubject(parsed.subject) ? parsed.subject : null
  }
  const matched = snapshot.characters.find((name) => text.includes(name) && isImportantSubject(name))
  return matched ?? null
}

function buildChapterSnapshotsDocument(snapshots: ChapterSnapshot[]): string {
  const lines = pageHeader("chapter-snapshots", "章节快照记忆")
  for (const snapshot of snapshots) {
    lines.push(`## ${chapterLabel(snapshot.chapterNumber)}`, "")
    lines.push("### 摘要", snapshot.summary || "无", "")
    lines.push("### 人物状态变化", ...(snapshot.characterStateChanges.length > 0 ? snapshot.characterStateChanges.map((item) => `- ${item}`) : ["- 无"]), "")
    lines.push("### 角色认知变化", ...(snapshot.knowledgeChanges.length > 0 ? snapshot.knowledgeChanges.map((item) => `- ${item}`) : ["- 无"]), "")
    lines.push("### 伏笔变化", ...(snapshot.foreshadowingChanges.length > 0 ? snapshot.foreshadowingChanges.map((item) => `- ${item}`) : ["- 无"]), "")
    lines.push("### 时间线事件", ...(snapshot.timelineEvents.length > 0 ? snapshot.timelineEvents.map((item) => `- ${item}`) : ["- 无"]), "")
    lines.push("### 结尾钩子", snapshot.endingHook || "无", "")
  }
  return `${lines.join("\n").trimEnd()}\n`
}

function buildCharacterCognitionDocument(snapshots: ChapterSnapshot[]): string {
  const state = new Map<string, { knows: Map<string, Set<number>>; unknowns: Map<string, Set<number>> }>()
  const candidates: string[] = []

  for (const snapshot of snapshots) {
    for (const raw of snapshot.knowledgeChanges) {
      const text = raw.trim()
      if (!text) continue
      if (UNCERTAIN_RE.test(text)) {
        candidates.push(`${chapterLabel(snapshot.chapterNumber)}：${text}`)
        continue
      }
      const unknownMatch = text.match(/^(.+?)不知道(.+)$/u)
      if (unknownMatch?.[1] && unknownMatch?.[2]) {
        const subject = unknownMatch[1].trim()
        if (!isImportantSubject(subject)) continue
        const entry = state.get(subject) ?? { knows: new Map(), unknowns: new Map() }
        if (!state.has(subject)) state.set(subject, entry)
        const detail = unknownMatch[2].trim()
        const chapters = entry.unknowns.get(detail) ?? new Set<number>()
        chapters.add(snapshot.chapterNumber)
        entry.unknowns.set(detail, chapters)
        continue
      }
      const knowMatch = text.match(/^(.+?)(知道|得知|察觉到|意识到)(.+)$/u)
      if (knowMatch?.[1] && knowMatch?.[3]) {
        const subject = knowMatch[1].trim()
        if (!isImportantSubject(subject)) continue
        const entry = state.get(subject) ?? { knows: new Map(), unknowns: new Map() }
        if (!state.has(subject)) state.set(subject, entry)
        const detail = knowMatch[3].trim()
        const chapters = entry.knows.get(detail) ?? new Set<number>()
        chapters.add(snapshot.chapterNumber)
        entry.knows.set(detail, chapters)
      }
    }
  }

  const lines = pageHeader("character-cognition", "角色认知记忆")
  lines.push("## 当前正式认知", "")
  const entries = [...state.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-CN"))
  if (entries.length === 0) {
    lines.push("暂无正式认知记录。", "")
  } else {
    for (const [subject, entry] of entries) {
      lines.push(`### ${subject}`)
      for (const [detail, chapters] of entry.knows) {
        lines.push(`- 已知：${detail}（来源：${joinChapterLabels(chapters)}）`)
      }
      for (const [detail, chapters] of entry.unknowns) {
        lines.push(`- 未知：${detail}（来源：${joinChapterLabels(chapters)}）`)
      }
      lines.push("")
    }
  }
  appendCandidateSection(lines, candidates)
  return `${lines.join("\n").trimEnd()}\n`
}

export interface MemoryProjection {
  characters: CharacterStateStore
  foreshadows: ForeshadowingStore
  timeline: TimelineEntry[]
  officialSnapshots: ChapterSnapshot[]
  candidates: { characters: string[]; foreshadows: string[]; timeline: string[] }
}

export function buildMemoryProjection(
  snapshots: ChapterSnapshot[],
  previousCharacters?: CharacterStateStore,
  previousForeshadows?: ForeshadowingStore,
): MemoryProjection {
  const chapters = snapshots.filter((s) => isValidMemorySnapshot(s, [])).sort((a, b) => a.chapterNumber - b.chapterNumber)
  const lastUpdated = chapters.reduce((latest, s) => (s.memorySyncedAt ?? "") > latest ? s.memorySyncedAt! : latest, "")
  const characters = new Map<string, CharacterState>()
  const previousPeople = new Map(previousCharacters?.characters.map((p) => [p.characterName, p]))
  const previousItems = previousForeshadows?.items ?? []
  const previousByName = new Map(previousItems.map((item) => [item.name, item]))
  let serial = previousItems.reduce((max, item) => Math.max(max, Number(/^F(\d+)$/.exec(item.id)?.[1] ?? 0)), previousForeshadows?.lastSerial ?? 0)
  const items: Foreshadowing[] = []
  const candidates: MemoryProjection["candidates"] = { characters: [], foreshadows: [], timeline: [] }
  const timeline: TimelineEntry[] = []
  const officialSnapshots: ChapterSnapshot[] = []
  const owners = new Map<string, Set<string>>()
  for (const s of chapters) {
    for (const [name, aliases] of Object.entries(s.characterAliases ?? {})) {
      for (const alias of [name, ...aliases]) {
        const names = owners.get(alias) ?? new Set<string>()
        names.add(name)
        owners.set(alias, names)
      }
    }
  }
  for (const s of chapters) {
    const official: ChapterSnapshot = { ...s, characterStateChanges: [], foreshadowingChanges: [], timelineEvents: [] }
    officialSnapshots.push(official)
    const candidate = (raw: string) => `${chapterLabel(s.chapterNumber)}：${raw}`
    for (const raw of s.characterStateChanges) {
      const text = raw.trim()
      if (!text) continue
      if (UNCERTAIN_RE.test(text)) { candidates.characters.push(candidate(text)); continue }
      const subject = pickStableSubject(text, s)
      const names = subject ? owners.get(subject) : undefined
      if (!subject || (names && names.size > 1)) { candidates.characters.push(candidate(text)); continue }
      const name = names?.values().next().value ?? subject
      const generated = parseSubjectChange(text)?.detail || text
      official.characterStateChanges.push(`${name}：${generated}`)
      const previous = previousPeople.get(name)
      const override = previous && (previous.manual || (previous.generatedStatus != null && previous.status !== previous.generatedStatus))
        ? previous.status : undefined
      characters.set(name, {
        characterName: name, currentLocation: "", equipment: [], abilities: [], relationships: {},
        ...previous, status: override ?? generated, generatedStatus: generated,
        lastUpdatedAt: s.memorySyncedAt || previous?.lastUpdatedAt || "",
        lastUpdatedChapter: s.chapterNumber,
      })
    }

    for (const raw of s.foreshadowingChanges) {
      const parsed = parseForeshadowingChange(raw)
      if (!parsed) continue
      const matches = matchForeshadowingNames(items, parsed.name)
      const match = matches[0]
      if (matches.length > 1 || UNCERTAIN_RE.test(raw) || (!match && parsed.kind === "advance")) {
        candidates.foreshadows.push(candidate(raw))
        continue
      }
      official.foreshadowingChanges.push(raw)
      if (match) {
        if (parsed.description.length > match.description.length) match.description = parsed.description
        if (parsed.kind === "resolve") {
          if (match.status !== "abandoned") match.status = "resolved"
          match.resolvedChapter = s.chapterNumber
        } else {
          if (match.status !== "resolved" && match.status !== "abandoned") match.status = "advanced"
          if (!match.advancedChapters.includes(s.chapterNumber)) match.advancedChapters.push(s.chapterNumber)
        }
      } else {
        const previous = previousByName.get(parsed.name)
        items.push({
          relatedCharacters: [], relatedEvents: [], notes: "", ...previous,
          name: parsed.name, description: parsed.description,
          id: previous?.id ?? `F${String(++serial).padStart(3, "0")}`,
          plantedChapter: s.chapterNumber, advancedChapters: [],
          resolvedChapter: parsed.kind === "resolve" ? s.chapterNumber : undefined,
          status: previous?.status === "abandoned" ? "abandoned" : parsed.kind === "resolve" ? "resolved" : "planted",
        })
      }
    }

    const eventKeys = new Set<string>()
    for (const raw of s.timelineEvents) {
      const event = raw.trim()
      const key = event.normalize("NFKC").replace(/\s+/gu, "")
      if (!key || eventKeys.has(key)) continue
      eventKeys.add(key)
      if (UNCERTAIN_RE.test(event)) candidates.timeline.push(candidate(event))
      else {
        timeline.push({ chapterNumber: s.chapterNumber, event })
        official.timelineEvents.push(event)
      }
    }
  }

  // 手工补充的位置、装备、备注等在最后一个自动来源撤回后仍应保留。
  for (const p of previousPeople.values()) {
    if (!characters.has(p.characterName) && (p.manual || (p.generatedStatus != null && p.status !== p.generatedStatus) || p.currentLocation || p.equipment?.length || p.abilities?.length
      || Object.keys(p.relationships ?? {}).length || p.publicImage || p.pendingForeshadowing?.length || p.stateChangeHistory?.length)) {
      const status = p.manual || (p.generatedStatus != null && p.status !== p.generatedStatus) ? p.status : ""
      characters.set(p.characterName, { ...p, status, generatedStatus: "", lastUpdatedChapter: 0, lastUpdatedAt: "" })
    }
  }
  for (const previous of previousItems) {
    if (!items.some((f) => f.id === previous.id) && (previous.manual || previous.notes || previous.relatedCharacters?.length
      || previous.relatedEvents?.length || previous.expectedResolveChapter != null || previous.importance || previous.status === "abandoned")) {
      items.push({ ...previous })
    }
  }
  return { characters: { characters: [...characters.values()], lastUpdated }, foreshadows: { items, lastUpdated, lastSerial: serial }, timeline, candidates, officialSnapshots }
}

function buildCharacterStatesDocument(memory: MemoryProjection): string {
  const lines = pageHeader("character-states", "人物状态记忆")
  lines.push("## 当前正式状态", "")
  for (const p of memory.characters.characters) {
    lines.push(`### ${p.characterName}`, `- 当前状态：${p.status}`)
    if (p.currentLocation) lines.push(`- 当前位置：${p.currentLocation}`)
    if (p.publicImage) lines.push(`- 公众形象：${p.publicImage}`)
    if (p.equipment?.length) lines.push(`- 装备：${p.equipment.join("、")}`)
    if (p.abilities?.length) lines.push(`- 能力：${p.abilities.join("、")}`)
    for (const [name, relationship] of Object.entries(p.relationships ?? {})) lines.push(`- 与${name}的关系：${relationship}`)
    if (p.pendingForeshadowing?.length) lines.push(`- 待回收伏笔：${p.pendingForeshadowing.join("、")}`)
    for (const history of p.stateChangeHistory ?? []) lines.push(`- ${chapterLabel(history.chapter)}变化：${history.change}`)
    if (p.lastUpdatedChapter > 0) lines.push(`- 最近更新：${chapterLabel(p.lastUpdatedChapter)}`)
    lines.push("")
  }
  appendCandidateSection(lines, memory.candidates.characters)
  return `${lines.join("\n").trimEnd()}\n`
}

function buildForeshadowingDocument(memory: MemoryProjection): string {
  const lines = pageHeader("foreshadowing-tracker", "伏笔追踪记忆")
  const labels = { planted: "待推进", advanced: "推进中", resolved: "已完成", abandoned: "已放弃" }
  for (const section of ["进行中", "已完成", "已放弃"]) {
    lines.push(`## ${section}`, "")
    for (const item of memory.foreshadows.items) {
      const state = item.status === "resolved" ? "已完成" : item.status === "abandoned" ? "已放弃" : "进行中"
      if (state !== section) continue
      const sources = [item.plantedChapter, ...item.advancedChapters]
      if (item.resolvedChapter != null) sources.push(item.resolvedChapter)
      lines.push(`### ${item.name}`, `- 编号：${item.id}`, `- 状态：${labels[item.status]}`, `- 说明：${item.description}`,
        `- 初次出现：${chapterLabel(item.plantedChapter)}`, `- 来源回查：${joinChapterLabels(sources)}`)
      if (item.resolvedChapter != null) lines.push(`- 完成章节：${chapterLabel(item.resolvedChapter)}`)
      if (item.expectedResolveChapter != null) lines.push(`- 预计回收：${chapterLabel(item.expectedResolveChapter)}`)
      if (item.importance) lines.push(`- 重要度：${({ high: "高", medium: "中", low: "低" })[item.importance]}`)
      if (item.relatedCharacters?.length) lines.push(`- 相关人物：${item.relatedCharacters.join("、")}`)
      if (item.relatedEvents?.length) lines.push(`- 相关事件：${item.relatedEvents.join("、")}`)
      if (item.notes) lines.push(`- 备注：${item.notes}`)
      lines.push("")
    }
    if (lines[lines.length - 2] === `## ${section}`) lines.push("暂无正式记录。", "")
  }
  appendCandidateSection(lines, memory.candidates.foreshadows)
  return `${lines.join("\n").trimEnd()}\n`
}

function buildTimelineDocument(memory: MemoryProjection): string {
  const lines = pageHeader("timeline", "时间线记忆")
  lines.push("## 已发生事件", "")
  for (const entry of memory.timeline) lines.push(`- ${entry.event}（来源：${chapterLabel(entry.chapterNumber)}）`)
  lines.push("")
  appendCandidateSection(lines, memory.candidates.timeline)
  return `${lines.join("\n").trimEnd()}\n`
}

function buildSimpleFactDocument(
  snapshots: ChapterSnapshot[],
  options: {
    memoryType: string
    title: string
    sectionTitle: string
    pick: (snapshot: ChapterSnapshot) => string[]
    keep?: (item: string) => boolean
  },
): string {
  const official = new Map<string, Set<number>>()
  const candidates: string[] = []
  for (const snapshot of snapshots) {
    for (const raw of options.pick(snapshot)) {
      const text = raw.trim()
      if (!text) continue
      if (UNCERTAIN_RE.test(text)) {
        candidates.push(`${chapterLabel(snapshot.chapterNumber)}：${text}`)
        continue
      }
      if (options.keep && !options.keep(text)) {
        continue
      }
      const chapters = official.get(text) ?? new Set<number>()
      chapters.add(snapshot.chapterNumber)
      official.set(text, chapters)
    }
  }

  const lines = pageHeader(options.memoryType, options.title)
  lines.push(`## ${options.sectionTitle}`, "")
  if (official.size === 0) {
    lines.push("暂无正式记录。", "")
  } else {
    for (const [text, chapters] of official) {
      lines.push(`- ${text}（来源：${joinChapterLabels(chapters)}）`)
    }
    lines.push("")
  }
  appendCandidateSection(lines, candidates)
  return `${lines.join("\n").trimEnd()}\n`
}

export function buildStructuredMemoryDocuments(snapshots: ChapterSnapshot[], memory = buildMemoryProjection(snapshots)): StructuredMemoryDocuments {
  const sortedSnapshots = snapshots.filter((s) => isValidMemorySnapshot(s, [])).sort((a, b) => a.chapterNumber - b.chapterNumber)
  return {
    "chapter-snapshots.md": buildChapterSnapshotsDocument(sortedSnapshots),
    "character-cognition.md": buildCharacterCognitionDocument(sortedSnapshots),
    "character-states.md": buildCharacterStatesDocument(memory),
    "foreshadowing-tracker.md": buildForeshadowingDocument(memory),
    "timeline.md": buildTimelineDocument(memory),
    "canon-facts.md": buildSimpleFactDocument(sortedSnapshots, {
      memoryType: "canon-facts",
      title: "正式设定记忆",
      sectionTitle: "正式事实",
      pick: (snapshot) => snapshot.newCanonFacts,
      keep: (item) => item.length <= 100,
    }),
    "conflicts.md": buildSimpleFactDocument(sortedSnapshots, {
      memoryType: "conflicts",
      title: "冲突追踪记忆",
      sectionTitle: "当前冲突",
      pick: (snapshot) => snapshot.conflicts,
      keep: (item) => item.length <= 100,
    }),
  }
}
