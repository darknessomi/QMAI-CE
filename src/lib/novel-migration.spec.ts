import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MigrationView } from "./novel-migration"
import { chooseMigrationAction, ensureProjectMigrated, getMigrationView, MigrationReturned, restoreDesktopMigration, setMigrationShelfReturn } from "./novel-migration"

const native = vi.hoisted(() => ({
  invoke: vi.fn(), flush: vi.fn(), listener: undefined as undefined | ((event: {payload: MigrationView | null}) => void),
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }))
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name, fn) => { native.listener = fn; return () => { native.listener = undefined } }),
}))
vi.mock("./platform", () => ({ isTauri: () => true }))
vi.mock("./pre-close-flush", () => ({ runPreCloseFlushes: native.flush }))
vi.mock("./migration-reader-flush", () => ({ flushMigrationReaders: vi.fn() }))
vi.mock("./web-store", () => ({ flushAppState: vi.fn() }))
vi.mock("@/stores/wiki-store", () => ({ useWikiStore: { getState: () => ({ project: null }) } }))

const oldBook = "/books/old"
const preparing: MigrationView = { path: oldBook, phase: "preparing", stage: "准备", completed: 0, total: 0, detail: "", canLeave: false }

describe("项目打开前的迁移守卫", () => {
  let view: MigrationView | null
  let worker: (rollback: boolean) => Promise<void>
  beforeEach(() => {
    view = { ...preparing }
    native.flush.mockReset().mockResolvedValue({ ran: 0, failed: 0 })
    setMigrationShelfReturn(undefined)
    worker = async () => { view = null }
    native.invoke.mockReset().mockImplementation(async (cmd, args) => {
      switch (cmd) {
        case "inspect_novel_migration":
        case "novel_migration_status": return view
        case "run_novel_migration": return worker(args.rollback)
        case "leave_novel_migration": view = null; return
        case "fail_novel_migration_preparation":
          view = { ...preparing, phase: "failed", detail: args.detail, canLeave: true }
          return
        default: throw Error("未知命令")
      }
    })
  })

  it("普通新项目直接打开", async () => {
    view = null
    await ensureProjectMigrated(oldBook)
    expect(native.invoke.mock.calls.map(([name]) => name)).toEqual(["inspect_novel_migration"])
  })

  it("同一项目并发打开只执行一次，等待原生完成期间禁止切书", async () => {
    let complete!: () => void
    worker = async () => {
      await new Promise<void>((resolve) => { complete = resolve })
      view = null
    }
    const first = ensureProjectMigrated(oldBook)
    const second = ensureProjectMigrated(oldBook)
    expect(first).toBe(second)
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"))
    await expect(ensureProjectMigrated("/books/other")).rejects.toThrow("另一个项目")
    expect(getMigrationView()?.path).toBe(oldBook)
    complete()
    await first
    expect(getMigrationView()).toBe(null)
    expect(native.flush).toHaveBeenCalledOnce()
  })

  it("已保存修改失败时保持锁定，重试先重新保存", async () => {
    native.flush.mockResolvedValueOnce({ ran: 0, failed: 1 })
    const opening = ensureProjectMigrated(oldBook)
    await vi.waitFor(() => expect(getMigrationView()?.phase).toBe("failed"))
    expect(native.invoke.mock.calls.some(([name]) => name === "run_novel_migration")).toBe(false)
    chooseMigrationAction("retry")
    await opening
    expect(native.flush).toHaveBeenCalledTimes(2)
  })

  it("原项目未受影响的错误允许退出，并实际调用书架切换", async () => {
    const shelf = vi.fn(async () => undefined)
    setMigrationShelfReturn(shelf)
    worker = async () => {
      view = { ...preparing, phase: "failed", detail: "写入临时目录失败", canLeave: true }
      throw Error(view.detail)
    }
    const opening = ensureProjectMigrated(oldBook)
    await vi.waitFor(() => expect(getMigrationView()?.phase).toBe("failed"))
    chooseMigrationAction("leave")
    await expect(opening).rejects.toBeInstanceOf(MigrationReturned)
    expect(shelf).toHaveBeenCalledOnce()
    expect(getMigrationView()).toBeNull()
  })

  it("重启发现未完成任务先恢复；中断后拒绝返回书架，显式回滚后才释放", async () => {
    worker = async (rollback) => {
      if (rollback) { view = null; return }
      view = { ...preparing, phase: "failed", detail: "恢复文件失败", canLeave: false }
      throw Error(view.detail)
    }
    const opening = restoreDesktopMigration()
    await vi.waitFor(() => expect(getMigrationView()?.phase).toBe("failed"))
    chooseMigrationAction("leave")
    expect(native.invoke.mock.calls.some(([name]) => name === "leave_novel_migration")).toBe(false)
    chooseMigrationAction("rollback")
    await expect(opening).rejects.toBeInstanceOf(MigrationReturned)
    expect(getMigrationView()).toBeNull()
  })
})
