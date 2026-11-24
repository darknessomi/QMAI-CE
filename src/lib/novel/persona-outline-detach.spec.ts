import { beforeEach, describe, expect, it, vi } from "vitest"

const io = vi.hoisted(() => ({ files: new Map<string, string>() }))

vi.mock("@/commands/fs", () => ({
  readFile: async (path: string) => {
    if (!io.files.has(path)) throw new Error(`文件缺失：${path}`)
    return io.files.get(path)!
  },
  writeFileAtomic: async (path: string, contents: string) => {
    io.files.set(path, contents)
  },
  createDirectory: async () => {},
  listDirectory: async () => [],
  fileExists: async (path: string) => io.files.has(path),
}))

import {
  outlineSourceRefs,
  resolvePersonaOutlineRef,
  updatePersonaOutlineRefs,
  renamePersonaOutlineFolderRefs,
  planPersonaDetach,
  removePersonaFromIndex,
} from "./persona-outline-detach"
import { buildProjectPathIndexFromTree } from "@/lib/wiki-page-resolver"
import { loadPersonaSkillIndex } from "./persona-skill-store"
import type { PersonaSkillMeta } from "./persona-skill-types"

const project = "C:/project"
const indexFile = `${project}/.qmai/persona-skills/index.json`
const OUTLINE = "卷纲-第一卷.md"

function meta(overrides: Partial<PersonaSkillMeta> & { characterName: string }): PersonaSkillMeta {
  return {
    id: overrides.characterName, aliases: [], roleType: "", tier: "minor", pinned: false,
    status: "active", firstChapter: 1, lastChapter: 4, appearanceCount: 1, createdChapter: 1,
    lastLearnedChapter: 4, skillRevision: 1, editedByUser: false, hasResearch: false,
    updatedAt: "2026-10-10T00:00:00.000Z", origin: "auto", outlineRefs: [OUTLINE], asOfChapter: 4,
    ...overrides,
  }
}

describe("planPersonaDetach", () => {
  it("手工建档的角色永不连带移除", () => {
    const plan = planPersonaDetach({ refs: [OUTLINE], skills: [meta({ characterName: "A", origin: "manual" })] })
    expect(plan.removals).toEqual([])
    expect(plan.kept).toEqual([{ characterName: "A", reason: "manual" }])
  })

  it("绿勾角色永不连带移除", () => {
    const plan = planPersonaDetach({ refs: [OUTLINE], skills: [meta({ characterName: "B", pinned: true })] })
    expect(plan.removals).toEqual([])
    expect(plan.kept).toEqual([{ characterName: "B", reason: "pinned" }])
  })

  it("仍被其他大纲引用时保留，并给出其他引用", () => {
    const plan = planPersonaDetach({
      refs: [OUTLINE],
      skills: [meta({ characterName: "C", outlineRefs: [OUTLINE, "章纲-第3章.md"] })],
    })
    expect(plan.removals).toEqual([])
    expect(plan.kept).toEqual([{ characterName: "C", reason: "referenced", otherRefs: ["章纲-第3章.md"] }])
  })

  it("auto + 未绿勾 + 仅被这一份引用 → 可移除", () => {
    const plan = planPersonaDetach({ refs: [OUTLINE], skills: [meta({ characterName: "D" })] })
    expect(plan.removals).toEqual([{ id: "D", characterName: "D" }])
    expect(plan.kept).toEqual([])
  })

  it("未引用这份大纲的角色既不移除也不列为保留", () => {
    const plan = planPersonaDetach({ refs: [OUTLINE], skills: [meta({ characterName: "E", outlineRefs: [] })] })
    expect(plan.removals).toEqual([])
    expect(plan.kept).toEqual([])
  })

  it("混合场景：一次分拣清楚谁删谁留", () => {
    const plan = planPersonaDetach({
      refs: [OUTLINE],
      skills: [
        meta({ characterName: "手建", origin: "manual" }),
        meta({ characterName: "重点", pinned: true }),
        meta({ characterName: "共用", outlineRefs: [OUTLINE, "章纲-第5章.md"] }),
        meta({ characterName: "可删" }),
      ],
    })
    expect(plan.removals).toEqual([{ id: "可删", characterName: "可删" }])
    expect(plan.kept.map((item) => item.reason)).toEqual(["manual", "pinned", "referenced"])
  })
})

describe("removePersonaFromIndex", () => {
  it("只移除点名的角色，其余按原顺序保留", () => {
    const skills = [meta({ characterName: "A" }), meta({ characterName: "B" }), meta({ characterName: "C" })]
    const result = removePersonaFromIndex(skills, ["B"])
    expect(result.removed).toEqual(["B"])
    expect(result.next.map((item) => item.characterName)).toEqual(["A", "C"])
  })

  it("名字不存在时什么都不移除", () => {
    const result = removePersonaFromIndex([meta({ characterName: "A" })], ["不存在"])
    expect(result.removed).toEqual([])
    expect(result.next).toHaveLength(1)
  })
})

