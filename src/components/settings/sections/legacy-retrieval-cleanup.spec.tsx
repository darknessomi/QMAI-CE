// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core"
import { afterEach, expect, it, vi } from "vitest"
import { confirmAction } from "@/lib/confirm-action"
import { useWikiStore } from "@/stores/wiki-store"
import { button, click, mountModel } from "@/components/uitest/models/model-test-utils"
import { LegacyRetrievalCleanup } from "./legacy-retrieval-cleanup"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))
vi.mock("@/lib/confirm-action", () => ({ confirmAction: vi.fn() }))

const book = { path: "/books/one", name: "第一本", id: "one" }
const projectButton = "清理当前项目旧索引和配置"
const appButton = "清理应用旧模型凭据"
afterEach(() => {
  vi.resetAllMocks()
  useWikiStore.setState({ project: null })
})

it("需要单独确认，切书后取消，项目命令只接收确认过的项目路径", async () => {
  const panel = await mountModel(<LegacyRetrievalCleanup project={book} />)
  try {
    useWikiStore.setState({ project: book })
    vi.mocked(confirmAction).mockResolvedValueOnce(false)
    await click(panel.host, projectButton)
    expect(invoke).not.toHaveBeenCalled()
    vi.mocked(confirmAction).mockResolvedValue(true)
    useWikiStore.setState({ project: { ...book, path: "/books/two" } })
    await click(panel.host, projectButton)
    expect(invoke).not.toHaveBeenCalled()
    useWikiStore.setState({ project: book })
    vi.mocked(invoke).mockResolvedValueOnce(4)
    await click(panel.host, projectButton)
    expect(invoke).toHaveBeenCalledExactlyOnceWith("clear_legacy_project_retrieval", { projectPath: book.path })
    expect(panel.host.textContent).toContain("已清理当前项目的 4 项")
  } finally {
    await panel.unmount()
  }
})

it("未打开项目仍可单独清理应用凭据，取消不会调用后端", async () => {
  const panel = await mountModel(<LegacyRetrievalCleanup project={null} />)
  try {
    expect(button(panel.host, projectButton).disabled).toBe(true)
    vi.mocked(confirmAction).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await click(panel.host, appButton)
    expect(invoke).not.toHaveBeenCalled()
    vi.mocked(invoke).mockResolvedValueOnce(false)
    await click(panel.host, appButton)
    expect(invoke).toHaveBeenCalledExactlyOnceWith("clear_legacy_retrieval_credentials")
    expect(panel.host.textContent).toContain("应用内没有旧模型配置或凭据")
  } finally {
    await panel.unmount()
  }
})
