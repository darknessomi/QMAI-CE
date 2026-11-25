import { beforeEach, expect, it, vi } from "vitest"
import { getJevConfig } from "./jev-config"
import { searchWiki } from "./search"
import { projectAnswerEvidence } from "./project-answer-evidence"

vi.mock("./jev-config", () => ({ getJevConfig: vi.fn() }))
vi.mock("./search", () => ({ searchWiki: vi.fn() }))
const signal = new AbortController().signal

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getJevConfig).mockReturnValue({ endpoint: "http://localhost", model: "test" })
})

it("同一文件的两段引文分别标注行号，并保留原始顺序", async () => {
  vi.mocked(searchWiki).mockResolvedValue([4, 12].map(line => ({
    path: "/book/QM/entities/甲.md", title: "甲", startLine: line, endLine: line + 1,
    snippet: "第" + line + "行的证据", titleMatch: false, score: 1, images: [],
  })))
  const content = await projectAnswerEvidence("/book", "谁收到文件？", signal, 8192)
  expect(content).toContain("〔QM/entities/甲.md，第 4–5 行〕")
  expect(content).toContain("〔QM/entities/甲.md，第 12–13 行〕")
  expect(content.indexOf("第4行的证据")).toBeLessThan(content.indexOf("第12行的证据"))
})

it("未配置 JEV 时保留原聊天输入，不请求模型", async () => {
  vi.mocked(getJevConfig).mockReturnValue(null)
  expect(await projectAnswerEvidence("/book", "问题", signal, 8192)).toBe("")
  expect(searchWiki).not.toHaveBeenCalled()
})

it("区分零命中和服务错误", async () => {
  vi.mocked(searchWiki).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("服务不可用"))
  expect(await projectAnswerEvidence("/book", "问题", signal, 8192)).toContain("没有找到")
  await expect(projectAnswerEvidence("/book", "问题", signal, 8192)).rejects.toThrow("服务不可用")
})
