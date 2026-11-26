import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { AgentRunner } from "@/lib/agent/runner"
import { streamChat } from "@/lib/llm-client"
import { buildContextPack, contextPackToPrompt } from "@/lib/novel/context-engine"
import { readPreviousChapterBodies } from "@/lib/novel/previous-chapters-analysis"
import { useWikiStore, DEFAULT_NOVEL_CONFIG } from "@/stores/wiki-store"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { runWritingConversation } from "./writing-conversation"

vi.mock("@/commands/fs", async original => ({
  ...await original<typeof import("@/commands/fs")>(), ...(await import("@/test-helpers/fs-temp")).realFs,
}))
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn(),
}))
vi.mock("@/lib/novel/task-intent-classifier", () => ({
  classifyTaskIntent: vi.fn(async () => ({ intent: "write_chapter", confidence: 1 })),
}))
vi.mock("@/lib/llm-client", async original => ({
  ...await original<typeof import("@/lib/llm-client")>(), streamChat: vi.fn(),
}))
vi.mock("@/lib/novel/review-adapter", async original => ({
  ...await original<typeof import("@/lib/novel/review-adapter")>(), reviewChapter: vi.fn(async () => []),
}))

const initialState = useWikiStore.getState()
let book: Awaited<ReturnType<typeof createTempProject>>
let chapter: string
const userRequest = "续写第 5 章，交代渡船去了哪里"
const sourceText = (quote: string) => ["---", "chapter_number: 1", "chapter_status: final", "---", quote].join("\n")
const quote = "渡船只到青石码头。"
const anchor = "wiki/chapters/第1章.md 第 5–5 行"
const searchCalls = () => vi.mocked(invoke).mock.calls.filter(([name]) => name === "sag_search")

beforeEach(async () => {
  book = await createTempProject("sag-writing")
  chapter = book.path + "/wiki/chapters/第1章.md"
  await writeFileRaw(chapter, sourceText(quote))
  vi.mocked(invoke).mockReset().mockImplementation(async (name, raw) => {
    const args = raw as { files: string[]; scopeFingerprint?: string; beforeChapter: number }
    if (name !== "sag_search" && name !== "sag_scope_fingerprint") return null
    expect(args.beforeChapter).toBe(5)
    const rows = await Promise.all(args.files.map(async path => [path, await realFs.readFile(path)]))
    const fingerprint = createHash("sha256").update(JSON.stringify(rows)).digest("hex")
    if (name === "sag_scope_fingerprint") return { fingerprint, pages: {}, chapters: [{ path: chapter, chapterNumber: 1 }] }
    expect(args.scopeFingerprint).toBe(fingerprint)
    return rows.map(([path, text]) => ({
      path, title: "渡口", content: text!.split("\n").at(-1), startLine: 5, endLine: 5, score: 1,
    }))
  })
  vi.mocked(streamChat).mockReset().mockImplementation(async (_config, messages, callbacks) => {
    const prompt = JSON.stringify(messages)
    callbacks.onToken(prompt.includes("只输出任务书")
      ? "写作任务书：承接渡口交接的伏笔，主角当面询问渡船去向。".repeat(12)
      : Array.from({ length: 140 }, (_, index) => `第${index}处脚印拐向河边，众人循着第${index + 1}块青砖找到船夫，继续沿岸寻找。`).join(""))
    callbacks.onDone()
  })
})

afterEach(async () => {
  useWikiStore.setState(initialState)
  vi.restoreAllMocks()
  await book.cleanup()
})

function setupModel(tools: boolean) {
  const model = tools ? "writer" : "o1"
  useWikiStore.setState({
    novelMode: true, jevConfig: { endpoint: "https://test.invalid", model: "judge" },
    project: null, aiChatModel: "custom/" + model, aiWorkflowMode: "standard",
    llmConfig: { provider: "custom", model, apiKey: "test", customEndpoint: "https://test.invalid/v1", ollamaUrl: "", maxContextSize: 32000 },
    novelConfig: { ...DEFAULT_NOVEL_CONFIG, defaultLlmModel: "custom/" + model, deepPreviousChaptersAnalysis: false },
    providerConfigs: { custom: { enabled: true, apiKey: "test", savedModels: [{ id: model, name: model, model, createdAt: 1 }] } },
  })
}

