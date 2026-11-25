import { eligibleChapterNumber, searchSagProject } from "@/lib/sag-search"
import { getJevConfig } from "@/lib/jev-config"
import { searchWiki } from "@/lib/search"
import { parseFrontmatter } from "@/lib/frontmatter"
import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { loadSnapshot, listSnapshots } from "./chapter-ingest"
import { isAiExcludedContent } from "./ai-exclude"
import { hasReadableHistory, listAiExcludedChapterNumbers } from "./ai-exclude-chapters"
interface NovelSearchParams {
  projectPath: string
  query: string
  chapterNumber?: number
  readableChapters?: ReadonlyMap<number, string>
  topK?: number
  authoritativeOnly?: boolean
  includeGraph?: boolean
  signal?: AbortSignal
  includeKeyword?: boolean
  includeRecentChapters?: boolean
  includeCanon?: boolean
}

interface NovelSearchResult {
  startLine?: number
  endLine?: number
  type: "keyword" | "sag" | "graph" | "recent_chapter" | "canon"
  path: string
  title: string
  snippet: string
  relevance: number
}

type RankedNovelSearchResult = NovelSearchResult & {
  sourceRank: number
}

const SOURCE_RRF_K = 60
const SEARCH_SOURCE_TIMEOUT_MS = 2500
const SOURCE_WEIGHTS: Record<NovelSearchResult["type"], number> = {
  keyword: 1,
  sag: 1,
  graph: 0.95,
  canon: 0.9,
  recent_chapter: 0.75,
}

const SOURCE_TIE_PRIORITY: Record<NovelSearchResult["type"], number> = {
  keyword: 0,
  sag: 1,
  graph: 2,
  canon: 3,
  recent_chapter: 4,
}

export function isAuthoritativeGenerationPath(path: string): boolean {
  return /\/(?:wiki|QM)\/(entities|concepts|memory|chapters)\//.test(path)
    || /\/(?:wiki|QM)\/canon\.md$/.test(path)
    || /\/\.qmai\/novel\/snapshots\//.test(path)
}

export function isHistoricalProjectionSnippet(path: string, snippet: string): boolean {
  return /\/history\//.test(path) || /is_historical:\s*true/i.test(snippet)
}

export async function novelMixedSearch(params: NovelSearchParams): Promise<NovelSearchResult[]> {
  const pp = normalizePath(params.projectPath)
  const topK = params.topK ?? 5
  if (getJevConfig()) {
    const hits = await searchSagProject(pp, params.query, topK, {
      beforeChapter: params.authoritativeOnly ? params.chapterNumber : undefined, signal: params.signal,
    })
    return hits.map(hit => ({
      type: "sag", path: hit.path, title: hit.title, snippet: hit.content, relevance: hit.score,
      startLine: hit.startLine, endLine: hit.endLine,
    }))
  }
  const results: RankedNovelSearchResult[] = []

  const promises: Promise<void>[] = []

  if (params.includeKeyword !== false) {
    const pKeyword = runSearchBranch("keyword", searchWiki(pp, params.query, {
      localOnly: true,
      signal: params.signal,
      acceptFile: (path, content) => !isAiExcludedContent(content)
        && (!params.authoritativeOnly || eligibleLocalSource(path, content, params.chapterNumber, params.readableChapters)),
    })).then(items => {
      console.log("[novelMixedSearch] keyword done, got", items.length)
      results.push(...items.slice(0, topK).map((item, sourceRank) => ({
        type: "keyword" as const,
        path: item.path,
        title: item.title,
        snippet: item.snippet ?? "",
        relevance: item.score ?? 0,
        sourceRank,
      })))
    })
    promises.push(pKeyword)
  }

  if (params.includeGraph) {
    const pGraph = runSearchBranch("graph", runGraphSearch(pp, params.query, topK, params.authoritativeOnly ? params.chapterNumber : undefined, params.readableChapters)).then(items => {
      console.log("[novelMixedSearch] graph done, got", items.length)
      results.push(...rankSourceResults(items))
    })
    promises.push(pGraph)
  }

  if (params.includeRecentChapters) {
    const pRecent = runSearchBranch("recent_chapter", runRecentChapterSearch(pp, topK, params.chapterNumber, params.readableChapters)).then(items => {
      console.log("[novelMixedSearch] recent_chapter done, got", items.length)
      results.push(...rankSourceResults(items))
    })
    promises.push(pRecent)
  }

  if (params.includeCanon) {
    const pCanon = runSearchBranch("canon", runCanonSearch(pp, params.query)).then(items => {
      console.log("[novelMixedSearch] canon done, got", items.length)
      results.push(...rankSourceResults(items))
    })
    promises.push(pCanon)
  }

  console.log("[novelMixedSearch] waiting for", promises.length, "promises...")
  await Promise.all(promises)
  console.log("[novelMixedSearch] all promises resolved, total results:", results.length)

  const merged = deduplicateResults(results, topK)
  const filtered = params.authoritativeOnly
    ? merged.filter((item) => {
      if (isHistoricalProjectionSnippet(item.path, item.snippet)) return false
      if (item.type === "canon" || item.type === "recent_chapter") return true
      return isAuthoritativeGenerationPath(item.path)
    })
    : merged
  console.log("[novelMixedSearch] dedup done, merged:", merged.length, "filtered:", filtered.length)

  params.signal?.throwIfAborted()
  return filtered
}

