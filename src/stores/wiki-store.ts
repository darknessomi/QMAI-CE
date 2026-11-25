import { confirmAction } from "@/lib/confirm-action"
import type { UiTestSkin } from "@/lib/ui-test"
import { create } from "zustand"
import type { WikiProject, FileNode } from "@/types/wiki"
import {
  buildProjectPathIndexFromTree,
  createEmptyProjectPathIndex,
  type ProjectPathIndex,
} from "@/lib/wiki-page-resolver"
import { DEFAULT_SOURCE_WATCH_CONFIG } from "@/lib/source-watch-config"
import type { LintResult } from "@/lib/lint"
import type { NovelReviewResult } from "@/lib/novel/review-adapter"
import type { DimensionReviewResult, SixReviewDimensionKey } from "@/lib/novel/dimension-review-adapter"
import type { TrashItem } from "@/lib/trash"
import {
  DEFAULT_SIDEBAR_NAV_CONFIG,
  normalizeSidebarNavConfig,
  type SidebarNavConfig,
} from "@/lib/sidebar-nav-preferences"
import {
  DEFAULT_BODY_FONT_PX,
  DEFAULT_BODY_LINE_HEIGHT,
  DEFAULT_BODY_LETTER_SPACING,
  DEFAULT_BODY_MARGIN_X,
  DEFAULT_BODY_SAFE_BOTTOM,
  clampBodyFontPx,
  clampBodyLineHeight,
  clampBodyLetterSpacing,
  clampBodyMarginX,
  clampBodySafeBottom,
  resolveMigratedBodyFontPx,
  clampUiFontSizeScale,
} from "@/lib/font-settings"
import {
  DEFAULT_REASONING_DEPTH,
  normalizeReasoningDepth,
  type ReasoningDepth,
} from "@/lib/reasoning-depth"
import {
  DEFAULT_VISUAL_STYLE,
  VISUAL_STYLE_STORAGE_KEY,
  VISUAL_STYLE_STORAGE_VERSION,
  VISUAL_STYLE_STORAGE_VERSION_KEY,
  normalizeVisualStyle,
  resolveStoredVisualStyle,
  type VisualStyle,
} from "@/lib/visual-style-settings"
import {
  DEFAULT_AI_WORKFLOW_MODE,
  DEFAULT_OUTLINE_WORKFLOW_MODE,
  type AiWorkflowMode,
  type OutlineWorkflowMode,
} from "@/lib/agent/workflow-mode"
import {
  normalizeProviderConfigs,
  normalizeUserLlmConfig,
} from "@/lib/llm-context-size"
import type { CodexSpeedMode } from "@/lib/codex-cli-speed"
// provider id 的联合定义放在 lib 分派模块里（内置字面量 + 任意插件 id），
// 这里只做类型引用；`import type` 编译期擦除，不会把 llm-providers 拉进 store 的运行时依赖。
import type { LlmProviderId } from "@/lib/llm-providers"

const UI_FONT_SIZE_SCALE_KEY = "qmai-ui-font-size-scale"
/** 正文字号独立键：与界面字号分开存。 */
const BODY_FONT_SIZE_SCALE_KEY = "qmai-ui-body-font-scale"
/*
 * 旧键保留**只读**：新用户不会再写它，但读回时要用它做一次性迁移。
 * 不删除的理由：用户回滚到旧版本时，旧设置仍然在。
 */
const BODY_FONT_PX_KEY = "qmai-body-font-px"
const BODY_LINE_HEIGHT_KEY = "qmai-body-line-height"
const BODY_LETTER_SPACING_KEY = "qmai-body-letter-spacing"
const BODY_MARGIN_X_KEY = "qmai-body-margin-x"
const BODY_SAFE_BOTTOM_KEY = "qmai-body-safe-bottom"
const SIDEBAR_NAV_CONFIG_KEY = "qmai-sidebar-nav-config"

export type SettingsCategoryId =
  | "model"
  | "network"
  | "interface"
  | "novel"
  | "usage-guide"
  | "data-management"
  | "feedback"
  | "changelog"

export type ModelSettingsTabId = "default" | "llm" | "jev"

export interface JevConfig {
  endpoint: string
  model: string
  apiKey?: string
}

const readStoredUiFontSizeScale = (): number => {
  if (typeof localStorage === "undefined") return 1
  const saved = Number(localStorage.getItem(UI_FONT_SIZE_SCALE_KEY) ?? "1")
  return Number.isFinite(saved) ? clampUiFontSizeScale(saved) : 1
}

/**
 * 读回正文字号（px）。
 *
 * 新键优先；读不到时交给 resolveMigratedBodyFontPx 决定，它会
 * **把界面字号乘进去**（0.85→15 / 1→18 / 1.25→23 / 1.5→27），
 * 并在「没存过 + 界面字号非默认」时按界面字号补种一次。
 * 旧键不写、不删，见上面常量处的说明。
 *
 * ⚠ 顺序是有意义的：readStoredUiFontSizeScale 定义在本函数**上方**。
 * 本函数在模块求值期就会被调用（state 初始化处），若它引用了
 * 定义在下面的 const 箭头函数，会直接抛暂时性死区错误、整个 store
 * 起不来。挪动这两个函数的相对位置前先看这条警告。
 */
const readStoredBodyFontPx = (): number => {
  if (typeof localStorage === "undefined") return DEFAULT_BODY_FONT_PX
  const raw = localStorage.getItem(BODY_FONT_PX_KEY)
  if (raw !== null) return clampBodyFontPx(raw)
  const legacy = localStorage.getItem(BODY_FONT_SIZE_SCALE_KEY)
  const migrated = resolveMigratedBodyFontPx(legacy, readStoredUiFontSizeScale())
  // null = 没有可迁移/可补种的值，保持默认
  return migrated ?? DEFAULT_BODY_FONT_PX
}

/**
 * 读取一个「数字 or null」的排版参数。
 * null 是合法取值（仅左右边距用它表示「跟随窗口」），见 clampBodyMarginX。
 */
const readStoredBodyLineHeight = (): number => {
  if (typeof localStorage === "undefined") return DEFAULT_BODY_LINE_HEIGHT
  return clampBodyLineHeight(localStorage.getItem(BODY_LINE_HEIGHT_KEY))
}

