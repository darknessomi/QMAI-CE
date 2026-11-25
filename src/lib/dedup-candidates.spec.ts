import { beforeEach, expect, test, vi } from "vitest"
import type { JevConfig, LlmConfig } from "@/stores/wiki-store"
import type { EntitySummary } from "./dedup"
import { detectDuplicateGroups } from "./dedup"
import { buildBasicDetectionBatches, pairBatches, windowBatches } from "./dedup-candidates"
import { executeMerge, loadAllEntitySummaries, resolveDedupPages, runDuplicateDetection } from "./dedup-runner"
import { loadDedupScanCache } from "./dedup-scan-cache"
import { invoke } from "@tauri-apps/api/core"
import { sagSearchFiles } from "./sag-search"
import { sha256Text } from "./context-hub/fingerprint"
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
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))
vi.mock("./sag-search", () => ({ sagSearchFiles: vi.fn() }))
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))

const cfg: JevConfig = { endpoint: "https://example.test", model: "test" }
const llm = { provider: "openai", model: "mock" } as LlmConfig
function summaries(n: number): EntitySummary[] {
  return Array.from({ length: n }, (_, i) => {
    const slug = `page-${String(i).padStart(4, "0")}`
    return { slug, path: "wiki/entities/" + slug + ".md", title: slug, tags: ["人物"], type: "entity", description: "这是本书的实体摘要。" }
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

test("带尾分隔符的 Windows 项目路径可读取 QM 实体和 wiki 概念", async () => {
  const paths = ["QM/entities/甲.md", "wiki/concepts/乙.md"]
  const absolute = paths.map(path => "C:\\book\\" + path.replaceAll("/", "\\"))
  vi.mocked(listDirectory).mockResolvedValue(absolute.map(path => ({ name: path.split("\\").pop()!, is_dir: false, path })))
  for (const path of absolute) memory.set(path, "---\ntype: entity\n---\n正文")
  const summaries = await loadAllEntitySummaries("C:\\book\\")
  expect(summaries.map(page => page.path)).toEqual(paths)
})

test("explicit aliases at opposite ends get an extra shared batch without embeddings", async () => {
  const pages = summaries(180)
  pages[179].aliases = [pages[0].title]
  const batches = buildBasicDetectionBatches(pages, [])
  expect(batches.some(batch => batch.includes(pages[0]) && batch.includes(pages[179]))).toBe(true)
})

test("every edge of an oversized cluster survives, including one crossing a full batch", () => {
  const pages = summaries(200)
  const edges = pages.slice(1).map((_, i) => [i, i + 1] as const)
  const batches = pairBatches(pages, edges, [])
  expect(batches.every(batch => batch.length <= 80)).toBe(true)
  for (const [a, b] of edges) expect(batches.some(batch => batch.includes(pages[a]) && batch.includes(pages[b]))).toBe(true)
})

test("配置 JEV 时两次命中的同一对仅复核一次，证据来自双方现行原文", async () => {
  const pages = summaries(2)
  pages[0].title = "已经删除的旧称"
  const paths = pages.map(page => "/project/" + page.path)
  for (const path of paths) memory.set(path, "---\ntype: entity\n---\n# 标题\n同一个人物在旧村生活。")
  vi.mocked(sagSearchFiles).mockResolvedValue(pages.map((page, i) => ({
    title: page.title, path: paths[i].replace("/wiki/", "/QM/"), content: "过时片段", startLine: 5, endLine: 5, score: 0.9,
  })))
  vi.mocked(invoke).mockResolvedValue(0.94)
  const run = await runDuplicateDetection("/project", llm, { summaries: pages, jevConfig: cfg })
  expect(run.groups).toHaveLength(1)
  expect(run.groups[0].reason).toContain("第 5–5 行：同一个人物")
  expect(run.groups[0].reason).not.toContain("过时片段")
  expect(vi.mocked(sagSearchFiles).mock.calls.map(call => call[2])).toEqual([[paths[1]], [paths[0]]])
  const versions = await Promise.all(paths.map(async path => ({ path, contentHash: await sha256Text(memory.get(path)!) })))
  expect(vi.mocked(sagSearchFiles).mock.calls.map(call => call[5]?.querySource)).toEqual(versions)
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(invoke).toHaveBeenCalledWith("sag_judge_pair", expect.objectContaining({ projectPath: "/project", sources: versions, left: expect.stringContaining("同一个人物") }))
  expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toContain("已经删除的旧称")
  expect(streamChat).not.toHaveBeenCalled()
})

test("三页同名时也复核后两页，并跳过用户已排除的页对", async () => {
  const pages = summaries(3)
  const descriptions = ["同名的药师。", "先前署名的船长。", "改用新署名的船长。"]
  pages.forEach((page, index) => {
    page.title = "田澄"
    memory.set("/project/" + page.path, "---\ntype: entity\ntitle: 田澄\n---\n" + descriptions[index])
  })
  vi.mocked(sagSearchFiles).mockResolvedValue([])
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const { left, right } = args as { left: string; right: string }
    return left.includes("船长") && right.includes("船长") ? 0.95 : 0.02
  })
  memory.set("/project/.qmai/dedup-not-duplicates.json", JSON.stringify([[pages[0].slug, pages[2].slug]]))
  const run = await runDuplicateDetection("/project", llm, { summaries: pages, jevConfig: cfg })
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(run.groups.map(group => group.slugs)).toEqual([[pages[1].slug, pages[2].slug]])
})

test("服务错误立即终止，不返回成功结论，证据不足的候选进入独立人工核对列表", async () => {
  const pages = summaries(2)
  pages[1].aliases = [pages[0].title]
  const run = () => runDuplicateDetection("/project", llm, { summaries: pages, jevConfig: cfg })
  for (const page of pages) memory.set("/project/" + page.path, "---\ntype: entity\n---\n原文")
  vi.mocked(sagSearchFiles).mockRejectedValueOnce(new Error("HTTP 401"))
  await expect(run()).rejects.toThrow("鉴权失败")
  expect(sagSearchFiles).toHaveBeenCalledTimes(1)
  vi.mocked(sagSearchFiles).mockResolvedValue([])
  vi.mocked(invoke).mockRejectedValueOnce(new Error("无法连接"))
  await expect(run()).rejects.toThrow("无法连接")
  vi.mocked(invoke).mockResolvedValueOnce(0.5)
  expect(await run()).toMatchObject({ groups: [], manualReview: [expect.stringContaining("不确定")] })
  memory.set("/project/" + pages[0].path, "---\ntype: entity\nai_exclude: true\n---\n禁读")
  vi.mocked(invoke).mockClear()
  expect(await run()).toMatchObject({ groups: [], manualReview: [expect.stringContaining("缺少可核对")] })
  expect(invoke).not.toHaveBeenCalled()
})

test("cancellation prevents later batches, and opening an old result cache makes no model calls", async () => {
  const cache = "/project/.qmai/dedup-scan-cache.json"
  memory.set(cache, JSON.stringify({ version: 1, projectId: "p", scannedAt: 1, scannedPageCount: 10, groups: [] }))
  expect((await loadDedupScanCache("/project"))?.groups).toEqual([])
  expect(sagSearchFiles).not.toHaveBeenCalled()
  expect(streamChat).not.toHaveBeenCalled()
  const controller = new AbortController()
  vi.mocked(streamChat).mockImplementation(async (_cfg, _msgs, cb) => {
    controller.abort()
    cb.onToken('{"groups":[]}')
    cb.onDone()
  })
  await expect(runDuplicateDetection("/project", llm, { summaries: summaries(181), signal: controller.signal, jevConfig: null })).rejects.toThrow("已取消")
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

test("取消候选发现时不会开始身份复核", async () => {
  const controller = new AbortController()
  let started!: () => void
  const pending = new Promise<void>(resolve => { started = resolve })
  vi.mocked(sagSearchFiles).mockImplementation(async () => {
    started()
    return new Promise<never>(() => {})
  })
  const pages = summaries(4)
  for (const page of pages) memory.set("/project/" + page.path, "---\ntype: entity\n---\n原文")
  const run = runDuplicateDetection("/project", llm, { summaries: pages, jevConfig: cfg, signal: controller.signal })
  await pending
  controller.abort()
  await expect(run).rejects.toThrow("已取消")
  expect(invoke).not.toHaveBeenCalled()
})
