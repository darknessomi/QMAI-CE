import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(/\r\n/g, "\n")

describe("写作上下文注入人物 Skill", () => {
  const contextEngine = read("./context-engine.ts")

  it("静态引入 persona-skill-context（它不拖重依赖）", () => {
    expect(contextEngine).toContain('import { buildPersonaSkillContext } from "./persona-skill-context"')
  })

  it("使用任务关联的章纲和人物状态匹配人物 Skill", () => {
    expect(contextEngine).toContain("const personaMatchingText = joinNonEmpty([")
    expect(contextEngine).toContain("buildPersonaSkillContext(context.projectPath, personaMatchingText)")
  })

  it("用 personaSkills 字段承载匹配结果", () => {
    expect(contextEngine).toContain("personaSkills?: string")
    expect(contextEngine).toContain("personaSkills: 10.5,")
    expect(contextEngine).toContain('fieldKey: "personaSkills"')
    expect(contextEngine).toContain("...(personaSkillContext ? { personaSkills: personaSkillContext } : {}),")
  })

  it("注入失败不能弄挂写作", () => {
    expect(contextEngine).toContain(
      'buildPersonaSkillContext(context.projectPath, personaMatchingText).catch(() => "")',
    )
  })
})
