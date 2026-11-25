import { isActiveForeshadowingStatus } from "./foreshadowing-normalize"
import { buildMemoryProjection } from "./memory-rebuild"
/**
 * 具体数据源实现
 * 将原有的数据获取函数重构为数据源对象
 */

import { readFile } from "@/commands/fs"
import { searchWiki } from "@/lib/search"
import { eligibleChapterNumber } from "@/lib/sag-search"
import { parseFrontmatter } from "@/lib/frontmatter"
import { parseChapterMeta } from "./chapter-meta"
import { isAiExcludedContent } from "./ai-exclude"
import { eligibleLocalSource, isEntityOrConceptPath } from "./search-adapter"
import { hasReadableHistory, listAiExcludedChapterNumbers, readVisibleChapter } from "./ai-exclude-chapters"
import { listSnapshots, loadSnapshot, type ChapterSnapshot } from "./chapter-ingest"
import { loadRevisionFeedbackForContext, createEmptyRevisionFeedback } from "./revision-feedback"
import { loadCognitionState } from "./character-cognition"
import { relevantCognitionContext } from "./cognition-context"
import { buildWritingStyleContext } from "./writing-style-store"
import { buildSectionBriefing } from "./section-briefing"
import { loadFanficCanonBody } from "./fanfic-canon"
import type { DataSource, ContextLoadContext } from "./context-data-source"
import type { RetrievalEntry } from "./retrieval"
import { createRetrievalStore } from "./refresh-memory"
import { loadCharacterStates } from "./character-state"
import { loadForeshadowingTracker } from "./foreshadowing-tracker"
import { loadTimeline } from "./timeline"
import type { DataSourceCategory } from "./classification"

// 导入现有的辅助函数
import {
  readOutlineContextLayers,
  readChapterOutlineContent,
  readVolumeContextContent,
  searchRelevantContentUnified,
  searchGraphRelevantContent,
  selectLookbackChapterNumbers,
  joinNonEmpty,
} from "./context-engine"

const RECENT_CHAPTER_CONTENT_MAX_CHARS = 6000
const RECENT_CHAPTER_CONTENT_HEAD_CHARS = 2200
const RECENT_CHAPTER_CONTENT_TAIL_CHARS = 3200

const DATA_SOURCE_CATEGORY_MAP: Record<string, DataSourceCategory[]> = {
  sectionBriefing: ["character_states", "foreshadowing", "settings"],
  outline: ["outline"],
  chapterOutline: ["outline"],
  volumeContext: ["outline", "settings"],
  snapshots: ["recent_summaries", "chapter_content", "character_states", "foreshadowing", "timeline"],
  retrieval: ["recent_summaries", "character_states", "foreshadowing", "timeline"],
  recentChapterContents: ["chapter_content"],
  fallbackRecentSummaries: ["recent_summaries"],
  fallbackPreviousEnding: ["chapter_content"],
  fallbackCharacterStates: ["character_states"],
  fallbackForeshadowingStates: ["foreshadowing"],
  fallbackTimeline: ["timeline"],
  relatedSettings: ["settings"],
  canonRules: ["settings"],
  sourceCanon: ["settings"],
  writingStyle: ["settings"],
  searchResults: ["memory", "plot_tools"],
  graphSearchResults: ["graph"],
  revisionFeedback: ["revision"],
  cognitionText: ["character_states"],
}

function selectRecentChapterNumbersForContent(chapterNumber: number | undefined, count: number): number[] {
  if (!chapterNumber || chapterNumber <= 1) return []
  const start = Math.max(1, chapterNumber - Math.max(1, count))
  const numbers: number[] = []
  for (let current = start; current < chapterNumber; current += 1) {
    numbers.push(current)
  }
  return numbers
}

function stripFrontmatterBody(content: string): string {
  return parseFrontmatter(content).body.trim()
}

function excerptChapterContent(body: string): string {
  const normalized = body.trim()
  if (normalized.length <= RECENT_CHAPTER_CONTENT_MAX_CHARS) return normalized
  const head = normalized.slice(0, RECENT_CHAPTER_CONTENT_HEAD_CHARS).trimEnd()
  const tail = normalized.slice(-RECENT_CHAPTER_CONTENT_TAIL_CHARS).trimStart()
  return `${head}\n\n[章节正文中段已按上下文预算省略]\n\n${tail}`
}

