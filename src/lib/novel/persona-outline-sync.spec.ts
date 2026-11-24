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
  deleteFile: async () => {},
}))

import { collectOutlineCharacters, syncPersonaFromOutlineSave } from "./persona-outline-sync"
import type { PersonaSkillMeta } from "./persona-skill-types"
import type { OutlineSaveRequest } from "./outline-save-request"

const project = "C:/project"
const indexFile = `${project}/.qmai/persona-skills/index.json`

function meta(characterName: string): PersonaSkillMeta {
  return {
    id: characterName, characterName, aliases: [], roleType: "", tier: "minor", pinned: false,
    status: "active", firstChapter: 0, lastChapter: 0, appearanceCount: 1, createdChapter: 0,
    lastLearnedChapter: 0, skillRevision: 1, editedByUser: false, hasResearch: false,
    updatedAt: "2026-10-10T00:00:00.000Z", origin: "auto", outlineRefs: [], asOfChapter: null,
  }
}

function req(partial: Partial<OutlineSaveRequest>): OutlineSaveRequest {
  return {
    targetFolder: "章纲", fileName: "章纲-第3章.md", fileType: "chapter-outline",
    writeMode: "create", referencedSkills: [], sourceIntent: "", content: "",
    ...partial,
  }
}

function castTable(...names: string[]): string {
  return [
    "## §13 出场角色与状态变化",
    "",
    "| 角色 | 本章作用 | 入场状态 | 结束状态 | 关系变化 |",
    "| --- | --- | --- | --- | --- |",
    ...names.map((name) => `| ${name} | 主线推进 | 潜伏 | 现身 | 与主角决裂 |`),
  ].join("\n")
}

describe("collectOutlineCharacters", () => {
  it("只从章纲角色列抽取名字，忽略重复与空行", () => {
    const request = req({ content: castTable("林清越", "", "林清越", "沈砚") })
    expect(collectOutlineCharacters(request).map((entry) => entry.name)).toEqual(["林清越", "沈砚"])
  })

  it.each([
    ["角色-男主-陆云飞.md", "", "陆云飞", "男主"],
    ["角色-苏晚.md", "# 苏晚（女主）\n\n## 性格\n\n谨慎。", "苏晚", "女主"],
    ["人物小传.md", "# 沈砚（反派）\n\n## 性格\n\n谨慎。", "沈砚", "反派"],
    ["苏晚.md", "# 用户记录\n", "苏晚", ""],
  ])("识别人物小传 %s 的真实姓名与定位", (fileName, content, name, roleType) => {
    const request = req({ targetFolder: "人物小传", fileName, fileType: "character", content })
    expect(collectOutlineCharacters(request)).toEqual([{ name, roleType }])
  })

  it("识别当前卷纲的环节人物与旧卷纲的人物清单", () => {
    const current = { stories: [{ st: [{ who: "顾长明（主角）＋ 谢无咎（引路）" }] }], cast: [{ n: "陆云飞" }] }
    const legacy = { volumes: [{ n: 1, roles: [{ name: "顾长明" }, { name: "谢无咎" }] }] }
    const volumeNames = (data: unknown) => collectOutlineCharacters(req({
      targetFolder: "卷纲", fileType: "volume-outline", structuredData: JSON.stringify(data),
    })).map((entry) => entry.name)
    expect(volumeNames(current)).toEqual(["顾长明", "谢无咎", "陆云飞"])
    expect(volumeNames(legacy)).toEqual(["顾长明", "谢无咎"])
    expect(collectOutlineCharacters(req({ fileType: "volume-outline", structuredData: "{坏 JSON" }))).toEqual([])
  })
})

