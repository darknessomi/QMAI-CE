import { parseFrontmatter } from "./frontmatter"
import { isAiExcludedContent } from "./novel/ai-exclude"
import { getJevConfig } from "./jev-config"
import { searchSagProject } from "./sag-search"
import { listDirectory, readFile } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { mapWikiMarkdown } from "./wiki-markdown-batches"

/**
 * One image reference extracted from a matched page's markdown.
 *
 * `url` is verbatim what was inside the `![](...)` parens — this is
 * a forward-slash path that the markdown image resolver knows how
 * to map to a renderable URL. We deliberately keep it pre-resolution
 * so the search-result UI can filter by URL prefix (e.g. "only show
 * images from this source's media dir") before paying the cost of
 * `convertFileSrc`.
 */
export interface ImageRef {
  url: string
  alt: string
}

export interface SearchResult {
  path: string
  title: string
  snippet: string
  startLine?: number
  endLine?: number
  score: number
  /**
   * Image references found inside this result's markdown. Populated
   * even when the query doesn't match the alt text — the UI splits
   * "alt-matches-query" from "image just lives on this matched
   * page" itself, so both views need the full set. May be empty.
   */
  images: ImageRef[]
}

interface SearchWikiOptions {
  topK?: number
  localOnly?: boolean
  includePageImages?: boolean
  /** 仅供内部按章号读取禁读标记。 */
  includeExcludedMetadata?: boolean
  signal?: AbortSignal
  acceptPath?: (path: string) => boolean
  acceptFile?: (path: string, content: string) => boolean | Promise<boolean>
}

const MAX_RESULTS = 20
const SNIPPET_CONTEXT = 80

const RRF_K = 60

// ── Scoring weights ────────────────────────────────────────────────────────
// Exact lexical matches dominate everything else. The rationale: when a
// user types "attention", the page literally named `attention.md` MUST
// rank first, regardless of how many other pages also mention the word.
//
//   filename == query (e.g. `attention.md` for query "attention")
//     → FILENAME_EXACT_BONUS — large enough that nothing short of an
//       equally-exact match can outrank it.
//
//   title or content contains the raw query as a substring
//     → PHRASE_IN_TITLE_BONUS / PHRASE_IN_CONTENT_PER_OCC — phrase
//       presence is worth far more than individual token presence, and
//       in content it rewards repetition (with a cap to avoid runaway).
//
//   per-token matches (existing behavior, but now smaller weight)
//     → TITLE_TOKEN_WEIGHT / CONTENT_TOKEN_WEIGHT. These used to
//       dominate via a flat +10 title bonus regardless of how many
//       tokens matched; now each matched token counts individually.
const FILENAME_EXACT_BONUS = 200
const PHRASE_IN_TITLE_BONUS = 50
const PHRASE_IN_CONTENT_PER_OCC = 20
const MAX_PHRASE_OCC_COUNTED = 10 // cap to avoid runaway on huge logs
const TITLE_TOKEN_WEIGHT = 5
const CONTENT_TOKEN_WEIGHT = 1

const STOP_WORDS = new Set([
  "的", "是", "了", "什么", "在", "有", "和", "与", "对", "从",
  "the", "is", "a", "an", "what", "how", "are", "was", "were",
  "do", "does", "did", "be", "been", "being", "have", "has", "had",
  "it", "its", "in", "on", "at", "to", "for", "of", "with", "by",
  "this", "that", "these", "those",
])