/**
 * 大纲数据源
 */
const outlineDataSource: DataSource<Awaited<ReturnType<typeof readOutlineContextLayers>>> = {
  name: "outline",
  priority: 1,
  async load(context: ContextLoadContext) {
    return await readOutlineContextLayers(context.projectPath, context.chapterNumber)
  },
}

/**
 * 章节大纲数据源
 */
const chapterOutlineDataSource: DataSource<string> = {
  name: "chapterOutline",
  priority: 2,
  async load(context: ContextLoadContext): Promise<string> {
    if (!context.chapterNumber) return ""
    return await readChapterOutlineContent(context.projectPath, context.chapterNumber)
  },
}

/**
 * 卷信息数据源
 */
const volumeContextDataSource: DataSource<string> = {
  name: "volumeContext",
  priority: 3,
  async load(context: ContextLoadContext): Promise<string> {
    return await readVolumeContextContent(context.projectPath, context.chapterNumber)
  },
}

/**
 * 快照上下文数据源
 */
const snapshotDataSource: DataSource<{
  recentSummaries: string[]
  previousChapterEnding: string
  characterStates: string
  foreshadowingSignals: string[]
  timeline: string
}> = {
  name: "snapshots",
  priority: 4,
  async load(context: ContextLoadContext) {
    const { projectPath, chapterNumber, config } = context
    const snapshotNumbers = await listSnapshots(projectPath)
    
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
      ? selectLookbackChapterNumbers(chapterNumber, config.snapshotLookback)
      : [...snapshotNumbers].sort((a, b) => b - a).slice(0, config.snapshotLookback)
    
    const summaryNumbers = chapterNumber
      ? snapshotNumbers.filter((n) => n < chapterNumber).slice(-config.recentSummaryWindow)
      : snapshotNumbers.slice(-config.recentSummaryWindow)

    const [lookbackSnapshots, summarySnapshots] = await Promise.all([
      Promise.all(lookbackNumbers.map((n) => loadSnapshot(projectPath, n))),
      Promise.all(summaryNumbers.map((n) => loadSnapshot(projectPath, n))),
    ])

    /*
     * 「选中（AI 不读取）」：被选中章节的**记忆快照**也不能进上下文 ——
     * 摘要、人物状态、时间线都是从那一章正文提炼出来的，放行等于换个形式读取。
     */
    const excludedNumbers = await listAiExcludedChapterNumbers(projectPath, [
      ...lookbackNumbers,
      ...summaryNumbers,
    ], context.chapterScope?.chapters)

    const validLookback = lookbackSnapshots
      .filter((snapshot): snapshot is ChapterSnapshot => Boolean(snapshot))
      .filter((snapshot) => !excludedNumbers.has(snapshot.chapterNumber))
    const validSummarySnapshots = summarySnapshots
      .filter((snapshot): snapshot is ChapterSnapshot => Boolean(snapshot))
      .filter((snapshot) => !excludedNumbers.has(snapshot.chapterNumber))

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
  },
}

/**
 * 降级：近期章节摘要数据源
 */
const recentChapterContentsDataSource: DataSource<string[]> = {
  name: "recentChapterContents",
  priority: 5,
  async load(context: ContextLoadContext): Promise<string[]> {
    const chapterNumbers = selectRecentChapterNumbersForContent(
      context.chapterNumber,
      context.config.recentSummaryWindow,
    )
    if (chapterNumbers.length === 0) return []

    const contents: string[] = []
    for (const chapterNumber of chapterNumbers) {
      try {
        const content = await readVisibleChapter(context.projectPath, chapterNumber, context.chapterScope?.chapters)
        if (!content) continue
        const body = stripFrontmatterBody(content)
        if (!body) continue
        contents.push(`## 第${chapterNumber}章正文片段\n${excerptChapterContent(body)}`)
      } catch {}
    }
    return contents
  },
}

