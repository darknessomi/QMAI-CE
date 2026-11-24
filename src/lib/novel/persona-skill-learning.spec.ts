import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import type { PersonaSkillIndex, PersonaSkillMeta } from "./persona-skill-types"

const io = vi.hoisted(() => {
  const files = new Map<string, string>()
  return { files }
})

vi.mock("@/commands/fs", () => ({
  readFile: async (path: string) => {
    if (!io.files.has(path)) throw new Error(`文件缺失：${path}`)
    return io.files.get(path)!
  },
  writeFileAtomic: async (path: string, contents: string) => {
    io.files.set(path, contents)
  },
  // 加固后的 store 靠 fileExists 区分「索引不存在」（可安全当空索引）与
  // 「存在但读不出来」（拒绝写，绝不覆盖）。不 mock 它会掉进真实 Tauri invoke。
  fileExists: async (path: string) => io.files.has(path),
  deleteFile: async (path: string) => {
    io.files.delete(path)
  },
  createDirectory: async () => {},
  listDirectory: async (dir: string) => {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`
    const nodes = new Map<string, { name: string; path: string; is_dir: boolean }>()
    for (const path of io.files.keys()) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      const head = rest.split("/")[0]
      const childPath = `${prefix}${head}`
      nodes.set(childPath, { name: head, path: childPath, is_dir: rest.includes("/") })
    }
    return [...nodes.values()]
  },
}))

const streamChatMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/llm-client", () => ({
  streamChat: streamChatMock,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS: 1000,
}))

vi.mock("@/lib/has-usable-llm", () => ({ hasUsableLlm: () => true }))

// 学习失败必须能被界面看见（App.tsx 订阅这个字段弹 toast），
// 所以这里用 spy 而不是空对象：空对象会让「静默失败」重新长回来。
const storeMock = vi.hoisted(() => ({
  providerConfigs: [] as unknown[],
  setPersonaSkillLearningError: vi.fn(),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: () => storeMock },
}))

import {
  collectChapterAppearances,
  createPersonaSkillByUser,
  demotePersonaSkillToSighting,
  learnPersonaSkillsFromChapter,
  loadCharacterRoleTypes,
  lookupRoleType,
  mergePersonaFields,
  parsePersonaSkillDrafts,
  regeneratePersonaSkillResearch,
  promotePersonaSightingLocal,
  renderPersonaSkillDocument,
  __resetPersonaSkillRoundsForTesting,
} from "./persona-skill-learning"
import { __resetPersonaSkillLocksForTesting, setPersonaSkillStatus } from "./persona-skill-store"

const project = "C:/project"
const indexFile = `${project}/.qmai/persona-skills/index.json`
const sightingsFile = `${project}/.qmai/persona-skills/sightings.json`
const llmConfig = {} as LlmConfig

function roleFile(roleType: string, name: string) {
  io.files.set(`${project}/wiki/characters/角色-${roleType}-${name}.md`, `# ${name}`)
}

function reply(skills: unknown) {
  streamChatMock.mockImplementation(
    async (_config: unknown, _messages: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void }) => {
      callbacks.onToken(JSON.stringify({ skills }))
      callbacks.onDone()
    },
  )
}

// 返回类型要写成 PersonaSkillIndex | null，不能只写 { skills: ... }：
// 下面有用例把 readIndex() 的结果直接喂给 collectChapterAppearances，
// 而它要求 PersonaSkillIndex（含 version），少一个字段就是 TS2345 卡门禁。
function readIndex() {
  return JSON.parse(io.files.get(indexFile) ?? "null") as PersonaSkillIndex | null
}

function readSightings() {
  return JSON.parse(io.files.get(sightingsFile) ?? "null") as { sightings: unknown[] } | null
}

function baseMeta(overrides: Partial<PersonaSkillMeta> = {}): PersonaSkillMeta {
  return {
    id: "林清越",
    characterName: "林清越",
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

function seedIndex(skills: Partial<PersonaSkillMeta>[]) {
  io.files.set(indexFile, JSON.stringify({ version: 1, skills: skills.map(baseMeta) }))
}

describe("loadCharacterRoleTypes", () => {
  it("从文件名读定位，不用读正文", async () => {
    roleFile("男主", "林清越")
    roleFile("男配", "沈砚")
    io.files.set(`${project}/wiki/characters/角色-男主-林-九.md`, "# 名字里带连字符")
    io.files.set(`${project}/wiki/characters/随便.md`, "# 不是角色页")
    const roleTypes = await loadCharacterRoleTypes(project)
    // 键是**归一化**过的（NFKC + 去空白与标点 + 小写）：文件名里的名字被
    // buildCharacterFileName 净化过，与快照里 LLM 抽出的原始名不是同一种写法。
    // 「林-九」的连字符也是净化产物，归一化后与快照里的「林九」才对得上。
    expect(roleTypes).toEqual({ 林清越: "男主", 沈砚: "男配", 林九: "男主" })
  })

  it("文件名被净化过（去空白）也能对上快照里的原始名", async () => {
    // 盘上是「角色-男主-LinChen.md」（sanitize 去掉了空格），
    // 而快照里的人物名是「Lin Chen」。不归一化就会查不到定位 → 静默降成次要档。
    roleFile("男主", "LinChen")
    const roleTypes = await loadCharacterRoleTypes(project)
    expect(lookupRoleType(roleTypes, "Lin Chen")).toBe("男主")
  })

  it("目录不存在时返回空对象，不抛", async () => {
    expect(await loadCharacterRoleTypes("C:/empty")).toEqual({})
  })
})

describe("collectChapterAppearances", () => {
  it("同一章里同一个人只计一次", () => {
    const { appearances } = collectChapterAppearances(
      { version: 1, skills: [] },
      { version: 1, sightings: [] },
      { chapterNumber: 2, chapterBody: "", characters: ["甲", "甲"] },
      {},
    )
    expect(appearances).toHaveLength(1)
    expect(appearances[0].appearanceCount).toBe(1)
  })

  it("别名能认回同一个人物", () => {
    const first = collectChapterAppearances(
      { version: 1, skills: [] },
      { version: 1, sightings: [] },
      { chapterNumber: 1, chapterBody: "", characters: ["林清越"] },
      {},
    )
    const second = collectChapterAppearances(
      { version: 1, skills: [] },
      first.sightings,
      { chapterNumber: 2, chapterBody: "", characters: ["清越"], characterAliases: { 清越: ["林清越"] } },
      {},
    )
    expect(second.sightings.sightings).toHaveLength(1)
    expect(second.appearances[0].appearanceCount).toBe(2)
  })

  it("同一章重复摄取不重复计数", () => {
    seedIndex([{ characterName: "林清越", lastChapter: 3 }])
    io.files.set(`${project}/.qmai/persona-skills/林清越/SKILL.md`, "# 林清越")
    const { appearances } = collectChapterAppearances(
      readIndex()!,
      { version: 1, sightings: [] },
      { chapterNumber: 3, chapterBody: "", characters: ["林清越"] },
      {},
    )
    expect(appearances[0].appearanceCount).toBe(1)
  })

  /*
   * 候选池是每章重新数出来的。用户删掉一个候选之后，如果只从当下的列表里移除，
   * 下一章提取就会把它数回来 —— 删除按钮等于假的。所以「删除」必须落成忽略名单。
   */
  it("忽略名单里的名字不会被数回候选池", () => {
    const { appearances, sightings } = collectChapterAppearances(
      { version: 1, skills: [] },
      { version: 1, sightings: [], ignored: ["小紫"] },
      { chapterNumber: 4, chapterBody: "", characters: ["小紫", "阿青"] },
      {},
    )
    const names = appearances.map((item) => item.characterName)
    expect(names).not.toContain("小紫")
    expect(names).toContain("阿青")
    expect(sightings.sightings.map((item) => item.characterName)).not.toContain("小紫")
    // 名单本身要留着，否则下一次又会数回来
    expect(sightings.ignored).toEqual(["小紫"])
  })

  it("忽略名单会顺手清掉候选池里已有的同名条目", () => {
    const { sightings } = collectChapterAppearances(
      { version: 1, skills: [] },
      {
        version: 1,
        sightings: [
          {
            characterName: "小紫",
            aliases: [],
            roleType: "",
            appearanceCount: 2,
            firstChapter: 1,
            lastChapter: 2,
            chapters: [1, 2],
          },
        ],
        ignored: ["小紫"],
      },
      { chapterNumber: 3, chapterBody: "", characters: [] },
      {},
    )
    expect(sightings.sightings).toHaveLength(0)
  })
})

describe("parsePersonaSkillDrafts", () => {
  const plans = [{
    characterName: "林清越",
    aliases: ["清越"],
    roleType: "男主",
    tier: "major" as const,
    pinned: false,
    appearanceCount: 1,
    mode: "create" as const,
    withResearch: false,
  }]

  it("坏 JSON 返回 null（整轮跳过）", () => {
    expect(parsePersonaSkillDrafts("这不是 JSON", plans)).toBeNull()
  })

  it("根对象缺 skills 数组返回 null", () => {
    expect(parsePersonaSkillDrafts('{"foo":1}', plans)).toBeNull()
  })

  it("用别名也能认回计划里的人物，名字统一成规范名", () => {
    const drafts = parsePersonaSkillDrafts(
      JSON.stringify({ skills: [{ name: "清越", fields: { 怎么说话: "句子短" } }] }),
      plans,
    )
    expect(drafts).toHaveLength(1)
    expect(drafts![0].characterName).toBe("林清越")
    expect(drafts![0].fields["怎么说话"]).toBe("句子短")
  })

  it("计划外的人物被丢掉", () => {
    const drafts = parsePersonaSkillDrafts(
      JSON.stringify({ skills: [{ name: "路人", fields: { 怎么说话: "x" } }] }),
      plans,
    )
    expect(drafts).toEqual([])
  })
})

describe("renderPersonaSkillDocument", () => {
  const base = {
    characterName: "林清越",
    aliases: ["清越"],
    roleType: "男主",
    tier: "major" as const,
    pinned: false,
    appearanceCount: 2,
    firstChapter: 1,
    lastChapter: 2,
    chapterNumber: 2,
    fields: { 怎么说话: "句子短。", 怎么判断: "先看对方的手。", 知道局限: "不知道沈砚的真实身份。" },
    editedByUser: false,
  }

  it("主要人物写出全部提供的字段与 frontmatter", () => {
    const doc = renderPersonaSkillDocument(base)
    expect(doc).toContain("## 怎么说话")
    expect(doc).toContain("## 知道局限")
    expect(doc).toContain("tier: major")
    expect(doc).toContain("appearances: 2")
    expect(doc).toContain("aliases: 清越")
  })

  it("次要人物同样落全部 5 个字段：档位只管注入，不管学习", () => {
    // 用户明确要「第一章角色一出现，skill 基本就成型」。提示词只问 2 个字段的
    // 话，另外 3 格永远空着。学习成本与字段数无关（整章合并成一次请求），
    // 真正稀缺的注入预算由 renderPersonaSkillBlock 按档位裁剪。
    const doc = renderPersonaSkillDocument({ ...base, tier: "minor" })
    expect(doc).toContain("## 怎么说话")
    expect(doc).toContain("## 知道局限")
    expect(doc).toContain("tier: minor")
  })

  it("用户手改过：既有正文逐字保留，新内容进「补充」段", () => {
    const existing = [
      "---",
      "character: 林清越",
      "---",
      "",
      "# 林清越 · 人物 Skill",
      "",
      "## 怎么说话",
      "",
      "这是用户亲手写的一句。",
      "",
    ].join("\n")
    const doc = renderPersonaSkillDocument({
      ...base,
      fields: { 怎么说话: "AI 的新观察。" },
      existing,
      editedByUser: true,
      chapterNumber: 7,
    })
    expect(doc).toContain("这是用户亲手写的一句。")
    expect(doc).toContain("## 补充（截至第 7 章）")
    expect(doc).toContain("AI 的新观察。")
    expect(doc.indexOf("这是用户亲手写的一句。")).toBeLessThan(doc.indexOf("## 补充（截至第 7 章）"))
    expect(doc.match(/# 林清越 · 人物 Skill/g)).toHaveLength(1)
  })

  it("手改档案的补充段只有一个：老档案里多个「补充（第 N 章）」合并，模型合并版优先", () => {
    const existing = [
      "# 林清越 · 人物 Skill",
      "",
      "## 怎么说话",
      "",
      "用户写的。",
      "",
      "## 补充（第 3 章）",
      "",
      "第三章的观察。",
      "",
      "## 补充（第 4 章）",
      "",
      "第四章的观察。",
      "",
    ].join("\n")
    const doc = renderPersonaSkillDocument({
      ...base,
      fields: { 怎么说话: "第五章的观察。" },
      existing,
      editedByUser: true,
      chapterNumber: 5,
      supplement: "第三、四、五章合并后的补充：说话越来越短。",
    })
    expect(doc.match(/^## 补充/gm)).toHaveLength(1)
    expect(doc).toContain("## 补充（截至第 5 章）")
    expect(doc).toContain("第三、四、五章合并后的补充")
    expect(doc).toContain("用户写的。")
    expect(doc).not.toContain("## 补充（第 3 章）")
  })

  it("模型没给补充时，旧补充与本章观察拼起来，不丢旧内容", () => {
    const existing = "# 林清越 · 人物 Skill\n\n## 怎么说话\n\n用户写的。\n\n## 补充（截至第 4 章）\n\n旧补充。\n"
    const doc = renderPersonaSkillDocument({
      ...base,
      fields: { 怎么判断: "先看对方的手。" },
      existing,
      editedByUser: true,
      chapterNumber: 5,
    })
    expect(doc.match(/^## 补充/gm)).toHaveLength(1)
    expect(doc).toContain("旧补充。")
    expect(doc).toContain("怎么判断：先看对方的手。")
  })
})

describe("mergePersonaFields", () => {
  it("新值为空：保留旧值", () => {
    const { fields, kept } = mergePersonaFields({ 怎么说话: "句子短。", 怎么想: "先算代价。" }, { 怎么说话: "句子短，爱反问。" })
    expect(fields).toEqual({ 怎么说话: "句子短，爱反问。", 怎么想: "先算代价。" })
    expect(kept).toEqual([])
  })

  it("新值明显比旧值短：视为漏写，保留旧值并报告", () => {
    const before = "句子短，先问后答；称呼对方一律用全名；生气时反而更客气，尾音拖长。"
    const { fields, kept } = mergePersonaFields({ 怎么说话: before }, { 怎么说话: "句子短。" })
    expect(fields.怎么说话).toBe(before)
    expect(kept).toEqual(["怎么说话"])
  })

  it("没有旧值时直接采用新值", () => {
    expect(mergePersonaFields({}, { 知道局限: "不知道沈砚的身份。" }).fields).toEqual({ 知道局限: "不知道沈砚的身份。" })
  })
})

describe("learnPersonaSkillsFromChapter", () => {
  beforeEach(() => {
    io.files.clear()
    streamChatMock.mockReset()
    __resetPersonaSkillRoundsForTesting()
  })

  it("主要人物第一次出场就建档，并从候选池移走", async () => {
    roleFile("男主", "林清越")
    reply([{ name: "林清越", fields: { 怎么说话: "句子短，先问后答。", 怎么判断: "先看对方的手。" } }])

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["林清越"] },
      llmConfig,
    })

    const index = readIndex()!
    expect(index.skills).toHaveLength(1)
    expect(index.skills[0]).toMatchObject({
      characterName: "林清越",
      roleType: "男主",
      tier: "major",
      appearanceCount: 1,
      lastLearnedChapter: 1,
    })
    expect(io.files.get(`${project}/.qmai/persona-skills/林清越/SKILL.md`)).toContain("句子短，先问后答。")
    expect(readSightings()!.sightings).toHaveLength(0)
  })

  it("同一章 4 个人物合并成 1 次调用；5 个人物分成 2 批", async () => {
    const roles: [string, string][] = [
      ["男主", "甲"], ["女主", "乙"], ["反派", "丙"], ["导师", "丁"], ["主角", "戊"],
    ]
    for (const [role, name] of roles) roleFile(role, name)
    reply(roles.map(([, name]) => ({ name, fields: { 怎么说话: `${name}的语气。` } })))

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: roles.slice(0, 4).map(([, name]) => name) },
      llmConfig,
    })
    expect(streamChatMock).toHaveBeenCalledTimes(1)

    io.files.clear()
    streamChatMock.mockClear()
    __resetPersonaSkillRoundsForTesting()
    for (const [role, name] of roles) roleFile(role, name)
    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: roles.map(([, name]) => name) },
      llmConfig,
    })
    expect(streamChatMock).toHaveBeenCalledTimes(2)
    expect(readIndex()!.skills).toHaveLength(5)
  })

  it("一批失败不影响另一批落盘", async () => {
    const names = ["甲", "乙", "丙", "丁", "戊"]
    for (const name of names) roleFile("男主", name)
    let call = 0
    streamChatMock.mockImplementation(
      async (_c: unknown, _m: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void }) => {
        call += 1
        if (call === 1) throw new Error("第一批网络错误")
        callbacks.onToken(JSON.stringify({ skills: [{ name: "戊", fields: { 怎么说话: "戊的语气。" } }] }))
        callbacks.onDone()
      },
    )

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: names },
      llmConfig,
    })
    expect(readIndex()!.skills.map((item) => item.characterName)).toEqual(["戊"])
  })

  it("次要人物第一次出场不建档，第二次才建档", async () => {
    roleFile("配角", "沈砚")
    reply([{ name: "沈砚", fields: { 怎么说话: "句尾常带「吧」。" } }])

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["沈砚"] },
      llmConfig,
    })
    expect(io.files.has(indexFile)).toBe(false)
    expect(streamChatMock).not.toHaveBeenCalled()
    expect(readSightings()!.sightings).toHaveLength(1)

    __resetPersonaSkillRoundsForTesting()
    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 2, chapterBody: "第二章正文", characters: ["沈砚"] },
      llmConfig,
    })
    expect(streamChatMock).toHaveBeenCalledTimes(1)
    expect(readIndex()!.skills[0]).toMatchObject({ characterName: "沈砚", tier: "minor", appearanceCount: 2 })
  })

  // 「未标注定位」走的是 PERSONA_UNKNOWN_FIRST_APPEARANCE = 3，与「龙套」不是同一件事：
  // 设计规格第 4 节的表述是「出场 ≥3 次才按 minor 处理（自动滤掉一笔带过的路人）」——
  // 也就是说「一笔带过」是被这个门槛滤掉的，而不是靠某个叫「龙套」的定位标签。
  // 所以无定位的人物出场到第 3 次时**应当**建档，不能写成「永远不建档」。
  it("未标注定位：出场两次仍不建档，也不烧模型", async () => {
    // 故意给一份「会被用上」的回复：万一代码错误地调了模型，它就会拿到有效草稿并建档，
    // 从而把后面两条断言一起打红——比 reply([]) 更能证明「真的没烧模型」。
    reply([{ name: "小二", fields: { 怎么说话: "爱搭话。" } }])
    for (const chapterNumber of [1, 2]) {
      __resetPersonaSkillRoundsForTesting()
      await learnPersonaSkillsFromChapter({
        projectPath: project,
        chapter: { chapterNumber, chapterBody: "正文", characters: ["小二"] },
        llmConfig,
      })
    }
    expect(streamChatMock).not.toHaveBeenCalled()
    expect(io.files.has(indexFile)).toBe(false)
    expect(readSightings()!.sightings).toHaveLength(1)
  })

  it("未标注定位：第 3 次出场才建档，按 minor 处理", async () => {
    reply([{ name: "小二", fields: { 怎么说话: "爱搭话。" } }])
    for (const chapterNumber of [1, 2, 3]) {
      __resetPersonaSkillRoundsForTesting()
      await learnPersonaSkillsFromChapter({
        projectPath: project,
        chapter: { chapterNumber, chapterBody: "正文", characters: ["小二"] },
        llmConfig,
      })
    }
    expect(streamChatMock).toHaveBeenCalledTimes(1)
    expect(readIndex()!.skills[0]).toMatchObject({
      characterName: "小二",
      tier: "minor",
      appearanceCount: 3,
    })
  })

  it("同一章重复摄取不二次烧模型，也不重复计数", async () => {
    roleFile("男主", "林清越")
    reply([{ name: "林清越", fields: { 怎么说话: "句子短。" } }])
    const chapter = { chapterNumber: 1, chapterBody: "第一章正文", characters: ["林清越"] }

    await learnPersonaSkillsFromChapter({ projectPath: project, chapter, llmConfig })
    __resetPersonaSkillRoundsForTesting()
    await learnPersonaSkillsFromChapter({ projectPath: project, chapter, llmConfig })

    expect(streamChatMock).toHaveBeenCalledTimes(1)
    expect(readIndex()!.skills[0].appearanceCount).toBe(1)
    expect(readIndex()!.skills[0].lastLearnedChapter).toBe(1)
  })

  it("模型返回坏 JSON：整轮跳过、不建 index，但不抛也不丢候选池计数", async () => {
    roleFile("男主", "林清越")
    streamChatMock.mockImplementation(
      async (_c: unknown, _m: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void }) => {
        callbacks.onToken("我把 JSON 忘了")
        callbacks.onDone()
      },
    )

    await expect(
      learnPersonaSkillsFromChapter({
        projectPath: project,
        chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["林清越"] },
        llmConfig,
      }),
    ).resolves.toBeUndefined()

    expect(io.files.has(indexFile)).toBe(false)
    expect(readSightings()!.sightings).toHaveLength(1)

    // 下一轮换成好 JSON，必须还能补上（证明 lastLearnedChapter 没被推进）
    reply([{ name: "林清越", fields: { 怎么说话: "句子短。" } }])
    __resetPersonaSkillRoundsForTesting()
    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 2, chapterBody: "第二章正文", characters: ["林清越"] },
      llmConfig,
    })
    expect(readIndex()!.skills).toHaveLength(1)
  })

  it("绿勾人物在完善时同时产出研究文件", async () => {
    roleFile("配角", "沈砚")
    seedIndex([{ characterName: "沈砚", id: "沈砚", roleType: "配角", tier: "minor", pinned: true, lastChapter: 2, appearanceCount: 2, lastLearnedChapter: 2 }])
    io.files.set(`${project}/.qmai/persona-skills/沈砚/SKILL.md`, "# 沈砚 · 人物 Skill\n\n## 怎么说话\n\n句尾常带「吧」。\n")
    reply([{
      name: "沈砚",
      fields: { 怎么说话: "句尾常带「吧」。", 怎么判断: "先算代价再开口。" },
      research: { 人物小传: "他是账房出身。", 语言习惯: "自问自答。" },
    }])

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 3, chapterBody: "第三章正文", characters: ["沈砚"] },
      llmConfig,
    })

    const research = io.files.get(`${project}/.qmai/persona-skills/沈砚/references/research/人物小传.md`)
    expect(research).toContain("他是账房出身。")
    expect(readIndex()!.skills[0].hasResearch).toBe(true)
    // 绿勾人物即使在 minor 定位下也按 major 注入
    expect(readIndex()!.skills[0].tier).toBe("major")
  })

  it("已有研究文件的绿勾人物再次完善时不重写研究文件（防用本章素材覆盖累积内容）", async () => {
    roleFile("配角", "沈砚")
    seedIndex([
      {
        characterName: "沈砚",
        id: "沈砚",
        roleType: "配角",
        tier: "minor",
        pinned: true,
        hasResearch: true,
        lastChapter: 2,
        appearanceCount: 2,
        lastLearnedChapter: 2,
      },
    ])
    io.files.set(`${project}/.qmai/persona-skills/沈砚/SKILL.md`, "# 沈砚 · 人物 Skill\n\n## 怎么说话\n\n句尾带吧。\n")
    io.files.set(
      `${project}/.qmai/persona-skills/沈砚/references/research/人物小传.md`,
      "旧的研究内容，不许被覆盖。",
    )
    reply([{
      name: "沈砚",
      fields: { 怎么说话: "句尾带吧。" },
      research: { 人物小传: "本章新素材写的东西。" },
    }])

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 3, chapterBody: "第三章正文", characters: ["沈砚"] },
      llmConfig,
    })

    expect(io.files.get(`${project}/.qmai/persona-skills/沈砚/references/research/人物小传.md`)).toContain(
      "旧的研究内容，不许被覆盖。",
    )
  })

  it("用户手改过的档案只追加「补充」，既有正文逐字保留", async () => {
    roleFile("男主", "林清越")
    seedIndex([{ characterName: "林清越", lastChapter: 2, appearanceCount: 2, lastLearnedChapter: 2, editedByUser: true }])
    io.files.set(
      `${project}/.qmai/persona-skills/林清越/SKILL.md`,
      "# 林清越 · 人物 Skill\n\n## 怎么说话\n\n用户亲手写的句子。\n",
    )
    reply([{ name: "林清越", fields: { 怎么说话: "AI 本次的新观察。" } }])

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 3, chapterBody: "第三章正文", characters: ["林清越"] },
      llmConfig,
    })

    const doc = io.files.get(`${project}/.qmai/persona-skills/林清越/SKILL.md`)!
    expect(doc).toContain("用户亲手写的句子。")
    expect(doc).toContain("AI 本次的新观察。")
    expect(doc).toContain("## 补充（截至第 3 章）")
    expect(readIndex()!.skills[0].editedByUser).toBe(true)
  })

  it("连续 30 章未出场转归档，但文件不删", async () => {
    seedIndex([{ characterName: "林清越", lastChapter: 1, appearanceCount: 1, status: "active" }])
    io.files.set(`${project}/.qmai/persona-skills/林清越/SKILL.md`, "# 林清越 · 人物 Skill\n")

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 31, chapterBody: "第三十一章正文", characters: ["路人"] },
      llmConfig,
    })

    expect(readIndex()!.skills[0].status).toBe("archived")
    expect(io.files.has(`${project}/.qmai/persona-skills/林清越/SKILL.md`)).toBe(true)
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("绿勾人物不会因为长期未出场被归档", async () => {
    seedIndex([{ characterName: "林清越", lastChapter: 1, appearanceCount: 1, status: "active", pinned: true }])
    io.files.set(`${project}/.qmai/persona-skills/林清越/SKILL.md`, "# 林清越 · 人物 Skill\n")

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 99, chapterBody: "第九十九章正文", characters: ["路人"] },
      llmConfig,
    })

    expect(readIndex()!.skills[0].status).toBe("active")
  })
})

