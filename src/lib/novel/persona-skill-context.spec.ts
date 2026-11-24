import { beforeEach, describe, expect, it, vi } from "vitest"

const io = vi.hoisted(() => ({ files: new Map<string, string>() }))

vi.mock("@/commands/fs", () => ({
  fileExists: async (path: string) => io.files.has(path),
  readFile: async (path: string) => {
    if (!io.files.has(path)) throw new Error(`文件缺失：${path}`)
    return io.files.get(path)!
  },
  writeFileAtomic: async (path: string, contents: string) => {
    io.files.set(path, contents)
  },
  createDirectory: async () => {},
  listDirectory: async () => [],
}))

import {
  PERSONA_INJECT_CHAR_BUDGET,
  PERSONA_INJECT_MAX_SKILLS,
  type PersonaSkillMeta,
} from "./persona-skill-types"
import {
  buildPersonaSkillContext,
  matchesPersonaName,
  renderPersonaSkillBlock as renderBlock,
  selectPersonaSkillCandidates,
} from "./persona-skill-context"

import { splitPersonaSkillDocument } from "./persona-skill-profile"

function renderPersonaSkillBlock(meta: PersonaSkillMeta, document: string) {
  return renderBlock(meta, splitPersonaSkillDocument(document))
}

const project = "C:/project"
const indexFile = `${project}/.qmai/persona-skills/index.json`

function meta(overrides: Partial<PersonaSkillMeta> & { characterName: string }): PersonaSkillMeta {
  return {
    id: overrides.characterName,
    aliases: [],
    roleType: "男主",
    tier: "major",
    pinned: false,
    status: "active",
    firstChapter: 1,
    lastChapter: 1,
    appearanceCount: 1,
    createdChapter: 1,
    lastLearnedChapter: 1,
    skillRevision: 1,
    editedByUser: false,
    hasResearch: false,
    updatedAt: "2026-10-10T00:00:00.000Z",
    origin: "auto", outlineRefs: [], asOfChapter: null,
    ...overrides,
  }
}

function doc(fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(([name, value]) => `## ${name}\n\n${value}\n`)
    .join("\n")
  return `# 人物 Skill\n\n${body}`
}

function seed(skills: PersonaSkillMeta[], documents: Record<string, string>) {
  io.files.set(indexFile, JSON.stringify({ version: 1, skills }))
  for (const [id, content] of Object.entries(documents)) {
    io.files.set(`${project}/.qmai/persona-skills/${id}/SKILL.md`, content)
  }
}

const majorFields = {
  怎么说话: "句子短，先问后答。",
  怎么想: "凡事先算退路。",
  怎么判断: "先看对方的手。",
  什么不做: "不碰旧账。",
  知道局限: "不知道沈砚的真实身份。",
}

describe("matchesPersonaName", () => {
  it("完全相等命中", () => {
    expect(matchesPersonaName("林清越", ["林清越"])).toBe(true)
  })

  it("双向包含都命中", () => {
    expect(matchesPersonaName("林清越推开门", ["林清越"])).toBe(true)
    expect(matchesPersonaName("清越", ["林清越"])).toBe(true)
  })

  it("单字查询不做包含匹配，避免污染", () => {
    expect(matchesPersonaName("林", ["林清越"])).toBe(false)
    expect(matchesPersonaName("林", ["林"])).toBe(true)
  })
})