const readStoredBodyLetterSpacing = (): number => {
  if (typeof localStorage === "undefined") return DEFAULT_BODY_LETTER_SPACING
  return clampBodyLetterSpacing(localStorage.getItem(BODY_LETTER_SPACING_KEY))
}

const readStoredBodyMarginX = (): number | null => {
  if (typeof localStorage === "undefined") return DEFAULT_BODY_MARGIN_X
  return clampBodyMarginX(localStorage.getItem(BODY_MARGIN_X_KEY))
}

const readStoredBodySafeBottom = (): number => {
  if (typeof localStorage === "undefined") return DEFAULT_BODY_SAFE_BOTTOM
  return clampBodySafeBottom(localStorage.getItem(BODY_SAFE_BOTTOM_KEY))
}

const readStoredVisualStyle = (): VisualStyle => {
  if (typeof localStorage === "undefined") return DEFAULT_VISUAL_STYLE
  const saved = localStorage.getItem(VISUAL_STYLE_STORAGE_KEY)
  const version = localStorage.getItem(VISUAL_STYLE_STORAGE_VERSION_KEY)
  const resolved = resolveStoredVisualStyle(saved, version)
  if (saved !== resolved || version !== VISUAL_STYLE_STORAGE_VERSION) {
    localStorage.setItem(VISUAL_STYLE_STORAGE_KEY, resolved)
    localStorage.setItem(VISUAL_STYLE_STORAGE_VERSION_KEY, VISUAL_STYLE_STORAGE_VERSION)
  }
  return resolved
}

const readStoredSidebarNavConfig = (): SidebarNavConfig => {
  if (typeof localStorage === "undefined") return DEFAULT_SIDEBAR_NAV_CONFIG
  try {
    const saved = localStorage.getItem(SIDEBAR_NAV_CONFIG_KEY)
    return normalizeSidebarNavConfig(saved ? JSON.parse(saved) : null)
  } catch {
    return DEFAULT_SIDEBAR_NAV_CONFIG
  }
}

/**
 * Wire protocol used when `provider === "custom"`. Other providers have a
 * fixed protocol (openai → OpenAI chat; anthropic → Anthropic messages;
 * etc.), so this field is ignored for them. `undefined` defaults to
 * `chat_completions` for backward compatibility with pre-0.3.7 configs.
 */
export type CustomApiMode = "chat_completions" | "responses" | "anthropic_messages"
export type AzureModelFamily = "auto" | "gpt5"
export type ReasoningMode = "auto" | "off" | "low" | "medium" | "high" | "xhigh" | "max" | "custom"

export interface ReasoningConfig {
  mode: ReasoningMode
  budgetTokens?: number
}

interface LlmConfig {
  /** 内置 provider 或运行期插件注入的 provider（形如 `wb-connect`）。 */
  provider: LlmProviderId
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
  azureApiVersion?: string
  azureModelFamily?: AzureModelFamily
  /** The model's context window, in TOKENS, as published on its spec sheet. */
  maxContextSize: number
  /** The model's maximum output, in TOKENS. A capability ceiling, not a
   *  per-request size: what actually gets sent is min(workflow need, this). */
  maxOutputTokens?: number
  apiMode?: CustomApiMode
  reasoning?: ReasoningConfig
  localCliIsolation?: boolean
  codexCliTimeoutMinutes?: number
  codexSpeedMode?: CodexSpeedMode
  /** Cursor ACP `fast=` parameter. Independent of Codex Fast. */
  cursorSpeedMode?: CodexSpeedMode
  /** When false, Agent requests omit tools/tool_choice. Default/undefined = enabled. */
  functionCallingEnabled?: boolean
}

export type SearchProvider = "bocha" | "qiniu" | "metaso" | "tavily" | "serpapi" | "searxng" | "gemini" | "baizhi" | "antigravity" | "none"
export type SerpApiEngine =
  | "google"
  | "google_news"
  | "google_scholar"
  | "google_patents"
  | "bing"
  | "duckduckgo"
  | "google_images"
  | "google_videos"
  | "youtube"
  | string
export type SearXngCategory =
  | "general"
  | "news"
  | "science"
  | "it"
  | "images"
  | "videos"
  | "files"
  | "map"
  | "music"
  | "social media"
  | string

export interface SearchProviderOverride {
  apiKey?: string
  serpApiEngine?: SerpApiEngine
  searXngUrl?: string
  searXngCategories?: SearXngCategory[]
  /** Gemini 搜索（Grounding with Google Search）用的模型，默认 gemini-4-hydrogen。 */
  geminiModel?: string
  /** 反重力 CLI 搜索用的 agy 模型；留空用 agy 默认模型。 */
  antigravityModel?: string
  /** 反重力 CLI 单次搜索超时（秒），30–900；缺省 180。 */
  antigravityTimeoutSecs?: number
  /** Gemini API 自定义地址（代理/中转），默认 https://generativelanguage.googleapis.com。 */
  geminiBaseUrl?: string
}

export type SearchProviderConfigs = Partial<Record<Exclude<SearchProvider, "none">, SearchProviderOverride>>

interface SearchApiConfig {
  provider: SearchProvider
  apiKey: string
  serpApiEngine?: SerpApiEngine
  searXngUrl?: string
  searXngCategories?: SearXngCategory[]
  providerConfigs?: SearchProviderConfigs
}

/**
 * Image-captioning settings (Phase 4 of the multimodal-images plan).
 *
 * Decoupled from `llmConfig` because vision-capable endpoints are
 * usually NOT the same model the user picks for analysis/generation:
 * - the analysis stage often goes to a strong text-only model (Claude
 *   Sonnet, DeepSeek, etc.) that doesn't speak vision at all;
 * - captioning is happy with a small local VL model (Qwen2.5-VL-7B,
 *   LLaVA-1.6) that costs near-zero per call.
 *
 * `enabled` is the master gate. When false the caption pipeline is
 * skipped entirely — `read_file`'s extracted images still appear
 * inline (with empty alt text) and the safety-net `## Embedded
 * Images` section still gets written, but we never touch the LLM.
 *
 * `useMainLlm`: when true (the default for first-time users we
 * onboard), captioning calls go through the same `llmConfig`
 * everything else uses. When false, the dedicated fields below are
 * sent through the same provider machinery — same `streamChat`,
 * same `getProviderConfig`, no duplicate code.
 *
 * `concurrency` bounds parallel caption requests during ingest.
 * 30-image PDFs with sequential captioning at ~10s/image (a Qwen3
 * thinking model on consumer GPU) take 5 minutes. At concurrency=4
 * that drops to ~75s. Going wider than 8 typically just queues
 * behind a single-GPU server's batch slot, so we cap the slider
 * UI at a tasteful max in the settings view.
 */