describe("regeneratePersonaSkillResearch", () => {
  beforeEach(() => {
    io.files.clear()
    streamChatMock.mockReset()
    __resetPersonaSkillRoundsForTesting()
  })

  it("从既有档案重新整理研究文件，并回写 hasResearch", async () => {
    seedIndex([{ characterName: "沈砚", id: "沈砚", roleType: "配角", pinned: true, hasResearch: false }])
    io.files.set(
      `${project}/.qmai/persona-skills/沈砚/SKILL.md`,
      "# 沈砚 · 人物 Skill\n\n## 怎么说话\n\n句尾常带「吧」。\n",
    )
    streamChatMock.mockImplementation(
      async (_c: unknown, _m: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void }) => {
        callbacks.onToken(JSON.stringify({ research: { 人物小传: "他是账房出身。", 语言习惯: "自问自答。" } }))
        callbacks.onDone()
      },
    )

    const ok = await regeneratePersonaSkillResearch({
      projectPath: project,
      id: "沈砚",
      llmConfig,
    })

    expect(ok).toBe(true)
    expect(io.files.get(`${project}/.qmai/persona-skills/沈砚/references/research/人物小传.md`)).toContain(
      "他是账房出身。",
    )
    expect(readIndex()!.skills[0].hasResearch).toBe(true)
  })

  it("查无此人时返回 false，且不调模型", async () => {
    const ok = await regeneratePersonaSkillResearch({
      projectPath: project,
      id: "查无此人",
      llmConfig,
    })
    expect(ok).toBe(false)
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("模型返回坏 JSON 时返回 false，不写文件，也不抛", async () => {
    seedIndex([{ characterName: "沈砚", id: "沈砚", roleType: "配角", pinned: true }])
    io.files.set(`${project}/.qmai/persona-skills/沈砚/SKILL.md`, "# 沈砚 · 人物 Skill\n\n## 怎么说话\n\n句尾带吧。\n")
    streamChatMock.mockImplementation(
      async (_c: unknown, _m: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void }) => {
        callbacks.onToken("抱歉，我忘了 JSON")
        callbacks.onDone()
      },
    )

    await expect(
      regeneratePersonaSkillResearch({ projectPath: project, id: "沈砚", llmConfig }),
    ).resolves.toBe(false)
    expect(readIndex()!.skills[0].hasResearch).toBe(false)
  })

  it("非绿勾人物：即使盘上还留着研究文件，也不重新整理（D6）", async () => {
    // 被取消绿勾的人，研究文件不会从盘上删掉 —— 视图据此以为「他有研究文件」。
    seedIndex([{ characterName: "沈砚", id: "沈砚", roleType: "配角", pinned: false, hasResearch: true }])
    io.files.set(`${project}/.qmai/persona-skills/沈砚/SKILL.md`, "# 沈砚 · 人物 Skill\n\n## 怎么说话\n\n句尾带吧。\n")
    io.files.set(`${project}/.qmai/persona-skills/沈砚/references/research/人物小传.md`, "旧的小传。")
    streamChatMock.mockImplementation(
      async (_c: unknown, _m: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void }) => {
        callbacks.onToken(JSON.stringify({ research: { 人物小传: "新的小传。" } }))
        callbacks.onDone()
      },
    )

    await expect(
      regeneratePersonaSkillResearch({ projectPath: project, id: "沈砚", llmConfig }),
    ).resolves.toBe(false)
    expect(streamChatMock).not.toHaveBeenCalled()
    // 旧文件一字未动
    expect(io.files.get(`${project}/.qmai/persona-skills/沈砚/references/research/人物小传.md`)).toBe("旧的小传。")
  })
})

