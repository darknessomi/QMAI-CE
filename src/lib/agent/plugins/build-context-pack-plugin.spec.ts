import { describe, expect, it, vi } from "vitest"
import { createBuildContextPackPlugin } from "./build-context-pack-plugin"
import type { ContextPack } from "@/lib/novel/context-engine"

const mockContextPack: ContextPack = {
  task: "写第5章",
  chapterGoal: "第5章目标",
  outline: "大纲内容",
  recentSummaries: ["第4章摘要"],
  previousChapterEnding: "上一章结尾",
  characterStates: "人物状态",
  cognitionStates: "认知状态",
  foreshadowingStates: "伏笔状态",
  timeline: "时间线",
  relatedSettings: "相关设定",
  canonRules: "正史规则",
  writingStyle: "写作风格",
  searchResults: "搜索结果",
  graphSearchResults: "图谱搜索结果",
  mustDo: "必须做",
  mustAvoid: "必须避免",
  nextChapterAdvice: "下一章建议",
  revisionDirectives: "修订指令",
}

describe("BuildContextPackPlugin", () => {
  it("builds context pack in novel mode with task route", async () => {
    const mockBuild = vi.fn().mockResolvedValue(mockContextPack)
    const plugin = createBuildContextPackPlugin({ buildContextPack: mockBuild })

    const result = await plugin.run({
      userMessage: "写第5章",
      projectPath: "/test-project",
      agentConfig: {} as any,
      novelMode: true,
      taskRoute: { intent: "write_chapter", confidence: 0.9, chapterNumber: 5, extractedParams: {} },
    })

    expect(result.contextPack).toBeDefined()
    expect(result.contextPack?.task).toBe("写第5章")
    expect(mockBuild).toHaveBeenCalledWith("/test-project", "写第5章", 5)
  })

  it("uses effectiveTaskRoute if available", async () => {
    const mockBuild = vi.fn().mockResolvedValue(mockContextPack)
    const plugin = createBuildContextPackPlugin({ buildContextPack: mockBuild })

    await plugin.run({
      userMessage: "写章节",
      projectPath: "/test-project",
      agentConfig: {} as any,
      novelMode: true,
      taskRoute: { intent: "write_chapter", confidence: 0.9, extractedParams: {} },
      effectiveTaskRoute: { intent: "write_chapter", confidence: 0.9, chapterNumber: 7, extractedParams: { chapterNumber: "7" } },
    })

    expect(mockBuild).toHaveBeenCalledWith("/test-project", "写章节", 7)
  })

  it("returns empty when not in novel mode", async () => {
    const mockBuild = vi.fn().mockResolvedValue(mockContextPack)
    const plugin = createBuildContextPackPlugin({ buildContextPack: mockBuild })

    const result = await plugin.run({
      userMessage: "写第5章",
      projectPath: "/test-project",
      agentConfig: {} as any,
      novelMode: false,
    })

    expect(result.contextPack).toBeUndefined()
    expect(mockBuild).not.toHaveBeenCalled()
  })

  it("returns empty when no task route", async () => {
    const mockBuild = vi.fn().mockResolvedValue(mockContextPack)
    const plugin = createBuildContextPackPlugin({ buildContextPack: mockBuild })

    const result = await plugin.run({
      userMessage: "随便聊聊",
      projectPath: "/test-project",
      agentConfig: {} as any,
      novelMode: true,
      taskRoute: null,
    })

    expect(result.contextPack).toBeUndefined()
    expect(mockBuild).not.toHaveBeenCalled()
  })

  it("handles build error gracefully", async () => {
    const mockError = vi.fn()
    const mockBuild = vi.fn().mockRejectedValue(new Error("build failed"))
    const plugin = createBuildContextPackPlugin({ buildContextPack: mockBuild, onError: mockError })

    const result = await plugin.run({
      userMessage: "写第5章",
      projectPath: "/test-project",
      agentConfig: {} as any,
      novelMode: true,
      taskRoute: { intent: "write_chapter", confidence: 0.9, chapterNumber: 5, extractedParams: {} },
    })

    expect(result.contextPack).toBeUndefined()
    expect(mockError).toHaveBeenCalled()
  })

  it("loads classification before context and passes allowed categories to build", async () => {
    const mockBuild = vi.fn().mockResolvedValue(mockContextPack)
    const mockLoadClassification = vi.fn().mockResolvedValue({
      config: {
        routes: [
          {
            intent: "generate_outline",
            required: ["settings"],
            optional: ["outline"],
            forbidden: ["chapter_content", "recent_summaries"],
          },
        ],
      },
      source: "project",
    })
    const mockApplyRouteRules = vi.fn().mockReturnValue({
      pack: mockContextPack,
      blockedSources: ["chapter_content", "recent_summaries"],
      keptSources: ["settings", "outline"],
    })
    const plugin = createBuildContextPackPlugin({
      buildContextPack: mockBuild,
      enableClassification: true,
      loadClassificationConfig: mockLoadClassification as any,
      applyRouteRules: mockApplyRouteRules as any,
    })

    const result = await plugin.run({
      userMessage: "生成大纲",
      projectPath: "/test-project",
      agentConfig: {} as any,
      novelMode: true,
      taskRoute: { intent: "generate_outline", confidence: 0.9, extractedParams: {} },
    })

    expect(mockLoadClassification).toHaveBeenCalledWith("/test-project", undefined)
    expect(mockBuild).toHaveBeenCalledWith("/test-project", "生成大纲", undefined, {
      categories: ["settings", "outline"],
    })
    expect(result.routeSource).toBe("project")
    expect(result.blockedSources).toEqual(["chapter_content", "recent_summaries"])
  })
})
