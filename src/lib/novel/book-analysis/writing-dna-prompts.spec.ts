import { describe, expect, it } from "vitest"
import { stripConstitutionSection } from "./writing-dna-prompts"

describe("stripConstitutionSection", () => {
  it("摘掉硬约束小节，保留其余小节", () => {
    const body = stripConstitutionSection([
      "## 语言特征",
      "短句为主。",
      "",
      "## 风格硬约束",
      "1. 环境描写不超过 2 句。",
      "",
      "## 排版与节奏",
      "一句一段。",
    ].join("\n"))
    expect(body).toContain("短句为主")
    expect(body).toContain("一句一段")
    expect(body).not.toContain("环境描写不超过 2 句")
  })

  it("硬约束在末尾时也能摘掉", () => {
    const body = stripConstitutionSection("## 语言特征\n短句为主。\n\n## 风格硬约束\n1. 用短句。")
    expect(body).toContain("短句为主")
    expect(body).not.toContain("用短句")
  })

  it("没有该小节时原样返回", () => {
    expect(stripConstitutionSection("## 语言特征\n短句为主。")).toBe("## 语言特征\n短句为主。")
  })
})