describe("人物 Skill 审查修复：并发保存、确定性记账、回填旧章", () => {
  beforeEach(() => {
    io.files.clear()
    streamChatMock.mockReset()
    __resetPersonaSkillRoundsForTesting()
  })

  it("模型调用期间用户保存了手改正文：正文保留、editedByUser 不回退", async () => {
    seedIndex([
      { characterName: "林清越", id: "林清越", roleType: "男主", pinned: false, appearanceCount: 1, lastChapter: 0, editedByUser: false, createdChapter: 1, skillRevision: 1 },
    ])
    io.files.set(
      `${project}/.qmai/persona-skills/林清越/SKILL.md`,
      "# 林清越 · 人物 Skill\n\n## 怎么说话\n\n旧的内容。\n",
    )
    streamChatMock.mockImplementation(
      async (_c: unknown, _m: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void }) => {
        // 模拟「整轮模型调用期间，用户在人物 Skill 页点了保存」
        io.files.set(
          `${project}/.qmai/persona-skills/林清越/SKILL.md`,
          "# 林清越 · 人物 Skill\n\n## 怎么说话\n\n用户亲手改的句子。\n",
        )
        const saved = JSON.parse(io.files.get(indexFile)!) as { skills: Array<Record<string, unknown>> }
        saved.skills[0].editedByUser = true
        io.files.set(indexFile, JSON.stringify(saved))
        callbacks.onToken(JSON.stringify({ skills: [{ name: "林清越", fields: { 怎么说话: "本章新观察。" } }] }))
        callbacks.onDone()
      },
    )

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 2, chapterBody: "第二章正文", characters: ["林清越"] },
      llmConfig,
    })

    const document = io.files.get(`${project}/.qmai/persona-skills/林清越/SKILL.md`)!
    // 用户那句话必须还在（原实现会整份丢掉，只剩「本章新观察。」）
    expect(document).toContain("用户亲手改的句子。")
    expect(document).toContain("## 补充（截至第 2 章）")
    // 护栏不能一起丢，否则下一次还会覆盖
    expect(readIndex()!.skills[0].editedByUser).toBe(true)
  })

  it("模型漏了已建档的人：他的 lastChapter 与状态仍然前进", async () => {
    seedIndex([
      { characterName: "沈砚", id: "沈砚", roleType: "配角", pinned: false, appearanceCount: 3, lastChapter: 5, createdChapter: 3, skillRevision: 1 },
      { characterName: "林清越", id: "林清越", roleType: "男主", pinned: false, appearanceCount: 2, lastChapter: 5, createdChapter: 1, skillRevision: 1 },
    ])
    // 模型只回了林清越，一个字都没提沈砚
    streamChatMock.mockImplementation(
      async (_c: unknown, _m: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void }) => {
        callbacks.onToken(JSON.stringify({ skills: [{ name: "林清越", fields: { 怎么说话: "照旧。" } }] }))
        callbacks.onDone()
      },
    )

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 45, chapterBody: "第四十五章正文", characters: ["沈砚", "林清越"] },
      llmConfig,
    })

    const shen = readIndex()!.skills.find((item) => item.characterName === "沈砚")!
    // 原实现里他停在 lastChapter=5 → gap=40 → archived（正在场上的人被移出注入）
    expect(shen.lastChapter).toBe(45)
    expect(shen.status).toBe("active")
    expect(shen.appearanceCount).toBe(4)
  })

  it("学习与长期未出场会更新自动状态，保留手动分组直到作者恢复自动", async () => {
    seedIndex([
      { characterName: "沈砚", id: "沈砚", lastChapter: 1, manualStatus: "active" },
      { characterName: "林清越", id: "林清越", lastChapter: 1, appearanceCount: 3, manualStatus: "archived" },
    ])
    reply([{ name: "林清越", fields: { 怎么说话: "照旧。" } }])
    await learnPersonaSkillsFromChapter({
      projectPath: project, chapter: { chapterNumber: 45, chapterBody: "林清越进门。", characters: ["林清越"] }, llmConfig,
    })
    const [absent, present] = readIndex()!.skills
    expect(absent).toMatchObject({ status: "archived", manualStatus: "active" })
    expect(present).toMatchObject({ status: "active", manualStatus: "archived", lastLearnedChapter: 45 })
    await setPersonaSkillStatus(project, absent.id, null)
    expect(readIndex()!.skills[0]).toMatchObject({ status: "archived" })
    expect(readIndex()!.skills[0].manualStatus).toBeUndefined()
  })

  it("回填旧章：已归档的人不会因为旧章号被复活", async () => {
    seedIndex([
      { characterName: "沈砚", id: "沈砚", roleType: "配角", pinned: false, appearanceCount: 9, lastChapter: 40, createdChapter: 3, skillRevision: 4, status: "archived" },
    ])
    streamChatMock.mockImplementation(
      async (_c: unknown, _m: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void }) => {
        callbacks.onToken(JSON.stringify({ skills: [] }))
        callbacks.onDone()
      },
    )

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 5, chapterBody: "第五章正文", characters: ["沈砚"] },
      llmConfig,
    })

    // 原实现：currentChapter(5) - lastChapter(40) = -35 → 负数 gap 落进 return "active"
    expect(readIndex()!.skills[0].status).toBe("archived")
  })
})

