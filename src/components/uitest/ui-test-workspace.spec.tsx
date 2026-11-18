// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import { useOutlineGenerationStore } from "@/stores/outline-generation-store"
import { UiTestWorkspace } from "./ui-test-workspace"

vi.mock("@/components/layout/preview-panel", () => ({
  PreviewPanel: () => <div data-testid="preview">正文</div>,
}))
vi.mock("@/components/chat/chat-panel", () => ({ ChatPanel: () => <div data-testid="chat">对话</div> }))
vi.mock("@/components/sources/outline-chat-panel", () => ({ OutlineChatPanel: () => <div data-testid="outline-chat">大纲对话</div> }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function mount(mode: "chapter" | "outline") {
  await act(async () => {
    root.render(
      <div className="ui-test-root" data-skin="light">
        <UiTestWorkspace mode={mode} requestedWidth={420} viewportWidth={1440} onWidthChange={() => {}} />
      </div>,
    )
  })
}

function editorPane(): HTMLElement {
  const node = container.querySelector<HTMLElement>("#ui-test-editor-pane")
  expect(node, "应渲染正文栏").not.toBeNull()
  return node!
}

beforeEach(() => {
  useWikiStore.setState({ chatExpanded: false })
  useOutlineGenerationStore.setState({ panelOpen: false })
  window.innerWidth = 1440
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.clearAllMocks()
})

describe("写作工作区布局", () => {
  it("章节视图只渲染正文容器，移除底部写作字数栏", async () => {
    await mount("chapter")
    const pane = editorPane()
    expect(pane.querySelector(".ui-test-editor-slot > [data-testid='preview']")).not.toBeNull()
    expect(pane.children).toHaveLength(1)
    expect(container.querySelector(".ui-test-statusbar")).toBeNull()
  })

  it("大纲视图打开助手时挂载大纲对话", async () => {
    useOutlineGenerationStore.setState({ panelOpen: true })
    await mount("outline")
    expect(container.querySelector('[data-testid="outline-chat"]')).not.toBeNull()
  })

  it("正文栏的 hidden 属性能隐藏 flex 容器", () => {
    // tabs 模式（窄窗 + 对话展开）靠 hidden 属性切换；正文栏加了 display:flex
    // 会盖掉浏览器默认的 [hidden]{display:none}。
    const css = readFileSync("src/components/uitest/ui-test.css", "utf8")
    expect(css.replace(/\r\n/g, "\n")).toContain(".ui-test-editor-pane[hidden] { display: none; }")
  })
})

/**
 * 回归：正文容器**冒用编辑器内部类名**会让正文滚不动。
 *
 * 真实故障：正文容器一度叫 `ui-test-editor-body`，与 ui-test-editor.tsx 的
 * 编辑器正文容器同名。ui-test-editor.css 里有一条
 * `.ui-test-editor-body > div { height: auto; overflow: visible }`，
 * 于是它命中了 PreviewPanel 的根 div（`flex h-full flex-col`），
 * 把 `height: 100%` 改写成 `auto` → `.ui-test-editor-scroll` 不再溢出 →
 * 没有滚动条、滚轮也滚不动，而外层 `overflow: hidden` 把多余内容裁掉。
 *
 * 这里从三个角度钉死，任何一个被改回都会红：
 * 1) 结构与真实渲染：正文容器不能带那个类；
 * 2) 文档里不能存在第二个 `ui-test-editor-body` 祖先；
 * 3) 样式表契约：ui-test.css 不得定义 `.ui-test-editor-body`（那是编辑器的类）。
 */
describe("正文容器不得冒用编辑器内部类名（否则正文滚不动）", () => {
  const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n")

  it("正文栏的直接子容器用的是 slot 类，不是编辑器内部的 body 类", async () => {
    await mount("chapter")
    const pane = editorPane()
    expect(
      pane.querySelector(":scope > .ui-test-editor-body"),
      "正文容器不能叫 ui-test-editor-body（会触发 `.ui-test-editor-body > div` 改写正文高度）",
    ).toBeNull()
    expect(pane.querySelector(":scope > .ui-test-editor-slot")).not.toBeNull()
  })

  it("PreviewPanel 的根节点不是 ui-test-editor-body，不会被 `> div` 规则命中", () => {
    // 故障成立的前提就是 PreviewPanel 根 div 是 body 类的直接子元素。
    // 钉住根节点形状：它必须仍是 `flex h-full flex-col`（高度链的起点）。
    const source = read("src/components/layout/preview-panel.tsx")
    expect(source).toContain('<div className="flex h-full flex-col">')
    expect(read("src/components/uitest/ui-test-workspace.tsx"))
      .not.toContain('<div className="ui-test-editor-body"><PreviewPanel />')
  })

  it("ui-test.css 不得定义 .ui-test-editor-body —— 那个类归编辑器样式表所有", () => {
    const workspaceCss = read("src/components/uitest/ui-test.css")
    // 只要工作区样式表里出现这条类选择器，就说明又有元素冒用了它。
    expect(
      /^\.ui-test-editor-body[\s,{:]/m.test(workspaceCss),
      "ui-test.css 不应定义 .ui-test-editor-body：它属于编辑器内部容器，冒用会改写正文高度链",
    ).toBe(false)
    // 同时确认「肇事规则」还在编辑器样式表里 —— 它在，冒用就一定会再次踩坑。
    expect(read("src/components/uitest/ui-test-editor.css"))
      .toContain(".ui-test-editor-body > div { height: auto; overflow: visible; }")
  })
})
