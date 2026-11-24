import { beforeEach, expect, test, vi } from "vitest"
import type { EmbeddingConfig, LlmConfig } from "@/stores/wiki-store"
import type { EntitySummary } from "./dedup"
import { detectDuplicateGroups } from "./dedup"
import { buildDetectionBatches, pairBatches, windowBatches } from "./dedup-candidates"
import { executeMerge, resolveDedupPages, runDuplicateDetection } from "./dedup-runner"
import { estimateContextTokens } from "./context-hub/token-estimator"
import { loadDedupScanCache } from "./dedup-scan-cache"
import { fetchEmbeddings } from "./embedding"
import { streamChat } from "./llm-client"
import { deleteFile, listDirectory, writeFileAtomic } from "@/commands/fs"

const memory = vi.hoisted(() => new Map<string, string>())
vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(),
  deleteFile: vi.fn(),
  fileExists: async (path: string) => memory.has(path),
  readFile: async (path: string) => memory.get(path),
  writeFileAtomic: vi.fn(async (path: string, data: string) => { memory.set(path, data) }),
}))
vi.mock("./embedding", () => ({ fetchEmbeddings: vi.fn() }))
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))

const cfg: EmbeddingConfig = { enabled: true, endpoint: "https://example.test/embeddings", model: "test", apiKey: "" }
const llm = { provider: "openai", model: "mock" } as LlmConfig
function summaries(n: number): EntitySummary[] {
  return Array.from({ length: n }, (_, i) => {
    const slug = `page-${String(i).padStart(4, "0")}`
    return { slug, path: "wiki/entities/" + slug + ".md", title: slug, tags: ["人物"], type: "entity", description: "这是本书的实体摘要。" }
  })
}
// Deterministic fixture: the first and last pages are synonyms; each intervening page is unrelated.
function vectors(texts: string[], n: number) {
  return texts.map(text => {
    const index = Number(text.match(/^page-(\d+)/)?.[1])
    return Array.from({ length: n }, (_, i) => Number(i === (index === n - 1 ? 0 : index)))
  })
}

beforeEach(() => {
  memory.clear()
  vi.resetAllMocks()
  vi.mocked(writeFileAtomic).mockImplementation(async (path, data) => { memory.set(path, data) })
})

test("80/81-page windows bound requests and overlap by eight", () => {
  expect(windowBatches(summaries(80)).map(b => b.length)).toEqual([80])
  const [first, second] = windowBatches(summaries(81))
  expect([first.length, second.length]).toEqual([80, 9])
  expect(second.slice(0, 8)).toEqual(first.slice(-8))
})

test("explicit aliases at opposite ends get an extra shared batch without embeddings", async () => {
  const pages = summaries(180)
  pages[179].aliases = [pages[0].title]
  const { batches } = await buildDetectionBatches("/project", pages, null, [], () => {})
  expect(batches.some(batch => batch.includes(pages[0]) && batch.includes(pages[179]))).toBe(true)
})

test("every edge of an oversized cluster survives, including one crossing a full batch", () => {
  const pages = summaries(200)
  const edges = pages.slice(1).map((_, i) => [i, i + 1] as const)
  const batches = pairBatches(pages, edges, [])
  expect(batches.every(batch => batch.length <= 80)).toBe(true)
  for (const [a, b] of edges) expect(batches.some(batch => batch.includes(pages[a]) && batch.includes(pages[b]))).toBe(true)
})

test("covers 250/251 empty-candidate boundary and falls back for inadequate vector coverage", async () => {
  for (const count of [250, 251]) {
    const pages = summaries(count)
    vi.mocked(fetchEmbeddings).mockResolvedValue(pages.map((_, index) => Array.from({ length: count }, (_, i) => Number(index === i))))
    const result = await buildDetectionBatches("/" + count, pages, cfg, [], () => {})
    expect(result.batches.length > 0).toBe(count === 250)
    expect(result.coverage).toContain(`${count}/${count}`)
  }
  vi.mocked(fetchEmbeddings).mockResolvedValue([])
  const result = await buildDetectionBatches("/broken", summaries(251), cfg, [], () => {})
  expect(result.batches.length).toBeGreaterThan(0)
  expect(result.coverage).toContain("覆盖 0/251")
})

