import { fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { fetchEmbeddings } from "./embedding"
import { hashEmbeddingText } from "./embedding-batch"
import { normalizePath } from "./path-utils"
import type { EmbeddingConfig } from "@/stores/wiki-store"
import type { EntitySummary } from "./dedup"

const MAX_VECTOR_PAGES = 5_000
const NEIGHBORS = 8
const SIMILARITY_THRESHOLD = 0.68
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
type CacheRow = { hash: string; data: string }

function packVector(vector: Float32Array): string {
  const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
  let binary = ""
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192))
  }
  return btoa(binary)
}

function unpackVector(data: string): Float32Array | null {
  try {
    const binary = atob(data)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const vector = new Float32Array(bytes.buffer)
    return vector.length && vector.every(Number.isFinite) ? vector : null
  } catch {
    return null
  }
}

function normalizedVector(raw: number[] | null): Float32Array | null {
  if (!raw?.length) return null
  let norm = 0
  for (const value of raw) norm += value * value
  if (!Number.isFinite(norm) || norm <= 0) return null
  const length = Math.sqrt(norm)
  return Float32Array.from(raw, (value) => value / length)
}

// fetchEmbeddings 由多个功能共享。取消等待时，已发出的 HTTP 请求由共享客户端收尾。
function fetchScanEmbeddings(texts: string[], config: EmbeddingConfig, signal?: AbortSignal) {
  return waitForDedupResult(() => fetchEmbeddings(texts, config), signal)
}

async function summaryVectors(
  projectPath: string, pages: EntitySummary[], config: EmbeddingConfig,
  log: (text: string) => void, signal?: AbortSignal,
) {
  const path = `${normalizePath(projectPath)}/.qmai/dedup-summary-vectors.json`
  const configHash = hashEmbeddingText(JSON.stringify([config.endpoint.trim(), config.model.trim(), config.outputDimensionality]))
  let previous: Record<string, CacheRow> = {}
  try {
    if (await fileExists(path)) {
      const cache = JSON.parse(await readFile(path))
      if (cache?.version === 1 && cache.configHash === configHash && cache.rows && typeof cache.rows === "object") previous = cache.rows
    }
  } catch { /* 缓存损坏或不存在时按原始摘要重新计算。 */ }
  checkDedupSignal(signal)
  const rows: Record<string, CacheRow> = Object.create(null)
  const vectors: (Float32Array | null)[] = Array(pages.length).fill(null)
  const missing: { index: number; hash: string; text: string }[] = []
  pages.forEach((page, index) => {
    const text = [page.slug, page.title, ...(page.aliases ?? []), ...page.tags, page.description].filter(Boolean).join("\n")
    const hash = hashEmbeddingText(text)
    const entry = previous[page.path]
    if (entry?.hash === hash && typeof entry.data === "string") vectors[index] = unpackVector(entry.data)
    if (vectors[index]) rows[page.path] = entry
    else missing.push({ index, hash, text })
  })
  const reused = pages.length - missing.length
  log(`摘要向量缓存命中 ${reused}/${pages.length} 页，需要计算 ${missing.length} 页`)
  // 以小批为取消边界，复用向量客户端的多文本请求、统一并发上限和退避。
  for (let start = 0; start < missing.length; start += 256) {
    checkDedupSignal(signal)
    const batch = missing.slice(start, start + 256)
    const raw = await fetchScanEmbeddings(batch.map((entry) => entry.text), config, signal)
    checkDedupSignal(signal)
    batch.forEach(({ index, hash }, offset) => {
      const vector = normalizedVector(raw[offset])
      if (!vector) return
      vectors[index] = vector
      rows[pages[index].path] = { hash, data: packVector(vector) }
    })
    log(`已处理向量 ${reused + start + batch.length}/${pages.length} 页`)
  }
  if (missing.length || Object.keys(previous).length !== pages.length) {
    try {
      await writeFileAtomic(path, JSON.stringify({ version: 1, configHash, rows }))
    } catch {
      log("摘要向量缓存写入失败，本次检测继续")
    }
  }
  return vectors
}

