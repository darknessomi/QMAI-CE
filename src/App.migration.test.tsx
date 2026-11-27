// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import App from "./App"
import { NovelMigrationDialog } from "@/components/project/novel-migration-dialog"
import type { MigrationView } from "@/lib/novel-migration"
import { useWikiStore } from "@/stores/wiki-store"

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), settings: new Map<string, unknown>() }))

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
  invoke: mocks.invoke,
}))
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/event")>(),
  listen: async () => () => undefined,
}))
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: async () => () => undefined, setTitle: async () => undefined }),
}))
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/platform")>(),
  isTauri: () => true,
}))
vi.mock("@/lib/web-store", () => ({
  getStore: async () => ({
    get: async (key: string) => mocks.settings.get(key),
    set: async (key: string, value: unknown) => { mocks.settings.set(key, value) },
    delete: async (key: string) => mocks.settings.delete(key),
    save: async () => undefined,
  }),
  flushAppState: async () => undefined,
}))
vi.mock("@/lib/migration-reader-flush", () => ({ flushMigrationReaders: async () => undefined }))
vi.mock("@/lib/reset-project-state", () => ({ resetProjectState: async () => undefined }))
vi.mock("@/components/uitest/ui-test-shell", () => ({ UiTestShell: () => <main>书架</main> }))

it("启动时迁移失败并返回书架后加载全局配置，且不自动重新打开项目", async () => {
  const preparing: MigrationView = {
    path: "/books/old", phase: "preparing", stage: "正在准备迁移", detail: "",
    completed: 0, total: 0, canLeave: false,
  }
  let view: MigrationView | null = preparing
  const migrationError = "旧 cognition-state.json 有无法从正文快照复现的认知内容"
  mocks.invoke.mockImplementation(async (command: string, args?: { detail: string }) => {
    switch (command) {
      case "novel_migration_status":
      case "inspect_novel_migration":
        return view
      case "run_novel_migration":
        view = { ...preparing, phase: "failed", stage: "迁移未完成", detail: migrationError, canLeave: true }
        throw new Error(migrationError)
      case "fail_novel_migration_preparation":
        view = { ...preparing, phase: "failed", stage: "迁移未完成", detail: args?.detail ?? "", canLeave: true }
        return
      case "leave_novel_migration":
        view = null
    }
  })

  const savedModel = { ...useWikiStore.getState().llmConfig, model: "saved-global-model" }
  const previousBook = { id: "recent", name: "上次打开的小说", path: "/books/recent" }
  mocks.settings.set("llmConfig", savedModel)
  mocks.settings.set("theme__uiTest", "dark")
  mocks.settings.set("lastProject", previousBook)

  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false } },
  })
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = createRoot(host)
  const returnButton = () => [...host.querySelectorAll("button")].find((button) => button.textContent === "返回书架")

  try {
    await act(async () => root.render(<><App /><NovelMigrationDialog /></>))
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(returnButton()).toBeDefined()
    })
    expect(host.querySelector("[role=alert]")?.textContent).toBe(migrationError)
    await act(async () => returnButton()?.click())
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(host.querySelector("main")?.textContent).toBe("书架")
    })

    expect(useWikiStore.getState().llmConfig.model).toBe(savedModel.model)
    expect(useWikiStore.getState().theme).toBe("dark")
    expect(useWikiStore.getState().project).toBeNull()
    expect(mocks.settings.get("llmConfig")).toMatchObject({ model: savedModel.model })
    expect(mocks.settings.get("lastProject")).toEqual(previousBook)
    expect(mocks.invoke).toHaveBeenCalledWith("leave_novel_migration")
    const inspections = mocks.invoke.mock.calls.filter(([command]) => command === "inspect_novel_migration")
    expect(inspections).toEqual([["inspect_novel_migration", { path: "/books/old" }]])
  } finally {
    act(() => root.unmount())
    host.remove()
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal")
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close")
    vi.unstubAllGlobals()
  }
})
