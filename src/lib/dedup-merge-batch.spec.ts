import { beforeEach, expect, it, vi } from "vitest"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { estimateChatMessagesTokens } from "./chat-request-budget"
import type { DuplicateGroup } from "./dedup"
import { cancelAllMerges, cancelTask, enqueueMergeBatch, getMergeCounts, pauseQueue, getMergeProgress, getQueue, restoreQueue, resumePausedMerges } from "./dedup-queue"
import { streamChat } from "./llm-client"
import { deleteFile } from "@/commands/fs"
import { createDeferred, flushIO, waitFor } from "@/test-helpers/deferred"

const { files, model } = vi.hoisted(() => ({
  files: new Map<string, string>(),
  model: { provider: "openai", model: "test", maxContextSize: 100_000, maxOutputTokens: 40_000 } as LlmConfig,
}))
vi.mock("./project-identity", () => ({ getProjectPathById: async () => "/book" }))
vi.mock("./novel/model-resolver", () => ({ resolveDefaultModel: () => model, resolveModelConfig: () => model }))
vi.mock("./has-usable-llm", () => ({ hasUsableLlm: () => true }))
vi.mock("./llm-client", () => ({ streamChat: vi.fn(), OUTPUT_TRUNCATED_ERROR_MARKER: "输出被截断" }))
vi.mock("@/commands/fs", () => ({
  readFile: async (path: string) => {
    if (!files.has(path)) throw new Error("文件不存在：" + path)
    return files.get(path)!
  },
  fileExists: async (path: string) => files.has(path),
  writeFileAtomic: async (path: string, content: string) => { files.set(path, content) },
  deleteFile: vi.fn(async (path: string) => { files.delete(path) }),
  listDirectory: async () => [...files.keys()].filter((path) => path.startsWith("/book/wiki/"))
    .map((path) => ({ path, name: path.split("/").pop()!, is_dir: false })),
}))

interface InputGroup { id: number; pages: { slug: string; content: string }[] }
function pagePath(slug: string) { return "/book/wiki/entities/" + slug + ".md" }
function setupGroups(count: number, bodySize = 12) {
  return Array.from({ length: count }, (_, i): DuplicateGroup => {
    const slugs = ["别名" + i, "正式名" + i]
    for (const slug of slugs) files.set(pagePath(slug), `---\ntitle: ${slug}\n---\n${"事".repeat(bodySize)} [[别名0]]`)
    return { slugs, confidence: "high", reason: "" }
  })
}
function results(groups: InputGroup[]) {
  return groups.map(({ id, pages }) => ({
    id, canonicalSlug: pages[1].slug, content: pages[1].content,
  })).reverse()
}
function mockModel(respond: (groups: InputGroup[]) => unknown | Promise<unknown> = (groups) => ({ results: results(groups) })) {
  const calls: { groups: InputGroup[]; input: number; output: number }[] = []
  vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks, _signal, overrides) => {
    const groups = JSON.parse(String(messages[1].content)) as InputGroup[]
    calls.push({ groups, input: estimateChatMessagesTokens(messages), output: Number(overrides?.max_tokens) })
    const response = await respond(groups)
    callbacks.onToken(typeof response === "string" ? response : JSON.stringify(response))
    callbacks.onDone()
  })
  return calls
}
async function finish(groups: DuplicateGroup[]) {
  await enqueueMergeBatch("book", groups)
  await waitFor(() => getQueue().every((task) => task.status === "failed"))
  await flushIO()
}

beforeEach(async () => {
  files.clear()
  vi.clearAllMocks()
  model.maxContextSize = 100_000
  model.maxOutputTokens = 40_000
  useWikiStore.getState().setProject({ id: "book", path: "/book", name: "测试" })
  await restoreQueue("book", "/book")
})

it("20 组完整正文按 50k 分批，在一轮回复中分别选主条目并累积公共引用更新", async () => {
  const groups = setupGroups(20, 2600)
  const index = "/book/wiki/chapters/引文.md"
  files.set(index, groups.map((group) => "[[" + group.slugs[0] + "]]").join(" "))
  const calls = mockModel()
  await finish(groups)
  expect(getQueue()).toHaveLength(0)
  expect(calls.map((call) => call.groups.length)).toEqual([5, 5, 5, 5])
  for (const { input, output, groups: payload } of calls) {
    expect(input + output).toBeLessThanOrEqual(50_000)
    expect(input + output).toBeGreaterThan(45_000)
    expect(payload[0].pages[0].content).toContain("事".repeat(2600))
  }
  for (const group of groups) {
    expect(files.has(pagePath(group.slugs[0]))).toBe(false)
    expect(files.get(pagePath(group.slugs[1]))).toContain("[[正式名0]]")
    expect(files.get(index)).toContain("[[" + group.slugs[1] + "]]")
  }
})

