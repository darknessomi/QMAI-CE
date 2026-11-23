import { beforeEach, describe, expect, it, vi } from "vitest"

const listDirectory = vi.fn()
const readFile = vi.fn()

vi.mock("@/commands/fs", () => ({
  listDirectory: (...args: unknown[]) => listDirectory(...args),
  readFile: (...args: unknown[]) => readFile(...args),
  fileExists: vi.fn(async () => false),
  writeFileAtomic: vi.fn(async () => undefined),
  createDirectory: vi.fn(async () => undefined),
}))

vi.mock("@/lib/search", () => ({
  searchWiki: vi.fn(),
}))

import { searchWiki } from "@/lib/search"
import { getAllDataSources } from "./context-data-sources"

const PROJECT = "C:/book"
const SNAPSHOTS_DIR = `${PROJECT}/.qmai/novel/snapshots`

function snapshotJson(chapterNumber: number, summary: string) {
  return JSON.stringify({
    chapterNumber,
    chapterId: `chapter-${chapterNumber}`,
    summary,
    endingHook: `第${chapterNumber}章结尾`,
    characters: [],
    locations: [],
    organizations: [],
    items: [],
    events: [],
    characterStateChanges: [`第${chapterNumber}章人物状态`],
    relationshipChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: [],
    newCanonFacts: [],
    timelineEvents: [],
    conflicts: [],
    graphNodes: [],
    graphEdges: [],
  })
}

const FILES: Record<string, string> = {
  [`${SNAPSHOTS_DIR}/001.snapshot.json`]: snapshotJson(1, "第1章摘要"),
  [`${SNAPSHOTS_DIR}/002.snapshot.json`]: snapshotJson(2, "第2章摘要"),
}

const CHAPTER_FILES: Record<string, string> = {
  [`${PROJECT}/wiki/chapters/001.md`]: "---\nchapter_number: 1\n---\n\n第一章正文\n",
  // 第 2 章被选中：AI 不读取
  [`${PROJECT}/wiki/chapters/002.md`]: "---\nchapter_number: 2\nai_exclude: true\n---\n\n第二章正文\n",
}

function load() {
  const source = getAllDataSources().find((item) => item.name === "snapshots")
  expect(source).toBeDefined()
  return source!
}

/*
 * 记忆快照与「选中（AI 不读取）」。
 *
 * 为什么这条必须存在：快照是从章节正文提炼出来的摘要/人物状态/结尾钩子，
 * 它**不带章节 id**，只按章号存放。正文那条链路排除了、这里没排除，
 * 用户就会看到"明明选中了，AI 还是知道这一章发生了什么"。
 */
describe("snapshots 数据源：跳过被选中章节的派生快照", () => {
  beforeEach(() => {
    listDirectory.mockReset()
    readFile.mockReset()
    vi.mocked(searchWiki).mockReset()

    listDirectory.mockImplementation(async (path: string) => {
      if (path === SNAPSHOTS_DIR) {
        return [
          { name: "001.snapshot.json", path: `${SNAPSHOTS_DIR}/001.snapshot.json`, is_dir: false },
          { name: "002.snapshot.json", path: `${SNAPSHOTS_DIR}/002.snapshot.json`, is_dir: false },
        ]
      }
      return []
    })
    readFile.mockImplementation(async (path: string) => FILES[path] ?? CHAPTER_FILES[path] ?? "")
    vi.mocked(searchWiki).mockImplementation(async (_projectPath, query) => {
      const chapterNumber = Number(String(query).replace("chapter_number:", ""))
      const path = `${PROJECT}/wiki/chapters/${String(chapterNumber).padStart(3, "0")}.md`
      return [{ path } as never]
    })
  })

  it("被选中章节的摘要不出现在最近摘要里，其余章节照常", async () => {
    const result = await load().load({
      projectPath: PROJECT,
      task: "写下一章",
      chapterNumber: 3,
      config: { recentSummaryWindow: 2, searchTopK: 5, snapshotLookback: 2, revisionFeedbackWindowConfig: null },
    })

    expect(result.recentSummaries.join("\n")).toContain("第1章摘要")
    expect(result.recentSummaries.join("\n")).not.toContain("第2章摘要")
    // 人物状态、时间线同源，必须一起被拦住
    expect(result.characterStates).not.toContain("第2章人物状态")
    // 上一章结尾钩子来自 lookback 的首个快照：第 2 章被排除后应回落到第 1 章
    expect(result.previousChapterEnding).not.toContain("第2章")
  })

  it("没有排除标记时两条摘要都在（不改变原有行为）", async () => {
    readFile.mockImplementation(async (path: string) => FILES[path]
      ?? (path.endsWith("002.md") ? "---\nchapter_number: 2\n---\n\n第二章正文\n" : CHAPTER_FILES[path] ?? ""))

    const result = await load().load({
      projectPath: PROJECT,
      task: "写下一章",
      chapterNumber: 3,
      config: { recentSummaryWindow: 2, searchTopK: 5, snapshotLookback: 2, revisionFeedbackWindowConfig: null },
    })

    expect(result.recentSummaries.join("\n")).toContain("第1章摘要")
    expect(result.recentSummaries.join("\n")).toContain("第2章摘要")
  })
})
