import { buildMemoryProjection } from "./memory-rebuild"
import {
  charsPerTokenForLanguage,
  resolveContextPackTokenBudget,
} from "@/lib/context-budget"
import { readFile } from "@/commands/fs"
import i18n from "@/i18n"
import { searchWiki, tokenizeQuery } from "@/lib/search"
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"
import { parseChapterMeta } from "./chapter-meta"
import { isAiExcludedContent } from "./ai-exclude"
import { listAiExcludedChapterNumbers } from "./ai-exclude-chapters"
import { parseFrontmatter } from "@/lib/frontmatter"
import { listSnapshots, loadSnapshot, type ChapterSnapshot } from "./chapter-ingest"
import { buildRevisionDirectives } from "./revision-feedback"
import { extractChapterOutlineStatus } from "./outline-quality-check"
import { loadCognitionState, cognitionToContextText } from "./character-cognition"
import { isGeneratedProjection } from "./persona-projection"
import { buildPersonaSkillContext } from "./persona-skill-context"
import { withMemoryWriteLock } from "./memory-cleanup-policy"
import { eligibleLocalSource, isAuthoritativeGenerationPath, isHistoricalProjectionSnippet, novelMixedSearch } from "./search-adapter"
import { getJevConfigState } from "@/lib/jev-config"
import { fitSagEvidence, formatSagEvidence, prepareSagChapterScope, searchSagProject } from "@/lib/sag-search"
import {
  DataSourceRegistry,
  type ContextLoadContext,
  type DataSourceLoadAdapter,
} from "./context-data-source"
import { getDataSourcesForCategories } from "./context-data-sources"
import type { DataSourceCategory } from "./classification"
import {
  buildOutlineContext,
  buildOutlineContextLayers,
  type OutlineContextLayers,
  type OutlineCharacterBrief,
  renderCharacterBriefs,
  buildVolumeContext,
  capOutlineSourcesToBudget,
  loadOutlineDocumentIndex,
  resolveChapterOutline,
} from "./outline-context-index"

const FIELD_PRIORITY: Record<string, number> = {
  sectionBriefing: 0,
  task: 1,
  chapterGoal: 2,
  mustDo: 3,
  mustAvoid: 4,
  /**
   * 同人原作正典：硬约束，必须在「人物状态」之前保留。
   * 用 4.5 而不是整数，避免改动任何既有字段的序号与 token 预算边界。
   */
  sourceCanon: 4.5,
  outline: 6,
  /** 本章章纲：写作链路（excludeOutline）下替代 mergedOutline 里的章纲部分，
   *  让「作品大纲」可以稳定前置、章纲下沉。优先级紧贴 outline。 */
  chapterOutlineContext: 6.5,
  recentSummaries: 7,
  previousChapterEnding: 8,
  characterStates: 9,
  personaSkills: 10.5,
  foreshadowingStates: 11,
  recentChapterContents: 12,
  revisionDirectives: 13,
  cognitionStates: 14,
  timeline: 15,
  relatedSettings: 16,
  /**
   * 「禁止违背」（硬性世界规则）是跨章不变的正确性约束，和原作正典同类，
   * 不能排在"最近摘要/人物状态/时间线/核心设定"这些**每章可再取**的辅助信息之后。
   *
   * 实测（12000~40000 预算的存活模拟）：提到 6.6（紧跟章纲）后，
   * ≤12000 时"留谁"的集合完全不变（截止点本来就在它之前），
   * ≥20000 时能把硬规则救回来，且不额外挤掉任何字段。
   * 没有再往前提到"章纲之前"——那样会为了硬规则牺牲本章章纲，得不偿失。
   */
  canonRules: 6.6,
  nextChapterAdvice: 18,
  writingStyle: 19,
  searchResults: 20,
  graphSearchResults: 21,
}

export interface TrimResult {
  prompt: string
  trimmedFields: string[]
  partiallyTrimmedField?: {
    fieldKey: string
    originalChars: number
    keptChars: number
  }
  trimmedChars: number
  originalChars: number
  finalChars: number
}

export interface ChapterSearchEvidence {
  chapterNumber?: number
  scopeKey?: string
  text: string
  warning?: string
}

export interface ContextPack {
  sagEvidence?: ChapterSearchEvidence
  task: string
  chapterGoal: string
  outline: string
  /** 全书总纲和设定；与当前章节无关。缺失表示旧版未分层上下文。 */
  projectOutline?: string
  /** 当前分卷、章节规划和章纲；仅放在动态任务层。 */
  chapterOutlineContext?: string
  /** 当前章命中的材料；只进动态层，不进稳定大纲。 */
  relevantMaterials?: string
  /** 仅供写作实体补搜提取候选名称，不注入任务书、正文或审稿提示词。 */
  entitySearchOutline?: string
  recentChapterContents?: string[]
  recentSummaries: string[]
  previousChapterEnding: string
  characterStates: string
  /** 与当前任务匹配的人物 Skill。 */
  personaSkills?: string
  cognitionStates: string
  foreshadowingStates: string
  sectionBriefing?: string
  timeline: string
  relatedSettings: string
  canonRules: string
  /**
   * 同一部**外部原作**的既成事实（同人正典）。
   *
   * 与 `canonRules` 的区别：`canonRules` 是本项目自己确认的正史（`wiki/canon.md`），
   * `sourceCanon` 来自 `.qmai/novel/fanfic-canon.md`，是用户导入的原作事实，按固定路径读取、
   * 不经模糊检索。原创项目恒为空串。
   *
   * 可选：手工构造的旧上下文包没有这个字段，消费方一律按「无正典」处理。
   */
  sourceCanon?: string
  writingStyle: string
  searchResults: string
  graphSearchResults: string
  mustDo: string
  mustAvoid: string
  nextChapterAdvice: string
  revisionDirectives: string
}

