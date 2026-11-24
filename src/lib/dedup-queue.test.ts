import { describe, it, expect, beforeEach, vi } from "vitest"
import { createDeferred, flushMicrotasks } from "@/test-helpers/deferred"

vi.mock("./dedup-runner", () => ({
  executeMerge: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
}))

const TEST_ID = "test-project-uuid"
const TEST_PATH = "/project"
const TEST_ID_B = "test-project-uuid-b"
const TEST_PATH_B = "/project-b"
const idToPath: Record<string, string> = {
  [TEST_ID]: TEST_PATH,
  [TEST_ID_B]: TEST_PATH_B,
}
vi.mock("@/lib/project-identity", () => ({
  ensureProjectId: vi.fn(),
  upsertProjectInfo: vi.fn(),
  getProjectPathById: vi.fn(async (id: string) => idToPath[id] ?? null),
  getProjectIdByPath: vi.fn(),
  loadRegistry: vi.fn(),
}))

import {
  enqueueMerge,
  enqueueMergeBatch,
  cancelTask,
  cancelAllMerges,
  resumePausedMerges,
  retryTask,
  getQueue,
  pauseQueue,
  restoreQueue,
} from "./dedup-queue"
import { executeMerge } from "./dedup-runner"
import { registerDedupScanSessionApi } from "./dedup-scan-session"
import { readFile, writeFileAtomic } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { DedupRollbackError, type DuplicateGroup } from "./dedup"

const mockExecuteMerge = vi.mocked(executeMerge)
const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFileAtomic)

function makeGroup(slugs: string[]): DuplicateGroup {
  return { slugs, confidence: "high", reason: "test" }
}

async function activate(id: string = TEST_ID): Promise<void> {
  useWikiStore.getState().setProject({
    id,
    name: id,
    path: idToPath[id],
  })
  await restoreQueue(id, idToPath[id])
}

beforeEach(async () => {
  mockExecuteMerge.mockReset()
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  mockReadFile.mockRejectedValue(new Error("ENOENT"))
  mockWriteFile.mockResolvedValue(undefined as unknown as void)

  useWikiStore.getState().setLlmConfig({
    provider: "openai",
    apiKey: "test-key",
    model: "gpt-4",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  })
  useWikiStore.getState().setProviderConfigs({
    openai: {
      apiKey: "test-key",
      model: "gpt-4",
      savedModels: [{
        id: "gpt-4",
        name: "gpt-4",
        model: "gpt-4",
        createdAt: 1,
      }],
    },
  })
  useWikiStore.getState().setAiChatModel("gpt-4")
  useWikiStore.getState().setDefaultLlmModel("")

  await activate()
})

