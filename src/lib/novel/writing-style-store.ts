/**
 * 作品文风预设的项目级启用态 + 生成注入（feature/book-style-extraction → feature/writing-dna）
 *
 * 预设存盘在 <projectPath>/.qmai/writing-style.json。
 * 启用某个文风后，buildWritingStyleContext() 把"整合 DNA + 代表片段"拼成注入文本，
 * 由 context-engine 接入 contextPack.writingStyle，
 * 经 contextPackToPrompt 流向普通对话与深度生成各阶段（含缓存前缀）。
 *
 * 样例和约束都取自已保存的文风预设。
 *
 * 红线：只注入蒸馏结果 + 少量短片段，绝不注入整本原文。
 */
import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"
import { migrateStyleProfile } from "./book-analysis/style-profile-schema"
import type { BookStyleProfile } from "./book-analysis/types"
import { stripConstitutionSection } from "./book-analysis/writing-dna-prompts"

export interface WritingStylePreset {
  id: string
  name: string
  sourceBook: string
  profile: BookStyleProfile
  createdAt: number
  updatedAt: number
}

interface WritingStyleStore {
  version: 1
  enabledStyleId: string | null
  styles: WritingStylePreset[]
}

interface BuildWritingStyleContextOptions {
  includeSamples?: boolean
  constitutionCharLimit?: number
  samplesCharLimit?: number
  /** undefined 沿用项目文风，null 停用一次，字符串指定新的预设。 */
  styleIdOverride?: string | null
}

const DEFAULT_CONSTITUTION_LIMIT = 800
const DEFAULT_SAMPLES_LIMIT = 2500
/** 写作请求中整合文档正文的字数预算。 */
const DEFAULT_DNA_BODY_LIMIT = 1800
export const STYLE_EVOLUTION_SOURCE_PREFIX = "我的文风 · 自动进化"

function storePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.qmai/writing-style.json`
}

async function readWritingStyleStore(projectPath: string): Promise<WritingStyleStore> {
  try {
    const raw = await readFile(storePath(projectPath))
    const parsed = JSON.parse(raw) as Partial<WritingStyleStore>
    return {
      version: 1,
      enabledStyleId: typeof parsed.enabledStyleId === "string" ? parsed.enabledStyleId : null,
      styles: Array.isArray(parsed.styles) ? parsed.styles : [],
    }
  } catch {
    return { version: 1, enabledStyleId: null, styles: [] }
  }
}

function isAvailableWritingStyle(preset: WritingStylePreset): boolean {
  if (typeof preset?.id !== "string") return false
  const stored = preset as WritingStylePreset & {
    sourceBookId?: string
    profile: BookStyleProfile & { workbenchStyle?: unknown }
  }
  if (stored.sourceBookId || stored.profile?.workbenchStyle) return false
  if (!/^style-\d+-[a-z0-9]+$/i.test(preset.id)) return true

  // 早期拆书和自进化共用 style-<时间>-<随机数>，手动预设有独立前缀。
  const profile = preset.profile
  return (typeof preset.sourceBook === "string" && preset.sourceBook.startsWith(STYLE_EVOLUTION_SOURCE_PREFIX))
    || (profile?.schemaVersion === 2
      && profile.sampledChapterIds?.length === 0
      && !profile.metrics
      && !profile.layers)
}

function availableWritingStyleStore(store: WritingStyleStore): WritingStyleStore {
  const styles = store.styles.filter(isAvailableWritingStyle)
  return {
    ...store,
    styles,
    enabledStyleId: styles.some((preset) => preset.id === store.enabledStyleId) ? store.enabledStyleId : null,
  }
}

export async function loadWritingStyleStore(projectPath: string): Promise<WritingStyleStore> {
  return availableWritingStyleStore(await readWritingStyleStore(projectPath))
}

/** 写盘成功后通知技能库和写作区重新加载。 */
async function saveWritingStyleStore(projectPath: string, store: WritingStyleStore): Promise<void> {
  await createDirectory(`${normalizePath(projectPath)}/.qmai`)
  await writeFileAtomic(storePath(projectPath), JSON.stringify(store, null, 2))
  useWikiStore.getState().bumpDataVersion()
}

/**
 * 写入/更新一个文风预设（按 sourceBook 去重：同一本书只保留一份，重复提取则覆盖）。
 * 不改变当前启用项。返回该预设 id。
 */
export async function upsertWritingStylePreset(
  projectPath: string,
  input: {
    name: string
    sourceBook: string
    profile: BookStyleProfile
  },
): Promise<WritingStylePreset> {
  const store = await readWritingStyleStore(projectPath)
  const now = Date.now()
  const existingIndex = store.styles.findIndex((s) => isAvailableWritingStyle(s) && s.sourceBook === input.sourceBook)
  let preset: WritingStylePreset
  if (existingIndex >= 0) {
    preset = {
      ...store.styles[existingIndex],
      name: input.name,
      profile: input.profile,
      updatedAt: now,
    }
    store.styles[existingIndex] = preset
  } else {
    preset = {
      id: `style-evolution-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name: input.name,
      sourceBook: input.sourceBook,
      profile: input.profile,
      createdAt: now,
      updatedAt: now,
    }
    store.styles.push(preset)
  }
  await saveWritingStyleStore(projectPath, store)
  return preset
}