export async function buildContextPack(
  projectPath: string,
  task: string,
  chapterNumber?: number,
  options?: { categories?: DataSourceCategory[]; loadAdapter?: DataSourceLoadAdapter; signal?: AbortSignal; evidence?: ChapterSearchEvidence },
): Promise<ContextPack> {
  const pp = normalizePath(projectPath)
  if (!useWikiStore.getState().novelMode) return emptyPack(task)
  const context = buildLoadContext(pp, task, chapterNumber)
  const sources = getDataSourcesForCategories(options?.categories)
  const jev = getJevConfigState()
  const semantic = Boolean(jev.config || jev.error)
  const isSearchSource = (source: { name: string }) => source.name === "searchResults" || source.name === "graphSearchResults"
  const wantsSearch = sources.some(isSearchSource)
  const registry = new DataSourceRegistry({ loadAdapter: options?.loadAdapter })
  registry.registerAll(semantic ? sources.filter(source => !isSearchSource(source)) : sources)
  const beforeChapter = context.chapterNumber ?? Number.MAX_SAFE_INTEGER
  let scope: Awaited<ReturnType<typeof prepareSagChapterScope>> | undefined
  let failure = jev.error
  try {
    scope = await prepareSagChapterScope(pp, beforeChapter, options?.signal)
  } catch (error) {
    options?.signal?.throwIfAborted()
    failure ??= error instanceof Error ? error.message : String(error)
  }
  context.chapterScope = scope ?? { fingerprint: "unavailable", chapters: new Map() }

  const { pack, chapterOutline } = await withMemoryWriteLock(pp, async () => {
    const rawData = await registry.loadAll(context)
    return { pack: await buildContextPackFromRawData(rawData, context), chapterOutline: rawData.chapterOutline ?? "" }
  })
  options?.signal?.throwIfAborted()
  if (!semantic || !wantsSearch) return pack

  let scopeKey: string | undefined
  let evidence: ChapterSearchEvidence
  try {
    if (failure || !scope) throw new Error(failure || "未能校验可读取章节")
    const outline = chapterOutline.slice(0, 950)
    const goal = pack.chapterGoal.slice(0, 350)
    scopeKey = JSON.stringify([pp, beforeChapter, scope.fingerprint, outline, goal, context.config.searchTopK, jev.config?.endpoint, jev.config?.model])
    if (options?.evidence?.scopeKey === scopeKey) {
      evidence = options.evidence
    } else {
      const query = [context.task.slice(0, 650), goal, outline].filter(Boolean).join("\n")
      const hits = await searchSagProject(pp, query, context.config.searchTopK, {
        beforeChapter, signal: options?.signal, scope,
      })
      evidence = { chapterNumber: context.chapterNumber, scopeKey, text: formatSagEvidence(pp, hits) }
    }
  } catch (error) {
    options?.signal?.throwIfAborted()
    evidence = { chapterNumber: context.chapterNumber, scopeKey, text: "", warning: `本轮未取得 SAG2 原文证据：${error instanceof Error ? error.message : String(error)}` }
  }
  return { ...pack, sagEvidence: evidence, searchResults: evidence.text, graphSearchResults: "" }
}

/**
 * 构建加载上下文配置
 */
function buildLoadContext(
  projectPath: string,
  task: string,
  chapterNumber?: number,
): ContextLoadContext {
  const novelConfig = useWikiStore.getState().novelConfig
  const revisionFeedbackWindowConfig = useWikiStore.getState().revisionFeedbackWindowConfig
  
  return {
    projectPath,
    task,
    chapterNumber: chapterNumber ?? extractChapterNumberFromTask(task),
    config: {
      recentSummaryWindow: novelConfig.recentSummaryWindow > 0 ? novelConfig.recentSummaryWindow : 8,
      searchTopK: novelConfig.searchTopK > 0 ? novelConfig.searchTopK : 5,
      snapshotLookback: 3,
      revisionFeedbackWindowConfig,
    },
  }
}

/**
 * 从原始数据构建上下文包
 */
async function buildContextPackFromRawData(
  rawData: Record<string, any>,
  context: ContextLoadContext,
): Promise<ContextPack> {
  const searchResults = joinNonEmpty([
    rawData.searchResults || "",
  ], "\n\n")
  // retrieval 源返回项目级原始条目，按当前章节在此过滤
  interface RetrievalEntryShape {
    chapterNumber: number
    chapterTitle: string
    summary: string
    characterStates: string
    foreshadowingChanges: string
    timelineEvents: string
  }
  const retrievalEntries: RetrievalEntryShape[] = Array.isArray(rawData.retrieval?.entries)
    ? rawData.retrieval.entries
    : []
  const summaryCount = context.config.recentSummaryWindow > 0 ? context.config.recentSummaryWindow : 8
  const lookbackCount = context.config.snapshotLookback > 0 ? context.config.snapshotLookback : 3
  const summaryEntries = context.chapterNumber
    ? retrievalEntries.filter((e) => e.chapterNumber < context.chapterNumber!).slice(-summaryCount)
    : retrievalEntries.slice(-summaryCount)
  const lookbackEntries = context.chapterNumber
    ? retrievalEntries.filter((e) => e.chapterNumber < context.chapterNumber!).slice(-lookbackCount)
    : retrievalEntries.slice(-lookbackCount)
  /*
   * 「选中（AI 不读取）」：检索索引里的条目同样是章节派生数据（摘要 / 人物状态 /
   * 时间线），被选中的章号在这里剔除。
   *
   * 只反查**窗口内**的章号（summaryCount + lookbackCount 条），不按全书条目扫：
   * 这个函数每次生成都会跑，开销不能随章节数增长。
   */
  const excludedRetrievalNumbers = await listAiExcludedChapterNumbers(
    context.projectPath,
    [...summaryEntries, ...lookbackEntries].map((entry) => entry.chapterNumber),
    context.chapterScope?.chapters,
  )
  const visibleSummaryEntries = summaryEntries.filter((entry) => !excludedRetrievalNumbers.has(entry.chapterNumber))
  const visibleLookbackEntries = lookbackEntries.filter((entry) => !excludedRetrievalNumbers.has(entry.chapterNumber))
  const retrievalRecentSummaries = visibleSummaryEntries.map(
    (entry) => `第${entry.chapterNumber}章 ${entry.chapterTitle}：${entry.summary}`,
  )
  const retrievalCharacterStates = joinNonEmpty(
    visibleLookbackEntries
      .filter((e) => e.characterStates && e.characterStates !== "无明显变化")
      .map((e) => `第${e.chapterNumber}章：${e.characterStates}`),
    "\n",
  )
  const retrievalTimeline = joinNonEmpty(
    visibleLookbackEntries
      .filter((e) => e.timelineEvents && e.timelineEvents !== "无")
      .map((e) => `第${e.chapterNumber}章：${e.timelineEvents}`),
    "\n",
  )
  const retrievalForeshadowingSignals = visibleLookbackEntries
    .filter((e) => e.foreshadowingChanges && e.foreshadowingChanges !== "无")
    .flatMap((e) => e.foreshadowingChanges.split("\n").filter(Boolean))

  // 合并快照数据和降级数据，优先使用 retrieval 索引
  const snapshotRecentSummaries = Array.isArray(rawData.snapshots?.recentSummaries)
    ? rawData.snapshots.recentSummaries
    : []
  const recentSummaries = retrievalRecentSummaries.length > 0
    ? retrievalRecentSummaries
    : snapshotRecentSummaries.length > 0 
    ? snapshotRecentSummaries 
    : rawData.fallbackRecentSummaries ?? []
  const recentChapterContents = Array.isArray(rawData.recentChapterContents)
    ? rawData.recentChapterContents
    : []
  
  const previousChapterEnding = rawData.snapshots?.previousChapterEnding
    || rawData.fallbackPreviousEnding || ""
  
  const snapshotCharacterStates = rawData.snapshots?.characterStates || ""
  const characterStates = retrievalCharacterStates || snapshotCharacterStates || rawData.fallbackCharacterStates || ""
  const timeline = retrievalTimeline || rawData.snapshots?.timeline || rawData.fallbackTimeline || ""

  const snapshotForeshadowingSignals = Array.isArray(rawData.snapshots?.foreshadowingSignals)
    ? rawData.snapshots.foreshadowingSignals
    : []
  const foreshadowingSignals = retrievalForeshadowingSignals.length > 0
    ? retrievalForeshadowingSignals
    : snapshotForeshadowingSignals
  const foreshadowingStates = mergeForeshadowingSignals(
    foreshadowingSignals.length > 0 
      ? foreshadowingSignals 
      : [rawData.fallbackForeshadowingStates].filter(Boolean),
    searchResults,
  )
  
  const outlineLayers = rawData.outline && typeof rawData.outline === "object"
    && typeof rawData.outline.full === "string"
    && typeof rawData.outline.project === "string"
    && typeof rawData.outline.task === "string"
    ? rawData.outline as OutlineContextLayers
    : undefined
  const outline = outlineLayers?.full ?? (typeof rawData.outline === "string" ? rawData.outline : "")

  // 构建章节目标
  const chapterGoal = buildChapterGoal(
    outline,
    rawData.chapterOutline, 
    context.chapterNumber
  )

  const entitySearchOutline = selectWritingEntitySearchOutline({
    chapterOutline: rawData.chapterOutline,
    volumeContext: rawData.volumeContext,
    chapterGoal,
    outline,
  })
  
  // 合并大纲信息
  const mergedOutline = joinNonEmpty([
    outline,
    rawData.volumeContext ?? "",
    rawData.chapterOutline ?? ""
  ], "\n\n")
  
  // 构建修订指令
  const revisionDirectives = rawData.revisionFeedback?.mustFix ? buildRevisionDirectives(rawData.revisionFeedback) : ""
  
  const briefing = rawData.sectionBriefing
  const briefs: OutlineCharacterBrief[] = briefing?.characterBriefs ?? []
  const persona = await buildPersonaSkillContext(
    context.projectPath,
    joinNonEmpty([context.task, chapterGoal, rawData.chapterOutline ?? ""], "\n"),
    joinNonEmpty([characterStates, rawData.cognitionText ?? ""], "\n"),
    briefs,
    context.chapterScope?.chapters,
  ).catch(() => ({ skills: "", profileFacts: new Map<string, string>() }))
  const characterBriefs = renderCharacterBriefs(briefs, persona.profileFacts)
  const sectionBriefing = joinNonEmpty([
    briefing?.text ?? "",
    characterBriefs ? `### 相关人物小传\n${characterBriefs}` : "",
  ], "\n\n")

  return {
    task: context.task,
    chapterGoal,
    outline: mergedOutline,
    ...(outlineLayers ? {
      projectOutline: outlineLayers.project,
      // outlineLayers.task 已经包含「卷纲 + 章纲」。旧写法把 task、volumeContext、
      // chapterOutline 无条件拼在一起，同一段章纲会出现 2~3 次（浪费 token，
      // 也让模型读到重复段落）。这里只追加**确实没被 task 覆盖**的部分，
      // 索引落后/漏收时仍然不会丢内容。
      chapterOutlineContext: (() => {
        const taskText = outlineLayers.task.trim()
        const extras = [rawData.volumeContext, rawData.chapterOutline]
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter(Boolean)
        if (!taskText) return joinNonEmpty(extras, "\n\n")
        const uncovered = extras.filter((value) => !taskText.includes(value.slice(0, Math.min(200, value.length))))
        return joinNonEmpty([taskText, ...uncovered], "\n\n")
      })(),
      relevantMaterials: outlineLayers.materials,
    } : {}),
    entitySearchOutline,
    recentChapterContents,
    recentSummaries,
    previousChapterEnding,
    characterStates,
    sectionBriefing,
    ...(persona.skills ? { personaSkills: persona.skills } : {}),
    cognitionStates: rawData.cognitionText ?? "",
    foreshadowingStates,
    timeline,
    relatedSettings: rawData.relatedSettings ?? "",
    canonRules: rawData.canonRules ?? "",
    sourceCanon: typeof rawData.sourceCanon === "string" ? rawData.sourceCanon : "",
    writingStyle: rawData.writingStyle ?? "",
    searchResults,
    graphSearchResults: rawData.graphSearchResults ?? "",
    mustDo: buildMustDo(chapterGoal, previousChapterEnding, foreshadowingStates),
    mustAvoid: buildMustAvoid(rawData.canonRules ?? "", timeline, characterStates, rawData.sourceCanon),
    nextChapterAdvice: buildNextChapterAdvice({
      chapterGoal,
      recentSummaries,
      previousChapterEnding,
      foreshadowingStates,
      timeline,
      searchResults,
    }),
    revisionDirectives,
  }
}

