/**
 * 「人物 Skill」的类型与阈值单点。
 *
 * 这里只放纯数据与纯判定；读写盘在 persona-skill-store.ts，编排在 persona-skill-learning.ts。
 */

export type PersonaSkillTier = "major" | "minor"
export type PersonaSkillStatus = "active" | "dormant" | "archived"
export type PersonaSkillMode = "create" | "refine"

/** 定位 → 档位。定位取自 wiki/characters/角色-<定位>-<名>.md 的文件名。 */
export const PERSONA_MAJOR_ROLE_TYPES = ["主角", "男主", "女主", "反派", "导师"] as const
export const PERSONA_MINOR_ROLE_TYPES = ["男配", "女配", "配角", "盟友"] as const

/** 首次建档所需的累计出场次数。 */
export const PERSONA_MAJOR_FIRST_APPEARANCE = 1
export const PERSONA_MINOR_FIRST_APPEARANCE = 2
/**
 * 没有定位的名字不进档位表，用更保守的门槛：出场满 3 次才按 minor 处理。
 * 「一笔带过的路人」就是被这个门槛滤掉的——不是靠某个叫「龙套」的定位标签。
 * 注意别把它读成「永不确定」：出场真的到了 3 次，就该建档。
 */
export const PERSONA_UNKNOWN_FIRST_APPEARANCE = 3

/** 再次完善所需的累计出场次数。 */
export const PERSONA_MAJOR_REFINE_APPEARANCE = 2
export const PERSONA_MINOR_REFINE_APPEARANCE = 3

/** 生命周期：连续多少章没出场算潜伏 / 归档。永不自动删除文件。 */
export const PERSONA_DORMANT_GAP_CHAPTERS = 10
export const PERSONA_ARCHIVED_GAP_CHAPTERS = 30

/** 一次模型调用最多处理几个人物：人数一多，每个人分到的注意力和输出长度都会被稀释。 */
export const PERSONA_SKILL_BATCH_SIZE = 4

/**
 * 完善时的字段护栏：新值短于旧值的这个比例，视为模型漏写，保留旧值。
 * 完善要求输出「合并后的完整内容」，正常情况下只会变长或略微压缩。
 */
export const PERSONA_FIELD_SHRINK_RATIO = 0.4
/** 提示词里每个字段的长度上限（合并后）。 */
export const PERSONA_FIELD_MAX_CHARS = 300
/** 手改档案唯一「补充」段的长度上限。 */
export const PERSONA_SUPPLEMENT_MAX_CHARS = 600

/** 建档时额外参考的、此前出场过的章节数。 */
export const PERSONA_PRIOR_EVIDENCE_CHAPTERS = 3

/** SKILL.md 被覆盖前的版本快照目录与保留份数。 */
export const PERSONA_SKILL_HISTORY_DIR = "references/history"
export const PERSONA_SKILL_HISTORY_KEEP = 5

/** 注入上限（D5）。 */
export const PERSONA_INJECT_MAX_SKILLS = 12
export const PERSONA_INJECT_CHAR_BUDGET = 4000
export const PERSONA_INJECT_FIELD_CHARS = 260
/** 性格在演技段最前展示，同时受标签数、字数和整段预算限制。 */
export const PERSONA_INJECT_PERSONALITY_MAX_TAGS = 4
export const PERSONA_INJECT_PERSONALITY_MAX_CHARS = 20
/** 双向包含匹配的最小长度：单字称呼（如单姓「林」）会污染匹配，只允许精确相等。 */
export const PERSONA_MIN_SUBSTRING_MATCH_CHARS = 2

/** 主要人物的演技字段。字段名对应 SKILL.md 的二级标题，顺序即写作注入顺序。 */
export const PERSONA_MAJOR_FIELDS = [
  "怎么说话",
  "怎么想",
  "怎么判断",
  "什么不做",
  "知道局限",
] as const
/** 次要人物只给两条（设计 07 节）：这两条在 major 表里也有，必须是它的子集。 */
export const PERSONA_MINOR_FIELDS = ["怎么说话", "怎么判断"] as const
/** 所有角色建档和学习时保存全部五项演技字段，生成正文时按档位选取。 */
export const PERSONA_STORED_FIELDS = PERSONA_MAJOR_FIELDS

