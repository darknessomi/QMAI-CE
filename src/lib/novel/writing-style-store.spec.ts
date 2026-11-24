import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import type { BookStyleProfile } from "./book-analysis/types"

const mem = new Map<string, string>()

vi.mock("@/commands/fs", () => ({
  fileExists: vi.fn(async (path: string) => mem.has(path)),
  readFile: vi.fn(async (path: string) => {
    if (!mem.has(path)) throw new Error("ENOENT")
    return mem.get(path)!
  }),
  writeFileAtomic: vi.fn(async (path: string, content: string) => {
    mem.set(path, content)
  }),
  createDirectory: vi.fn(async () => {}),
}))

import {
  loadWritingStyleStore,
  setEnabledWritingStyle,
  getEnabledWritingStyle,
  buildWritingStyleContext,
  removeWritingStylePreset,
  createWritingStylePreset,
  updateWritingStylePreset,
  getWritingStylePreset,
} from "./writing-style-store"

const PROJECT = "E:/Novel"

/** v1 形状的旧画像：没有 layers / metrics / integratedDna。 */
function makeProfile(overrides: Partial<BookStyleProfile> = {}): BookStyleProfile {
  return {
    schemaVersion: 1,
    generatedAt: 1,
    sampledChapterIds: ["ch-0001"],
    narrativeDensity: "密度高、推进快",
    descriptionWeight: "",
    emotionRendering: "",
    sentenceStyle: "",
    rhetoricDensity: "",
    transitionStyle: "",
    narrativeVoice: "",
    dialogueStyle: "",
    thematicHabits: "",
    constitution: "1. 朴素\n2. 克制",
    samples: ["原文片段一", "原文片段二"],
    ...overrides,
  }
}

/** v2 形状：含分层产物与整合文档。 */
function makeDnaProfile(overrides: Partial<BookStyleProfile> = {}): BookStyleProfile {
  return makeProfile({
    schemaVersion: 2,
    layers: {
      languageDna: "短句为主。",
      structurePatterns: "推进章骨架。",
      cognitiveFrame: "能一句带过就不展开。",
      rhythmGuide: "一句一段用于转折。",
    },
    integratedDna: [
      "## 语言特征",
      "短句为主，平均句长 12 字。",
      "",
      "## 风格硬约束",
      "1. 环境描写不超过 2 句。",
    ].join("\n"),
    ...overrides,
  })
}

beforeEach(() => {
  mem.clear()
})

