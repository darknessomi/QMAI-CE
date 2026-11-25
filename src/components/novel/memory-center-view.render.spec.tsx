// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MemoryCenterData, MemoryCenterSnapshotCard } from "@/lib/novel/memory-center"
import { normalizeChapterSnapshot } from "@/lib/novel/snapshot-format"
import { useWikiStore } from "@/stores/wiki-store"

const hoisted = vi.hoisted(() => ({
  loadMemoryCenterData: vi.fn(),
  fileExists: vi.fn(),
  rebuild: vi.fn(),
  loadSnapshot: vi.fn(),
  syncSnapshotToMemory: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  fileExists: hoisted.fileExists,
  readFile: hoisted.readFile,
  writeFile: hoisted.writeFile,
  deleteFile: hoisted.deleteFile,
}))
vi.mock("@/lib/novel/chapter-ingest", () => ({
  finalizeProjectMemoryRebuild: hoisted.rebuild,
  loadSnapshot: hoisted.loadSnapshot,
  listSnapshotHistory: async () => [],
  syncSnapshotToMemory: hoisted.syncSnapshotToMemory,
}))
vi.mock("@/lib/novel/memory-center", () => ({
  loadMemoryCenterData: hoisted.loadMemoryCenterData,
}))
vi.mock("@/components/editor/wiki-reader", () => ({
  WikiReader: ({ body }: { body: string }) => <div data-testid="wiki-reader">{body}</div>,
}))

import { MemoryCenterView } from "./memory-center-view"
// 用真实 i18n 初始化，标签就按用户看到的中文断言；否则 t() 只会回显键名，
// 「统计条写的是快照总数」这类断言就变成在比较键名，失去意义。
import "@/i18n"

let host: HTMLDivElement
let root: Root

const PROJECT = { id: "p1", name: "测试小说", path: "E:/Novel" }

function makeCard(chapterNumber: number, chapterTitle?: string): MemoryCenterSnapshotCard {
  return {
    chapterNumber,
    chapterTitle,
    summary: `摘要 ${chapterNumber}`,
    endingHook: "",
    memorySynced: false,
    snapshotPath: `.qmai/novel/snapshots/${chapterNumber}.snapshot.json`,
    characterStateChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: [],
    timelineEvents: [],
    hasMoreCharacterStateChanges: false,
    hasMoreKnowledgeChanges: false,
    hasMoreForeshadowingChanges: false,
    hasMoreTimelineEvents: false,
  }
}

function makeData(): MemoryCenterData {
  return {
    stats: {
      // 章节+大纲总数，故意与「章节快照」标签的条数不同，用来钉住不能混用
      snapshotCount: 5,
      syncedSnapshotCount: 2,
      characterCount: 3,
      activeForeshadowingCount: 1,
      memoryFileCount: 1,
    },
    snapshots: [makeCard(4), makeCard(2), makeCard(-7, "总大纲"), makeCard(-3, "人物小传"), makeCard(-9, "力量体系")],
    allChapterNumbers: [4, 2],
    files: [
      {
        key: "character-states",
        title: "character-states",
        path: "E:/Novel/wiki/memory/character-states.md",
        sections: [{ title: "主角", items: ["许七安：警觉"], groups: [] }],
      },
    ],
  }
}

async function render() {
  await act(async () => { root.render(<MemoryCenterView />) })
  // loadMemoryCenterData 是异步的，等它落地
  await act(async () => { await Promise.resolve() })
}

const tabs = () =>
  [...host.querySelectorAll<HTMLElement>('[data-ui="memory-tab"]')]

const tabByLabel = (label: string) =>
  tabs().find((tab) => tab.textContent?.includes(label))

async function clickTab(label: string) {
  const tab = tabByLabel(label)
  expect(tab, `标签「${label}」应当存在`).toBeTruthy()
  await act(async () => { tab!.click() })
}