describe("dedup-queue — basic enqueue + processing", () => {
  it.each(["完成", "候选文件不存在"])("%s时，候选移除通知看到的队列已经移除该组", async (reason) => {
    if (reason === "完成") {
      mockExecuteMerge.mockResolvedValue({ canonicalContent: "", canonicalPath: "", rewrites: [], pagesToDelete: [], backup: [] })
    } else {
      mockExecuteMerge.mockRejectedValue(new Error("文件不存在"))
    }
    const remove = vi.fn(() => getQueue().length)
    registerDedupScanSessionApi({ removeGroup: remove })
    try {
      await enqueueMerge(TEST_ID, makeGroup(["甲", "乙"]), "甲")
      await flushMicrotasks(30)
      expect(remove).toHaveReturnedWith(0)
    } finally {
      registerDedupScanSessionApi(null)
    }
  })

  it("processes a queued merge and removes the task on success", async () => {
    mockExecuteMerge.mockResolvedValue({
      canonicalContent: "x",
      canonicalPath: "wiki/entities/a.md",
      rewrites: [],
      pagesToDelete: [],
      backup: [],
    })

    const id = await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    expect(id).toMatch(/^dedup-/)

    await flushMicrotasks(20)

    expect(mockExecuteMerge).toHaveBeenCalledOnce()
    expect(getQueue()).toHaveLength(0)
  })

  it("persists pending queue to disk", async () => {
    mockExecuteMerge.mockImplementation(() => new Promise(() => {}))
    await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    await flushMicrotasks(2)

    expect(mockWriteFile).toHaveBeenCalled()
    const call = mockWriteFile.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("dedup-queue.json"),
    )
    expect(call).toBeTruthy()
  })

  it("dedupes on slug-set: re-enqueueing the same group returns the same id", async () => {
    mockExecuteMerge.mockImplementation(() => new Promise(() => {}))
    const id1 = await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    const id2 = await enqueueMerge(TEST_ID, makeGroup(["b", "a"]), "b")
    expect(id2).toBe(id1)
    expect(getQueue()).toHaveLength(1)
  })

  it("批量入队一次保存全部待处理任务，保留模型选择模式，重复点击不重复入队", async () => {
    mockExecuteMerge.mockImplementation(() => new Promise(() => {}))
    const groups = Array.from({ length: 1196 }, (_, i) => makeGroup([`条目${i}`, `别名${i}`]))
    const results = await Promise.all([enqueueMergeBatch(TEST_ID, groups), enqueueMergeBatch(TEST_ID, groups.slice(5, 10))])
    expect(results).toEqual([1196, 0])
    const admission = JSON.parse(mockWriteFile.mock.calls[0][1])
    expect(admission).toHaveLength(1196)
    expect(admission.every((task: { canonicalSlug: unknown; status: string }) => task.canonicalSlug === null && task.status === "pending")).toBe(true)
    await flushMicrotasks(20)
    expect(mockWriteFile).toHaveBeenCalledTimes(2) // one admission, one transition to processing
    expect(mockExecuteMerge).toHaveBeenCalledTimes(1)
    expect(mockExecuteMerge.mock.calls[0][2]).toBeNull()
    await pauseQueue()
    mockReadFile.mockResolvedValue(JSON.stringify(admission.map((task: object) => ({ ...task, modelId: "旧模型" }))))
    await restoreQueue(TEST_ID, TEST_PATH)
    await flushMicrotasks(20)
    expect(mockExecuteMerge).toHaveBeenCalledTimes(1)
    expect(getQueue().filter((task) => task.status === "awaiting_resume")).toHaveLength(1196)
    await Promise.all([resumePausedMerges(TEST_ID, "openai/gpt-4"), resumePausedMerges(TEST_ID, "忽略重复点击")])
    await flushMicrotasks(20)
    expect(mockExecuteMerge).toHaveBeenCalledTimes(2)
    expect(getQueue().every(task => task.modelId === "openai/gpt-4")).toBe(true)
    expect(mockExecuteMerge.mock.calls[1][3].model).toBe("gpt-4")
    expect(mockExecuteMerge.mock.calls[1][2]).toBeNull()
    expect(getQueue()).toHaveLength(1196)
  })

  it("保存批量任务失败时不启动合并，可以重试", async () => {
    mockWriteFile.mockRejectedValueOnce(new Error("磁盘空间不足"))
    const groups = [makeGroup(["甲", "乙"])]
    await expect(enqueueMergeBatch(TEST_ID, groups)).rejects.toThrow("磁盘空间不足")
    expect(getQueue()).toHaveLength(0)
    expect(mockExecuteMerge).not.toHaveBeenCalled()
    mockExecuteMerge.mockImplementation(() => new Promise(() => {}))
    expect(await enqueueMergeBatch(TEST_ID, groups)).toBe(1)
  })

  it("processes serially: second task only starts after first completes", async () => {
    const d1 = createDeferred<void>()
    const d2 = createDeferred<void>()
    let calls = 0
    mockExecuteMerge.mockImplementation(async () => {
      calls++
      const which = calls
      await (which === 1 ? d1.promise : d2.promise)
      return {
        canonicalContent: "",
        canonicalPath: "",
        rewrites: [],
        pagesToDelete: [],
        backup: [],
      }
    })

    await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    await enqueueMerge(TEST_ID, makeGroup(["c", "d"]), "c")
    await flushMicrotasks(5)

    expect(mockExecuteMerge).toHaveBeenCalledTimes(1)

    d1.resolve()
    await flushMicrotasks(20)
    expect(mockExecuteMerge).toHaveBeenCalledTimes(2)

    d2.resolve()
    await flushMicrotasks(20)
    expect(getQueue()).toHaveLength(0)
  })
})

