import { describe, expect, it } from "vitest"
import { buildMemoryProjection } from "./memory-rebuild"
import type { ChapterSnapshot } from "./chapter-ingest"

function snap(
  chapterNumber: number,
  foreshadowingChanges: string[],
): ChapterSnapshot {
  return {
    chapterId: `ch-${chapterNumber}`,
    chapterNumber,
    summary: "",
    characters: [],
    locations: [],
    organizations: [],
    items: [],
    events: [],
    characterStateChanges: [],
    relationshipChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges,
    newCanonFacts: [],
    timelineEvents: [],
    conflicts: [],
    endingHook: "",
    graphNodes: [],
    graphEdges: [],
  }
}

describe("伏笔重放", () => {
  it("归并新增、无前缀推进及回收，保留稳定 ID 和人工备注", () => {
    const plant = snap(1, ["新增伏笔：旧车票交接凭证"])
    const advance = snap(2, ["旧车票交接凭证仍未核验"])
    const first = buildMemoryProjection([plant])
    first.foreshadows.items[0].notes = "人工备注"
    const next = buildMemoryProjection([plant, advance, snap(3, ["回收：旧车票交接凭证"])], undefined, first.foreshadows)
    expect(next.foreshadows.items).toEqual([expect.objectContaining({
      id: first.foreshadows.items[0].id, status: "resolved", notes: "人工备注", advancedChapters: [2], resolvedChapter: 3,
    })])
  })

  it("重复埋设视为推进，孤立回收入正式库，孤立推进和推测进入候选区", () => {
    const next = buildMemoryProjection([snap(1, ["新增：红色信笺", "推进：失踪名册"]), snap(2,
      ["新增：红色信笺", "新增：也许另有密函", "回收：锁匠的旧钥匙"])])
    expect(next.foreshadows.items.map((f) => f.status)).toEqual(["advanced", "resolved"])
    expect(next.candidates.foreshadows).toHaveLength(2)
  })
})
