import type { PrePlugin, PrePluginInput, PrePluginOutput } from "../pipeline"
import { buildTaskDirective } from "@/lib/novel/task-router"
import {
  buildOutlineFindProtocol,
  shouldIncludeOutlineFindProtocol,
  stripOutlineFindProtocol,
} from "@/lib/novel/outline-find-protocol"
import { buildSelectedSkillsPrompt } from "./select-skills-plugin"

interface BuildSystemPromptPluginDeps {
  baseSystemPrompt?: string
  buildTaskDirectiveFn?: typeof buildTaskDirective
  onError?: (error: Error) => void
}

export function createBuildSystemPromptPlugin(deps: BuildSystemPromptPluginDeps = {}): PrePlugin {
  const { baseSystemPrompt, buildTaskDirectiveFn, onError } = deps

  return {
    name: "build_system_prompt",
    priority: 60,
    run: async (input: PrePluginInput): Promise<PrePluginOutput> => {
      if (!input.novelMode) return {}

      try {
        const buildDirective = buildTaskDirectiveFn || buildTaskDirective
        const route = input.effectiveTaskRoute || input.taskRoute

        const parts: string[] = []
        const rulesParts: string[] = []
        const stableRulesParts: string[] = []
        const dynamicRulesParts: string[] = []

        // 去掉 base 里可能已有的找纲协议，统一由本 plugin 注入一次，避免重复。
        const rawBase = baseSystemPrompt || (input.agentConfig as any)?.systemPrompt || ""
        const base = rawBase ? stripOutlineFindProtocol(rawBase) : ""
        if (base) {
          parts.push(base)
          rulesParts.push(base)
          stableRulesParts.push(base)
        }

        if (input.novelSystemPrompt) {
          parts.push(input.novelSystemPrompt)
        }

        const selectedSkillsPrompt = buildSelectedSkillsPrompt(input.selectedSkills)
        if (selectedSkillsPrompt) {
          parts.push(selectedSkillsPrompt)
          rulesParts.push(selectedSkillsPrompt)
          dynamicRulesParts.push(selectedSkillsPrompt)
        }
        const missingSkillNames = Array.isArray(input.missingSkillNames)
          ? input.missingSkillNames.filter((name): name is string => typeof name === "string")
          : []
        if (missingSkillNames.length > 0) {
          const diagnostic = `## Skill 路由诊断\n以下确定性 Skill 缺失或已被用户禁用，禁止通过 apply_skill 强制启用：${missingSkillNames.join("、")}。请按已加载规则继续，并向用户保留该诊断。`
          parts.push(diagnostic)
          rulesParts.push(diagnostic)
          dynamicRulesParts.push(diagnostic)
        }

        const routeForWriting = input.effectiveTaskRoute || input.taskRoute

        if (shouldIncludeOutlineFindProtocol(routeForWriting?.intent)) {
          const outlineProtocol = buildOutlineFindProtocol(routeForWriting?.chapterNumber)
          parts.push(outlineProtocol)
          rulesParts.push(outlineProtocol)
          dynamicRulesParts.push(outlineProtocol)
        }

        // 共创（discuss）讨论轮只做方向推演，注入写作任务指令会让模型直接吐正文，故跳过。
        if (route && input.aiWorkflowMode !== "discuss") {
          const taskDirective = buildDirective(route)
          if (taskDirective) {
            parts.push(taskDirective)
            rulesParts.push(taskDirective)
            dynamicRulesParts.push(taskDirective)
          }
        }

        if (typeof input.localEntityHint === "string" && input.localEntityHint.trim()) {
          parts.push(input.localEntityHint)
          rulesParts.push(input.localEntityHint)
          dynamicRulesParts.push(input.localEntityHint)
        }

        const finalSystemPrompt = parts.join("\n\n")
        const finalSystemRulesPrompt = rulesParts.join("\n\n")
        return {
          finalSystemPrompt,
          finalSystemRulesPrompt,
          stableSystemRulesPrompt: stableRulesParts.join("\n\n"),
          dynamicSystemRulesPrompt: dynamicRulesParts.join("\n\n"),
        }
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)))
        return {}
      }
    },
  }
}
