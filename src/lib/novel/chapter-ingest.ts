import { extractMemoryInParts, finishMemoryExtraction, type MemoryExtraction } from "./memory-extraction-parts"
import { CHAPTER_BODY_EXCERPT_MAX_CHARS } from "./chapter-excerpts"
import { resolveOutlineIngestIdentity } from "./outline-ingest-utils"
import { normalizeChapterSnapshot, buildSourceHash } from "./snapshot-format"
import { finishMemoryRefresh, markMemoryRefreshPending } from "./memory-refresh-status"
export { buildSourceHash } from "./snapshot-format"
import { readFile, writeFileAtomic, listDirectory, fileExists, createDirectory, deleteFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { chapterSnapshotNumbersFromFileNames } from "./chapter-memory-dot"
import { useWikiStore } from "@/stores/wiki-store"
import { parseFrontmatter } from "@/lib/frontmatter"
import { isChapterPage, isFinalChapter, parseChapterNumber } from "./chapter-meta"
import { isAiExcluded, isAiExcludedContent } from "./ai-exclude"
import { streamChat, type StreamCallbacks } from "@/lib/llm-client"
import type { ChatMessage } from "@/lib/llm-providers"
import { getOutputLanguage, buildLanguageReminder } from "@/lib/output-language"
import type { LlmConfig } from "@/stores/wiki-store"
import { canonicalizeSnapshotCharacters, writeSnapshotToWiki, writePatchFieldsToWiki } from "./graph-adapter"
import { resolveNovelModel } from "./model-resolver"
import { listChapterSources, refreshProjectMemory, type ChapterSource } from "./refresh-memory"
export { createRetrievalStore } from "./refresh-memory"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { shouldRebuildCommunitySummaries, generateCommunitySummaries } from "./community-summary"
import { learnPersonaSkillsFromChapter } from "./persona-skill-learning"
import { buildChapterIngestOutput, type ChapterIngestOutput } from "./chapter-ingest-output"
import { isValidMemorySnapshot } from "./memory-rebuild"
import { clearGraphCache } from "@/lib/graph-relevance"
import { computeOutlineIngestBodyBudget } from "@/lib/context-budget"
import { parseLlmJsonObject } from "./book-analysis/llm-json"
import {
  buildChapterExtractSystemPrompt,
  buildChapterExtractUserPrompt,
  buildOutlineExtractSystemPrompt,
  buildOutlineExtractUserPrompt,
  CHAPTER_EXTRACT_REQUEST_OVERRIDES,
  resolveChapterExtractMaxTokens,
  buildMemoryCleanupExclusions,
} from "./chapter-ingest-extract"
import { appendChapterIngestLog, previewLlmOutput } from "./chapter-ingest-log"
import { ITEM_CATEGORY_LABELS, type ItemCategory } from "./item-category"
import { buildEstablishedContextForExtraction } from "./extract-established-context"
import { filterRemovedMemories, loadMemoryCleanupPolicy, withMemoryWriteLock, type MemoryField, type MemoryRemoval } from "./memory-cleanup-policy"

export interface ValidationWarning {
  type: "entity_new" | "canon_conflict"
  message: string
}

export interface CharacterDetail {
  identity: string
  faction: string
  goals: string
  arcChange: string
}

export interface LocationDetail {
  region: string
  type: string
  controller: string
  hiddenInfo: string
}

export interface OrganizationDetail {
  leader: string
  members: string
  goals: string
  resources: string
}

export interface ItemDetail {
  holder: string
  previousHolders: string
  abilities: string
  limitations: string
  origin: string
}

export interface EventDetail {
  cause: string
  process: string
  relatedForeshadowing: string
  relatedConflicts: string
  followUpItems: string
}

export interface ChapterSnapshot {
  chapterId: string
  chapterNumber: number
  sourceHash?: string
  chapterTitle?: string
  summary: string
  characters: string[]
  characterAliases?: Record<string, string[]>
  locations: string[]
  organizations: string[]
  items: string[]
  events: string[]
  characterStateChanges: string[]
  relationshipChanges: string[]
  knowledgeChanges: string[]
  foreshadowingChanges: string[]
  newCanonFacts: string[]
  timelineEvents: string[]
  conflicts: string[]
  endingHook: string
  graphNodes: string[]
  graphEdges: string[]
  sourceType?: "chapter" | "outline"
  sourceSequence?: number
  revision?: number
  snapshotId?: string
  supersedes?: string
  isHistorical?: boolean
  validationWarnings?: ValidationWarning[]
  memorySyncedAt?: string
  characterDetails?: Record<string, CharacterDetail>
  locationDetails?: Record<string, LocationDetail>
  organizationDetails?: Record<string, OrganizationDetail>
  itemDetails?: Record<string, ItemDetail>
  /**
   * 物品分类（旁挂，不改 `items` 的 string[] 形状）。
   *
   * 为什么另开一个字段而不是把 `items` 改成对象数组：`normalizeSnapshotList()`
   * 会把非字符串元素静默丢成 `""` 再 filter 掉，改形状不会报错、只会让
   * 已有快照里的物品凭空消失，并且污染图谱。详见 item-category.ts 顶部说明。
   */
  itemCategories?: Record<string, ItemCategory>
  eventDetails?: Record<string, EventDetail>
}

function inferSnapshotSourceType(snapshot: Pick<ChapterSnapshot, "chapterNumber">): "chapter" | "outline" {
  return snapshot.chapterNumber < 0 ? "outline" : "chapter"
}

function inferSnapshotSourceSequence(snapshot: Pick<ChapterSnapshot, "chapterNumber">): number {
  return Math.abs(snapshot.chapterNumber)
}

function buildSnapshotRevisionId(snapshot: Pick<ChapterSnapshot, "chapterId">, revision: number): string {
  return `${snapshot.chapterId}-r${revision}`
}

function ensureSnapshotIdentity(
  snapshot: ChapterSnapshot,
  overrides: Partial<Pick<ChapterSnapshot, "sourceType" | "sourceSequence" | "revision" | "snapshotId" | "supersedes" | "isHistorical">> = {},
): ChapterSnapshot {
  const sourceType = overrides.sourceType ?? snapshot.sourceType ?? inferSnapshotSourceType(snapshot)
  const sourceSequence = overrides.sourceSequence ?? snapshot.sourceSequence ?? inferSnapshotSourceSequence(snapshot)
  const revision = overrides.revision ?? snapshot.revision ?? 1
  const snapshotId = overrides.snapshotId ?? snapshot.snapshotId ?? buildSnapshotRevisionId(snapshot, revision)

  return {
    ...snapshot,
    sourceType,
    sourceSequence,
    revision,
    snapshotId,
    supersedes: overrides.supersedes ?? snapshot.supersedes,
    isHistorical: overrides.isHistorical ?? snapshot.isHistorical ?? false,
  }
}

async function readCurrentSnapshot(projectPath: string, chapterNumber: number): Promise<ChapterSnapshot | null> {
  try {
    const raw = await readFile(snapshotJsonPath(projectPath, chapterNumber))
    const parsed = normalizeChapterSnapshot(JSON.parse(raw), {
      chapterId: `chapter-${chapterNumber}`,
      chapterNumber,
    })
    return parsed ? ensureSnapshotIdentity(parsed) : null
  } catch {
    return null
  }
}

function materializeNextCurrentSnapshot(snapshot: ChapterSnapshot, currentSnapshot: ChapterSnapshot | null): ChapterSnapshot {
  const existing = currentSnapshot ? ensureSnapshotIdentity(currentSnapshot) : null
  const nextRevisionBase = Math.max(existing?.revision ?? 0, snapshot.revision ?? 0)
  const nextRevision = nextRevisionBase > 0 ? nextRevisionBase + 1 : 1
  return ensureSnapshotIdentity(snapshot, {
    sourceType: snapshot.sourceType ?? existing?.sourceType ?? inferSnapshotSourceType(snapshot),
    sourceSequence: snapshot.sourceSequence ?? existing?.sourceSequence ?? inferSnapshotSourceSequence(snapshot),
    revision: nextRevision,
    snapshotId: buildSnapshotRevisionId(snapshot, nextRevision),
    supersedes: existing?.snapshotId ?? snapshot.snapshotId,
    isHistorical: false,
  })
}

function materializeRestoredCurrentSnapshot(
  archivedSnapshot: ChapterSnapshot,
  currentSnapshot: ChapterSnapshot | null,
): ChapterSnapshot {
  const archived = ensureSnapshotIdentity(archivedSnapshot, { isHistorical: true })
  const current = currentSnapshot ? ensureSnapshotIdentity(currentSnapshot) : null
  const nextRevision = Math.max(archived.revision ?? 1, current?.revision ?? 0) + 1
  return ensureSnapshotIdentity(archived, {
    revision: nextRevision,
    snapshotId: buildSnapshotRevisionId(archived, nextRevision),
    supersedes: current?.snapshotId ?? archived.snapshotId,
    isHistorical: false,
  })
}

type IngestFailReason = "no_llm" | "not_chapter" | "not_final" | "invalid_chapter_number" | "extract_failed" | "cancelled" | "ai_excluded"

interface IngestResult {
  snapshot: ChapterSnapshot | null
  failReason?: IngestFailReason
  error?: string
}

interface IngestChapterOptions {
  allowDraft?: boolean
}

export async function ingestChapter(
  projectPath: string,
  chapterPath: string,
  _reviewModel?: string,
  signal?: AbortSignal,
  chapterNumberOverride?: number,
  options: IngestChapterOptions = {},
): Promise<IngestResult> {
  const pp = normalizePath(projectPath)
  const state = useWikiStore.getState()
  if (!state.novelMode) return { snapshot: null }

  const llmConfig = state.llmConfig
  const novelConfig = state.novelConfig
  // 使用 resolveNovelModel 正确解析提取模型（含供应商配置切换）
  const runtimeLlmConfig = resolveNovelModel(llmConfig, novelConfig, "extract")
  const startedAt = Date.now()
  let resolvedChapterNumber = chapterNumberOverride
  const logFail = async (failReason: IngestFailReason, error?: string) => {
    const message = error ?? failReason
    console.error(`[Chapter Ingest] ${failReason}:`, message)
    await appendChapterIngestLog(pp, {
      event: "fail",
      chapterNumber: resolvedChapterNumber,
      chapterPath,
      failReason,
      error: message,
      model: runtimeLlmConfig.model,
      provider: runtimeLlmConfig.provider,
      elapsedMs: Date.now() - startedAt,
    })
    return { snapshot: null, failReason, error: message } satisfies IngestResult
  }

  if (!hasUsableLlm(runtimeLlmConfig, state.providerConfigs)) {
    return logFail("no_llm", "提取模型不可用")
  }

  const content = await readFile(chapterPath)
  const parsed = parseFrontmatter(content)
  const fm = parsed.frontmatter as Record<string, unknown> | null
  if (!fm || !isChapterPage(fm)) return logFail("not_chapter", "不是章节页")
  /*
   * 「选中（AI 不读取）」：摄取是"让模型读整章"最集中的地方，所以守在这里。
   *
   * 界面按钮已禁用、一键提取已跳过、MCP 已拒绝 —— 但那三处都是**调用方**的自觉。
   * 这一道是**被调用方**的底线：将来新增任何入口（导入后自动提取、批量脚本、
   * 新的 Agent 工具）都绕不过它。返回明确原因而不是静默成功，调用方才说得清话。
   */
  if (isAiExcluded(fm)) {
    return logFail("ai_excluded", "该篇已被选中（AI 不读取），不提取记忆；需要先在界面上取消选中")
  }
  if (!options.allowDraft && !isFinalChapter(fm)) {
    console.warn(`[Chapter Ingest] Chapter status is not final, skipping ingest.`)
    return logFail("not_final", "章节不是正式稿")
  }

  const chapterNumber = chapterNumberOverride ?? parseChapterNumber(fm.chapter_number) ?? 0
  resolvedChapterNumber = chapterNumber
  if (chapterNumber <= 0) {
    console.warn("[Chapter Ingest] Invalid chapter number, skipping ingest.")
    return logFail("invalid_chapter_number", "章节号无效")
  }
  const body = parsed.body

  if (signal?.aborted) return logFail("cancelled", "已取消")
  await appendChapterIngestLog(pp, {
    event: "start",
    chapterNumber,
    chapterPath,
    model: runtimeLlmConfig.model,
    provider: runtimeLlmConfig.provider,
  })
  const existingSnapshotPromise = readCurrentSnapshot(pp, chapterNumber)
  let extraction: MemoryExtraction
  try {
    // 先备好「已建立设定」：物品分类要判断归属（谁是主角/配角/反派）与有无意义
    // （对照已埋设伏笔），只看本章正文是判不准的。读取失败会退化成空串，
    // 提示词随之与改造前完全一致，绝不会因此中断摄取。
    const establishedContext = await buildEstablishedContextForExtraction(pp)
      .catch(() => "")
    extraction = await extractSnapshotWithLLM(
      pp, chapterNumber, body, runtimeLlmConfig, signal, establishedContext,
      (await loadMemoryCleanupPolicy(pp)).removed.filter((r) => r.chapterNumber === chapterNumber),
    )
  } catch (err) {
    return logFail("extract_failed", err instanceof Error ? err.message : String(err))
  }
  const snapshot = canonicalizeSnapshotCharacters(extraction.snapshot)

  if (!snapshot) {
    return logFail("extract_failed", "模型没有返回快照")
  }

  return withMemoryWriteLock(pp, async () => {
    if (signal?.aborted) return logFail("cancelled", "已取消")
    if (extraction.checkpointPath && await readFile(chapterPath) !== content) {
      return logFail("extract_failed", "提取期间章节已修改，请使用新稿重新提取")
    }
    Object.assign(snapshot, filterRemovedMemories(snapshot, await loadMemoryCleanupPolicy(pp)))
    const existingSnapshot = await existingSnapshotPromise
    const isReingest = existingSnapshot != null

    try {
      const [entityWarnings, canonWarnings] = await Promise.all([
        validateEntityReferences(pp, snapshot),
        validateCanonConflicts(pp, snapshot),
      ])
      snapshot.validationWarnings = [...entityWarnings, ...canonWarnings]
    } catch (err) {
      console.warn("[Chapter Ingest] Validation failed:", err instanceof Error ? err.message : err)
      snapshot.validationWarnings = []
    }

    const syncResult = await syncSnapshotToMemoryUnlocked(pp, snapshot, {
      source: { filePath: normalizePath(chapterPath).slice(pp.length + 1), sourceHash: buildSourceHash(content) },
      title: typeof fm.title === "string" ? fm.title : undefined,
    })
    await finishMemoryExtraction(extraction.checkpointPath)

    try {
      const patchPath = `${pp}/.qmai/novel/chapter-ingest-output/${String(snapshot.chapterNumber).padStart(3, "0")}.wiki-patch.json`
      const patchJson = await readFile(patchPath)
      const patch = JSON.parse(patchJson)
      const patchPaths = await writePatchFieldsToWiki(pp, patch)
      if (patchPaths.length > 0) {
        console.log(`[Chapter Ingest] Wrote ${patchPaths.length} entity pages from wiki patch fields`)
      }
    } catch (err) {
      console.warn("[Chapter Ingest] Wiki patch fields write failed:", err instanceof Error ? err.message : err)
    }

    // 人物 Skill：提取记忆时顺带学习（首次建档 / 再次完善）。
    // 后台异步、不阻塞「提取记忆」按钮；整章所有人物合并成一次 LLM 调用。
    // 这里刻意不 await：学习失败只 warn，绝不能影响章节摄取本身。
    //
    // 重新提取（isReingest）同样要学习 —— 不能短路：
    // 旧版这里写着「重新提取不重复学习，避免重复消耗模型」，但那个理由站不住，
    // 而且有真实代价。学习本身就是幂等的（planPersonaSkillRound 按
    // lastLearnedChapter 跳过已学过的人；候选池按 chapters[] 去重），
    // 所以重复摄取不会二次烧模型。反过来，一旦某一轮因为任何原因没建出档案
    // （定位查不到、模型没返回 JSON、应用被关掉），短路就等于**永久放弃修复**：
    // 用户手上唯一的补救动作就是重新提取，而那恰好是被跳过的那条路。
    // 实测就踩了这个坑：第 1 章早已摄取过，重新提取时 isReingest 为真，
    // 学习整段不执行，技能库永远是空的。
    void learnPersonaSkillsFromChapter({
      projectPath: pp,
      chapter: {
        chapterNumber: snapshot.chapterNumber,
        chapterBody: body,
        characters: snapshot.characters,
        characterAliases: snapshot.characterAliases,
      },
      // 整份快照一起下去：人物 Skill 的「当前状态 / 出场组织 / 认知变化 / 关系变化」
      // 由它投影（不调模型），所以模型不可用时这四段照样更新。
      chapterSnapshot: snapshot,
      llmConfig: runtimeLlmConfig,
      signal,
    })

    // 重新提取只替换本章快照，不必顺带打一次社区摘要（那是另一次 LLM）。
    if (!isReingest && shouldRebuildCommunitySummaries(snapshot.chapterNumber, novelConfig)) {
      const rebuildCommunitySummaries = async () => {
        try {
          await generateCommunitySummaries(pp, llmConfig, novelConfig, signal)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.warn("[Chapter Ingest] 社区摘要生成失败:", message)
          // 弹窗提示（通过 store 触发 UI 通知）
          useWikiStore.getState().setCommunitySummaryError(message)
        }
      }

      if (novelConfig.communitySummaryAsync) {
        // 后台异步执行，不阻塞章节摄取
        void rebuildCommunitySummaries()
      } else {
        // 同步等待
        await rebuildCommunitySummaries()
      }
    }

    await appendChapterIngestLog(pp, {
      event: "ok",
      chapterNumber,
      chapterPath,
      model: runtimeLlmConfig.model,
      provider: runtimeLlmConfig.provider,
      elapsedMs: Date.now() - startedAt,
    })
    return { snapshot: { ...snapshot, memorySyncedAt: syncResult.memorySyncedAt } }
  })
}

function normalizeOutlineIngestError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (/request cancelled|aborted|cancelled/i.test(message)) {
    return new Error("大纲摄取已中断，请稍后重试")
  }
  return new Error(message)
}