describe("writing-style-store", () => {
  it("忽略旧拆书文风，保留自建和自进化预设及原始记录", async () => {
    const path = `${PROJECT}/.qmai/writing-style.json`
    const profile = makeProfile({ sampledChapterIds: ["chapter-1"] })
    const presets = [
      { id: "style-1000-books", sourceBook: "旧拆书", profile },
      { id: "style-2000-tagged", sourceBook: "已发布的拆书", sourceBookId: "book-1", profile },
      { id: "style-3000-evolve", sourceBook: "我的文风 · 自动进化 · 第 1 轮", profile },
      { id: "style-evolution-3500-abc123", sourceBook: "我的文风 · 自动进化 · 第 2 轮", profile },
      { id: "style-manual-4000-own", sourceBook: "自建预设", profile },
    ].map((preset) => ({ ...preset, name: preset.sourceBook, createdAt: 1, updatedAt: 1 }))
    const original = JSON.stringify({ version: 1, enabledStyleId: presets[0].id, styles: presets })
    mem.set(path, original)

    expect((await loadWritingStyleStore(PROJECT)).styles.map((preset) => preset.id))
      .toEqual(presets.slice(2).map((preset) => preset.id))
    expect(await buildWritingStyleContext(PROJECT)).toBe("")
    expect(await buildWritingStyleContext(PROJECT, { styleIdOverride: presets[1].id })).toBe("")
    expect(mem.get(path)).toBe(original)

    for (const preset of presets.slice(2)) {
      await setEnabledWritingStyle(PROJECT, preset.id)
      expect(await buildWritingStyleContext(PROJECT)).toContain(preset.sourceBook)
    }
    expect(JSON.parse(mem.get(path)!).styles).toEqual(presets)
  })


  /*
   * ── 写入必须通知刷新（用户报的第四项）──
   *
   * 现场：在拆书库「拆出库」并启用一条新文风后，写作区那个「文风」按钮
   * 仍显示旧状态（「未启用」/ 上一条），文风库卡片的「当前启用」徽章同理。
   * 根因是读的那一侧只在 `dataVersion` 变化时重读
   * （`use-writing-style-options.ts` 依赖 `[dataVersion, projectPath, selectedSkillId]`），
   * 而写入这边只落盘、从不通知。
   *
   * 这条用例钉的是**漏斗**（`saveWritingStyleStore`）而不是某个调用点：
   * 三条写入路径（新建预设 / 启用或取消 / 删除）都必须各通知一次。
   * 判别力：把 `saveWritingStyleStore` 里那句 `bumpDataVersion()` 删掉，
   * 三个断言同时红；把通知挪到某一个调用点上，另外两个红。
   */
  it("每条写入路径都通知刷新：dataVersion 各加一次", async () => {
    const before = useWikiStore.getState().dataVersion

    const preset = await createWritingStylePreset(PROJECT, { name: "通知", sourceBook: "通知书", constitution: "短句" })
    expect(useWikiStore.getState().dataVersion, "新建预设要通知").toBe(before + 1)

    await setEnabledWritingStyle(PROJECT, preset.id)
    expect(useWikiStore.getState().dataVersion, "启用/取消要通知").toBe(before + 2)

    await removeWritingStylePreset(PROJECT, preset.id)
    expect(useWikiStore.getState().dataVersion, "删除预设也要通知").toBe(before + 3)
  })

  it("enables and clears the active style", async () => {
    const preset = await createWritingStylePreset(PROJECT, { name: "x", sourceBook: "凡人", constitution: "短句" })
    await setEnabledWritingStyle(PROJECT, preset.id)
    expect((await getEnabledWritingStyle(PROJECT))?.id).toBe(preset.id)

    await setEnabledWritingStyle(PROJECT, null)
    expect(await getEnabledWritingStyle(PROJECT)).toBeNull()
  })

  it("ignores an unknown style id when enabling", async () => {
    await createWritingStylePreset(PROJECT, { name: "x", sourceBook: "凡人", constitution: "短句" })
    await setEnabledWritingStyle(PROJECT, "does-not-exist")
    expect(await getEnabledWritingStyle(PROJECT)).toBeNull()
  })

  it("returns empty context when nothing is enabled", async () => {
    await createWritingStylePreset(PROJECT, { name: "x", sourceBook: "凡人", constitution: "短句" })
    expect(await buildWritingStyleContext(PROJECT)).toBe("")
  })

  it("injects the guard, constitution and samples by default", async () => {
    const preset = await createWritingStylePreset(PROJECT, { name: "x", sourceBook: "凡人修仙传", ...makeProfile() })
    await setEnabledWritingStyle(PROJECT, preset.id)

    const ctx = await buildWritingStyleContext(PROJECT)
    expect(ctx).toContain("《凡人修仙传》")
    expect(ctx).toContain("严禁借用")
    expect(ctx).toContain("朴素")
    expect(ctx).toContain("原文片段一")
  })

  it("omits samples when includeSamples is false", async () => {
    const preset = await createWritingStylePreset(PROJECT, { name: "x", sourceBook: "凡人", ...makeProfile() })
    await setEnabledWritingStyle(PROJECT, preset.id)

    const ctx = await buildWritingStyleContext(PROJECT, { includeSamples: false })
    expect(ctx).not.toContain("原文片段一")
    expect(ctx).toContain("朴素")
  })

  it("clips an over-long constitution to the configured limit", async () => {
    const preset = await createWritingStylePreset(PROJECT, {
      name: "x",
      sourceBook: "凡人",
      constitution: "约束".repeat(1000),
    })
    await setEnabledWritingStyle(PROJECT, preset.id)

    const ctx = await buildWritingStyleContext(PROJECT, { constitutionCharLimit: 100 })
    expect(ctx).toContain("…")
    expect(ctx.length).toBeLessThan(800)
  })
})