describe("真实项目回归：定位查不到时靠实体页兜底", () => {
  /**
   * 这一组钉的是线上实测到的静默失效：
   *
   * 定位只写在 `wiki/characters/角色-<定位>-<名>.md` 的文件名里，而那个目录
   * 只有跑过「人物」多智能体生成才会存在。实测项目 `C:\QM-BOOK\黑雨之下`
   * 根本没有 `wiki/characters`，于是所有人 roleType 为空 → 一律按「未标注」
   * 要 3 次出场才建档。那个项目摄取到第 4 章，候选池里最高出场数才 2，
   * 结果一个人都没建档，技能库空空如也，且**全程没有任何报错或日志**。
   *
   * 兜底判据用仓库既有的那条：`wiki/entities/` 下 `tags` 含 `character`
   * 的实体页（`character-aura.ts` 的 isCharacterEntityContent 同款）。
   * 它的价值在于天然斩断路人 —— 正文里一笔带过的「老太太/老头/小男孩」
   * 压根不会建实体页。
   */
  function entityPage(name: string, tags = "[character]") {
    io.files.set(
      `${project}/wiki/entities/${name}.md`,
      `---\ntype: entity\ntitle: "${name}"\ntags: ${tags}\n---\n\n# ${name}\n`,
    )
  }

  /** 一个人物五个字段都给全，确保 renderFieldSections 不会把整条草稿丢成空。 */
  function fullFields() {
    return {
      怎么说话: "话少，句子短。",
      怎么想: "先算代价。",
      怎么判断: "看人先看底线。",
      什么不做: "不拿无辜者交换。",
      知道局限: "救不了所有人。",
    }
  }

  beforeEach(() => {
    io.files.clear()
    streamChatMock.mockReset()
    __resetPersonaSkillRoundsForTesting()
  })

  it("无 wiki/characters、只有实体页：真实人物第一次出场就建档", async () => {
    entityPage("杨寒")
    reply([{ name: "杨寒", fields: fullFields() }])

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["杨寒"] },
      llmConfig,
    })

    // 修复前：roleType 为空 → 门槛 3 → 0 次模型调用、不建 index。
    expect(streamChatMock).toHaveBeenCalledTimes(1)
    const index = readIndex()
    expect(index).not.toBeNull()
    expect(index!.skills.map((item) => item.characterName)).toEqual(["杨寒"])
    // 档位仍是 minor：认出来只影响「什么时候建档」，不影响注入预算档位。
    expect(index!.skills[0].tier).toBe("minor")
    // 建档后从候选池移走
    expect(readSightings()!.sightings).toEqual([])
  })

  it("路人不建实体页，仍按未标注处理：出场两次也不建档", async () => {
    // 「老太太」在正文里出现过，但没有任何实体页 —— 不该为临时角色建档。
    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["老太太"] },
      llmConfig,
    })
    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 2, chapterBody: "第二章正文", characters: ["老太太"] },
      llmConfig,
    })

    expect(streamChatMock).not.toHaveBeenCalled()
    expect(readIndex()).toBeNull()
    expect(readSightings()!.sightings).toHaveLength(1)
  })

  it("实体页 type 不是 entity（设定页重名）不算数", async () => {
    io.files.set(
      `${project}/wiki/entities/归元箓.md`,
      `---\ntype: concept\ntitle: "归元箓"\ntags: [character]\n---\n\n# 归元箓\n`,
    )

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["归元箓"] },
      llmConfig,
    })

    expect(streamChatMock).not.toHaveBeenCalled()
    expect(readIndex()).toBeNull()
  })

  it("实体页没有 character 标签（地点/物品）不算数", async () => {
    entityPage("千碑城", "[location, city]")

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["千碑城"] },
      llmConfig,
    })

    expect(streamChatMock).not.toHaveBeenCalled()
    expect(readIndex()).toBeNull()
  })

  it("声明了定位的主角仍然走主角档：实体页不改变已有定位的优先级", async () => {
    roleFile("主角", "杨寒")
    entityPage("杨寒")
    reply([{ name: "杨寒", fields: fullFields() }])

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["杨寒"] },
      llmConfig,
    })

    expect(readIndex()!.skills[0].tier).toBe("major")
  })

  it("实体页标签写法兼容块列表（tags: 换行 + - character）", async () => {
    io.files.set(
      `${project}/wiki/entities/杨寒.md`,
      `---\ntype: entity\ntitle: "杨寒"\ntags:\n  - character\n  - 主角\n---\n\n# 杨寒\n`,
    )
    reply([{ name: "杨寒", fields: fullFields() }])

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["杨寒"] },
      llmConfig,
    })

    expect(readIndex()!.skills.map((item) => item.characterName)).toEqual(["杨寒"])
  })
})