export interface OutlineIngestResult {
  snapshot: ChapterSnapshot | null
  checkpointPath?: string
  truncated: boolean
  originalLength: number
  bodyLength: number
  bodyBudget: number
  failureReason?: "no_llm" | "ai_excluded" | null
}

interface IngestOutlineOptions {
  skipSync?: boolean
}

function buildOutlineIngestUserPrompt(body: string): string {
  return buildOutlineExtractUserPrompt(body)
}

async function extractSnapshotWithLLM(
  projectPath: string,
  chapterNumber: number,
  chapterBody: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
  establishedContext = "",
  removed: MemoryRemoval[] = [],
): Promise<MemoryExtraction> {
  const systemPrompt = buildChapterExtractSystemPrompt(buildLanguageReminder(getOutputLanguage()))
  return extractNovelMemory({
    projectPath, chapterNumber, chapterId: `chapter-${chapterNumber}`, content: chapterBody,
    bodyBudget: CHAPTER_BODY_EXCERPT_MAX_CHARS, llmConfig, signal, systemPrompt,
    prompt: body => buildChapterExtractUserPrompt(chapterNumber, body, establishedContext, removed),
  })
}

async function extractNovelMemory(options: {
  projectPath: string; chapterNumber: number; chapterId: string; content: string; bodyBudget: number
  llmConfig: LlmConfig; signal?: AbortSignal; systemPrompt: string; prompt: (body: string) => string
}): Promise<MemoryExtraction> {
  const { llmConfig, chapterNumber, chapterId, systemPrompt, signal } = options
  return extractMemoryInParts({
    source: options.content, budget: options.bodyBudget, projectPath: options.projectPath, sourceKey: chapterId,
    requestKey: JSON.stringify([llmConfig.provider, llmConfig.customEndpoint, llmConfig.model, systemPrompt, options.prompt("")]),
    signal,
    async extract(body, instructions) {
      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: options.prompt(body) + instructions },
      ]
      let result = ""
      let streamError: Error | null = null
      const callbacks: StreamCallbacks = {
        onToken: token => { result += token },
        onDone: () => {},
        onError: error => { streamError = error },
      }
      await streamChat(llmConfig, messages, callbacks, signal, {
        ...CHAPTER_EXTRACT_REQUEST_OVERRIDES,
        max_tokens: resolveChapterExtractMaxTokens(llmConfig.maxContextSize),
      })
      signal?.throwIfAborted()
      if (streamError) throw streamError
      if (!result.trim()) throw new Error("快照提取失败：模型返回空内容（流结束但没有任何正文）")
      const parsed = parseLlmJsonObject(result)
      if (!parsed) throw new Error(`快照提取失败：模型没有返回可解析的 JSON。${previewLlmOutput(result, 400)}`)
      const snapshot = normalizeChapterSnapshot({ ...parsed, chapterNumber, chapterId, validationWarnings: [] })
      if (!snapshot) throw new Error("模型返回的快照格式无效")
      return snapshot
    },
  })
}

