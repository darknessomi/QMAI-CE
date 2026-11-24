// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 人物区段把「人物」搬回了大纲第一栏，所以这几条盯着的是
 * **它点了之后到底改了什么**：只应该切中栏内容（`personaOutlinePane`），
 * 不该跳整页视图（`activeView`）。
 */
const storeState: {
  project: { path: string } | null
  personaOutlinePane: unknown
  setPersonaOutlinePane: (focus: unknown) => void
} = {
  project: { path: "/tmp/project" },
  personaOutlinePane: null,
  setPersonaOutlinePane: vi.fn(),
}

const indexMock = vi.fn()
const sightingsMock = vi.fn()

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}))

vi.mock("@/lib/novel/persona-skill-store", () => ({
  loadPersonaSkillState: async () => ({ index: await indexMock(), sightings: await sightingsMock() }),
}))

import { PersonaTreeSection } from "./persona-tree-section"

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  storeState.personaOutlinePane = null
  storeState.setPersonaOutlinePane = vi.fn()
  indexMock.mockResolvedValue({
    version: 1,
    skills: [
      { id: "杨寒", characterName: "杨寒", roleType: "主角", status: "active", appearanceCount: 18, pinned: true, aliases: ["Han"], tier: "major" },
      { id: "杨津艺", characterName: "杨津艺", roleType: "次要", status: "dormant", appearanceCount: 1, pinned: false, aliases: ["江城医师"], tier: "minor", autoUpdate: false },
      { id: "闻修", characterName: "闻修", roleType: "次要", status: "archived", appearanceCount: 2, pinned: false, aliases: ["江城郎中"], tier: "minor" },
      { id: "许松", characterName: "许松", roleType: "次要", status: "archived", appearanceCount: 1, pinned: false, aliases: [], tier: "minor" },
    ],
  })
  sightingsMock.mockResolvedValue({
    version: 1,
    sightings: [
      { characterName: "地下铁门守卫", aliases: ["老韩"], roleType: "", appearanceCount: 1, firstChapter: 5, lastChapter: 5, chapters: [5] },
    ],
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function render(searchQuery = "") {
  await act(async () => root.render(<PersonaTreeSection searchQuery={searchQuery} />))
}

async function openActiveGroup() {
  await act(async () => host.querySelector<HTMLElement>('[data-testid="persona-tree-active-toggle"]')!.click())
}

describe("PersonaTreeSection（大纲第一栏的人物小传）", () => {
  it("已建档人物按重要和出场次数排列，候选按最近章排列，同分保留原位", async () => {
    const skill = (name: string, count: number, pinned = false) => ({
      id: name, characterName: name, aliases: [], status: "active", appearanceCount: count, pinned,
    })
    const sighting = (name: string, lastChapter: number, appearanceCount: number) => ({
      characterName: name, aliases: [], lastChapter, appearanceCount,
    })
    indexMock.mockResolvedValue({ version: 1, skills: [
      skill("同分乙", 3), skill("高频", 13), skill("重点", 1, true), skill("同分甲", 3),
    ] })
    sightingsMock.mockResolvedValue({ version: 1, sightings: [
      sighting("早期", 2, 5), sighting("新面孔", 10, 1), sighting("近期多次", 10, 2),
    ] })
    await render()
    await openActiveGroup()
    await act(async () => host.querySelector<HTMLElement>('[data-testid="persona-tree-candidates-toggle"]')!.click())
    const names = [...host.querySelectorAll(".is-leaf .ui-test-ptree-name")].map((row) => row.textContent)
    expect(names).toEqual(["重点", "高频", "同分乙", "同分甲", "近期多次", "新面孔", "早期"])
  })

  it("按姓名和别名跨组查找，清空后恢复原来的折叠状态", async () => {
    await render()
    await openActiveGroup()
    const rowNames = () => [...host.querySelectorAll(".is-leaf .ui-test-ptree-name")].map(row => row.textContent)
    await render("寒")
    expect(rowNames()).toEqual(["杨寒"])
    await render("  hAN ")
    expect(rowNames()).toEqual(["杨寒"])
    await render("江城")
    expect(rowNames()).toEqual(["杨津艺", "闻修"])
    expect([...host.querySelectorAll(".is-group")].map(row => row.textContent)).toEqual(["潜伏角色1", "归档角色1"])
    await render("老韩")
    expect(rowNames()).toEqual(["地下铁门守卫"])
    await act(async () => host.querySelector<HTMLButtonElement>(".is-leaf")!.click())
    expect(storeState.setPersonaOutlinePane).toHaveBeenCalledWith({ mode: "candidate", name: "地下铁门守卫" })
    await render("无人匹配")
    expect(host.querySelector('[role="status"]')?.textContent).toBe("没有找到匹配的人物")
    await render("")
    expect(rowNames()).toEqual(["杨寒"])
  })

  it("人物页签直接显示四个一级分组，各组独立计数并默认折叠", async () => {
    await render()
    const section = host.querySelector('[data-testid="persona-tree-section"]')!
    const groups = [...section.children]
    expect(groups.map(group => group.textContent)).toEqual(["活跃角色1", "潜伏角色1", "归档角色2", "候选角色1"])
    expect(groups.every(group => group.getAttribute("aria-expanded") === "false")).toBe(true)
  })

  it("各组使用对应的状态颜色，独立显示重要和冻结标记", async () => {
    await render()
    await openActiveGroup()
    const active = host.querySelector('[data-testid="persona-tree-item-杨寒"]')!
    expect(active.getAttribute("data-persona-status")).toBe("active")
    expect(active.querySelector(".ui-test-ptree-check")).not.toBeNull()
    expect(host.querySelector('[data-testid="persona-tree-item-杨津艺"]')).toBeNull()
    await act(async () => host.querySelector<HTMLElement>('[data-testid="persona-tree-dormant-toggle"]')!.click())
    const dormant = host.querySelector('[data-testid="persona-tree-item-杨津艺"]')!
    expect(dormant.getAttribute("data-persona-status")).toBe("dormant")
    expect(dormant.textContent).toContain("冻")
  })

  it.each([["杨津艺", "dormant"], ["闻修", "archived"]])("恢复已选人物 %s 时根据异步载入的索引展开对应分组", async (name, group) => {
    storeState.personaOutlinePane = { mode: "persona", id: name }
    await render()
    expect(host.querySelector('[data-testid="persona-tree-active-toggle"]')?.getAttribute("aria-expanded")).toBe("false")
    expect(host.querySelector(`[data-testid="persona-tree-${group}-toggle"]`)?.getAttribute("aria-expanded")).toBe("true")
    const row = host.querySelector(`[data-testid="persona-tree-item-${name}"]`)
    expect(row?.classList.contains("is-on")).toBe(true)
  })

  it("点角色只切中栏内容，不跳整页视图", async () => {
    await render()
    await openActiveGroup()
    await act(async () =>
      host.querySelector<HTMLElement>('[data-testid="persona-tree-item-杨寒"]')!.click(),
    )
    expect(storeState.setPersonaOutlinePane).toHaveBeenCalledWith({ mode: "persona", id: "杨寒" })
  })

  it("区段里不再有「新建人物角色」按钮：统一走顶部新建菜单", async () => {
    await render()
    expect(host.querySelector('[data-testid="persona-tree-create"]')).toBeNull()
  })

  it("候选角色右键出菜单：建档 / 删除", async () => {
    await render()
    await act(async () =>
      host.querySelector<HTMLElement>('[data-testid="persona-tree-candidates-toggle"]')!.click(),
    )
    const row = host.querySelector<HTMLElement>('[data-testid="persona-tree-candidate-地下铁门守卫"]')!
    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 20 }))
    })
    const menu = host.querySelector('[data-testid="persona-tree-menu"]')!
    expect(menu).not.toBeNull()
    expect(menu.querySelector('[data-testid="persona-tree-menu-promote"]')).not.toBeNull()
    expect(menu.querySelector('[data-testid="persona-tree-menu-delete-candidate"]')).not.toBeNull()
  })

  it("右键菜单不会被自己的全局监听关掉（曾经右键完全没反应）", async () => {
    await render()
    await openActiveGroup()
    const row = host.querySelector<HTMLElement>('[data-testid="persona-tree-item-杨寒"]')!
    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 20 }))
    })
    // 模拟浏览器行为：contextmenu 之后事件继续冒泡到 window
    await act(async () => {
      window.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }))
    })
    expect(host.querySelector('[data-testid="persona-tree-menu"]')).not.toBeNull()
  })

  it("点菜单外部会收起菜单，点菜单内部不会", async () => {
    await render()
    await openActiveGroup()
    const row = host.querySelector<HTMLElement>('[data-testid="persona-tree-item-杨寒"]')!
    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 20 }))
    })
    // 菜单内部按下：不应收起
    await act(async () => {
      const item = host.querySelector<HTMLElement>('[data-testid="persona-tree-menu-open"]')!
      item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    })
    expect(host.querySelector('[data-testid="persona-tree-menu"]')).not.toBeNull()
    // 外部按下：收起
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    })
    expect(host.querySelector('[data-testid="persona-tree-menu"]')).toBeNull()
  })

  it("已建档角色右键只提供打开和删除，状态与重要人物由档案顶栏处理", async () => {
    await render()
    await openActiveGroup()
    const row = host.querySelector<HTMLElement>('[data-testid="persona-tree-item-杨寒"]')!
    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 20 }))
    })
    const menu = host.querySelector('[data-testid="persona-tree-menu"]')!
    expect([...menu.querySelectorAll("button")].map((item) => item.textContent?.trim())).toEqual(["打开档案", "删除角色"])
    expect(menu.querySelector("select")).toBeNull()
  })

  it("点「活跃角色」整行切换展开/折叠", async () => {
    await render()
    const toggle = host.querySelector<HTMLElement>('[data-testid="persona-tree-active-toggle"]')!
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(host.querySelector('[data-testid="persona-tree-item-杨寒"]')).toBeNull()
    await openActiveGroup()
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(host.querySelector('[data-testid="persona-tree-item-杨寒"]')).not.toBeNull()
    await act(async () => toggle.click())
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(host.querySelector('[data-testid="persona-tree-item-杨寒"]')).toBeNull()
    expect(storeState.setPersonaOutlinePane).not.toHaveBeenCalled()
  })

  it("候选角色默认折叠，展开后才出现名字", async () => {
    await render()
    expect(host.textContent).not.toContain("地下铁门守卫")
    await act(async () =>
      host.querySelector<HTMLElement>('[data-testid="persona-tree-candidates-toggle"]')!.click(),
    )
    expect(host.textContent).toContain("地下铁门守卫")
  })
})
