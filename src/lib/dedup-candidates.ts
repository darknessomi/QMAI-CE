import { invoke } from "@tauri-apps/api/core"
import { readFile } from "@/commands/fs"
import { normalizePath } from "./path-utils"
import { parseFrontmatter } from "./frontmatter"
import { isAiExcluded } from "./novel/ai-exclude"
import { sagSearchFiles, type SagSourceVersion } from "./sag-search"
import { sha256Text } from "./context-hub/fingerprint"
import { extractEntitySummary, normalizeGroupKey, type EntitySummary, type DuplicateGroup } from "./dedup"
import { jevServiceError, type JevConfig } from "./jev-config"

export const DETECTOR_BATCH_SIZE = 80

export function checkDedupSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("操作已取消")
}

/** Release read-only work on cancel even when the transport hasn't acknowledged the abort. */
export async function waitForDedupResult<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  checkDedupSignal(signal)
  if (!signal) return start()
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("操作已取消"))
    signal.addEventListener("abort", abort, { once: true })
  })
  try {
    return await Promise.race([start(), cancelled])
  } finally {
    signal.removeEventListener("abort", abort)
  }
}

type Pair = readonly [number, number]

export function namePairs(pages: EntitySummary[], allMatches = false): Pair[] {
  const byName = new Map<string, number[]>()
  const pairs: Pair[] = []
  pages.forEach((page, index) => {
    const names = [page.title, page.slug, ...(page.aliases ?? [])]
    const keys = new Set(names.map(name => name.normalize("NFKC").toLowerCase().replace(/[\s_-]+/g, "")))
    for (const key of keys) {
      if (!key) continue
      const matches = byName.get(key)
      if (matches) {
        for (const other of matches) pairs.push([other, index])
        if (allMatches) matches.push(index)
      } else {
        byName.set(key, [index])
      }
    }
  })
  return pairs
}

export function windowBatches(pages: EntitySummary[]): EntitySummary[][] {
  const sorted = [...pages].sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path))
  const batches: EntitySummary[][] = []
  for (let start = 0; start < sorted.length; start += DETECTOR_BATCH_SIZE - 8) {
    batches.push(sorted.slice(start, start + DETECTOR_BATCH_SIZE))
    if (start + DETECTOR_BATCH_SIZE >= sorted.length) break
  }
  return batches.filter((batch) => batch.length >= 2)
}

export function pairBatches(
  pages: EntitySummary[], pairs: Pair[], excluded: string[][], existing: EntitySummary[][] = [],
): EntitySummary[][] {
  const blocked = new Set(excluded.filter((group) => group.length === 2).map((group) => JSON.stringify(group.map((s) => s.toLowerCase()).sort())))
  const covered = new Map<string, Set<number>>()
  existing.forEach((batch, index) => batch.forEach((page) => {
    const ids = covered.get(page.path) ?? new Set<number>()
    ids.add(index)
    covered.set(page.path, ids)
  }))
  const batches: EntitySummary[][] = []
  let batch = new Set<number>()
  const seen = new Set<string>()
  for (const [i, j] of pairs) {
    const key = i < j ? `${i}/${j}` : `${j}/${i}`
    if (seen.has(key)) continue
    seen.add(key)
    if (blocked.has(JSON.stringify([pages[i].slug.toLowerCase(), pages[j].slug.toLowerCase()].sort()))) continue
    const left = covered.get(pages[i].path)
    const right = covered.get(pages[j].path)
    if (left && right && [...left].some((id) => right.has(id))) continue
    if (batch.size + Number(!batch.has(i)) + Number(!batch.has(j)) > DETECTOR_BATCH_SIZE) {
      batches.push(Array.from(batch, (idx) => pages[idx]))
      batch = new Set()
    }
    batch.add(i)
    batch.add(j)
  }
  if (batch.size) batches.push(Array.from(batch, (idx) => pages[idx]))
  return batches
}

export function buildBasicDetectionBatches(pages: EntitySummary[], excluded: string[][]) {
  const windows = windowBatches(pages)
  return [...windows, ...pairBatches(pages, namePairs(pages), excluded, windows)]
}