/**
 * 真实项目报障回归（2026-10-11）：「提取完了，技能库里人物 Skill 还是空的」。
 *
 * 实盘取证：那个项目 `.qmai/persona-skills/` 下**只有 sightings.json**，
 * 从来没有 index.json；章节提取日志里连着两章都是「模型没有返回可解析的 JSON」。
 * 把真实编排跑起来喂各种「模型真会吐出来」的形状后发现：**规范形状是好的**，
 * 但模型一偏离提示词的严格契约，整轮就静默什么都不写 —— 一个字的日志都没有。
 * 这一组用例把那些静默路径逐条钉住。
 */
describe("模型输出形状容错：模型不会逐字照抄提示词", () => {
  const logFile = `${project}/.qmai/chapter-ingest.log`
  const doc = (name: string) => io.files.get(`${project}/.qmai/persona-skills/${name}/SKILL.md`) ?? ""
  const readLog = () => io.files.get(logFile) ?? ""

  function replyRaw(raw: string) {
    streamChatMock.mockImplementation(
      async (_c: unknown, _m: unknown, cb: { onToken: (t: string) => void; onDone: () => void }) => {
        cb.onToken(raw)
        cb.onDone()
      },
    )
  }

  beforeEach(() => {
    io.files.clear()
    streamChatMock.mockReset()
    __resetPersonaSkillRoundsForTesting()
    storeMock.setPersonaSkillLearningError.mockClear()
  })

  it("对照组：完全照抄提示词的规范形状照常建档", async () => {
    roleFile("男主", "林清越")
    reply([{ name: "林清越", fields: { 怎么说话: "句子短，先问后答。", 怎么想: "先算代价。" } }])

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["林清越"] },
      llmConfig,
    })

    expect(readIndex()!.skills).toHaveLength(1)
  })

  it("字段平铺在条目顶层（没有 fields 子对象）也建档", async () => {
    // 之前这条整轮静默：fields 取不到 → 空对象 → 全部 skip → upserts 0 → 一个日志都没有
    roleFile("男主", "林清越")
    replyRaw(
      JSON.stringify({
        skills: [{ name: "林清越", 怎么说话: "句子短，先问后答。", 怎么判断: "先看对方的手。" }],
      }),
    )

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["林清越"] },
      llmConfig,
    })

    expect(readIndex()!.skills.map((item) => item.characterName)).toEqual(["林清越"])
    expect(doc("林清越")).toContain("## 怎么说话")
    expect(doc("林清越")).toContain("句子短，先问后答。")
  })

  it("字段名被改写成近义词：落进规范段，而不是写出一页只有 frontmatter 的空档案", async () => {
    // 之前这条会建出 index 与 SKILL.md，但文档里 0 个 `## ` 段：
    // 库里有卡片、点开什么都没有 —— 用户看到的正是「显示还是为空」。
    roleFile("男主", "林清越")
    replyRaw(
      JSON.stringify({
        skills: [
          {
            name: "林清越",
            fields: { 说话方式: "句子短，句尾带「嗯」。", 思维方式: "先算代价再动。", 判断方式: "看对方手腕。" },
          },
        ],
      }),
    )

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["林清越"] },
      llmConfig,
    })

    const text = doc("林清越")
    expect(text).toContain("## 怎么说话")
    expect(text).toContain("句子短，句尾带「嗯」。")
    expect(text).toContain("## 怎么想")
    expect(text).toContain("## 怎么判断")
  })

  it("名字带装饰（林清越（男主））也能匹配到本轮计划", async () => {
    // 严格按名字查表时这条整轮静默，且模型的「name」字段是最容易跑偏的一项
    roleFile("男主", "林清越")
    replyRaw(JSON.stringify({ skills: [{ name: "林清越（男主）", fields: { 怎么说话: "句子短。" } }] }))

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["林清越"] },
      llmConfig,
    })

    expect(readIndex()!.skills.map((item) => item.characterName)).toEqual(["林清越"])
  })

  it("模型用别名称呼人物：认回同一个人，并统一成规范名建档", async () => {
    roleFile("男主", "林清越")
    replyRaw(JSON.stringify({ skills: [{ name: "清越", fields: { 怎么说话: "句子短。" } }] }))

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: {
        chapterNumber: 1,
        chapterBody: "第一章正文",
        characters: ["林清越"],
        characterAliases: { 林清越: ["清越"] },
      },
      llmConfig,
    })

    expect(readIndex()!.skills.map((item) => item.characterName)).toEqual(["林清越"])
  })

  it("字段值是数组时拼接进正文，而不是整格丢掉", async () => {
    roleFile("男主", "林清越")
    replyRaw(
      JSON.stringify({
        skills: [{ name: "林清越", fields: { 怎么说话: ["句子短。", "句尾常带「嗯」。"] } }],
      }),
    )

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["林清越"] },
      llmConfig,
    })

    expect(doc("林清越")).toContain("句子短。")
    expect(doc("林清越")).toContain("句尾常带「嗯」。")
  })

  it("模型直接返回裸数组（没有 skills 外壳）也能解析", async () => {
    roleFile("男主", "林清越")
    replyRaw(JSON.stringify([{ name: "林清越", fields: { 怎么说话: "句子短。" } }]))

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["林清越"] },
      llmConfig,
    })

    expect(readIndex()!.skills.map((item) => item.characterName)).toEqual(["林清越"])
  })

  it("一条草稿都认不出来时：不写空档案，并把原始输出留在 .qmai/chapter-ingest.log", async () => {
    // 这一条是「下次再出事必须能查」的保险：以前这条路径连一个字的日志都没有。
    roleFile("男主", "林清越")
    replyRaw("我忘了要输出 JSON，这里是林清越的性格：话少。")

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["林清越"] },
      llmConfig,
    })

    expect(io.files.has(indexFile)).toBe(false)
    expect(readLog()).toContain("persona")
    expect(readLog()).toContain("我忘了要输出 JSON")
    // 候选池计数不能丢，下一轮还要能补上
    expect(readSightings()!.sightings).toHaveLength(1)
  })

  it("字段名全都认不出来：不建空档案，写日志并让界面能看见", async () => {
    roleFile("男主", "林清越")
    replyRaw(JSON.stringify({ skills: [{ name: "林清越", fields: { 他喜欢吃辣: "很能吃辣。" } }] }))

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["林清越"] },
      llmConfig,
    })

    expect(io.files.has(indexFile)).toBe(false)
    expect(readLog()).toContain("persona")
    expect(storeMock.setPersonaSkillLearningError).toHaveBeenCalled()
  })

  it("模型调用本身抛错（鉴权/网络/参数被拒）也要留痕并让界面看见", async () => {
    // 这条路径走不到上面任何一条 if：以前只有一句 console.warn，
    // 用户看到的仍然是「技能库空的」，而开发者手上什么都没有。
    roleFile("男主", "林清越")
    streamChatMock.mockImplementation(async () => {
      throw new Error("401 invalid api key")
    })

    await expect(
      learnPersonaSkillsFromChapter({
        projectPath: project,
        chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["林清越"] },
        llmConfig,
      }),
    ).resolves.toBeUndefined()

    expect(io.files.has(indexFile)).toBe(false)
    expect(readLog()).toContain("persona_round_error")
    expect(readLog()).toContain("401 invalid api key")
    expect(storeMock.setPersonaSkillLearningError).toHaveBeenCalled()
  })
})

