import { afterAll, beforeAll, describe, it } from "vitest"
import path from "node:path"
import { createTempProject, readFileRaw, writeFileRaw } from "@/test-helpers/fs-temp"
import {
  buildStableContextPrefix,
  buildDeepChapterBriefPrompt,
  buildDeepChapterDraftPrompt,
  buildDeepChapterRevisionPrompt,
} from "@/lib/novel/deep-chapter-prompts"
import { buildContextHubPromptParts, withContextHubTaskContent } from "@/lib/context-hub/prompt-content"
import type { ChatMessage } from "@/lib/llm-providers"

/**
 * 在环境变量或 .env.test.local 中配置 CACHE_PROBE_BASE_URL（OpenAI 兼容 API 根地址）
 * 和 CACHE_PROBE_MODEL。需要鉴权的服务另设 CACHE_PROBE_API_KEY。
 * 运行 pnpm run test:llm 可查看各轮请求的缓存命中率。
 */
const baseUrl = process.env.CACHE_PROBE_BASE_URL?.trim().replace(/\/+$/, "")
const model = process.env.CACHE_PROBE_MODEL?.trim()
const apiKey = process.env.CACHE_PROBE_API_KEY?.trim()
const configured = Boolean(baseUrl && model)
const rows: Array<{ tag: string; prompt: number; cached: number; hit: number }> = []

function flatten(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content
  return content.map((block) => block.type === "text" ? block.text : "").join("")
}

