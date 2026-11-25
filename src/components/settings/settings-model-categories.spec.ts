import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import zh from "@/i18n/zh.json"

const settingsViewSource = readFileSync(resolve(__dirname, "settings-view.tsx"), "utf8")

describe("settings model categories", () => {
  it("groups the writing and SAG2 models under a single model settings category", () => {
    expect(settingsViewSource).toContain('| "model"')
    expect(settingsViewSource).toContain('{ id: "model", labelKey: "settings.categories.model", icon: Brain }')
    // 原独立分类已归并
    expect(settingsViewSource).not.toContain('| "llm"')
    expect(settingsViewSource).not.toContain('| "rerank"')
    expect(settingsViewSource).not.toContain('| "embedding"')
  })

  it("renders the merged UiTestModelSettingsSection for the model category", () => {
    expect(settingsViewSource).toContain('case "model":')
    expect(settingsViewSource).toContain("return <UiTestModelSettingsSection draft={draft} setDraft={setDraft} />")
  })

  it("uses the requested Chinese model category names", () => {
    expect(zh.settings.categories.model).toBe("模型设置")
    expect(zh.settings.sections.llm.title).toBe("大语言/LLM模型")
    expect(settingsViewSource).toContain("SAG2 决策模型")
  })
})