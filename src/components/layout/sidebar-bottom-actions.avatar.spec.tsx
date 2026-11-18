// @vitest-environment jsdom
/**
 * 左下角设置入口：
 * - 点它展开菜单（头像 + 外观设置 + 维护工具），不再直接弹账号信息；
 * - 菜单里点头像 → 「设置 → 账号」；
 * - 点「维护工具」→ 维护视图。
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  setActiveView: vi.fn(),
  setActiveSettingsCategory: vi.fn(),
  setSearchPanelOpen: vi.fn(),
  selectSkin: vi.fn(),
}))

vi.mock("@/stores/wiki-store", () => {
  const state = {
    activeView: "wiki",
    setActiveView: mocks.setActiveView,
    setActiveSettingsCategory: mocks.setActiveSettingsCategory,
    setSearchPanelOpen: mocks.setSearchPanelOpen,
  }
  const useWikiStore = (selector: (value: typeof state) => unknown) => selector(state)
  useWikiStore.getState = () => state
  return { useWikiStore }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? (key === "sidebarActions.appearance" ? "外观设置" : key),
  }),
}))

vi.mock("@/components/layout/appearance-context", () => ({
  useAppearanceSkin: () => ({ skin: "light", selectSkin: mocks.selectSkin }),
}))

import { SidebarBottomActions } from "./sidebar-bottom-actions"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  mocks.setActiveView.mockReset()
  mocks.setActiveSettingsCategory.mockReset()
  mocks.setSearchPanelOpen.mockReset()

})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.querySelectorAll(".ui-test-menu-pop").forEach((node) => node.remove())
})

function render() {
  act(() => root.render(<SidebarBottomActions />))
}

function trigger() {
  return host.querySelector<HTMLButtonElement>('[data-ui="sidebar-options"]')!
}

function menu() {
  return document.querySelector<HTMLElement>(".ui-test-avatar-menu")
}

describe("左下角设置入口", () => {
  it("默认不展开菜单；点设置才展开，且含外观设置与维护工具", () => {
    render()
    expect(menu()).toBeNull()

    act(() => trigger().click())

    const panel = menu()!
    expect(panel).toBeTruthy()
    expect(panel.textContent).toContain("外观设置")
    expect(panel.textContent).toContain("维护工具")
    expect(panel.querySelector('[data-ui="sidebar-avatar-account-entry"]')).toBeNull()
  })


  it("点「维护工具」→ 打开维护视图", () => {
    render()
    act(() => trigger().click())
    const entry = menu()!.querySelector<HTMLButtonElement>('[data-ui="sidebar-maintenance-entry"]')!
    act(() => entry.click())

    expect(mocks.setActiveView).toHaveBeenCalledWith("maintenance")
    expect(menu()).toBeNull()
  })

})

describe("设置菜单", () => {
  it("点「设置」→ 打开设置视图（该功能曾丢失）", () => {
    render()
    act(() => trigger().click())
    const entry = menu()!.querySelector<HTMLButtonElement>('[data-ui="sidebar-settings-entry"]')!
    act(() => entry.click())
    expect(mocks.setActiveView).toHaveBeenCalledWith("settings")
    expect(menu()).toBeNull()
  })

  it("外观默认折叠，点开后列出青瓷和石墨并可切换", () => {
    render()
    act(() => trigger().click())
    const panel = menu()!
    const sub = () => panel.querySelector<HTMLElement>(".ui-avatar-appearance-sub")!
    // 默认折叠
    expect(sub().getAttribute("data-open")).toBe("false")

    const entry = panel.querySelector<HTMLButtonElement>('[data-ui="sidebar-appearance-entry"]')!
    act(() => entry.click())
    expect(sub().getAttribute("data-open")).toBe("true")

    const skins = panel.querySelectorAll('[role="menuitemradio"]')
    expect(Array.from(skins, (item) => item.textContent)).toEqual(["青瓷", "石墨"])
    act(() => (skins[1] as HTMLButtonElement).click())
    expect(mocks.selectSkin).toHaveBeenCalledWith("dark")
  })

  it("鼠标移到「外观」上就展开，移开就收起", () => {
    render()
    act(() => trigger().click())
    const panel = menu()!
    const group = panel.querySelector<HTMLElement>(".ui-avatar-appearance-group")!
    const sub = () => panel.querySelector<HTMLElement>(".ui-avatar-appearance-sub")!

    expect(sub().getAttribute("data-open")).toBe("false")
    act(() => {
      group.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    })
    expect(sub().getAttribute("data-open")).toBe("true")

    act(() => {
      group.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }))
    })
    expect(sub().getAttribute("data-open")).toBe("false")
  })


})