const fallbackRecentSummariesDataSource: DataSource<string[]> = {
  name: "fallbackRecentSummaries",
  priority: 5,
  async load(context: ContextLoadContext): Promise<string[]> {
    const summaries: string[] = []
    try {
      const cutoff = context.chapterNumber ?? Number.MAX_SAFE_INTEGER
      const results = context.chapterScope
        ? [...context.chapterScope.chapters].sort(([a], [b]) => b - a).map(([, path]) => ({ path }))
        : await searchWiki(context.projectPath, "type:chapter", {
          localOnly: true, acceptFile: (path, text) => eligibleChapterNumber(path, text, cutoff) !== null,
        })
      for (const r of results.slice(0, context.config.recentSummaryWindow)) {
        try {
          const content = await readFile(r.path)
          // 「选中（AI 不读取）」：被排除的章节不进降级摘要。
          if (eligibleChapterNumber(r.path, content, cutoff) === null) continue
          const parsed = parseFrontmatter(content)
          const fm = parsed.frontmatter as Record<string, unknown> | null
          const meta = fm ? parseChapterMeta(fm) : null
          if (meta) {
            const bodyStart = content.indexOf("---", 4)
            const body = bodyStart >= 0 ? content.slice(bodyStart + 3).trim() : content
            summaries.push(`第${meta.chapterNumber}章 (${meta.status}): ${body.slice(0, 800)}`)
          }
        } catch {}
      }
    } catch {}
    return summaries
  },
}

/**
 * 降级：前一章结尾数据源
 */
const fallbackPreviousEndingDataSource: DataSource<string> = {
  name: "fallbackPreviousEnding",
  priority: 6,
  async load(context: ContextLoadContext): Promise<string> {
    if (!context.chapterNumber || context.chapterNumber <= 1) return ""
    try {
      const content = await readVisibleChapter(context.projectPath, context.chapterNumber - 1, context.chapterScope?.chapters)
      if (content) {
        const bodyStart = content.indexOf("---", 4)
        const body = bodyStart >= 0 ? content.slice(bodyStart + 3).trim() : content
        const lines = body.split("\n")
        return lines.slice(-30).join("\n").slice(-1200)
      }
    } catch {}
    return ""
  },
}

/**
 * 降级：角色状态数据源
 */
async function visibleMemoryRows<T>(
  context: ContextLoadContext, rows: T[], sourceChapters: (row: T) => number[],
): Promise<T[]> {
  const cutoff = context.chapterNumber ?? Infinity
  const eligible = rows.filter((row) => sourceChapters(row).every((n) => n > 0 && n < cutoff)).slice(-12)
  const excluded = await listAiExcludedChapterNumbers(context.projectPath, eligible.flatMap(sourceChapters), context.chapterScope?.chapters)
  return eligible.filter((row) => !sourceChapters(row).some((n) => excluded.has(n)))
}

const fallbackCharacterStatesDataSource: DataSource<string> = {
  name: "fallbackCharacterStates",
  priority: 7,
  async load(context) {
    const state = await loadCharacterStates(context.projectPath)
    const rows = await visibleMemoryRows(context, state.characters, (p) => [p.lastUpdatedChapter])
    return rows.map((p) => `${p.characterName}：${p.status}`).join("\n")
  },
}

const fallbackForeshadowingStatesDataSource: DataSource<string> = {
  name: "fallbackForeshadowingStates",
  priority: 8,
  async load(context) {
    const store = await loadForeshadowingTracker(context.projectPath)
    const active = store.items.filter((f) => isActiveForeshadowingStatus(f.status))
    const rows = await visibleMemoryRows(context, active, (f) => [f.plantedChapter, ...f.advancedChapters, ...(f.resolvedChapter ? [f.resolvedChapter] : [])])
    return rows.map((f) => `${f.id} ${f.name}：${f.description}`).join("\n")
  },
}

const fallbackTimelineDataSource: DataSource<string> = {
  name: "fallbackTimeline",
  priority: 9,
  async load(context) {
    const timeline = await loadTimeline(context.projectPath)
    const rows = await visibleMemoryRows(context, timeline.entries, (e) => [e.chapterNumber])
    return rows.map((e) => `第${e.chapterNumber}章：${e.event}`).join("\n")
  },
}

/**
 * 相关设定数据源
 */
function referenceSearchOptions(context: ContextLoadContext) {
  return {
    localOnly: true,
    acceptPath: (path: string) => !/\/(?:chapters|outlines|memory)\//i.test(path),
    acceptFile: (path: string, content: string) => {
      if (isAiExcludedContent(content)) return false
      const fields = parseFrontmatter(content).frontmatter
      if (isEntityOrConceptPath(path) || fields?.snapshot_id || fields?.source_sequence || fields?.source_type) {
        return eligibleLocalSource(path, content, context.chapterNumber, context.chapterScope)
      }
      return true
    },
  }
}