test("cached summaries survive rescans, changed text, model changes and deletion", async () => {
  const pages = summaries(5)
  vi.mocked(fetchEmbeddings).mockImplementation(async texts => vectors(texts, 5))
  const scan = (entries: EntitySummary[], config = cfg) => buildDetectionBatches("/project", entries, config, [], () => {})
  await scan(pages)
  await scan(pages)
  expect(fetchEmbeddings).toHaveBeenCalledTimes(1)
  pages[2].description = "修改摘要"
  await scan(pages.slice(1))
  expect(vi.mocked(fetchEmbeddings).mock.calls[1][0]).toHaveLength(1)
  expect([...memory.values()][0]).not.toContain(pages[0].path)
  await scan(pages.slice(1), { ...cfg, model: "different" })
  expect(vi.mocked(fetchEmbeddings).mock.calls[2][0]).toHaveLength(4)
})

test("coverage gaps past 5000 are disclosed and get bounded fallback", async () => {
  vi.mocked(fetchEmbeddings).mockImplementation(async texts => texts.map(() => null))
  const pages = summaries(5001)
  const result = await buildDetectionBatches("/project", pages, cfg, [], () => {})
  expect(vi.mocked(fetchEmbeddings).mock.calls.flatMap(([texts]) => texts)).toHaveLength(5000)
  expect(result.batches.some(b => b.includes(pages[5000]))).toBe(true)
  expect(result.coverage).toContain("覆盖 0/5001")
})

test("cancellation prevents later batches, and opening an old result cache makes no model calls", async () => {
  const cache = "/project/.qmai/dedup-scan-cache.json"
  memory.set(cache, JSON.stringify({ version: 1, projectId: "p", scannedAt: 1, scannedPageCount: 10, groups: [] }))
  expect((await loadDedupScanCache("/project"))?.groups).toEqual([])
  expect(fetchEmbeddings).not.toHaveBeenCalled()
  expect(streamChat).not.toHaveBeenCalled()
  const controller = new AbortController()
  vi.mocked(streamChat).mockImplementation(async (_cfg, _msgs, cb) => {
    controller.abort()
    cb.onToken('{"groups":[]}')
    cb.onDone()
  })
  await expect(runDuplicateDetection("/project", llm, { summaries: summaries(181), signal: controller.signal, embeddingConfig: null })).rejects.toThrow("已取消")
  expect(streamChat).toHaveBeenCalledTimes(1)
})

test("rejects white-listed pairs even inside larger groups and resolves merges only to unique entity/concept paths", async () => {
  const pages = summaries(3)
  const slugs = pages.map(p => p.slug)
  const detected = await detectDuplicateGroups(pages, async () => JSON.stringify({ groups: [{ slugs }] }), { notDuplicates: [slugs.slice(0, 2)] })
  expect(detected).toEqual([])
  const chapter = { path: `wiki/chapters/${slugs[0]}.md` }
  expect(resolveDedupPages([...pages, chapter], slugs)[0].path).toBe(pages[0].path)
  expect(() => resolveDedupPages([...pages, { path: `wiki/concepts/${slugs[0]}.md` }], slugs)).toThrow("同名")
})