export function tokenizeQuery(query: string): string[] {
  // Split by whitespace and punctuation
  const rawTokens = query
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…]+/)
    .filter((t) => t.length > 1)
    .filter((t) => !STOP_WORDS.has(t))

  const tokens: string[] = []

  for (const token of rawTokens) {
    // Check if token contains CJK characters
    const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token)

    if (hasCJK && token.length > 2) {
      // For CJK text: split into individual characters AND overlapping bigrams
      // "默会知识" → ["默会", "会知", "知识", "默", "会", "知", "识"]
      const chars = [...token]
      // Add bigrams (most useful for Chinese)
      for (let i = 0; i < chars.length - 1; i++) {
        tokens.push(chars[i] + chars[i + 1])
      }
      // Also add individual chars (for single-char matches)
      for (const ch of chars) {
        if (!STOP_WORDS.has(ch)) {
          tokens.push(ch)
        }
      }
      // Keep the original token too (for exact phrase match)
      tokens.push(token)
    } else {
      tokens.push(token)
    }
  }

  // Deduplicate
  return [...new Set(tokens)]
}

function tokenMatchScore(text: string, tokens: readonly string[]): number {
  const lower = text.toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (lower.includes(token)) score += 1
  }
  return score
}

function countOccurrences(haystackLower: string, needleLower: string): number {
  if (!needleLower || needleLower.length === 0) return 0
  let count = 0
  let pos = 0
  while (true) {
    const idx = haystackLower.indexOf(needleLower, pos)
    if (idx === -1) break
    count++
    pos = idx + needleLower.length
  }
  return count
}

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

