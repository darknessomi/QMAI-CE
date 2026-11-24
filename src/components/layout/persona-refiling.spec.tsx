// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { PersonaPane } from "@/components/skill-library/persona-pane"
import { createPersonaSkillByUser, demotePersonaSkillToSighting, refreshPersonaSkillStatuses } from "@/lib/novel/persona-skill-learning"
import { loadPersonaSkillState, updatePersonaSkillIndex } from "@/lib/novel/persona-skill-store"
import { useWikiStore } from "@/stores/wiki-store"
import { PersonaTreeSection } from "./persona-tree-section"

const files = vi.hoisted(() => new Map<string, string>())
vi.mock("@/commands/fs", () => ({
  fileExists: async (path: string) => files.has(path),
  readFile: async (path: string) => {
    if (!files.has(path)) throw new Error(`文件不存在：${path}`)
    return files.get(path)!
  },
  writeFileAtomic: async (path: string, value: string) => { files.set(path, value) },
  listDirectory: async () => [],
  createDirectory: async () => {},
}))

const projectPath = "/test/novel"
const characterName = "林清越"
const originalOrder = ["周岚", characterName, "许南"]
let root: Root
let host: HTMLElement
const scrollIntoView = vi.fn<HTMLElement["scrollIntoView"]>()
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView")

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView })
})
afterAll(() => {
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll)
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView")
})

function element(id: string) {
  const target = host.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  expect(target, id).not.toBeNull()
  return target!
}

async function click(id: string) {
  await act(async () => element(id).click())
}

function headerStatus() {
  const header = element("persona-profile-name").closest("header")
  const select = header?.querySelector<HTMLSelectElement>('select[aria-label="人物状态"]')
  expect(select).toBeTruthy()
  return select!
}

async function chooseStatus(value: string) {
  const select = headerStatus()
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.spyOn(window, "confirm").mockReturnValue(true)
  files.clear()
  useWikiStore.setState(useWikiStore.getInitialState())
  useWikiStore.getState().setProject({ id: "book", name: "测试书稿", path: projectPath })
  for (const name of originalOrder) {
    await createPersonaSkillByUser({
      projectPath, characterName: name, roleType: "主角", fields: name === characterName ? { 背景: "旧城钟表匠。" } : {},
    })
  }
  useWikiStore.getState().setPersonaOutlinePane({ mode: "persona", id: characterName })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<><PersonaTreeSection /><PersonaPane /></>))
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it("从顶栏手动归档后仍跟踪出场进度，恢复自动时进入最新分组", async () => {
  const row = () => element(`persona-tree-item-${characterName}`)
  await chooseStatus("archived")
  expect(row().dataset.personaStatus).toBe("archived")
  expect(element("persona-tree-archived-toggle").textContent).toContain("归档角色1")
  expect(element("persona-tree-active-toggle").textContent).toContain("活跃角色2")

  await act(async () => {
    await refreshPersonaSkillStatuses(projectPath, 18)
    useWikiStore.getState().bumpPersonaDataVersion()
  })
  expect(row().dataset.personaStatus).toBe("archived")
  const archived = (await loadPersonaSkillState(projectPath)).index.skills[1]
  expect(archived).toMatchObject({ id: characterName, status: "dormant", manualStatus: "archived" })

  await chooseStatus("auto")
  expect(row().dataset.personaStatus).toBe("dormant")
  expect(row().classList.contains("is-on")).toBe(true)
  expect(element("persona-tree-dormant-toggle").textContent).toContain("潜伏角色3")
  expect((await loadPersonaSkillState(projectPath)).index.skills[1].manualStatus).toBeUndefined()
})

it("在研究页从顶栏调整当前人物分组时保留原文草稿", async () => {
  await click("persona-page-research")
  const editor = element("persona-skill-editor") as HTMLTextAreaElement
  const draft = editor.value + "\n## 待核实\n尚未保存的笔记"
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, draft)
    editor.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await chooseStatus("dormant")
  expect(element(`persona-tree-item-${characterName}`).dataset.personaStatus).toBe("dormant")
  expect(element("persona-profile-name").textContent).toBe(characterName)
  expect((element("persona-skill-editor") as HTMLTextAreaElement).value).toBe(draft)
  expect(useWikiStore.getState().personaSkillLibraryDraftDirty).toBe(true)
})

it("取消移入候选时顶栏恢复所选状态，人物留在原组", async () => {
  await chooseStatus("archived")
  vi.mocked(window.confirm).mockReturnValue(false)
  await chooseStatus("candidate")
  expect(window.confirm).toHaveBeenCalledTimes(1)
  expect(headerStatus().value).toBe("archived")
  expect(element(`persona-tree-item-${characterName}`).dataset.personaStatus).toBe("archived")
  expect((await loadPersonaSkillState(projectPath)).sightings.sightings).toHaveLength(0)
})

