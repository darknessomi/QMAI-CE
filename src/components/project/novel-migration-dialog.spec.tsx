// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NovelMigrationDialog } from "./novel-migration-dialog"
import type { MigrationView } from "@/lib/novel-migration"

const mocks = vi.hoisted(() => ({
  view: null as MigrationView | null,
  exitNotice: undefined as undefined | (() => void),
  action: vi.fn(),
}))
vi.mock("@/lib/novel-migration", () => ({
  getMigrationView: () => mocks.view, subscribeMigration: () => () => undefined,
  migrationReturnLabel: () => "返回书架", chooseMigrationAction: mocks.action,
}))
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name, fn) => { mocks.exitNotice = fn; return () => undefined }),
}))
let root: Root
let host: HTMLElement

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false } },
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal")
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close")
})

describe("强制迁移进度窗口", () => {
  it("运行时拦截退出快捷键并说明意外中断的后果", () => {
    mocks.view = { path: "/books/test", phase: "running", stage: "准备新版文件", detail: "章节", completed: 2, total: 5, canLeave: false }
    act(() => root.render(<NovelMigrationDialog />))
    expect(host.querySelector("dialog")?.open).toBe(true)
    expect(host.querySelector("button")).toBeNull()
    expect(host.textContent).toContain("强制退出、关机或移动项目文件")
    const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true })
    window.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    act(() => mocks.exitNotice?.())
    expect(host.querySelector("[role=alert]")?.textContent).toContain("当前无法退出")
  })
  it("文件尚未恢复的错误只开放重试和恢复", () => {
    mocks.view = { path: "/books/test", phase: "failed", stage: "迁移未完成", detail: "写入失败", completed: 0, total: 0, canLeave: false }
    act(() => root.render(<NovelMigrationDialog />))
    const buttons = [...host.querySelectorAll("button")]
    expect(buttons.map((el) => el.textContent)).toEqual(["重试", "恢复原项目"])
    act(() => buttons[1].click())
    expect(mocks.action).toHaveBeenCalledWith("rollback")
  })
})