function extractTitle(content: string, fileName: string): string {
  const title = parseFrontmatter(content).frontmatter?.title
  if (typeof title === "string" && title.trim()) return title.trim()

  // Try first heading
  const headingMatch = content.match(/^#\s+(.+)$/m)
  if (headingMatch) return headingMatch[1].trim()

  // Fall back to filename
  return fileName.replace(/\.md$/, "").replace(/-/g, " ")
}

/**
 * Markdown image-reference regex. Matches `![alt](url)` capturing
 * groups 1=alt, 2=url. Identical to the regex in
 * `image-caption-pipeline.ts` — kept duplicated rather than shared
 * because the two modules have very different lifetimes (search
 * runs every keystroke; the pipeline runs at ingest), and a shared
 * symbol there would tie them together for no benefit.
 *
 * Excludes:
 *   - HTML `<img src=...>` (we don't generate these)
 *   - Reference-style `![alt][ref]` (we don't generate these either)
 */
const IMAGE_REF_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g

function extractImageRefs(content: string): ImageRef[] {
  const seen = new Set<string>()
  const out: ImageRef[] = []
  for (const m of content.matchAll(IMAGE_REF_RE)) {
    const url = m[2]
    // De-dupe within a single page: the same image may be
    // referenced both inline (LLM-preserved) AND in the safety-net
    // "## Embedded Images" section. Showing it twice in the
    // results UI would just be visual noise.
    if (seen.has(url)) continue
    seen.add(url)
    out.push({ url, alt: m[1] })
  }
  return out
}

function buildSnippet(content: string, query: string): string {
  const lower = content.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const idx = lower.indexOf(lowerQuery)
  if (idx === -1) return content.slice(0, SNIPPET_CONTEXT * 2).replace(/\n/g, " ")

  const start = Math.max(0, idx - SNIPPET_CONTEXT)
  const end = Math.min(content.length, idx + query.length + SNIPPET_CONTEXT)
  let snippet = content.slice(start, end).replace(/\n/g, " ")
  if (start > 0) snippet = "..." + snippet
  if (end < content.length) snippet = snippet + "..."
  return snippet
}

export async function searchWiki(
  projectPath: string,
  query: string,
  options: SearchWikiOptions = {},
): Promise<SearchResult[]> {
  if (!query.trim()) return []
  options.signal?.throwIfAborted()
  const pp = normalizePath(projectPath)
  const topK = options.topK ?? MAX_RESULTS
  if (!options.localOnly && getJevConfig()) {
    const hits = await searchSagProject(pp, query, topK, { signal: options.signal })
    const pageImages = new Map<string, ImageRef[]>()
    if (options.includePageImages) {
      for (const path of new Set(hits.map(hit => hit.path))) {
        options.signal?.throwIfAborted()
        const text = await readFile(path).catch(() => null)
        if (text !== null && !isAiExcludedContent(text)) pageImages.set(path, extractImageRefs(text))
      }
      options.signal?.throwIfAborted()
    }
    return hits.filter(hit => !options.includePageImages || pageImages.has(hit.path)).map(hit => ({
      path: hit.path, title: hit.title, snippet: hit.content, score: hit.score,
      startLine: hit.startLine, endLine: hit.endLine, images: pageImages.get(hit.path) ?? [],
    }))
  }

  const tokens = tokenizeQuery(query)
  const effectiveTokens = tokens.length ? tokens : [query.trim().toLowerCase()]
  const queryPhrase = query.trim().toLowerCase().replace(TRIM_PUNCT_RE, "")
  let results: SearchResult[]
  try {
    const allFiles = flattenMdFiles(await listDirectory(`${pp}/wiki`))
    const files = options.acceptPath ? allFiles.filter(file => options.acceptPath!(file.path)) : allFiles
    results = await mapWikiMarkdown(files, async (file, content) => {
      options.signal?.throwIfAborted()
      if (!options.includeExcludedMetadata && isAiExcludedContent(content)) return null
      const result = scoreFile(file, content, effectiveTokens, queryPhrase, query)
      if (result && options.acceptFile && !await options.acceptFile(file.path, content)) return null
      return result
    })
  } catch {
    options.signal?.throwIfAborted()
    return []
  }
  return results.sort((a, b) => b.score - a.score).slice(0, topK)
    .map((result, index) => ({ ...result, score: 1 / (RRF_K + index + 1) }))
}

/**
 * Punctuation pattern shared between token splitting and the
 * phrase-bonus normalization below. Matched at start AND end of
 * the query — internal punctuation (`U.S.A.`, `2024-Q3`) stays
 * because it might be load-bearing in legitimate phrase matches.
 */
const TRIM_PUNCT_RE =
  /^[\s,，。！？、；：""''（）()\-_/\\·~～…]+|[\s,，。！？、；：""''（）()\-_/\\·~～…]+$/g

/**
 * Pure scoring pass over one Markdown page.
 */
function scoreFile(
  file: FileNode,
  content: string,
  tokens: readonly string[],
  queryPhrase: string,
  query: string,
): SearchResult | null {
  const title = extractTitle(content, file.name)
  const titleText = `${title} ${file.name}`
  const titleLower = titleText.toLowerCase()
  const contentLower = content.toLowerCase()
  const fileStem = file.name.replace(/\.md$/, "").toLowerCase()

  // Exact-match signals (strongest)
  const filenameExact = fileStem === queryPhrase
  const titleHasPhrase =
    queryPhrase.length > 0 && titleLower.includes(queryPhrase)
  const contentPhraseOcc = Math.min(
    countOccurrences(contentLower, queryPhrase),
    MAX_PHRASE_OCC_COUNTED,
  )

  // Token-level signals (fallback / density)
  const titleTokenScore = tokenMatchScore(titleText, tokens)
  const contentTokenScore = tokenMatchScore(content, tokens)

  if (
    !filenameExact &&
    !titleHasPhrase &&
    contentPhraseOcc === 0 &&
    titleTokenScore === 0 &&
    contentTokenScore === 0
  ) {
    return null
  }

  const score =
    (filenameExact ? FILENAME_EXACT_BONUS : 0) +
    (titleHasPhrase ? PHRASE_IN_TITLE_BONUS : 0) +
    contentPhraseOcc * PHRASE_IN_CONTENT_PER_OCC +
    titleTokenScore * TITLE_TOKEN_WEIGHT +
    contentTokenScore * CONTENT_TOKEN_WEIGHT

  const snippetAnchor =
    contentPhraseOcc > 0
      ? queryPhrase
      : tokens.find((t) => contentLower.includes(t)) ?? query

  return {
    path: file.path,
    title,
    snippet: buildSnippet(content, snippetAnchor),
    score,
    images: extractImageRefs(content),
  }
}

