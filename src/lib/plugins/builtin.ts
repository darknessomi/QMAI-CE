import type { WikiState } from "@/stores/wiki-store"

/**
 * 「内置插件」清单。
 *
 * ── 它和手动安装的插件有什么不同 ──────────────────────────────
 * 外部插件是**第三方代码**：跑在独立进程里，只能通过 MCP + 宿主 HTTP 接口做事，
 * 因此碰不到应用内部状态（当前章节、审查结果、大纲树），也画不进主界面。
 *
 * 这里的「内置插件」是**我们自己的功能**，代码一行都没搬走，只是给它套上了
 * 插件形态的外壳（插件页里的条目 + 开关 + 描述）。所以：
 *
 *   · 好处：可以一键关掉自己不用的功能，插件页成为"我装了什么、开了什么"的
 *     统一入口，用户不用去设置里翻。
 *   · 代价 / 必须诚实的地方：**它不是真的卸载**。关掉只是让入口消失、功能不加载，
 *     代码仍在安装包里、磁盘占用不变、也不能单独分发或第三方开发。
 *
 * 界面文案必须写清这一点，否则用户会以为「关掉 = 卸掉了」。
 */
export type BuiltinPluginId =
  | "web-search"
  | "memory-center"
  | "skill-library"
  | "review-center"
  | "plot-search"

export interface BuiltinPlugin {
  id: BuiltinPluginId
  name: string
  /** 一句话说清它是什么（插件页卡片第二行）。 */
  description: string
  /**
   * `capability` = 一种能力闸门（关掉后是"不再发生某件事"）；
   * `view` = 一个界面（关掉后是"入口消失"）。
   * 两者的"关闭"语义不同，界面要用不同的措辞，不能混着写。
   */
  kind: "capability" | "view"
  /**
   * 关联的一级视图。`web-search` 没有独立视图（它是能力闸门），所以为空。
   * 有视图的条目被关闭时，导航里的入口要一起隐藏 —— 否则用户点进去只会看到
   * 一个"已关闭"的空壳，那是缺陷不是功能。
   */
  view?: NonNullable<WikiState["activeView"]>
  /** 关闭后到底会发生什么。必须具体，不许写"功能不可用"这种废话。 */
  offEffect: string
  defaultEnabled: boolean
}

/**
 * 顺序即插件页里的显示顺序：能力类在前，界面类在后。
 *
 * 剧情搜索 / 审查中心 之所以只能做成内置插件（而不是外部插件），
 * 是因为它们都依赖宿主独有能力：
 *   · 剧情搜索 用**向量检索**（需要 embedding 模型）+ 点结果要跳转章节；
 *   · 审查中心 读写 `reviewRun` / `selectedFile` 这些 store 状态；
 * 插件进程拿不到这些东西，硬拆会让功能断掉。
 */
export const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = [
  {
    id: "web-search",
    name: "网页搜索",
    description: "让 AI 联网查外部资料；也可供写作实体搜索等功能使用。",
    kind: "capability",
    offEffect: "关闭后所有联网搜索都会停用：AI 对话不再调用搜索工具，相关功能会跳过联网这一步。",
    defaultEnabled: true,
  },
  {
    id: "memory-center",
    name: "记忆中心",
    description: "查看与整理伏笔、设定、人物关系的记忆条目。",
    kind: "view",
    view: "lint",
    offEffect: "关闭后「记忆中心」入口从创作工具中消失，已记录的记忆条目不会被删除。",
    defaultEnabled: true,
  },
  {
    id: "skill-library",
    name: "技能库",
    description: "管理可复用的写作技能与提示词模板。",
    kind: "view",
    view: "skillLibrary",
    offEffect: "关闭后「技能库」入口从创作工具中消失，已保存的技能不会被删除。",
    defaultEnabled: true,
  },
  {
    id: "review-center",
    name: "审查中心",
    description: "按维度审查章节质量，汇总阻塞项与改写建议。",
    kind: "view",
    view: "reviewCenter",
    offEffect: "关闭后「审查中心」入口从创作工具中消失，已有的审查记录不会被删除。",
    defaultEnabled: true,
  },
  {
    id: "plot-search",
    name: "剧情搜索",
    description: "在当前作品里做关键词 / 向量 / 关系图混合检索，点结果直接跳章节。",
    kind: "view",
    view: "search",
    offEffect: "关闭后「剧情搜索」入口从创作工具中消失；AI 对话里的本地检索不受影响。",
    defaultEnabled: true,
  },
]

export function builtinPlugin(id: BuiltinPluginId): BuiltinPlugin | undefined {
  return BUILTIN_PLUGINS.find((item) => item.id === id)
}

/** 某个内置插件关联的视图（没有视图的能力类返回 undefined）。 */
export function builtinViewOf(id: BuiltinPluginId): BuiltinPlugin["view"] {
  return builtinPlugin(id)?.view
}
