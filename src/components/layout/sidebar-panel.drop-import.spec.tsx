// @vitest-environment jsdom
//
// 问题四（端到端）：把桌面文件拖进大纲/章节列表，就要真的进到对应的库目录里。
//
// 前面的 drop-import.spec / use-list-file-drop.spec 验的是判定与筛选，
// 这里验的是"接线到底通不通"：拖进章节列表 → 落到 wiki/chapters；
// 拖进大纲列表 → 落到 wiki/outlines；并且先问「是否提取记忆」。
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ListDirectoryOptions } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"

const platformMock = vi.hoisted(() => ({ isTauri: vi.fn(() => true) }))
vi.mock("@/lib/platform", () => platformMock)

const webviewMock = vi.hoisted(() => ({
  handler: null as null | ((event: { payload: unknown }) => void),
  unlisten: vi.fn(),
}))
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: (event: { payload: unknown }) => void) => {
      webviewMock.handler = handler
      return webviewMock.unlisten
    },
  }),
}))
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }))

// 显式标注签名，与 @/commands/fs 的生产契约一致；
// 否则 vi.fn(async () => ...) 会被推断成零参签名，mock.calls 变成空元组 []。
const writeFile = vi.fn<(path: string, contents: string) => Promise<void>>(async () => {})
const readFile = vi.fn<(path: string) => Promise<string>>(async () => "")
const listDirectory = vi.fn<
  (path: string, includeHiddenOrOptions?: boolean | ListDirectoryOptions) => Promise<FileNode[]>
>(async () => [])
const createDirectory = vi.fn<(path: string) => Promise<void>>(async () => {})
const fileExists = vi.fn<(path: string) => Promise<boolean>>(async () => false)
vi.mock("@/commands/fs", () => ({
  writeFile: (...args: [string, string]) => writeFile(...args),
  readFile: (...args: [string]) => readFile(...args),
  listDirectory: (
    ...args: [string, (boolean | ListDirectoryOptions)?]
  ) => listDirectory(...args),
  createDirectory: (...args: [string]) => createDirectory(...args),
  fileExists: (...args: [string]) => fileExists(...args),
  deleteFile: vi.fn(),
  openFileLocation: vi.fn(),
  copyFile: vi.fn(),
  writeFileAtomic: vi.fn(),
}))

import { SidebarPanel } from "./sidebar-panel"
import { useWikiStore } from "@/stores/wiki-store"
import { changeInput } from "@/components/uitest/models/model-test-utils"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = "E:/QMAI-DROP"
const LIST_RECT = { left: 0, top: 0, right: 400, bottom: 800 }

let container: HTMLDivElement
let root: Root

