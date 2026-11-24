import { beforeEach, describe, expect, it, vi } from "vitest"

const files = vi.hoisted(() => new Map<string, string>())
vi.mock("@/commands/fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/commands/fs")>(),
  readFile: async (path: string) => {
    const text = files.get(path)
    if (text === undefined) throw new Error("文件不存在")
    return text
  },
  fileExists: async (path: string) => files.has(path),
  listDirectory: async (dir: string) => [...files.keys()].filter((p) => p.startsWith(dir + "/"))
    .map((path) => ({ name: path.split("/").pop(), path, is_dir: false })),
}))
vi.mock("@/lib/search", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/search")>(),
  searchWiki: async () => [],
  searchFiles: async () => [],
}))

import { useWikiStore } from "@/stores/wiki-store"
import { composeContext } from "@/lib/context-hub/composer"
import { buildContextPack, contextPackToPrompt } from "./context-engine"
import { renderCharacterProfileHtml } from "./character-profile-template"
import { saveOutlineSaveRequests } from "./outline-save-request"
import { renderPersonaTableMarkdown } from "./persona-projection"

const project = "/book"
const outlineRoot = project + "/wiki/outlines/人物小传"
const skillRoot = project + "/.qmai/persona-skills"

describe("写作上下文中的人物档案和大纲小传", () => {
  beforeEach(() => {
    files.clear()
    useWikiStore.setState({ novelMode: true })
    files.set(skillRoot + "/index.json", JSON.stringify({ version: 1, skills: [
      { id: "林清越", characterName: "林清越", roleType: "男主" },
      { id: "周羽", characterName: "周羽", aliases: ["青衣客"], roleType: "配角" },
    ] }))
    files.set(outlineRoot + "/林清越.md", renderPersonaTableMarkdown({
      personaId: "林清越", characterName: "林清越", roleType: "男主", generatedAt: "2026-10-01",
      fields: { 背景: "曾用旧身份", 怎么说话: "过时的口头禅" },
    }))
    files.set(outlineRoot + "/林清越手稿.md", "# 人物小传：林清越\n作者手稿里的童年约定。")
    files.set(skillRoot + "/林清越/SKILL.md", "# 林清越\n## 背景\n江宁药铺学徒。\n## 怎么说话\n先问对方可曾用药。\n## 性格\n内敛谨慎")
    files.set(outlineRoot + "/周羽.md", renderPersonaTableMarkdown({
      personaId: "周羽", characterName: "周羽", roleType: "配角", generatedAt: "2026-10-01", fields: { 背景: "旧渡口有人记得他。" },
    }))
    files.set(skillRoot + "/周羽/SKILL.md", "# 周羽\n## 背景\n年轻时以摆渡为生。\n## 怎么说话\n句尾总带一声笑。")
  })

  it("按任务与别名匹配，正文和写作对话都能使用最新档案，并保留手写原文", async () => {
    const pack = await buildContextPack(project, "写第4章，林清越去见青衣客。", 4)
    const hub = composeContext({ contextPack: pack, dependencyStamp: { fingerprint: "test", sourceCount: 0, kinds: [] } })
    for (const prompt of [contextPackToPrompt(pack, 20_000), hub.dynamicContext]) {
      for (const phrase of ["江宁药铺学徒。", "先问对方可曾用药。", "内敛谨慎", "句尾总带一声笑。", "年轻时以摆渡为生。"]) {
        expect(prompt.split(phrase), phrase).toHaveLength(2)
      }
      expect(prompt).toContain("作者手稿里的童年约定。")
      expect(prompt).not.toContain("曾用旧身份")
      expect(prompt).not.toContain("过时的口头禅")
    }
  })

  it.each([false, true])("按实际保存路径读取角色卡，双格式只取主稿（Markdown=%s）", async (md) => {
    const data = { name: "林辰", roleType: "男主", sections: [{ kind: "list" as const, heading: "经历", items: ["小时候在旧船厂学徒。"] }] }
    const result = await saveOutlineSaveRequests({
      outlineRoot: project + "/wiki/outlines",
      formats: { md, html: true },
      requests: [{ targetFolder: "人物资料", fileName: "定制档案-2.md", fileType: "character", writeMode: "create",
        referencedSkills: [], sourceIntent: "", content: "# 林辰（男主）\n\n## 经历\n小时候在旧船厂学徒。",
        htmlContent: renderCharacterProfileHtml(data) }],
      fileExists: async (path) => files.has(path), createDirectory: async () => {},
      writeFile: async (path, text) => { files.set(path, text) },
    })
    expect(result.errors).toEqual([])
    expect(result.savedSources).toHaveLength(1)
    files.set(project + "/wiki/outlines/章纲/第1章.html", "<h1>林辰</h1><p>其他章节的私下会议。</p>")
    files.set(skillRoot + "/index.json", JSON.stringify({ version: 1, skills: [{
      id: "林辰", characterName: "林辰", aliases: ["修船匠"], outlineRefs: [result.savedSources[0].relativePath, "章纲/第1章.html"],
    }] }))
    const pack = await buildContextPack(project, "写第4章，修船匠来了。", 4)
    expect(pack.sectionBriefing?.split("小时候在旧船厂学徒。")).toHaveLength(2)
    expect(pack.sectionBriefing).not.toContain("其他章节的私下会议")
    expect(pack.sectionBriefing).not.toContain("<style")
    expect(pack.sectionBriefing).not.toContain("--sec-tint")

    const source = project + "/wiki/outlines/" + result.savedSources[0].relativePath
    files.set(source, "---\nai_exclude: true\n---\n" + files.get(source))
    const excluded = await buildContextPack(project, "写第4章，修船匠来了。", 4)
    expect(excluded.sectionBriefing).not.toContain("小时候在旧船厂学徒。")
  })

  it("只有人物主档也能带入身份资料，作者稿中的相同事实只使用一次", async () => {
    files.set(skillRoot + "/周羽/SKILL.md", "# 周羽\n## 年龄\n二十四岁\n## 背景\n父亲在船厂修船。")
    files.delete(outlineRoot + "/周羽.md")
    const task = "写第4章，周羽去修船。"
    let pack = await buildContextPack(project, task, 4)
    expect(pack.sectionBriefing).toContain("年龄：二十四岁")
    expect(pack.sectionBriefing).toContain("父亲在船厂修船。")
    files.set(outlineRoot + "/角色-配角-周羽.md", "# 周羽（配角）\n父亲在船厂修船。")
    pack = await buildContextPack(project, task, 4)
    expect(pack.sectionBriefing).toContain("年龄：二十四岁")
    expect(pack.sectionBriefing?.split("父亲在船厂修船。")).toHaveLength(2)
  })

  it("有效索引已移除且主档仍在时，历史投影不会恢复人物", async () => {
    files.set(skillRoot + "/index.json", JSON.stringify({ version: 1, skills: [] }))
    const pack = await buildContextPack(project, "写第4章，林清越归乡。", 4)
    const prompt = contextPackToPrompt(pack, 20_000)
    expect(prompt).toContain("作者手稿里的童年约定。")
    expect(prompt).not.toContain("曾用旧身份")
    expect(prompt).not.toContain("过时的口头禅")
    expect(prompt).not.toContain("江宁药铺学徒。")
  })

  it("没有人物索引时按标准角色文件名和标题取完整 Markdown 小传", async () => {
    files.set(outlineRoot + "/角色-男主-林辰.md", "# 林辰（男主）\n\n## 经历\n少年在织布厂打过工。")
    const pack = await buildContextPack(project, "写一场林辰独自出门的戏。")
    expect(pack.sectionBriefing).toContain("少年在织布厂打过工。")
  })

  it("仅按别名点名且主档缺失时，仍能从旧投影取得小传", async () => {
    files.delete(skillRoot + "/周羽/SKILL.md")
    const pack = await buildContextPack(project, "写第4章，青衣客在船头独坐。", 4)
    expect(pack.sectionBriefing).toContain("旧渡口有人记得他。")
  })

  it("别名命中时仍遵守大纲的 AI 不读取标记", async () => {
    const path = outlineRoot + "/周羽.md"
    files.set(path, files.get(path)!.replace("generated-from:", "ai_exclude: true\ngenerated-from:"))
    const pack = await buildContextPack(project, "写第4章，青衣客在船头独坐。", 4)
    expect(pack.sectionBriefing).not.toContain("年轻时以摆渡为生。")
    expect(pack.personaSkills ?? "").not.toContain("句尾总带一声笑。")
  })

  it.each(["缺少档案", "索引损坏"])("%s 时保留旧投影和手写小传", async (fault) => {
    if (fault === "缺少档案") files.delete(skillRoot + "/林清越/SKILL.md")
    else files.set(skillRoot + "/index.json", "{")
    const pack = await buildContextPack(project, "写第4章，林清越离开药铺。", 4)
    expect(pack.sectionBriefing).toContain("曾用旧身份")
    expect(pack.sectionBriefing).toContain("过时的口头禅")
    expect(pack.sectionBriefing).toContain("作者手稿里的童年约定。")
  })
})
