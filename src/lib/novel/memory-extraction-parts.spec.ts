import { beforeEach, expect, it, vi } from "vitest"
import { extractMemoryInParts, finishMemoryExtraction } from "./memory-extraction-parts"
import { normalizeChapterSnapshot } from "./snapshot-format"
const files = vi.hoisted(() => new Map<string, string>())
vi.mock("@/commands/fs", () => ({
  fileExists: async (p: string) => files.has(p),
  readFile: async (p: string) => files.get(p),
  writeFileAtomic: async (p: string, text: string) => { files.set(p, text) },
  deleteFile: async (p: string) => { files.delete(p) },
}))
beforeEach(() => files.clear())
const options = { source: "甲".repeat(12000) + "章尾完成交接。", budget: 12000, projectPath: "/book", sourceKey: "chapter-3", requestKey: "same" }
function extract(body: string) {
  return normalizeChapterSnapshot({ chapterId: "chapter-3", chapterNumber: 3, summary: "摘要",
    endingHook: body.endsWith("交接。") ? "完成交接" : "", events: [body[0]],
    characters: ["林青"], characterAliases: { 林青: [body[0]] },
  })!
}
it("断点只保存完整分段，重试复用首段并从结尾取钩子", async () => {
  const first = vi.fn(async (body: string) => {
    if (body.includes("交接")) throw new Error("中断")
    return extract(body)
  })
  await expect(extractMemoryInParts({ ...options, extract: first })).rejects.toThrow("中断")
  expect(first).toHaveBeenCalledTimes(2)
  const retry = vi.fn(async (body: string) => extract(body))
  const { snapshot, checkpointPath } = await extractMemoryInParts({ ...options, extract: retry })
  expect(retry).toHaveBeenCalledTimes(1)
  expect(snapshot.endingHook).toBe("完成交接")
  expect(snapshot.events).toEqual(["甲", "章"])
  expect(snapshot.characterAliases?.林青).toEqual(["甲", "章"])
  // A failed disk sync can retry all completed parts without another model call.
  const saved = await extractMemoryInParts({ ...options, extract: retry })
  expect(retry).toHaveBeenCalledTimes(1)
  expect(saved.snapshot.events).toEqual(snapshot.events)
  await finishMemoryExtraction(checkpointPath)
  expect(files.size).toBe(0)
})
it("短章只提取一次，未创建断点", async () => {
  const call = vi.fn(async (body: string) => extract(body))
  await extractMemoryInParts({ ...options, source: "短章", extract: call })
  expect(call).toHaveBeenCalledExactlyOnceWith("短章", "")
  expect(files.size).toBe(0)
})
