import { verifyLegacyPages } from "./legacy-pages"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { bindStagingRoot, readFile, fileExists, projectedFiles } from "./filesystem.mjs"
import { normalizeChapterSnapshot } from "@/lib/novel/snapshot-format"
import { loadMemoryCleanupPolicy, filterRemovedMemories } from "@/lib/novel/memory-cleanup-policy"
import { isValidMemorySnapshot } from "@/lib/novel/memory-rebuild"
import { listChapterSources, refreshProjectMemory } from "@/lib/novel/refresh-memory"
import type { ChapterSnapshot } from "@/lib/novel/chapter-ingest"

export async function refreshStagedProject(stagingPath: string) {
  const project = await bindStagingRoot(stagingPath)
  const sources = await listChapterSources(project)
  const dir = join(project, ".qmai/novel/snapshots")
  const snapshots: ChapterSnapshot[] = []
  const policy = await loadMemoryCleanupPolicy(project)
  const chaptersOnDisk = [...sources.keys()]
  let hasSnapshotFile = false
  for (const name of await fileExists(dir) ? await readdir(dir) : []) {
    const match = /^(\d+)\.snapshot\.json$/.exec(name)
    if (!match) continue
    hasSnapshotFile = true
    const text = await readFile(join(dir, name))
    let raw: unknown
    try { raw = JSON.parse(text) }
    catch { throw new Error(`无法解析章节快照：${name}`) }
    const snapshot = normalizeChapterSnapshot(raw, { chapterNumber: Number(match[1]) })
    if (!snapshot || snapshot.chapterNumber !== Number(match[1])) throw new Error(`章节快照内容无效：${name}`)
    if (isValidMemorySnapshot(snapshot, chaptersOnDisk)) snapshots.push(filterRemovedMemories(snapshot, policy))
  }
  const hasPages = await verifyLegacyPages(project, snapshots)
  if (!hasSnapshotFile && !hasPages) {
    // Like a new book, a project with no extraction history has no derived files.
    const existing = [
      "migration-input", "QM/memory/writing-progress.md",
      ...["character-states", "foreshadowing-tracker", "timeline", "cognition-state"].map((name) => `.qmai/novel/${name}.json`),
    ]
    if (!(await Promise.all(existing.map((path) => fileExists(join(project, path))))).some(Boolean)) return projectedFiles()
  }
  await refreshProjectMemory(project, snapshots.sort((a, b) => a.chapterNumber - b.chapterNumber), { sources })
  return projectedFiles()
}