it("模型回复与实际合并分别计数，重开后从原进度继续", async () => {
  const groups = setupGroups(8, 2600)
  const gate = createDeferred()
  const requests = mockModel(async input => {
    if (input.length === 3) await gate.promise
    return { results: results(input) }
  })
  await enqueueMergeBatch("book", groups)
  await waitFor(() => requests.length === 2)
  expect(getMergeProgress()).toMatchObject({ stage: "merging", requestGroups: 3 })
  expect(getMergeCounts("book")).toEqual({ merged: 5, skipped: 0, cancelled: 0 })
  await pauseQueue()
  await restoreQueue("book", "/book")
  gate.resolve()
  expect(getQueue().map(t => t.status)).toEqual(Array(3).fill("awaiting_resume"))
  expect(getMergeCounts("book").merged).toBe(5)
  await cancelTask(getQueue()[2].id)
  await resumePausedMerges("book")
  await waitFor(() => getQueue().length === 0)
  expect(getMergeCounts("book")).toEqual({ merged: 7, skipped: 0, cancelled: 1 })
})

it.each([
  { window: 8000, outputCap: 8000 },
  { window: 50000, outputCap: 1800 },
])("尊重较小的窗口 $window 和输出上限 $outputCap", async ({ window, outputCap }) => {
  model.maxContextSize = window
  model.maxOutputTokens = outputCap
  const calls = mockModel()
  await finish(setupGroups(9, 450))
  expect(getQueue()).toHaveLength(0)
  expect(calls.length).toBeGreaterThan(1)
  for (const call of calls) {
    expect(call.input + call.output).toBeLessThanOrEqual(window)
    expect(call.output).toBeLessThanOrEqual(outputCap)
  }
})

it("同批取消的组不会写盘，外部编辑过的组重新读取后才送模型", async () => {
  const groups = setupGroups(3)
  const path = pagePath("正式名1")
  let first = true
  const calls = mockModel(async (input) => {
    if (first) {
      first = false
      await cancelTask(getQueue().find((task) => task.group.slugs[0] === "别名2")!.id)
      files.set(path, files.get(path)! + " 作者新写的内容")
    }
    return { results: results(input) }
  })
  await finish(groups)
  expect(calls.map((call) => call.groups.length)).toEqual([3, 1])
  expect(files.get(path)).toContain("作者新写的内容")
  expect(files.has(pagePath("别名2"))).toBe(true)
  expect(getQueue()).toHaveLength(0)
})

it("重开时暂停旧队列，取消无响应的请求后可重新合并，迟到的回复无效", async () => {
  const groups = setupGroups(3)
  const path = "/book/.qmai/dedup-queue.json"
  files.set(path, JSON.stringify(groups.map((group, i) => ({
    id: "旧任务" + i, projectId: "book", status: i ? "pending" : "processing",
    canonicalSlug: null, group, autoResume: true, retryCount: 0, error: null, addedAt: 1,
  }))))
  const oldResponse = createDeferred<void>()
  const calls = mockModel(async (input) => {
    await oldResponse.promise
    return { results: results(input).map((row) => ({ ...row, content: "过期回复" })) }
  })
  await restoreQueue("book", "/book")
  expect(getQueue().map(t => t.status)).toEqual(groups.map(() => "awaiting_resume"))
  expect(calls).toHaveLength(0)
  await resumePausedMerges("book")
  await waitFor(() => calls.length === 1)
  expect(calls[0].groups).toHaveLength(3)
  const signal = vi.mocked(streamChat).mock.calls[0][3]
  await cancelAllMerges("book")
  expect(getMergeCounts("book")).toEqual({ merged: 0, skipped: 0, cancelled: 3 })
  expect(signal?.aborted).toBe(true)
  expect(getMergeProgress()).toBeNull()
  expect(getQueue()).toHaveLength(0)
  expect(JSON.parse(files.get(path)!)).toEqual([])
  expect([...files.keys()].filter(key => key.includes("/wiki/"))).toHaveLength(6)
  const restarted = mockModel()
  await finish(groups)
  oldResponse.resolve()
  await flushIO()
  expect(getMergeCounts("book")).toEqual({ merged: 3, skipped: 0, cancelled: 0 })
  expect(restarted.map(call => call.groups.length)).toEqual([3])
  expect(getQueue()).toHaveLength(0)
  for (const group of groups) {
    expect(files.has(pagePath(group.slugs[0]))).toBe(false)
    expect(files.get(pagePath(group.slugs[1]))).toContain("事")
  }
})

