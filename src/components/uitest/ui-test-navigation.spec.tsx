// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { UiTestDirectoryHeader } from "./ui-test-directory"
vi.mock("@/lib/ui-test", () => ({ IS_UI_TEST_BUILD: true }))
let host: HTMLDivElement, root: Root
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host=document.createElement("div");document.body.append(host);root=createRoot(host) })
afterEach(async()=>{await act(async()=>root.unmount());host.remove()})
async function click(text:string) { const button=[...host.querySelectorAll("button")].find(b=>b.textContent?.trim()===text); expect(button,text).toBeTruthy();await act(async()=>button!.click()) }
describe("测试版目录操作",()=>{
  it("导入与更多菜单执行真实回调，收起不销毁业务",async()=>{
    const onImportFiles=vi.fn(),onCreateContainer=vi.fn(),onClose=vi.fn()
    await act(async()=>root.render(<UiTestDirectoryHeader kind="outline" busy={false} onCreate={()=>{}} onCreateContainer={onCreateContainer} onImportFiles={onImportFiles} onImportFolder={()=>{}} onOpenAssistant={()=>{}} onClose={onClose} onHelp={()=>{}} />))
    await click("导入");await click("导入文件");expect(onImportFiles).toHaveBeenCalledTimes(1)
    await click("新建");await click("新建文件夹");expect(onCreateContainer).toHaveBeenCalledTimes(1)
    expect(host.textContent).not.toContain("更多")
    expect(host.querySelector('[aria-label="批量大纲提取"]')).not.toBeNull()
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="收起目录"]')!.click());expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("章节新建包含章节和卷，并提供与大纲相同的一键提取入口", async () => {
    const onCreate = vi.fn(), onCreateContainer = vi.fn(), onOpenAssistant = vi.fn()
    await act(async () => root.render(<UiTestDirectoryHeader kind="chapter" busy={false} onCreate={onCreate} onCreateContainer={onCreateContainer} onImportFiles={() => {}} onImportFolder={() => {}} onOpenAssistant={onOpenAssistant} onClose={() => {}} onHelp={() => {}} />))
    await click("新建")
    expect(host.textContent).toContain("新建章节")
    expect(host.textContent).toContain("新建卷")
    expect(host.textContent).not.toContain("新建分卷")
    expect(host.textContent).not.toContain("功能使用说明")
    await click("新建卷")
    expect(onCreateContainer).toHaveBeenCalledTimes(1)
    await click("新建")
    await click("新建章节")
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[aria-label="一键提取"]')).not.toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="一键提取"]')!.click())
    expect(onOpenAssistant).toHaveBeenCalledTimes(1)
  })
})

describe("测试版目录菜单：新建人物角色", () => {
  it("大纲视图的创建菜单有第三项，点击走真实回调", async () => {
    const onCreatePersona = vi.fn()
    await act(async () => root.render(<UiTestDirectoryHeader kind="outline" busy={false} onCreate={() => {}} onCreateContainer={() => {}} onCreatePersona={onCreatePersona} onImportFiles={() => {}} onImportFolder={() => {}} onOpenAssistant={() => {}} onClose={() => {}} onHelp={() => {}} />))
    await click("新建")
    expect(host.textContent).toContain("新建大纲")
    expect(host.textContent).toContain("新建文件夹")
    expect(host.textContent).toContain("新建人物角色")
    await click("新建人物角色")
    expect(onCreatePersona).toHaveBeenCalledTimes(1)
  })

  it("章节视图不出现「新建人物角色」", async () => {
    await act(async () => root.render(<UiTestDirectoryHeader kind="chapter" busy={false} onCreate={() => {}} onCreateContainer={() => {}} onCreatePersona={() => {}} onImportFiles={() => {}} onImportFolder={() => {}} onOpenAssistant={() => {}} onClose={() => {}} onHelp={() => {}} />))
    await click("新建")
    expect(host.textContent).not.toContain("新建人物角色")
  })

  it("没传回调时也不渲染（避免点上没反应的空按钮）", async () => {
    await act(async () => root.render(<UiTestDirectoryHeader kind="outline" busy={false} onCreate={() => {}} onCreateContainer={() => {}} onImportFiles={() => {}} onImportFolder={() => {}} onOpenAssistant={() => {}} onClose={() => {}} onHelp={() => {}} />))
    await click("新建")
    expect(host.textContent).not.toContain("新建人物角色")
  })
})
describe("运行期实际渲染的是哪个目录组件（防回归）", () => {
  it("IS_UI_TEST_BUILD 恒真 → sidebar 渲染 UiTestDirectoryHeader，菜单必须加在它里面", async () => {
    const { readFileSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const uiTest = readFileSync(resolve(__dirname, "../../lib/ui-test.ts"), "utf8")
    // 一旦这里变成 false，菜单就该挪回 KnowledgeTree——本条断言会立刻失败提醒
    expect(uiTest).toContain("IS_UI_TEST_BUILD = true")
    const sidebar = readFileSync(resolve(__dirname, "../layout/sidebar-panel.tsx"), "utf8")
    expect(sidebar).toContain("onCreatePersona=")
  })
})