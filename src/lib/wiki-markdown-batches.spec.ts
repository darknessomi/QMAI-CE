import { beforeEach, expect, it, vi } from "vitest"
import { readMarkdownBatch } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { mapWikiMarkdown } from "./wiki-markdown-batches"

vi.mock("@/commands/fs", () => ({ readMarkdownBatch: vi.fn() }))

const read = vi.mocked(readMarkdownBatch)
beforeEach(() => { read.mockReset() })

function page(name: string, size = 64, mtimeMs = 1): FileNode {
  return { name, path: `/book/wiki/${name}`, is_dir: false, size, mtimeMs }
}

function holdReads() {
  const requests: {
    paths: string[]
    resolve: (texts: (string | null)[]) => void
    reject: (error: Error) => void
  }[] = []
  read.mockImplementation(paths => new Promise((resolve, reject) => {
    requests.push({ paths, resolve, reject })
  }))
  return requests
}

it("批量读取超过 128 页时保留顺序、空正文和大页，跳过缺页", async () => {
  const files = Array.from({ length: 131 }, (_, i) => page(`${i}.md`, i === 128 ? 2_000_000 : 64))
  read
    .mockResolvedValueOnce(files.slice(0, 128).map((f, i) => i === 1 ? null : f.name))
    .mockResolvedValueOnce(["大页"])
    .mockResolvedValueOnce(["", "末页"])

  const pages = await mapWikiMarkdown(files, (file, content) => [file.name, content])
  expect(read.mock.calls.map(([paths]) => paths))
    .toEqual([files.slice(0, 128), files.slice(128, 129), files.slice(129)].map(batch => batch.map(f => f.path)))
  expect(pages).toHaveLength(130)
  expect(pages.slice(0, 2)).toEqual([["0.md", "0.md"], ["2.md", "2.md"]])
  expect(pages.slice(-3)).toEqual([["128.md", "大页"], ["129.md", ""], ["130.md", "末页"]])
})

it("多个检索共用十六个并发名额，后返回的首批仍最先交给回调", async () => {
  const limit = 16
  const requests = holdReads()
  const files = Array.from({ length: limit + 2 }, (_, i) => page(`${i}.md`, 700_000))
  const seen: string[] = []
  const scan = mapWikiMarkdown(files, (file, text) => {
    seen.push(file.name)
    return text
  })
  const other = mapWikiMarkdown([page("另一页.md")], (_, text) => text)
  await vi.waitFor(() => expect(requests).toHaveLength(limit))
  expect(requests.map(r => r.paths)).toEqual(files.slice(0, limit).map(file => [file.path]))
  for (let i = limit - 1; i >= 1; i--) requests[i].resolve([files[i].name])
  await vi.waitFor(() => expect(requests).toHaveLength(limit + 1))
  expect(requests[limit].paths).toEqual([page("另一页.md").path])
  expect(seen).toEqual([])
  requests[limit].resolve(["其他正文"])
  await expect(other).resolves.toEqual(["其他正文"])
  requests[0].resolve([files[0].name])
  await vi.waitFor(() => expect(requests).toHaveLength(limit + 3))
  requests[limit + 2].resolve([files[limit + 1].name])
  requests[limit + 1].resolve([files[limit].name])
  const names = files.map(file => file.name)
  await expect(scan).resolves.toEqual(names)
  expect(seen).toEqual(names)
})

it("前面的批次就绪即处理，后批提前失败也按目录顺序交付", async () => {
  const requests = holdReads()
  const files = ["前", "中", "后"].map(name => page(name, 700_000))
  const seen: string[] = []
  const scan = mapWikiMarkdown(files, (_, text) => { seen.push(text); return text })
  const outcome = Promise.allSettled([scan])
  await vi.waitFor(() => expect(requests).toHaveLength(3))
  const error = new Error("最后一批读取失败")
  requests[2].reject(error)
  requests[0].resolve(["前"])
  await vi.waitFor(() => expect(seen).toEqual(["前"]))
  requests[1].resolve(["中"])
  await expect(outcome).resolves.toEqual([{ status: "rejected", reason: error }])
  expect(seen).toEqual(["前", "中"])
})

it("并行检索共享同版本同顺序的读盘，版本变化和后续检索重新读取", async () => {
  const requests = holdReads()
  const a = page("a.md")
  const b = page("b.md")
  const scan = (files: FileNode[]) => mapWikiMarkdown(files, (_, text) => text)
  const scans = Promise.all([
    scan([a, b]),
    mapWikiMarkdown([{ ...a }, { ...b }], (file, text) => file.name + text),
    scan([{ ...a, mtimeMs: 2 }, b]),
    scan([{ ...a, size: 100 }, b]),
    scan([b, a]),
  ])
  await vi.waitFor(() => expect(requests).toHaveLength(4))
  requests[0].resolve(["甲", "乙"])
  requests[1].resolve(["新版", "乙"])
  requests[2].resolve(["变长", "乙"])
  requests[3].resolve(["乙", "甲"])
  await expect(scans).resolves.toEqual([["甲", "乙"], ["a.md甲", "b.md乙"], ["新版", "乙"], ["变长", "乙"], ["乙", "甲"]])
  read.mockResolvedValueOnce(["再次读取", "乙"])
  await expect(scan([a, b])).resolves.toEqual(["再次读取", "乙"])
  expect(read).toHaveBeenCalledTimes(5)
})

it("超大文件独占读取名额，共享请求失败后释放名额并允许重试", async () => {
  const requests = holdReads()
  const scan = (name: string, size?: number) => mapWikiMarkdown([page(name, size)], (_, text) => text)
  const first = scan("前.md")
  const big = Promise.allSettled([scan("大.md", 2_000_000), scan("大.md", 2_000_000)])
  const last = scan("后.md")
  await vi.waitFor(() => expect(requests).toHaveLength(1))
  requests[0].resolve(["前"])
  await first
  await vi.waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[1].paths).toEqual([page("大.md").path])
  const error = new Error("桌面读取失败")
  requests[1].reject(error)
  await expect(big).resolves.toEqual([{ status: "rejected", reason: error }, { status: "rejected", reason: error }])
  await vi.waitFor(() => expect(requests).toHaveLength(3))
  expect(requests[2].paths).toEqual([page("后.md").path])
  requests[2].resolve(["后"])
  await expect(last).resolves.toEqual(["后"])
  read.mockResolvedValueOnce(["重试成功"])
  await expect(scan("大.md", 2_000_000)).resolves.toEqual(["重试成功"])
  expect(read).toHaveBeenCalledTimes(4)
})