describe("同名大纲与旧书引用", () => {
  const folder = `${project}/wiki/outlines/`
  const path = `${folder}甲/${OUTLINE}`
  const file = { name: OUTLINE, path, is_dir: false }

  it("只有旧文件名在本书大纲中唯一时才复用该引用", () => {
    const index = buildProjectPathIndexFromTree([file, { ...file, path: `${project}/wiki/chapters/${OUTLINE}` }])
    expect(outlineSourceRefs(project, path, index)).toEqual([`甲/${OUTLINE}`, OUTLINE])
    expect(resolvePersonaOutlineRef(project, OUTLINE, index)).toBe(path)
    const duplicate = buildProjectPathIndexFromTree([file, { ...file, path: `${folder}乙/${OUTLINE}` }])
    expect(outlineSourceRefs(project, path, duplicate)).toEqual([`甲/${OUTLINE}`])
    expect(resolvePersonaOutlineRef(project, OUTLINE, duplicate)).toBeUndefined()
    expect(resolvePersonaOutlineRef(project, `甲/${OUTLINE}`, duplicate)).toBe(path)
  })
})

describe("updatePersonaOutlineRefs", () => {
  beforeEach(() => io.files.clear())
  function seed(skills: PersonaSkillMeta[]) {
    io.files.set(indexFile, JSON.stringify({ version: 1, skills }))
  }

  it("整体改名更新所有相对路径、唯一旧文件名，保留其他同名目录", async () => {
    const root = `${project}/wiki/outlines`
    seed([meta({ characterName: "清越", outlineRefs: ["旧/子/隐藏于树的小传.html", "唯一.md", "旧名/记事.md"] })])
    const previous = buildProjectPathIndexFromTree([{ name: "唯一.md", path: `${root}/旧/唯一.md`, is_dir: false }])
    await renamePersonaOutlineFolderRefs(project, `${root}/旧`, `${root}/新`, previous)
    expect((await loadPersonaSkillIndex(project)).skills[0].outlineRefs).toEqual([
      "新/子/隐藏于树的小传.html", "新/唯一.md", "旧名/记事.md",
    ])
  })

  it("移除文件前新出现的引用或重要标记会阻止连带移除，未确认的人也保留", async () => {
    seed([meta({ characterName: "移除" }), meta({ characterName: "共用", outlineRefs: [OUTLINE, "另一份.md"] }),
      meta({ characterName: "重点", pinned: true }), meta({ characterName: "新增" })])
    await updatePersonaOutlineRefs(project, [OUTLINE], { remove: ["移除", "共用", "重点"] })
    const { skills } = await loadPersonaSkillIndex(project)
    expect(skills.map((item) => item.characterName)).toEqual(["共用", "重点", "新增"])
    expect(skills.map((item) => item.outlineRefs)).toEqual([["另一份.md"], [], []])
  })

  it("连带移除仅作用于已确认的档案编号，同名的手建、未确认和新加入的档案保留", async () => {
    const name = "布什"
    const selected = meta({ id: "乔治·布什", characterName: name })
    const protectedProfile = meta({ id: name, characterName: name, origin: "manual" })
    const plan = planPersonaDetach({ refs: [OUTLINE], skills: [selected, protectedProfile] })
    seed([selected, protectedProfile, meta({ id: "新档案", characterName: name })])
    await updatePersonaOutlineRefs(project, [OUTLINE], { remove: plan.removals.map((item) => item.id) })
    expect((await loadPersonaSkillIndex(project)).skills.map(({ id, outlineRefs }) => [id, outlineRefs]))
      .toEqual([[name, []], ["新档案", []]])
  })

  it("选择保留时仅冻结失去唯一来源的自动人物", async () => {
    seed([meta({ characterName: "自动", lastChapter: 7 }), meta({ characterName: "手建", origin: "manual" })])
    await updatePersonaOutlineRefs(project, [OUTLINE], { keepDormant: true })
    expect((await loadPersonaSkillIndex(project)).skills).toMatchObject([
      { outlineRefs: [], status: "dormant", asOfChapter: 7 },
      { outlineRefs: [], status: "active" },
    ])
  })

  it("移动或改名同时替换旧文件名和相对路径，已有新引用只留一条", async () => {
    const from = `甲/${OUTLINE}`
    const to = `乙/${OUTLINE}`
    seed([meta({ characterName: "角色", outlineRefs: [OUTLINE, from, to] })])
    await updatePersonaOutlineRefs(project, [from, OUTLINE], { replacement: to })
    expect((await loadPersonaSkillIndex(project)).skills[0].outlineRefs).toEqual([to])
    expect(await updatePersonaOutlineRefs(project, [from])).toBe(false)
  })
})