async function send(tag: string, messages: ChatMessage[], maxTokens = 8): Promise<number> {
  const body = {
    model,
    messages: messages.map((message) => ({ role: message.role, content: flatten(message.content) })),
    max_tokens: maxTokens,
    stream: false,
  }
  let payload: any = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 160)}`)
      payload = await response.json()
      break
    } catch (error) {
      if (attempt === 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 10_000 * (attempt + 1)))
    }
  }
  const usage = payload.usage ?? {}
  const prompt = usage.prompt_tokens ?? 0
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0
  const hit = prompt > 0 ? cached / prompt : 0
  rows.push({ tag, prompt, cached, hit })
  // eslint-disable-next-line no-console
  console.log(`      ${tag.padEnd(38)} prompt=${String(prompt).padStart(6)} cached=${String(cached).padStart(6)} 命中=${(hit * 100).toFixed(1)}%`)
  return hit
}

async function prepareProjectMaterial(projectPath: string) {
  // 校准要有足够长、在多轮间稳定的前缀，所有记录都由测试生成。
  const outline = Array.from({ length: 120 }, (_, i) =>
    `场景 ${i + 1}：记录员在码头核对第 ${i + 1} 箱货物的封条，值班人递交签收单。两份编号相差一位，记录员把单据留下，等下一班船进港时复核。`,
  ).join("\n")
  const skills = Array.from({ length: 80 }, (_, i) => ({
    scene: i + 1,
    instruction: `用角色观察到的动作引出第 ${i + 1} 号封条，在交接对话中交代谁最后签过字。`,
  }))
  const files = {
    "purpose.md": "缓存测试作品。记录员必须在轮船离港前查清错发的货物。",
    "schema.md": "故事发生在渡口，以交接班记录和货物清单作为线索。",
    "wiki/outlines/码头.md": outline,
    "wiki/memory/当班记录.md": "值班人持有签收单，记录员保管封条。两人约定天亮复核。",
    "writing-skills.json": JSON.stringify(skills),
    "wiki/chapters/chapter-019.md": "雨水沿篷布边缘落下。记录员把两张签收单摊在灯下，等着下一班船。",
  }
  await Promise.all(Object.entries(files).map(([name, content]) =>
    writeFileRaw(path.join(projectPath, name), content),
  ))
  const read = (name: keyof typeof files) => readFileRaw(path.join(projectPath, name))
  const [purpose, schema, plan, context, skillText, chapter] = await Promise.all([
    read("purpose.md"), read("schema.md"), read("wiki/outlines/码头.md"),
    read("wiki/memory/当班记录.md"), read("writing-skills.json"), read("wiki/chapters/chapter-019.md"),
  ])
  return { purpose, schema, outline: [purpose, plan, schema].join("\n\n"), context, skills: skillText, chapter }
}

const user = (text: string): ChatMessage => ({ role: "user", content: text })
const assistant = (text: string): ChatMessage => ({ role: "assistant", content: text })

const suiteName = configured
  ? "真实模型缓存实测"
  : "真实模型缓存实测（已跳过：需要配置 CACHE_PROBE_BASE_URL 和 CACHE_PROBE_MODEL）"

describe.skipIf(!configured)(suiteName, () => {
  let project: Awaited<ReturnType<typeof createTempProject>>
  let material: Awaited<ReturnType<typeof prepareProjectMaterial>>

  beforeAll(async () => {
    project = await createTempProject("cache-probe")
    material = await prepareProjectMaterial(project.path)
  })
  afterAll(async () => { await project?.cleanup() })

  it("场景0：校准——大 prompt 重复两次，确认缓存生效", async () => {
    const calibration: ChatMessage[] = [
      { role: "system", content: "## 校准\n" + material.outline.slice(0, 6000) },
      user("只回复：好"),
    ]
    // eslint-disable-next-line no-console
    console.log("\n[场景0] 校准（本次运行缓存是否在线）")
    await send("校准-第1次", calibration)
    await send("校准-第2次", calibration)
  }, 300_000)

  it("场景1：章节多阶段——现状兄弟请求 vs 单会话追加", async () => {
    const outlinePrompt = "# 【强制遵守】作品完整大纲\n" + material.outline
    const contextPrompt = "## 小说上下文包\n### 人物当前状态\n" + material.context
    const stable = buildStableContextPrefix(outlinePrompt, contextPrompt)

    const brief = buildDeepChapterBriefPrompt(outlinePrompt, contextPrompt, "写第20章", 20)
    const draft = buildDeepChapterDraftPrompt(outlinePrompt, contextPrompt, "上一阶段的任务书正文占位", "写第20章", 20)
    const revision = buildDeepChapterRevisionPrompt(
      outlinePrompt, contextPrompt, "上一阶段的任务书正文占位", material.chapter,
      [{ severity: "error", type: "plot", message: "结尾钩子缺失", evidence: "", relatedMemory: "", suggestion: "补钩子" }],
      "写第20章", 20,
    )

    // eslint-disable-next-line no-console
    console.log(`\n[场景1] 稳定前缀 ${stable.length} 字符（大纲 ${outlinePrompt.length} + 上下文 ${contextPrompt.length}）`)
    // eslint-disable-next-line no-console
    console.log("  1a 现状：三个阶段各发一条独立 user 请求（兄弟）")
    await send("章-任务书（冷）", [user(brief)])
    await send("章-初稿（共享 P？）", [user(draft)])
    await send("章-返修（共享 P？）", [user(revision)])

    // eslint-disable-next-line no-console
    console.log("  1b 修后：同一条会话逐轮追加")
    const turn1: ChatMessage[] = [user(brief)]
    await send("章-单会话 第1轮", turn1)
    const turn2: ChatMessage[] = [...turn1, assistant("任务书：S1 雨夜接头；S2 身份暴露；钩子：尸体手臂的纹身。"), user("请按上述任务书写第20章正文，2000字。")]
    await send("章-单会话 第2轮", turn2)
    const turn3: ChatMessage[] = [...turn2, assistant(material.chapter.slice(0, 1200)), user("按上述问题返修：补结尾钩子。")]
    await send("章-单会话 第3轮", turn3)
  }, 600_000)

  it("场景2：大纲——同一会话连续两轮", async () => {
    const systemRules = "你是小说大纲规划助手。只输出结构化大纲，不写正文。"
    const outlineContext = "## 已有大纲\n" + material.outline
    const turn1: ChatMessage[] = [
      { role: "system", content: systemRules },
      user(outlineContext + "\n\n请给出第20-22章的分卷推进建议。"),
    ]
    // eslint-disable-next-line no-console
    console.log("\n[场景2] 大纲两轮")
    await send("纲-第1轮（冷）", turn1)
    const turn2: ChatMessage[] = [
      ...turn1,
      assistant("第20章：雨夜接头；第21章：身份暴露；第22章：转移据点。"),
      user("把第21章拆成 3 个场景。"),
    ]
    await send("纲-第2轮（追加）", turn2)
    const turn3: ChatMessage[] = [
      { role: "system", content: systemRules },
      user(outlineContext + "\n\n把第22章拆成 3 个场景。"),
    ]
    await send("纲-换问题（兄弟）", turn3)
  }, 600_000)

  it("场景3/4：灵魂+技能库+推演资料——现状（尾部注入）vs 修后（资料前移）", async () => {
    const softwareRules = "## 软件规则\n你是专业小说写作助手。所有面向用户的回复必须使用中文。\n必须遵守角色人格与记忆库。"
    const stableCore = [
      "### 作品灵魂\n" + material.purpose,
      "### 核心设定\n" + material.schema,
      "### 写作风格与技能库\n" + material.skills.slice(0, 4000),
      "### 大纲骨架\n" + material.outline.slice(0, 4000),
    ].join("\n\n")
    const dynamicContext = "### 剧情推演命中\n" + material.context.slice(0, 3000) + "\n\n### 本章相关材料\n" + material.chapter.slice(0, 2500)
    const sessionSummary = "用户：推进第19章；助手：已交付，冲突升级至码头对峙。"

    const parts = buildContextHubPromptParts(softwareRules, {
      stableCore, sessionSummary, dynamicContext,
    } as never, ["## 本轮执行要求\n必须调用 run_chapter_workflow"], ["## 技能库\n" + material.skills.slice(0, 1500)])

    // eslint-disable-next-line no-console
    console.log("\n[场景3] 现状：稳定块在 system，摘要+推演资料注入到 user（下一轮回放未注入原文）")
    const rawA = "写第20章，承接码头对峙。"
    const rawB = "继续，把第20章结尾改成反转。"
    const turnN: ChatMessage[] = [
      { role: "system", content: parts.systemContent },
      user(rawA),
    ]
    // 现状：注入态发送，但存的是原文
    // 旧布局复刻：资料 + 摘要 + 本轮要求全部塞进当前 user 消息
    const legacyTail = [
      { type: "text" as const, text: `## 当前会话摘要\n${sessionSummary}\n\n## 本轮参考资料\n${dynamicContext}` },
      { type: "text" as const, text: "## 本轮执行要求\n必须调用 run_chapter_workflow" },
    ]
    const injectedN: ChatMessage[] = [
      { role: "system", content: parts.systemContent },
      { role: "user", content: withContextHubTaskContent(rawA, legacyTail) },
    ]
    await send("现-第1轮（注入态发送·冷）", injectedN)
    const turnN1: ChatMessage[] = [
      { role: "system", content: parts.systemContent },
      user(rawA),
      assistant("第20章已交付。"),
      { role: "user", content: withContextHubTaskContent(rawB, legacyTail) },
    ]
    await send("现-第2轮（回放原文→断点）", turnN1)

    // eslint-disable-next-line no-console
    console.log("  修后：摘要+推演资料作为独立 user 消息前移到 system 之后、历史之前")
    const materialMessage: ChatMessage = { role: "user", content: parts.chapterPrefix }
    const fixedN: ChatMessage[] = [
      { role: "system", content: parts.systemContent },
      materialMessage,
      user(rawA),
    ]
    await send("修-第1轮（冷）", fixedN)
    const fixedN1: ChatMessage[] = [
      { role: "system", content: parts.systemContent },
      materialMessage,
      user(rawA),
      assistant("第20章已交付。"),
      user(rawB),
    ]
    await send("修-第2轮（资料可命中）", fixedN1)
    void turnN
  }, 600_000)

  it("场景4：技能库是否进入可命中前缀", async () => {
    const withSkillsInSystem: ChatMessage[] = [
      { role: "system", content: "## 软件规则\n你是专业小说写作助手。\n\n## 技能库\n" + material.skills.slice(0, 4000) + "\n\n## 大纲骨架\n" + material.outline.slice(0, 4000) },
      user("按技能库要求写第20章开头 200 字。"),
    ]
    // eslint-disable-next-line no-console
    console.log("\n[场景4] 技能库在 system（可命中）")
    await send("技-第1轮（冷）", withSkillsInSystem)
    const second: ChatMessage[] = [
      ...withSkillsInSystem,
      assistant("雨砸在铁皮上。"),
      user("继续，把视角切到对手。"),
    ]
    await send("技-第2轮（技能库应命中）", second)

    const skillsInTail: ChatMessage[] = [
      { role: "system", content: "## 软件规则\n你是专业小说写作助手。" },
      user(material.skills.slice(0, 3000) + "\n\n按以上技能要求写第20章开头 200 字。"),
    ]
    // eslint-disable-next-line no-console
    console.log("  技能库放在 user 正文里（下一轮回放原文→不可命中）")
    await send("技-尾部 第1轮", skillsInTail)
    await send("技-尾部 第2轮", [
      { role: "system", content: "## 软件规则\n你是专业小说写作助手。" },
      user("按技能库要求写第20章开头 200 字。"),
      assistant("雨砸在铁皮上。"),
      user("继续，把视角切到对手。"),
    ])
  }, 600_000)

  it("汇总", async ({ annotate }) => {
    // eslint-disable-next-line no-console
    console.log("\n===== 汇总 =====")
    for (const row of rows) {
      // eslint-disable-next-line no-console
      console.log(`${row.tag.padEnd(38)} prompt=${String(row.prompt).padStart(6)} cached=${String(row.cached).padStart(6)} 命中=${(row.hit * 100).toFixed(1)}%`)
    }
    const report = path.join(project.path, "cache-probe-app.json")
    await writeFileRaw(report, JSON.stringify(rows, null, 2))
    await annotate("缓存命中统计", { path: report })
  })
})
