import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = readFileSync(resolve(__dirname, "chapter-ingest.ts"), "utf8")

describe("chapter ingest draft boundary", () => {
  it("keeps draft ingestion opt-in so existing final-only flows do not change", () => {
    expect(source).toContain("interface IngestChapterOptions")
    expect(source).toContain("allowDraft?: boolean")
    expect(source).toContain("options: IngestChapterOptions = {}")
    expect(source).toContain("if (!options.allowDraft && !isFinalChapter(fm))")
    expect(source).toContain('return logFail("not_final", "章节不是正式稿")')
  })

  it("writes extract failures to .qmai/chapter-ingest.log and returns error", () => {
    expect(source).toContain("appendChapterIngestLog")
    expect(source).toContain('event: "fail"')
    expect(source).toContain('event: "start"')
    expect(source).toContain('event: "ok"')
    expect(source).toContain("failReason, error: message")
  })

  it("does not persist a snapshot before syncSnapshotToMemory", () => {
    const ingestFn = source.slice(
      source.indexOf("export async function ingestChapter"),
      source.indexOf("function normalizeOutlineIngestError"),
    )
    const saveBeforeSync = ingestFn.indexOf("await saveSnapshot(")
    const syncCall = ingestFn.indexOf("await syncSnapshotToMemoryUnlocked(")
    expect(syncCall).toBeGreaterThan(0)
    expect(saveBeforeSync).toBe(-1)
  })
})

/**
 * 这些名字曾经每摄入一章就写一次盘，但全仓库没有任何读取方。
 * 它们不是「暂时没人用」——查过 TS/Rust/脚本/快照查看器四条路径都没有读者，
 * 并且唯一读 .output.json 的 story-extractor 只用 wikiUpdatePatch.entries。
 * 这里钉死它们不会被无意中加回来（加回来等于每章多写两个没人读的文件）。
 */
describe("chapter ingest 不写无人读取的派生产物", () => {
  it("不再写搜索索引 / 向量索引文件", () => {
    expect(source).not.toContain(".search-index.json")
    expect(source).not.toContain(".vector-index.json")
    // 仍然写这两个：wiki-patch 被图谱与 story-extractor 读，output 被 story-extractor 读
    expect(source).toContain(".wiki-patch.json")
    expect(source).toContain(".output.json")
  })

  it("不再维护 entityIsNew（只写不读的逐实体标志位）", () => {
    expect(source).not.toContain("entityIsNew")
    expect(source).not.toContain("normalizeEntityFlags")
    // 但「新实体」这条校验警告必须保留：它会渲染进 .snapshot.md 给人看
    expect(source).toContain('type: "entity_new"')
  })
})

/*
 * 「选中（AI 不读取）」在摄取层的底线。
 *
 * 界面按钮、一键提取、MCP 三处都在**调用方**自觉；这里是**被调用方**的底线，
 * 将来新加入口（导入后自动提取、批量脚本、新 Agent 工具）也绕不过。
 */
describe("chapter ingest 拒绝读取被选中的文档", () => {
  it("章节：读到 ai_exclude 就直接返回失败原因", () => {
    expect(source).toContain("if (isAiExcluded(fm)) {")
    expect(source).toContain('return logFail("ai_excluded"')
  })

  it("大纲：同一道底线（一键提取 / 生成后自动摄取都走这里）", () => {
    const outlineFn = source.slice(source.indexOf("export async function ingestOutline"))
    expect(outlineFn).toContain("if (isAiExcludedContent(content)) return emptyResult(null, \"ai_excluded\")")
  })

  it("失败原因是闭合联合的一员，调用方能区分「被排除」和「模型没配」", () => {
    expect(source).toContain('"cancelled" | "ai_excluded"')
    expect(source).toContain('failureReason?: "no_llm" | "ai_excluded" | null')
  })
})