describe("dedup-queue — retries", () => {
  it("retries on failure up to MAX_RETRIES (3) before marking failed", async () => {
    mockExecuteMerge.mockRejectedValue(new Error("LLM boom"))

    await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    await flushMicrotasks(40)

    expect(mockExecuteMerge).toHaveBeenCalledTimes(3)
    const tasks = getQueue()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].status).toBe("failed")
    expect(tasks[0].retryCount).toBe(3)
    expect(tasks[0].error).toContain("LLM boom")
  })

  it("succeeds after a transient failure within retry budget", async () => {
    mockExecuteMerge
      .mockRejectedValueOnce(new Error("flaky"))
      .mockRejectedValueOnce(new Error("flaky"))
      .mockResolvedValueOnce({
        canonicalContent: "",
        canonicalPath: "",
        rewrites: [],
        pagesToDelete: [],
        backup: [],
      })

    await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    await flushMicrotasks(40)

    expect(mockExecuteMerge).toHaveBeenCalledTimes(3)
    expect(getQueue()).toHaveLength(0)
  })

  it("retryTask resets a failed task to pending and runs it again", async () => {
    mockExecuteMerge.mockRejectedValue(new Error("boom"))

    const id = await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    await flushMicrotasks(40)
    expect(getQueue()[0].status).toBe("failed")
    expect(mockExecuteMerge).toHaveBeenCalledTimes(3)

    mockExecuteMerge.mockResolvedValueOnce({
      canonicalContent: "",
      canonicalPath: "",
      rewrites: [],
      pagesToDelete: [],
      backup: [],
    })

    await retryTask(id)
    await flushMicrotasks(20)

    expect(mockExecuteMerge).toHaveBeenCalledTimes(4)
    expect(getQueue()).toHaveLength(0)
  })
})

describe("dedup-queue — cancel / delete", () => {
  it("整批取消保存失败时保留暂停队列，重试取消后再打开仍为空", async () => {
    let disk = JSON.stringify(["甲", "乙"].map((slug) => ({
      id: slug, projectId: TEST_ID, group: makeGroup([slug, slug + "2"]), canonicalSlug: null,
      status: "pending", addedAt: 0, retryCount: 0, error: null,
    })))
    mockReadFile.mockImplementation(async () => disk)
    mockWriteFile.mockImplementation(async (_path, value) => { disk = value })
    await restoreQueue(TEST_ID, TEST_PATH)
    mockWriteFile.mockRejectedValueOnce(new Error("保存失败"))
    await expect(cancelAllMerges(TEST_ID)).rejects.toThrow("保存失败")
    expect(getQueue().map(t => t.status)).toEqual(["awaiting_resume", "awaiting_resume"])
    await cancelAllMerges(TEST_ID)
    await restoreQueue(TEST_ID, TEST_PATH)
    expect(getQueue()).toHaveLength(0)
    expect(mockExecuteMerge).not.toHaveBeenCalled()
  })

  it("取消时回滚失败会显示备份位置并暂停后续组", async () => {
    const unwritten = createDeferred<never>()
    mockExecuteMerge.mockImplementationOnce(() => unwritten.promise)
    await enqueueMergeBatch(TEST_ID, [makeGroup(["甲", "乙"]), makeGroup(["丙", "丁"])])
    await flushMicrotasks(20)
    const cancelled = cancelTask(getQueue()[0].id)
    await flushMicrotasks(20)
    unwritten.reject(new DedupRollbackError("原文件备份位于备份目录"))
    await expect(cancelled).rejects.toThrow("原文件备份位于备份目录")
    expect(getQueue().map(t => t.status)).toEqual(["awaiting_resume"])
    expect(mockExecuteMerge).toHaveBeenCalledOnce()
  })

  it("cancelTask removes a pending task before it runs", async () => {
    const d = createDeferred<void>()
    mockExecuteMerge.mockImplementation(async () => {
      await d.promise
      return {
        canonicalContent: "",
        canonicalPath: "",
        rewrites: [],
        pagesToDelete: [],
        backup: [],
      }
    })

    const firstId = await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    const secondId = await enqueueMerge(TEST_ID, makeGroup(["c", "d"]), "c")
    await flushMicrotasks(5)

    // First is processing, second is pending — cancel the pending one.
    expect(getQueue().find((t) => t.id === secondId)?.status).toBe("pending")
    await cancelTask(secondId)
    expect(getQueue().find((t) => t.id === secondId)).toBeUndefined()

    d.resolve()
    await flushMicrotasks(10)
    expect(getQueue().find((t) => t.id === firstId)).toBeUndefined()
    void firstId
  })

  it("取消正在合并的组后，下一组等待文件回滚完成", async () => {
    const rollback = createDeferred<never>()
    mockExecuteMerge.mockImplementationOnce(() => rollback.promise)
      .mockImplementation(() => new Promise(() => {}))
    await enqueueMergeBatch(TEST_ID, [makeGroup(["甲", "乙"]), makeGroup(["丙", "丁"])])
    await flushMicrotasks(20)
    const cancel = cancelTask(getQueue()[0].id)
    await flushMicrotasks(20)
    expect(mockExecuteMerge).toHaveBeenCalledTimes(1)
    rollback.reject(new Error("已取消并恢复原文件"))
    await cancel
    await flushMicrotasks(20)
    expect(mockExecuteMerge).toHaveBeenCalledTimes(2)
    expect(mockExecuteMerge.mock.calls[1][1].slugs).toEqual(["丙", "丁"])
  })

  it("cancelTask aborts an in-flight processing task", async () => {
    let receivedSignal: AbortSignal | undefined
    const d = createDeferred<never>()
    mockExecuteMerge.mockImplementation(async (_pp, _g, _slug, _llm, opts) => {
      receivedSignal = opts?.signal
      // Reject when aborted
      opts?.signal?.addEventListener("abort", () => {
        d.reject(new Error("aborted"))
      })
      return d.promise
    })

    const id = await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    await flushMicrotasks(5)
    expect(receivedSignal).toBeDefined()
    expect(receivedSignal?.aborted).toBe(false)

    await cancelTask(id)
    expect(receivedSignal?.aborted).toBe(true)
    expect(getQueue().find((t) => t.id === id)).toBeUndefined()
  })
})