function extractChapterNumberFromTask(task: string): number | undefined {
  const patterns = [
    /\u7b2c\s*(\d+)\s*\u7ae0/i,
    /chapter\s*(\d+)/i,
    /ch\.?\s*(\d+)/i,
  ]
  for (const pattern of patterns) {
    const match = task.match(pattern)
    if (match) {
      const value = Number(match[1])
      if (Number.isFinite(value) && value > 0) return value
    }
  }
  return undefined
}

export function selectLookbackChapterNumbers(chapterNumber: number, lookback: number): number[] {
  const result: number[] = []
  for (let current = chapterNumber - 1; current >= 1 && result.length < lookback; current -= 1) {
    result.push(current)
  }
  return result
}

function mergeForeshadowingSignals(signals: string[], searchResults: string): string {
  const normalized = signals
    .map((signal) => signal.trim())
    .filter(Boolean)

  if (normalized.length === 0 && !searchResults.trim()) return ""

  const unresolved = normalized.filter(signal => /未回收|未解决|新增伏笔/i.test(signal))
  const repeated = unresolved.filter(signal => {
    const keyword = signal.split(/[：:]/)[0]?.trim()
    return keyword && searchResults.includes(keyword)
  })

  const sections = [normalized.join("\n")]
  if (repeated.length > 0) {
    const names = repeated
      .map(signal => signal.split(/[：:]/)[0]?.trim())
      .filter(Boolean)
    sections.push(`以下伏笔近期反复出现，但尚未明显推进，需注意是否在本章继续铺设或回收：${Array.from(new Set(names)).join("、")}`)
  }
  return sections.filter(Boolean).join("\n\n")
}

function buildChapterGoal(outline: string, chapterOutline: string, chapterNumber?: number): string {
  const parts: string[] = []
  const fromOutline = extractChapterGoal(outline, chapterNumber)
  const fromChapterOutline = extractChapterGoal(chapterOutline, chapterNumber)
  if (fromOutline) parts.push(fromOutline)
  if (fromChapterOutline && !parts.includes(fromChapterOutline)) parts.push(fromChapterOutline)
  return parts.join("\n")
}

function buildMustDo(chapterGoal: string, previousChapterEnding: string, foreshadowingStates: string): string {
  const items: string[] = []
  chapterGoal.split("\n").map((line) => line.trim()).filter(Boolean).forEach((line) => items.push(`- ${line}`))
  if (previousChapterEnding.trim()) {
    items.push(i18n.t("novel.contextPack.mustDo.previousChapterEnding", { value: previousChapterEnding.trim() }))
  }
  if (foreshadowingStates.trim()) {
    const firstForeshadowing = foreshadowingStates.split("\n").find(Boolean)
    if (firstForeshadowing) {
      items.push(i18n.t("novel.contextPack.mustDo.foreshadowing", { value: firstForeshadowing.trim() }))
    }
  }
  return items.join("\n")
}