/** 档案页和 SKILL.md 共用这些字段名与顺序。写作时性格进入演技段，其余事实与作者小传合并。 */
export const PERSONA_PROFILE_FIELDS = [
  "性别",
  "年龄",
  "势力组织",
  "外貌",
  "性格",
  "背景",
  "动机",
  "能力",
  "关系网",
  "成长轨迹",
  "备注",
] as const

/** 记忆提取从章节快照直接更新这些字段。写作时它们与该人物的小传事实共用预算。 */
export const PERSONA_LIVE_FIELDS = ["当前状态", "出场组织", "认知变化", "关系变化"] as const

/**
 * SKILL.md 里会被渲染 / 合并的**全部**字段，顺序即文档顺序。
 *
 * 档案在前、演技居中、动态在最后：动态区块变得最勤，放末尾便于人肉阅读与 diff。
 * `readStoredPersonaFields` 与 `mergePersonaFields` 也用它遍历 —— 后者必须覆盖
 * 全部字段，否则完善一轮只合并 5 个演技字段，其余字段会被下一轮整格替换清空。
 */
export const PERSONA_DOCUMENT_FIELDS = [
  ...PERSONA_PROFILE_FIELDS,
  ...PERSONA_MAJOR_FIELDS,
  ...PERSONA_LIVE_FIELDS,
] as const

/** 动态区块里「累积型」字段各自保留的条数上限（超出丢最旧）。当前状态是快照，不累积。 */
export const PERSONA_LIVE_SECTION_LIMITS = {
  出场组织: 8,
  认知变化: 12,
  关系变化: 12,
} as const
/** 用户手改过的档案只在文末追加这个段落，AI 不覆盖既有内容。 */
export const PERSONA_SUPPLEMENT_HEADING = "补充"
/** 只有绿勾（pinned）人物才生成研究文件。 */
export const PERSONA_RESEARCH_DOCUMENTS = [
  "人物小传",
  "语言习惯",
  "关键关系",
  "动机与弧光",
  "名场面",
  "禁忌与误区",
] as const

/**
 * 不允许删除的大纲文件夹。
 *
 * 只有「人物小传」：它是全项目角色的固定容器，删掉等于一次性丢掉所有角色入口，
 * 而角色档案的真实文件在 `.qmai/persona-skills/`，删文件夹并不会删档案 ——
 * 于是用户会看到「文件夹没了但技能库还在」，这是最难排查的一类不一致。
 * 单个角色文件仍可删（那是正常的角色清理），本保护只拦**文件夹**。
 */
export const PROTECTED_OUTLINE_FOLDERS = ["人物小传"] as const

export function isProtectedOutlineFolder(folderName: string): boolean {
  const trimmed = folderName.trim()
  return (PROTECTED_OUTLINE_FOLDERS as readonly string[]).includes(trimmed)
}

export const PERSONA_SKILLS_DIR = ".qmai/persona-skills"
export const PERSONA_SKILL_INDEX_FILE = "index.json"
export const PERSONA_SKILL_SIGHTINGS_FILE = "sightings.json"
export const PERSONA_SKILL_DOCUMENT_FILE = "SKILL.md"
export const PERSONA_SKILL_RESEARCH_DIR = "references/research"

/** index.json 里一条人物 Skill 的元数据。 */
export interface PersonaSkillMeta {
  id: string
  characterName: string
  aliases: string[]
  roleType: string
  tier: PersonaSkillTier
  /** 绿勾：用户手动点亮的「重要人物」，一票否决自动分档。 */
  pinned: boolean
  /** 章节学习和重要标记决定的自动状态，手动分组期间也会继续更新。 */
  status: PersonaSkillStatus
  /** 作者指定的分组。缺省时使用自动状态。 */
  manualStatus?: PersonaSkillStatus
  firstChapter: number
  lastChapter: number
  appearanceCount: number
  createdChapter: number
  lastLearnedChapter: number
  skillRevision: number
  /** 用户手改过正文；之后 AI 只追加「补充」，不整篇重写。 */
  editedByUser: boolean
  hasResearch: boolean
  updatedAt: string
  /**
   * 建档来源。`manual` = 用户点「新建人物角色」手建；`auto` = 大纲保存时抓取建档。
   * 删大纲连带删角色时 `manual` 永不连带删除 —— 用户亲手建的东西不能被一次删除带走。
   */
  origin: "manual" | "auto"
  /** 引用该角色的文件相对于 wiki/outlines 的路径。旧版条目可能只有文件名。 */
  outlineRefs: string[]
  /**
   * 冻结点：这份档案停在哪一章。`dormant` 时不再随大纲更新。
   * `null` 表示还没学到任何章节（手工新建刚建档时就是 null）。
   */
  asOfChapter: number | null
  /**
   * 随章节自动更新。缺省视为开启（老档案没这个字段，行为不能变）。
   * 关掉之后，「提取记忆」仍然会记出场次数，但**不再改写正文** ——
   * 适合已经定稿、不希望 AI 再动的角色。
   */
  autoUpdate?: boolean
}

