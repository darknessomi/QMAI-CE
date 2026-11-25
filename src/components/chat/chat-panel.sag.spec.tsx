// @vitest-environment jsdom
import { webcrypto } from "node:crypto"
import { act } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { renderChatPanel } from "@/test/chat-panel-mount"
import { fileExists, listDirectory, readFile, readMarkdownBatch } from "@/commands/fs"
import { realFs } from "@/test-helpers/fs-temp"
import type { FileNode } from "@/types/wiki"
import type { SagHit } from "@/lib/sag-search"
import { ContextHubController } from "@/lib/context-hub/context-hub"
import { AgentRunner } from "@/lib/agent/runner"
import { useWikiStore } from "@/stores/wiki-store"

vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn(),
}))
vi.mock("@/lib/novel/task-intent-classifier", () => ({
  classifyTaskIntent: vi.fn(async () => ({ intent: "write_chapter", confidence: 1 })),
}))

async function sendFromPanel(container: HTMLElement, task: string) {
  const input = container.querySelector<HTMLTextAreaElement>('[aria-label="引用输入框"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, task)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click()
  })
}

const state = useWikiStore.getState()
const previous = { jevConfig: state.jevConfig, novelMode: state.novelMode, novelConfig: state.novelConfig }
afterEach(() => {
  Object.assign(state, previous)
  vi.mocked(listDirectory).mockReset().mockResolvedValue([])
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each([true, false])("从实际聊天面板发起%s模式请求，主模型收到带文件与行号的引文", async novel => {
  vi.stubGlobal("crypto", webcrypto)
  Object.assign(state, {
    novelMode: novel, jevConfig: { endpoint: "https://test.invalid", model: "judge" },
    novelConfig: { ...state.novelConfig, searchTopK: 5, recentSummaryWindow: 3 },
  })
  const project = state.project!.path
  const relative = novel ? "wiki/chapters/第1章.md" : "wiki/entities/码头.md"
  const hitPath = project + "/" + relative
  const evidence = "渡船只停青石一号码头。"
  vi.mocked(listDirectory).mockImplementation(async dir => {
    return dir === project + (novel ? "/wiki/chapters" : "/wiki")
      ? [{ path: hitPath, name: hitPath.split("/").at(-1)!, is_dir: false, size: 50, mtimeMs: 1 }] : []
  })
  vi.mocked(invoke).mockReset().mockImplementation(async (cmd, raw) => {
    if (cmd === "sag_scope_fingerprint") return { fingerprint: "scope", chapters: [{ path: hitPath, chapterNumber: 1 }] }
    if (cmd !== "sag_search") return null
    expect(raw).toMatchObject({ beforeChapter: novel ? 5 : undefined, files: [hitPath] })
    return [{ path: hitPath, title: "码头", content: evidence, startLine: 7, endLine: 8, score: 1 }]
  })
  const hub = vi.spyOn(ContextHubController.prototype, "prepare")
  const model = vi.spyOn(AgentRunner.prototype, "run").mockResolvedValue({ finalText: "已完成", toolCalls: [], roundsUsed: 1 })
  const view = await renderChatPanel({ activeConversation: true, aiWorkflowMode: "fast" })
  try {
    await sendFromPanel(view.container, novel ? "续写第 5 章，交代渡船停靠哪里" : "渡船停靠哪里？")
    await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1))
    if (novel) expect(await hub.mock.results[0]?.value).not.toBeNull()
    const messages = JSON.stringify(model.mock.calls[0]![2])
    expect(messages).toContain(relative)
    expect(messages).toContain("第 7–8 行")
    expect(messages.split(evidence)).toHaveLength(2)
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "sag_search")).toHaveLength(1)
  } finally {
    await view.unmount()
  }
})

