import { runAiChatSession } from "@/lib/agent/ai-chat-session"
import { applyAgentActivityEvent, createAgentActivityEvent, createStageStartedEvent, settleRunningAgentStages } from "@/lib/agent/activity-trace"
import { applyAgentToolActivityEvent, applyAgentToolEvent, settleRunningAgentToolCalls } from "@/lib/agent/tool-events"
import { agentToolCallsToMessageReferences, normalizeReferencePath } from "@/components/chat/agent-message-metadata"
import { buildAgentConfig, effectiveToolsEnabled } from "@/lib/agent/config"
import { runNovelPrePluginChain } from "@/lib/agent/novel-pre-plugin-chain"
import { resolveRequiredToolsOnce } from "@/lib/agent/required-tools-gate"
import { ToolRegistry } from "@/lib/agent/registry"
import { runDeepChapterGeneration } from "@/lib/novel/deep-chapter-generation"
import { buildContextPack, type ChapterSearchEvidence } from "@/lib/novel/context-engine"
import { routeTask } from "@/lib/novel/task-router"
import { loadDeAiSkillConfig } from "@/lib/novel/de-ai-skill-library"
import { loadAllLinkedSkillsContent, loadUserSkillConfig, resolveEnabledWritingSkills } from "@/lib/novel/user-skill-store"
import { deriveConversationTitle } from "@/lib/conversation-title"
import { loadChatHistory, saveChatHistory } from "@/lib/persist"
import { normalizePath } from "@/lib/path-utils"
import { useChatStore, type Conversation, type DisplayMessage, type MessageReference } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { getPluginToolDescriptors, invokePluginToolViaTauri } from "@/lib/plugins/tool-sync"
import type { ConversationRunStates } from "@/lib/conversation-run-state"
import type { AgentActivityEvent, AgentToolEvent } from "@/lib/agent/types"
import { isWritingStopped, STOPPED_GENERATION_TEXT, writingRunRegistry } from "./stop-writing"
import { resolveWritingParameters, type ResolvedWritingParameters } from "./writing-parameters"
import { summarizeWritingError, writingProgressStore, type WritingProgressStore, type WritingRunStatus } from "./writing-progress"

export interface WritingSessionContext extends ResolvedWritingParameters {
  projectPath: string
  conversationId: string
  message: string
  history: Array<{ role: string; content: string }>
  signal?: AbortSignal
  onActivityEvent?: (event: AgentActivityEvent) => void
  onToolEvent?: (event: AgentToolEvent) => void
  onText?: (text: string) => void
  onReasoningToken?: (chunk: string) => void
  onNeedsInput?: (message: string) => void
  onRetrievalWarning?: () => void
}

interface ChatSnapshot {
  conversations: Conversation[]
  messages: DisplayMessage[]
  runStates: ConversationRunStates
}

export interface WritingConversationDeps {
  progressStore?: WritingProgressStore
  runSession?: (ctx: WritingSessionContext) => Promise<string>
  loadHistory?: (projectPath: string) => Promise<ChatSnapshot>
  saveHistory?: (
    projectPath: string,
    conversations: Conversation[],
    messages: DisplayMessage[],
    runStates: ConversationRunStates,
  ) => Promise<void>
  readLive?: () => ({ projectPath: string | null; activeConversationId?: string | null } & ChatSnapshot) | null
  writeLive?: (data: ChatSnapshot & { activeConversationId: string | null }) => void
}

const activeProjects = new Set<string>()

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function defaultReadLive(): ({ projectPath: string | null; activeConversationId: string | null } & ChatSnapshot) | null {
  const projectPath = useWikiStore.getState().project?.path ?? null
  if (!projectPath) return null
  const chat = useChatStore.getState()
  return {
    projectPath,
    conversations: chat.conversations,
    messages: chat.messages,
    runStates: chat.runStates,
    activeConversationId: chat.activeConversationId,
  }
}

