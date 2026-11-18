import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = readFileSync(
  resolve(__dirname, "sidebar-bottom-actions.tsx"),
  "utf8",
)

describe("sidebar-bottom-actions", () => {


  it("外观默认折叠，点击或悬停都能展开三个主题且不带副标题", () => {
    expect(source).toContain('data-ui="sidebar-appearance-entry"')
    expect(source).toContain("ui-avatar-appearance-group")
    expect(source).toContain("ui-avatar-appearance-sub")
    expect(source).toContain("UI_TEST_SKINS.map")
    // 折叠：受控状态 + data-open
    expect(source).toContain("appearanceVisible")
    expect(source).toContain("data-open={appearanceVisible")
    // 用户 2026-10-28：三个皮肤要弹在「外观」右侧，鼠标移上去就展开（点击也仍可用）
    expect(source).toContain("onMouseEnter={() => setAppearanceHovered(true)}")
    expect(source).toContain("onMouseLeave")
    expect(source).toContain("setAppearancePinned((open) => !open)")
    // 子项只有主题名，不带 hint 副标题
    expect(source).not.toContain("{item.hint}")
  })

  it("菜单里的入口都绑了点击处理", () => {
    expect(source).toContain("onClick={openGeneralSettings}")
    expect(source).toContain("onClick={openMaintenance}")
    expect(source).toContain("onClick={() => selectSkin(item.id)}")
    expect(source).toContain("onClick={() => setAppearancePinned((open) => !open)}")
  })




  it("外观子菜单弹在右侧，而不是列在「外观」下面", () => {
    const css = readFileSync(
      resolve(__dirname, "../uitest/ui-test.css"),
      "utf8",
    )
    /*
     * 用户 2026-10-28：三个皮肤必须在「外观」右侧弹出。
     * 之前是 `margin-left: 12px` + `border-left` 的缩进列表，会长在下方。
     */
    expect(css).not.toContain("border-left: 1px solid var(--ui-line);\n  padding-left: 4px;")
    /*
     * left 要跨过「菜单内边距 14px + 间隙 6px」：group 的右边界是菜单**内容区**的
     * 右边界，不是菜单卡片的右边界（+6px 会让子菜单压进菜单卡片里）。
     */
    expect(css).toContain("left: calc(100% + 20px)")
    expect(css).toContain('.ui-avatar-appearance-sub[data-open="true"]')
    /*
     * 悬停通道：从「外观」一行横移进子菜单要跨过 20px 空档，
     * 少了这块透明的桥，mouseleave 会先把子菜单收掉。
     */
    expect(css).toContain(".ui-avatar-appearance-sub::before")
    /*
     * 账号菜单是 createPortal 挂到 document.body 的，不在 .ui-test-root 里面：
     * 这两条规则一旦带上 `.ui-test-root` 前缀就永远匹配不上 —— 表现是三个皮肤
     * 一直平铺在外观下面、收起和右侧定位全部失效（2026-10-28 用户实测截图）。
     * 必须是全局选择器。
     */
    expect(css).not.toContain(".ui-test-root .ui-avatar-appearance-group")
    expect(css).not.toContain(".ui-test-root .ui-avatar-appearance-sub")
    expect(css).toMatch(/(^|\n)\.ui-avatar-appearance-group \{/)
    expect(css).toMatch(/(^|\n)\.ui-avatar-appearance-sub \{/)
  })

  it("外部点击放行整个账号菜单（否则菜单里点任何一项都会被先关掉）", () => {
    expect(source).toContain('closest?.(".ui-test-avatar-menu")')
    expect(source).not.toContain('closest?.(".ui-test-skin-menu")')
  })


  it("no longer owns a light/dark theme dropdown", () => {
    expect(source).not.toContain("applyTheme")
    expect(source).not.toContain("saveTheme")
    expect(source).not.toContain("THEME_OPTIONS")
  })

  it("opens the menu in a portal, anchored by its bottom above the trigger", () => {
    expect(source).toContain("createPortal")
    expect(source).toContain("document.body")
    expect(source).toContain('position: "fixed"')
    expect(source).toContain('top: "auto"')
    expect(source).toContain('right: "auto"')
    expect(source).toContain("bottom: menuStyle.bottom")
    expect(source).not.toContain("rect.top - menuHeight")
  })

  it("弹层不能是滚动容器（否则子菜单被裁 + 长出滚动条）", () => {
    /*
     * 用户 2026-10-28 截图：账号菜单里出现左右/上下两个灰色滚动条，
     * 「外观」右侧的皮肤子菜单完全看不见。
     * 根因是弹层 `overflow-y: auto` + max-height：绝对定位的子菜单属于弹层的
     * 可滚动溢出区，既被裁掉又把 scrollWidth 撑到 450px（实测）。
     * 菜单本身只有四项、约 200px 高，永远不需要滚。
     */
    expect(source).toContain('overflow: "visible"')
    expect(source).not.toContain('overflowY: "auto"')
    expect(source).not.toContain("maxHeight")
  })

})