describe("writing-style-store · Writing DNA 注入", () => {
  function enable(profile: BookStyleProfile) {
    const preset = { id: "style-legacy", name: "旧预设", sourceBook: "凡人修仙传", profile, createdAt: 1, updatedAt: 1 }
    mem.set(`${PROJECT}/.qmai/writing-style.json`, JSON.stringify({ version: 1, enabledStyleId: preset.id, styles: [preset] }))
  }

  it("硬约束排在整合文档正文之前，保证不被挤掉", async () => {
    enable(makeDnaProfile())
    const ctx = await buildWritingStyleContext(PROJECT)

    expect(ctx.indexOf("风格硬约束")).toBeGreaterThan(-1)
    expect(ctx.indexOf("风格硬约束")).toBeLessThan(ctx.indexOf("Writing DNA 要点"))
  })

  it("整合文档注入时摘掉硬约束小节，避免同一段内容注入两遍", async () => {
    enable(makeDnaProfile())
    const ctx = await buildWritingStyleContext(PROJECT)

    expect(ctx).toContain("平均句长 12 字")
    // 「环境描写不超过 2 句」只应来自 constitution 字段，不应随正文再来一次
    expect(ctx.split("环境描写不超过 2 句").length - 1).toBeLessThanOrEqual(1)
  })

  it("v1 旧画像没有整合文档时降级为只注入硬约束", async () => {
    enable(makeProfile())
    const ctx = await buildWritingStyleContext(PROJECT)

    expect(ctx).toContain("风格硬约束")
    expect(ctx).toContain("朴素")
    expect(ctx).not.toContain("Writing DNA 要点")
  })

  it("v1 旧画像读出时迁移为 v2 形状并按层归类 9 维内容", async () => {
    enable(makeProfile())
    const preset = await getEnabledWritingStyle(PROJECT)

    expect(preset?.profile.schemaVersion).toBe(2)
    expect(preset?.profile.layers?.languageDna).toContain("密度高、推进快")
    expect(preset?.profile.layers?.rhythmGuide).toBe("")
  })

  it("整合文档正文超预算时被截断，但硬约束完整保留", async () => {
    enable(makeDnaProfile({
      constitution: "1. 环境描写不超过 2 句。",
      integratedDna: `## 语言特征\n${"细节".repeat(2000)}\n\n## 风格硬约束\n1. 环境描写不超过 2 句。`,
    }))
    const ctx = await buildWritingStyleContext(PROJECT)

    expect(ctx).toContain("环境描写不超过 2 句")
    expect(ctx).toContain("…")
    expect(ctx.length).toBeLessThan(6000)
  })
})

/**
 * 文风预设删除（设计 §7：文风库原本没有任何删除接口）。
 * 删除是「连使用库一起真删」，所以启用态必须跟着一起清，不能留下悬空启用项。
 */