async function runDefaultSession(ctx: WritingSessionContext): Promise<string> {
  if (ctx.signal?.aborted) throw new Error("操作已取消")
  const projectPath = ctx.projectPath
  const [skillConfig, writingSkills] = await Promise.all([
    loadDeAiSkillConfig(projectPath).catch(() => null),
    loadUserSkillConfig(projectPath)
      .then((config) => loadAllLinkedSkillsContent(config))
      .then(resolveEnabledWritingSkills)
      .catch(() => []),
  ])
  const registry = new ToolRegistry()
  const novelMode = useWikiStore.getState().novelMode
  const toolsEnabled = effectiveToolsEnabled(ctx.agentLlm.model, ctx.agentLlm)
  let chapterEvidence: ChapterSearchEvidence | undefined
  ctx.onActivityEvent?.(createStageStartedEvent({ stageId: "task_understanding", title: "识别写作任务", summary: "" }))
  const taskRoute = await routeTask(ctx.message, {
    llmConfig: ctx.agentLlm,
    signal: ctx.signal,
  })
  const agentConfig = buildAgentConfig(ctx.agentLlm.model, "你是青幕写作的写作对话助手。", registry, {
    wikiPath: `${normalizePath(projectPath)}/wiki`,
    projectPath: normalizePath(projectPath),
    llmConfig: ctx.agentLlm,
    chapterWritingLlmConfig: ctx.chapterWritingLlm,
    aiWorkflowMode: ctx.workflowMode,
    draftMode: novelMode,
    maxContextSize: ctx.agentLlm.maxContextSize,
    getSkillConfig: () => skillConfig,
    getUserSkills: () => writingSkills,
    getSearchApiConfig: () => useWikiStore.getState().searchApiConfig,
    getChatConversations: () => [],
    getOutlineConversations: () => [],
    disabledTools: ["write_chapter", "write_outline_node", "write_memory"],
    /*
     * 这条路径也在 WebView 里跑：`src/lib/mcp/host.ts` 用 Tauri 的 `listen("mcp-request")`
     * 接外部 MCP 请求，再调 `handleMcpToolCall → runWritingConversation`，与界面同进程同
     * store，所以插件工具一样能接。缓存读取本身不会抛（未同步过就是空数组），
     * invoke 只在模型真的调用工具时才走 Tauri。
     */
    pluginTools: getPluginToolDescriptors(),
    invokePluginTool: invokePluginToolViaTauri(),
    runDeepChapterGeneration: (input, ...args) => runDeepChapterGeneration({
      ...input,
      chapterNumber: input.chapterNumber ?? chapterEvidence?.chapterNumber,
      chapterEvidence,
    }, ...args),
  })
  ctx.onActivityEvent?.(createStageStartedEvent({ stageId: "prepare_agent_context", title: "准备主 Agent 上下文", summary: "" }))
  const prePlugin = await runNovelPrePluginChain({
    config: toolsEnabled ? undefined : { disabledPlugins: ["select_capabilities", "build_system_prompt"] },
    deps: { buildContextPack: (project, task, chapter, options) => buildContextPack(project, task, chapter, { ...options, signal: ctx.signal }) },
    input: {
      userMessage: ctx.message,
      projectPath,
      agentConfig,
      novelMode,
      taskRoute,
      effectiveTaskRoute: taskRoute,
      aiWorkflowMode: ctx.workflowMode,
      availableSkills: writingSkills,
    },
  }).catch(() => null)
  if (ctx.signal?.aborted) throw new Error("操作已取消")
  chapterEvidence = prePlugin?.contextPack?.sagEvidence
  if (chapterEvidence?.warning) ctx.onRetrievalWarning?.()
  if (prePlugin?.shouldStop) {
    if (prePlugin.stopReason === "source_canon_overflow") throw new Error("模型上下文不足，无法保留完整原作设定。")
    const clarification = prePlugin.stopReason === "clarification_needed"
      ? "需要明确本次写作意图，请在同一会话补充要求。"
      : "需要用户确认后才能继续，请在同一会话补充要求。"
    ctx.onNeedsInput?.(clarification)
    return clarification
  }
  const requiredToolsOnce = resolveRequiredToolsOnce({
    novelMode,
    intent: taskRoute.intent,
    mode: ctx.workflowMode,
    enabledToolNames: toolsEnabled ? prePlugin?.enabledToolNames : [],
  })
  const systemPrompt = toolsEnabled
    ? prePlugin?.finalSystemPrompt?.trim() || agentConfig.systemPrompt
    : [agentConfig.systemPrompt, "本轮未启用工具，请直接根据已有资料完成用户要求。", prePlugin?.novelSystemPrompt].filter(Boolean).join("\n\n")
  const sourceRefs = chapterEvidence?.sources
    ?.filter(source => systemPrompt.includes(source.anchor + "\n"))
    .map(source => ({ type: "wiki", title: source.title, path: source.path }))
  ctx.onActivityEvent?.(createAgentActivityEvent({
    id: "prepare_agent_context:ready", stageId: "prepare_agent_context", kind: "stage_output",
    title: "写作上下文已准备",
    content: sourceRefs?.length ? `已将 ${sourceRefs.length} 段原文引文加入上下文。` : "已组装本轮写作请求。",
    sourceRefs,
  }))
  let reply = ""
  ctx.onActivityEvent?.(createStageStartedEvent({ stageId: "agent_dispatch", title: "等待主 Agent 响应", summary: "" }))
  let awaitingAgent = true
  const markAgentResponse = () => {
    if (!awaitingAgent) return
    awaitingAgent = false
    ctx.onActivityEvent?.({ id: "agent_dispatch:response", stageId: "agent_dispatch",
      kind: "stage_output", title: "主 Agent 已响应", content: "已收到主 Agent 响应。", timestamp: Date.now() })
  }
  const record = await runAiChatSession({
    userMessage: ctx.message,
    projectPath,
    agentConfig: {
      ...agentConfig,
      systemPrompt,
      projectPath,
      taskGoal: ctx.message,
      ...(requiredToolsOnce ? { requiredToolsOnce } : {}),
    },
    enabledToolNames: prePlugin?.enabledToolNames,
    registry,
    messages: [
      { role: "system", content: systemPrompt },
      ...ctx.history.map((message) => ({ role: message.role as "user" | "assistant" | "system", content: message.content })),
      { role: "user", content: ctx.message },
    ],
    callbacks: {
      onText: (chunk) => {
        if (chunk.trim()) markAgentResponse()
        reply += chunk
        ctx.onText?.(chunk)
      },
      onActivityEvent: ctx.onActivityEvent,
      onReasoningToken: ctx.onReasoningToken,
      onToolEvent: (event) => { markAgentResponse(); ctx.onToolEvent?.(event) },
      onFinalContent: (content) => { markAgentResponse(); reply = content; ctx.onText?.(content) },
      onDone: () => {},
      onError: (error) => {
        throw error
      },
    },
    signal: ctx.signal,
  })
  return (record.finalText || reply).trim() || "写作对话已完成，但没有返回正文。"
}