it.each(["候选预览", "侧栏右键", "同名新建"])("从%s重新建档，人物回到活跃组原位置并选中", async (entry) => {
  await chooseStatus("candidate")
  expect(element("persona-candidate-preview").textContent).toContain(characterName)
  // 模拟用户在候选区操作时已收起活跃组。
  if (element("persona-tree-active-toggle").getAttribute("aria-expanded") === "true") {
    await click("persona-tree-active-toggle")
  }
  if (element("persona-tree-candidates-toggle").getAttribute("aria-expanded") !== "true") {
    await click("persona-tree-candidates-toggle")
  }
  const candidate = element(`persona-tree-candidate-${characterName}`)
  scrollIntoView.mockClear()
  if (entry === "侧栏右键") {
    await act(async () => {
      candidate.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }))
    })
    await click("persona-tree-menu-promote")
  } else if (entry === "同名新建") {
    await act(async () => useWikiStore.getState().setPersonaOutlinePane({ mode: "create" }))
    await act(async () => {
      const input = element("persona-create-name")
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, characterName)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await click("persona-create-submit")
  } else {
    await click("persona-candidate-promote")
  }

  const state = await loadPersonaSkillState(projectPath)
  expect(state.index.skills.map((meta) => meta.characterName)).toEqual(originalOrder)
  expect(state.index.skills[1].status).toBe("active")
  expect(state.sightings.sightings).toHaveLength(0)
  expect(host.querySelector(`[data-testid="persona-tree-candidate-${characterName}"]`)).toBeNull()
  expect(element("persona-profile-name").textContent).toBe(characterName)
  expect((element("persona-field-背景") as HTMLTextAreaElement).value).toBe("旧城钟表匠。")
  const activeRow = element(`persona-tree-item-${characterName}`)
  expect(activeRow.classList.contains("is-on")).toBe(true)
  expect(scrollIntoView.mock.contexts.at(-1)).toBe(activeRow)
  expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" })
  const visibleNames = Array.from(host.querySelectorAll('[data-testid^="persona-tree-item-"] .ui-test-ptree-name'))
    .map((element) => element.textContent)
  expect(visibleNames).toEqual(originalOrder)
})

function deferConfirmation() {
  let respond!: (confirmed: boolean) => void
  // 桌面端使用异步原生弹窗，浏览器的类型声明只包含同步版本。
  const pending = new Promise<boolean>((resolve) => { respond = resolve })
  vi.mocked(window.confirm).mockImplementationOnce(() => pending as unknown as boolean)
  return (confirmed: boolean) => act(async () => respond(confirmed))
}

it.each(["侧栏", "详情"])("%s删除同名人物时等待确认，取消后可重试，确认后只移除选中的档案", async (entry) => {
  const [sibling, target] = originalOrder
  await act(async () => {
    await updatePersonaSkillIndex(projectPath, (index) => ({
      ...index, skills: index.skills.map((meta) => meta.id === sibling ? { ...meta, characterName: target } : meta),
    }))
    useWikiStore.getState().bumpPersonaDataVersion()
    useWikiStore.getState().setPersonaOutlinePane({ mode: "persona", id: entry === "侧栏" ? sibling : target })
  })
  const rows = () => host.querySelectorAll<HTMLElement>(`[data-testid="persona-tree-item-${target}"]`)
  async function requestDeletion() {
    if (entry === "详情") return click("persona-delete")
    await act(async () => { rows()[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })) })
    await click("persona-tree-menu-delete-persona")
  }

  await act(async () => useWikiStore.getState().setPersonaSkillLibraryDraftDirty(true))
  const before = new Map(files)
  for (const answer of [false, true]) {
    const respond = deferConfirmation()
    await requestDeletion()
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining(`档案编号：${target}`))
    if (entry === "详情") expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining("未保存"))
    expect(rows()).toHaveLength(2)
    expect(files).toEqual(before)
    await respond(answer)
    if (!answer) {
      expect(rows()).toHaveLength(2)
      expect(files).toEqual(before)
    }
  }
  expect((await loadPersonaSkillState(projectPath)).index.skills.map((meta) => meta.id)).toEqual([sibling, "许南"])
  expect(rows()).toHaveLength(1)
  expect(window.confirm).toHaveBeenCalledTimes(2)
  expect(useWikiStore.getState().personaSkillLibraryDraftDirty).toBe(entry === "侧栏")
  expect(useWikiStore.getState().personaOutlinePane).toEqual(entry === "侧栏" ? { mode: "persona", id: sibling } : null)
})

it.each(["候选预览", "侧栏右键"])("%s删除候选时等待确认，取消不会写入忽略名单", async (entry) => {
  await act(async () => {
    await demotePersonaSkillToSighting({ projectPath, id: characterName })
    useWikiStore.getState().bumpPersonaDataVersion()
    useWikiStore.getState().setPersonaOutlinePane({ mode: "candidate", name: characterName })
  })
  const before = new Map(files)
  const respond = deferConfirmation()
  if (entry === "侧栏右键") {
    await act(async () => {
      element(`persona-tree-candidate-${characterName}`).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }))
    })
    await click("persona-tree-menu-delete-candidate")
  } else {
    await click("persona-candidate-delete")
  }
  expect(files).toEqual(before)
  await respond(false)
  expect(files).toEqual(before)
  expect(element("persona-candidate-preview").textContent).toContain(characterName)
})