export function buildMustAvoid(
  canonRules: string,
  timeline: string,
  characterStates: string,
  sourceCanon?: string,
): string {
  const items: string[] = []
  // 同人正典可能很长，这里只放一条指针式硬约束，正文见「原作正典」段，避免重复占预算。
  if (sourceCanon?.trim()) {
    items.push(i18n.t("novel.contextPack.mustAvoid.sourceCanon"))
  }
  if (canonRules.trim()) items.push(i18n.t("novel.contextPack.mustAvoid.canonRules", { value: canonRules.trim() }))
  if (timeline.trim()) items.push(i18n.t("novel.contextPack.mustAvoid.timeline", { value: timeline.trim() }))
  if (characterStates.trim()) items.push(i18n.t("novel.contextPack.mustAvoid.characterStates", { value: characterStates.trim() }))
  return items.join("\n")
}

function buildNextChapterAdvice(input: {
  chapterGoal: string
  recentSummaries: string[]
  previousChapterEnding: string
  foreshadowingStates: string
  timeline: string
  searchResults: string
}): string {
  const advice: string[] = []
  if (input.previousChapterEnding.trim()) {
    advice.push(i18n.t("novel.contextPack.nextChapterAdvice.previousChapterEnding", { value: input.previousChapterEnding.trim() }))
  }
  if (input.chapterGoal.trim()) {
    advice.push(i18n.t("novel.contextPack.nextChapterAdvice.chapterGoal", { value: input.chapterGoal.trim() }))
  }
  if (input.foreshadowingStates.trim()) {
    const firstForeshadowing = input.foreshadowingStates.split("\n").find(Boolean)
    if (firstForeshadowing) {
      advice.push(i18n.t("novel.contextPack.nextChapterAdvice.foreshadowing", { value: firstForeshadowing.trim() }))
    }
  }
  if (input.timeline.trim()) {
    advice.push(i18n.t("novel.contextPack.nextChapterAdvice.timeline", { value: input.timeline.trim() }))
  }
  if (input.searchResults.trim()) {
    advice.push(i18n.t("novel.contextPack.nextChapterAdvice.searchResults", { value: input.searchResults.trim() }))
  }
  if (input.recentSummaries.length > 0) {
    advice.push(i18n.t("novel.contextPack.nextChapterAdvice.recentSummaries", { value: input.recentSummaries.slice(-2).join("；") }))
  }
  return advice.join("\n")
}

export function joinNonEmpty(parts: string[], separator: string): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(separator)
}

export function selectWritingEntitySearchOutline(input: {
  chapterOutline?: string
  volumeContext?: string
  chapterGoal?: string
  outline?: string
}): string {
  for (const candidate of [
    input.chapterOutline,
    input.volumeContext,
    input.chapterGoal,
    input.outline,
  ]) {
    const normalized = candidate?.trim() ?? ""
    if (normalized) return normalized
  }
  return ""
}

function emptyPack(task: string): ContextPack {
  return {
    task,
    chapterGoal: "",
    outline: "",
    entitySearchOutline: "",
    recentChapterContents: [],
    recentSummaries: [],
    previousChapterEnding: "",
    characterStates: "",
    cognitionStates: "",
    foreshadowingStates: "",
    sectionBriefing: "",
    timeline: "",
    relatedSettings: "",
    canonRules: "",
    sourceCanon: "",
    writingStyle: "",
    searchResults: "",
    graphSearchResults: "",
    mustDo: "",
    mustAvoid: "",
    nextChapterAdvice: "",
    revisionDirectives: "",
  }
}

export async function readOutlineContextLayers(pp: string, chapterNumber?: number): Promise<OutlineContextLayers> {
  try {
    return buildOutlineContextLayers(await loadOutlineDocumentIndex(pp), chapterNumber)
  } catch {
    return { full: "", project: "", task: "", materials: "" }
  }
}

export async function readOutlineContent(pp: string, chapterNumber?: number): Promise<string> {
  try {
    return buildOutlineContext(await loadOutlineDocumentIndex(pp), chapterNumber)
  } catch {
    return ""
  }
}