it("整批取消发生在文件写入中时，只撤回当前组，已完成的组保留，余下组可重选", async () => {
  const groups = setupGroups(3)
  const calls = mockModel()
  // The first completed group legitimately rewrites links in both pages of the next one.
  const originalAlias = files.get(pagePath("别名1"))!.replace("[[别名0]]", "[[正式名0]]")
  const originalMain = files.get(pagePath("正式名1"))!.replace("[[别名0]]", "[[正式名0]]")
  const deleting = createDeferred()
  const completeDelete = createDeferred()
  vi.mocked(deleteFile)
    .mockImplementationOnce(async path => { files.delete(path) })
    .mockImplementationOnce(async path => {
      deleting.resolve()
      await completeDelete.promise
      files.delete(path)
    })
  await enqueueMergeBatch("book", groups)
  await deleting.promise
  const cancel = cancelAllMerges("book")
  await waitFor(() => getQueue().length === 0)
  completeDelete.resolve()
  await cancel
  expect(files.has(pagePath("别名0"))).toBe(false)
  expect(files.get(pagePath("别名1"))).toBe(originalAlias)
  expect(files.get(pagePath("正式名1"))).toBe(originalMain)
  expect(files.has(pagePath("别名2"))).toBe(true)
  await finish(groups.slice(1))
  expect(getQueue()).toHaveLength(0)
  expect(calls.map(call => call.groups.length)).toEqual([3, 2])
})

it("回复中的重复编号与跨组主条目均不能落盘，合法组继续使用同一份回复", async () => {
  const groups = setupGroups(3)
  const calls = mockModel((input) => {
    const rows = results(input)
    for (const row of [...rows]) {
      if (row.canonicalSlug === "正式名0") rows.push(row)
      if (row.canonicalSlug === "正式名1") row.canonicalSlug = "正式名2"
    }
    return { results: rows }
  })
  await finish(groups)
  expect(getQueue().map((task) => task.group.slugs[0])).toEqual(["别名0", "别名1"])
  expect(files.has(pagePath("别名0")) && files.has(pagePath("别名1"))).toBe(true)
  expect(files.has(pagePath("别名2"))).toBe(false)
  expect(calls.filter((call) => call.groups.some((g) => g.pages[0].slug === "别名2"))).toHaveLength(1)
})

it("单组完整输入装不下时保留原文并继续下一组", async () => {
  const [large] = setupGroups(1, 51_000)
  const other = { ...large, slugs: ["另名", "正名"] }
  for (const slug of other.slugs) files.set(pagePath(slug), "---\ntitle: 小组\n---\n正文")
  const original = files.get(pagePath("别名0"))
  const calls = mockModel()
  await finish([large, other])
  expect(calls).toHaveLength(1)
  expect(getQueue()[0].error).toContain("token 预算")
  expect(files.get(pagePath("别名0"))).toBe(original)
  expect(files.has(pagePath("另名"))).toBe(false)
})

it.each(["不完整 JSON", "输出被截断", "context_length_exceeded"])("遇到%s时自动缩小批次，已合并的组不再提交", async (failure) => {
  const calls = mockModel((groups) => {
    if (groups.length > 2) {
      if (failure === "不完整 JSON") return '{"results":['
      throw new Error(failure)
    }
    return { results: results(groups) }
  })
  await finish(setupGroups(4))
  expect(calls.map((call) => call.groups.length)).toEqual([4, 2, 2])
  expect(calls[2].groups.map((g) => g.pages[0].slug)).toEqual(["别名2", "别名3"])
  expect(getQueue()).toHaveLength(0)
})

it("共享候选页面的两组分开读取和合并，后面的组能使用前一次写入的主条目", async () => {
  const groups = setupGroups(2)
  const overlap = { ...groups[0], slugs: ["正式名0", "正式名1"] }
  const calls = mockModel()
  await finish([groups[0], overlap])
  expect(calls.map((call) => call.groups.length)).toEqual([1, 1])
  expect(calls[1].groups[0].pages[0].content).toContain("[[正式名0]]")
  expect(files.has(pagePath("正式名0"))).toBe(false)
  expect(files.has(pagePath("正式名1"))).toBe(true)
})