function snapshotToMarkdown(snapshot: ChapterSnapshot): string {
  const md = [
    `# 第${snapshot.chapterNumber}章 快照`,
    "",
    `## 摘要`,
    snapshot.summary,
    "",
    `## 出场人物`,
    ...(snapshot.characters.length > 0 ? snapshot.characters.map(c => `- ${c}`) : ["（无）"]),
    "",
    `## 出场地点`,
    ...(snapshot.locations.length > 0 ? snapshot.locations.map(l => `- ${l}`) : ["（无）"]),
    "",
    `## 出场组织`,
    ...(snapshot.organizations.length > 0 ? snapshot.organizations.map(o => `- ${o}`) : ["（无）"]),
    "",
    `## 出场物品`,
    ...(snapshot.items.length > 0
      ? snapshot.items.map(i => {
          const category = snapshot.itemCategories?.[i]
          return category ? `- ${i}（${ITEM_CATEGORY_LABELS[category]}）` : `- ${i}`
        })
      : ["（无）"]),
    "",
    `## 关键事件`,
    ...(snapshot.events.length > 0 ? snapshot.events.map(e => `- ${e}`) : ["（无）"]),
    "",
    `## 人物状态变化`,
    ...(snapshot.characterStateChanges.length > 0 ? snapshot.characterStateChanges.map(c => `- ${c}`) : ["（无）"]),
    "",
    `## 人物关系变化`,
    ...(snapshot.relationshipChanges.length > 0 ? snapshot.relationshipChanges.map(r => `- ${r}`) : ["（无）"]),
    "",
    `## 角色认知变化`,
    ...(snapshot.knowledgeChanges.length > 0 ? snapshot.knowledgeChanges.map(k => `- ${k}`) : ["（无）"]),
    "",
    `## 伏笔变化`,
    ...(snapshot.foreshadowingChanges.length > 0 ? snapshot.foreshadowingChanges.map(f => `- ${f}`) : ["（无）"]),
    "",
    `## 新增正史设定`,
    ...(snapshot.newCanonFacts.length > 0 ? snapshot.newCanonFacts.map(c => `- ${c}`) : ["（无）"]),
    "",
    `## 时间线事件`,
    ...(snapshot.timelineEvents.length > 0 ? snapshot.timelineEvents.map(t => `- ${t}`) : ["（无）"]),
    "",
    `## 冲突变化`,
    ...(snapshot.conflicts.length > 0 ? snapshot.conflicts.map(c => `- ${c}`) : ["（无）"]),
    "",
    `## 结尾钩子`,
    snapshot.endingHook || "（无）",
    "",
    `## 图谱节点`,
    ...(snapshot.graphNodes.length > 0 ? snapshot.graphNodes.map(g => `- ${g}`) : ["（无）"]),
    "",
    `## 图谱关系边`,
    ...(snapshot.graphEdges.length > 0 ? snapshot.graphEdges.map(g => `- ${g}`) : ["（无）"]),
  ]

  if (snapshot.validationWarnings && snapshot.validationWarnings.length > 0) {
    md.push(
      "",
      `## 校验警告`,
      ...snapshot.validationWarnings.map(w => `- [${w.type}] ${w.message}`),
    )
  }

  return md.join("\n")
}