describe("dedup-queue — pauseQueue / restoreQueue", () => {
  it("pauseQueue persists state, restoreQueue brings it back", async () => {
    let captured = ""
    mockWriteFile.mockImplementation(async (path: string, content: string) => {
      if (path.includes("dedup-queue.json") && path.startsWith(TEST_PATH)) {
        captured = content
      }
    })
    // Hold execution so the task stays pending across pause.
    mockExecuteMerge.mockImplementation(() => new Promise(() => {}))

    await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    await flushMicrotasks(5)

    await pauseQueue()
    expect(getQueue()).toHaveLength(0)
    expect(JSON.parse(captured)[0].status).toBe("awaiting_resume")

    // Restore: read returns the captured content.
    mockReadFile.mockImplementation(async (path: string) => {
      if (path.startsWith(TEST_PATH)) return captured
      throw new Error("ENOENT")
    })

    await restoreQueue(TEST_ID, TEST_PATH)
    const restored = getQueue()
    expect(restored).toHaveLength(1)
    expect(restored[0].group.slugs).toEqual(["a", "b"])
  })

  it("旧版正在执行的任务在重开后等待手动继续", async () => {
    const persisted = JSON.stringify([
      {
        id: "dedup-interrupted",
        autoResume: true,
        projectId: TEST_ID,
        group: { slugs: ["a", "b"], confidence: "high", reason: "x" },
        canonicalSlug: "a",
        status: "processing",
        addedAt: 1,
        error: null,
        retryCount: 0,
      },
    ])
    mockReadFile.mockImplementation(async (path: string) =>
      path.startsWith(TEST_PATH) ? persisted : Promise.reject(new Error("ENOENT")),
    )
    mockExecuteMerge.mockResolvedValue({
      canonicalContent: "",
      canonicalPath: "",
      rewrites: [],
      pagesToDelete: [],
      backup: [],
    })

    await restoreQueue(TEST_ID, TEST_PATH)
    await flushMicrotasks(20)

    expect(mockExecuteMerge).not.toHaveBeenCalled()
    expect(getQueue()[0].status).toBe("awaiting_resume")
    await resumePausedMerges(TEST_ID)
    await flushMicrotasks(20)
    expect(mockExecuteMerge).toHaveBeenCalledOnce()
    expect(getQueue()).toHaveLength(0)
  })

  it("does not leak tasks across project switch", async () => {
    mockExecuteMerge.mockImplementation(() => new Promise(() => {}))

    await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    expect(getQueue().length).toBe(1)

    await pauseQueue()
    await restoreQueue(TEST_ID_B, TEST_PATH_B)
    expect(getQueue().length).toBe(0)
  })
})