/**
 * Global outbound HTTP proxy. When `enabled` and `url` is a valid
 * http(s) URL, the Rust setup hook reads this on app launch and
 * sets HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars before the
 * reqwest client used by tauri-plugin-http is constructed. Changes
 * apply on app restart only.
 */
interface ProxyConfig {
  enabled: boolean
  url: string
  bypassLocal: boolean
}

interface ScheduledImportConfig {
  enabled: boolean
  path: string // 监控目录的相对路径（相对于项目根目录），空字符串表示使用默认的 "raw"
  interval: number // 扫描间隔（分钟）
  lastScan: number | null // 上次扫描时间戳
}

interface SourceWatchConfig {
  enabled: boolean
  autoIngest: boolean
  includeExtensions: string[]
  excludeExtensions: string[]
  excludeDirs: string[]
  excludeGlobs: string[]
  maxFileSizeMb: number
}

export interface NovelConfig {
  recentSummaryWindow: number
  searchTopK: number
  /** 单章目标字数（按去除空白后的字符数计），章节生成提示词和扩写阈值都按它推算。 */
  chapterTargetChars: number
  /** 前情分析：读取并 LLM 分析前几章完整正文。快速模式始终跳过；标准/严格模式跟随此开关。关闭时记忆库的近期摘要与上一章结尾仍会注入（默认关）。 */
  deepPreviousChaptersAnalysis: boolean
  /** 章节写作联网补搜：本地缺实体时自动联网。快速模式始终跳过；标准/严格模式跟随此开关。需先配置网页搜索源（默认开）。 */
  writingWebSearchEnabled: boolean
  /** 审稿（含六维审查）使用的 reasoning 档位。下调可省审稿推理 Token，但连贯性把关会变弱（默认 high）。 */
  reviewReasoningEffort: "low" | "medium" | "high"
  /** 默认模型（工作流）：审稿、记忆提取、资料去重等。空字符串表示跟随 AI 会话模型。 */
  defaultLlmModel: string
  reviewModel: string
  extractModel: string
  /** 去 AI 味：章节预览去 AI 味、深度生成阶段6。空字符串表示跟随默认模型。 */
  deAiModel: string
  /** 批量去 AI 味同时运行的章节数，范围 1–5。 */
  deAiBatchConcurrency: number
  /** 草稿章节是否提示先保存为正式再提取记忆。关闭后不再弹出（默认开）。 */
  draftMemoryHintEnabled: boolean
  /** 这本书的文件夹里是否已经提示过一次。重新打开开关不会清掉。 */
  draftMemoryHintSeen: boolean
  /**
   * 新章节灵感提示（丙-4a）：章节正文为空时，点章节工具栏的「生成章节细纲」
   * 会在按钮旁挂出一枚说明气泡（默认开）。
   *
   * ⚠️ 与 `draftMemoryHintEnabled` **是两套独立字段**，刻意不复用：
   * 复用会让「关掉灵感提示」连带关掉草稿提示（反之亦然）。
   * 两者在界面上互斥（见 `inspiration-hint.ts` 与 `draft-memory-hint.ts:23`），
   * 但持久化语义必须各自独立。
   */
  inspirationHintEnabled: boolean
  /**
   * 这本书的文件夹里已经挂过一次新章节灵感气泡（丙-4a）。
   *
   * 与 `draftMemoryHintSeen` 同样是「每本书一次」的**显示即记**标记，
   * 不复用后者：两个提示各自记自己的账，关掉其中一个不该影响另一个。
   */
  inspirationHintSeen: boolean
}

export const DEFAULT_NOVEL_CONFIG: NovelConfig = {
  recentSummaryWindow: 8,
  searchTopK: 5,
  chapterTargetChars: 3000,
  deepPreviousChaptersAnalysis: false,
  writingWebSearchEnabled: true,
  reviewReasoningEffort: "high",
  defaultLlmModel: "",
  reviewModel: "",
  extractModel: "",
  deAiModel: "",
  deAiBatchConcurrency: 3,
  draftMemoryHintEnabled: true,
  draftMemoryHintSeen: false,
  inspirationHintEnabled: true,
  inspirationHintSeen: false,
}

export interface RevisionFeedbackWindowConfig {
  currentChapterIncludeShouldImprove: boolean
  previousChapterCarryEnabled: boolean
  lookbackChapterCount: number
  lookbackIncludeMustFixOnly: boolean
}

interface MultimodalConfig {
  enabled: boolean
  /** Reuse `llmConfig` for caption calls. When true, the fields
   *  below are ignored. */
  useMainLlm: boolean
  provider: LlmConfig["provider"]
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
  azureApiVersion?: string
  azureModelFamily?: AzureModelFamily
  apiMode?: CustomApiMode
  /** Max parallel caption requests during ingest. >=1. */
  concurrency: number
}

/**
 * Output language for LLM-generated content (wiki pages, chat responses, research).
 * "auto" = detect from user input / source document language.
 * Otherwise = force all LLM output to use the specified language.
 */
type OutputLanguage =
  | "auto"
  | "English"
  | "Chinese"
  | "Traditional Chinese"
  | "Japanese"
  | "Korean"
  | "Vietnamese"
  | "French"
  | "German"
  | "Spanish"
  | "Portuguese"
  | "Italian"
  | "Russian"
  | "Arabic"
  | "Persian"
  | "Hindi"
  | "Turkish"
  | "Dutch"
  | "Polish"
  | "Swedish"
  | "Indonesian"
  | "Thai"
  | "Ukrainian"

/**
 * 已保存的模型配置项
 */