function entitySourceKey(path: string, root: string): string {
  const canonical = normalizePath(path)
  const relative = canonical.startsWith(root + "/") ? canonical.slice(root.length + 1) : canonical
  return relative.replace(/^QM\//, "wiki/")
}

interface Passage {
  text: string
  startLine: number
  endLine: number
}

interface CurrentPassage extends Passage {
  source: SagSourceVersion
  title: string
}

async function readPassage(path: string, other: EntitySummary, hit?: Passage): Promise<CurrentPassage | null> {
  const content = await readFile(path).catch(() => "")
  const { frontmatter, body } = parseFrontmatter(content)
  if (!frontmatter || isAiExcluded(frontmatter)) return null
  const title = extractEntitySummary(path, content)?.title
  if (!title) return null
  const source = { path, contentHash: await sha256Text(content) }
  const lines = content.split(/\r?\n/)
  const offset = (content.slice(0, content.length - body.length).match(/\n/g) ?? []).length
  const useful = (line: string) => Boolean(line.trim()) && !/^\s*#/.test(line)
  if (hit && hit.startLine > offset && hit.endLine >= hit.startLine && hit.endLine <= lines.length) {
    const original = lines.slice(hit.startLine - 1, hit.endLine).join("\n")
    const text = hit.text.trim().slice(0, 1200)
    const begin = original.indexOf(text)
    if (begin >= 0 && text.split("\n").some(useful)) {
      const startLine = hit.startLine + original.slice(0, begin).split("\n").length - 1
      return { text, startLine, endLine: startLine + text.split("\n").length - 1, source, title }
    }
  }
  const bodyLines = body.split(/\r?\n/)
  const terms = [other.title, ...(other.aliases ?? [])].filter(Boolean)
  let start = bodyLines.findIndex(line => useful(line) && terms.some(term => line.includes(term)))
  if (start < 0) start = bodyLines.findIndex(useful)
  if (start < 0) return null
  const text = bodyLines.slice(start, start + 6).join("\n").trimEnd().slice(0, 1200)
  return { text, startLine: offset + start + 1, endLine: offset + start + text.split("\n").length, source, title }
}

async function judgePair(projectPath: string, config: JevConfig, a: CurrentPassage, b: CurrentPassage, signal?: AbortSignal): Promise<number> {
  const requestId = crypto.randomUUID()
  const cancel = () => { void invoke("sag_cancel", { requestId }).catch(() => {}) }
  signal?.addEventListener("abort", cancel, { once: true })
  try {
    return await waitForDedupResult(() => invoke<number>("sag_judge_pair", {
      projectPath, config, left: a.title + "\n" + a.text, right: b.title + "\n" + b.text,
      sources: [a.source, b.source], requestId, purpose: "identity",
    }), signal)
  } finally {
    signal?.removeEventListener("abort", cancel)
  }
}

export async function detectSagDuplicates(
  projectPath: string, pages: EntitySummary[], config: JevConfig,
  excluded: string[][], log: (message: string) => void, signal?: AbortSignal,
): Promise<{ groups: DuplicateGroup[]; coverage: string; manualReview: string[] }> {
  const root = normalizePath(projectPath).replace(/\/+$/, "")
  const paths = pages.map(page => root + "/" + page.path)
  const indices = new Map(paths.map((path, i) => [entitySourceKey(path, root), i]))
  const blocked = new Set(excluded.map(normalizeGroupKey))
  const pairs = new Map<string, { left: number; right: number; passages: Map<number, Passage> }>()
  function add(i: number, j: number, passage?: Passage) {
    if (i === j || pages[i].slug === pages[j].slug || blocked.has(normalizeGroupKey([pages[i].slug, pages[j].slug]))) return
    const left = Math.min(i, j)
    const right = Math.max(i, j)
    const key = left + "/" + right
    const pair = pairs.get(key) ?? { left, right, passages: new Map<number, Passage>() }
    if (passage && !pair.passages.has(j)) pair.passages.set(j, passage)
    pairs.set(key, pair)
  }
  // 基础模式一次核对整批；JEV 每次核对两页，同名组中的每一对都可能是不同结论。
  for (const [i, j] of namePairs(pages, true)) add(i, j)
  let searched = 0
  for (const [i, page] of pages.entries()) {
    checkDedupSignal(signal)
    // 长扫描期间条目可能改为禁读；作为查询发送给决策服务前也要复核来源。
    const content = await readFile(paths[i]).catch(() => "")
    const { frontmatter } = parseFrontmatter(content)
    if (!frontmatter || isAiExcluded(frontmatter)) continue
    const current = extractEntitySummary(page.path, content)
    if (!current) continue
    const query = [current.title, ...(current.aliases ?? []), current.description].filter(Boolean).join(" ")
    try {
      const otherPaths = paths.filter(path => path !== paths[i])
      const querySource = { path: paths[i], contentHash: await sha256Text(content) }
      const hits = await waitForDedupResult(() => sagSearchFiles(root, query, otherPaths, 8, signal, { querySource }), signal)
      searched++
      for (const hit of hits) {
        const j = indices.get(entitySourceKey(hit.path, root))
        if (j !== undefined) add(i, j, { text: hit.content, startLine: hit.startLine, endLine: hit.endLine })
      }
    } catch (error) {
      checkDedupSignal(signal)
      throw jevServiceError(error)
    }
    if ((i + 1) % 25 === 0 || i + 1 === pages.length) log(`已检索 ${searched}/${pages.length} 页，得到 ${pairs.size} 对候选`)
  }
  const groups: DuplicateGroup[] = []
  const manualReview: string[] = []
  let judged = 0
  for (const { left, right, passages } of pairs.values()) {
    checkDedupSignal(signal)
    const a = pages[left]
    const b = pages[right]
    const [e1, e2] = await Promise.all([
      readPassage(paths[left], b, passages.get(left)), readPassage(paths[right], a, passages.get(right)),
    ])
    if (!e1 || !e2) {
      manualReview.push(`${a.path}、${b.path}：缺少可核对的现行原文。`)
      continue
    }
    let score: number
    try {
      score = await judgePair(root, config, e1, e2, signal)
    } catch (error) {
      checkDedupSignal(signal)
      throw jevServiceError(error)
    }
    if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error("决策服务返回了无效概率，请检查模型配置。")
    judged++
    const evidence = `${a.path} 第 ${e1.startLine}–${e1.endLine} 行：${e1.text}\n${b.path} 第 ${e2.startLine}–${e2.endLine} 行：${e2.text}`
    if (score >= 0.7) {
      groups.push({
        slugs: [a.slug, b.slug], confidence: score >= 0.9 ? "high" : "medium",
        reason: `JEV 身份复核 ${Math.round(score * 100)}%。\n${evidence}`,
      })
    } else if (score > 0.3) {
      manualReview.push(`身份判断不确定（${Math.round(score * 100)}%）。\n${evidence}`)
    }
  }
  checkDedupSignal(signal)
  return { groups, manualReview, coverage: `SAG 已检索 ${searched}/${pages.length} 页，JEV 已复核 ${judged}/${pairs.size} 对候选。` }
}