function readFrontmatterChapterNumber(content: string): number | undefined {
  const raw = parseFrontmatter(content).frontmatter?.chapter_number
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function numberToChineseChapter(value: number): string {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"]
  if (value <= 10) {
    if (value === 10) return "十"
    return digits[value] ?? String(value)
  }
  if (value < 20) return `十${digits[value - 10]}`
  if (value < 100) {
    const tens = Math.floor(value / 10)
    const ones = value % 10
    return `${digits[tens]}十${ones === 0 ? "" : digits[ones]}`
  }
  if (value < 1000) {
    const hundreds = Math.floor(value / 100)
    const rest = value % 100
    if (rest === 0) return `${digits[hundreds]}百`
    if (rest < 10) return `${digits[hundreds]}百零${digits[rest]}`
    return `${digits[hundreds]}百${numberToChineseChapter(rest)}`
  }
  return String(value)
}

function chapterLabels(chapterNumber: number): string[] {
  return [`第${chapterNumber}章`, `第${numberToChineseChapter(chapterNumber)}章`]
}

function includesChapterMarker(text: string, chapterNumber: number): boolean {
  const compact = text.replace(/\s+/g, "")
  return chapterLabels(chapterNumber).some((label) => compact.includes(label)) ||
    new RegExp(`chapter\\s*${chapterNumber}\\b`, "i").test(text)
}

function hasChapterHeading(content: string, chapterNumber: number): boolean {
  const labels = chapterLabels(chapterNumber)
  return content.split(/\r?\n/).some((line) => {
    const compact = line.trim().replace(/\s+/g, "")
    const heading = compact.replace(/^#{1,6}/, "")
    if (heading === compact) return false
    return labels.some((label) =>
      heading === label ||
      heading.startsWith(`${label}：`) ||
      heading.startsWith(`${label}:`) ||
      heading.startsWith(`${label}-`) ||
      heading.startsWith(`${label}—`),
    )
  })
}

export function pickChapterOutlineByNumber(
  candidates: Array<{ path: string; content: string }>,
  chapterNumber: number,
): string {
  const frontmatterMatch = candidates.find((candidate) => readFrontmatterChapterNumber(candidate.content) === chapterNumber)
  if (frontmatterMatch) return frontmatterMatch.content.slice(0, 4000)

  const headingMatch = candidates.find((candidate) =>
    hasChapterHeading(candidate.content, chapterNumber) || includesChapterMarker(candidate.path, chapterNumber),
  )
  if (headingMatch) return headingMatch.content.slice(0, 4000)

  return ""
}

export async function readChapterOutlineContent(pp: string, chapterNumber?: number): Promise<string> {
  if (!chapterNumber) return ""
  try {
    const resolution = resolveChapterOutline(await loadOutlineDocumentIndex(pp), chapterNumber)
    if (!resolution.content.trim()) return ""
    return resolution.sourceKind === "standalone"
      ? annotateChapterOutlineStatus(resolution.content)
      : resolution.content
  } catch {
    return ""
  }
}

export async function readVolumeContextContent(pp: string, chapterNumber?: number): Promise<string> {
  if (!chapterNumber) return ""
  try {
    return buildVolumeContext(await loadOutlineDocumentIndex(pp), chapterNumber)
  } catch {
    return ""
  }
}

export function annotateChapterOutlineStatus(content: string): string {
  const status = extractChapterOutlineStatus(content)
  if (status === "已确认") return content
  const label = status === "未知" ? "未标明当前状态" : `当前状态为「${status}」`
  return [
    `【章纲状态提示】该章纲${label}。本标记仅说明资料状态，不构成暂停生成、要求确认或向用户追问的指令；用户已明确要求生成目标章节时，应按章纲已有内容执行，不得自行补写或改写章纲。`,
    "",
    content,
  ].join("\n")
}

// 以下函数已被数据源模式使用，但通过动态导入，TypeScript 无法检测到
// @ts-expect-error - 函数通过动态导入在 context-data-sources.ts 中使用
async function readSnapshotContext(
  pp: string,
  chapterNumber: number | undefined,
  recentSummaryWindow: number,
  snapshotLookback: number,
): Promise<{
  recentSummaries: string[]
  previousChapterEnding: string
  characterStates: string
  foreshadowingSignals: string[]
  timeline: string
}> {
  const snapshotNumbers = await listSnapshots(pp)
  if (snapshotNumbers.length === 0) {
    return {
      recentSummaries: [],
      previousChapterEnding: "",
      characterStates: "",
      foreshadowingSignals: [],
      timeline: "",
    }
  }

  const lookbackNumbers = chapterNumber
    ? selectLookbackChapterNumbers(chapterNumber, snapshotLookback)
    : [...snapshotNumbers].sort((a, b) => b - a).slice(0, snapshotLookback)
  const summaryNumbers = chapterNumber
    ? snapshotNumbers.filter((n) => n < chapterNumber).slice(-recentSummaryWindow)
    : snapshotNumbers.slice(-recentSummaryWindow)

  const [lookbackSnapshots, summarySnapshots] = await Promise.all([
    Promise.all(lookbackNumbers.map((n) => loadSnapshot(pp, n))),
    Promise.all(summaryNumbers.map((n) => loadSnapshot(pp, n))),
  ])

  // 「选中（AI 不读取）」：被选中章节的派生快照一并不进上下文（口径见 ai-exclude-chapters.ts）。
  const excludedSnapshotNumbers = await listAiExcludedChapterNumbers(pp, [...lookbackNumbers, ...summaryNumbers])

  const validLookback = lookbackSnapshots
    .filter((snapshot): snapshot is ChapterSnapshot => Boolean(snapshot))
    .filter((snapshot) => !excludedSnapshotNumbers.has(snapshot.chapterNumber))
  const validSummarySnapshots = summarySnapshots
    .filter((snapshot): snapshot is ChapterSnapshot => Boolean(snapshot))
    .filter((snapshot) => !excludedSnapshotNumbers.has(snapshot.chapterNumber))

  const previousSnapshot = validLookback[0]
    const official = buildMemoryProjection(validLookback).officialSnapshots
  const recentSummaries = validSummarySnapshots.map((snapshot) => `第${snapshot.chapterNumber}章：${snapshot.summary}`)
  const characterStates = joinNonEmpty(
    official
      .flatMap((snapshot) => snapshot.characterStateChanges.map((change) => `第${snapshot.chapterNumber}章：${change}`)),
    "\n",
  )
  const foreshadowingSignals = official.flatMap((snapshot) => snapshot.foreshadowingChanges)
  const timeline = joinNonEmpty(
    official
      .flatMap((snapshot) => snapshot.timelineEvents.map((event) => `第${snapshot.chapterNumber}章：${event}`)),
    "\n",
  )

  return {
    recentSummaries,
    previousChapterEnding: previousSnapshot?.endingHook || "",
    characterStates,
    foreshadowingSignals,
    timeline,
  }
}

// @ts-expect-error - 函数通过动态导入在 context-data-sources.ts 中使用
async function readRecentChapterSummaries(pp: string, count: number): Promise<string[]> {
  const summaries: string[] = []
  try {
    const results = await searchWiki(pp, "type:chapter", { localOnly: true })
    for (const r of results.slice(0, count)) {
      try {
        const content = await readFile(r.path)
        // 「选中（AI 不读取）」：被排除的章节不进摘要。
        if (isAiExcludedContent(content)) continue
        const parsed = parseFrontmatter(content)
        const fm = parsed.frontmatter as Record<string, unknown> | null
        const meta = fm ? parseChapterMeta(fm) : null
        if (meta) {
          const bodyStart = content.indexOf("---", 4)
          const body = bodyStart >= 0 ? content.slice(bodyStart + 3).trim() : content
          summaries.push(`第${meta.chapterNumber}章 (${meta.status}): ${body.slice(0, 500)}`)
        }
      } catch {}
    }
  } catch {}
  return summaries
}

// @ts-expect-error - 函数通过动态导入在 context-data-sources.ts 中使用
async function readPreviousChapterEnding(pp: string, chapterNumber?: number): Promise<string> {
  if (!chapterNumber || chapterNumber <= 1) return ""
  try {
    const results = await searchWiki(pp, `chapter_number:${chapterNumber - 1}`, { localOnly: true })
    if (results.length > 0) {
      const content = await readFile(results[0].path)
      // 「选中（AI 不读取）」：被排除的章节连结尾钩子都不给。
      if (isAiExcludedContent(content)) return ""
      const lines = content.split("\n")
      const lastLines = lines.slice(-10).join("\n")
      return lastLines
    }
  } catch {}
  return ""
}

// @ts-expect-error - 函数通过动态导入在 context-data-sources.ts 中使用
async function readCharacterStates(pp: string): Promise<string> {
  try {
    const results = await searchWiki(pp, "type:entity character", { localOnly: true })
    if (results.length > 0) {
      const contents = await Promise.all(results.slice(0, 5).map(r => readFile(r.path).catch(() => "")))
      return contents.filter(Boolean).join("\n---\n").slice(0, 3000)
    }
  } catch {}
  return ""
}

// @ts-expect-error - 函数通过动态导入在 context-data-sources.ts 中使用
async function readCognitionStates(pp: string): Promise<string> {
  try {
    const state = await loadCognitionState(pp)
    if (!state) return ""
    return cognitionToContextText(state)
  } catch {}
  return ""
}

// @ts-expect-error - 函数通过动态导入在 context-data-sources.ts 中使用
async function readForeshadowingStates(pp: string): Promise<string> {
  try {
    const results = await searchWiki(pp, "伏笔 foreshadowing", { localOnly: true })
    if (results.length > 0) {
      const contents = await Promise.all(results.slice(0, 3).map(r => readFile(r.path).catch(() => "")))
      return contents.filter(Boolean).join("\n---\n").slice(0, 2000)
    }
  } catch {}
  return ""
}

// @ts-expect-error - 函数通过动态导入在 context-data-sources.ts 中使用
async function readTimeline(pp: string): Promise<string> {
  try {
    const results = await searchWiki(pp, "timeline 时间线", { localOnly: true })
    if (results.length > 0) {
      const content = await readFile(results[0].path)
      return content.slice(0, 2000)
    }
  } catch {}
  return ""
}

// @ts-expect-error - 函数通过动态导入在 context-data-sources.ts 中使用
async function readRelatedSettings(pp: string): Promise<string> {
  try {
    const results = await searchWiki(pp, "setting 设定 location 地点", { localOnly: true })
    if (results.length > 0) {
      const contents = await Promise.all(results.slice(0, 3).map(r => readFile(r.path).catch(() => "")))
      return contents.filter(Boolean).join("\n---\n").slice(0, 2000)
    }
  } catch {}
  return ""
}

// @ts-expect-error - 函数通过动态导入在 context-data-sources.ts 中使用
async function readCanonRules(pp: string): Promise<string> {
  try {
    const results = await searchWiki(pp, "canon 正史 rule 规则", { localOnly: true })
    if (results.length > 0) {
      const content = await readFile(results[0].path)
      return content.slice(0, 2000)
    }
  } catch {}
  return ""
}

// @ts-expect-error - 函数通过动态导入在 context-data-sources.ts 中使用
async function readWritingStyle(pp: string): Promise<string> {
  // 优先：已启用的文风预设。
  // buildWritingStyleContext 内部已做长度上限与"只学文风不借剧情"硬约束。
  try {
    const { buildWritingStyleContext } = await import("./writing-style-store")
    const styleContext = await buildWritingStyleContext(pp)
    if (styleContext.trim()) return styleContext
  } catch {}
  // 回退：wiki 中的风格页（旧行为）。
  try {
    const results = await searchWiki(pp, "style 风格 writing 写作", { localOnly: true })
    if (results.length > 0) {
      const content = await readFile(results[0].path)
      return content.slice(0, 1000)
    }
  } catch {}
  return ""
}

// @ts-expect-error - 函数通过动态导入在 context-data-sources.ts 中使用
async function readVolumeContext(
  pp: string,
  chapterNumber: number | undefined,
): Promise<string> {
  if (!chapterNumber) return ""
  return readVolumeContextContent(pp, chapterNumber)
}

export async function searchRelevantContentUnified(
  pp: string,
  task: string,
  chapterNumber: number | undefined,
  limit: number,
  readableChapters?: ReadonlyMap<number, string>,
): Promise<string> {
  const tokens = tokenizeQuery(task)
  const entityHints = tokens.filter((t) => t.length >= 2).slice(0, 5)
  const queryParts = [task]
  if (chapterNumber) {
    queryParts.push(`chapter ${chapterNumber}`)
  }
  if (entityHints.length > 0) {
    queryParts.push(entityHints.join(" "), "伏笔", "人物", "设定", "时间线")
  } else {
    queryParts.push("伏笔", "人物", "设定")
  }
  const query = queryParts.join(" ")

  const [semanticResults, indexResults] = await Promise.all([
    novelMixedSearch({
      projectPath: pp,
      query,
      chapterNumber,
      readableChapters,
      topK: Math.max(limit * 2, 6),
      authoritativeOnly: true,
      includeKeyword: true,
      includeGraph: true,
      includeRecentChapters: true,
      includeCanon: true,
    }).catch(() => []),
    searchWiki(pp, task, {
      localOnly: true,
      acceptFile: (path, content) => eligibleLocalSource(path, content, chapterNumber, readableChapters),
      topK: Math.max(limit, 4),
    }).catch(() => []),
  ])

  const candidates = [
    ...semanticResults.map((result) => ({
      id: `${result.type}:${result.path}`,
      path: result.path,
      title: result.title,
      snippet: result.snippet ?? "",
      source: result.type,
    })),
    ...indexResults.map((result) => ({
      id: `index:${result.path}`,
      path: result.path,
      title: result.title,
      snippet: result.snippet ?? "",
      source: "index",
    })),
  ].filter((item) => {
    const path = typeof (item as { path?: unknown }).path === "string"
      ? (item as { path?: string }).path ?? ""
      : ""
    const snippet = item.snippet ?? ""
    if (!path || isHistoricalProjectionSnippet(path, snippet)) return false
    return isAuthoritativeGenerationPath(path)
  })

  const deduplicatedCandidates = candidates.filter((item, index, all) => {
    const path = typeof item.path === "string" ? normalizePath(item.path) : ""
    if (!path) return all.findIndex((candidate) => candidate.id === item.id) === index
    return all.findIndex((candidate) => (
      typeof candidate.path === "string" && normalizePath(candidate.path) === path
    )) === index
  })

  const merged: string[] = []
  const seen = new Set<string>()
  for (const result of deduplicatedCandidates) {
    const key = result.path
      ? normalizePath(result.path)
      : `${result.title}|${result.snippet.slice(0, 50)}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(`- ${result.title}: ${result.snippet}`)
  }

  return merged.slice(0, Math.max(limit * 2, limit)).join("\n")
}

export async function searchGraphRelevantContent(
  pp: string,
  task: string,
  chapterNumber: number | undefined,
  limit = 10,
  readableChapters?: ReadonlyMap<number, string>,
): Promise<string> {
  const topK = Math.max(1, Math.floor(limit) || 10)
  try {
    const { buildRetrievalGraph, getRelatedNodes } = await import("@/lib/graph-relevance")
    const graph = await buildRetrievalGraph(pp)
    if (graph.nodes.size === 0) return ""

    const tokens = tokenizeQuery(task)
    const candidateNames = new Set<string>()

    for (const token of tokens) {
      if (token.length >= 2) candidateNames.add(token)
    }

    for (const [, node] of graph.nodes) {
      if (task.includes(node.title) || task.includes(node.id)) {
        candidateNames.add(node.title)
        candidateNames.add(node.id)
      }
      for (const name of candidateNames) {
        if (node.title.includes(name) || node.id.includes(name)) {
          candidateNames.add(node.title)
          candidateNames.add(node.id)
        }
      }
    }

    const seenIds = new Set<string>()
    const scoredNodes: { title: string; snippet: string; relevance: number }[] = []

    for (const name of candidateNames) {
      const matchedNodes = Array.from(graph.nodes.values()).filter(
        n => n.title.includes(name) || n.id.includes(name),
      )
      for (const matchedNode of matchedNodes) {
        if (seenIds.has(matchedNode.id)) continue
        seenIds.add(matchedNode.id)

        const related = getRelatedNodes(matchedNode.id, graph, 5)
        for (const { node, relevance } of related) {
          if (seenIds.has(node.id)) continue
          seenIds.add(node.id)
          try {
            const content = await readFile(node.path)
            if (isAiExcludedContent(content) || isGeneratedProjection(content)) continue
            if (chapterNumber && !eligibleLocalSource(node.path, content, chapterNumber, readableChapters)) continue
            scoredNodes.push({
              title: node.title,
              snippet: content.slice(0, 300).replace(/\n/g, " "),
              relevance: Math.round(relevance * 100) / 100,
            })
          } catch {}
        }
      }
    }

    scoredNodes.sort((a, b) => b.relevance - a.relevance)
    const topNodes = scoredNodes.slice(0, topK)
    const nodeResults = topNodes.length > 0
      ? topNodes.map(
          n => `- 【${n.title}】(关联度 ${n.relevance}): ${n.snippet}`,
        ).join("\n")
      : ""

    return nodeResults
  } catch {
    return ""
  }
}

function extractChapterGoal(outline: string, chapterNumber?: number): string {
  if (!chapterNumber || !outline) return ""
  const cleaned = outline.replace(/^---[\s\S]*?---\s*/m, "").trim()
  for (const line of cleaned.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const compact = trimmed.replace(/\s+/g, "")
    for (const label of chapterLabels(chapterNumber)) {
      if (compact.includes(label)) {
        const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const rest = trimmed.replace(new RegExp(`^#*\\s*${escapedLabel}[：:、\\s-]*`), "").trim()
        return (rest || cleaned).slice(0, 2500)
      }
    }
    const englishMatch = trimmed.match(new RegExp(`^#*\\s*Chapter\\s*${chapterNumber}[：:\\s-]*(.+)?$`, "i"))
    if (englishMatch) {
      return ((englishMatch[1] ?? "").trim() || cleaned).slice(0, 2500)
    }
  }
  if (includesChapterMarker(cleaned, chapterNumber)) return cleaned.slice(0, 2500)
  return ""
}