export interface SnapshotHistoryEntry {
  fileName: string
  path: string
  createdAt: string
}

function snapshotFilePrefix(chapterNumber: number): string {
  if (chapterNumber < 0) return `outline-${String(Math.abs(chapterNumber)).padStart(3, "0")}`
  return String(chapterNumber).padStart(3, "0")
}

export function chapterSnapshotJsonPath(projectPath: string, chapterNumber: number): string {
  return `${normalizePath(projectPath)}/.qmai/novel/snapshots/${snapshotFilePrefix(chapterNumber)}.snapshot.json`
}

function snapshotJsonPath(projectPath: string, chapterNumber: number): string {
  return chapterSnapshotJsonPath(projectPath, chapterNumber)
}

function snapshotMarkdownPath(projectPath: string, chapterNumber: number): string {
  return `${projectPath}/.qmai/novel/snapshots/${snapshotFilePrefix(chapterNumber)}.snapshot.md`
}

function snapshotHistoryDir(projectPath: string, chapterNumber: number): string {
  return `${projectPath}/.qmai/novel/snapshots/history/${snapshotFilePrefix(chapterNumber)}`
}

async function backupSnapshotBeforeOverwrite(projectPath: string, chapterNumber: number): Promise<void> {
  const currentJsonPath = snapshotJsonPath(projectPath, chapterNumber)
  if (!(await fileExists(currentJsonPath))) return
  const currentRaw = await readFile(currentJsonPath)
  const normalizedCurrent = normalizeChapterSnapshot(JSON.parse(currentRaw), {
    chapterId: `chapter-${chapterNumber}`,
    chapterNumber,
  })
  const currentJson = normalizedCurrent
    ? JSON.stringify(ensureSnapshotIdentity(normalizedCurrent, { isHistorical: true }), null, 2)
    : currentRaw
  const historyDir = snapshotHistoryDir(projectPath, chapterNumber)
  await createDirectory(historyDir)
  // 同一毫秒内连续编辑或恢复时也要保留每一份修订。调用方持有项目写锁。
  let time = Date.now()
  let path: string
  do {
    path = `${historyDir}/${new Date(time++).toISOString().replace(/:/g, "-")}.snapshot.json`
  } while (await fileExists(path))
  await writeFileAtomic(path, currentJson)
}

