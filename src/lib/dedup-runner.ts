/**
 * I/O wrapper that connects the pure dedup algorithm in dedup.ts
 * to the project's filesystem + LLM. The UI layer calls these
 * functions; everything below is about read/write/spawn-llm so
 * the algorithm core stays testable without mocks of all that.
 */
import { listDirectory, readFile, writeFileAtomic, deleteFile, fileExists } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import { normalizeComparablePath, normalizePath } from "@/lib/path-utils"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import {
  DedupRollbackError,
  detectDuplicateGroups,
  extractEntitySummary,
  finalizeDuplicateMerge,
  mergeDuplicateGroup,
  type DedupLlmCall,
  type DuplicateGroup,
  type EntitySummary,
  type MergeResult,
} from "./dedup"
import { getJevConfig, type JevConfig } from "./jev-config"
import { isAiExcludedContent } from "./novel/ai-exclude"
import { buildBasicDetectionBatches, checkDedupSignal, waitForDedupResult, detectSagDuplicates } from "./dedup-candidates"
import { loadNotDuplicates } from "./dedup-storage"
import { advanceBatchDrafts, getBatchMergeDraft, type DedupMergeBatch } from "./dedup-merge-batch"

const WIKI_READ_CONCURRENCY = 12
const WIKI_WRITE_CONCURRENCY = 12

export type DedupMergeStage = "loading" | "merging" | "writing"

export type DedupScanStage = "loading" | "detecting"

/** Append-only process log line for UI / console. */
type DedupLogFn = (message: string) => void

interface ExecuteMergeOptions {
  batch?: DedupMergeBatch
  signal?: AbortSignal
  onProgress?: (stage: DedupMergeStage, requestGroups?: number) => void
  onLog?: DedupLogFn
}

interface RunDuplicateDetectionOptions {
  signal?: AbortSignal
  summaries?: EntitySummary[]
  jevConfig?: JevConfig | null
  onProgress?: (stage: DedupScanStage) => void
  onLog?: DedupLogFn
}

function describeLlm(llmConfig: LlmConfig): string {
  const provider = llmConfig.provider?.trim() || "unknown"
  const model = llmConfig.model?.trim() || "unknown"
  return `${provider}/${model}`
}

interface DuplicateDetectionResult {
  groups: DuplicateGroup[]
  scannedPageCount: number
  coverage?: string
  manualReview?: string[]
}

/**
 * Run `fn` over `items` with a bounded worker pool. Items where `fn`
 * returns null/undefined are omitted from the result.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R | null | undefined>,
): Promise<R[]> {
  if (items.length === 0) return []

  const limit = Math.max(1, concurrency)
  const results: R[] = []
  let index = 0

  async function worker(): Promise<void> {
    while (true) {
      const i = index++
      if (i >= items.length) return
      const result = await fn(items[i])
      if (result !== null && result !== undefined) {
        results.push(result)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  )
  return results
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return

  const limit = Math.max(1, concurrency)
  let index = 0

  async function worker(): Promise<void> {
    while (true) {
      const i = index++
      if (i >= items.length) return
      await fn(items[i])
    }
  }

  // Wait for all in-flight writes before propagating an error to the rollback.
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  )
  for (const result of settled) if (result.status === "rejected") throw result.reason
}

/**
 * Wrap streamChat into the (system, user, signal) → string shape
 * the dedup module expects. Same pattern page-merge uses — keeps
 * the algorithm modules free of any LlmConfig knowledge.
 */
function buildDedupLlmCall(llmConfig: LlmConfig, maxTokens: number, intactInputWindowTokens?: number): DedupLlmCall {
  return async (systemPrompt, userMessage, signal) => {
    let result = ""
    let streamError: Error | null = null
    await waitForDedupResult(() => streamChat(
      llmConfig,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      {
        onToken: (token) => { if (!signal?.aborted) result += token },
        onDone: () => {},
        onError: (error) => { streamError = error },
      },
      signal,
      { temperature: 0.1, max_tokens: maxTokens, reasoning: { mode: "off" }, skipUserMemory: true },
      { intactInputWindowTokens },
    ), signal)
    checkDedupSignal(signal)
    if (streamError) throw streamError
    return result
  }
}

