import { beforeEach, describe, expect, it, vi } from "vitest"

const memStore = new Map<string, string>()

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (path: string) => {
    const content = memStore.get(path)
    if (content == null) throw new Error("missing")
    return content
  }),
}))

import { loadTimeline } from "./timeline"

const projectPath = "E:/Novel"
const timelinePath = "E:/Novel/.qmai/novel/timeline.json"

beforeEach(() => {
  memStore.clear()
})

describe("loadTimeline", () => {
  it("读取统一刷新写出的正式时间线", async () => {
    const data = { version: 1, entries: [{ chapterNumber: 2, event: "进城" }], serial: 1, updatedAt: "" }
    memStore.set(timelinePath, JSON.stringify(data))
    expect(await loadTimeline(projectPath)).toEqual(data)
  })
  it("新项目返回空时间线", async () => {
    expect((await loadTimeline(projectPath)).entries).toEqual([])
  })
})
