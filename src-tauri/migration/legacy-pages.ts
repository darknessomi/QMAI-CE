// Frozen renderer of the retired export format. Used only to prove that a
// legacy page is reproducible before replacing it; never used by the app.
import { join } from "node:path"
import { readdir } from "node:fs/promises"
import { readFile, fileExists, writeFileAtomic } from "./filesystem.mjs"
import { parseVolumeEntries, serializeVolumeEntries } from "@/lib/novel/retrieval/markdown-serializer"
import type { CharacterStateStore } from "@/lib/novel/character-state"
import type { Foreshadowing } from "@/lib/novel/foreshadowing-tracker"
import { emptyCognitionState, mergeCognitionFromSnapshot } from "@/lib/novel/character-cognition"
import type { TimelineEntry } from "@/lib/novel/timeline"
import { readContextMd, serializeContextMd } from "@/lib/novel/tracking-files"
type ResolvedForeshadowingRecord = { id: string; resolvedInChapter: number; resolution: string }
import type { ChapterSnapshot } from "@/lib/novel/chapter-ingest"
import { normalizeForeshadowingName } from "@/lib/novel/foreshadowing-normalize"

const UNCERTAIN_RE = /(可能|也许|似乎|疑似|或许|大概|推测|猜测|尚不确定|未证实)/u
const PUNCTUATION_RE = /[，。；：？！“”‘’（）《》【】<>]/u
const GENERIC_SUBJECT_RE = /^(?:\d+号.+|短发女人|长发女人|老太太|老头|老人|守卫|村民|灰白制服(?:人员|男人|女人)|两名灰白制服人员)$/u
interface StructuredMemoryDocuments {
  "chapter-snapshots.md": string
  "character-cognition.md": string
  "character-states.md": string
  "foreshadowing-tracker.md": string
  "timeline.md": string
  "canon-facts.md": string
  "conflicts.md": string
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

function buildCharacterStatesDocument(snapshots: ChapterSnapshot[]): string {
  const latest = new Map<string, { detail: string; chapter: number }>()
  const candidates: string[] = []

  for (const snapshot of snapshots) {
    for (const raw of snapshot.characterStateChanges) {
      const text = raw.trim()
      if (!text) continue
      if (UNCERTAIN_RE.test(text)) {
        candidates.push(`${chapterLabel(snapshot.chapterNumber)}：${text}`)
        continue
      }
      const subject = pickStableSubject(text, snapshot)
      if (!subject) continue
      const parsed = parseSubjectChange(text)
      latest.set(subject, {
        detail: parsed?.detail || text,
        chapter: snapshot.chapterNumber,
      })
    }
  }

  const lines = pageHeader("character-states", "人物状态记忆")
  lines.push("## 当前正式状态", "")
  const entries = [...latest.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-CN"))
  if (entries.length === 0) {
    lines.push("暂无正式状态记录。", "")
  } else {
    for (const [subject, value] of entries) {
      lines.push(`### ${subject}`)
      lines.push(`- 当前状态：${value.detail}`)
      lines.push(`- 最近更新：${chapterLabel(value.chapter)}`)
      lines.push("")
    }
  }
  appendCandidateSection(lines, candidates)
  return `${lines.join("\n").trimEnd()}\n`
}

function buildForeshadowingDocument(snapshots: ChapterSnapshot[]): string {
  const tracker = new Map<string, { name: string; description: string; planted: number; advanced: Set<number>; resolved?: number; sources: Set<number>; status: "planted" | "advanced" | "resolved" }>()
  const candidates: string[] = []

  for (const snapshot of snapshots) {
    for (const raw of snapshot.foreshadowingChanges) {
      const text = raw.trim()
      if (!text) continue
      if (UNCERTAIN_RE.test(text)) {
        candidates.push(`${chapterLabel(snapshot.chapterNumber)}：${text}`)
        continue
      }
      const normalized = normalizeForeshadowingName(text)
      if (!normalized.name) continue
      const existing = tracker.get(normalized.name) ?? {
        name: normalized.name,
        description: normalized.description,
        planted: snapshot.chapterNumber,
        advanced: new Set<number>(),
        sources: new Set<number>(),
        status: "planted" as const,
      }
      existing.description = existing.description.length >= normalized.description.length ? existing.description : normalized.description
      existing.planted = Math.min(existing.planted, snapshot.chapterNumber)
      existing.sources.add(snapshot.chapterNumber)
      if (/^(回收伏笔|回收)/u.test(text)) {
        existing.status = "resolved"
        existing.resolved = snapshot.chapterNumber
      } else if (/^(推进伏笔|推进)/u.test(text)) {
        if (existing.status !== "resolved") existing.status = "advanced"
        existing.advanced.add(snapshot.chapterNumber)
      }
      tracker.set(normalized.name, existing)
    }
  }

  const official = [...tracker.values()].sort((a, b) => a.planted - b.planted || a.name.localeCompare(b.name, "zh-CN"))
  const lines = pageHeader("foreshadowing-tracker", "伏笔追踪记忆")
  lines.push("## 进行中", "")
  const active = official.filter((item) => item.status !== "resolved")
  if (active.length === 0) {
    lines.push("暂无进行中的正式伏笔。", "")
  } else {
    for (const item of active) {
      lines.push(`### ${item.name}`)
      lines.push(`- 状态：${item.status === "advanced" ? "推进中" : "待推进"}`)
      lines.push(`- 说明：${item.description}`)
      lines.push(`- 初次出现：${chapterLabel(item.planted)}`)
      lines.push(`- 来源回查：${joinChapterLabels(item.sources)}`)
      lines.push("")
    }
  }
  lines.push("## 已完成", "")
  const resolved = official.filter((item) => item.status === "resolved")
  if (resolved.length === 0) {
    lines.push("暂无已完成伏笔。", "")
  } else {
    for (const item of resolved) {
      lines.push(`### ${item.name}`)
      lines.push("- 状态：已完成")
      lines.push(`- 说明：${item.description}`)
      lines.push(`- 初次出现：${chapterLabel(item.planted)}`)
      if (item.resolved) {
        lines.push(`- 完成章节：${chapterLabel(item.resolved)}`)
      }
      lines.push(`- 来源回查：${joinChapterLabels(item.sources)}`)
      lines.push("")
    }
  }
  appendCandidateSection(lines, candidates)
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

function renderLegacyPages(snapshots: ChapterSnapshot[]): StructuredMemoryDocuments {
  const sortedSnapshots = [...snapshots].sort((a, b) => a.chapterNumber - b.chapterNumber)
  return {
    "chapter-snapshots.md": buildChapterSnapshotsDocument(sortedSnapshots),
    "character-cognition.md": buildCharacterCognitionDocument(sortedSnapshots),
    "character-states.md": buildCharacterStatesDocument(sortedSnapshots),
    "foreshadowing-tracker.md": buildForeshadowingDocument(sortedSnapshots),
    "timeline.md": buildSimpleFactDocument(sortedSnapshots, {
      memoryType: "timeline",
      title: "时间线记忆",
      sectionTitle: "已发生事件",
      pick: (snapshot) => snapshot.timelineEvents,
      keep: (item) => item.length <= 80,
    }),
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


function compareGenerated(path: string, original: string, generated: string) {
  const lines = (value: string) => value.replace(/^\uFEFF/u, "").trimEnd().split(/\r?\n/u).map(line => line.trimEnd())
  const oldLines = lines(original)
  const newLines = lines(generated)
  const difference = oldLines.findIndex((line, index) => line !== newLines[index])
  if (difference >= 0 || oldLines.length !== newLines.length) {
    const number = difference >= 0 ? difference + 1 : oldLines.length + 1
    throw new Error(`${path} 第 ${number} 行与可从快照重建的内容不同。请先将自行编辑的内容保存到独立文档，并移出该文件后重试。项目保持原状。`)
  }
}

function serializeForeshadowingMd(
  items: Foreshadowing[],
  resolved: ResolvedForeshadowingRecord[],
): string {
  const active = items.filter((f) => f.status !== "resolved" && f.status !== "abandoned")
  const abandoned = items.filter((f) => f.status === "abandoned")
  const resolvedItems = resolved.length > 0
    ? resolved
    : items.filter((f) => f.status === "resolved").map((f) => ({
        id: f.id,
        resolvedInChapter: f.resolvedChapter ?? 0,
        resolution: `伏笔「${f.name}」在第${f.resolvedChapter}章回收`,
      }))

  const statusLabelOf = (status: string): string => {
    if (status === "planted") return "已埋设"
    if (status === "advanced") return "推进中"
    if (status === "abandoned") return "已放弃"
    return "推进中"
  }

  const lines: string[] = [
    "# 伏笔追踪",
    "",
    "## 活跃伏笔",
    "| ID | 伏笔内容 | 埋设章节 | 预计回收章节 | 状态 | 重要度 | 相关角色 | 备注 |",
    "|---|---|---|---|---|---|---|---|",
  ]

  for (const f of active) {
    const importance = f.importance ?? "medium"
    const statusLabel = statusLabelOf(f.status)
    const expectedChapter = f.expectedResolveChapter ? `第${f.expectedResolveChapter}章` : "待定"
    const relatedChars = (f.relatedCharacters || []).join("、")
    const content = f.description || f.name
    lines.push(
      `| ${f.id} | ${content} | 第${f.plantedChapter}章 | ${expectedChapter} | ${statusLabel} | ${importance} | ${relatedChars} | ${f.notes} |`,
    )
  }

  lines.push("", "## 已回收伏笔", "| ID | 伏笔内容 | 埋设章节 | 回收章节 | 回收方式 |", "|---|---|---|---|---|")

  for (const r of resolvedItems) {
    const f = items.find((fi) => fi.id === r.id)
    const plantedChapter = f?.plantedChapter ?? "?"
    const content = f?.description || f?.name || ""
    lines.push(`| ${r.id} | ${content} | 第${plantedChapter}章 | 第${r.resolvedInChapter}章 | ${r.resolution} |`)
  }

  lines.push("", "## 已放弃伏笔", "| ID | 伏笔内容 | 埋设章节 | 状态 | 备注 |", "|---|---|---|---|---|")
  for (const f of abandoned) {
    const content = f.description || f.name
    lines.push(`| ${f.id} | ${content} | 第${f.plantedChapter}章 | 已放弃 | ${f.notes} |`)
  }

  return lines.join("\n")
}

function serializeCharacterStateMd(store: CharacterStateStore): string {
  const lines: string[] = [
    "# 角色状态快照",
    "",
  ]

  let maxChapter = 0
  for (const c of store.characters) {
    if (c.lastUpdatedChapter > maxChapter) maxChapter = c.lastUpdatedChapter
  }

  if (maxChapter > 0) {
    lines.push(`> 最后更新：第${maxChapter}章`)
    lines.push("")
  }

  for (const c of store.characters) {
    lines.push(`## ${c.characterName}`)
    lines.push(`- **当前位置**：${c.currentLocation || "未知"}`)
    lines.push(`- **状态**：${c.status || "正常"}`)
    if (c.publicImage) lines.push(`- **公众形象**：${c.publicImage}`)
    if (c.pendingForeshadowing && c.pendingForeshadowing.length > 0) {
      lines.push(`- **待回收伏笔**：${c.pendingForeshadowing.join("、")}`)
    }
    if (c.stateChangeHistory && c.stateChangeHistory.length > 0) {
      lines.push("")
      lines.push("### 状态变更记录（最近10条）")
      for (const record of c.stateChangeHistory) {
        lines.push(`- 第${record.chapter}章：${record.change}`)
      }
    }
    lines.push("")
  }

  return lines.join("\n")
}

function serializeTimelineMd(entries: TimelineEntry[]): string {
  const lines: string[] = ["# 时间线", "", "| 章节 | 事件 |", "|---|---|"]
  const sorted = [...entries].sort((a, b) => a.chapterNumber - b.chapterNumber)
  for (const e of sorted) {
    lines.push(`| 第${e.chapterNumber}章 | ${e.event} |`)
  }
  return lines.join("\n")
}


async function verifyTracking(project: string) {
  type TrackingData = CharacterStateStore & { items: Foreshadowing[]; entries: TimelineEntry[] }
  const docs: Array<[string, string, (data: TrackingData) => string]> = [
    ["角色状态.md", "character-states.json", data => serializeCharacterStateMd(data)],
    ["伏笔.md", "foreshadowing-tracker.json", data => serializeForeshadowingMd(data.items, [])],
    ["时间线.md", "timeline.json", data => serializeTimelineMd(data.entries)],
  ]
  for (const [name, source, render] of docs) {
    const original = join(project, "migration-input", name)
    if (!(await fileExists(original))) continue
    const json = join(project, ".qmai/novel", source)
    if (!(await fileExists(json))) throw new Error(`QM/tracking/${name} 的来源 ${source} 缺失，请先保存追踪页或修复来源后重试。`)
    compareGenerated(`QM/tracking/${name}`, await readFile(original), render(JSON.parse(await readFile(json))))
  }
  const oldContext = join(project, "migration-input/上下文.md")
  const context = await fileExists(oldContext) ? oldContext : join(project, "QM/memory/writing-progress.md")
  if (await fileExists(context)) {
    const previous = await readContextMd(project)
    if (!previous) throw new Error("无法迁移旧写作进度")
    const authored = (s: string) => s.split(/\r?\n/).filter(line => !/^\| (最近完成章节|最近已提取正文|活跃伏笔数|关键待回收伏笔|最后更新) \|/.test(line)).join("\n")
    compareGenerated("QM/tracking/上下文.md", authored(await readFile(context)), authored(serializeContextMd(previous)))
  }
}
// Runtime JSON had no marker for a hand-edited status. Reproduce the old
// assignment rules to distinguish an actual override from a generated value.
async function preserveEditedStatuses(project: string, snapshots: ChapterSnapshot[]) {
  const file = join(project, ".qmai/novel/character-states.json")
  if (!(await fileExists(file))) return
  const prior = JSON.parse(await readFile(file)) as CharacterStateStore
  const generated = new Map<string, string>()
  const previousValues = new Map<string, Set<string>>()
  for (const snapshot of [...snapshots].sort((a, b) => a.chapterNumber - b.chapterNumber)) {
    for (const raw of snapshot.characterStateChanges) {
      const colon = raw.includes(":") ? raw.indexOf(":") : raw.indexOf("：")
      const name = colon > 0 ? raw.slice(0, colon).trim() : [...generated.keys()].find(n => raw.includes(n))
      if (!name) continue
      const value = colon > 0 ? raw.slice(colon + 1).trim() : raw
      generated.set(name, value)
      const seen = previousValues.get(name) ?? new Set<string>()
      seen.add(value)
      previousValues.set(name, seen)
    }
  }
  let changed = false
  for (const p of prior.characters) {
    const seen = previousValues.get(p.characterName)
    if (!p.status || p.manual) continue
    if (p.generatedStatus !== undefined) {
      if (p.generatedStatus && !seen?.has(p.generatedStatus)) throw new Error(`人物“${p.characterName}”在旧追踪页和 JSON 中有不同的人工状态，请核对后重试。`)
      continue
    }
    if (seen && !seen.has(p.status)) {
      p.generatedStatus = generated.get(p.characterName) ?? ""
      changed = true
    }
  }
  if (changed) await writeFileAtomic(file, JSON.stringify(prior))
}

async function verifyCognition(project: string, snapshots: ChapterSnapshot[]) {
  const path = join(project, ".qmai/novel/cognition-state.json")
  if (!(await fileExists(path))) return
  let existing: ReturnType<typeof emptyCognitionState>
  try {
    existing = JSON.parse(await readFile(path))
    if (!Array.isArray(existing.readerKnows) || !Array.isArray(existing.characters) ||
      existing.characters.some(c => !c || typeof c.character !== "string" || !Array.isArray(c.knows) || !Array.isArray(c.doesNotKnow))) {
      throw new Error()
    }
  } catch {
    throw new Error("旧 cognition-state.json 格式损坏，无法核对现有认知内容。请修复后重试。")
  }
  const expected = [...snapshots].sort((a,b) => a.chapterNumber-b.chapterNumber).reduce(mergeCognitionFromSnapshot, emptyCognitionState())
  // Compare facts, since incremental writes can legitimately reorder arrays.
  function normalized(data: typeof expected) {
    const rows = data.characters.flatMap(c => [
      ...c.knows.map(x => ["已知", c.character, x]),
      ...c.doesNotKnow.map(x => ["未知", c.character, x]),
    ])
    rows.push(...data.readerKnows.map(x => ["读者", x]))
    return rows.map(row => JSON.stringify(row)).sort()
  }
  if (JSON.stringify(normalized(existing)) !== JSON.stringify(normalized(expected))) {
    throw new Error("旧 cognition-state.json 有无法从正文快照复现的认知内容，请保存人工修订后重试。")
  }
}

export async function verifyLegacyPages(project: string, snapshots: ChapterSnapshot[]) {
  await verifyTracking(project)
  await preserveEditedStatuses(project, snapshots)
  await verifyCognition(project, snapshots)
  const pages = renderLegacyPages(snapshots)
  let hasPages = false
  for (const [name, generated] of Object.entries(pages)) {
    const relative = `QM/memory/${name}`
    const path = join(project, relative)
    if (await fileExists(path)) {
      hasPages = true
      compareGenerated(relative, await readFile(path), generated)
    }
  }
  const retrieval = join(project, ".qmai/retrieval")
  if (!(await fileExists(retrieval))) return hasPages
  const current = new Set(snapshots.map(s => s.chapterNumber))
  const byChapter = new Map<number, ReturnType<typeof parseVolumeEntries>[number]>()
  for (const name of await readdir(retrieval)) {
    const match = /^volume-(\d+)\.md$/.exec(name)
    if (!match) continue
    hasPages = true
    const original = await readFile(join(retrieval, name))
    const entries = parseVolumeEntries(original)
    compareGenerated(`retrieval/${name}`, original, serializeVolumeEntries(entries, `第${match[1]}卷`))
    for (const entry of entries) {
      if (byChapter.has(entry.chapterNumber)) throw new Error(`检索中有重复章号：第${entry.chapterNumber}章，请保留正确备注后重试。`)
      byChapter.set(entry.chapterNumber, entry)
    }
    const orphan = entries.find(e => !current.has(e.chapterNumber) && (e.manualNotes || e.manualReminders))
    if (orphan) throw new Error(`retrieval/${name} 第 ${orphan.chapterNumber} 章仍有人工备注或提醒，但缺少可迁移的快照。请先保存这些备注再重试。`)
  }
  const index = join(retrieval, "index.md")
  if (await fileExists(index)) {
    hasPages = true
    const headings = new Map([["## 伏笔倒排索引", "foreshadowingChanges"], ["## 人物倒排索引", "characterStates"], ["## 时间线倒排索引", "timelineEvents"]] as const)
    let section: string = ""
    const lines = (await readFile(index)).split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line || line === "# 检索主索引" || line === "- 暂无") continue
      if (line === "## 分卷目录" || [...headings.keys()].some(h => h === line)) { section = line; continue }
      if (section === "## 分卷目录" && /^- 第\d+卷：retrieval\/volume-\d+\.md（第\d+-\d+章）$/.test(line)) continue
      const key = [...headings].find(([h]) => h === section)?.[1]
      const match = /^- (.+)：(第\d+章(?:, 第\d+章)*)$/.exec(line)
      if (key && match && [...match[2].matchAll(/第(\d+)章/g)].every(m => byChapter.get(Number(m[1]))?.[key].includes(match[1]))) continue
      throw new Error(`retrieval/index.md 第 ${i + 1} 行含未识别的索引内容，请先保存人工补充后重试。`)
    }
  }
  return hasPages
}