/** 用独立 ID 新建手工预设，允许同一来源保存多个预设。 */
export async function createWritingStylePreset(
  projectPath: string,
  input: {
    name: string
    sourceBook?: string
    constitution: string
    samples?: string[]
    integratedDna?: string
  },
): Promise<WritingStylePreset> {
  const store = await readWritingStyleStore(projectPath)
  const now = Date.now()
  const preset: WritingStylePreset = {
    id: `style-manual-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name: input.name.trim() || "未命名文风",
    sourceBook: input.sourceBook?.trim() || "手动创建",
    profile: {
      schemaVersion: 2,
      generatedAt: now,
      sampledChapterIds: [],
      constitution: input.constitution ?? "",
      samples: input.samples ?? [],
      integratedDna: input.integratedDna?.trim() ? input.integratedDna : undefined,
    },
    createdAt: now,
    updatedAt: now,
  }
  await saveWritingStyleStore(projectPath, { ...store, styles: [...store.styles, preset] })
  return preset
}

/** 更新可编辑字段，保留其余画像数据。 */
export async function updateWritingStylePreset(
  projectPath: string,
  styleId: string,
  patch: {
    name?: string
    sourceBook?: string
    constitution?: string
    samples?: string[]
    integratedDna?: string
  },
): Promise<WritingStylePreset | null> {
  const store = await readWritingStyleStore(projectPath)
  const index = store.styles.findIndex((s) => isAvailableWritingStyle(s) && s.id === styleId)
  if (index < 0) return null
  const current = store.styles[index]
  const profile: BookStyleProfile = {
    ...current.profile,
    ...(patch.constitution !== undefined ? { constitution: patch.constitution } : {}),
    ...(patch.samples !== undefined ? { samples: patch.samples } : {}),
    ...(patch.integratedDna !== undefined ? { integratedDna: patch.integratedDna } : {}),
  }
  const preset: WritingStylePreset = {
    ...current,
    name: patch.name !== undefined ? patch.name.trim() || current.name : current.name,
    sourceBook:
      patch.sourceBook !== undefined ? patch.sourceBook.trim() || "手动创建" : current.sourceBook,
    profile,
    updatedAt: Date.now(),
  }
  const styles = [...store.styles]
  styles[index] = preset
  await saveWritingStyleStore(projectPath, { ...store, styles })
  return preset
}

/**
 * 读取单个文风预设（供技能库编辑器读-改-写）。
 * 返回**未迁移**的原始 `profile`：编辑器读进来什么、就原样写回去，不擅自改写用户数据。
 */
export async function getWritingStylePreset(
  projectPath: string,
  styleId: string,
): Promise<WritingStylePreset | null> {
  const store = await loadWritingStyleStore(projectPath)
  return store.styles.find((s) => s.id === styleId) ?? null
}

export async function setEnabledWritingStyle(projectPath: string, styleId: string | null): Promise<WritingStyleStore> {
  const store = await readWritingStyleStore(projectPath)
  const next: WritingStyleStore = {
    ...store,
    enabledStyleId: styleId && store.styles.some((s) => isAvailableWritingStyle(s) && s.id === styleId) ? styleId : null,
  }
  await saveWritingStyleStore(projectPath, next)
  return availableWritingStyleStore(next)
}

/** 删除可用预设，并在删除当前启用项时清除启用状态。 */
async function removeWritingStylePresets(
  projectPath: string,
  match: (preset: WritingStylePreset) => boolean,
): Promise<WritingStyleStore> {
  const store = await readWritingStyleStore(projectPath)
  const styles = store.styles.filter((preset) => !isAvailableWritingStyle(preset) || !match(preset))
  const enabledRemoved = store.enabledStyleId !== null
    && !styles.some((preset) => preset?.id === store.enabledStyleId)
  const next: WritingStyleStore = {
    ...store,
    styles,
    enabledStyleId: enabledRemoved ? null : store.enabledStyleId,
  }
  await saveWritingStyleStore(projectPath, next)
  return availableWritingStyleStore(next)
}

/** 按 id 删除一个文风预设。 */
export async function removeWritingStylePreset(projectPath: string, styleId: string): Promise<WritingStyleStore> {
  return removeWritingStylePresets(projectPath, (preset) => preset.id === styleId)
}

/** 按来源名称清理上一轮自进化预设。 */
export async function removeWritingStylePresetBySourceBook(projectPath: string, sourceBook: string): Promise<WritingStyleStore> {
  return removeWritingStylePresets(projectPath, (preset) => preset.sourceBook === sourceBook)
}

export async function getEnabledWritingStyle(projectPath: string): Promise<WritingStylePreset | null> {
  const store = await loadWritingStyleStore(projectPath)
  if (!store.enabledStyleId) return null
  const preset = store.styles.find((s) => s.id === store.enabledStyleId)
  if (!preset) return null
  // 盘上可能是 v1 数据，统一迁移成 v2 形状再交给调用方
  return { ...preset, profile: migrateStyleProfile(preset.profile) }
}

/** 解析本轮启用的预设，并归一化旧版文风字段。 */
export async function resolveWritingStylePreset(
  projectPath: string,
  styleIdOverride?: string | null,
): Promise<WritingStylePreset | null> {
  if (styleIdOverride === null) return null
  if (styleIdOverride === undefined) return getEnabledWritingStyle(projectPath)
  const store = await loadWritingStyleStore(projectPath)
  const preset = store.styles.find((s) => s.id === styleIdOverride)
  if (!preset) return null
  return { ...preset, profile: migrateStyleProfile(preset.profile) }
}

function clip(value: string, limit: number): string {
  const trimmed = value.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit)}…`
}

/** 把当前文风的硬约束、Writing DNA 和样例加入写作上下文。 */
export async function buildWritingStyleContext(
  projectPath: string,
  options: BuildWritingStyleContextOptions = {},
): Promise<string> {
  const preset = await resolveWritingStylePreset(projectPath, options.styleIdOverride)
  if (!preset) return ""
  return renderWritingStylePreset(preset, options)
}

/**
 * 由**已经取好的** preset 拼注入文本。`buildWritingStyleContext` 的唯一渲染入口
 * —— 覆盖路径与启用路径共用它，避免出现第二套文案/第二种形状。
 */
function renderWritingStylePreset(
  preset: WritingStylePreset,
  options: BuildWritingStyleContextOptions,
): string {
  const {
    includeSamples = true,
    constitutionCharLimit = DEFAULT_CONSTITUTION_LIMIT,
    samplesCharLimit = DEFAULT_SAMPLES_LIMIT,
  } = options

  const lines: string[] = [
    `目标文风来源：《${preset.sourceBook}》。`,
    "只模仿这种叙事密度、描写克制度、句式与节奏。严禁借用下方参考片段中的人物、地名、设定、情节——它们只是文风样例，不是剧情素材。",
    "",
  ]

  lines.push("风格硬约束：", clip(preset.profile.constitution, constitutionCharLimit))

  const integratedDna = preset.profile.integratedDna?.trim()
  if (integratedDna) {
    const body = stripConstitutionSection(integratedDna)
    if (body) {
      lines.push("", "Writing DNA 要点（写作时逐条对照）：", clip(body, DEFAULT_DNA_BODY_LIMIT))
    }
  }

  const samples = preset.profile.samples

  if (includeSamples && samples.length > 0) {
    const sampleLines: string[] = []
    let used = 0
    for (const sample of samples) {
      const text = sample.trim()
      if (!text) continue
      if (used + text.length > samplesCharLimit) break
      used += text.length
      sampleLines.push(`- ${text}`)
    }
    if (sampleLines.length > 0) {
      lines.push("", "文风参考片段（只学写法，不要照抄内容）：", ...sampleLines)
    }
  }

  return lines.join("\n")
}