async function referencePages(context: ContextLoadContext, query: string, limit: number): Promise<string[]> {
  const options = referenceSearchOptions(context)
  const hits = await searchWiki(context.projectPath, query, options)
  return Promise.all(hits.slice(0, limit).map(async ({ path }) => {
    const content = await readFile(path).catch(() => "")
    return content && options.acceptPath(path) && await options.acceptFile(path, content) ? content : ""
  }))
}

const relatedSettingsDataSource: DataSource<string> = {
  name: "relatedSettings",
  priority: 10,
  async load(context: ContextLoadContext): Promise<string> {
    try {
      const pages = await referencePages(context, "setting 设定 location 地点", 3)
      return pages.filter(Boolean).join("\n---\n").slice(0, 2000)
    } catch {}
    return ""
  },
}

/**
 * 正史规则数据源
 */
const canonRulesDataSource: DataSource<string> = {
  name: "canonRules",
  priority: 11,
  async load(context: ContextLoadContext): Promise<string> {
    try {
      const canon = await readFile(`${context.projectPath}/wiki/canon.md`).catch(() => "")
      if (canon) return isAiExcludedContent(canon) ? "" : canon.slice(0, 2000)
      const [page] = await referencePages(context, "canon 正史 rule 规则", 1)
      return page?.slice(0, 2000) ?? ""
    } catch {}
    return ""
  },
}

/**
 * 同人原作正典数据源
 *
 * 与 `canonRulesDataSource` 的本质区别：**按固定路径读取** `.qmai/novel/fanfic-canon.md`，
 * 不做模糊检索。同人正典一旦被检索漏掉，模型就会凭空编造原作事实——
 * 这正是「同人写得像原创」的直接原因。
 *
 * 原创项目没有这个文件，返回空串，不占预算、不影响既有行为。
 */
const sourceCanonDataSource: DataSource<string> = {
  name: "sourceCanon",
  priority: 2,
  async load(context: ContextLoadContext): Promise<string> {
    try {
      return await loadFanficCanonBody(context.projectPath)
    } catch {
      return ""
    }
  },
}

/**
 * 写作风格数据源
 */
const writingStyleDataSource: DataSource<string> = {
  name: "writingStyle",
  priority: 12,
  async load(context: ContextLoadContext): Promise<string> {
    // 优先级1: 已启用的文风预设
    try {
      const enabledStyle = await buildWritingStyleContext(context.projectPath)
      if (enabledStyle.trim()) return enabledStyle
    } catch {}

    // 优先级2: 独立文风设定文件（wiki/写作风格.md 或 wiki/writing-style.md）
    try {
      const pp = context.projectPath
      const stylePaths = [`${pp}/wiki/写作风格.md`, `${pp}/wiki/writing-style.md`]
      for (const stylePath of stylePaths) {
        const content = await readFile(stylePath).catch(() => "")
        if (content.trim() && !isAiExcludedContent(content)) return content.slice(0, 1000)
      }
    } catch {}

    // 优先级3: 从 wiki 搜索风格相关页面
    try {
      const [page] = await referencePages(context, "style 风格 writing 写作", 1)
      return page?.slice(0, 1000) ?? ""
    } catch {}
    return ""
  },
}

/**
 * 搜索结果数据源
 */
const searchResultsDataSource: DataSource<string> = {
  name: "searchResults",
  priority: 13,
  async load(context: ContextLoadContext): Promise<string> {
    return await searchRelevantContentUnified(
      context.projectPath,
      context.task,
      context.chapterNumber,
      context.config.searchTopK,
      context.chapterScope,
    )
  },
}

/**
 * 图谱搜索结果数据源
 */
const graphSearchResultsDataSource: DataSource<string> = {
  name: "graphSearchResults",
  priority: 14,
  async load(context: ContextLoadContext): Promise<string> {
    return await searchGraphRelevantContent(
      context.projectPath,
      context.task,
      context.chapterNumber,
      context.config.searchTopK,
      context.chapterScope,
    )
  },
}

/**
 * 修订反馈数据源
 */