export async function runWritingConversation(input: {
  projectPath: string
  message: string
  conversationId?: string
  workflowMode?: unknown
  model?: unknown
  reasoningDepth?: unknown
  background?: boolean
}, deps: WritingConversationDeps = {}): Promise<string> {
  const message = input.message.trim()
  if (!message) throw new Error("写作对话内容不能为空")
  const projectPath = normalizePath(input.projectPath)
  if (activeProjects.has(projectPath)) {
    if (!writingRunRegistry.has(projectPath)) {
      activeProjects.delete(projectPath)
    } else {
      throw new Error("当前项目已有进行中的写作对话")
    }
  }
  activeProjects.add(projectPath)
  const controller = new AbortController()
  writingRunRegistry.register(projectPath, controller)
  let backgroundStarted = false
  let released = false
  const release = () => {
    if (released) return
    released = true
    writingRunRegistry.remove(projectPath, controller)
    activeProjects.delete(projectPath)
  }
  try {
    const parameters = resolveWritingParameters(input)
    const live = (deps.readLive ?? defaultReadLive)()
    const useLive = Boolean(live?.projectPath && normalizePath(live.projectPath) === projectPath)
    const loaded = useLive && live
      ? live
      : await (deps.loadHistory ?? loadChatHistory)(projectPath)
    if (Object.values(loaded.runStates).some((state) => state.status === "running")) {
      if (!writingRunRegistry.has(projectPath)) {
        if (useLive) {
          useChatStore.getState().setLoadedRunStates(loaded.runStates)
        }
      } else {
        throw new Error("当前项目已有进行中的写作对话")
      }
    }
    let conversation = input.conversationId
      ? loaded.conversations.find((item) => item.id === input.conversationId)
      : undefined
    if (input.conversationId && !conversation) throw new Error("找不到该写作对话")
    const now = Date.now()
    if (!conversation) {
      conversation = {
        id: createId(),
        title: deriveConversationTitle(message) || "写作对话",
        createdAt: now,
        updatedAt: now,
        deAiMode: false,
      }
    }
    conversation = { ...conversation }
    const target = conversation
    const history = loaded.messages
      .filter((item) => item.conversationId === conversation.id && !item.discarded)
      .map((item) => ({ role: item.role, content: item.content }))
    const progress = await (deps.progressStore ?? writingProgressStore).start({ projectPath, conversationId: target.id, runId: createId() })
    const runId = progress.snapshot().runId
    if (useLive && !deps.readLive && normalizePath(useWikiStore.getState().project?.path ?? "") === projectPath) {
      useChatStore.setState((state) => ({
        conversations: state.conversations.some((item) => item.id === target.id) ? state.conversations : [target, ...state.conversations],
        runStates: { ...state.runStates, [target.id]: { status: "running", runId, updatedAt: now } },
      }))
    }
    const userMessage: DisplayMessage = { id: createId(), role: "user", content: message, timestamp: now, conversationId: target.id }
    const assistant: DisplayMessage = {
      id: createId(), role: "assistant", content: "", timestamp: now, conversationId: target.id,
      isAgentRunning: true, generationTiming: { startedAt: now },
      agentStages: applyAgentActivityEvent([], createAgentActivityEvent({
        id: "preparing:started", stageId: "preparing", kind: "stage_started", title: "准备写作上下文",
        content: "开始准备本轮写作所需的上下文。", timestamp: now,
      })),
    }

    async function execute(): Promise<string> {
      let reply = ""
      let partial = ""
      let status: Exclude<WritingRunStatus, "running"> = "completed"
      let problem: string | undefined
      let failure: unknown
      const references = new Map<string, MessageReference>()
      try {
        try {
          reply = await (deps.runSession ?? runDefaultSession)({
            ...parameters, projectPath, conversationId: target.id, message, history, signal: controller.signal,
            onActivityEvent: (event) => {
              assistant.agentStages = applyAgentActivityEvent(assistant.agentStages, event)
              for (const source of event.sourceRefs ?? []) {
                if (source.type === "wiki" && source.path) {
                  const path = normalizeReferencePath(source.path)
                  references.set(path, { title: source.title, path })
                }
              }
              progress.activity(event)
            },
            onToolEvent: (event) => {
              assistant.agentToolCalls = applyAgentToolEvent(assistant.agentToolCalls, event)
              assistant.agentStages = applyAgentToolActivityEvent(assistant.agentStages, event)
              progress.tool(event)
            },
            onText: (text) => { partial += text },
            onReasoningToken: (chunk) => { assistant.reasoning_content = (assistant.reasoning_content ?? "") + chunk },
            onNeedsInput: (text) => { status = "needs_input"; problem = text },
            onRetrievalWarning: progress.retrievalWarning,
          })
          if (progress.snapshot().tools.some((tool) => tool.status === "approval_required")) {
            status = "needs_input"
            problem ??= "有操作需要用户确认，尚未执行。"
          }
        } catch (error) {
          if (isWritingStopped(error, controller.signal)) {
            status = "cancelled"
            reply = STOPPED_GENERATION_TEXT
          } else {
            status = "failed"
            failure = error
            problem = summarizeWritingError(error)
            reply = `出错：${problem}${partial ? `\n\n${partial}` : ""}`
          }
        }
        if (controller.signal.aborted) { status = "cancelled"; reply = STOPPED_GENERATION_TEXT; problem = undefined }
        assistant.content = reply
        assistant.isAgentRunning = false
        const finishedAt = Date.now()
        assistant.generationTiming!.finishedAt = finishedAt
        const view = progress.snapshot()
        const settled = status === "failed" ? "error" : status === "cancelled" ? "cancelled" : "done"
        for (const reference of agentToolCallsToMessageReferences(assistant.agentToolCalls)) {
          references.set(reference.path, reference)
        }
        if (references.size) assistant.references = [...references.values()]
        assistant.agentStages = settleRunningAgentStages(assistant.agentStages, settled, finishedAt)
        assistant.agentToolCalls = settleRunningAgentToolCalls(assistant.agentToolCalls, settled, finishedAt)
        // 执行期间可能切换项目或产生其他会话，收尾必须重新读取并只合并本轮。
        const currentLive = (deps.readLive ?? defaultReadLive)()
        const sameProject = Boolean(currentLive?.projectPath && normalizePath(currentLive.projectPath) === projectPath)
        const latest = sameProject && currentLive ? currentLive : await (deps.loadHistory ?? loadChatHistory)(projectPath)
        const conversations = latest.conversations.some((item) => item.id === target.id)
          ? latest.conversations.map((item) => item.id === target.id ? { ...item, updatedAt: Date.now() } : item)
          : [{ ...target, updatedAt: Date.now() }, ...latest.conversations]
        const messages = [...latest.messages, userMessage, assistant]
        const settledRunState = () => ({
          status: status === "failed" ? "failed" as const : "idle" as const,
          runId, updatedAt: Date.now(), ...(status === "failed" ? { error: problem } : {}),
        })
        const runStates = { ...latest.runStates }
        if (runStates[target.id]?.runId === runId) runStates[target.id] = settledRunState()
        const saveHistory = deps.saveHistory ?? ((path, nextConversations, nextMessages, runStates) => (
          saveChatHistory(path, nextConversations, nextMessages, undefined, runStates)
        ))
        // 先把本轮合并到当前内存，让随后触发的 UI 自动保存也能包含本轮结果。
        if (sameProject && normalizePath((deps.readLive ?? defaultReadLive)()?.projectPath ?? "") === projectPath) {
          if (deps.writeLive) deps.writeLive({ conversations, messages, runStates, activeConversationId: currentLive?.activeConversationId ?? null })
          else useChatStore.setState((state) => ({
            conversations: state.conversations.some((item) => item.id === target.id)
              ? state.conversations.map((item) => item.id === target.id ? { ...item, updatedAt: Date.now() } : item)
              : [{ ...target, updatedAt: Date.now() }, ...state.conversations],
            messages: [...state.messages, userMessage, assistant],
            runStates: state.runStates[target.id]?.runId === runId
              ? { ...state.runStates, [target.id]: settledRunState() } : state.runStates,
          }))
        }
        try {
          const merged = !deps.readLive && normalizePath(useWikiStore.getState().project?.path ?? "") === projectPath
            ? useChatStore.getState() : { conversations, messages, runStates }
          await saveHistory(projectPath, merged.conversations, merged.messages, merged.runStates)
        } catch {
          status = "failed"
          problem = "写作对话保存失败，完整结果尚未可靠保存。"
          failure = new Error(problem)
          if (!deps.readLive && normalizePath(useWikiStore.getState().project?.path ?? "") === projectPath) {
            useChatStore.setState((state) => ({
              runStates: state.runStates[target.id]?.runId === runId
                ? { ...state.runStates, [target.id]: settledRunState() } : state.runStates,
            }))
          }
        }
        await progress.finish(status, problem ? { kind: status === "needs_input" ? "input_required" : "error", message: problem } : undefined)
        if (failure) throw failure
        if (status === "cancelled") return STOPPED_GENERATION_TEXT
        const retrievalWarning = view.issues.find(issue => issue.kind === "retrieval_warning")?.message
        return `写作对话${status === "needs_input" ? "需要补充信息" : "已完成"}。\n会话：${target.id}\n模式：${parameters.workflowMode}\n正文模型：${parameters.chapterWritingLlm.model}\n工作流模型：${parameters.agentLlm.model}${retrievalWarning ? "\n" + retrievalWarning : ""}\n\n${reply}`
      } catch (error) {
        if (progress.snapshot().status === "running") {
          await progress.finish("failed", { kind: "error", message: summarizeWritingError(error) }).catch(() => {})
        }
        throw error
      } finally { release() }
    }
    if (input.background) {
      backgroundStarted = true
      // 任务归青幕进程持有，不依附这一条 MCP 请求的生命周期。
      setTimeout(() => { void execute().catch(() => {}) }, 0)
      return JSON.stringify(progress.snapshot())
    }
    return await execute()
  } finally {
    if (!backgroundStarted) release()
  }
}
