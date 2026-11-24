// @vitest-environment jsdom
import { act, Profiler } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import type { DedupScanCacheEntry } from "@/lib/dedup-scan-cache"
import type { DedupTask, getMergeProgress } from "@/lib/dedup-queue"
import { removeMergedDedupGroupFromSession } from "@/lib/dedup-scan-session"
import { MaintenanceSection } from "./maintenance-section"

const mocks = vi.hoisted(() => ({
  load: vi.fn(), missing: vi.fn(), enqueueBatch: vi.fn(), enqueueSingle: vi.fn(),
  queue: [] as DedupTask[], save: vi.fn(), logs: [] as string[],
  resume: vi.fn(), cancelAll: vi.fn(),
  counts: { merged: 0, skipped: 0, cancelled: 0 }, progress: null as ReturnType<typeof getMergeProgress>,
}))
vi.mock("@/lib/dedup-scan-cache", () => ({ loadDedupScanCache: mocks.load, saveDedupScanCache: mocks.save }))
vi.mock("@/lib/dedup-model-prefs", () => ({ loadDedupModelPrefs: async () => ({ detectModelId: "检测", mergeModelId: "合并甲" }), saveDedupModelPrefs: async () => {} }))
vi.mock("@/components/chat/chat-model-selector", () => ({
  ChatModelSelector: ({ value, onChange }: { value: string; onChange: (id: string) => void }) =>
    <button onClick={() => onChange("合并乙")}>{value}</button>,
}))
vi.mock("@/lib/dedup-runner", () => ({ missingDedupSlugs: mocks.missing }))
vi.mock("@/lib/dedup-queue", async (original) => ({
  ...await original<typeof import("@/lib/dedup-queue")>(),
  getMergeCounts: () => mocks.counts, getMergeProgress: () => mocks.progress,
  getQueue: () => mocks.queue, getMergeLogs: () => mocks.logs, ensureQueueActive: async () => {},
  enqueueMergeBatch: mocks.enqueueBatch, enqueueMerge: mocks.enqueueSingle,
  resumePausedMerges: mocks.resume, cancelAllMerges: mocks.cancelAll,
}))
vi.mock("@/lib/foreshadowing-cleanup-queue", () => ({ ensureForeshadowingCleanupQueueActive: async () => {}, getForeshadowingCleanupQueue: () => [] }))
vi.mock("@/lib/has-usable-llm", () => ({ hasUsableLlm: () => true }))
vi.mock("./memory-cleanup-tool", () => ({ MemoryCleanupTool: () => null }))
vi.mock("./context-cache-maintenance", () => ({ ContextCacheMaintenance: () => null }))