export interface SavedModel {
  /** 唯一ID */
  id: string
  /** 显示名称 */
  name: string
  /** 模型ID */
  model: string
  /** API密钥（可选，可以复用供应商的密钥） */
  apiKey?: string
  /** 自定义接口地址（可选，可以复用供应商的地址） */
  customEndpoint?: string
  /** 备注说明 */
  description?: string
  /** 创建时间 */
  createdAt: number
}

/**
 * Per-preset saved fields. Each entry survives turning the preset off
 * and coming back — users don't have to re-enter an API key when they
 * briefly switch to a different provider.
 */
export interface ProviderOverride {
  label?: string             // 自定义配置的显示名称
  apiKey?: string
  model?: string
  baseUrl?: string           // customEndpoint for custom presets, ollamaUrl for ollama
  azureApiVersion?: string
  azureModelFamily?: AzureModelFamily
  apiMode?: CustomApiMode
  maxContextSize?: number
  maxOutputTokens?: number
  reasoning?: ReasoningConfig
  localCliIsolation?: boolean
  codexCliTimeoutMinutes?: number
  codexSpeedMode?: CodexSpeedMode
  cursorSpeedMode?: CodexSpeedMode
  /** 是否在 AI 会话中显示该 provider 下的模型（仅用于自定义供应商）。默认 true。 */
  enabled?: boolean
  /** 已保存的模型列表（仅用于自定义供应商） */
  savedModels?: SavedModel[]
  /** When false, Agent requests for this provider omit tools/tool_choice. Default/undefined = enabled. */
  functionCallingEnabled?: boolean
}

export type ProviderConfigs = Record<string, ProviderOverride>

interface BaseTaskState {
  projectPath: string
  filePath?: string
}

interface AsyncTaskState extends BaseTaskState {
  runId: string
  running: boolean
  error?: string
}

export type FinalChapterSavePhase =
  | "saving"
  | "saved"
  | "reingesting"
  | "ingested"
  | "ingest_failed"
  | "ingest_no_llm"
  | "ingest_no_chapter_number"

interface FinalChapterSaveState extends BaseTaskState {
  filePath: string
  saving: boolean
  phase: FinalChapterSavePhase | null
  params?: Record<string, string | number>
}

interface LintRunState extends AsyncTaskState {
  hasRun: boolean
  results: LintResult[]
}

interface ReviewRunState extends AsyncTaskState {
  results: NovelReviewResult[]
  thinking?: string
  dimensionResults?: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>
  dimensionThinking?: Partial<Record<SixReviewDimensionKey, string>>
  activeDimension?: SixReviewDimensionKey
  dimensionProgress?: string
}

export interface PendingEditorHighlight {
  path: string
  text: string
  nonce: number
}

type LintRunFinishState = Omit<Partial<LintRunState>, "runId" | "projectPath" | "filePath">
type ReviewRunFinishState = Omit<Partial<ReviewRunState>, "runId" | "projectPath" | "filePath">

const SKILL_LIBRARY_UNSAVED_CONFIRM = "当前 Skill 还有未保存修改，确定放弃修改吗？"

export function confirmDiscardSkillLibraryDraft(): Promise<boolean> {
  return confirmAction(SKILL_LIBRARY_UNSAVED_CONFIRM)
}

/**
 * 大纲页中间栏要显示哪一块「人物」内容。
 * 人物从技能库搬回大纲后，新建与查看都发生在中栏，不再跳整页。
 */
export type PersonaOutlinePaneFocus =
  | { mode: "create" }
  | { mode: "persona"; id: string }
  | { mode: "candidate"; name: string }