describe("selectPersonaSkillCandidates", () => {
  // 夹具人物名必须 ≥ 2 字：matchesPersonaName 对单字名只允许精确相等，
  // 而这里传进去的是一整段 matchingText，所以单字名会（按设计）匹配不上。
  // 名字只是占位，本组用例测的是排序与状态筛选。
  beforeEach(() => io.files.clear())

  it("绿勾排最前，其次主要人物，再按出场次数降序", () => {
    const index = {
      version: 1 as const,
      skills: [
        meta({ characterName: "甲一", appearanceCount: 3 }),
        meta({ characterName: "乙二", tier: "minor", roleType: "配角", appearanceCount: 9 }),
        meta({ characterName: "丙三", pinned: true, tier: "minor", roleType: "配角", appearanceCount: 1 }),
        meta({ characterName: "丁四", appearanceCount: 7 }),
      ],
    }
    const selected = selectPersonaSkillCandidates(index, "甲一 乙二 丙三 丁四 都出场了")
    expect(selected.map((item) => item.characterName)).toEqual(["丙三", "丁四", "甲一", "乙二"])
  })

  it("归档 / 潜伏的人只要名字出现在本次文本里就入选 —— 回归角色最需要档案", () => {
    const index = {
      version: 1 as const,
      skills: [
        meta({ characterName: "甲一", status: "archived" }),
        meta({ characterName: "乙二", status: "dormant" }),
        meta({ characterName: "丙三", status: "archived", pinned: true }),
      ],
    }
    const selected = selectPersonaSkillCandidates(index, "甲一 乙二 丙三")
    const names = selected.map((item) => item.characterName)
    // 「第 1~3 章出场、消失 50 章、第 54 章回归」的角色，回归那章 status 还是
    // 归档，但名字就在本章文本里 —— 挡掉他的档案等于逼 AI 凭空写老角色。
    expect(names).toHaveLength(3)
    expect(names).toContain("甲一")
    expect(names).toContain("乙二")
    // 绿勾仍然排在最前（预算紧张时优先保住重要人物）
    expect(names[0]).toBe("丙三")

    // 反向：休眠/归档的人名字不在文本里，一个都不占预算
    expect(selectPersonaSkillCandidates(index, "无关的路人")).toEqual([])
  })

  it("本轮和章纲点名的人物先于仅在近期状态中出现的人物", () => {
    const index = { version: 1 as const, skills: [
      meta({ characterName: "甲一", pinned: true }),
      meta({ characterName: "乙二", tier: "minor" }),
    ] }
    expect(selectPersonaSkillCandidates(index, "写乙二回家", "甲一遇见了乙二")
      .map((item) => item.characterName)).toEqual(["乙二", "甲一"])
  })

  it("最多取 12 个", () => {
    const skills = Array.from({ length: 20 }, (_unused, index) =>
      meta({ characterName: `人物${index}`, appearanceCount: 100 - index }),
    )
    const selected = selectPersonaSkillCandidates(
      { version: 1, skills },
      skills.map((item) => item.characterName).join(" "),
    )
    expect(selected).toHaveLength(PERSONA_INJECT_MAX_SKILLS)
  })
})

describe("renderPersonaSkillBlock", () => {
  it("主要人物写 7 段", () => {
    const block = renderPersonaSkillBlock(meta({ characterName: "林清越" }), doc(majorFields))
    for (const field of Object.keys(majorFields)) expect(block).toContain(field)
    expect(block).toContain("主要人物")
    expect(block).toContain("出场 1 次")
  })

  it("次要人物只留「怎么说话 / 怎么判断」，其余段落即使存在也不注入", () => {
    const block = renderPersonaSkillBlock(
      meta({ characterName: "沈砚", tier: "minor", roleType: "配角" }),
      doc(majorFields),
    )
    expect(block).toContain("怎么说话")
    expect(block).toContain("怎么判断")
    expect(block).not.toContain("怎么想")
    expect(block).not.toContain("什么不做")
    expect(block).not.toContain("知道局限")
  })

  it("用户手改过的「补充」段也会注入", () => {
    const block = renderPersonaSkillBlock(
      meta({ characterName: "林清越", editedByUser: true }),
      doc({ 怎么说话: "句子短。", "补充（第 3 章）": "AI 本轮补的观察。" }),
    )
    expect(block).toContain("AI 本轮补的观察。")
  })
})