describe("demotePersonaSkillToSighting", () => {
  beforeEach(() => {
    // 这个 describe 自己没有清理的话，上一条用例写下的 sightings.json 会留下来，
    // 「一个字节都不写」那条断言就会因为看到别人的残留文件而假红。
    io.files.clear()
    __resetPersonaSkillRoundsForTesting()
    __resetPersonaSkillLocksForTesting()
  })

  it("把档案退回候选：index 移除，出场记录写回候选池", async () => {
    seedIndex([
      {
        id: "小紫",
        characterName: "小紫",
        aliases: ["紫儿"],
        roleType: "",
        pinned: true,
        appearanceCount: 2,
        firstChapter: 1,
        lastChapter: 4,
      },
    ])
    io.files.set(sightingsFile, JSON.stringify({ version: 1, sightings: [] }))

    expect(await demotePersonaSkillToSighting({ projectPath: project, id: "小紫" })).toBe(true)

    // 档案区不再有这个人（否则会同时出现在档案区与候选区）
    expect(readIndex()!.skills).toHaveLength(0)
    const sightings = readSightings()!.sightings as Array<Record<string, unknown>>
    expect(sightings).toHaveLength(1)
    expect(sightings[0].characterName).toBe("小紫")
    expect(sightings[0].aliases).toEqual(["紫儿"])
    // 出场次数与首末章要带回去：退回后仍要参与建档门槛的累计，
    // 从 1 重新数会让这个人物看起来像刚出场（用户会觉得又“丢数据”了）
    expect(sightings[0].appearanceCount).toBe(2)
    expect(sightings[0].firstChapter).toBe(1)
    expect(sightings[0].lastChapter).toBe(4)
  })

  it("同名档案退回第二份再建档，原编号、顺序和另一份档案都保留", async () => {
    seedIndex([{ id: "甲", characterName: "布什" }, { id: "乙", characterName: "布什" }])
    expect(await demotePersonaSkillToSighting({ projectPath: project, id: "乙" })).toBe(true)
    expect(readIndex()!.skills.map((meta) => meta.id)).toEqual(["甲"])
    expect(await promotePersonaSightingLocal({ projectPath: project, characterName: "布什" })).toMatchObject({ id: "乙" })
    expect(readIndex()!.skills.map((meta) => meta.id)).toEqual(["甲", "乙"])
    expect(readSightings()!.sightings).toEqual([])
  })

  it("没有这张档案时返回 false，一个字节都不写", async () => {
    seedIndex([{ id: "林清越", characterName: "林清越" }])
    const before = io.files.get(indexFile)

    expect(await demotePersonaSkillToSighting({ projectPath: project, id: "查无此人" })).toBe(false)

    expect(io.files.get(indexFile)).toBe(before)
    expect(io.files.has(sightingsFile)).toBe(false)
  })

  it.each([["乙", "丙"], ["丙", "乙"]])("连续退回两人，先恢复%s再恢复%s，仍在原位", async (first, second) => {
    seedIndex(["甲", "乙", "丙"].map((name) => ({
      id: name, characterName: name, pinned: name === second, manualStatus: name === "乙" ? "archived" : undefined,
    })))
    for (const name of ["乙", "丙"]) {
      expect(await demotePersonaSkillToSighting({ projectPath: project, id: name })).toBe(true)
    }
    await createPersonaSkillByUser({ projectPath: project, characterName: "丁", roleType: "", fields: {} })
    __resetPersonaSkillLocksForTesting()
    await Promise.all([
      promotePersonaSightingLocal({ projectPath: project, characterName: first }),
      createPersonaSkillByUser({ projectPath: project, characterName: second, roleType: "", fields: {} }),
    ])
    expect(readIndex()!.skills.map((item) => item.characterName)).toEqual(["甲", "乙", "丙", "丁"])
    expect(readIndex()!.skills.every((item) => item.status === "active")).toBe(true)
    expect(readIndex()!.skills[1].manualStatus).toBe("archived")
    expect(readIndex()!.skills.filter((item) => item.pinned).map((item) => item.characterName)).toEqual([second])
    expect(readSightings()!.sightings).toEqual([])
  })

  it("重新建档复用旧编号，同名目录已被其他角色使用也能恢复原文与原位置", async () => {
    seedIndex([{ id: "小紫", characterName: "另一位" }, { id: "旧编号", characterName: "小紫" }, { id: "末位", characterName: "末位" }])
    const original = "# 小紫\n\n作者手写的原文。"
    const root = `${project}/.qmai/persona-skills`
    io.files.set(`${root}/旧编号/SKILL.md`, original)
    io.files.set(`${root}/小紫/SKILL.md`, "# 另一位")
    const options = { projectPath: project, characterName: "小紫" }
    expect(await demotePersonaSkillToSighting({ projectPath: project, id: "旧编号" })).toBe(true)
    const restored = await promotePersonaSightingLocal(options)
    expect(restored).toMatchObject({ id: "旧编号", status: "active" })
    expect(readIndex()!.skills.map((item) => item.id)).toEqual(["小紫", "旧编号", "末位"])
    expect(io.files.get(`${root}/旧编号/SKILL.md`)).toBe(original)
    expect(io.files.get(`${root}/小紫/SKILL.md`)).toBe("# 另一位")
  })

  it("原编号已被另一个人占用时保留候选及对方档案", async () => {
    seedIndex([{ id: "旧编号", characterName: "小紫" }])
    const options = { projectPath: project, characterName: "小紫" }
    await demotePersonaSkillToSighting({ projectPath: project, id: "旧编号" })
    seedIndex([{ id: "旧编号", characterName: "另一位" }])
    const path = `${project}/.qmai/persona-skills/旧编号/SKILL.md`
    io.files.set(path, "# 另一位")
    await expect(promotePersonaSightingLocal(options)).rejects.toThrow("编号已被占用")
    expect(readSightings()!.sightings).toHaveLength(1)
    expect(io.files.get(path)).toBe("# 另一位")
  })

  it("章节学习为候选重新建档时也恢复在原位", async () => {
    seedIndex(["开头", "小紫", "末位"].map((name) => ({ id: name === "小紫" ? "旧编号" : name, characterName: name })))
    await setPersonaSkillStatus(project, "旧编号", "dormant")
    await demotePersonaSkillToSighting({ projectPath: project, id: "旧编号" })
    reply([{ name: "小紫", fields: { 怎么说话: "短句。" } }])
    await learnPersonaSkillsFromChapter({
      projectPath: project, chapter: { chapterNumber: 2, chapterBody: "小紫进来了。", characters: ["小紫"] }, llmConfig,
    })
    expect(readIndex()!.skills.map((item) => item.id)).toEqual(["开头", "旧编号", "末位"])
    expect(readIndex()!.skills[1]).toMatchObject({ status: "active", manualStatus: "dormant" })
    expect(readSightings()!.sightings).toEqual([])
  })

  it("候选池里已有同名条目时不重复添加，也不覆盖它的计数", async () => {
    seedIndex([{ id: "小紫", characterName: "小紫", appearanceCount: 9 }])
    io.files.set(
      sightingsFile,
      JSON.stringify({
        version: 1,
        sightings: [
          {
            characterName: "小紫",
            aliases: [],
            roleType: "",
            appearanceCount: 1,
            firstChapter: 1,
            lastChapter: 1,
            chapters: [1],
          },
        ],
      }),
    )

    expect(await demotePersonaSkillToSighting({ projectPath: project, id: "小紫" })).toBe(true)

    const sightings = readSightings()!.sightings as Array<Record<string, unknown>>
    expect(sightings).toHaveLength(1)
    expect(sightings[0].appearanceCount).toBe(1)
  })
})

