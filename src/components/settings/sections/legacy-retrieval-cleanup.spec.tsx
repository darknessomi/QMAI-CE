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
const summariesButton = "清理当前项目旧社区摘要"
const appButton = "清理应用旧模型凭据"
afterEach(() => {
  vi.resetAllMocks()
  useWikiStore.setState({ project: null })
})

it.each([
  [projectButton, "clear_legacy_project_retrieval", 4, "已清理当前项目的 4 项"],
  [summariesButton, "clear_legacy_community_summaries", { removed: 3, skipped: 1 }, "已清理当前项目的 3 份旧社区摘要。已保留 1 个其他条目。"],
] as const)("%s 需要单独确认，切书后取消，项目命令只接收确认过的项目路径", async (label, command, result, message) => {
  const panel = await mountModel(<LegacyRetrievalCleanup project={book} />)
  try {
    useWikiStore.setState({ project: book })
    vi.mocked(confirmAction).mockResolvedValueOnce(false)
    await click(panel.host, label)
    expect(invoke).not.toHaveBeenCalled()
    vi.mocked(confirmAction).mockResolvedValue(true)
    useWikiStore.setState({ project: { ...book, path: "/books/two" } })
    await click(panel.host, label)
    expect(invoke).not.toHaveBeenCalled()
    useWikiStore.setState({ project: book })
    vi.mocked(invoke).mockResolvedValueOnce(result)
    await click(panel.host, label)
    expect(confirmAction).toHaveBeenCalledWith(expect.stringContaining(book.path), expect.stringContaining("当前项目"))
    expect(invoke).toHaveBeenCalledExactlyOnceWith(command, { projectPath: book.path })
    expect(panel.host.textContent).toContain(message)
  } finally {
    await panel.unmount()
  }
})

it("未打开项目仍可单独清理应用凭据，取消不会调用后端", async () => {
  const panel = await mountModel(<LegacyRetrievalCleanup project={null} />)
  try {
    expect(button(panel.host, projectButton).disabled).toBe(true)
    expect(button(panel.host, summariesButton).disabled).toBe(true)
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

it("社区摘要清理区分失败和没有可清理的记录，支持重试", async () => {
  useWikiStore.setState({ project: book })
  const panel = await mountModel(<LegacyRetrievalCleanup project={book} />)
  try {
    vi.mocked(confirmAction).mockResolvedValue(true)
    vi.mocked(invoke).mockRejectedValueOnce("无法检查摘要目录")
    await click(panel.host, summariesButton)
    expect(panel.host.textContent).toContain("清理失败：无法检查摘要目录")
    vi.mocked(invoke).mockResolvedValueOnce({ removed: 0, skipped: 0 })
    await click(panel.host, summariesButton)
    expect(panel.host.textContent).toContain("当前项目没有可清理的旧社区摘要")
  } finally {
    await panel.unmount()
  }
})