beforeEach(() => {
  vi.clearAllMocks()
  useWikiStore.setState({ project: PROJECT })
  hoisted.loadMemoryCenterData.mockResolvedValue(makeData())
  hoisted.fileExists.mockResolvedValue(false)
  hoisted.readFile.mockImplementation(async (path: string) => `# ${path}\n\n正文内容`)
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe("记忆中心：单页结构", () => {
  it("页面打开后才发生刷新失败，点击刷新仍会从现存快照补写", async () => {
    await render()
    hoisted.fileExists.mockResolvedValue(true)
    const refresh = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("刷新"))
    expect(refresh).toBeDefined()
    await act(async () => { refresh!.click() })
    await vi.waitFor(() => expect(hoisted.rebuild).toHaveBeenCalledWith(PROJECT.path))
  })
  it("渲染 8 个标签，顺序为两类快照在前、6 个记忆文件在后", async () => {
    await render()
    expect(tabs().map((tab) => tab.getAttribute("data-tab-key"))).toEqual([
      "snapshots",
      "outline-snapshots",
      "character-states",
      "character-cognition",
      "foreshadowing-tracker",
      "timeline",
      "canon-facts",
      "conflicts",
    ])
  })

  it("不再渲染中间栏式的分类列表，也没有「先选一个项目」的占位", async () => {
    await render()
    expect(host.textContent).not.toContain("请先从左侧记忆列表选择一个项目")
    expect(host.querySelectorAll("button").length).toBeGreaterThan(0)
  })

  it("派生记忆页只展示正文，修改入口指向来源快照", async () => {
    hoisted.readFile.mockResolvedValue("---\ntype: structured-memory\n---\n# 正式记忆")
    await render()
    await clickTab("人物状态")
    const detail = host.querySelector('[data-ui="memory-detail"]')
    expect(detail?.textContent).toContain("编辑对应章节")
    expect(detail?.textContent).toContain("正式记忆")
    expect(detail?.textContent).not.toContain("structured-memory")
    expect(detail?.querySelector("button, textarea")).toBeNull()
  })

  it("打开旧版 Markdown 快照时略去图谱段，保留人物关系、代码示例和校验警告", async () => {
    const story = ["# 第4章", "## 人物关系变化", "- 两人达成合作", "```text", "## 图谱节点", "这里是原文示例", "```"]
    const warnings = ["## 校验警告", "- 核对称谓"]
    hoisted.readFile.mockResolvedValue([...story, "## 图谱节点", "- 人物:甲", "## 图谱关系边", "- 甲->合作->乙", ...warnings].join("\r\n"))
    await render()
    const open = [...host.querySelectorAll("button")].find(button => button.textContent === "查看记忆")!
    await act(async () => { open.click() })
    expect(host.querySelector('[data-testid="wiki-reader"]')?.textContent).toBe([...story, ...warnings].join("\n"))
    expect(hoisted.writeFile).not.toHaveBeenCalled()
  })

  it("查看和编辑章节快照时隐藏图谱栏，保存其他记忆时保留原始关系数据", async () => {
    const graph = { graphNodes: ["人物:甲"], graphEdges: ["甲->合作->乙"] }
    hoisted.loadSnapshot.mockResolvedValue(normalizeChapterSnapshot({
      chapterNumber: 4, summary: "本章摘要", relationshipChanges: ["两人达成合作"], ...graph,
    }))
    hoisted.syncSnapshotToMemory.mockResolvedValue({ memorySyncedAt: "2026-01-01", writtenEntityPaths: [] })
    await render()
    const card = host.querySelector('[data-ui="memory-snapshot"]')!
    await act(async () => { [...card.querySelectorAll("button")].find(b => b.textContent === "编辑")!.click() })
    const dialog = () => host.querySelector<HTMLElement>(".fixed.inset-0")!
    const clickDialog = async (label: string) => {
      const button = [...dialog().querySelectorAll("button")].find(b => b.textContent?.includes(label))!
      await act(async () => { button.click() })
    }
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("两人达成合作"))
    expect(dialog().textContent).not.toMatch(/图谱节点|图谱关系边|人物:甲|甲->合作->乙/)
    await clickDialog("JSON 详情")
    expect(JSON.parse(dialog().querySelector("pre")!.textContent!)).toMatchObject({ summary: "本章摘要" })
    expect(dialog().querySelector("pre")!.textContent).not.toMatch(/graphNodes|graphEdges/)
    await clickDialog("编辑")
    expect(dialog().textContent).not.toMatch(/图谱节点|图谱关系边/)
    const fields = [...dialog().querySelectorAll("textarea")]
    const values = fields.map(field => field.value)
    expect(values).not.toContain(graph.graphNodes[0])
    expect(values).not.toContain(graph.graphEdges[0])
    const summary = fields.find(field => field.value === "本章摘要")!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(summary, "修订后的摘要")
      summary.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await clickDialog("保存")
    expect(hoisted.syncSnapshotToMemory).toHaveBeenCalledWith(PROJECT.path, expect.objectContaining({
      summary: "修订后的摘要", ...graph,
    }))
  })

  it("每个标签都带计数，且两种快照的计数各算各的", async () => {
    await render()
    // 章节快照 2 条、大纲快照 3 条 —— 不能都显示 stats.snapshotCount(5)
    expect(tabByLabel("章节快照")?.textContent).toContain("2")
    expect(tabByLabel("大纲快照")?.textContent).toContain("3")
    expect(tabByLabel("人物状态")?.textContent).toContain("1")
  })

  it("统计条首个 chip 写「快照总数」并显示 5，而不是「章节快照」", async () => {
    await render()
    const statsBar = host.querySelector('[data-ui="memory-stats"]')
    expect(statsBar?.textContent).toContain("快照总数")
    expect(statsBar?.textContent).toContain("5")
    // 「章节快照」这个名字属于标签，不该再出现在统计条上，否则 5 与 2 同名不同值
    expect(statsBar?.textContent).not.toContain("章节快照")
  })

  it("默认停在章节快照标签，按章号降序", async () => {
    await render()
    expect(tabByLabel("章节快照")?.getAttribute("aria-selected")).toBe("true")
    const titles = [...host.querySelectorAll('[data-ui="memory-snapshot"] .text-sm.font-semibold')]
      .map((node) => node.textContent?.trim())
    // 只出章节卡，不出大纲卡
    expect(titles).toEqual(["第4章", "第2章"])
  })

  it("切到大纲快照后按标题排列，并按编号绝对值兜底不露负号", async () => {
    await render()
    await clickTab("大纲快照")

    const titles = [...host.querySelectorAll('[data-ui="memory-snapshot"] .text-sm.font-semibold')]
      .map((node) => node.textContent?.trim())
    // 按标题 localeCompare：力量体系 < 人物小传 < 总大纲
    expect(titles).toEqual(["力量体系", "人物小传", "总大纲"])
    expect(titles.join()).not.toContain("-")
  })

  it("切标签会换掉内容区，且同一时刻只渲染一个标签页", async () => {
    await render()
    expect(host.querySelectorAll('[role="tabpanel"]')).toHaveLength(1)

    await clickTab("时间线")
    expect(tabByLabel("时间线")?.getAttribute("aria-selected")).toBe("true")
    expect(tabByLabel("章节快照")?.getAttribute("aria-selected")).toBe("false")
    expect(host.querySelectorAll('[role="tabpanel"]')).toHaveLength(1)
  })

  it("切到记忆文件标签时才读盘（按需读取，不是一次性全读）", async () => {
    await render()
    expect(hoisted.readFile).not.toHaveBeenCalled()

    await clickTab("人物状态")
    expect(hoisted.readFile).toHaveBeenCalledWith("E:/Novel/wiki/memory/character-states.md")
  })

  it("记忆文件标签渲染的是对应文件的内容", async () => {
    await render()
    await clickTab("人物状态")
    expect(host.querySelector('[data-testid="wiki-reader"]')?.textContent)
      .toContain("E:/Novel/wiki/memory/character-states.md")
  })

  it("标签条是单排不换行（滚动而不是折行）", async () => {
    await render()
    const strip = host.querySelector<HTMLElement>('[data-ui="memory-tabs"]')
    expect(strip).not.toBeNull()
    // 结构上是一排：所有标签是同一个 flex 容器的直接子元素
    const children = [...strip!.children]
    expect(children.every((child) => child.getAttribute("data-ui") === "memory-tab")).toBe(true)
    expect(children).toHaveLength(8)
  })
})

describe("记忆中心：整窗单页", () => {
  it("根元素带页面与状态标识，供 UI 测试皮肤挂样式", async () => {
    await render()
    const page = host.querySelector('[data-ui-page="memory"]')
    expect(page).not.toBeNull()
    expect(page?.getAttribute("data-ui-state")).toBe("ready")
  })

  it("选中的标签带 aria-controls，内容区带 aria-labelledby，可被读屏关联", async () => {
    await render()
    const selected = tabByLabel("章节快照")!
    const panel = host.querySelector('[role="tabpanel"]')!
    expect(selected.id).toBe("memory-tab-snapshots")
    expect(panel.getAttribute("aria-labelledby")).toBe("memory-tab-snapshots")
    expect(panel.id).toBe(selected.getAttribute("aria-controls"))
  })
})
