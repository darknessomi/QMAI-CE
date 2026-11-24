// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { discardProjectSkillDrafts, useWikiStore } from "./wiki-store"

beforeEach(() => {
  useWikiStore.setState({
    ...useWikiStore.getInitialState(),
    activeView: "sources", personaOutlinePane: { mode: "persona", id: "甲" }, personaSkillLibraryDraftDirty: true,
  })
})
afterEach(() => { vi.restoreAllMocks() })

it.each([false, true])("切换文件在草稿确认返回前保留原选择，返回 %s 后应用决定", async (answer) => {
  let respond!: (value: boolean) => void
  const pending = new Promise<boolean>(resolve => { respond = resolve })
  vi.spyOn(window, "confirm").mockImplementation(() => pending as unknown as boolean)
  const state = useWikiStore.getState()
  const navigation = state.setSelectedFile("乙.md")
  expect(await state.setActiveView("wiki")).toBe(false)
  expect(useWikiStore.getState()).toMatchObject({ selectedFile: null, personaSkillLibraryDraftDirty: true })
  respond(answer)
  expect(await navigation).toBe(answer)
  expect(useWikiStore.getState()).toMatchObject({
    selectedFile: answer ? "乙.md" : null, personaOutlinePane: answer ? null : state.personaOutlinePane,
    personaSkillLibraryDraftDirty: !answer, activeView: "sources",
  })
  expect(window.confirm).toHaveBeenCalledTimes(1)
})

it("换书后才返回的旧确认不能清除新项目的草稿", async () => {
  let respond!: (value: boolean) => void
  const pending = new Promise<boolean>(resolve => { respond = resolve })
  vi.spyOn(window, "confirm").mockImplementation(() => pending as unknown as boolean)
  const oldNavigation = discardProjectSkillDrafts()
  useWikiStore.getState().setProject({ path: "/新书", id: "new", name: "新书" })
  useWikiStore.getState().setPersonaSkillLibraryDraftDirty(true)
  respond(true)
  expect(await oldNavigation).toBe(false)
  expect(useWikiStore.getState().personaSkillLibraryDraftDirty).toBe(true)
})