describe("文风预设删除", () => {
  it("按 id 删掉对应预设，其它预设保留", async () => {
    const target = await createWritingStylePreset(PROJECT, { name: "甲书 · 文风", sourceBook: "甲书", constitution: "短句" })
    const keep = await createWritingStylePreset(PROJECT, { name: "乙书 · 文风", sourceBook: "乙书", constitution: "短句" })

    const next = await removeWritingStylePreset(PROJECT, target.id)

    expect(next.styles.map((preset) => preset.id)).toEqual([keep.id])
    expect((await loadWritingStyleStore(PROJECT)).styles.map((preset) => preset.id)).toEqual([keep.id])
  })

  it("删掉的正是当前启用项时必须清空 enabledStyleId，不留悬空的启用项", async () => {
    const target = await createWritingStylePreset(PROJECT, { name: "甲书 · 文风", sourceBook: "甲书", constitution: "短句" })
    await setEnabledWritingStyle(PROJECT, target.id)

    const next = await removeWritingStylePreset(PROJECT, target.id)

    expect(next.enabledStyleId).toBeNull()
    expect((await loadWritingStyleStore(PROJECT)).enabledStyleId).toBeNull()
    expect(await getEnabledWritingStyle(PROJECT)).toBeNull()
    expect(await buildWritingStyleContext(PROJECT)).toBe("")
  })

  it("删的不是当前启用项时启用态原样保留", async () => {
    const enabled = await createWritingStylePreset(PROJECT, { name: "乙书 · 文风", sourceBook: "乙书", constitution: "短句" })
    const target = await createWritingStylePreset(PROJECT, { name: "甲书 · 文风", sourceBook: "甲书", constitution: "短句" })
    await setEnabledWritingStyle(PROJECT, enabled.id)

    const next = await removeWritingStylePreset(PROJECT, target.id)

    expect(next.enabledStyleId).toBe(enabled.id)
    expect((await getEnabledWritingStyle(PROJECT))?.id).toBe(enabled.id)
  })

  it("删不存在的目标不抛错，store 内容不变", async () => {
    const keep = await createWritingStylePreset(PROJECT, { name: "甲书 · 文风", sourceBook: "甲书", constitution: "短句" })
    const before = await loadWritingStyleStore(PROJECT)

    const byId = await removeWritingStylePreset(PROJECT, "style-does-not-exist")
    expect(byId.styles.map((preset) => preset.id)).toEqual([keep.id])
    expect(byId.enabledStyleId).toEqual(before.enabledStyleId)

    expect(await loadWritingStyleStore(PROJECT)).toEqual(byId)
  })
})

describe("文风 skill：技能库手动新建 / 修改 / 读取", () => {
  it("手动新建：空 sourceBook 落成「手动创建」，且多条并存不去重", async () => {
    const a = await createWritingStylePreset(PROJECT, { name: "甲", constitution: "短句" })
    const b = await createWritingStylePreset(PROJECT, { name: "乙", constitution: "长句" })

    expect(a.id).not.toBe(b.id)
    expect(a.id.startsWith("style-manual-")).toBe(true)
    expect(a.sourceBook).toBe("手动创建")
    expect(a.profile.schemaVersion).toBe(2)
    expect(a.profile.constitution).toBe("短句")

    const store = await loadWritingStyleStore(PROJECT)
    expect(store.styles.map((s) => s.name)).toEqual(["甲", "乙"])
  })

  it("手工修改：浅合并 profile，保留原 profile 其它字段与形状", async () => {
    const created = await createWritingStylePreset(PROJECT, {
      name: "甲",
      constitution: "短句",
      samples: ["一"],
    })
    const updated = await updateWritingStylePreset(PROJECT, created.id, {
      name: "甲改",
      constitution: "长句",
      samples: ["二", "三"],
    })

    expect(updated?.name).toBe("甲改")
    expect(updated?.profile.constitution).toBe("长句")
    expect(updated?.profile.samples).toEqual(["二", "三"])
    expect(updated?.profile.schemaVersion).toBe(2)
    expect(updated?.profile.generatedAt).toBe(created.profile.generatedAt)
  })

  it("更新不存在的 id 返回 null，且不写盘", async () => {
    const before = await loadWritingStyleStore(PROJECT)
    const result = await updateWritingStylePreset(PROJECT, "style-manual-missing", { name: "x" })
    expect(result).toBeNull()
    expect(await loadWritingStyleStore(PROJECT)).toEqual(before)
  })

  it("getWritingStylePreset 读回未迁移的原始 profile，找不到返回 null", async () => {
    const created = await createWritingStylePreset(PROJECT, { name: "甲", constitution: "短句" })
    const read = await getWritingStylePreset(PROJECT, created.id)
    expect(read).toEqual(created)
    expect(await getWritingStylePreset(PROJECT, "style-manual-missing")).toBeNull()
  })

  it("手动新建的可启用，删除时清理启用态", async () => {
    const created = await createWritingStylePreset(PROJECT, { name: "甲", constitution: "短句" })
    await setEnabledWritingStyle(PROJECT, created.id)
    expect((await loadWritingStyleStore(PROJECT)).enabledStyleId).toBe(created.id)

    const after = await removeWritingStylePreset(PROJECT, created.id)
    expect(after.enabledStyleId).toBeNull()
    expect(await getWritingStylePreset(PROJECT, created.id)).toBeNull()
  })
})