interface FieldConfig {
  titleKey: string
  fieldKey: keyof ContextPack
}

const FIELD_CONFIGS: FieldConfig[] = [
  { titleKey: "novel.contextPack.sectionBriefing", fieldKey: "sectionBriefing" },
  { titleKey: "novel.contextPack.currentChapterGoal", fieldKey: "chapterGoal" },
  { titleKey: "novel.contextPack.mustDo.title", fieldKey: "mustDo" },
  { titleKey: "novel.contextPack.mustAvoid.title", fieldKey: "mustAvoid" },
  { titleKey: "novel.contextPack.nextChapterAdvice.title", fieldKey: "nextChapterAdvice" },
  { titleKey: "novel.contextPack.recentRevisionDirectives", fieldKey: "revisionDirectives" },
  { titleKey: "novel.contextPack.requiredOutline", fieldKey: "outline" },
  { titleKey: "novel.contextPack.chapterOutline", fieldKey: "chapterOutlineContext" },
  { titleKey: "novel.contextPack.recentChapterContents", fieldKey: "recentChapterContents" },
  { titleKey: "novel.contextPack.recentPlotSummaries", fieldKey: "recentSummaries" },
  { titleKey: "novel.contextPack.previousChapterEnding", fieldKey: "previousChapterEnding" },
  { titleKey: "novel.contextPack.characterStates", fieldKey: "characterStates" },
  { titleKey: "novel.contextPack.personaSkills", fieldKey: "personaSkills" },
  { titleKey: "novel.contextPack.cognitionStates", fieldKey: "cognitionStates" },
  { titleKey: "novel.contextPack.foreshadowingStates", fieldKey: "foreshadowingStates" },
  { titleKey: "novel.contextPack.timeline", fieldKey: "timeline" },
  { titleKey: "novel.contextPack.relatedSettings", fieldKey: "relatedSettings" },
  { titleKey: "novel.contextPack.canonRules", fieldKey: "canonRules" },
  { titleKey: "novel.contextPack.sourceCanon", fieldKey: "sourceCanon" },
  { titleKey: "novel.contextPack.writingStyle", fieldKey: "writingStyle" },
  { titleKey: "novel.contextPack.searchResults", fieldKey: "searchResults" },
  { titleKey: "novel.contextPack.graphSearchResults", fieldKey: "graphSearchResults" },
]

