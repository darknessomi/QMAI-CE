import { describe, expect, it } from "vitest"
import { parseFrontmatter } from "@/lib/frontmatter"
import { isAiExcluded, isAiExcludedContent, setAiExcluded } from "./ai-exclude"

const CHAPTER = [
  "---",
  "type: chapter",
  "chapter_number: '7'",
  "chapter_status: final",
  'title: "第7章 断线"',
  "---",
  "",
  "# 第7章 断线",
  "",
  "雨在子夜停了。",
  "",
].join("\n")

const OUTLINE = [
  "---",
  "type: outline",
  "outline_type: chapter-outline",
  "chapter_number: '7'",
  "---",
  "",
  "# 第7章 铁梯上的第二双鞋",
  "",
].join("\n")

describe("isAiExcluded：判定口径", () => {
  /*
   * 读回来的是**字符串** `"true"`：`frontmatter.ts#normalize` 把所有标量都
   * stringify 了。只认布尔会让磁盘上明明写着 `ai_exclude: true` 的文件被判成
   * 「没排除」—— 那正是这个功能最不能出的错，所以单独钉一条。
   */
  it("磁盘读回的形状（字符串 true / 数字 1 / yes）都算已选中", () => {
    expect(isAiExcluded({ ai_exclude: "true" })).toBe(true)
    expect(isAiExcluded({ ai_exclude: true })).toBe(true)
    expect(isAiExcluded({ ai_exclude: 1 })).toBe(true)
    expect(isAiExcluded({ ai_exclude: "1" })).toBe(true)
    expect(isAiExcluded({ ai_exclude: "yes" })).toBe(true)
    expect(isAiExcluded({ ai_exclude: " TRUE " })).toBe(true)
  })

  it("缺省与否定值一律视为未排除 —— 不写标记的老项目行为必须完全不变", () => {
    expect(isAiExcluded(null)).toBe(false)
    expect(isAiExcluded(undefined)).toBe(false)
    expect(isAiExcluded({})).toBe(false)
    expect(isAiExcluded({ ai_exclude: "false" })).toBe(false)
    expect(isAiExcluded({ ai_exclude: false })).toBe(false)
    expect(isAiExcluded({ ai_exclude: 0 })).toBe(false)
    expect(isAiExcluded({ ai_exclude: "" })).toBe(false)
  })
})

describe("setAiExcluded：写盘只碰这一行", () => {
  it("选中：在 frontmatter 首行插入标记，其余 YAML 与正文逐字不动", () => {
    const next = setAiExcluded(CHAPTER, true)
    expect(next.replace("---\nai_exclude: true\n", "---\n")).toBe(CHAPTER)
    expect(isAiExcludedContent(next)).toBe(true)
  })

  it("大纲同理（type/outline_type 都保留）", () => {
    const next = setAiExcluded(OUTLINE, true)
    expect(next.replace("---\nai_exclude: true\n", "---\n")).toBe(OUTLINE)
    expect(isAiExcludedContent(next)).toBe(true)
  })

  it("重复选中不会写出第二行（幂等）", () => {
    const once = setAiExcluded(CHAPTER, true)
    expect(setAiExcluded(once, true)).toBe(once)
    expect(once.match(/ai_exclude:/g)).toHaveLength(1)
  })

  it("取消选中：正好回到原文件（连空行都不多一个）", () => {
    const once = setAiExcluded(CHAPTER, true)
    expect(setAiExcluded(once, false)).toBe(CHAPTER)
  })

  it("本来就没有标记时取消选中是**同一个字符串**（不触发多余写盘）", () => {
    expect(setAiExcluded(CHAPTER, false)).toBe(CHAPTER)
  })

  it("正文里的 ai_exclude 字样不会被误删", () => {
    const withMention = `${CHAPTER}正文里提到 ai_exclude 这个词。\n`
    const next = setAiExcluded(withMention, false)
    expect(next).toBe(withMention)
  })

  it("没有 frontmatter 的文件也会被补出一个最小的块，正文一字不动", () => {
    const plain = "# 卷一 残灯有火\n\n没有 frontmatter 的大纲。\n"
    const next = setAiExcluded(plain, true)
    expect(next.startsWith("---\nai_exclude: true\n---\n")).toBe(true)
    expect(next).toContain("没有 frontmatter 的大纲。")
    expect(isAiExcludedContent(next)).toBe(true)
    expect(isAiExcludedContent(setAiExcluded(next, false))).toBe(false)
  })

  it("CRLF 文件插入的行也用 CRLF，不混入孤立 LF", () => {
    const crlf = CHAPTER.replace(/\n/g, "\r\n")
    const next = setAiExcluded(crlf, true)
    expect(next).toContain("---\r\nai_exclude: true\r\n")
    expect(next.replace(/\r\n/g, "")).not.toContain("\n")
    expect(isAiExcludedContent(next)).toBe(true)
    expect(setAiExcluded(next, false)).toBe(crlf)
  })

  it("写进去的标记能被真实解析链读回，且正文解析结果不变", () => {
    const next = setAiExcluded(OUTLINE, true)
    const parsed = parseFrontmatter(next)
    expect(isAiExcluded(parsed.frontmatter as Record<string, unknown>)).toBe(true)
    expect(parsed.body).toBe(parseFrontmatter(OUTLINE).body)
    // 原有键没有被吞掉
    expect(parsed.frontmatter?.outline_type).toBe("chapter-outline")
  })
})