async function flush(ticks = 8) {
  await act(async () => {
    for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function emit(payload: unknown) {
  act(() => { webviewMock.handler?.({ payload }) })
}

/** 落在列表内的物理坐标（DPR=1）。 */
const INSIDE = { x: 200, y: 400 }
const OUTSIDE = { x: 1200, y: 400 }

async function mount(mode: "chapter" | "outline") {
  useWikiStore.setState({
    project: { id: "p-drop", name: "测试书", path: PROJECT },
    novelMode: true,
    selectedFile: null,
    activeView: mode === "chapter" ? "wiki" : "sources",
    fileTree: [],
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<SidebarPanel />)
  })
  // 切到目标页签（SidebarPanel 的模式由 activeView/selectedFile 推导）
  if (mode === "outline") {
    await act(async () => {
      useWikiStore.setState({ activeView: "sources", selectedFile: null })
    })
    await flush()
  }
  await flush()
}

const dropTarget = () =>
  container.querySelector<HTMLElement>("[data-ui-list-drop-target]")

/** 把列表容器的矩形钉死：jsdom 不做布局，getBoundingClientRect 全是 0。 */
function stubListRect() {
  Element.prototype.getBoundingClientRect = vi.fn(
    (): DOMRect => ({
      ...LIST_RECT,
      x: LIST_RECT.left,
      y: LIST_RECT.top,
      width: LIST_RECT.right - LIST_RECT.left,
      height: LIST_RECT.bottom - LIST_RECT.top,
      toJSON: () => ({}),
    }),
  )
}

beforeEach(() => {
  platformMock.isTauri.mockReturnValue(true)
  webviewMock.handler = null
  webviewMock.unlisten.mockReset()
  for (const fn of [writeFile, readFile, listDirectory, createDirectory, fileExists]) {
    fn.mockReset()
  }
  writeFile.mockResolvedValue(undefined)
  readFile.mockResolvedValue("这是章节正文。")
  listDirectory.mockResolvedValue([])
  createDirectory.mockResolvedValue(undefined)
  fileExists.mockResolvedValue(false)
  stubListRect()
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe("桌面文件拖进列表导入", () => {
  it("章节列表挂上了投放目标标记", async () => {
    await mount("chapter")
    expect(dropTarget()?.getAttribute("data-ui-list-drop-target")).toBe("chapter")
    expect(container.querySelector('[aria-label="大纲侧栏"]')).toBeNull()
  })

  it("大纲列表挂上了投放目标标记", async () => {
    await mount("outline")
    expect(dropTarget()?.getAttribute("data-ui-list-drop-target")).toBe("outline")
  })

  it("输入关键词直接找到折叠目录里的大纲，两页搜索词独立", async () => {
    await mount("outline")
    const outlines = `${PROJECT}/wiki/outlines`
    const folder = `${outlines}/设定`
    await act(async () => useWikiStore.setState({ fileTree: [{
      name: "outlines", path: outlines, is_dir: true, children: [{
        name: "设定", path: folder, is_dir: true, children: ["世界", "人物关系"].map(title => ({
          name: `${title}.md`, path: `${folder}/${title}.md`, is_dir: false,
        })),
      }],
    }] }))
    const [outline, personas] = container.querySelectorAll<HTMLButtonElement>('[aria-label="大纲侧栏"] [role="tab"]')
    const files = () => [...container.querySelectorAll("[data-page-path]")].map(row => row.getAttribute("data-page-path"))
    await changeInput(container, "搜索大纲", "世界")
    expect(files()).toEqual([`${folder}/世界.md`])
    await act(async () => personas.click())
    expect(container.querySelector<HTMLInputElement>("input[type=search]")?.value).toBe("")
    await changeInput(container, "搜索人物姓名或别名", "老韩")
    expect(container.textContent).toContain("没有找到匹配的人物")
    await act(async () => outline.click())
    expect(container.querySelector<HTMLInputElement>("input[type=search]")?.value).toBe("世界")
    await changeInput(container, "搜索大纲", " ")
    expect(files()).toEqual([])
    expect(container.querySelector('[data-ui-tree-row="folder"] button')?.getAttribute("aria-expanded")).toBe("false")
  })

  it("大纲和人物小传共用侧栏，切换时保留手动展开的目录，人物页不接收大纲投放", async () => {
    await mount("outline")
    const outlines = `${PROJECT}/wiki/outlines`
    const folder = `${outlines}/设定`
    const file = `${folder}/世界.md`
    await act(async () => useWikiStore.setState({ fileTree: [
      { name: "outlines", path: outlines, is_dir: true, children: [
        { name: "设定", path: folder, is_dir: true, children: [
          { name: "世界.md", path: file, is_dir: false },
        ] },
      ] },
    ] }))

    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="大纲侧栏"] [role="tab"]')]
    expect(tabs.map(tab => tab.textContent)).toEqual(["大纲", "人物小传"])
    const visiblePanel = () => container.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!
    const folderButton = () => visiblePanel().querySelector<HTMLButtonElement>('[data-ui-tree-row="folder"] button')!
    expect(tabs[0].getAttribute("aria-selected")).toBe("true")
    expect(folderButton().getAttribute("aria-expanded")).toBe("false")
    expect(visiblePanel().querySelector("[data-page-path]")).toBeNull()
    await act(async () => folderButton().click())
    expect(visiblePanel().querySelector("[data-page-path]")?.getAttribute("data-page-path")).toBe(file)

    await act(async () => tabs[1].click())
    await vi.waitFor(() => expect(dropTarget()?.hidden).toBe(true))
    expect(visiblePanel().querySelector('[data-testid="persona-tree-section"]')).not.toBeNull()
    expect(visiblePanel().querySelector('[data-page-path]')).toBeNull()
    emit({ type: "drop", paths: ["E:/桌面/主线.md"], position: INSIDE })
    await flush()
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    await act(async () => tabs[0].click())
    await vi.waitFor(() => expect(container.querySelectorAll('[role="tabpanel"]:not([hidden])')).toHaveLength(1))
    expect(folderButton().getAttribute("aria-expanded")).toBe("true")
    expect(visiblePanel().querySelector('[data-testid="persona-tree-section"]')).toBeNull()
  })

  /**
   * 用户明确要求：拖进来也要走「是否提取记忆」这一步，而不是静默导入。
   * 章节侧原本的"选文件"就是先问再导，拖进来沿用同一条。
   */
  it("拖进章节列表时先弹「是否提取记忆」", async () => {
    await mount("chapter")
    emit({ type: "drop", paths: ["E:/桌面/第1章.txt"], position: INSIDE })
    await flush()

    expect(document.body.textContent, "必须先问一次是否提取记忆").toContain("是否提取记忆")
  })

  it("在弹窗里选「只导入」，章节就落到 wiki/chapters", async () => {
    await mount("chapter")
    emit({ type: "drop", paths: ["E:/桌面/第1章.txt"], position: INSIDE })
    await flush()

    const importOnly = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "只导入")
    expect(importOnly, "弹窗里应该有「只导入」").toBeTruthy()
    await act(async () => { importOnly!.click() })
    await flush(12)

    const targets = writeFile.mock.calls.map((call) => String(call[0]))
    expect(targets.length, "拖进来的章节应该被写盘").toBeGreaterThan(0)
    expect(targets.some((path) => path.startsWith(`${PROJECT}/wiki/chapters/`))).toBe(true)
  })

  it("在弹窗里选「只导入」，大纲就落到 wiki/outlines", async () => {
    await mount("outline")
    emit({ type: "drop", paths: ["E:/桌面/主线.md"], position: INSIDE })
    await flush()

    const importOnly = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "只导入")
    expect(importOnly, "大纲侧拖进来同样要先问记忆").toBeTruthy()
    await act(async () => { importOnly!.click() })
    await flush(12)

    const targets = writeFile.mock.calls.map((call) => String(call[0]))
    expect(targets.some((path) => path.startsWith(`${PROJECT}/wiki/outlines`))).toBe(true)
  })

  it("在弹窗里取消，什么都不导入", async () => {
    await mount("chapter")
    emit({ type: "drop", paths: ["E:/桌面/第1章.txt"], position: INSIDE })
    await flush()

    const cancel = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "取消导入")
    expect(cancel).toBeTruthy()
    await act(async () => { cancel!.click() })
    await flush(12)

    expect(writeFile).not.toHaveBeenCalled()
  })

  it("落在列表以外不触发任何导入", async () => {
    await mount("chapter")
    emit({ type: "drop", paths: ["E:/桌面/第1章.txt"], position: OUTSIDE })
    await flush()
    expect(document.body.textContent).not.toContain("是否提取记忆")
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("拖进来的是不可导入的文件时给出提示，不弹记忆确认", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    await mount("chapter")
    emit({ type: "drop", paths: ["E:/桌面/封面.png"], position: INSIDE })
    await flush()

    expect(alertSpy).toHaveBeenCalled()
    expect(document.body.textContent).not.toContain("是否提取记忆")
  })

  it("拖动经过列表时显示「松手即可导入」的提示", async () => {
    await mount("chapter")
    emit({ type: "enter", paths: ["E:/桌面/第1章.txt"], position: INSIDE })
    await act(async () => {})
    expect(container.querySelector('[data-ui-list-drop-hint="true"]')).not.toBeNull()

    emit({ type: "leave" })
    await act(async () => {})
    expect(container.querySelector('[data-ui-list-drop-hint="true"]')).toBeNull()
  })

  /**
   * 原生拖拽可以在记忆弹窗还开着的时候再来一次。第二次如果照样走进来，
   * 就会覆盖掉第一次那个 promise 的 resolve，第一次的导入永远不 resolve：
   * 用户点了「只导入」却没反应。这里钉住"第二次直接被挡掉"。
   */
  it("记忆弹窗还开着时，第二次拖入被挡掉而不是把前一次卡死", async () => {
    await mount("chapter")
    emit({ type: "drop", paths: ["E:/桌面/第1章.txt"], position: INSIDE })
    await flush()
    expect(document.body.textContent).toContain("是否提取记忆")

    emit({ type: "drop", paths: ["E:/桌面/第2章.txt"], position: INSIDE })
    await flush()

    // 第一次的弹窗仍然可以被回答，并且只导入第一次那批文件
    const importOnly = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "只导入")
    await act(async () => { importOnly!.click() })
    await flush(12)

    const targets = writeFile.mock.calls.map((call) => String(call[0]))
    expect(targets, "只该导入第一次拖进来的那一章").toEqual([`${PROJECT}/wiki/chapters/chapter-001.md`])
    expect(targets.some((path) => path.includes("chapter-002")), "第二次拖入不该混进来").toBe(false)
  })
})