async function writeViaMcp() {
  return runWritingConversation({ projectPath: book.path, message: userRequest }, {
    readLive: () => null, loadHistory: async () => ({ conversations: [], messages: [], runStates: {} }), saveHistory: async () => {},
  })
}

describe("MCP 写作实际组包与模型输入", () => {
  it("无工具模型直接收到带路径、行号的前章引用", async () => {
    setupModel(false)
    const run = vi.spyOn(AgentRunner.prototype, "run").mockResolvedValue({ finalText: "已写完", toolCalls: [], roundsUsed: 1 })
    await writeViaMcp()
    expect(run).toHaveBeenCalledOnce()
    const [config, registry, messages] = run.mock.calls[0]!
    expect(registry.list()).toHaveLength(0)
    expect(config.requiredToolsOnce).toBeUndefined()
    expect(JSON.stringify(messages)).toContain(anchor)
    expect(JSON.stringify(messages)).toContain(quote)
    expect(JSON.stringify(messages)).not.toContain("run_chapter_workflow")
    expect(searchCalls()).toHaveLength(1)
  })

  it("主 Agent 将证据交给真实章节工具，正文提示词复用同一次判定", async () => {
    setupModel(true)
    vi.spyOn(AgentRunner.prototype, "run").mockImplementation(async (_config, registry, messages, _callbacks, signal) => {
      expect(JSON.stringify(messages)).toContain(anchor)
      const tool = registry.get("run_chapter_workflow")!
      await tool.execute({ userRequest }, signal, { callId: "write", toolName: tool.name })
      return { finalText: "已写完", toolCalls: [], roundsUsed: 1 }
    })
    await writeViaMcp()
    const modelCalls = vi.mocked(streamChat).mock.calls.map(([, messages]) => JSON.stringify(messages))
    expect(modelCalls.some(text => text.includes(anchor) && text.includes(quote) && text.includes("正文"))).toBe(true)
    expect(searchCalls()).toHaveLength(1)
  })

  it("普通写作将实体和概念送入 SAG2，相关引文进入最终提示词，大纲单独读取", async () => {
    setupModel(false)
    const entity = book.path + "/wiki/entities/守卫.md"
    const concept = book.path + "/wiki/concepts/凭证.md"
    const outline = book.path + "/wiki/outlines/第5章.md"
    await writeFileRaw(entity, "---\nsource_sequence: 1\n---\n守卫负责渡口交接。")
    await writeFileRaw(concept, "---\nsources: ['001.snapshot.json']\n---\n凭证上盖有蓝色印章。")
    await writeFileRaw(outline, "# 第5章\n下一章计划")
    const run = vi.spyOn(AgentRunner.prototype, "run").mockResolvedValue({ finalText: "已写完", toolCalls: [], roundsUsed: 1 })
    await writeViaMcp()
    expect(searchCalls()).toHaveLength(1)
    const files = (searchCalls()[0]![1] as { files: string[] }).files
    expect(files).toEqual(expect.arrayContaining([chapter, entity, concept]))
    expect(files).not.toContain(outline)
    const prompt = JSON.stringify(run.mock.calls[0]![2])
    expect(prompt).toContain("守卫负责渡口交接。")
    expect(prompt).toContain("凭证上盖有蓝色印章。")
  })

  it.each([true, false])("回写旧章时三个辅助设定入口均遵守来源章和页版本，JEV=%s", async (jev) => {
    setupModel(false)
    if (!jev) useWikiStore.setState({ jevConfig: null })
    const entity = book.path + "/wiki/entities/船夫.md"
    const mixed = book.path + "/wiki/concepts/通行证.md"
    const changed = book.path + "/wiki/entities/改稿.md"
    const keywords = "setting 设定 location 地点 canon 正史 rule 规则 style 风格 writing 写作"
    const original = "---\nsource_sequence: 1\n---\n" + keywords + "\n只有船夫认识旧船票。"
    const mixedText = "---\nsources: ['001.snapshot.json', '009.snapshot.json']\n---\n" + keywords + "\n第九章秘密印章已被销毁。"
    const oldText = "---\nsource_sequence: 1\n---\n" + keywords
    await writeFileRaw(entity, original)
    await writeFileRaw(mixed, mixedText)
    await writeFileRaw(changed, oldText)
    vi.mocked(invoke).mockImplementation(async (name, raw) => {
      if (name === "sag_scope_fingerprint") {
        expect((raw as { files: string[] }).files).toEqual(expect.arrayContaining([chapter, entity, changed, mixed]))
        await writeFileRaw(changed, oldText + "\n校验后才补上的结局。")
        const hash = (text: string) => createHash("sha256").update(text).digest("hex")
        return { fingerprint: "chapter-five", chapters: [{ chapterNumber: 1, path: chapter }], pages: { [entity]: hash(original), [changed]: hash(oldText) } }
      }
      if (name === "sag_search") return [{ path: chapter, title: "渡口", content: quote, startLine: 5, endLine: 5, score: 1 }]
      return null
    })
    const pack = await buildContextPack(book.path, userRequest, 5, { categories: ["settings", "plot_tools"] })
    for (const reference of [pack.relatedSettings, pack.canonRules, pack.writingStyle]) {
      expect(reference).toContain("只有船夫认识旧船票")
    }
    const prompt = contextPackToPrompt(pack, 20_000)
    expect(prompt).toContain("只有船夫认识旧船票")
    expect(prompt).not.toContain("第九章秘密印章")
    expect(prompt).not.toContain("校验后才补上的结局")
    if (jev) expect(prompt).toContain(quote)
    expect(searchCalls()).toHaveLength(jev ? 1 : 0)
  })

  it("同章交接期间发生等长修改就重新检索，新证据覆盖旧引文", async () => {
    setupModel(true)
    const first = await buildContextPack(book.path, userRequest, 5)
    const updated = "渡船只到白石码头。"
    await writeFileRaw(chapter, sourceText(updated))
    const next = await buildContextPack(book.path, userRequest, 5, { evidence: first.sagEvidence })
    expect(next.searchResults).toContain(anchor)
    expect(next.searchResults).toContain(updated)
    expect(next.searchResults).not.toContain(quote)
    expect(searchCalls()).toHaveLength(2)
  })

  it("无 JEV 时从上一章草稿原文承接，即使更早的定稿有结尾快照", async () => {
    setupModel(true)
    useWikiStore.setState({ jevConfig: null })
    const dir = book.path + "/wiki/chapters/"
    const records = [[2, "draft", false], [5, "draft", false], [6, "final", false]] as const
    for (const [n, status, excluded] of records) {
      await writeFileRaw(dir + `第${n}章.md`, `---\ntype: chapter\nchapter_number: ${n}\nchapter_status: ${status}\nai_exclude: ${excluded}\n---\n渡船的不可见事实${n}。`)
    }
    const third = dir + "第3章.md"
    const previousDraftPath = dir + "第4章.md"
    await writeFileRaw(third, "---\nchapter_number: 3\nchapter_status: final\n---\n众人登船。")
    await writeFileRaw(previousDraftPath, "---\nchapter_number: 4\nchapter_status: draft\n---\n渡船刚刚靠岸。")
    await writeFileRaw(book.path + "/.qmai/novel/snapshots/003.snapshot.json",
      JSON.stringify({ chapterNumber: 3, endingHook: "船刚出港。", summary: "众人登船。" }))
    await writeFileRaw(dir + "第4章-禁读.md", "---\nchapter_number: 4\nchapter_status: draft\nai_exclude: true\n---\n渡船的不可见事实。")
    vi.mocked(invoke).mockImplementation(async name => name === "sag_scope_fingerprint"
      ? { fingerprint: "fifth", chapters: [{ path: chapter, chapterNumber: 1 }, { path: third, chapterNumber: 3 }], previousDraftPath, pages: {} }
      : null)
    const pack = await buildContextPack(book.path, userRequest, 5)
    expect(pack.previousChapterEnding).toBe("渡船刚刚靠岸。")
    expect(pack.recentChapterContents?.join("\n")).toContain("渡船刚刚靠岸。")
    const bodies = await readPreviousChapterBodies(book.path, 5, 3)
    expect(bodies.map(ch => ch.number)).toEqual([3, 4])
    expect(bodies.at(-1)?.content).toBe("渡船刚刚靠岸。")
    const text = JSON.stringify(pack)
    expect(text).toContain(quote)
    expect(text).not.toContain("渡船的不可见事实")
    expect(searchCalls()).toHaveLength(0)
  })
})