/*
 * 「完善一次档案就退化成本章残片」的回归组。
 *
 * 旧实现：refine 提示词要模型「只补本章新增」「看不出来给空字符串」，落盘却按整格替换，
 * 于是每完善一次，本章没体现的字段就消失。
 */
describe("人物 Skill 完善：合并而不是覆盖", () => {
  const docPath = `${project}/.qmai/persona-skills/林清越/SKILL.md`
  const fullDoc = [
    "# 林清越 · 人物 Skill",
    "",
    "## 怎么说话",
    "",
    "句子短，先问后答。",
    "",
    "## 怎么想",
    "",
    "先算代价，再算人情。",
    "",
    "## 怎么判断",
    "",
    "看人先看手。",
    "",
    "## 什么不做",
    "",
    "不拿无辜者交换。",
    "",
    "## 知道局限",
    "",
    "不知道沈砚的真实身份。",
    "",
  ].join("\n")

  beforeEach(() => {
    io.files.clear()
    streamChatMock.mockReset()
    __resetPersonaSkillRoundsForTesting()
  })

  it("模型只给了一个字段、其余为空：旧字段全部保留", async () => {
    roleFile("男主", "林清越")
    seedIndex([{ characterName: "林清越", lastChapter: 2, appearanceCount: 2, lastLearnedChapter: 2 }])
    io.files.set(docPath, fullDoc)
    reply([{
      name: "林清越",
      fields: { 怎么说话: "句子短，先问后答；被逼急了会连说三个「好」。", 怎么想: "", 怎么判断: "", 什么不做: "", 知道局限: "" },
    }])

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 3, chapterBody: "第三章正文", characters: ["林清越"] },
      llmConfig,
    })

    const doc = io.files.get(docPath)!
    expect(doc).toContain("被逼急了会连说三个「好」")
    expect(doc).toContain("先算代价，再算人情。")
    expect(doc).toContain("看人先看手。")
    expect(doc).toContain("不拿无辜者交换。")
    expect(doc).toContain("不知道沈砚的真实身份。")
  })

  it("覆盖前把旧版存进历史快照", async () => {
    roleFile("男主", "林清越")
    seedIndex([{ characterName: "林清越", lastChapter: 2, appearanceCount: 2, lastLearnedChapter: 2, skillRevision: 4 }])
    io.files.set(docPath, fullDoc)
    reply([{ name: "林清越", fields: { 怎么说话: "句子短，先问后答，偶尔冷笑。" } }])

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 3, chapterBody: "第三章正文", characters: ["林清越"] },
      llmConfig,
    })

    expect(io.files.get(`${project}/.qmai/persona-skills/林清越/references/history/r000004.md`)).toBe(fullDoc)
  })

  it("并发触发的两轮排队串行：旧章晚到不会把 lastChapter 拨回去", async () => {
    roleFile("男主", "林清越")
    seedIndex([{ characterName: "林清越", lastChapter: 1, appearanceCount: 1, lastLearnedChapter: 1 }])
    io.files.set(docPath, fullDoc)
    let running = 0
    let maxRunning = 0
    streamChatMock.mockImplementation(
      async (_c: unknown, _m: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void }) => {
        running += 1
        maxRunning = Math.max(maxRunning, running)
        await new Promise((resolve) => setTimeout(resolve, 5))
        callbacks.onToken(JSON.stringify({ skills: [{ name: "林清越", fields: { 怎么说话: "句子短，先问后答，偶尔冷笑。" } }] }))
        callbacks.onDone()
        running -= 1
      },
    )

    const third = learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 3, chapterBody: "第三章正文", characters: ["林清越"] },
      llmConfig,
    })
    const second = learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 2, chapterBody: "第二章正文", characters: ["林清越"] },
      llmConfig,
    })
    await Promise.all([third, second])

    expect(maxRunning).toBe(1)
    const meta = readIndex()!.skills[0]
    expect(meta.lastChapter).toBe(3)
    expect(meta.lastLearnedChapter).toBe(3)
  })

  it("建档时带上候选池记录的此前出场章节素材", async () => {
    roleFile("配角", "沈砚")
    io.files.set(
      `${project}/wiki/chapters/chapter-001.md`,
      "---\nchapter_number: 1\n---\n\n院子里很静。\n\n沈砚低声说：「先记账，再算人。」\n",
    )
    reply([{ name: "沈砚", fields: { 怎么说话: "句尾常带「吧」。" } }])

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "沈砚低声说：「先记账，再算人。」", characters: ["沈砚"] },
      llmConfig,
    })
    expect(streamChatMock).not.toHaveBeenCalled()

    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 2, chapterBody: "第二章，沈砚没说话。", characters: ["沈砚"] },
      llmConfig,
    })
    expect(streamChatMock).toHaveBeenCalledTimes(1)
    const messages = streamChatMock.mock.calls[0][1] as Array<{ role: string; content: string }>
    const user = messages.find((message) => message.role === "user")!.content
    expect(user).toContain("此前出场的相关段落（第 1 章）")
    expect(user).toContain("先记账，再算人。")
  })
})


describe("createPersonaSkillByUser", () => {
  it("手工建档：origin=manual、outlineRefs 为空、asOfChapter 为 null", async () => {
    await createPersonaSkillByUser({
      projectPath: project, characterName: "林清越", roleType: "男主",
      fields: { 性别: "男", 年龄: "二十四", 势力组织: "青云宗" },
    })
    const meta = readIndex()!.skills.find((item) => item.characterName === "林清越")!
    expect(meta.origin).toBe("manual")
    expect(meta.outlineRefs).toEqual([])
    expect(meta.asOfChapter).toBeNull()
    expect(meta.tier).toBe("major")
  })

  it("手工建档不调用模型", async () => {
    streamChatMock.mockClear()
    await createPersonaSkillByUser({
      projectPath: project, characterName: "沈砚", roleType: "反派", fields: { 性别: "男" },
    })
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("同名再建不产生第二条档案，改为合并字段", async () => {
    await createPersonaSkillByUser({ projectPath: project, characterName: "林清越", roleType: "男主", fields: { 性别: "男" } })
    await createPersonaSkillByUser({ projectPath: project, characterName: "林清越", roleType: "男主", fields: { 年龄: "二十四" } })
    const skills = readIndex()!.skills.filter((item) => item.characterName === "林清越")
    expect(skills).toHaveLength(1)
    const document = io.files.get(`${project}/.qmai/persona-skills/林清越/SKILL.md`) ?? ""
    expect(document).toContain("男")
    expect(document).toContain("二十四")
  })

  it("已存在的 AI 档案被用户手补一次，origin 仍是 auto", async () => {
    reply([{
      characterName: "林清越", aliases: [], roleType: "男主", tier: "major", mode: "create",
      fields: { 怎么说话: "短句。", 怎么想: "先看利害。", 怎么判断: "看证据。", 什么不做: "不欺弱。", 知道局限: "不知朝局。" },
      research: {}, supplement: "", withResearch: false, pinned: false, appearanceCount: 1,
    }])
    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["林清越"] },
      llmConfig,
    })
    expect(readIndex()!.skills[0].origin).toBe("auto")

    await createPersonaSkillByUser({ projectPath: project, characterName: "林清越", roleType: "男主", fields: { 备注: "手补" } })
    expect(readIndex()!.skills[0].origin).toBe("auto")
  })
})

