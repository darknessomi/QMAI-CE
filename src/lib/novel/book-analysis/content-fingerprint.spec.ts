// content-fingerprint.spec.ts
// 内容指纹模块测试（feature/book-analysis-reuse）
import { describe, it, expect } from "vitest"
import { fingerprintText } from "./content-fingerprint"

describe("content-fingerprint", () => {
  it("fingerprintText 对相同输入稳定", () => {
    expect(fingerprintText("hello world")).toBe(fingerprintText("hello world"))
  })
  it("fingerprintText 对不同输入差异", () => {
    expect(fingerprintText("hello world")).not.toBe(fingerprintText("hello WORLD"))
  })
  it("fingerprintText 接受空字符串", () => {
    expect(fingerprintText("")).toMatch(/^[0-9a-f]{16}$/)
  })
})
