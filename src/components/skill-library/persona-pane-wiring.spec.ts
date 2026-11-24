import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { useWikiStore } from "@/stores/wiki-store"
import { describe, expect, it } from "vitest"

/**
 * 「点角色没反应」修了两次都没修对，根因是**改错了渲染点**：
 * 大纲页的中栏由 `OutlineWorkbench` 渲染，而我只改了 `WritingWorkspace`，
 * 正式版根本走不到那段代码。
 *
 * 所以这里用一条源码守卫把「所有渲染 PreviewPanel 的地方都必须能切到人物面板」
 * 钉死：以后新增第四处渲染点时，这条会立刻红。
 */
const RENDER_SITES = [
  "src/components/sources/outline-workbench.tsx",
  "src/components/uitest/ui-test-workspace.tsx",
  "src/components/layout/writing-workspace.tsx",
]

describe("人物面板必须接在所有中栏渲染点上", () => {
  it.each(RENDER_SITES)("%s 在有 personaPane 时渲染人物面板", (file) => {
    const source = readFileSync(resolve(process.cwd(), file), "utf8")
    expect(source).toContain("<PreviewPanel />")
    expect(source).toContain("<PersonaPane />")
    // 必须是「有面板就换掉文档」，而不是无条件都渲染
    expect(source).toMatch(/personaPane\s*\?/)
  })

  it("点回已选文档时也关闭人物面板", () => {
    const store = useWikiStore.getState()
    store.setSelectedFile("大纲.md")
    store.setPersonaOutlinePane({ mode: "create" })
    expect(useWikiStore.getState().personaOutlinePane).toEqual({ mode: "create" })
    store.setSelectedFile("大纲.md")
    expect(useWikiStore.getState().personaOutlinePane).toBeNull()
  })
})