export function eligibleLocalSource(path: string, content: string, chapterNumber?: number, readable?: ReadonlyMap<number, string>): boolean {
  if (isAiExcludedContent(content) || isHistoricalProjectionSnippet(path, content)) return false
  if (chapterNumber && /\/(?:wiki|QM)\/chapters\//.test(normalizePath(path))) {
    return eligibleChapterNumber(path, content, chapterNumber) !== null
  }
  if (chapterNumber) {
    const { frontmatter } = parseFrontmatter(content)
    if (frontmatter?.snapshot_id || /\/(?:wiki|QM)\/memory\//.test(normalizePath(path))) {
      const through = Number(frontmatter?.source_sequence ?? frontmatter?.chapter_number)
      return frontmatter?.source_type !== "outline" && through > 0 && through < chapterNumber
        && (!readable || hasReadableHistory(through, readable))
    }
  }
  return isAuthoritativeGenerationPath(normalizePath(path))
}

async function runSearchBranch<T>(label: string, promise: Promise<T>): Promise<T> {
  try {
    return await withTimeout(promise, SEARCH_SOURCE_TIMEOUT_MS, label)
  } catch (err) {
    console.log(`[novelMixedSearch] ${label} error:`, err)
    return [] as T
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} search timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function rankSourceResults(items: NovelSearchResult[]): RankedNovelSearchResult[] {
  return items.map((item, sourceRank) => ({ ...item, sourceRank }))
}

async function runGraphSearch(
  pp: string,
  query: string,
  topK: number,
  chapterNumber?: number,
  readable?: ReadonlyMap<number, string>,
): Promise<NovelSearchResult[]> {
  try {
    const { buildRetrievalGraph, getRelatedNodes } = await import("@/lib/graph-relevance")
    const graph = await buildRetrievalGraph(pp)
    if (graph.nodes.size === 0) return []

    const tokens = query
      .split(/[\s,，。！？、]+/)
      .filter(t => t.length >= 2)

    const candidateNames = new Set(tokens)
    for (const [, node] of graph.nodes) {
      const nodeText = `${node.title} ${node.id}`.toLowerCase()
      for (const token of tokens) {
        if (nodeText.includes(token.toLowerCase())) {
          candidateNames.add(node.title)
          candidateNames.add(node.id)
        }
      }
    }

    const seenIds = new Set<string>()
    const scoredNodes: { title: string; path: string; snippet: string; relevance: number }[] = []

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
            if (isAiExcludedContent(content) || (chapterNumber && !eligibleLocalSource(node.path, content, chapterNumber, readable))) continue
            scoredNodes.push({
              title: node.title,
              path: node.path,
              snippet: content.slice(0, 300).replace(/\n/g, " "),
              relevance: Math.round(relevance * 100) / 100,
            })
          } catch {}
        }
      }
    }

    scoredNodes.sort((a, b) => b.relevance - a.relevance)
    return scoredNodes.slice(0, topK).map(n => ({
      type: "graph" as const,
      path: n.path,
      title: n.title,
      snippet: n.snippet,
      relevance: n.relevance,
    }))
  } catch {
    return []
  }
}

async function runRecentChapterSearch(
  pp: string,
  topK: number,
  beforeChapter?: number,
  readable?: ReadonlyMap<number, string>,
): Promise<NovelSearchResult[]> {
  try {
    const chapterNumbers = await listSnapshots(pp)
    if (chapterNumbers.length === 0) return []

    const recentNumbers = chapterNumbers.filter(n => n > 0 && (!beforeChapter || n < beforeChapter) && (!readable || readable.has(n))).slice(-topK).reverse()
    const items: NovelSearchResult[] = []
    // 「选中（AI 不读取）」：快照也是从被排除的章节里提炼的，检索里同样不出现。
    const excludedNumbers = await listAiExcludedChapterNumbers(pp, recentNumbers, readable)

    for (const num of recentNumbers) {
      if (excludedNumbers.has(num)) continue
      const snap = await loadSnapshot(pp, num)
      if (snap) {
        const paddedNum = String(num).padStart(3, "0")
        items.push({
          type: "recent_chapter",
          path: `${pp}/.qmai/novel/snapshots/${paddedNum}.snapshot.json`,
          title: `第${num}章`,
          snippet: snap.summary || snap.endingHook || "",
          relevance: 1,
        })
      }
    }
    return items
  } catch {
    return []
  }
}