const liveProject = process.env.QMAI_SAG_WRITING_PROJECT
it.skipIf(!liveProject)("已配置 JEV 的实际写作请求到达最终模型输入", async () => {
  const project = liveProject!
  const chapter = Number(process.env.QMAI_SAG_WRITING_CHAPTER)
  const task = process.env.QMAI_SAG_WRITING_TASK
  if (!task || !Number.isSafeInteger(chapter) || chapter < 2) throw new Error("需指定写作任务和章号")
  const { nativeBridge } = await import("@/test-helpers/sag-native-bridge")
  const bridge = nativeBridge()
  vi.stubGlobal("crypto", webcrypto)
  const oldProject = state.project
  state.project = { id: "sag-live", name: "写作评测", path: project }
  state.jevConfig = { endpoint: "http://localhost", model: "native-bridge" }
  state.novelMode = true
  const physical = (path: string) => path.replace(project + "/wiki", project + "/QM")
  const virtualize = (node: FileNode): FileNode => ({
    ...node, path: node.path.replace(project + "/QM", project + "/wiki"), children: node.children?.map(virtualize),
  })
  vi.mocked(listDirectory).mockImplementation(async path => (await realFs.listDirectory(physical(path))).map(virtualize))
  vi.mocked(readFile).mockImplementation(path => realFs.readFile(physical(path)))
  vi.mocked(fileExists).mockImplementation(path => realFs.fileExists(physical(path)))
  vi.mocked(readMarkdownBatch).mockImplementation(paths => realFs.readMarkdownBatch(paths.map(physical)))

  let jevHttpCalls = 0
  let searches = 0
  let searchMs = 0
  let queryWithOutline = false
  let hits: SagHit[] = []
  vi.mocked(invoke).mockReset().mockImplementation(async (cmd, raw) => {
    if (cmd !== "sag_scope_fingerprint" && cmd !== "sag_search") return null
    const { config: _credential, ...args } = raw as Record<string, unknown>
    if (cmd === "sag_search") {
      if (++searches > 1) throw new Error("同一写作任务重复请求 JEV")
      queryWithOutline = String(args.query).includes(task) && String(args.query).length > task.length + 100
    }
    const started = performance.now()
    const reply = await bridge.call({ command: cmd, requestId: crypto.randomUUID(), ...args })
    if (reply.error) throw new Error("原生检索未完成")
    if (cmd === "sag_search") {
      jevHttpCalls += reply.calls
      searchMs += Math.round(performance.now() - started)
      hits = reply.value as SagHit[]
    }
    return reply.value
  })
  const model = vi.spyOn(AgentRunner.prototype, "run").mockResolvedValue({ finalText: "写作评测完成", toolCalls: [], roundsUsed: 1 })
  const view = await renderChatPanel({ activeConversation: true, aiWorkflowMode: "fast" })
  try {
    const started = performance.now()
    await sendFromPanel(view.container, task)
    await vi.waitFor(() => expect(model.mock.calls.length).toBe(1), { timeout: 180000 })
    const elapsedMs = Math.round(performance.now() - started)
    const messages = model.mock.calls[0]![2].map(m => typeof m.content === "string" ? m.content :
      Array.isArray(m.content) ? m.content.map(b => "text" in b ? b.text : "").join("") : "").join("\n")
    const anchors = hits.filter(hit => messages.includes(hit.path.slice(project.length + 1))
      && messages.includes(`第 ${hit.startLine}–${hit.endLine} 行`)
      && messages.includes(hit.content.trim().slice(0, 30)))
      .map(hit => ({ path: hit.path.slice(project.length + 1), from: hit.startLine, to: hit.endLine }))
    console.log("QMAI_SAG_WRITING_RESULT=" + JSON.stringify({
      target: chapter, elapsedMs, searchMs, jevHttpCalls, searches, hits: hits.length, anchors, queryWithOutline,
    }))
    expect(searches).toBe(1)
    expect(jevHttpCalls).toBeGreaterThan(0)
    expect(queryWithOutline).toBe(true)
    expect(anchors.length).toBeGreaterThan(0)
  } finally {
    await view.unmount()
    bridge.close()
    state.project = oldProject
  }
}, 240000)