export async function listSnapshotHistory(projectPath: string, chapterNumber: number): Promise<SnapshotHistoryEntry[]> {
  const pp = normalizePath(projectPath)
  const historyDir = snapshotHistoryDir(pp, chapterNumber)
  try {
    const nodes = await listDirectory(historyDir)
    return nodes
      .filter(node => !node.is_dir && node.name.endsWith(".snapshot.json"))
      .map(node => ({
        fileName: node.name,
        path: node.path,
        createdAt: node.name.replace(/\.snapshot\.json$/, "").replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3"),
      }))
      .sort((a, b) => b.fileName.localeCompare(a.fileName))
  } catch {
    return []
  }
}

export async function restoreSnapshotHistory(
  projectPath: string,
  chapterNumber: number,
  historyFileName: string,
): Promise<ChapterSnapshot> {
  const pp = normalizePath(projectPath)
  return withMemoryWriteLock(pp, async () => {
    const currentSnapshot = await readCurrentSnapshot(pp, chapterNumber)
    await backupSnapshotBeforeOverwrite(pp, chapterNumber)
    const historyPath = `${snapshotHistoryDir(pp, chapterNumber)}/${historyFileName}`
    const snapshot = normalizeChapterSnapshot(
      JSON.parse(await readFile(historyPath)),
      { chapterId: `chapter-${chapterNumber}`, chapterNumber },
    )
    if (!snapshot) {
      throw new Error("Invalid snapshot history file.")
    }
    const restoredCurrent = materializeRestoredCurrentSnapshot(snapshot, currentSnapshot)
    Object.assign(restoredCurrent, filterRemovedMemories(restoredCurrent, await loadMemoryCleanupPolicy(pp)))
    const writtenEntityPaths = await writeSnapshotToWiki(pp, restoredCurrent)
    await cleanupSupersededEntityFiles(pp, restoredCurrent, writtenEntityPaths)
    await saveSnapshot(pp, restoredCurrent)
    if (chapterNumber > 0) {
      await rebuildDerivedMemoryFromSnapshots(pp, restoredCurrent)
    }
    clearGraphCache()
    useWikiStore.getState().bumpDataVersion()
    return restoredCurrent
  })
}

interface SyncSnapshotToMemoryResult {
  writtenEntityPaths: string[]
  memoryPagePaths: string[]
  memorySyncedAt: string
}

interface SyncSnapshotToMemoryOptions {
  deferDerivedRebuild?: boolean
  source?: ChapterSource
  title?: string
  outlineExtraction?: { filePath: string; checkpointPath: string }
}

export async function syncSnapshotToMemory(
  projectPath: string,
  snapshot: ChapterSnapshot,
  options?: SyncSnapshotToMemoryOptions,
): Promise<SyncSnapshotToMemoryResult> {
  return withMemoryWriteLock(projectPath, () => syncSnapshotToMemoryUnlocked(projectPath, snapshot, options))
}

async function syncSnapshotToMemoryUnlocked(
  projectPath: string,
  snapshot: ChapterSnapshot,
  options?: SyncSnapshotToMemoryOptions,
): Promise<SyncSnapshotToMemoryResult> {
  const pp = normalizePath(projectPath)
  const pending = options?.outlineExtraction
  if (pending && snapshot.sourceHash !== buildSourceHash(await readFile(pending.filePath))) {
    throw new Error("提取期间大纲已修改，请使用新稿重新提取")
  }
  const filtered = filterRemovedMemories(snapshot, await loadMemoryCleanupPolicy(pp))
  Object.assign(snapshot, filtered)
  const currentSnapshot = await readCurrentSnapshot(pp, snapshot.chapterNumber)
  if (snapshot.chapterNumber < 0 && currentSnapshot?.chapterId.startsWith("outline-path:")
    && currentSnapshot.chapterId !== snapshot.chapterId) {
    throw new Error("该编号已属于另一份大纲，原快照已保留")
  }
  const memorySyncedAt = new Date().toISOString()
  const normalizedSnapshot = normalizeChapterSnapshot(
    { ...snapshot, chapterTitle: options?.title || snapshot.chapterTitle,
      sourceHash: options?.source?.sourceHash ?? snapshot.sourceHash, memorySyncedAt },
    { chapterId: snapshot.chapterId, chapterNumber: snapshot.chapterNumber },
  )
  if (!normalizedSnapshot) {
    throw new Error("Invalid snapshot data.")
  }
  const syncedSnapshot = materializeNextCurrentSnapshot(normalizedSnapshot, currentSnapshot)

  // 获取同步前该快照关联的旧实体文件（用于清理）
  const entitiesDir = `${pp}/wiki/entities`
  let oldEntityFiles: string[] = []
  try {
    const tree = await listDirectory(entitiesDir)
    oldEntityFiles = tree.filter(f => f.name.endsWith(".md")).map(f => f.name)
  } catch { /* entities dir may not exist */ }

  const writtenEntityPaths = await writeSnapshotToWiki(pp, syncedSnapshot)
  await cleanupSupersededEntityFiles(pp, syncedSnapshot, writtenEntityPaths)

  // 清理旧实体：如果一个实体文件不在新写入列表中，且其内容引用了当前快照的 source，则删除
  const writtenFileNames = new Set(writtenEntityPaths.map(p => p.split("/").pop() ?? ""))
  const snapshotSourceFiles = new Set(snapshotSourceFileNameCandidates(syncedSnapshot.chapterNumber))

  for (const oldFile of oldEntityFiles) {
    if (writtenFileNames.has(oldFile)) continue // 仍然存在于新快照中，保留
    try {
      const filePath = `${entitiesDir}/${oldFile}`
      const content = await readFile(filePath)
      if (shouldDeleteSupersededProjectionContent(content, syncedSnapshot)) {
        await deleteFile(filePath)
        continue
      }
      // 只删除引用了当前快照 source 的实体文件
      if (Array.from(snapshotSourceFiles).some(sourceFile => content.includes(sourceFile))) {
        // 检查是否还被其他快照引用
        const allSources = content.match(/[A-Za-z0-9_-]+\.snapshot\.json/g) ?? []
        const onlyCurrentSource = allSources.length > 0 && allSources.every(s => snapshotSourceFiles.has(s))
        if (onlyCurrentSource) {
          await deleteFile(filePath)
        }
      }
    } catch { /* skip errors */ }
  }

  await backupSnapshotBeforeOverwrite(pp, syncedSnapshot.chapterNumber)
  await saveSnapshot(pp, syncedSnapshot, { title: options?.title })
  const memoryPagePaths = !options?.deferDerivedRebuild && syncedSnapshot.chapterNumber > 0
    ? await rebuildDerivedMemoryFromSnapshots(pp, syncedSnapshot, { source: options?.source })
    : []
  if (!options?.deferDerivedRebuild) {
    clearGraphCache()
    useWikiStore.getState().bumpDataVersion()
  }

  await finishMemoryExtraction(pending?.checkpointPath)
  return { writtenEntityPaths, memoryPagePaths, memorySyncedAt }
}

