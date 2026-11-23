import { isActiveForeshadowingStatus } from "./foreshadowing-normalize"
import type { ChapterSnapshot } from "./chapter-ingest"
import type { ForeshadowingStore } from "./foreshadowing-tracker"
import type { WritingProgress } from "./tracking-types"

export function buildWritingProgress(
  snapshots: ChapterSnapshot[],
  foreshadows: ForeshadowingStore,
  previous?: WritingProgress | null,
): WritingProgress {
  const latest = snapshots.reduce<ChapterSnapshot | undefined>((last, snapshot) =>
    snapshot.chapterNumber > (last?.chapterNumber ?? 0) ? snapshot : last, undefined)
  const active = foreshadows.items.filter((f) => isActiveForeshadowingStatus(f.status))
  return {
    lastCompletedChapter: latest?.chapterNumber ?? 0,
    lastCompletedChapterTitle: latest?.chapterTitle || "",
    lastUpdated: foreshadows.lastUpdated || previous?.lastUpdated || "",
    currentArc: previous?.currentArc ?? (latest ? "进行中" : "尚未开始"),
    activeForeshadowingCount: active.length,
    keyPendingForeshadowing: active.slice(0, 5).map((f) => f.name),
    relationshipStatus: previous?.relationshipStatus ?? "",
    nextChapterGuidance: previous?.nextChapterGuidance ?? "",
    notes: previous?.notes ?? [],
  }
}