it("维护页载入 1196 组时只挂载本页卡片，默认勾选高置信，跨页和跨组批量入队", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.useFakeTimers()
  const project = { id: "book", path: "/book", name: "测试项目" }
  const groups: DedupScanCacheEntry[] = Array.from({ length: 1196 }, (_, i) => ({
    group: { slugs: [`甲${i}`, `乙${i}`], reason: "名称相近", confidence: i < 600 ? "high" : i < 1000 ? "medium" : "low" },
    skipped: false, canonicalSlug: `甲${i}`,
  }))
  mocks.queue.push({
    ...groups[0], id: "queued", projectId: project.id, status: "pending", error: null, addedAt: 0, retryCount: 0,
  })
  mocks.load.mockResolvedValue({ groups, projectId: project.id, scannedPageCount: 2000 })
  mocks.missing.mockResolvedValue([])
  mocks.save.mockResolvedValue(undefined)
  mocks.enqueueBatch.mockResolvedValue(622)
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
  useWikiStore.getState().setProviderConfigs({ openai: { enabled: true, model: "合并甲" } })
  useWikiStore.getState().setProject(project)

  const host = document.createElement("div")
  const root = createRoot(host)
  const rendered = vi.fn()
  const checks = () => [...host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")]
  const buttons = () => [...host.querySelectorAll("button")]
  const click = async (label: string) => {
    const button = buttons().find((item) => item.textContent === label)
    expect(button, label).toBeDefined()
    await act(async () => button!.click())
  }
  try {
    await act(async () => root.render(<Profiler id="maintenance" onRender={rendered}><MaintenanceSection /></Profiler>))
    expect(checks()).toHaveLength(25)
    expect(checks()[0].disabled).toBe(true)
    expect(checks().filter((input) => input.checked)).toHaveLength(24)
    const count = rendered.mock.calls.length
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(rendered.mock.calls.length).toBe(count)
    mocks.counts = { merged: 7, skipped: 1, cancelled: 1 }
    mocks.queue[0].status = "processing"
    mocks.progress = { taskId: "queued", stage: "merging", requestGroups: 1, requestedAt: Date.now() }
    await act(async () => { vi.advanceTimersByTime(500) })
    const bar = host.querySelector("progress")!
    expect([bar.value, bar.max]).toEqual([7, 10])
    expect(host.textContent).toContain("等待模型回复（本次请求 1 组）")
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(host.textContent).toContain("已等待 0:02")
    mocks.progress = { taskId: "queued", stage: "writing" }
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(host.textContent).toContain("正在备份并写入文件")
    expect([bar.value, bar.max]).toEqual([7, 10])
    const log = host.querySelector("pre")
    expect(log?.classList.contains("h-40")).toBe(true)
    for (const length of [3, 20, 0]) {
      mocks.logs = Array.from({ length }, (_, i) => `进度 ${i}`)
      await act(async () => { vi.advanceTimersByTime(500) })
      expect(host.querySelector("pre")).toBe(log)
      expect(log?.textContent).toBe(mocks.logs.join("\n") || "…")
    }
    await click("下一页")
    await act(async () => checks()[0].click()) // deselect high group 25
    await click("中置信度（400）")
    expect(checks().every((box) => !box.checked)).toBe(true)
    await click("选中本页")
    await click("低置信度（196）")
    expect(checks().every((box) => !box.checked)).toBe(true)
    await click("批量合并（623 组）")
    expect(mocks.missing).not.toHaveBeenCalled()
    expect(mocks.enqueueBatch).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    mocks.missing.mockResolvedValueOnce(["乙1"])
    await click("批量合并（623 组）")
    expect(mocks.missing).toHaveBeenCalledTimes(1)
    expect(mocks.enqueueBatch.mock.calls[0][2]).toBe("合并甲")
    const submitted = mocks.enqueueBatch.mock.calls[0][1]
    expect(submitted).toEqual(groups.slice(2, 625).filter((_, i) => i + 2 !== 25).map((entry) => entry.group))
    expect(mocks.enqueueSingle).not.toHaveBeenCalled()
    await click("清空选择")
    await click("全选所有候选")
    expect(buttons().some((b) => b.textContent === "批量合并（1194 组）")).toBe(true)
    await act(async () => host.querySelectorAll<HTMLInputElement>("input[type=radio]")[1].click())
    await click("合并到 乙1000")
    expect(mocks.enqueueSingle.mock.calls[0].slice(0, 3)).toEqual(["book", groups[1000].group, "乙1000"])
    mocks.queue[0].status = "awaiting_resume"
    mocks.resume.mockImplementation(async () => { mocks.queue[0].status = "processing" })
    mocks.cancelAll.mockImplementation(async () => { mocks.queue.length = 0 })
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(host.querySelector('[aria-label="合并队列"]')?.textContent).toContain("1 组已暂停")
    await click("合并甲")
    await click("继续合并（1 组）")
    expect(mocks.resume).toHaveBeenCalledExactlyOnceWith("book", "合并乙")
    await click("取消全部合并")
    expect(mocks.cancelAll).toHaveBeenCalledExactlyOnceWith("book")
    expect(host.querySelector('[aria-label="合并队列"]')?.textContent).toContain("本轮已结束")
    await click("批量合并（1195 组）")
    expect(mocks.enqueueBatch.mock.calls.at(-1)?.[1]).toHaveLength(1195)
    mocks.queue.push({
      ...groups[0], projectId: project.id, id: "完成组", status: "processing", addedAt: 0, retryCount: 0, error: null,
    })
    await act(async () => { vi.advanceTimersByTime(500) })
    mocks.queue.length = 0
    await act(async () => removeMergedDedupGroupFromSession(project.id, groups[0].group.slugs))
    expect(host.textContent).not.toContain("进行中的合并任务")
    expect(host.querySelector('[aria-label="合并队列"]')?.textContent).toContain("本轮已结束")
  } finally {
    await act(async () => root.unmount())
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