export interface PersonaSkillIndex {
  version: 1
  skills: PersonaSkillMeta[]
}

export function getEffectivePersonaStatus(meta: PersonaSkillMeta): PersonaSkillStatus {
  return meta.manualStatus ?? meta.status
}

/**
 * sightings.json 只装「还没有档案的人物」的出场计数，用来判断有没有到门槛。
 * 一旦建档就把它从这里移走 —— 所以这个文件的规模是「配角池」，不是全库。
 */
export interface PersonaSkillSighting {
  characterName: string
  /** 退回前的身份和列表位置。位置计入已暂存于候选池的人物。 */
  previousProfile?: { id: string; position: number; pinned: boolean; manualStatus?: PersonaSkillStatus }
  aliases: string[]
  roleType: string
  appearanceCount: number
  firstChapter: number
  lastChapter: number
  chapters: number[]
}

export interface PersonaSkillSightings {
  version: 1
  sightings: PersonaSkillSighting[]
  /**
   * 用户手动删除掉的候选人物名。
   * 必须持久化：候选池是**每章重新数出来**的，没有这份名单，删掉的人下次提取就会回来。
   */
  ignored?: string[]
}

export function isMajorRoleType(roleType: string): boolean {
  return (PERSONA_MAJOR_ROLE_TYPES as readonly string[]).includes(roleType.trim())
}

export function isMinorRoleType(roleType: string): boolean {
  return (PERSONA_MINOR_ROLE_TYPES as readonly string[]).includes(roleType.trim())
}

/**
 * 建档门槛（首次出场）。
 *
 * `knownCharacter` 是「已经能确认他是本作的一个真实人物」——判据是
 * `wiki/entities/` 下有一张 `tags` 含 `character` 的实体页（见
 * `resolveKnownCharacters`）。这个信号的宝贵之处在于**它天然斩断了路人**：
 * 摄取管线只会给值得追踪的实体建页，正文里一笔带过的「老太太 / 老头 /
 * 小男孩」根本没有实体页。
 *
 * 为什么必须认这个信号：定位（主角/配角…）只写在
 * `wiki/characters/角色-<定位>-<名>.md` 的文件名里，而那个目录只有跑过
 * 「人物」多智能体生成才会出现。真实项目里它往往不存在 → 所有人 roleType
 * 都是空 → 一律落到 `PERSONA_UNKNOWN_FIRST_APPEARANCE = 3`。实测一个 12 章
 * 的项目里最高出场数才 2，于是**一个人都建不了档，功能整体静默失效**。
 * 有了这道兜底，确认过的人物第一次出场就建档；档位仍是 minor（浅档、省预算），
 * 由用户点绿勾或声明定位来升级。
 *
 * 绿勾的「一票升级」在 planPersonaSkillRound 里处理，不进这张表。
 */
export function firstAppearanceThreshold(roleType: string, knownCharacter = false): number {
  if (isMajorRoleType(roleType)) return PERSONA_MAJOR_FIRST_APPEARANCE
  if (isMinorRoleType(roleType)) return PERSONA_MINOR_FIRST_APPEARANCE
  if (knownCharacter) return PERSONA_MAJOR_FIRST_APPEARANCE
  return PERSONA_UNKNOWN_FIRST_APPEARANCE
}

export function refineAppearanceThreshold(roleType: string): number {
  return isMajorRoleType(roleType) ? PERSONA_MAJOR_REFINE_APPEARANCE : PERSONA_MINOR_REFINE_APPEARANCE
}

