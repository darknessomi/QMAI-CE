import { beforeEach, expect, it, vi } from "vitest"
import { createDeferred, flushMicrotasks } from "@/test-helpers/deferred"
import { useWikiStore } from "@/stores/wiki-store"
import { enqueueMerge, ensureQueueActive, getQueue, pauseQueue, retryTask } from "./dedup-queue"
import {
  ensureForeshadowingCleanupQueueActive, getForeshadowingCleanupQueue, pauseForeshadowingCleanupQueue,
  retryForeshadowingCleanupTask,
} from "./foreshadowing-cleanup-queue"

const { disk, chat, apply, embedding, indexed, slowRead } = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  chat: vi.fn(),
  apply: vi.fn(),
  embedding: vi.fn(),
  indexed: { value: true },
  slowRead: { wait: null as Promise<void> | null },
}))
vi.mock("@/commands/fs", () => ({
  readFile: async (path: string) => {
    if (slowRead.wait) await slowRead.wait
    if (!disk.has(path)) throw Error("ENOENT")
    return disk.get(path)
  },
  writeFileAtomic: async (path: string, content: string) => { disk.set(path, content) },
  writeFile: async (path: string, content: string) => { disk.set(path, content) },
  fileExists: async (path: string) => path.endsWith("/lancedb") ? indexed.value : disk.has(path),
}))
vi.mock("@/lib/project-identity", () => ({ getProjectPathById: async (id: string) => "/" + id }))
vi.mock("@/lib/has-usable-llm", () => ({ hasUsableLlm: () => true }))
vi.mock("@/lib/novel/model-resolver", () => ({ resolveDefaultModel: () => ({}), resolveModelConfig: () => ({}) }))
vi.mock("@/lib/dedup-scan-cache", () => ({ removeGroupFromDedupScanCache: async () => {} }))
vi.mock("@/lib/foreshadowing-cleanup-cache", () => ({ removeIssueFromForeshadowingScanCache: async () => {} }))
vi.mock("@/lib/dedup-runner", () => ({ executeMerge: (...args: unknown[]) => chat(...args) }))
vi.mock("@/lib/foreshadowing-cleanup-runner", () => ({
  resolveCurrentChapter: () => 5,
  executeCleanupTask: (...args: unknown[]) => apply(...args),
}))

const merge = { id: "old-merge", projectId: "A", status: "processing", group: { slugs: ["a", "b"], confidence: "high" as const, reason: "异名" }, canonicalSlug: "a", retryCount: 0, addedAt: 1, error: null }
const cleanup = { id: "old-cleanup", projectId: "A", status: "pending", issue: { ids: ["p1"], kind: "noise", reason: "噪声", confidence: "high" }, retryCount: 0, addedAt: 1, error: null }
const dedupPath = "/A/.qmai/dedup-queue.json"
const cleanupPath = "/A/.qmai/foreshadowing-cleanup-queue.json"

function openProject(id: string) {
  useWikiStore.getState().setProject({ id, path: "/" + id, name: id })
  return Promise.all([ensureQueueActive(id, "/" + id), ensureForeshadowingCleanupQueueActive(id, "/" + id)])
}
function closeProject() {
  return Promise.all([pauseQueue(), pauseForeshadowingCleanupQueue()])
}

beforeEach(async () => {
  await closeProject()
  disk.clear()
  chat.mockReset()
  apply.mockReset()
  embedding.mockReset()
  indexed.value = true
  slowRead.wait = null
  useWikiStore.getState().setEmbeddingConfig({ enabled: true, endpoint: "mock", apiKey: "", model: "e" })
  apply.mockImplementation(async () => {
    if (indexed.value && useWikiStore.getState().embeddingConfig.enabled) embedding()
  })
})

it("restores legacy maintenance jobs with zero model work on open; each resumes only on request", async () => {
  disk.set(dedupPath, JSON.stringify([merge, { ...merge, id: "old-failed", status: "failed", error: "已有错误" }]))
  disk.set(cleanupPath, JSON.stringify([cleanup]))
  await openProject("A")
  await flushMicrotasks(20)
  expect(chat).not.toHaveBeenCalled()
  expect(apply).not.toHaveBeenCalled()
  expect(embedding).not.toHaveBeenCalled()
  expect(getQueue().map(t => t.status)).toEqual(["awaiting_resume", "failed"])
  expect(getForeshadowingCleanupQueue()[0].status).toBe("awaiting_resume")
  await closeProject()
  await openProject("A")
  expect(chat).not.toHaveBeenCalled()
  expect(embedding).not.toHaveBeenCalled()
  await retryTask(merge.id)
  await flushMicrotasks(30)
  expect(chat).toHaveBeenCalledTimes(1)
  expect(embedding).not.toHaveBeenCalled()
  await retryForeshadowingCleanupTask(cleanup.id)
  await flushMicrotasks(30)
  expect(embedding).toHaveBeenCalledTimes(1)
  expect(getQueue().map(t => t.id)).toEqual(["old-failed"])
})

it("only gates model-backed legacy cleanup; opening without a vector database retains local cleanup", async () => {
  indexed.value = false
  disk.set(cleanupPath, JSON.stringify([cleanup]))
  await openProject("A")
  await flushMicrotasks(25)
  expect(apply).toHaveBeenCalledTimes(1)
  expect(embedding).not.toHaveBeenCalled()
})

it("hydrates newly created interrupted tasks after switching away and back, keeping legacy neighbors held", async () => {
  disk.set(dedupPath, JSON.stringify([merge]))
  disk.set(cleanupPath, JSON.stringify([cleanup, { ...cleanup, id: "new-cleanup", autoResume: true, status: "processing" }]))
  await openProject("A")
  await flushMicrotasks(25)
  expect(embedding).toHaveBeenCalledTimes(1)
  chat.mockImplementationOnce(() => new Promise(() => {}))
  const newId = await enqueueMerge("A", { ...merge.group, slugs: ["c", "d"] }, "c")
  await flushMicrotasks(10)
  expect(chat).toHaveBeenCalledTimes(1)
  await closeProject()
  await openProject("B")
  expect(getQueue()).toHaveLength(0)
  await closeProject()
  await openProject("A")
  await flushMicrotasks(30)
  expect(chat).toHaveBeenCalledTimes(1)
  expect(getQueue().map(t => t.status)).toEqual(["awaiting_resume", "awaiting_resume"])
  await retryTask(newId)
  await flushMicrotasks(30)
  expect(chat).toHaveBeenCalledTimes(2)
  expect(getQueue().map(t => [t.id, t.status])).toEqual([[merge.id, "awaiting_resume"]])
  expect(getForeshadowingCleanupQueue().map(t => t.id)).toEqual([cleanup.id])
})

it("a maintenance-panel activation during startup shares the pending disk load", async () => {
  disk.set(dedupPath, JSON.stringify([merge]))
  const gate = createDeferred<void>()
  slowRead.wait = gate.promise
  const startup = openProject("A")
  const added = enqueueMerge("A", { ...merge.group, slugs: ["e", "f"] }, "e")
  await flushMicrotasks(5)
  expect(chat).not.toHaveBeenCalled()
  gate.resolve()
  await Promise.all([startup, added])
  await flushMicrotasks(25)
  expect(chat).toHaveBeenCalledTimes(1)
  expect(getQueue().map(t => t.id)).toEqual([merge.id])
})