/**
 * 上下文字段的**输出顺序**，与 {@link FIELD_PRIORITY}（裁剪优先级）解耦。
 *
 * 优先级决定"预算不够时留谁"，输出顺序决定"写进 prompt 的先后"。
 * provider 的前缀缓存只认从第 0 个字节起连续相同的部分，所以：
 * **作品级稳定字段必须写在最前面，随章变化的字段（任务/章纲/状态/检索）写在最后。**
 *
 * 旧实现直接用优先级顺序输出，`## 当前任务 / 写第N章` 落在第 18 个字符，
 * 于是每换一章，整包上下文从第 20 个字符起全部失效（实测跨章公共前缀 0.2%）。
 */
const FIELD_EMIT_ORDER: string[] = [
  // 作品级稳定：整本书内逐字节不变
  "sourceCanon",
  "canonRules",
  "writingStyle",
  // 作品+卷+章合并大纲：含章纲，随章变（review 等未 excludeOutline 的场景走这里）
  "outline",
  // 写作链路里章纲单独成段，跟在（已稳定的）作品大纲之后
  "chapterOutlineContext",
  // 以下随章/随轮变化
  "task",
  "chapterGoal",
  "sectionBriefing",
  "mustDo",
  "mustAvoid",
  "relatedSettings",
  "previousChapterEnding",
  "characterStates",
  "personaSkills",
  "foreshadowingStates",
  "cognitionStates",
  "timeline",
  "recentSummaries",
  "recentChapterContents",
  "revisionDirectives",
  "nextChapterAdvice",
  "searchResults",
  "graphSearchResults",
]

function emitRank(fieldKey: string): number {
  const index = FIELD_EMIT_ORDER.indexOf(fieldKey)
  return index < 0 ? FIELD_EMIT_ORDER.length : index
}

/** 正典被预算裁掉时的统一提示。 */
export const SOURCE_CANON_OVERFLOW_MESSAGE =
  "上下文预算不足，原作正典未完整保留。请减少本次参考内容或选择更大上下文模型，已停止生成。"

/** 正典溢出错误。调用方需要据此停机，而不是继续生成。 */
export class SourceCanonOverflowError extends Error {
  constructor(message: string = SOURCE_CANON_OVERFLOW_MESSAGE) {
    super(message)
    this.name = "SourceCanonOverflowError"
  }
}

/**
 * 正典是硬约束：静默丢掉它会让模型凭空编造原作事实，宁可停下来报错。
 *
 * 提示词有**两条**构建路径（`contextPackToPrompt` 与 `trim-context-plugin` 里的
 * `trimContextPack`），守卫必须两条都装，只装一条会留下静默丢弃的缺口。
 */
export function assertSourceCanonPreserved(pack: ContextPack, prompt: string): void {
  if (pack.sourceCanon?.trim() && !prompt.includes(pack.sourceCanon)) {
    throw new SourceCanonOverflowError()
  }
}

export function contextPackToPrompt(
  pack: ContextPack,
  tokenBudget?: number,
  options?: { excludeOutline?: boolean; maxContextSize?: number },
): string {
  const result = trimContextPack(pack, tokenBudget, options)
  assertSourceCanonPreserved(pack, result.prompt)
  return result.prompt
}