interface WikiState {
  project: WikiProject | null
  fileTree: FileNode[]
  /**
   * Lightweight lookup index derived from `fileTree`. Production code must
   * update fileTree through `setFileTree` so this stays in sync; direct
   * `useWikiStore.setState({ fileTree })` is only for tests that also reset or
   * do not read path resolution.
   */
  projectPathIndex: ProjectPathIndex
  selectedFile: string | null
  selectedTrashItem: TrashItem | null
  fileContent: string
  pendingEditorHighlight: PendingEditorHighlight | null
  /**
   * One-shot scroll target for the markdown preview. When the user
   * clicks an image in search results and chooses "jump to source",
   * we set this to the image URL alongside `selectedFile`. The
   * markdown preview consumes it on its next render — finds the
   * `<img data-mdsrc="..."/>` whose attribute matches and scrolls
   * it into view, then clears this back to null so a stale target
   * doesn't fire on the NEXT page open.
   *
   * Match by raw URL (the literal `src` from the markdown) rather
   * than the resolved `convertFileSrc` URL — same image referenced
   * across two pages with different URL conventions (one absolute,
   * one wiki-relative) still works.
   */
  pendingScrollImageSrc: string | null
  chatExpanded: boolean
  searchPanelOpen: boolean
  /*
   * 合并说明：两侧各自追加了不同的技能库内部视图，取并集。
   *   main（人物 Skill）→ personaSkillLibrary
   *   scratch-20261010（文风 skill 化）→ writingStyleLibrary
   */
  activeView: "wiki" | "sources" | "search" | "lint" | "soul" | "skillLibrary" | "writingSkillLibrary" | "writingStyleLibrary" | "personaSkillLibrary" | "skillFavorites" | "bookAnalysis" | "settings" | "trash" | "reviewCenter" | "storySimulation" | "maintenance" | "plugins"
  activeSettingsCategory: SettingsCategoryId | null
  activeModelSettingsTab: ModelSettingsTabId | null
  selectedSkillLibrarySkillId: string | null
  skillLibraryDraftDirty: boolean
  selectedWritingSkillLibrarySkillId: string | null
  writingSkillLibraryDraftDirty: boolean
  /** 技能库「文风 skill」当前选中的文风 id；null = 未选中。 */
  selectedWritingStyleLibraryStyleId: string | null
  personaSkillLibraryDraftDirty: boolean
  /**
   * 大纲页中间栏当前是否在显示「人物」面板（null = 显示普通文档）。
   * 人物从技能库搬回大纲后，新建 / 查看档案都发生在中栏，不再跳整页。
   */
  personaOutlinePane: PersonaOutlinePaneFocus | null
  /**
   * 人物数据的版本号：任何会改变「索引 / 候选池」的操作（标记重要、建档、删除、
   * 开关自动更新）都要 +1。
   * 左栏与档案页是两份独立的数据副本 —— 没有这个版本号，在档案里取消绿勾后
   * 左栏的对号不会消失（用户实测）。
   */
  personaDataVersion: number
  selectedReviewDimension: string | null
  selectedReviewFilePath: string
  llmConfig: LlmConfig
  aiChatModel: string
  /** Dedicated global AI outline model key; isolated from AI chat. */
  aiOutlineModel: string
  aiOutlineModelRevision: number
  /**
   * Thinking depth for the chat model picked in the writing footer. Applies
   * only to chapter body generation (`chapterWritingLlmConfig`), never to the
   * orchestrating agent, which runs on the default model.
   */
  aiChatReasoningDepth: ReasoningDepth
  /** Thinking depth for the outline chat model; applies to generation turns only. */
  aiOutlineReasoningDepth: ReasoningDepth
  /** 默认模型（工作流）：导入队列、资料去重等。章节/大纲记忆摄取见 novelConfig.extractModel */
  defaultLlmModel: string
  /** Per-provider-preset stored overrides (API key, model, endpoint, …). */
  providerConfigs: ProviderConfigs
  /** Which preset is currently active. `null` = no LLM configured. */
  activePresetId: string | null
  searchApiConfig: SearchApiConfig
  jevConfig: JevConfig | null
  jevConfigLoadError: string | null
  multimodalConfig: MultimodalConfig
  outputLanguage: OutputLanguage
  proxyConfig: ProxyConfig
  scheduledImportConfig: ScheduledImportConfig
  sourceWatchConfig: SourceWatchConfig
  novelMode: boolean
  chatEditModeEnabled: boolean
  aiWorkflowMode: AiWorkflowMode
  /** 切入「共创」前所处的模式；共创选定方向后按它生成正文（默认 standard）。 */
  aiWorkflowModeBeforeDiscuss: AiWorkflowMode
  outlineWorkflowMode: OutlineWorkflowMode
  novelConfig: NovelConfig
  /**
   * 人物 Skill 本轮没建出档案的原因（UI 层监听并弹窗提示）。
   * 学习是后台 `void` 调用，失败以前只写 console，用户在界面上完全看不到 ——
   * 表现就是「提取完了技能库还是空的」，必须有个能看见的出口。
   */
  personaSkillLearningError: string | null
  searchHistory: string[]
  searchTrigger: { query: string; ts: number } | null
  revisionFeedbackWindowConfig: RevisionFeedbackWindowConfig
  finalChapterSave: FinalChapterSaveState | null
  lintRun: LintRunState | null
  reviewRun: ReviewRunState | null
  theme: UiTestSkin
  uiFontSizeScale: number
  /** 正文字号（px 绝对值）。替代原 uiBodyFontSizeScale（倍数）。 */
  uiBodyFontPx: number
  /** 正文行间距（无单位倍数）。 */
  uiBodyLineHeight: number
  /** 正文字间距（px，可为负）。 */
  uiBodyLetterSpacing: number
  /** 正文左右边距（px）；null = 跟随窗口。 */
  uiBodyMarginX: number | null
  /** 正文底部安全距离（px）。 */
  uiBodySafeBottom: number
  visualStyle: VisualStyle
  sidebarNavConfig: SidebarNavConfig
  dataVersion: number

  setProject: (project: WikiProject | null) => void
  setFileTree: (tree: FileNode[], options?: { syncPathIndex?: boolean }) => void
  setProjectPathIndexFromTree: (tree: FileNode[]) => void
  setSelectedFile: (path: string | null) => Promise<boolean>
  setSelectedTrashItem: (item: TrashItem | null) => void
  setFileContent: (content: string) => void
  setPendingEditorHighlight: (highlight: PendingEditorHighlight | null) => void
  setPendingScrollImageSrc: (src: string | null) => void

  setChatExpanded: (expanded: boolean) => void
  setSearchPanelOpen: (open: boolean) => void
  setActiveView: (view: WikiState["activeView"]) => Promise<boolean>
  setActiveSettingsCategory: (category: SettingsCategoryId | null) => void
  setActiveModelSettingsTab: (tab: ModelSettingsTabId | null) => void
  setSelectedSkillLibrarySkillId: (id: string | null) => Promise<boolean>
  setSkillLibraryDraftDirty: (dirty: boolean) => void
  setSelectedWritingSkillLibrarySkillId: (id: string | null) => Promise<boolean>
  setWritingSkillLibraryDraftDirty: (dirty: boolean) => void
  setSelectedWritingStyleLibraryStyleId: (id: string | null) => void
  setPersonaSkillLibraryDraftDirty: (dirty: boolean) => void
  setPersonaOutlinePane: (focus: PersonaOutlinePaneFocus | null) => Promise<boolean>
  /** 通知所有人物视图「数据变了」。 */
  bumpPersonaDataVersion: () => void
  setSelectedReviewDimension: (dimension: string | null) => void
  setSelectedReviewFilePath: (path: string) => void
  setLlmConfig: (config: LlmConfig) => void
  setAiChatModel: (model: string) => void
  setAiOutlineModel: (model: string) => void
  setAiChatReasoningDepth: (depth: ReasoningDepth) => void
  setAiOutlineReasoningDepth: (depth: ReasoningDepth) => void
  setDefaultLlmModel: (model: string) => void
  setProviderConfigs: (configs: ProviderConfigs) => void
  setActivePresetId: (id: string | null) => void
  setSearchApiConfig: (config: SearchApiConfig) => void
  setMultimodalConfig: (config: MultimodalConfig) => void
  setOutputLanguage: (lang: OutputLanguage) => void
  setProxyConfig: (config: ProxyConfig) => void
  setScheduledImportConfig: (config: ScheduledImportConfig) => void
  setSourceWatchConfig: (sourceWatchConfig: SourceWatchConfig) => void
  setNovelMode: (novelMode: boolean) => void
  setChatEditModeEnabled: (enabled: boolean) => void
  setAiWorkflowMode: (mode: AiWorkflowMode) => void
  setOutlineWorkflowMode: (mode: OutlineWorkflowMode) => void
  setNovelConfig: (config: Partial<NovelConfig>) => void
  setPersonaSkillLearningError: (error: string | null) => void
  setSearchHistory: (history: string[]) => void
  setSearchTrigger: (trigger: { query: string; ts: number } | null) => void
  setRevisionFeedbackWindowConfig: (revisionFeedbackWindowConfig: RevisionFeedbackWindowConfig) => void
  setFinalChapterSave: (finalChapterSave: FinalChapterSaveState | null) => void
  setLintRun: (lintRun: LintRunState | null) => void
  finishLintRun: (runId: string, lintRun: LintRunFinishState) => void
  setReviewRun: (reviewRun: ReviewRunState | null) => void
  finishReviewRun: (runId: string, reviewRun: ReviewRunFinishState) => void
  clearTransientTaskState: () => void
  setTheme: (theme: UiTestSkin) => void
  setUiFontSizeScale: (scale: number) => void
  setUiBodyFontPx: (value: number) => void
  setUiBodyLineHeight: (value: number) => void
  setUiBodyLetterSpacing: (value: number) => void
  setUiBodyMarginX: (value: number | null) => void
  setUiBodySafeBottom: (value: number) => void
  setVisualStyle: (visualStyle: VisualStyle) => void
  setSidebarNavConfig: (config: Partial<SidebarNavConfig>) => void
  bumpDataVersion: () => void
}

