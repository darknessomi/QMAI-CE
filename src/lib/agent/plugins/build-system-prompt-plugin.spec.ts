import { describe, expect, it } from "vitest"
import { createBuildSystemPromptPlugin } from "./build-system-prompt-plugin"
import { normalizeUserSkill } from "@/lib/novel/skill-library"
import { buildOutlineFindProtocol } from "@/lib/novel/outline-find-protocol"

describe("BuildSystemPromptPlugin selected skills", () => {
  it("injects selected skill prompt before final model execution", async () => {
    const plugin = createBuildSystemPromptPlugin({
      baseSystemPrompt: "base prompt",
      buildTaskDirectiveFn: () => "task directive",
    })

    const result = await plugin.run({
      userMessage: "帮我写下一章",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      novelSystemPrompt: "context prompt",
      taskRoute: { intent: "write_chapter", confidence: 0.9, extractedParams: {} },
      selectedSkills: [
        normalizeUserSkill({
          id: "three-four",
          name: "三翻四抖",
          kind: ["structure"],
          stages: ["drafting"],
          modes: ["standard"],
          content: "三次转折，四次震惊。",
          source: "project",
        }),
      ],
    })

    expect(result.finalSystemPrompt).toContain("base prompt")
    expect(result.finalSystemPrompt).toContain("context prompt")
    expect(result.finalSystemPrompt).toContain("本次启用 Skill")
    expect(result.finalSystemPrompt).toContain("三翻四抖")
    expect(result.finalSystemPrompt).toContain("三次转折，四次震惊。")
    expect(result.finalSystemPrompt).toContain("task directive")
    expect(result.finalSystemRulesPrompt).toContain("base prompt")
    expect(result.finalSystemRulesPrompt).toContain("本次启用 Skill")
    expect(result.finalSystemRulesPrompt).toContain("task directive")
    expect(result.finalSystemRulesPrompt).not.toContain("context prompt")
    expect(result.stableSystemRulesPrompt).toBe("base prompt")
    expect(result.dynamicSystemRulesPrompt).toContain("本次启用 Skill")
    expect(result.dynamicSystemRulesPrompt).toContain("task directive")
    expect(result.dynamicSystemRulesPrompt).not.toContain("base prompt")
  })

  it("skips the writing task directive for discuss (co-creation) mode", async () => {
    const plugin = createBuildSystemPromptPlugin({
      baseSystemPrompt: "base prompt",
      buildTaskDirectiveFn: () => "task directive",
    })

    const result = await plugin.run({
      userMessage: "第三章不知道怎么写",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      aiWorkflowMode: "discuss",
      taskRoute: { intent: "write_chapter", confidence: 0.9, extractedParams: {} },
    })

    expect(result.finalSystemPrompt ?? "").not.toContain("章节主编策划协议")
    expect(result.finalSystemPrompt ?? "").not.toContain("task directive")
  })

  it("injects the writing task directive for standard mode", async () => {
    const plugin = createBuildSystemPromptPlugin({
      baseSystemPrompt: "base prompt",
      buildTaskDirectiveFn: () => "task directive",
    })

    const result = await plugin.run({
      userMessage: "帮我写下一章",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      aiWorkflowMode: "standard",
      taskRoute: { intent: "write_chapter", confidence: 0.9, extractedParams: {} },
    })

    expect(result.finalSystemPrompt).not.toContain("章节创作计划协议")
    expect(result.finalSystemPrompt).not.toContain("chapter_plan")
  })

  it("injects outline find protocol for chapter writing", async () => {
    const plugin = createBuildSystemPromptPlugin({
      baseSystemPrompt: "base prompt",
      buildTaskDirectiveFn: () => "task directive",
    })

    const result = await plugin.run({
      userMessage: "写第167章",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      aiWorkflowMode: "strict",
      taskRoute: {
        intent: "write_chapter",
        confidence: 0.95,
        chapterNumber: 167,
        extractedParams: { chapterNumber: "167" },
      },
    })

    expect(result.finalSystemPrompt).toContain("大纲定位协议")
    expect(result.finalSystemPrompt).toContain("本次写作目标：第 167 章")
    expect(result.finalSystemPrompt).toContain("overview")
    expect(result.finalSystemPrompt).not.toContain("章节主编策划协议")
    const occurrences = (result.finalSystemPrompt?.match(/大纲定位协议/g) ?? []).length
    expect(occurrences).toBe(1)
  })

  it("does not inject outline find protocol for non-writing intents", async () => {
    const plugin = createBuildSystemPromptPlugin({
      baseSystemPrompt: "base prompt",
    })

    const result = await plugin.run({
      userMessage: "陈远现在知道什么",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      aiWorkflowMode: "strict",
      taskRoute: { intent: "character_query", confidence: 0.9, extractedParams: {} },
    })

    expect(result.finalSystemPrompt).not.toContain("大纲定位协议")
  })

  it("dedupes outline find protocol already present in base system prompt", async () => {
    const plugin = createBuildSystemPromptPlugin({
      baseSystemPrompt: ["base", buildOutlineFindProtocol(1), "tail"].join("\n\n"),
    })

    const result = await plugin.run({
      userMessage: "写下一章",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      taskRoute: {
        intent: "write_chapter",
        confidence: 0.9,
        chapterNumber: 167,
        extractedParams: {},
      },
    })

    const occurrences = (result.finalSystemPrompt?.match(/大纲定位协议/g) ?? []).length
    expect(occurrences).toBe(1)
    expect(result.finalSystemPrompt).toContain("本次写作目标：第 167 章")
  })
})