function insertNeighbor(top: { index: number; score: number }[], index: number, score: number) {
  if (top.length === NEIGHBORS && top[top.length - 1].score >= score) return
  let pos = top.length
  while (pos && top[pos - 1].score < score) pos--
  top.splice(pos, 0, { index, score })
  if (top.length > NEIGHBORS) top.pop()
}

// 先单位化，每对向量只算一次点积，两端分别维护最多八个近邻。
async function nearestPairs(vectors: (Float32Array | null)[], signal?: AbortSignal): Promise<Pair[]> {
  const top = vectors.map((): { index: number; score: number }[] => [])
  let lastYield = performance.now()
  for (let i = 0; i < vectors.length; i++) {
    if (performance.now() - lastYield >= 12) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      lastYield = performance.now()
    }
    checkDedupSignal(signal)
    const left = vectors[i]
    if (!left) continue
    for (let j = i + 1; j < vectors.length; j++) {
      const right = vectors[j]
      if (!right || left.length !== right.length) continue
      let score = 0
      for (let dim = 0; dim < left.length; dim++) score += left[dim] * right[dim]
      if (score < SIMILARITY_THRESHOLD) continue
      insertNeighbor(top[i], j, score)
      insertNeighbor(top[j], i, score)
    }
  }
  return top.flatMap((neighbors, i) => neighbors.map(({ index }): Pair => [i, index]))
}

export function namePairs(pages: EntitySummary[]): Pair[] {
  const firstByName = new Map<string, number>()
  const pairs: Pair[] = []
  pages.forEach((page, index) => {
    for (const name of [page.title, page.slug, ...(page.aliases ?? [])]) {
      const key = name.normalize("NFKC").toLowerCase().replace(/[\s_-]+/g, "")
      if (!key) continue
      const first = firstByName.get(key)
      if (first === undefined) firstByName.set(key, index)
      else if (first !== index) pairs.push([first, index])
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

export async function buildDetectionBatches(
  projectPath: string, pages: EntitySummary[], config: EmbeddingConfig | null | undefined,
  excluded: string[][], log: (text: string) => void, signal?: AbortSignal,
): Promise<{ batches: EntitySummary[][]; coverage: string }> {
  const named = namePairs(pages)
  if (config?.enabled && config.endpoint?.trim() && config.model?.trim()) {
    const subset = pages.slice(0, MAX_VECTOR_PAGES)
    let vectors: (Float32Array | null)[] = []
    try { vectors = await summaryVectors(projectPath, subset, config, log, signal) }
    catch { checkDedupSignal(signal); log("向量服务不可用，切换到分批检测") }
    // 不混用不同维度的向量，异常的页也需要进入回退检测。
    const dimensionCounts = new Map<number, number>()
    for (const v of vectors) if (v) dimensionCounts.set(v.length, (dimensionCounts.get(v.length) ?? 0) + 1)
    const [dimension, valid] = [...dimensionCounts].sort((a, b) => b[1] - a[1])[0] ?? [0, 0]
    const coverage = `摘要向量覆盖 ${valid}/${pages.length} 页`
    log(coverage)
    if (valid >= 2 && valid >= subset.length * 0.8) {
      const normalized = vectors.map(v => v?.length === dimension ? v : null)
      const pairs = await nearestPairs(normalized, signal)
      const fallbackAll = !pairs.length && pages.length <= 250
      const uncovered = new Set(pages.filter((_, i) => !normalized[i]).map((p) => p.path))
      const windows = fallbackAll || uncovered.size ? windowBatches(pages).filter(
        (batch) => fallbackAll || batch.some((page) => uncovered.has(page.path)),
      ) : []
      return {
        batches: [...windows, ...pairBatches(pages, [...named, ...pairs], excluded, windows)],
        coverage: `${coverage}，候选由相似度和名称筛选${windows.length ? "，已补充分批检测" : ""}`,
      }
    }
    const windows = windowBatches(pages)
    return { batches: [...windows, ...pairBatches(pages, named, excluded, windows)], coverage: `${coverage}，已对全部摘要分批检测` }
  }
  const windows = windowBatches(pages)
  return { batches: [...windows, ...pairBatches(pages, named, excluded, windows)], coverage: `按名称和别名对 ${pages.length} 页分批检测` }
}