describe("大纲小传与本地候选共用档案", () => {
  beforeEach(() => io.files.clear())

  it("以别名并发保存同一角色只更新既有 id，保留原文并合并引用", async () => {
    seedIndex([{ id: "旧编号", aliases: ["阿越"] }])
    const document = `${project}/.qmai/persona-skills/旧编号/SKILL.md`
    io.files.set(document, "# 林清越\n\n## 背景\n\n作者原稿\n")
    const options = { projectPath: project, characterName: "阿越", roleType: "", fields: {}, origin: "auto" as const }
    await Promise.all(["章纲/一.md", "章纲/二.md"].map(outlineRef => createPersonaSkillByUser({ ...options, outlineRef })))
    expect(readIndex()!.skills).toHaveLength(1)
    expect(readIndex()!.skills[0]).toMatchObject({ id: "旧编号", characterName: "林清越", outlineRefs: ["章纲/一.md", "章纲/二.md"] })
    expect(io.files.get(document)).toContain("作者原稿")
    expect([...io.files.keys()].some(path => path.includes("/阿越/"))).toBe(false)
  })

  it("本地建档一次性转移候选资料并保留忽略名单，退回后仍然保留", async () => {
    const candidate = { characterName: "林清越", aliases: ["阿越"], roleType: "配角", firstChapter: 2, lastChapter: 6, chapters: [2, 6], appearanceCount: 2 }
    io.files.set(sightingsFile, JSON.stringify({ version: 1, sightings: [candidate], ignored: ["路人"] }))
    const input = { projectPath: project, characterName: "阿越" }
    const results = await Promise.all([promotePersonaSightingLocal(input), promotePersonaSightingLocal(input)])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(readIndex()!.skills[0]).toMatchObject({ characterName: "林清越", aliases: ["阿越"], firstChapter: 2, lastChapter: 6, appearanceCount: 2, editedByUser: false, pinned: true })
    expect(readSightings()).toMatchObject({ sightings: [], ignored: ["路人"] })
    await demotePersonaSkillToSighting({ projectPath: input.projectPath, id: results.find(Boolean)!.id })
    expect(readSightings()).toMatchObject({ sightings: [expect.objectContaining({ characterName: "林清越" })], ignored: ["路人"] })
  })

  it("旧文件名空壳改用真实姓名，保留原 id，实体小传保存后不创建空投影", async () => {
    const old = "角色-男主-林辰"
    seedIndex([{ id: old, characterName: old, roleType: "", firstChapter: 0, lastChapter: 0, createdChapter: 0,
      lastLearnedChapter: 0, editedByUser: true, outlineRefs: [old + ".md"] }])
    const doc = `${project}/.qmai/persona-skills/${old}/SKILL.md`
    io.files.set(doc, `# ${old} · 人物 Skill\n`)
    const input = { projectPath: project, characterName: "林辰", roleType: "男主", fields: {}, origin: "auto" as const,
      outlineRef: `人物小传/${old}.md`, legacyOutlineName: old, skipProjection: true }
    await createPersonaSkillByUser(input)
    await createPersonaSkillByUser({ ...input, outlineRef: "章纲/一.md", legacyOutlineName: undefined, skipProjection: false })
    expect(readIndex()!.skills).toHaveLength(1)
    expect(readIndex()!.skills[0]).toMatchObject({ id: old, characterName: "林辰", editedByUser: false, outlineRefs: [input.outlineRef, "章纲/一.md"] })
    expect(io.files.get(doc)).toBe("# 林辰 · 人物 Skill\n")
    expect(io.files.has(`${project}/wiki/outlines/人物小传/林辰.md`)).toBe(false)
  })

  it("只有旧空壳能与已有真名档合并，旧文件和书稿作者的正文均保留", async () => {
    const old = "角色-反派-林辰"
    const legacy = { id: old, characterName: old, roleType: "", firstChapter: 0, lastChapter: 0,
      createdChapter: 0, lastLearnedChapter: 0, editedByUser: true, outlineRefs: [old + ".md"] }
    const canonical = { id: "林辰", characterName: "林辰", origin: "manual" as const, outlineRefs: ["章纲/初见.md"] }
    seedIndex([legacy, canonical])
    const oldPath = `${project}/.qmai/persona-skills/${old}/SKILL.md`
    const input = { projectPath: project, characterName: "林辰", roleType: "反派", fields: {}, origin: "auto" as const,
      outlineRef: `人物小传/${old}-2.html`, legacyOutlineName: old, skipProjection: true }
    io.files.set(oldPath, "# 作者手写的独立资料")
    await createPersonaSkillByUser(input)
    expect(readIndex()!.skills).toHaveLength(2)
    io.files.set(oldPath, `# ${old} · 人物 Skill\n`)
    await createPersonaSkillByUser(input)
    expect(readIndex()!.skills).toHaveLength(1)
    expect(readIndex()!.skills[0].id).toBe("林辰")
    expect(readIndex()!.skills[0].outlineRefs).toEqual(expect.arrayContaining(["章纲/初见.md", legacy.outlineRefs[0], input.outlineRef]))
    expect(io.files.get(oldPath)).toBe(`# ${old} · 人物 Skill\n`)
  })

  it("自动创建的空档案能学习演技字段，已写小传保留 AI 排除设置", async () => {
    const input = { projectPath: project, characterName: "林清越", roleType: "男主", fields: {}, origin: "auto" as const, outlineRef: "章纲/一.md" }
    const meta = await createPersonaSkillByUser(input)
    expect(meta.editedByUser).toBe(false)
    const target = `${project}/wiki/outlines/人物小传/林清越.md`
    io.files.set(target, io.files.get(target)!.replace("---\n", "---\nai_exclude: true\n"))
    // 旧版将这种标题壳误标成手改；对真实手改文档仍沿用保护。
    const old = readIndex()!
    old.skills[0].editedByUser = true
    io.files.set(indexFile, JSON.stringify(old))
    reply([{ characterName: "林清越", fields: { 怎么说话: "短句" } }])
    await learnPersonaSkillsFromChapter({ projectPath: project, chapter: { chapterNumber: 1, chapterBody: "一句话", characters: ["林清越"] }, llmConfig })
    await learnPersonaSkillsFromChapter({ projectPath: project, chapter: { chapterNumber: 2, chapterBody: "又一句", characters: ["林清越"] }, llmConfig })
    expect(io.files.get(`${project}/.qmai/persona-skills/林清越/SKILL.md`)).toContain("## 怎么说话")
    expect(io.files.get(target)).toContain("| 怎么说话 | 短句 |")
    expect(io.files.get(target)).toContain("ai_exclude: true")
  })
})

describe("自动建档来源标记", () => {
  it("学习建档产出 origin=auto，outlineRefs 为空", async () => {
    io.files.clear()
    roleFile("男主", "林清越")
    reply([{
      characterName: "林清越", aliases: [], roleType: "男主", tier: "major", mode: "create",
      fields: { 怎么说话: "短句。", 怎么想: "先看利害。", 怎么判断: "看证据。", 什么不做: "不欺弱。", 知道局限: "不知朝局。" },
      research: {}, supplement: "", withResearch: false, pinned: false, appearanceCount: 1,
    }])
    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 1, chapterBody: "第一章正文", characters: ["林清越"] },
      llmConfig,
    })
    const meta = readIndex()!.skills[0]
    expect(meta.origin).toBe("auto")
    expect(meta.outlineRefs).toEqual([])
  })
})

describe("asOfChapter 随学习推进", () => {
  // 与其它 describe 同一约定：io.files 是模块级 Map，不清理会把上一个用例建的角色带过来。
  beforeEach(() => {
    io.files.clear()
    streamChatMock.mockReset()
    __resetPersonaSkillRoundsForTesting()
  })

  function draft(name: string) {
    return [{
      characterName: name, aliases: [], roleType: "主角", tier: "major", mode: "create",
      fields: { 怎么说话: "短句。", 怎么想: "先看利害。", 怎么判断: "看证据。", 什么不做: "不欺弱。", 知道局限: "不知朝局。" },
      research: {}, supplement: "", withResearch: false, pinned: false, appearanceCount: 1,
    }]
  }

  it("首次学习建档后，asOfChapter 记为本轮章节号", async () => {
    // 必须先登记定位：未标注定位的角色要出场满 3 次才建档，这里只学一章。
    roleFile("主角", "林清越")
    reply(draft("林清越"))
    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 3, chapterBody: "第三章正文", characters: ["林清越"] },
      llmConfig,
    })
    expect(readIndex()!.skills[0].asOfChapter).toBe(3)
  })

  it("后续学习只往后推：旧章晚到不把冻结点拨回去", async () => {
    roleFile("主角", "林清越")
    reply(draft("林清越"))
    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 5, chapterBody: "第五章正文", characters: ["林清越"] },
      llmConfig,
    })
    expect(readIndex()!.skills[0].asOfChapter).toBe(5)

    reply(draft("林清越"))
    await learnPersonaSkillsFromChapter({
      projectPath: project,
      chapter: { chapterNumber: 2, chapterBody: "第二章正文", characters: ["林清越"] },
      llmConfig,
    })
    // 与 lastLearnedChapter 同一口径：只增不减，否则「停在哪一章」会随批次乱序而倒退
    expect(readIndex()!.skills[0].asOfChapter).toBe(5)
  })
})

describe("手工建档产出投影文件", () => {
  it("createPersonaSkillByUser 会写 wiki/outlines/人物小传/<名>.md", async () => {
    io.files.clear()
    await createPersonaSkillByUser({
      projectPath: project, characterName: "林清越", roleType: "男主",
      fields: { 性别: "男" },
    })
    const target = `${project}/wiki/outlines/人物小传/林清越.md`
    expect(io.files.has(target)).toBe(true)
    const content = io.files.get(target)!
    expect(content).toContain("generated-from: persona-skill")
    expect(content).toContain("| 性别 | 男 |")
  })

  it("已有用户手写的小传文件时不被覆盖", async () => {
    io.files.clear()
    const target = `${project}/wiki/outlines/人物小传/沈砚.md`
    io.files.set(target, "# 用户手写的\n")
    await createPersonaSkillByUser({
      projectPath: project, characterName: "沈砚", roleType: "反派",
      fields: { 性别: "男" },
    })
    expect(io.files.get(target)).toBe("# 用户手写的\n")
  })

  it.each(["007", "#7", "@Q"])("刷新本角色的旧字面 ID 投影 %s 并保留排除标记", async (characterName) => {
    io.files.clear()
    const target = `${project}/wiki/outlines/人物小传/${characterName}.md`
    io.files.set(target, [
      "---", "ai_exclude: true", "generated-from: persona-skill", `persona-id: ${characterName}`,
      "generated-at: 2026-11-20T00:00:00Z", "---", "", "# 旧投影",
    ].join("\n"))
    await createPersonaSkillByUser({ projectPath: project, characterName, roleType: "配角", fields: { 年龄: "二十" } })
    const md = io.files.get(target)
    expect(md).toContain(`persona-id: ${JSON.stringify(characterName)}`)
    expect(md).toContain("ai_exclude: true")
    expect(md).toContain("| 年龄 | 二十 |")
  })
})
