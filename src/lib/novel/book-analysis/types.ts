import type { StyleMetrics } from "./style-metrics"

export interface WritingDnaLayers {
  /** L1 语言 DNA：模型对确定性统计（句长、标点、词频）的解读 */
  languageDna: string
  /** L2 章节结构模板：开场 hook、场景切换、章尾钩子、单章场景数 */
  structurePatterns: string
  /** L3-L5 叙事视角与认知框架：推进取舍、细节素材、作者价值判断 */
  cognitiveFrame: string
  /** L6 排版与节奏：段落长度节奏、一句一段用法、分隔方式 */
  rhythmGuide: string
}

/**
 * 文风预设中保存的作品级叙事画像。
 * 描述作者的整体叙事风格。
 *
 * schemaVersion 2 起改为 writing-dna 分层蒸馏：metrics 是脚本统计的确定性数字，
 * layers 是 L1-L6 分层解读，integratedDna 是注入生成的总入口（上限约 4000 字）。
 * v1 的 9 个维度字段全部保留为可选，既能读旧数据，也让旧 UI 与校验引擎继续工作。
 */
export interface BookStyleProfile {
  schemaVersion: 1 | 2
  generatedAt: number
  sampledChapterIds: string[]
  /** v2：L1 / L6 的确定性统计结果（不调 LLM 算出）。 */
  metrics?: StyleMetrics
  /** v2：L1-L6 分层蒸馏产物。 */
  layers?: WritingDnaLayers
  /** v2：整合文档正文，注入生成时的首选内容。 */
  integratedDna?: string
  /** v1 维度，v2 仍会尽量填充以兼容旧 UI 与 verification-engine。 */
  narrativeDensity?: string
  descriptionWeight?: string
  emotionRendering?: string
  sentenceStyle?: string
  rhetoricDensity?: string
  transitionStyle?: string
  narrativeVoice?: string
  dialogueStyle?: string
  thematicHabits?: string
  humorMechanisms?: string[]
  highEnergyMechanisms?: string[]
  pointOfView?: string
  vocabularyPreferences?: string[]
  avoidPatterns?: string[]
  evidenceIds?: string[]
  /** 8~12 条注入用"风格宪法"硬约束。v2 仍保留，作为 integratedDna 缺失时的降级内容。 */
  constitution: string
  /** 3~6 段代表原文片段，作为模仿锚点（few-shot）。 */
  samples: string[]
}