function trimFieldContent(content: string | string[], maxChars: number): string | string[] {
  if (Array.isArray(content)) {
    if (content.length === 0) return content
    const result: string[] = []
    let total = 0
    for (let i = content.length - 1; i >= 0; i--) {
      const item = content[i]
      if (total + item.length <= maxChars) {
        result.unshift(item)
        total += item.length
      } else {
        break
      }
    }
    if (result.length === 0 && content.length > 0) {
      const last = content[content.length - 1]
      return [last.slice(0, maxChars) + "..."]
    }
    return result
  } else {
    if (content.length <= maxChars) return content
    if (maxChars < 50) return content.slice(0, maxChars) + "..."
    const headChars = Math.floor(maxChars * 0.4)
    const tailChars = maxChars - headChars - 5
    return content.slice(0, headChars) + "\n...\n" + content.slice(-tailChars)
  }
}

export function trimContextPack(
  pack: ContextPack,
  tokenBudget?: number,
  options?: { excludeOutline?: boolean; maxContextSize?: number }
): TrimResult {
  const sections: string[] = []

  sections.push(i18n.t("novel.contextPack.title"))
  sections.push("")

  const resolvedTokenBudget = tokenBudget && tokenBudget > 0
    ? tokenBudget
    : resolveContextPackTokenBudget({ maxContextSize: options?.maxContextSize })
  const targetChars = Math.floor(resolvedTokenBudget * charsPerTokenForLanguage())
  const fieldData: { fieldKey: string; title: string; content: string | string[]; priority: number; charCount: number }[] = []
  for (const config of FIELD_CONFIGS) {
    if (options?.excludeOutline && config.fieldKey === "outline") {
      continue
    }
    // 不排除 outline 时，章纲已经在 mergedOutline 里了，再单独输出会重复。
    if (!options?.excludeOutline && config.fieldKey === "chapterOutlineContext") {
      continue
    }

    const rawContent = pack[config.fieldKey as keyof ContextPack] as string | string[] | undefined
    const sag = config.fieldKey === "searchResults" && Boolean(pack.sagEvidence?.text)
    const content = sag && typeof rawContent === "string"
      ? fitSagEvidence(rawContent, Math.floor(targetChars / 5))
      : rawContent ?? ""
    const hasContent = Array.isArray(content) ? content.length > 0 : Boolean(content)
    if (!hasContent) continue

    const charCount = Array.isArray(content)
      ? content.reduce((sum, item) => sum + item.length, 0)
      : content.length

    fieldData.push({
      fieldKey: config.fieldKey,
      title: i18n.t(config.titleKey),
      content,
      priority: sag ? 4.75 : FIELD_PRIORITY[config.fieldKey] ?? 999,
      charCount,
    })
  }

  // 当前任务是正文的一部分，但**输出位置必须排在稳定字段之后**（见 FIELD_EMIT_ORDER）。
  if (pack.task && pack.task.trim()) {
    fieldData.push({
      fieldKey: "task",
      title: i18n.t("novel.contextPack.currentTask"),
      content: pack.task,
      priority: FIELD_PRIORITY.task ?? 1,
      charCount: pack.task.length,
    })
  }

  fieldData.sort((a, b) => a.priority - b.priority)

  const headerChars = sections.join("\n").length + 2
  let totalChars = headerChars + fieldData.reduce((sum, f) => sum + f.charCount + f.title.length + 3, 0)
  const originalChars = totalChars
  const trimmedFields: string[] = []

  if (totalChars <= targetChars) {
    for (const { title, content } of [...fieldData].sort((a, b) => emitRank(a.fieldKey) - emitRank(b.fieldKey))) {
      sections.push(title)
      if (Array.isArray(content)) {
        content.forEach(item => sections.push(item))
      } else {
        sections.push(content)
      }
      sections.push("")
    }
    return {
      prompt: sections.join("\n"),
      trimmedFields: [],
      trimmedChars: 0,
      originalChars,
      finalChars: originalChars,
    }
  }

  const sortedByPriorityAsc = [...fieldData].sort((a, b) => a.priority - b.priority)
  let accumulatedChars = headerChars
  let keepCount = 0
  for (let i = 0; i < sortedByPriorityAsc.length; i++) {
    const field = sortedByPriorityAsc[i]
    const fieldTotalChars = field.charCount + field.title.length + 3
    if (accumulatedChars + fieldTotalChars <= targetChars) {
      accumulatedChars += fieldTotalChars
      keepCount = i + 1
    } else {
      break
    }
  }

  for (let i = keepCount; i < sortedByPriorityAsc.length; i++) {
    trimmedFields.push(sortedByPriorityAsc[i].fieldKey)
    totalChars -= sortedByPriorityAsc[i].charCount + sortedByPriorityAsc[i].title.length + 3
  }

  let partiallyTrimmed: { fieldKey: string; originalChars: number; keptChars: number } | null = null

  if (keepCount < sortedByPriorityAsc.length) {
    const nextField = sortedByPriorityAsc[keepCount]
    const remainingBudget = targetChars - accumulatedChars
    const minKeepChars = 100
    const targetContentChars = remainingBudget - nextField.title.length - 3
    const originalFieldChars = nextField.charCount
    
    if (targetContentChars > minKeepChars && nextField.charCount > targetContentChars) {
      const trimmedContent = nextField.fieldKey === "outline" && typeof nextField.content === "string"
        ? capOutlineSourcesToBudget(nextField.content, targetContentChars)
        : nextField.fieldKey === "searchResults" && pack.sagEvidence?.text && typeof nextField.content === "string"
          ? fitSagEvidence(nextField.content, targetContentChars)
          : trimFieldContent(nextField.content, targetContentChars)
      const keptContentChars = Array.isArray(trimmedContent)
        ? trimmedContent.reduce((sum, item) => sum + item.length, 0)
        : trimmedContent.length
      
      if (keptContentChars > 0) {
        nextField.content = trimmedContent
        nextField.charCount = keptContentChars
        totalChars = accumulatedChars + keptContentChars + nextField.title.length + 3
        partiallyTrimmed = {
          fieldKey: nextField.fieldKey,
          originalChars: originalFieldChars,
          keptChars: keptContentChars,
        }
        const idx = trimmedFields.indexOf(nextField.fieldKey)
        if (idx > -1) trimmedFields.splice(idx, 1)
        keepCount++
      }
    }
  }

  const keptFields = sortedByPriorityAsc.slice(0, keepCount)

  for (const { title, content } of [...keptFields].sort((a, b) => emitRank(a.fieldKey) - emitRank(b.fieldKey))) {
    sections.push(title)
    if (Array.isArray(content)) {
      content.forEach(item => sections.push(item))
    } else {
      sections.push(content)
    }
    sections.push("")
  }

  const trimmedChars = originalChars - totalChars

  if (trimmedFields.length > 0) {
    sections.push(`[...已裁剪 ${trimmedFields.length} 个低优先级上下文字段，约 ${trimmedChars} 字符...]`)
    sections.push("")
  }

  return {
    prompt: sections.join("\n"),
    trimmedFields,
    partiallyTrimmedField: partiallyTrimmed ?? undefined,
    trimmedChars,
    originalChars,
    finalChars: totalChars,
  }
}