function snapshotSourceFileNameCandidates(chapterNumber: number): string[] {
  const canonical = chapterNumber < 0
    ? `outline-${String(Math.abs(chapterNumber)).padStart(3, "0")}.snapshot.json`
    : `${String(chapterNumber).padStart(3, "0")}.snapshot.json`
  const legacy = `${String(chapterNumber).padStart(3, "0")}.snapshot.json`
  return Array.from(new Set([canonical, legacy]))
}

function extractFrontmatterString(content: string, key: string): string | null {
  const match = content.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "m"))
  return match?.[1]?.trim() || null
}

function extractFrontmatterNumber(content: string, key: string): number | null {
  const value = extractFrontmatterString(content, key)
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function shouldDeleteSupersededProjectionContent(content: string, snapshot: ChapterSnapshot): boolean {
  const currentSnapshot = ensureSnapshotIdentity(snapshot)
  const snapshotId = extractFrontmatterString(content, "snapshot_id")
  if (snapshotId && currentSnapshot.supersedes && snapshotId === currentSnapshot.supersedes) {
    return true
  }

  const sourceType = extractFrontmatterString(content, "source_type")
  const sourceSequence = extractFrontmatterNumber(content, "source_sequence")
  const sourceRevision = extractFrontmatterNumber(content, "source_revision")
  if (
    sourceType
    && sourceSequence
    && sourceRevision
    && sourceType === currentSnapshot.sourceType
    && sourceSequence === currentSnapshot.sourceSequence
    && sourceRevision < (currentSnapshot.revision ?? 1)
  ) {
    return true
  }

  return false
}

async function cleanupSupersededEntityFiles(
  projectPath: string,
  snapshot: ChapterSnapshot,
  writtenEntityPaths: string[],
): Promise<void> {
  const entitiesDir = `${projectPath}/wiki/entities`
  const writtenFileNames = new Set(writtenEntityPaths.map((path) => path.split("/").pop() ?? ""))
  const snapshotSourceFiles = new Set(snapshotSourceFileNameCandidates(snapshot.chapterNumber))

  let oldEntityFiles: string[] = []
  try {
    const tree = await listDirectory(entitiesDir)
    oldEntityFiles = tree.filter((file) => file.name.endsWith(".md")).map((file) => file.name)
  } catch {
    return
  }

  for (const oldFile of oldEntityFiles) {
    if (writtenFileNames.has(oldFile)) continue
    try {
      const filePath = `${entitiesDir}/${oldFile}`
      const content = await readFile(filePath)
      if (shouldDeleteSupersededProjectionContent(content, snapshot)) {
        await deleteFile(filePath)
        continue
      }
      if (Array.from(snapshotSourceFiles).some((sourceFile) => content.includes(sourceFile))) {
        const allSources = content.match(/[A-Za-z0-9_-]+\.snapshot\.json/g) ?? []
        const onlyCurrentSource = allSources.length > 0 && allSources.every((sourceFile) => snapshotSourceFiles.has(sourceFile))
        if (onlyCurrentSource) {
          await deleteFile(filePath)
        }
      }
    } catch {
      // ignore cleanup failures per file
    }
  }
}

/** 调用方持有项目记忆写锁。快照读取失败时终止，避免用缺页数据重建。 */
export async function rebuildDerivedMemoryFromSnapshots(
  projectPath: string,
  latestSnapshot?: ChapterSnapshot,
  options?: { fields?: readonly MemoryField[]; source?: ChapterSource },
): Promise<string[]> {
  // 字段清理有独立的备份、回滚和撤销事务，不覆盖先前未完成的整书刷新。
  if (options?.fields) return rebuildMemory(projectPath, latestSnapshot, options)
  await markMemoryRefreshPending(projectPath)
  try {
    const paths = await rebuildMemory(projectPath, latestSnapshot, options)
    await finishMemoryRefresh(projectPath)
    return paths
  } catch (error) {
    throw new Error(`记忆和检索刷新未完成，可在记忆中心从已保存的快照重试。\n${error instanceof Error ? error.message : String(error)}`)
  }
}

async function rebuildMemory(
  projectPath: string,
  latestSnapshot?: ChapterSnapshot,
  options?: { fields?: readonly MemoryField[]; source?: ChapterSource },
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const sources = await listChapterSources(pp)
  if (latestSnapshot && options?.source) sources.set(latestSnapshot.chapterNumber, options.source)
  const actual = [...sources.keys()]
  const policy = await loadMemoryCleanupPolicy(pp)
  const snapshotDir = `${pp}/.qmai/novel/snapshots`
  let names = await fileExists(snapshotDir) ? await listDirectory(snapshotDir) : []
  if (!options?.fields && names.some((node) => node.name.endsWith(".refresh.json"))) {
    await repairSnapshotArtifacts(pp, names.map((node) => node.name))
    names = await listDirectory(snapshotDir)
  }
  const numbers = chapterSnapshotNumbersFromFileNames(names.map((n) => n.name)).filter((n) => n > 0)
  if (latestSnapshot && latestSnapshot.chapterNumber > 0 && !numbers.includes(latestSnapshot.chapterNumber)) numbers.push(latestSnapshot.chapterNumber)
  const snapshots = await Promise.all(numbers.map(async (number) => {
    const loaded = latestSnapshot?.chapterNumber === number ? latestSnapshot : await loadSnapshot(pp, number)
    if (!loaded) throw new Error(`读取第${number}章记忆快照失败，请检查文件后重试。`)
    return filterRemovedMemories(loaded, policy)
  }))
  const valid = snapshots.filter((snapshot) => isValidMemorySnapshot(snapshot, actual))
  return refreshProjectMemory(pp, valid, { sources, fields: options?.fields })
}

export async function finalizeProjectMemoryRebuild(projectPath: string): Promise<void> {
  await withMemoryWriteLock(projectPath, async () => {
    await rebuildDerivedMemoryFromSnapshots(projectPath)
    clearGraphCache()
    useWikiStore.getState().bumpDataVersion()
  })
}

function artifactJobPath(projectPath: string, number: number) {
  return `${projectPath}/.qmai/novel/snapshots/${snapshotFilePrefix(number)}.refresh.json`
}

// JSON 是章节快照的来源。中断后只补完尚未写齐的章节文件，再重建整书汇总。
async function repairSnapshotArtifacts(pp: string, names: string[]) {
  for (const name of names) {
    const match = /^(\d+)\.refresh\.json$/.exec(name)
    if (!match) continue
    const number = Number(match[1])
    const jobPath = artifactJobPath(pp, number)
    const job = JSON.parse(await readFile(jobPath))
    if (job.operation === "delete") {
      await removeSnapshotArtifacts(pp, number)
    } else if (job.operation === "save") {
      if (await fileExists(snapshotJsonPath(pp, number))) {
        const snapshot = await loadSnapshot(pp, number)
        if (!snapshot) throw new Error(`第${number}章快照损坏，无法恢复记忆。`)
        await writeFileAtomic(snapshotMarkdownPath(pp, number), snapshotToMarkdown(snapshot))
        await saveChapterIngestOutput(pp, snapshot, { title: job.title })
      }
    } else throw new Error(`第${number}章记忆刷新记录损坏。`)
    await deleteFile(jobPath)
  }
}

async function saveSnapshot(projectPath: string, snapshot: ChapterSnapshot,
  options: { transactionalCleanup?: boolean; title?: string } = {}): Promise<void> {
  snapshot = filterRemovedMemories(snapshot, await loadMemoryCleanupPolicy(projectPath))
  const canonicalSnapshot = ensureSnapshotIdentity(canonicalizeSnapshotCharacters(snapshot))
  const normalizedSnapshot = normalizeChapterSnapshot(canonicalSnapshot, {
    chapterId: snapshot.chapterId,
    chapterNumber: snapshot.chapterNumber,
  })
  if (!normalizedSnapshot) {
    throw new Error("Invalid snapshot data.")
  }
  const snapshotDir = `${projectPath}/.qmai/novel/snapshots`
  const jsonPath = snapshotJsonPath(projectPath, normalizedSnapshot.chapterNumber)
  const mdPath = snapshotMarkdownPath(projectPath, normalizedSnapshot.chapterNumber)

  await createDirectory(snapshotDir)
  const jobPath = artifactJobPath(projectPath, snapshot.chapterNumber)
  const needsJob = snapshot.chapterNumber > 0 && !options.transactionalCleanup
  if (needsJob) {
    await markMemoryRefreshPending(projectPath)
    await writeFileAtomic(jobPath, JSON.stringify({ operation: "save", title: options.title }))
  }
  await writeFileAtomic(jsonPath, JSON.stringify(normalizedSnapshot, null, 2))
  await writeFileAtomic(mdPath, snapshotToMarkdown(normalizedSnapshot))
  if (snapshot.chapterNumber > 0) await saveChapterIngestOutput(projectPath, normalizedSnapshot, { title: options.title })
  if (needsJob && await fileExists(jobPath)) await deleteFile(jobPath)
}

/** Called with the project memory lock held; no model call or incremental merge. */
export async function replaceSnapshotForMemoryCleanup(projectPath: string, snapshot: ChapterSnapshot): Promise<void> {
  const previous = await readCurrentSnapshot(projectPath, snapshot.chapterNumber)
  await backupSnapshotBeforeOverwrite(projectPath, snapshot.chapterNumber)
  const next = materializeNextCurrentSnapshot(snapshot, previous)
  await saveSnapshot(projectPath, next, { transactionalCleanup: true })
}

async function saveChapterIngestOutput(projectPath: string, snapshot: ChapterSnapshot, options: { title?: string } = {}): Promise<ChapterIngestOutput> {
  const outputDir = `${projectPath}/.qmai/novel/chapter-ingest-output`
  const prefix = `${outputDir}/${String(snapshot.chapterNumber).padStart(3, "0")}`
  let title = snapshot.chapterTitle
  if (!options.title && await fileExists(`${prefix}.output.json`)) {
    const previous = JSON.parse(await readFile(`${prefix}.output.json`)) as ChapterIngestOutput
    if (typeof previous.snapshotWikiFields?.title === "string") title = previous.snapshotWikiFields.title
  }
  const output = buildChapterIngestOutput(snapshot, { ...(title ? { title } : {}), ...options })

  await createDirectory(outputDir)
  await writeFileAtomic(`${prefix}.output.json`, JSON.stringify(output, null, 2))
  await writeFileAtomic(`${prefix}.wiki-patch.json`, JSON.stringify(output.wikiUpdatePatch, null, 2))

  return output
}

async function validateEntityReferences(
  projectPath: string,
  snapshot: ChapterSnapshot,
): Promise<ValidationWarning[]> {
  const warnings: ValidationWarning[] = []
  const entitiesDir = `${projectPath}/wiki/entities`

  const categories = [
    { key: "characters" as const, label: "人物" },
    { key: "locations" as const, label: "地点" },
    { key: "organizations" as const, label: "组织" },
    { key: "items" as const, label: "物品" },
  ]

  const checks = categories.flatMap(({ key, label }) =>
    snapshot[key].map(async (name) => {
      try {
        const exists = await fileExists(`${entitiesDir}/${name}.md`)
        return { name, exists, label }
      } catch {
        return { name, exists: false, label }
      }
    }),
  )
  const results = await Promise.all(checks)
  for (const { name, exists, label } of results) {
    if (!exists) {
      warnings.push({
        type: "entity_new",
        message: `新${label}: ${name}`,
      })
    }
  }

  return warnings
}

async function validateCanonConflicts(
  projectPath: string,
  snapshot: ChapterSnapshot,
): Promise<ValidationWarning[]> {
  const warnings: ValidationWarning[] = []

  try {
    const canonPath = `${projectPath}/wiki/canon.md`
    try {
      await readFile(canonPath)
    } catch {
      return warnings
    }

    const conflictPatterns: [RegExp, string][] = [
      [/推翻|打破|改写了|不再是/, "设定推翻"],
      [/之前.+错误|误解|记错|搞错/, "历史修正"],
      [/实际上.+不是|真相是|真正.*是/, "真相揭示"],
    ]

    for (const event of snapshot.events) {
      for (const [regex, label] of conflictPatterns) {
        if (regex.test(event)) {
          warnings.push({
            type: "canon_conflict",
            message: `${label}: "${event}" 可能与正史规则存在潜在冲突`,
          })
          break
        }
      }
    }
  } catch {
    // 校验失败不影响主流程
  }

  return warnings
}

export async function loadSnapshot(
  projectPath: string,
  chapterNumber: number,
): Promise<ChapterSnapshot | null> {
  const pp = normalizePath(projectPath)
  const prefix = chapterNumber < 0
    ? `outline-${String(Math.abs(chapterNumber)).padStart(3, "0")}`
    : String(chapterNumber).padStart(3, "0")
  const jsonPath = `${pp}/.qmai/novel/snapshots/${prefix}.snapshot.json`
  try {
    const raw = await readFile(jsonPath)
    return normalizeChapterSnapshot(JSON.parse(raw), {
      chapterId: `chapter-${chapterNumber}`,
      chapterNumber,
    })
  } catch {
    return null
  }
}

export async function listSnapshots(projectPath: string): Promise<number[]> {
  const pp = normalizePath(projectPath)
  const snapshotDir = `${pp}/.qmai/novel/snapshots`
  try {
    const tree = await listDirectory(snapshotDir)
    return chapterSnapshotNumbersFromFileNames(tree.map((file) => file.name))
  } catch {
    return []
  }
}

export async function deleteChapterSnapshotArtifacts(projectPath: string, chapterNumber: number): Promise<boolean> {
  const pp = normalizePath(projectPath)
  if (chapterNumber <= 0) return removeSnapshotArtifacts(pp, chapterNumber)
  await markMemoryRefreshPending(pp)
  const jobPath = artifactJobPath(pp, chapterNumber)
  await writeFileAtomic(jobPath, JSON.stringify({ operation: "delete" }))
  const removed = await removeSnapshotArtifacts(pp, chapterNumber)
  if (await fileExists(jobPath)) await deleteFile(jobPath)
  return removed
}

async function removeSnapshotArtifacts(pp: string, chapterNumber: number): Promise<boolean> {
  const prefix = `${pp}/.qmai/novel/chapter-ingest-output/${String(chapterNumber).padStart(3, "0")}`
  const paths = [snapshotMarkdownPath(pp, chapterNumber), snapshotHistoryDir(pp, chapterNumber),
    `${prefix}.output.json`, `${prefix}.wiki-patch.json`, snapshotJsonPath(pp, chapterNumber)]
  let deleted = false
  for (const path of paths) {
    if (!await fileExists(path)) continue
    await deleteFile(path)
    deleted = true
  }
  return deleted
}

export async function deleteChapterSnapshots(projectPath: string, chapterNumber: number): Promise<void> {
  const pp = normalizePath(projectPath)
  return withMemoryWriteLock(pp, async () => {
    await deleteChapterSnapshotArtifacts(pp, chapterNumber)
    if (chapterNumber > 0) await rebuildDerivedMemoryFromSnapshots(pp)
    clearGraphCache()
    useWikiStore.getState().bumpDataVersion()
  })
}

export async function ingestOutline(
  projectPath: string,
  outlinePath: string,
  signal?: AbortSignal,
  options?: IngestOutlineOptions,
): Promise<OutlineIngestResult> {
  const emptyResult = (
    snapshot: ChapterSnapshot | null = null,
    failureReason: OutlineIngestResult["failureReason"] = null,
  ): OutlineIngestResult => ({
    snapshot,
    truncated: false,
    originalLength: 0,
    bodyLength: 0,
    bodyBudget: 0,
    failureReason,
  })

  const pp = normalizePath(projectPath)
  const state = useWikiStore.getState()
  const llmConfig = state.llmConfig
  const novelConfig = state.novelConfig
  // 使用 resolveNovelModel 正确解析提取模型（含供应商配置切换），与 ingestChapter 保持一致
  const runtimeLlmConfig = resolveNovelModel(llmConfig, novelConfig, "extract")
  if (!hasUsableLlm(runtimeLlmConfig, state.providerConfigs)) return emptyResult(null, "no_llm")

  const content = await readFile(outlinePath)
  const originalLength = content.length
  // 「选中（AI 不读取）」：与章节同一道底线，见 ingestChapter 里那段说明。
  if (isAiExcludedContent(content)) return emptyResult(null, "ai_excluded")

  const outputLang = getOutputLanguage()
  const langReminder = buildLanguageReminder(outputLang)
  const systemPrompt = buildOutlineExtractSystemPrompt(langReminder)
  const promptOverhead = systemPrompt.length + buildOutlineIngestUserPrompt("").length
  const bodyBudget = computeOutlineIngestBodyBudget(runtimeLlmConfig.maxContextSize, promptOverhead)

  const { outlineName, chapterNumber: outlineNumber, sourceKey } = await resolveOutlineIngestIdentity(pp, outlinePath)
  const chapterId = `outline-path:${sourceKey}`

  const exclusions = buildMemoryCleanupExclusions(
    (await loadMemoryCleanupPolicy(pp)).removed.filter(r => r.chapterNumber === outlineNumber),
  )
  try {
    const { snapshot, checkpointPath } = await extractNovelMemory({
      projectPath: pp, chapterId, chapterNumber: outlineNumber, content, bodyBudget,
      llmConfig: runtimeLlmConfig, signal, systemPrompt,
      prompt: body => buildOutlineIngestUserPrompt(body) + exclusions,
    })
    snapshot.chapterTitle = outlineName
    if (checkpointPath) snapshot.sourceHash = buildSourceHash(content)
    signal?.throwIfAborted()

    if (options?.skipSync) {
      return {
        snapshot,
        checkpointPath,
        truncated: false,
        originalLength,
        bodyLength: originalLength,
        bodyBudget,
        failureReason: null,
      }
    }

    const syncResult = await syncSnapshotToMemory(pp, snapshot, {
      outlineExtraction: checkpointPath ? { filePath: outlinePath, checkpointPath } : undefined,
    })
    return {
      snapshot: { ...snapshot, memorySyncedAt: syncResult.memorySyncedAt },
      truncated: false,
      originalLength,
      bodyLength: originalLength,
      bodyBudget,
      failureReason: null,
    }
  } catch (err) {
    console.error("[Outline Ingest] Failed:", err)
    throw normalizeOutlineIngestError(err)
  }
}