async function runCanonSearch(
  pp: string,
  query: string,
): Promise<NovelSearchResult[]> {
  const canonPath = `${pp}/wiki/canon.md`
  try {
    const content = await readFile(canonPath)
    if (!content.trim() || isAiExcludedContent(content)) return []

    const queryLower = query.toLowerCase()
    const lines = content.split("\n")
    const matchedLines: string[] = []

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(queryLower)) {
        const start = Math.max(0, i - 1)
        const end = Math.min(lines.length, i + 2)
        matchedLines.push(lines.slice(start, end).join("\n"))
      }
    }

    if (matchedLines.length === 0) {
      return [{
        type: "canon",
        path: canonPath,
        title: "正史规则",
        snippet: content.slice(0, 500).replace(/\n/g, " "),
        relevance: 0.5,
      }]
    }

    return matchedLines.slice(0, 3).map((snippet, i) => ({
      type: "canon" as const,
      path: canonPath,
      title: "正史规则",
      snippet: snippet.replace(/\n/g, " ").slice(0, 300),
      relevance: 1 - i * 0.1,
    }))
  } catch {
    return []
  }
}

function deduplicateResults(results: RankedNovelSearchResult[], topK: number): NovelSearchResult[] {
  const fused = new Map<string, {
    result: NovelSearchResult
    fusionScore: number
    bestContribution: number
    bestRelevance: number
    bestRank: number
    bestTypePriority: number
  }>()

  for (const r of results) {
    const sourceRank = Math.max(0, r.sourceRank)
    const weight = SOURCE_WEIGHTS[r.type] ?? 0.8
    const contribution = weight / (SOURCE_RRF_K + sourceRank + 1)
    const key = normalizeResultPath(r.path)
    const cleanResult = toPublicResult(r)
    const existing = fused.get(key)

    if (!existing) {
      fused.set(key, {
        result: cleanResult,
        fusionScore: contribution,
        bestContribution: contribution,
        bestRelevance: r.relevance,
        bestRank: sourceRank,
        bestTypePriority: SOURCE_TIE_PRIORITY[r.type] ?? 9,
      })
      continue
    }

    existing.fusionScore += contribution
    if (shouldReplaceRepresentative(existing, r, contribution)) {
      existing.result = cleanResult
      existing.bestContribution = contribution
      existing.bestRelevance = r.relevance
      existing.bestRank = sourceRank
      existing.bestTypePriority = SOURCE_TIE_PRIORITY[r.type] ?? 9
    }
  }

  return Array.from(fused.values())
    .sort((a, b) => {
      if (b.fusionScore !== a.fusionScore) return b.fusionScore - a.fusionScore
      if (b.bestRelevance !== a.bestRelevance) return b.bestRelevance - a.bestRelevance
      if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank
      if (a.bestTypePriority !== b.bestTypePriority) return a.bestTypePriority - b.bestTypePriority
      return a.result.title.localeCompare(b.result.title)
    })
    .slice(0, topK)
    .map((item) => ({
      ...item.result,
      relevance: Math.round(item.fusionScore * 1_000_000) / 1_000_000,
    }))
}

function normalizeResultPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase()
}

function toPublicResult(result: NovelSearchResult): NovelSearchResult {
  return {
    type: result.type,
    path: result.path,
    title: result.title,
    snippet: result.snippet,
    relevance: result.relevance,
  }
}

function shouldReplaceRepresentative(
  existing: {
    bestContribution: number
    bestRelevance: number
    bestRank: number
    bestTypePriority: number
  },
  candidate: RankedNovelSearchResult,
  contribution: number,
): boolean {
  if (contribution !== existing.bestContribution) return contribution > existing.bestContribution
  if (candidate.relevance !== existing.bestRelevance) return candidate.relevance > existing.bestRelevance
  if (candidate.sourceRank !== existing.bestRank) return candidate.sourceRank < existing.bestRank
  return (SOURCE_TIE_PRIORITY[candidate.type] ?? 9) < existing.bestTypePriority
}

interface SearchPlotOptions {
  scene?: string
  topK?: number
  includeKeyword?: boolean
  signal?: AbortSignal
  includeGraph?: boolean
  includeRecentChapters?: boolean
  includeCanon?: boolean
}

export async function searchPlot(
  projectPath: string,
  query: string,
  options?: SearchPlotOptions,
): Promise<NovelSearchResult[]> {
  return novelMixedSearch({
    projectPath,
    query,
    topK: options?.topK ?? 10,
    includeKeyword: options?.includeKeyword ?? true,
    signal: options?.signal,
    includeGraph: options?.includeGraph ?? true,
    includeRecentChapters: options?.includeRecentChapters ?? true,
    includeCanon: options?.includeCanon ?? false,
  })
}