async function applyDraftNavigation(
  state: WikiState, needsConfirmation: boolean, patch: Partial<WikiState>,
): Promise<boolean> {
  if (needsConfirmation) {
    if (!(await confirmDiscardSkillLibraryDraft())) return false
    const current = useWikiStore.getState()
    if (current.project?.path !== state.project?.path || current.activeView !== state.activeView
      || current.personaOutlinePane !== state.personaOutlinePane || current.selectedFile !== state.selectedFile
      || current.selectedSkillLibrarySkillId !== state.selectedSkillLibrarySkillId
      || current.selectedWritingSkillLibrarySkillId !== state.selectedWritingSkillLibrarySkillId) return false
  }
  useWikiStore.setState(patch)
  return true
}

export function discardProjectSkillDrafts(): Promise<boolean> {
  const state = useWikiStore.getState()
  return applyDraftNavigation(state,
    state.skillLibraryDraftDirty || state.writingSkillLibraryDraftDirty || state.personaSkillLibraryDraftDirty,
    { skillLibraryDraftDirty: false, writingSkillLibraryDraftDirty: false, personaSkillLibraryDraftDirty: false },
  )
}

export const useWikiStore = create<WikiState>((set, get) => ({
  project: null,
  fileTree: [],
  projectPathIndex: createEmptyProjectPathIndex(),
  selectedFile: null,
  selectedTrashItem: null,
  fileContent: "",
  pendingEditorHighlight: null,
  pendingScrollImageSrc: null,

  chatExpanded: false,
  searchPanelOpen: false,
  activeView: "wiki",
  activeSettingsCategory: null,
  activeModelSettingsTab: null,
  selectedSkillLibrarySkillId: null,
  skillLibraryDraftDirty: false,
  selectedWritingSkillLibrarySkillId: null,
  writingSkillLibraryDraftDirty: false,
  selectedWritingStyleLibraryStyleId: null,
  personaSkillLibraryDraftDirty: false,
  personaOutlinePane: null,
  personaDataVersion: 0,
  selectedReviewDimension: null,
  selectedReviewFilePath: "",
  llmConfig: {
    provider: "openai",
    apiKey: "",
    maxContextSize: 204800,
    model: "",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    azureApiVersion: "2024-10-21",
    azureModelFamily: "auto",
    reasoning: { mode: "auto" },
    localCliIsolation: false,
  },
  aiChatModel: "",
  aiOutlineModel: "",
  aiOutlineModelRevision: 0,
  aiChatReasoningDepth: DEFAULT_REASONING_DEPTH,
  aiOutlineReasoningDepth: DEFAULT_REASONING_DEPTH,
  defaultLlmModel: "",
  providerConfigs: {},
  activePresetId: null,

  dataVersion: 0,

  setProject: (project) => set((state) => project?.path === state.project?.path
    ? { project }
    : { project, personaOutlinePane: null, personaSkillLibraryDraftDirty: false }),
  setFileTree: (fileTree, options) => {
    if (options?.syncPathIndex === false) {
      set({ fileTree })
      return
    }
    set({ fileTree, projectPathIndex: buildProjectPathIndexFromTree(fileTree) })
  },
  setProjectPathIndexFromTree: (tree) =>
    set({ projectPathIndex: buildProjectPathIndexFromTree(tree) }),
  setSelectedFile: (selectedFile) => {
    const state = get()
    return applyDraftNavigation(state, !!state.personaOutlinePane && state.personaSkillLibraryDraftDirty, {
      selectedFile, selectedTrashItem: null, personaOutlinePane: null, personaSkillLibraryDraftDirty: false,
    })
  },
  setSelectedTrashItem: (selectedTrashItem) => set({ selectedTrashItem, selectedFile: null }),
  setFileContent: (fileContent) => set({ fileContent }),
  setPendingEditorHighlight: (pendingEditorHighlight) => set({ pendingEditorHighlight }),
  setPendingScrollImageSrc: (pendingScrollImageSrc) => set({ pendingScrollImageSrc }),

  setChatExpanded: (chatExpanded) => set({ chatExpanded }),
  setSearchPanelOpen: (searchPanelOpen) => set({ searchPanelOpen }),
  setActiveView: (activeView) => {
    const state = get()
    if (activeView === "soul" || activeView === "bookAnalysis" || activeView === "storySimulation") {
      activeView = "wiki"
    }
    const leaving = activeView !== state.activeView
    const dirty = leaving && (
      (state.activeView === "skillLibrary" && state.skillLibraryDraftDirty)
      || (state.activeView === "writingSkillLibrary" && state.writingSkillLibraryDraftDirty)
      || ((!!state.personaOutlinePane || state.activeView === "personaSkillLibrary") && state.personaSkillLibraryDraftDirty)
    )
    return applyDraftNavigation(state, dirty, {
      activeView,
      personaOutlinePane: activeView === state.activeView ? state.personaOutlinePane : null,
      skillLibraryDraftDirty: activeView === "skillLibrary" ? state.skillLibraryDraftDirty : false,
      writingSkillLibraryDraftDirty: activeView === "writingSkillLibrary"
        ? state.writingSkillLibraryDraftDirty
        : false,
      personaSkillLibraryDraftDirty: activeView === state.activeView && state.personaSkillLibraryDraftDirty,
    })
  },
  setActiveSettingsCategory: (activeSettingsCategory) => set({ activeSettingsCategory }),
  setActiveModelSettingsTab: (activeModelSettingsTab) => set({ activeModelSettingsTab }),
  setSelectedSkillLibrarySkillId: (selectedSkillLibrarySkillId) => {
    const state = get()
    if (state.selectedSkillLibrarySkillId === selectedSkillLibrarySkillId) return Promise.resolve(true)
    return applyDraftNavigation(state, state.skillLibraryDraftDirty, {
      selectedSkillLibrarySkillId,
      skillLibraryDraftDirty: false,
    })
  },
  setSkillLibraryDraftDirty: (skillLibraryDraftDirty) => set({ skillLibraryDraftDirty }),
  setSelectedWritingSkillLibrarySkillId: (selectedWritingSkillLibrarySkillId) => {
    const state = get()
    if (state.selectedWritingSkillLibrarySkillId === selectedWritingSkillLibrarySkillId) return Promise.resolve(true)
    return applyDraftNavigation(state, state.writingSkillLibraryDraftDirty, {
      selectedWritingSkillLibrarySkillId,
      writingSkillLibraryDraftDirty: false,
    })
  },
  setWritingSkillLibraryDraftDirty: (writingSkillLibraryDraftDirty) => set({ writingSkillLibraryDraftDirty }),
  setSelectedWritingStyleLibraryStyleId: (selectedWritingStyleLibraryStyleId) =>
    set({ selectedWritingStyleLibraryStyleId }),
  setPersonaSkillLibraryDraftDirty: (personaSkillLibraryDraftDirty) =>
    set({ personaSkillLibraryDraftDirty }),
  setPersonaOutlinePane: (personaOutlinePane) => {
    const state = get()
    if (state.personaOutlinePane?.mode === "persona" && personaOutlinePane?.mode === "persona"
      && state.personaOutlinePane.id === personaOutlinePane.id) return Promise.resolve(true)
    return applyDraftNavigation(state, state.personaSkillLibraryDraftDirty, { personaOutlinePane, personaSkillLibraryDraftDirty: false })
  },
  bumpPersonaDataVersion: () => set((state) => ({ personaDataVersion: state.personaDataVersion + 1 })),

  setSelectedReviewDimension: (selectedReviewDimension) => set({ selectedReviewDimension }),
  setSelectedReviewFilePath: (selectedReviewFilePath) => set({ selectedReviewFilePath }),
  searchApiConfig: {
    provider: "none",
    apiKey: "",
    serpApiEngine: "google",
    searXngUrl: "",
    searXngCategories: ["general"],
    providerConfigs: {},
  },

  jevConfig: null,
  jevConfigLoadError: null,
  multimodalConfig: {
    // Off by default — captioning is a non-trivial token spend
    // (one VLM call per extracted image), and silently turning it
    // on for every user the first time they import a PDF would be
    // a budget surprise. Users who want it flip the toggle in
    // Settings → Image captioning.
    enabled: false,
    useMainLlm: true,
    provider: "custom",
    apiKey: "",
    model: "",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    azureApiVersion: "2024-10-21",
    azureModelFamily: "auto",
    apiMode: "chat_completions",
    concurrency: 4,
  },

  outputLanguage: "Chinese",

  proxyConfig: {
    enabled: false,
    url: "",
    bypassLocal: true,
  },

  scheduledImportConfig: {
    enabled: false,
    path: "",
    interval: 60,
    lastScan: null,
  },

  sourceWatchConfig: DEFAULT_SOURCE_WATCH_CONFIG,

  novelMode: true,
  chatEditModeEnabled: false,
  aiWorkflowMode: DEFAULT_AI_WORKFLOW_MODE,
  aiWorkflowModeBeforeDiscuss: DEFAULT_AI_WORKFLOW_MODE,
  outlineWorkflowMode: DEFAULT_OUTLINE_WORKFLOW_MODE,
  novelConfig: { ...DEFAULT_NOVEL_CONFIG },
  personaSkillLearningError: null,
  searchHistory: [],
  searchTrigger: null,
  revisionFeedbackWindowConfig: {
    currentChapterIncludeShouldImprove: true,
    previousChapterCarryEnabled: true,
    lookbackChapterCount: 2,
    lookbackIncludeMustFixOnly: true,
  },
  finalChapterSave: null,
  lintRun: null,
  reviewRun: null,
  theme: "light",
  uiFontSizeScale: readStoredUiFontSizeScale(),
  uiBodyFontPx: readStoredBodyFontPx(),
  uiBodyLineHeight: readStoredBodyLineHeight(),
  uiBodyLetterSpacing: readStoredBodyLetterSpacing(),
  uiBodyMarginX: readStoredBodyMarginX(),
  uiBodySafeBottom: readStoredBodySafeBottom(),
  visualStyle: readStoredVisualStyle(),
  sidebarNavConfig: readStoredSidebarNavConfig(),

  setLlmConfig: (llmConfig) => set({ llmConfig: normalizeUserLlmConfig(llmConfig) }),
  setAiChatModel: (aiChatModel) => set({ aiChatModel }),
  setAiOutlineModel: (aiOutlineModel) => set((state) => ({
    aiOutlineModel,
    aiOutlineModelRevision: state.aiOutlineModelRevision + 1,
  })),
  setAiChatReasoningDepth: (depth) => set({
    aiChatReasoningDepth: normalizeReasoningDepth(depth),
  }),
  setAiOutlineReasoningDepth: (depth) => set({
    aiOutlineReasoningDepth: normalizeReasoningDepth(depth),
  }),
  setDefaultLlmModel: (defaultLlmModel) => set({ defaultLlmModel }),
  setProviderConfigs: (providerConfigs) => set({
    providerConfigs: normalizeProviderConfigs(providerConfigs),
  }),
  setActivePresetId: (activePresetId) => set({ activePresetId }),
  setSearchApiConfig: (searchApiConfig) => set({ searchApiConfig }),
  setMultimodalConfig: (multimodalConfig) => set({ multimodalConfig }),
  setOutputLanguage: (outputLanguage) => set({ outputLanguage }),
  setProxyConfig: (proxyConfig) => set({ proxyConfig }),
  setScheduledImportConfig: (scheduledImportConfig) => set({ scheduledImportConfig }),
  setSourceWatchConfig: (sourceWatchConfig) => set({ sourceWatchConfig }),
  setNovelMode: (novelMode) => set({ novelMode }),
  setChatEditModeEnabled: (chatEditModeEnabled) => set({ chatEditModeEnabled }),
  setAiWorkflowMode: (aiWorkflowMode) =>
    set((state) => ({
      aiWorkflowMode,
      // 切到「共创」时记住切入前的模式；切到其它模式时直接刷新为当前选择。
      aiWorkflowModeBeforeDiscuss:
        aiWorkflowMode === "discuss"
          ? (state.aiWorkflowMode !== "discuss"
            ? state.aiWorkflowMode
            : state.aiWorkflowModeBeforeDiscuss)
          : aiWorkflowMode,
    })),
  setOutlineWorkflowMode: (outlineWorkflowMode) => set({ outlineWorkflowMode }),
  setNovelConfig: (config) => set((state) => ({
    novelConfig: { ...state.novelConfig, ...config },
    ...(config.defaultLlmModel !== undefined
      ? { defaultLlmModel: config.defaultLlmModel }
      : {}),
  })),
  setPersonaSkillLearningError: (personaSkillLearningError) => set({ personaSkillLearningError }),
  setSearchHistory: (searchHistory) => set({ searchHistory }),
  setSearchTrigger: (searchTrigger) => set({ searchTrigger }),
  setRevisionFeedbackWindowConfig: (revisionFeedbackWindowConfig) => set({ revisionFeedbackWindowConfig }),
  setFinalChapterSave: (finalChapterSave) => set({ finalChapterSave }),
  setLintRun: (lintRun) => set({ lintRun }),
  finishLintRun: (runId, lintRun) => set((state) => {
    if (state.lintRun?.runId !== runId) return {}
    return { lintRun: { ...state.lintRun, ...lintRun } }
  }),
  setReviewRun: (reviewRun) => set({ reviewRun }),
  finishReviewRun: (runId, reviewRun) => set((state) => {
    if (state.reviewRun?.runId !== runId) return {}
    return { reviewRun: { ...state.reviewRun, ...reviewRun } }
  }),
  clearTransientTaskState: () => set({ finalChapterSave: null, lintRun: null, reviewRun: null }),
  setTheme: (theme) => set({ theme }),
  setUiFontSizeScale: (scale) => {
    const clamped = clampUiFontSizeScale(scale)
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(UI_FONT_SIZE_SCALE_KEY, String(clamped))
    }
    set({ uiFontSizeScale: clamped })
  },
  /*
   * 5 个排版参数的统一写法：钳制 → 落 localStorage → 写 store。
   * 三者缺一都会出问题：
   *   · 少钳制 → 「设成 200px 后下次启动被读回时截成别的值」；
   *   · 少落盘 → 这次生效、下次启动丢失；
   *   · 少写 store → 界面不刷新。
   * 范围一律来自 font-settings.ts 的 clamp，不在这里重写数字。
   */
  setUiBodyFontPx: (value) => {
    const clamped = clampBodyFontPx(value)
    if (typeof localStorage !== "undefined") localStorage.setItem(BODY_FONT_PX_KEY, String(clamped))
    set({ uiBodyFontPx: clamped })
  },
  setUiBodyLineHeight: (value) => {
    const clamped = clampBodyLineHeight(value)
    if (typeof localStorage !== "undefined") localStorage.setItem(BODY_LINE_HEIGHT_KEY, String(clamped))
    set({ uiBodyLineHeight: clamped })
  },
  setUiBodyLetterSpacing: (value) => {
    const clamped = clampBodyLetterSpacing(value)
    if (typeof localStorage !== "undefined") localStorage.setItem(BODY_LETTER_SPACING_KEY, String(clamped))
    set({ uiBodyLetterSpacing: clamped })
  },
  setUiBodyMarginX: (value) => {
    const clamped = clampBodyMarginX(value)
    if (typeof localStorage !== "undefined") {
      // null 表示「跟随窗口」：移除该键，让读取函数回到默认的 null，
      // 而不是写字符串 "null"（读回时 Number("null") 是 NaN）
      if (clamped === null) localStorage.removeItem(BODY_MARGIN_X_KEY)
      else localStorage.setItem(BODY_MARGIN_X_KEY, String(clamped))
    }
    set({ uiBodyMarginX: clamped })
  },
  setUiBodySafeBottom: (value) => {
    const clamped = clampBodySafeBottom(value)
    if (typeof localStorage !== "undefined") localStorage.setItem(BODY_SAFE_BOTTOM_KEY, String(clamped))
    set({ uiBodySafeBottom: clamped })
  },
  setVisualStyle: (visualStyle) => {
    const normalized = normalizeVisualStyle(visualStyle)
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(VISUAL_STYLE_STORAGE_KEY, normalized)
      localStorage.setItem(VISUAL_STYLE_STORAGE_VERSION_KEY, VISUAL_STYLE_STORAGE_VERSION)
    }
    set({ visualStyle: normalized })
  },
  setSidebarNavConfig: (config) => {
    const normalized = normalizeSidebarNavConfig(config)
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(SIDEBAR_NAV_CONFIG_KEY, JSON.stringify(normalized))
    }
    set({ sidebarNavConfig: normalized })
  },
  bumpDataVersion: () => set((state) => ({ dataVersion: state.dataVersion + 1 })),
}))

export type { WikiState, LlmConfig, SearchApiConfig, MultimodalConfig, OutputLanguage, ProxyConfig, SourceWatchConfig }
