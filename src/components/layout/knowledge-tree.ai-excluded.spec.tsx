// @vitest-environment jsdom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const listDirectory = vi.fn()
const readFile = vi.fn()

vi.mock("@/commands/fs", () => ({
  listDirectory: (...args: unknown[]) => listDirectory(...args),
  readFile: (...args: unknown[]) => readFile(...args),
  fileExists: vi.fn(async () => false),
  writeFile: vi.fn(),
  createDirectory: vi.fn(),
  deleteFile: vi.fn(),
  openFileLocation: vi.fn(),
  copyFile: vi.fn(),
}))

import { KnowledgeTree } from "./knowledge-tree"
import { useWikiStore } from "@/stores/wiki-store"
import { useImportProgressStore } from "@/stores/import-progress-store"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = "E:/QMAI-AI-EXCLUDE"
const CHAPTERS_DIR = `${PROJECT}/wiki/chapters`
const OUTLINES_DIR = `${PROJECT}/wiki/outlines`

const CHAPTER_FILES = [
  { name: "第1章-雨夜.md", path: `${CHAPTERS_DIR}/第1章-雨夜.md`, is_dir: false },
  { name: "第2章-断线.md", path: `${CHAPTERS_DIR}/第2章-断线.md`, is_dir: false },
]
const OUTLINE_FILES = [
  { name: "卷一 残灯有火.md", path: `${OUTLINES_DIR}/卷一 残灯有火.md`, is_dir: false },
]

const FILE_TREE = [{
  name: "QMAI-AI-EXCLUDE", path: PROJECT, is_dir: true, children: [{
    name: "wiki", path: `${PROJECT}/wiki`, is_dir: true, children: [
      { name: "chapters", path: CHAPTERS_DIR, is_dir: true, children: CHAPTER_FILES },
      { name: "outlines", path: OUTLINES_DIR, is_dir: true, children: OUTLINE_FILES },
    ],
  }],
}]

const CONTENTS: Record<string, string> = {
  // 第 1 章：正常参与 AI
  [`${CHAPTERS_DIR}/第1章-雨夜.md`]: "---\nchapter_number: 1\ntitle: 第1章 雨夜\n---\n\n正文。\n",
  // 第 2 章：被选中（AI 不读取）
  [`${CHAPTERS_DIR}/第2章-断线.md`]: "---\nchapter_number: 2\ntitle: 第2章 断线\nai_exclude: true\n---\n\n正文。\n",
  // 大纲：同样被选中
  [`${OUTLINES_DIR}/卷一 残灯有火.md`]: "---\ntype: outline\noutline_type: volume-outline\nai_exclude: true\n---\n\n# 卷一 残灯有火\n",
}

function mount(filterType: "chapter" | "outline") {
  listDirectory.mockImplementation(async (path: string) => {
    if (path === CHAPTERS_DIR) return CHAPTER_FILES
    if (path === OUTLINES_DIR) return OUTLINE_FILES
    return []
  })
  readFile.mockImplementation(async (path: string) => CONTENTS[path] ?? "")

  useWikiStore.setState({
    project: { id: "p-ai-exclude", name: "测试书", path: PROJECT },
    novelMode: true,
    selectedFile: null,
    fileTree: FILE_TREE as never,
  })

  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<KnowledgeTree filterType={filterType} />)
  })
  return {
    container,
    cleanup: () => {
      act(() => root.unmount())
      document.body.removeChild(container)
    },
  }
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function rowFor(container: HTMLElement, fileName: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`[data-page-path$="${fileName}"]`)
  expect(row, `找不到目录行 ${fileName}`).toBeTruthy()
  return row!
}

function badgeIn(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>("[data-ui-tree-ai-excluded]")
}

/*
 * 目录里的「AI 不读」小标签。
 *
 * 它只负责"看得见"：真正拦住模型的是 ai-exclude.ts + 各处闸口。
 * 但看不见的排除状态本身就是缺陷 —— 用户会以为自己早就把它关掉了，
 * 或者反过来，以为某篇没被排除而被 AI 读走了。
 */
describe("目录树的「AI 不读」标记", () => {
  beforeEach(() => {
    listDirectory.mockReset()
    readFile.mockReset()
    useImportProgressStore.setState({ tasks: [] })
  })

  afterEach(() => {
    useWikiStore.setState(useWikiStore.getInitialState())
    useImportProgressStore.setState({ tasks: [] })
  })

  it("章节：被选中的显示标记，未选中的不显示", async () => {
    const { container, cleanup } = mount("chapter")
    await flush()

    const excludedRow = rowFor(container, "第2章-断线.md")
    const normalRow = rowFor(container, "第1章-雨夜.md")

    expect(badgeIn(excludedRow)?.textContent).toBe("AI 不读")
    expect(badgeIn(excludedRow)?.getAttribute("aria-label")).toBe("已选中，AI 不读取")
    expect(badgeIn(normalRow)).toBeNull()

    cleanup()
  })

  it("大纲：同一枚标记（大纲与章节共用同一个行渲染器）", async () => {
    const { container, cleanup } = mount("outline")
    await flush()

    const outlineRow = rowFor(container, "卷一 残灯有火.md")
    expect(badgeIn(outlineRow)?.textContent).toBe("AI 不读")

    cleanup()
  })

  it("标记只认 frontmatter 的 ai_exclude，不误伤正文里出现过这个词的文件", async () => {
    CONTENTS[`${CHAPTERS_DIR}/第1章-雨夜.md`] =
      "---\nchapter_number: 1\ntitle: 第1章 雨夜\n---\n\n他在笔记里写下 ai_exclude 这个词。\n"
    const { container, cleanup } = mount("chapter")
    await flush()

    expect(badgeIn(rowFor(container, "第1章-雨夜.md"))).toBeNull()
    expect(badgeIn(rowFor(container, "第2章-断线.md"))).not.toBeNull()

    cleanup()
  })

  /*
   * CRLF 文件：树里那份 frontmatter 快取正则（`^---\n`）取不到块，
   * 所以判据必须走 `parseFrontmatter`（它认 \r\n）。否则会出现
   * "编辑器顶上挂着排除带、目录里却没有标记" —— 同一个状态两种说法。
   */
  it("CRLF 换行的文件同样显示标记", async () => {
    CONTENTS[`${CHAPTERS_DIR}/第1章-雨夜.md`] =
      "---\r\nchapter_number: 1\r\ntitle: 第1章 雨夜\r\nai_exclude: true\r\n---\r\n\r\n正文。\r\n"
    const { container, cleanup } = mount("chapter")
    await flush()

    expect(badgeIn(rowFor(container, "第1章-雨夜.md"))).not.toBeNull()

    cleanup()
  })
})