test("measures candidate recall, prompt estimates and request counts on the same synthetic chapters", async () => {
  const pages = summaries(260)
  const a = pages[0].slug
  const b = pages[pages.length - 1].slug
  const oracle = (prompt: string) => JSON.stringify({ groups: prompt.includes(a) && prompt.includes(b) ? [{ slugs: [a, b], confidence: "high" }] : [] })
  let promptTokens = 0
  let calls = 0
  const record = (system: string, user: string) => {
    calls++
    promptTokens += estimateContextTokens(system + user)
    return oracle(user)
  }
  vi.mocked(fetchEmbeddings).mockImplementation(async texts => vectors(texts, pages.length))
  vi.mocked(streamChat).mockImplementation(async (_cfg, msgs, cb) => {
    cb.onToken(record(String(msgs[0].content), String(msgs[1].content)))
    cb.onDone()
  })
  const metrics = []
  for (const phase of ["old", "cold", "warm"]) {
    calls = 0
    promptTokens = 0
    vi.mocked(fetchEmbeddings).mockClear()
    const start = performance.now()
    const found = phase === "old" ? await detectDuplicateGroups(pages, async (s,u) => record(s,u))
      : (await runDuplicateDetection("/book", llm, { summaries: pages, embeddingConfig: cfg })).groups
    metrics.push({ phase, ms: +(performance.now() - start).toFixed(2), modelCalls: calls, estimatedInputTokens: promptTokens,
      embeddingTexts: vi.mocked(fetchEmbeddings).mock.calls.reduce((n, [texts]) => n + texts.length, 0), hits: found.length })
  }
  expect(metrics.map(m => m.hits)).toEqual([1,1,1])
  expect(metrics.map(m => m.embeddingTexts)).toEqual([0,260,0])
  expect(metrics[1].estimatedInputTokens).toBeLessThan(metrics[0].estimatedInputTokens)
  if (process.env.QMAI_DEDUP_BENCH) console.log(JSON.stringify(metrics))
})

test("批量任务收到组外主条目时不写入或删除任何项目文件", async () => {
  const paths = ["wiki/entities/甲.md", "wiki/entities/乙.md"]
  vi.mocked(listDirectory).mockResolvedValue(paths.map(path => ({ name: path.split("/").pop()!, is_dir: false, path: "/book/" + path })))
  for (const path of paths) memory.set("/book/" + path, "---\ntype: entity\n---\n原文")
  vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
    callbacks.onToken("组外名字\n---\ntitle: 组外名字\n---\n正文")
    callbacks.onDone()
  })
  await expect(executeMerge("/book", { slugs: ["甲", "乙"], confidence: "high", reason: "" }, null, llm)).rejects.toThrow("组内有效的主条目")
  expect(writeFileAtomic).not.toHaveBeenCalled()
  expect(deleteFile).not.toHaveBeenCalled()
})

test("merge failures restore the source pages, backlinks and index before the queue may retry", async () => {
  const paths = ["wiki/entities/a.md", "wiki/entities/b.md", "wiki/entities/c.md", "wiki/index.md"]
  const original = [
    "---\ntype: entity\ntitle: A\n---\n原 A",
    "---\ntype: entity\ntitle: B\n---\n原 B",
    "---\ntype: entity\ntitle: C\n---\n关联 [[b]]",
    "- [B](entities/b.md)\n",
  ]
  paths.forEach((path, i) => memory.set("/book/" + path, original[i]))
  vi.mocked(listDirectory).mockResolvedValue(paths.map(path => ({ name: path.split("/").pop()!, is_dir: false, path: "/book/" + path })))
  vi.mocked(deleteFile).mockRejectedValue(new Error("磁盘错误"))
  vi.mocked(streamChat).mockImplementation(async (_cfg, _messages, cb) => {
    cb.onToken("---\ntype: entity\ntitle: A\n---\n合并正文")
    cb.onDone()
  })
  await expect(executeMerge("/book", { slugs: ["a", "b"], reason: "", confidence: "high" }, "a", llm)).rejects.toThrow("磁盘错误")
  expect(paths.map(path => memory.get("/book/" + path))).toEqual(original)
  expect([...memory.keys()].filter(path => path.includes("/page-history/"))).toHaveLength(4)
})

test("cancelling an in-flight embedding wait does not start a detector or persist partial vectors", async () => {
  const controller = new AbortController()
  let started!: () => void
  const pending = new Promise<void>(resolve => { started = resolve })
  vi.mocked(fetchEmbeddings).mockImplementation(async () => {
    started()
    return new Promise<never>(() => {})
  })
  const run = runDuplicateDetection("/project", llm, { summaries: summaries(100), embeddingConfig: cfg, signal: controller.signal })
  await pending
  controller.abort()
  await expect(run).rejects.toThrow("已取消")
  expect(streamChat).not.toHaveBeenCalled()
  expect(writeFileAtomic).not.toHaveBeenCalled()
})
