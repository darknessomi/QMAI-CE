import { createDirectory, deleteFile, fileExists, listDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { mapWithConcurrency } from "@/lib/async-pool"
import { parseFrontmatter } from "@/lib/frontmatter"
import { isChapterPage, parseChapterNumber } from "./chapter-meta"
import { normalizePath } from "@/lib/path-utils"
import type { ChapterSnapshot } from "./chapter-ingest"
import type { CharacterStateStore } from "./character-state"
import { emptyCognitionState, mergeCognitionFromSnapshot, saveCognitionState } from "./character-cognition"
import type { ForeshadowingStore } from "./foreshadowing-tracker"
import type { MemoryField } from "./memory-cleanup-policy"
import type { TimelineEntry } from "./timeline"
import { buildMemoryProjection, buildStructuredMemoryDocuments, isValidMemorySnapshot } from "./memory-rebuild"
import { RetrievalStore } from "./retrieval"
import { progressPath, readContextMd, serializeContextMd } from "./tracking-files"
import { buildWritingProgress } from "./tracking-updater"

export interface ChapterSource {
  filePath: string
  sourceHash?: string
  title?: string
}

export async function listChapterSources(pp: string): Promise<Map<number, ChapterSource>> {
  const dir = `${pp}/wiki/chapters`
  const sources = new Map<number, ChapterSource>()
  if (!await fileExists(dir)) return sources
  const nodes = [...await listDirectory(dir)]
  const files: typeof nodes = []
  for (const node of nodes) {
    if (node.is_dir) nodes.push(...(node.children ?? []))
    else if (node.name.endsWith(".md")) files.push(node)
  }
  const chapters = await mapWithConcurrency(files, 12, async (node) => {
    const { frontmatter } = parseFrontmatter(await readFile(node.path))
    if (!frontmatter || !isChapterPage(frontmatter)) return null
    const number = parseChapterNumber(frontmatter.chapter_number)
    return number === null ? null : { number, title: typeof frontmatter.title === "string" ? frontmatter.title : undefined }
  })
  chapters.forEach((chapter, index) => {
    if (chapter) sources.set(chapter.number, { filePath: normalizePath(files[index].path).slice(pp.length + 1), title: chapter.title })
  })
  return sources
}

export function createRetrievalStore(projectPath: string): RetrievalStore {
  return new RetrievalStore(projectPath, {
    readFile, writeFile: writeFileAtomic, fileExists, deleteFile, createDirectory,
    listDirectory: async (path) => (await listDirectory(path)).map((node) => node.name),
    joinPath: (...parts) => parts.join("/"),
  })
}

async function readPrevious<T>(path: string): Promise<T | undefined> {
  return await fileExists(path) ? JSON.parse(await readFile(path)) as T : undefined
}

/** Caller holds the project write lock (or owns the offline staging directory). */
export async function refreshProjectMemory(
  projectPath: string,
  validSnapshots: ChapterSnapshot[],
  options: { sources?: ReadonlyMap<number, ChapterSource>; fields?: readonly MemoryField[] } = {},
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const dir = `${pp}/.qmai/novel`
  const memoryDir = `${pp}/wiki/memory`
  const snapshots = validSnapshots.filter((s) => isValidMemorySnapshot(s, []))
    .map((s) => s.chapterTitle ? s : { ...s, chapterTitle: options.sources?.get(s.chapterNumber)?.title })
    .sort((a, b) => a.chapterNumber - b.chapterNumber)
  const charPath = `${dir}/character-states.json`
  const foreshadowPath = `${dir}/foreshadowing-tracker.json`
  const previousCharacters = await readPrevious<CharacterStateStore>(charPath)
  const previousForeshadows = await readPrevious<ForeshadowingStore>(foreshadowPath)
  const previousProgress = await readContextMd(pp)
  const projection = buildMemoryProjection(snapshots, previousCharacters, previousForeshadows)
  const refresh = (field: MemoryField) => !options.fields || options.fields.includes(field)
  if (!refresh("characterStateChanges") && previousCharacters) projection.characters = previousCharacters
  if (!refresh("foreshadowingChanges") && previousForeshadows) projection.foreshadows = previousForeshadows
  const timelinePath = `${dir}/timeline.json`
  const previousTimeline = await readPrevious<{ entries: TimelineEntry[] }>(timelinePath)
  if (previousTimeline) {
    if (!refresh("timelineEvents")) projection.timeline = previousTimeline.entries
    else for (const entry of previousTimeline.entries.filter((item) => item.manual)) {
      const same = projection.timeline.find((item) => item.chapterNumber === entry.chapterNumber && item.event === entry.event)
      if (same) same.manual = true
      else projection.timeline.push(entry)
    }
  }
  const docs = buildStructuredMemoryDocuments(snapshots, projection)
  const progress = buildWritingProgress(snapshots, projection.foreshadows, previousProgress)
  await createDirectory(dir)
  await createDirectory(memoryDir)
  if (refresh("knowledgeChanges")) {
    await saveCognitionState(pp, snapshots.reduce(mergeCognitionFromSnapshot, emptyCognitionState()))
  }
  if (refresh("characterStateChanges") || !previousCharacters) await writeFileAtomic(charPath, JSON.stringify(projection.characters, null, 2))
  if (refresh("foreshadowingChanges") || !previousForeshadows) await writeFileAtomic(foreshadowPath, JSON.stringify(projection.foreshadows, null, 2))
  if (refresh("timelineEvents") || !await fileExists(timelinePath)) await writeFileAtomic(timelinePath, JSON.stringify({
    version: 1, entries: projection.timeline, serial: projection.timeline.length, updatedAt: projection.characters.lastUpdated,
  }, null, 2))
  const paths = []
  for (const [name, doc] of Object.entries(docs)) {
    const path = `${memoryDir}/${name}`
    await writeFileAtomic(path, doc)
    paths.push(path)
  }
  await writeFileAtomic(progressPath(pp), serializeContextMd(progress))
  await createRetrievalStore(pp).buildFromSnapshots(projection.officialSnapshots,
    (s) => options.sources?.get(s.chapterNumber)?.filePath ?? "",
    (s) => s.sourceHash ?? options.sources?.get(s.chapterNumber)?.sourceHash ?? "")
  return paths
}