/** Walk a FileNode tree, yielding every .md file under a given prefix. */
function* walkMd(nodes: FileNode[], projectPath: string, include: RegExp): Generator<FileNode> {
  for (const node of nodes) {
    if (node.is_dir) {
      if (node.children) yield* walkMd(node.children, projectPath, include)
      continue
    }
    if (node.name.endsWith(".md") && include.test(toWikiRelative(projectPath, node.path))) {
      yield node
    }
  }
}

/** Convert an absolute filesystem path to a wiki-relative one
 *  (`<project>/wiki/entities/foo.md` → `wiki/entities/foo.md`). */
function toWikiRelative(projectPath: string, absPath: string): string {
  const pp = normalizeComparablePath(projectPath)
  const norm = normalizePath(absPath)
  if (norm.startsWith(`${pp}/`)) return norm.slice(pp.length + 1)
  return norm
}

async function listEntityNodes(projectPath: string): Promise<FileNode[]> {
  const tree = await listDirectory(projectPath)
  return [...walkMd(tree, projectPath, /^(wiki|QM)\/(entities|concepts)\//)]
}

/** Re-check stale result cards without reading or modifying a page body. */
export async function missingDedupSlugs(projectPath: string, slugs: string[]): Promise<string[]> {
  const nodes = await listEntityNodes(normalizePath(projectPath))
  const names = new Set(nodes.map((node) => node.name))
  return slugs.filter((slug) => !names.has(slug + ".md"))
}

/**
 * Walk wiki/entities/ and wiki/concepts/, build summaries.
 * Pages that fail to parse (no frontmatter, etc.) are skipped
 * silently — they can't participate in dedup anyway.
 */
export async function loadAllEntitySummaries(
  projectPath: string,
  onSkipped?: () => void,
  signal?: AbortSignal,
): Promise<EntitySummary[]> {
  const pp = normalizePath(projectPath)
  const nodes = await listEntityNodes(pp)
  return mapWithConcurrency(nodes, WIKI_READ_CONCURRENCY, async (node) => {
    checkDedupSignal(signal)
    try {
      const content = await readFile(node.path)
      if (isAiExcludedContent(content)) return null
      const rel = toWikiRelative(pp, node.path)
      const summary = extractEntitySummary(rel, content)
      if (!summary) onSkipped?.()
      return summary
    } catch {
      onSkipped?.()
      return null
    }
  })
}

/** Read every .md under wiki/ as { path, content }. The path is
 *  the wiki-relative form callers downstream use. */
export async function loadAllWikiPages(
  projectPath: string,
  requireReadable = false,
  signal?: AbortSignal,
): Promise<{ path: string; content: string }[]> {
  const pp = normalizePath(projectPath)
  const tree = await listDirectory(pp)
  const nodes = [...walkMd(tree, pp, /^(wiki|QM)\//)]

  return mapWithConcurrency(nodes, WIKI_READ_CONCURRENCY, async (node) => {
    checkDedupSignal(signal)
    try {
      const content = await readFile(node.path)
      return { path: toWikiRelative(pp, node.path), content }
    } catch {
      if (requireReadable) throw new Error(`无法读取文档，不能确认合并引用：${node.path}`)
      return null
    }
  })
}

/**
 * Stage 1 + 2 from the user's perspective: scan the project for
 * duplicate-candidate groups. Reads notDuplicates whitelist from
 * disk so previously-confirmed false-positives don't reappear.
 */
export async function runDuplicateDetection(
  projectPath: string,
  llmConfig: LlmConfig,
  options: RunDuplicateDetectionOptions = {},
): Promise<DuplicateDetectionResult> {
  const log = options.onLog
  const config = options.jevConfig === undefined ? getJevConfig() : options.jevConfig
  log?.(`开始扫描，模型：${config ? "JEV/" + config.model : describeLlm(llmConfig)}`)
  checkDedupSignal(options.signal)
  options.onProgress?.("loading")
  log?.("正在读取实体 / 概念页面…")
  let skipped = 0
  const summaries = options.summaries ?? await loadAllEntitySummaries(projectPath, () => { skipped++ }, options.signal)
  checkDedupSignal(options.signal)
  const skippedNote = skipped ? `；另有 ${skipped} 页无法读取或缺少元数据，未参与检测` : ""
  log?.(`已读取 ${summaries.length} 个实体 / 概念页面`)

  if (summaries.length < 2) {
    log?.("页面不足 2 个，跳过模型检测")
    return { groups: [], scannedPageCount: summaries.length, ...(skippedNote ? { coverage: skippedNote.slice(1) } : {}) }
  }

  options.onProgress?.("detecting")
  const notDup = await loadNotDuplicates(projectPath)
  if (notDup.length > 0) {
    log?.(`已加载 ${notDup.length} 组「非重复」白名单`)
  }
  const ordered = [...summaries].sort((a, b) => a.path.localeCompare(b.path))
  if (config) {
    const result = await detectSagDuplicates(projectPath, ordered, config, notDup, log ?? (() => {}), options.signal)
    return { ...result, coverage: result.coverage + skippedNote, scannedPageCount: summaries.length }
  }
  const llm = buildDedupLlmCall(llmConfig, 8192)
  const batches = buildBasicDetectionBatches(ordered, notDup)
  const coverage = `基础查重：按名称和别名对 ${ordered.length} 页分批检测`
  const unique = new Map<string, DuplicateGroup>()
  for (const [i, batch] of batches.entries()) {
    checkDedupSignal(options.signal)
    log?.(`正在复核第 ${i + 1}/${batches.length} 批，共 ${batch.length} 页`)
    const groups = await detectDuplicateGroups(batch, llm, { signal: options.signal, notDuplicates: notDup })
    for (const group of groups) {
      const key = JSON.stringify([...group.slugs].sort())
      if (!unique.has(key)) unique.set(key, group)
    }
  }
  checkDedupSignal(options.signal)
  log?.(`模型分析完成，得到 ${unique.size} 组重复候选`)
  return { groups: [...unique.values()], scannedPageCount: summaries.length, coverage: `${coverage}，模型复核 ${batches.length} 批${skippedNote}` }
}

/** Resolve only entity/concept documents. The saved group format identifies members by slug. */
function indexDedupPages<T extends { path: string }>(pages: T[]) {
  const byName = new Map<string, T | null>()
  for (const page of pages) {
    if (!/^(wiki|QM)\/(entities|concepts)\//.test(page.path)) continue
    const name = page.path.split("/").pop()!
    byName.set(name, byName.has(name) ? null : page)
  }
  return (slugs: string[]) => {
    if (slugs.length < 2 || new Set(slugs).size !== slugs.length) throw new Error("候选组缺少两个不同的条目")
    return slugs.map((slug) => {
      const page = byName.get(slug + ".md")
      if (page === null) throw new Error(`实体或概念目录中有多份同名条目「${slug}」，无法确定合并对象`)
      if (!page) throw new Error(`未找到实体或概念条目「${slug}」，请重新扫描`)
      return { ...page, slug }
    })
  }
}

export function resolveDedupPages<T extends { path: string }>(pages: T[], slugs: string[]) {
  return indexDedupPages(pages)(slugs)
}

/**
 * Stage 3 + persistence: execute one user-confirmed merge.
 *
 * Steps:
 *   1. Load each group page's full content + every other wiki page
 *   2. Run mergeDuplicateGroup (LLM body merge + frontmatter
 *      union + cross-reference rewrites)
 *   3. Snapshot every touched file to .qmai/page-history/
 *      dedup-<timestamp>/
 *   4. Write canonical content
 *   5. Apply cross-reference rewrites
 *   6. Delete merged-away files
 */
export async function executeMerge(
  projectPath: string,
  group: DuplicateGroup,
  canonicalSlug: string | null,
  llmConfig: LlmConfig,
  options: ExecuteMergeOptions = {},
): Promise<MergeResult> {
  const pp = normalizePath(projectPath)
  const { signal, onProgress, onLog: log } = options

  log?.(
    `开始合并 ${group.slugs.join(", ")} → ${canonicalSlug ?? "由模型选择主条目"}，模型：${describeLlm(llmConfig)}`,
  )

  // 1. Resolve each group slug to its actual on-disk path + content
  onProgress?.("loading")
  log?.("正在读取 wiki 页面…")
  const allPages = await waitForDedupResult(() => loadAllWikiPages(pp, true, signal), signal)
  log?.(`已读取 ${allPages.length} 个 wiki 页面`)
  const resolvePages = indexDedupPages(allPages)
  const resolve = (slugs: string[]) => {
    const sources = resolvePages(slugs)
    if (sources.some(page => isAiExcludedContent(page.content))) {
      throw new Error("待合并条目已设为 AI 不读取，请重新扫描。")
    }
    return sources
  }
  const groupPages = resolve(group.slugs)
  checkDedupSignal(signal)

  const groupPaths = new Set(groupPages.map((p) => p.path))
  const otherPages = allPages.filter((page) => !groupPaths.has(page.path))

  const req = { group: groupPages, canonicalSlug, otherWikiPages: otherPages }
  let result: MergeResult
  if (options.batch && canonicalSlug === null) {
    const config: LlmConfig = { ...llmConfig, reasoning: { mode: "off" } }
    const draft = await getBatchMergeDraft(
      options.batch, groupPages, resolve, config,
      (system, user, maxTokens, window, groupCount) => {
        onProgress?.("merging", groupCount)
        return buildDedupLlmCall(config, maxTokens, window)(system, user, signal)
      },
      log,
    )
    result = finalizeDuplicateMerge(req, draft.canonicalSlug, draft.content)
  } else {
    onProgress?.("merging", 1)
    log?.("正在调用模型合并正文…")
    result = await mergeDuplicateGroup(req, buildDedupLlmCall(llmConfig, 16_384), { signal })
  }
  log?.(`模型正文合并完成，保留主条目：${result.canonicalPath}`)

  checkDedupSignal(signal)
  onProgress?.("writing")
  log?.("正在写入备份与文件…")

  // 2. Snapshot backup before any writes. If a write fails partway
  //    through, the user has the pre-merge state intact in
  //    .qmai/page-history/.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupDir = `${pp}/.qmai/page-history/dedup-${stamp}-${crypto.randomUUID()}`
  await runWithConcurrency(result.backup, WIKI_WRITE_CONCURRENCY, async (b) => {
    checkDedupSignal(signal)
    if (await readFile(`${pp}/${b.path}`) !== b.content) {
      throw new Error(`模型生成期间文件已变更，请重新扫描后再合并：${b.path}`)
    }
    await writeFileAtomic(`${backupDir}/${b.path}`, b.content)
  })
  log?.(`已备份 ${result.backup.length} 个文件 → ${backupDir}`)

  checkDedupSignal(signal)
  const originals = new Map(result.backup.map((b) => [b.path, b.content]))
  const applied = new Map<string, string | null>()
  const verifyOriginal = async (path: string) => {
    if (await readFile(`${pp}/${path}`) !== originals.get(path)) {
      throw new Error(`文件已变更，请重新扫描后再合并：${path}`)
    }
  }
  try {
    const writes = [{ path: result.canonicalPath, newContent: result.canonicalContent }, ...result.rewrites]
    await runWithConcurrency(writes, WIKI_WRITE_CONCURRENCY, async ({ path, newContent }) => {
      checkDedupSignal(signal)
      await verifyOriginal(path)
      checkDedupSignal(signal)
      await writeFileAtomic(`${pp}/${path}`, newContent)
      applied.set(path, newContent)
    })
    await runWithConcurrency(result.pagesToDelete, WIKI_WRITE_CONCURRENCY, async (path) => {
      checkDedupSignal(signal)
      await verifyOriginal(path)
      checkDedupSignal(signal)
      await deleteFile(`${pp}/${path}`)
      applied.set(path, null)
    })
    checkDedupSignal(signal)
    log?.(`已写入主条目，更新 ${result.rewrites.length} 个引用文件，移除 ${result.pagesToDelete.length} 个已合并页面`)
  } catch (error) {
    // 仅撤回本次成功写入且仍匹配的状态，保留随后发生的外部编辑。
    try {
      await runWithConcurrency([...applied], WIKI_WRITE_CONCURRENCY, async ([path, value]) => {
        const absPath = `${pp}/${path}`
        const current = await fileExists(absPath) ? await readFile(absPath) : null
        if (current === value) await writeFileAtomic(absPath, originals.get(path)!)
      })
    } catch {
      throw new DedupRollbackError(`合并中断，有文件未能恢复，原文件备份位于 ${backupDir}`)
    }
    throw error
  }

  if (options.batch) advanceBatchDrafts(options.batch, result, allPages.map((page) => page.path))
  log?.("合并完成")
  return result
}
