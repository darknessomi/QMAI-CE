// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { buildChatAgentSystemPrompt } from "./chat-panel"

/*
 * 「关闭 Function Calling 后本地模型依然不能用」的根因就在这份提示词里：
 * 请求确实不带 tools 了，但提示词还是命令模型「必须调用 run_chapter_workflow」。
 * 于是纯聊天模型要么回一句「我无法读取文件」，要么吐一段没人解析的工具 JSON。
 *
 * 这里把「带工具 / 不带工具」两种提示词的关键差异钉死，
 * 避免以后有人把 toolsEnabled 分支删掉、只留一份工具版提示词。
 */
const base = {
  novelMode: true,
  mode: "chat" as const,
  chatEditModeEnabled: false,
  aiWorkflowMode: "standard" as const,
}

describe("buildChatAgentSystemPrompt 无工具降级", () => {
  it.each(["standard", "strict"] as const)("有工具时 %s 模式直接进入正文工作流", (aiWorkflowMode) => {
    const prompt = buildChatAgentSystemPrompt({ ...base, aiWorkflowMode, toolsEnabled: true })
    expect(prompt).toContain("请通过可用工具读取项目资料")
    expect(prompt).toContain("必须调用 run_chapter_workflow 工具")
    expect(prompt).not.toContain("等待用户确认")
  })

  it("无工具时不再要求调用任何工具，并要求直接产出正文", () => {
    const prompt = buildChatAgentSystemPrompt({ ...base, toolsEnabled: false })
    expect(prompt).toContain("本轮未启用工具调用")
    expect(prompt).toContain("不要输出工具调用")
    expect(prompt).toContain("直接输出可放入章节库的完整正文")
    // 这些句子在无工具时都是「要求模型用不存在的能力」，必须消失
    expect(prompt).not.toContain("必须调用 run_chapter_workflow")
    expect(prompt).not.toContain("必须优先使用对应工具读取具体内容")
    expect(prompt).not.toContain("必须使用 web_search 工具")
    expect(prompt).not.toContain("请优先定位目标章节并使用章节读写工具")
  })

  it("无工具时开启联网写作提示也不会要求调用 web_search", () => {
    const prompt = buildChatAgentSystemPrompt({
      ...base,
      aiWorkflowMode: "strict",
      writingWebSearchEnabled: true,
      toolsEnabled: false,
    })
    expect(prompt).not.toContain("web_search")
  })
})
