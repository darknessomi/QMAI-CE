import { deleteFile, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { hashTextHex } from "@/lib/text-hash"
import { splitSourceIntoSemanticChunks } from "@/lib/semantic-source-chunks"
import type { ChapterSnapshot } from "./chapter-ingest"
import { normalizeChapterSnapshot } from "./snapshot-format"

const lists = [
  "characters", "locations", "organizations", "items", "events", "characterStateChanges",
  "relationshipChanges", "knowledgeChanges", "foreshadowingChanges", "newCanonFacts",
  "timelineEvents", "conflicts", "graphNodes", "graphEdges",
] as const

function mergeDetails<T extends object>(previous?: Record<string, T>, next?: Record<string, T>) {
  if (!previous || !next) return next ?? previous
  return Object.fromEntries([...new Set([...Object.keys(previous), ...Object.keys(next)])].map(key => [
    key, { ...previous[key], ...Object.fromEntries(Object.entries(next[key] ?? {}).filter(([, v]) => v !== "")) } as T,
  ]))
}

function mergeParts(previous: ChapterSnapshot, next: ChapterSnapshot): ChapterSnapshot {
  const merged = { ...next }
  for (const key of lists) merged[key] = [...new Set([...previous[key], ...next[key]])]
  const aliases = new Map(Object.entries(previous.characterAliases ?? {}))
  for (const [name, values] of Object.entries(next.characterAliases ?? {})) {
    aliases.set(name, [...new Set([...(aliases.get(name) ?? []), ...values])])
  }
  merged.characterAliases = Object.fromEntries(aliases)
  merged.characterDetails = mergeDetails(previous.characterDetails, next.characterDetails)
  merged.locationDetails = mergeDetails(previous.locationDetails, next.locationDetails)
  merged.organizationDetails = mergeDetails(previous.organizationDetails, next.organizationDetails)
  merged.itemDetails = mergeDetails(previous.itemDetails, next.itemDetails)
  merged.eventDetails = mergeDetails(previous.eventDetails, next.eventDetails)
  merged.itemCategories = { ...previous.itemCategories, ...next.itemCategories }
  return merged
}

export interface MemoryExtraction {
  snapshot: ChapterSnapshot
  checkpointPath?: string
}

export async function finishMemoryExtraction(checkpointPath?: string): Promise<void> {
  if (checkpointPath) await deleteFile(checkpointPath).catch(() => undefined)
}

export async function extractMemoryInParts(options: {
  source: string
  budget: number
  projectPath: string
  sourceKey: string
  requestKey: string
  signal?: AbortSignal
  extract: (body: string, instructions: string) => Promise<ChapterSnapshot>
}): Promise<MemoryExtraction> {
  const { source, budget, signal, extract } = options
  signal?.throwIfAborted()
  if (source.length <= budget) return { snapshot: await extract(source, "") }

  const parts: string[] = []
  for (const chunk of splitSourceIntoSemanticChunks(source, budget, 0)) {
    // The semantic splitter permits a slightly oversized paragraph or heading.
    for (let start = 0; start < chunk.main.length;) {
      let end = Math.min(start + budget, chunk.main.length)
      if (end < chunk.main.length && /[\uD800-\uDBFF]/.test(chunk.main[end - 1])) end--
      parts.push(chunk.main.slice(start, end))
      start = end
    }
  }
  if (!parts.length) throw new Error("正文为空，无法提取记忆")
  const signature = hashTextHex(JSON.stringify([1, options.sourceKey, options.requestKey, budget, source]))
  const path = `${options.projectPath}/.qmai/novel/extraction-progress/${signature}.json`
  let completed = 0
  let merged: ChapterSnapshot | null = null
  if (await fileExists(path)) {
    const contents = await readFile(path)
    try {
      const saved = JSON.parse(contents)
      if (saved.signature === signature && Number.isInteger(saved.completed)
        && saved.completed > 0 && saved.completed <= parts.length) {
        merged = normalizeChapterSnapshot(saved.snapshot)
        if (merged?.summary) completed = saved.completed
        else merged = null
      }
    } catch { /* An incomplete checkpoint is disposable. The source is authoritative. */ }
  }
  for (let i = completed; i < parts.length; i++) {
    signal?.throwIfAborted()
    const instructions = `\n\n这是原文第 ${i + 1}/${parts.length} 段。只提取本段出现的事实。summary 结合此前摘要写成截至本段的累计摘要；endingHook 只记录本段末尾。此前摘要：${merged?.summary ?? "无"}`
    const next = await extract(parts[i], instructions)
    signal?.throwIfAborted()
    if (!next.summary.trim()) throw new Error(`第 ${i + 1} 段未返回摘要，请重试提取`)
    merged = merged ? mergeParts(merged, next) : next
    await writeFileAtomic(path, JSON.stringify({ signature, completed: i + 1, snapshot: merged }))
  }
  if (!merged) throw new Error("未获得记忆快照")
  return { snapshot: merged, checkpointPath: path }
}