describe("syncPersonaFromOutlineSave", () => {
  beforeEach(() => io.files.clear())

  it("按实际保存的文件关联人物；重试保留旧档案，按别名复用人物", async () => {
    io.files.set(indexFile, JSON.stringify({ version: 1, skills: [{ ...meta("林清越"), aliases: ["阿越"] }] }))
    const documentPath = `${project}/.qmai/persona-skills/林清越/SKILL.md`
    const old = "# 林清越 · 人物 Skill\n\n## 怎么说话\n\n短句。\n"
    io.files.set(documentPath, old)
    const chapter = req({ content: castTable("阿越", "陆云飞") })
    const character = req({
      fileType: "character", targetFolder: "人物小传", fileName: "人物定稿.md",
      character: { name: "陆云飞", roleType: "男主" }, content: "# 用于印刷的封面",
    })
    const htmlPath = `${project}/wiki/outlines/人物小传/人物定稿-2.html`
    io.files.set(htmlPath, "<html>完整小传</html>")
    const input = { projectPath: project, savedSources: [
      { request: chapter, relativePath: "章纲/章纲-第3章-2.md" },
      { request: character, relativePath: "人物小传/人物定稿-2.html" },
    ] }
    await syncPersonaFromOutlineSave(input)
    await syncPersonaFromOutlineSave(input)
    const skills = JSON.parse(io.files.get(indexFile)!).skills
    expect(skills).toHaveLength(2)
    expect(skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ characterName: "林清越", outlineRefs: ["章纲/章纲-第3章-2.md"] }),
      expect.objectContaining({ characterName: "陆云飞", roleType: "男主", origin: "auto", outlineRefs: ["人物小传/人物定稿-2.html", "章纲/章纲-第3章-2.md"] }),
    ]))
    expect(io.files.get(documentPath)).toBe(old)
    expect(io.files.get(htmlPath)).toBe("<html>完整小传</html>")
    expect(io.files.has(`${project}/wiki/outlines/人物小传/陆云飞.md`)).toBe(false)
  })

  it("重存旧角色小传时，沿用旧空壳的档案目录", async () => {
    const oldName = "角色-男主-林清越"
    io.files.set(indexFile, JSON.stringify({ version: 1, skills: [
      { ...meta(oldName), editedByUser: true, outlineRefs: [`${oldName}.md`] },
    ] }))
    io.files.set(`${project}/.qmai/persona-skills/${oldName}/SKILL.md`, `# ${oldName} · 人物 Skill\n`)
    const request = req({ fileType: "character", targetFolder: "人物小传", fileName: `${oldName}.md` })
    const relativePath = `人物小传/${oldName}.md`
    await syncPersonaFromOutlineSave({ projectPath: project, savedSources: [{ request, relativePath }] })
    expect(JSON.parse(io.files.get(indexFile)!).skills).toEqual([
      expect.objectContaining({ id: oldName, characterName: "林清越", outlineRefs: [relativePath] }),
    ])
  })

  it("保留既有手写的小传文件", async () => {
    io.files.set(`${project}/wiki/outlines/人物小传/林清越.md`, "# 用户手写的\n")
    await syncPersonaFromOutlineSave({ projectPath: project, savedSources: [
      { request: req({ content: castTable("林清越") }), relativePath: "章纲/章纲-第3章.md" },
    ] })
    expect(io.files.get(`${project}/wiki/outlines/人物小传/林清越.md`)).toBe("# 用户手写的\n")
  })

  it("一位人物档案编号冲突时仍同步同一来源的其他角色", async () => {
    io.files.set(indexFile, JSON.stringify({ version: 1, skills: [{ ...meta("受阻"), id: "后来的角色" }] }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const synced = await syncPersonaFromOutlineSave({ projectPath: project, savedSources: [
        { request: req({ content: castTable("后来的角色", "林清越") }), relativePath: "章纲/第三章.md" },
      ] })
      expect(synced).toBe(true)
      expect(warn).toHaveBeenCalled()
      expect(JSON.parse(io.files.get(indexFile)!).skills).toEqual(expect.arrayContaining([
        expect.objectContaining({ characterName: "林清越", outlineRefs: ["章纲/第三章.md"] }),
      ]))
    } finally {
      warn.mockRestore()
    }
  })
})