describe("buildPersonaSkillContext", () => {
  beforeEach(() => io.files.clear())

  it("没有 index.json 时返回空串", async () => {
    expect((await buildPersonaSkillContext(project, "林清越出场了")).skills).toBe("")
  })

  it("matchingText 为空时返回空串，不读盘", async () => {
    seed([meta({ characterName: "林清越" })], { 林清越: doc(majorFields) })
    expect((await buildPersonaSkillContext(project, "   ")).skills).toBe("")
  })

  it("没有命中任何人物时返回空串", async () => {
    seed([meta({ characterName: "林清越" })], { 林清越: doc(majorFields) })
    expect((await buildPersonaSkillContext(project, "完全无关的一段细纲")).skills).toBe("")
  })

  it("命中时输出带标题的块，并包含该人物的字段", async () => {
    seed([meta({ characterName: "林清越" })], { 林清越: doc(majorFields) })
    const { skills: text } = await buildPersonaSkillContext(project, "林清越推开门，看见沈砚。")
    expect(text).toContain("【人物 Skill · 林清越")
    expect(text).toContain("林清越")
    expect(text).toContain("句子短，先问后答。")
  })

  it("别名也能命中", async () => {
    seed([meta({ characterName: "林清越", aliases: ["清越"] })], { 林清越: doc(majorFields) })
    expect((await buildPersonaSkillContext(project, "清越站在门口")).skills).toContain("林清越")
  })

  it("index 里有条目但 SKILL.md 丢了时跳过它，不抛", async () => {
    seed([meta({ characterName: "林清越" })], {})
    expect((await buildPersonaSkillContext(project, "林清越出场了")).skills).toBe("")
  })

  it("排在第十三名的人物仍从实档取小传事实，过期演技不能经投影回流", async () => {
    const people = Array.from({ length: 13 }, (_, i) => meta({ characterName: `角色${i}`, appearanceCount: 20 - i }))
    seed(people, Object.fromEntries(people.map((m) => [m.id, doc({ 怎么说话: "开口就笑", 背景: "曾是船工" })])))
    const briefs = people.map((m) => ({ relativePath: m.id, personaId: m.id, content: "过时的角色档案" }))
    const result = await buildPersonaSkillContext(project, "所有人物聚会", "", briefs)
    expect(result.skills).not.toContain("角色12")
    expect(result.profileFacts.get("角色12")).toContain("曾是船工")
    expect(result.profileFacts.get("角色12")).not.toContain("开口就笑")
  })

  it("总长不超过 4000 字预算", async () => {
    const long = "字".repeat(3000)
    const fields = Object.fromEntries(
      ["怎么说话", "怎么想", "怎么判断", "什么不做", "知道局限"].map((name) => [name, long]),
    )
    const skills = [
      meta({ characterName: "甲一", appearanceCount: 100 }),
      meta({ characterName: "乙二", appearanceCount: 90 }),
      meta({ characterName: "丙三", appearanceCount: 80 }),
    ]
    seed(skills, {
      甲一: doc(fields),
      乙二: doc(fields),
      丙三: doc(fields),
    })
    const { skills: text, profileFacts } = await buildPersonaSkillContext(project, "甲一 乙二 丙三", "", skills.map((item) => ({ personaId: item.id, content: "旧投影", relativePath: item.id })))
    expect(profileFacts.get("丙三")).toContain("定位：男主")
    expect(profileFacts.get("丙三")).not.toContain("怎么说话")
    expect(text.length).toBeLessThanOrEqual(PERSONA_INJECT_CHAR_BUDGET + 20)
    expect(text).toContain("甲一")
    expect(text).toContain("乙二")
    expect(text).not.toContain("丙三")
  })
})

describe("性格段注入", () => {
  const withPersonality = ["# 林清越 · 人物 Skill", "", "## 性格", "", "- 性格标签：毒舌、嘴硬心软", "", "## 怎么说话", "", "短句，爱反问。"].join("\n")

  it("性格段进注入，且排在最前", () => {
    const block = renderPersonaSkillBlock(meta({ characterName: "林清越" }), withPersonality)
    expect(block).toContain("人物性格：毒舌、嘴硬心软")
    expect(block.indexOf("人物性格")).toBeLessThan(block.indexOf("怎么说话"))
  })

  it("自由文本折叠换行，省略号也计入二十字上限", () => {
    const body = "先听别人说完。\n从不轻易表露喜怒，总是提醒自己冷静。"
    const block = renderPersonaSkillBlock(meta({ characterName: "林清越" }), doc({ 性格: body }))
    expect(block.split("人物性格：")[1]).toBe(body.replace("\n", " ").slice(0, 19) + "…")
  })

  it("性格标签超过 4 条时截断，按用户顺序保留前面的", () => {
    const document = ["# X · 人物 Skill", "", "## 性格", "", "- 性格标签：毒舌、嘴硬心软、阴阳怪气、满口网络梗、爱说歇后语"].join("\n")
    const block = renderPersonaSkillBlock(meta({ characterName: "X" }), document)
    const tags = block.split("人物性格：")[1].split("（")[0].split("、")
    expect(tags.length).toBeLessThanOrEqual(4)
    expect(tags[0]).toBe("毒舌")
  })

  it("没有性格段时不产生空的「人物性格：」", () => {
    const block = renderPersonaSkillBlock(meta({ characterName: "X" }), "# X · 人物 Skill\n\n## 怎么说话\n\n短句。")
    expect(block).not.toContain("人物性格")
  })

  it("性格标签合计超过 20 字时整条丢弃，不把标签切一半", () => {
    // 7 + 1 + 11 + 1 + 10 = 30 字 > 20：
    // 第一条 7 字可留；加第二条变 19 字仍可留；第三条会到 30 字，必须整条丢弃。
    const document = ["# X · 人物 Skill", "", "## 性格", "", "- 性格标签：一本正经说胡话、嘴上说不在乎实际很在乎、见不得浪费粮食"].join("\n")
    const block = renderPersonaSkillBlock(meta({ characterName: "X" }), document)
    const shown = block.split("人物性格：")[1].split("（")[0]
    // 关键：不能出现被切一半的标签（例如「见不得浪」）
    expect(shown).toBe("一本正经说胡话、嘴上说不在乎实际很在乎")
  })
})
