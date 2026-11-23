import { describe, expect, it } from "vitest"
import type { ChapterSnapshot } from "./chapter-ingest"
import {
  buildMemoryProjection,
  buildStructuredMemoryDocuments,
  isValidMemorySnapshot,
  looksLikeStableNovelEntityLabel,
} from "./memory-rebuild"

function makeSnapshot(partial: Partial<ChapterSnapshot>): ChapterSnapshot {
  return {
    chapterId: partial.chapterId ?? `chapter-${partial.chapterNumber ?? 1}`,
    chapterNumber: partial.chapterNumber ?? 1,
    summary: partial.summary ?? "",
    characters: partial.characters ?? [],
    locations: partial.locations ?? [],
    organizations: partial.organizations ?? [],
    items: partial.items ?? [],
    events: partial.events ?? [],
    characterStateChanges: partial.characterStateChanges ?? [],
    relationshipChanges: partial.relationshipChanges ?? [],
    knowledgeChanges: partial.knowledgeChanges ?? [],
    foreshadowingChanges: partial.foreshadowingChanges ?? [],
    newCanonFacts: partial.newCanonFacts ?? [],
    timelineEvents: partial.timelineEvents ?? [],
    conflicts: partial.conflicts ?? [],
    endingHook: partial.endingHook ?? "",
    graphNodes: partial.graphNodes ?? [],
    graphEdges: partial.graphEdges ?? [],
  }
}

describe("memory-rebuild", () => {
  it("只接受有效章节范围内的快照", () => {
    expect(isValidMemorySnapshot(makeSnapshot({ chapterNumber: 0 }), [1, 2, 3])).toBe(false)
    expect(isValidMemorySnapshot(makeSnapshot({ chapterNumber: 10 }), [1, 2, 3])).toBe(false)
    expect(isValidMemorySnapshot(makeSnapshot({ chapterNumber: 7 }), [1, 2, 3])).toBe(true)
    expect(isValidMemorySnapshot({ ...makeSnapshot({}), isHistorical: true }, [1])).toBe(false)
    expect(isValidMemorySnapshot({ ...makeSnapshot({}), sourceType: "outline" }, [1])).toBe(false)
  })

  it("会把不确定内容写入候选区，并过滤泛化人物状态", () => {
    const documents = buildStructuredMemoryDocuments([
      makeSnapshot({
        chapterNumber: 2,
        characters: ["杨寒", "307号女孩"],
        characterStateChanges: ["杨寒：仍在追查白塔", "307号女孩：短暂清醒"],
        knowledgeChanges: ["杨寒知道1849仍存活", "杨寒可能已经见过白塔诱导室"],
        foreshadowingChanges: ["新增伏笔：白塔地下诱导室"],
        newCanonFacts: ["白塔旧院地下存在诱导室"],
        timelineEvents: ["深夜：杨寒返回白塔旧院"],
        conflicts: ["杨寒与编号派的冲突升级"],
      }),
    ])

    expect(documents["character-states.md"]).toContain("### 杨寒")
    expect(documents["character-states.md"].split("## 候选区")[0]).not.toContain("307号女孩")
    expect(documents["character-states.md"].split("## 候选区")[1]).toContain("307号女孩")
    expect(documents["character-cognition.md"]).toContain("## 候选区")
    expect(documents["character-cognition.md"]).toContain("杨寒可能已经见过白塔诱导室")
  })

  it("别名归一、同章事件去重、歧义推进与推测留在候选区", () => {
    const s = makeSnapshot({
      characterStateChanges: ["阿青：已离开"], timelineEvents: ["上午：出发", "上午: 出发", "可能返家"],
      foreshadowingChanges: ["新增：印着黑塔的密函甲", "新增：印着黑塔的密函乙", "推进：印着黑塔的密函"],
    })
    s.characterAliases = { 苏青雨: ["阿青"] }
    const memory = buildMemoryProjection([s])
    expect(memory.characters.characters.map((p) => p.characterName)).toEqual(["苏青雨"])
    expect(memory.timeline).toHaveLength(1)
    expect(memory.foreshadows.items.map((f) => f.status)).toEqual(["planted", "planted"])
    expect(memory.candidates.foreshadows).toHaveLength(1)
    expect(memory.officialSnapshots[0].timelineEvents).toEqual(["上午：出发"])
    expect(memory.officialSnapshots[0].foreshadowingChanges).toHaveLength(2)
  })

  it("旧章删改再重放保留明确人工状态和配置，并保留伏笔ID", () => {
    const first = makeSnapshot({ characterStateChanges: ["楚白：住在旧宅"], foreshadowingChanges: ["新增：第一把钥匙", "新增：第二把钥匙"] })
    const old = buildMemoryProjection([first])
    old.characters.characters[0].status = "作者手改"
    old.characters.characters[0].equipment = ["玉简"]
    const kept = old.foreshadows.items[1]
    kept.notes = "作者约定"
    const next = buildMemoryProjection([{ ...first, characterStateChanges: ["楚白：进城"], foreshadowingChanges: ["新增：第二把钥匙"] }], old.characters, old.foreshadows)
    expect(next.characters.characters[0]).toMatchObject({ status: "作者手改", equipment: ["玉简"], generatedStatus: "进城" })
    expect(next.foreshadows.items).toHaveLength(1)
    expect(next.foreshadows.items[0]).toMatchObject({ id: kept.id, notes: "作者约定" })
  })

  it("会拦住句子型事件，只保留稳定命名事件", () => {
    expect(looksLikeStableNovelEntityLabel("event", "黑雨之夜")).toBe(true)
    expect(looksLikeStableNovelEntityLabel("event", "编号派试图以人格压缩和编号接管保全文明")).toBe(false)
    expect(looksLikeStableNovelEntityLabel("event", "1849在被广播点名时仍能以编号应答，说明其认知已遭诱导重塑。")).toBe(false)
  })
})