const revisionFeedbackDataSource: DataSource<any> = {
  name: "revisionFeedback",
  priority: 15,
  async load(context: ContextLoadContext): Promise<any> {
    if (!context.chapterNumber) return createEmptyRevisionFeedback()
    return await loadRevisionFeedbackForContext(
      context.projectPath,
      context.chapterNumber,
      context.config.revisionFeedbackWindowConfig
    )
  },
}

/**
 * 认知状态数据源
 */
const cognitionTextDataSource: DataSource<string> = {
  name: "cognitionText",
  priority: 16,
  async load(context: ContextLoadContext): Promise<string> {
    try {
      const state = await loadCognitionState(context.projectPath)
      if (!state) return ""
      if (context.chapterNumber && state.lastUpdatedChapter >= context.chapterNumber) return ""
      if (context.chapterScope && !hasReadableHistory(state.lastUpdatedChapter, context.chapterScope.chapters)) return ""
      const outline = context.chapterNumber ? await readChapterOutlineContent(context.projectPath, context.chapterNumber) : ""
      return relevantCognitionContext(state, [context.task, outline].filter(Boolean).join("\n"))
    } catch {}
    return ""
  },
}

/**
 * 本节速记数据源
 * 根据细纲筛选角色状态、伏笔和世界观约束，priority=0（最优先）
 */
const sectionBriefingDataSource: DataSource<Awaited<ReturnType<typeof buildSectionBriefing>> | ""> = {
  name: "sectionBriefing",
  priority: 0,
  async load(context) {
    const chapterOutlineContent = await readChapterOutlineContent(context.projectPath, context.chapterNumber)
    const briefing = await buildSectionBriefing(
      context.projectPath,
      context.chapterNumber,
      chapterOutlineContent,
      context.task,
      context.chapterScope?.chapters,
    )
    return briefing.text || briefing.characterBriefs.length ? briefing : ""
  },
}

/**
 * Retrieval 索引数据源
 * 返回项目级原始条目（不做章节过滤），缓存以项目级 key 复用；
 * 按章节过滤逻辑移到 context-engine 的 buildContextPackFromRawData。
 */
const retrievalDataSource: DataSource<{ entries: RetrievalEntry[] }> = {
  name: "retrieval",
  priority: 3,
  async load(context: ContextLoadContext) {
    const store = createRetrievalStore(context.projectPath)
    const hasIndex = await store.hasIndex()

    if (!hasIndex) {
      return { entries: [] }
    }

    try {
      const allEntries = await store.getAllEntries()
      const sortedEntries = [...allEntries].sort((a, b) => a.chapterNumber - b.chapterNumber)
      return { entries: sortedEntries }
    } catch (err) {
      console.warn("[DataSource] retrieval load failed:", err)
      return { entries: [] }
    }
  },
}

/**
 * 获取所有数据源
 */
export function getAllDataSources(): DataSource<any>[] {
  return [
    sectionBriefingDataSource,
    outlineDataSource,
    chapterOutlineDataSource,
    volumeContextDataSource,
    snapshotDataSource,
    retrievalDataSource,
    recentChapterContentsDataSource,
    fallbackRecentSummariesDataSource,
    fallbackPreviousEndingDataSource,
    fallbackCharacterStatesDataSource,
    fallbackForeshadowingStatesDataSource,
    fallbackTimelineDataSource,
    relatedSettingsDataSource,
    canonRulesDataSource,
    sourceCanonDataSource,
    writingStyleDataSource,
    searchResultsDataSource,
    graphSearchResultsDataSource,
    revisionFeedbackDataSource,
    cognitionTextDataSource,
  ]
}

export function getDataSourceNamesForCategories(categories: DataSourceCategory[]): string[] {
  const allowed = new Set(categories)
  return getAllDataSources()
    .filter((source) => (DATA_SOURCE_CATEGORY_MAP[source.name] || []).some((category) => allowed.has(category)))
    .map((source) => source.name)
}

export function getDataSourcesForCategories(categories?: DataSourceCategory[]): DataSource<any>[] {
  if (!categories || categories.length === 0) return getAllDataSources()
  const allowedNames = new Set(getDataSourceNamesForCategories(categories))
  return getAllDataSources().filter((source) => allowedNames.has(source.name))
}