/** 绿勾一律按 major 注入；其余按定位分档。 */
export function resolvePersonaTier(roleType: string, pinned: boolean): PersonaSkillTier {
  if (pinned) return "major"
  return isMajorRoleType(roleType) ? "major" : "minor"
}

/** 连续多少章未出场决定状态；绿勾永远 active。 */
export function resolvePersonaStatus(
  lastChapter: number,
  currentChapter: number,
  pinned: boolean,
): PersonaSkillStatus {
  if (pinned) return "active"
  const gap = currentChapter - lastChapter
  if (gap >= PERSONA_ARCHIVED_GAP_CHAPTERS) return "archived"
  if (gap >= PERSONA_DORMANT_GAP_CHAPTERS) return "dormant"
  return "active"
}

/** 归一化人物名：去空白与标点、折叠大小写、NFKC。匹配只在归一化空间里做。 */
export function normalizePersonaName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "")
}

/** planPersonaSkillRound 的输入：一个人物在本章之后的累计状态。 */
export interface PersonaSkillPlanInput {
  characterName: string
  aliases: string[]
  roleType: string
  appearanceCount: number
  hasSkill: boolean
  /** 已经生成过研究文件。研究文件只「首次生成」，之后刷新由用户在界面上手动触发。 */
  hasResearch: boolean
  pinned: boolean
  lastLearnedChapter: number
  /**
   * 已确认是本作的真实人物（`wiki/entities/` 有 `tags` 含 `character` 的实体页）。
   * 只影响建档门槛，不影响档位 —— 档位仍由 roleType / 绿勾决定。
   */
  knownCharacter: boolean
}

export interface PersonaSkillPlan {
  characterName: string
  aliases: string[]
  roleType: string
  tier: PersonaSkillTier
  pinned: boolean
  appearanceCount: number
  mode: PersonaSkillMode
  /**
   * 本轮该「首次生成」研究文件：绿勾人物 + 还没有研究文件。
   * 已经有研究文件的一律不重写 —— 章节学习的提示词只看得到 SKILL.md，
   * 看不到那 6 份研究文件，重写等于用只有本章的素材覆盖掉累积内容。
   */
  withResearch: boolean
}

/**
 * 本轮该对哪些人物做什么，纯函数。
 *
 * 幂等：已建档的人物如果 lastLearnedChapter 已经等于当前章就跳过，重复摄取同一章不会二次烧模型。
 * 未建档的人物不受 lastLearnedChapter 约束 —— 那是有意的 fail-open：没有档案就该建档，
 * 万一有调用方给未建档条目填了 lastLearnedChapter，最坏也只是重复规划一次，不会永久静默跳过。
 *
 * 输入须已按 normalizePersonaName 去重（同名人物传两次会产出两条 plan）。
 */
export function planPersonaSkillRound(
  inputs: readonly PersonaSkillPlanInput[],
  currentChapter: number,
): PersonaSkillPlan[] {
  const plans: PersonaSkillPlan[] = []
  for (const input of inputs) {
    const tier = resolvePersonaTier(input.roleType, input.pinned)
    const withResearch = input.pinned && !input.hasResearch
    if (input.hasSkill) {
      if (input.lastLearnedChapter >= currentChapter) continue
      // 复用 major 首现门槛 = D6「绿勾一票升级为 major」，不是巧合。
      const threshold = input.pinned ? PERSONA_MAJOR_FIRST_APPEARANCE : refineAppearanceThreshold(input.roleType)
      if (input.appearanceCount < threshold) continue
      plans.push({
        characterName: input.characterName,
        aliases: [...input.aliases],
        roleType: input.roleType,
        tier,
        pinned: input.pinned,
        appearanceCount: input.appearanceCount,
        mode: "refine",
        withResearch,
      })
      continue
    }
    const threshold = input.pinned
      ? PERSONA_MAJOR_FIRST_APPEARANCE
      : firstAppearanceThreshold(input.roleType, input.knownCharacter)
    if (input.appearanceCount < threshold) continue
    plans.push({
      characterName: input.characterName,
      aliases: [...input.aliases],
      roleType: input.roleType,
      tier,
      pinned: input.pinned,
      appearanceCount: input.appearanceCount,
      mode: "create",
      withResearch,
    })
  }
  return plans
}
