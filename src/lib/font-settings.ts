/**
 * 界面字号倍率的允许范围（单一来源）。
 *
 * 为什么必须集中定义：这个值原先在两处各自硬编码
 * （`wiki-store.ts` 读取已存值时、`setUiFontSizeScale` 写入时）——
 * 只改一处会造成"设成 150% 后下次启动被读回时截成 130%"这种极难排查的缺陷。
 * 现在两处都引用这里的 clamp，改动只需一处，也不可能再漂移。
 *
 * 范围 80%–150% 由用户确认：下限照顾想缩小界面的用户，
 * 上限与正文字号上限相乘为 1.5 × 1.5 = 2.25 倍（约 40.5px），已实测无裁切。
 */
export const UI_FONT_SIZE_MIN = 0.8
export const UI_FONT_SIZE_MAX = 1.5

/**
 * 把任意输入钳制到允许范围。
 *
 * 无效输入（null / undefined / 空串 / 非有限值）退回默认档 **1**，
 * 而不是被 `Number(null) === 0` 这种隐式转换带到下限 0.8 ——
 * "没有存过值"与"用户想要最小字号"是两件事，不能混为一谈。
 */
function clampScale(value: unknown, min: number, max: number): number {
  if (value === null || value === undefined || value === "") return 1
  const n = Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.max(min, Math.min(max, Number(n.toFixed(2))))
}

export function clampUiFontSizeScale(value: unknown): number {
  return clampScale(value, UI_FONT_SIZE_MIN, UI_FONT_SIZE_MAX)
}

/** 界面字号预设。与上面同一份范围定义放在一起，避免与滑块边界脱节。 */
export const UI_FONT_SIZE_PRESETS = [
  { label: "小", value: 0.85 },
  { label: "默认", value: 1 },
  { label: "大", value: 1.25 },
  { label: "特大", value: 1.5 },
] as const

/* ────────────────────────── 正文排版参数（字号 / 行距 / 字距 / 边距 / 安全距离） ────────────────────────── */

/**
 * 把「可能来自存储的任意值」转成有限数字；null = 不是一个数字。
 *
 * 为什么不能直接 Number(x)：Number([]) === 0、Number("  ") === 0、
 * Number(true) === 1。这些会把「垃圾 / 未设置」误读成「用户选了最小值」，
 * 于是同一个文件对同一个输入给出两个答案（clampBodyFontPx("  ") → 12px，
 * bodyFontPxFromScale("  ") → 18px），而 "" 被特殊处理、"  " 却没有。
 *
 * 数字字符串要保留可用：localStorage 里存的就是 String(number)。
 * 真实的数字 0 原样返回 0 —— 那是用户明确选的取值，不是「没有值」。
 */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string") {
    const text = value.trim()
    if (text === "") return null
    const n = Number(text)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * 正文字号的允许范围（单位 px，绝对值）。
 *
 * ── 为什么从「倍数」改成「px」──
 * 旧模型是 `calc(1.125rem * var(--qmai-body-font-scale, 1))`：
 * 正文字号 = 界面字号 × 正文倍数。用户找不到「我要 15px」这个动作
 * —— 只有 85%/100%/125%/150% 四档百分比，且改界面字号会连带改正文。
 * 现在正文是绝对 px，与界面字号彻底解耦（用户已确认接受这一代价）。
 *
 * 上限 32px 低于旧模型的理论上限 40.5px（18 × 1.5 × 1.5），
 * 故裁切 / 溢出风险是**下降**的，不是上升。
 */
export const BODY_FONT_PX_MIN = 12
export const BODY_FONT_PX_MAX = 32
export const DEFAULT_BODY_FONT_PX = 18

/**
 * 旧倍数 → 新 px 的换算基准：老界面里倍数 1 曾经等于的 18px。
 *
 * 名字必须带上 LEGACY：它与 DEFAULT_BODY_FONT_PX 数值相同但**含义不同**
 * （一个是历史换算基准，一个是新模型默认档）。把它们「去重」成一个常量，
 * 日后改默认字号就会静默改掉迁移结果。
 */
export const LEGACY_BODY_FONT_PX_AT_SCALE_1 = 18

/**
 * 把任意输入钳到字号范围并取整。
 *
 * 无效输入退回默认档，而不是被 `Number(null) === 0` 带到下限：
 * 「没有存过值」与「用户想要最小字号」是两件事，不能混为一谈
 * （这条是仓库里已有的教训，与 clampScale 的处理保持一致）。
 *
 * 判据统一走 toFiniteNumber：`null` / `undefined` / `""` / `"  "` / `[]` /
 * 布尔 / 非数字串 全部算「没有值」；只有真正的数字（含 0，见下）才算「用户选了」。
 */
export function clampBodyFontPx(value: unknown): number {
  const n = toFiniteNumber(value)
  if (n === null) return DEFAULT_BODY_FONT_PX
  return Math.max(BODY_FONT_PX_MIN, Math.min(BODY_FONT_PX_MAX, Math.round(n)))
}

/**
 * 旧「正文倍数」迁移成 px。
 *
 * 为什么要把界面字号乘进来：改造前正文字号是
 *   calc(1.125rem * var(--qmai-body-font-scale, 1))
 * 而 rem 的基准是根字号（App 把它设成 uiFontSizeScale×100%），
 * 所以实际渲染高度是 18px × 界面倍数 × 正文倍数。
 * 只乘正文倍数会让界面字号非 100% 的用户一升级就发现正文变小了 ——
 * 与「无损迁移」的承诺矛盾。默认参数 1 使老调用与既有测试保持有效。
 *
 * 界面 150% + 正文 125% 时 18 × 1.25 × 1.5 = 33.75 会被新的 32px 上限钳住：
 * 这是「上限 32px」的既定代价（旧模型理论上限 40.5px），不是 bug。
 *
 * 只在读不到新键时调用，并且**不删除**旧键 —— 用户回滚到旧版本时，
 * 旧设置仍然在。映射：0.85→15 / 1→18 / 1.25→23 / 1.5→27（界面 100% 时）。
 * 用 round：1.25 × 18 = 22.5，取 23 与设置页旧文案的量级一致；
 * 0.85 × 18 = 15.3，取 15（下限档）。
 */
export function bodyFontPxFromScale(scale: unknown, uiFontScale: unknown = 1): number {
  const s = toFiniteNumber(scale)
  // 非数字或 ≤0 一律当作「未设置倍数」= 1 倍；
  // 是否要写入由 resolveMigratedBodyFontPx 决定，不在这里表达。
  const bodyScale = s === null || s <= 0 ? 1 : s
  return clampBodyFontPx(
    LEGACY_BODY_FONT_PX_AT_SCALE_1 * bodyScale * clampUiFontSizeScale(uiFontScale),
  )
}

/**
 * 决定「升级后第一次读正文字号」该得到什么。
 *
 * 返回 null = 不要写任何值，保持 store 默认（默认值来自本模块的单一来源）。
 *
 * 三种情况：
 *  1. 存过旧倍数        → 乘入界面字号后迁移。
 *  2. 没存过、界面字号非默认 → 按界面字号补种一次，否则用户会看到正文字号凭空变小
 *                          （改造前它本来就被界面字号放大着）。
 *  3. 没存过、界面字号 1   → null。此时补种的值恰好等于默认值，写它没有意义，
 *                          留着不写可以让「未设置」在存储里保持为「未设置」。
 */
export function resolveMigratedBodyFontPx(
  legacyBodyScale: unknown,
  uiFontScale: unknown,
): number | null {
  const ui = clampUiFontSizeScale(uiFontScale)
  const legacy = toFiniteNumber(legacyBodyScale)
  if (legacy !== null && legacy > 0) return bodyFontPxFromScale(legacy, ui)
  if (ui === 1) return null
  return clampBodyFontPx(LEGACY_BODY_FONT_PX_AT_SCALE_1 * ui)
}

/** 正文字号预设（px）。滑块仍可任意取值，这些只是快速点选。 */
export const BODY_FONT_PX_PRESETS = [
  { label: "小", value: 15 },
  { label: "默认", value: 18 },
  { label: "大", value: 21 },
  { label: "特大", value: 24 },
] as const

/**
 * 行间距范围（无单位倍数）。
 *
 * 必须是**无单位**数字：带单位（如 32px）会让行高不随字号变化，
 * 用户调大字号后行距被"吃掉"、文字挤在一起。
 * 下限 1.2 是「紧凑但可读」的经验下限，上限 2.6 再往上单屏放不下几行。
 */
export const BODY_LINE_HEIGHT_MIN = 1.2
export const BODY_LINE_HEIGHT_MAX = 2.6
export const DEFAULT_BODY_LINE_HEIGHT = 1.95

export function clampBodyLineHeight(value: unknown): number {
  const n = toFiniteNumber(value)
  if (n === null) return DEFAULT_BODY_LINE_HEIGHT
  // 两位小数：滑块步长 0.05，两位足够；同时避免浮点误差反复漂移
  return Math.max(BODY_LINE_HEIGHT_MIN, Math.min(BODY_LINE_HEIGHT_MAX, Number(n.toFixed(2))))
}

/**
 * 字间距范围（px）。
 *
 * 允许负值：中文排版里轻微收紧（-0.5px）能让密排的宋体更整齐，
 * 这是真实存在的排版诉求，不是笔误。
 */
export const BODY_LETTER_SPACING_MIN = -1
export const BODY_LETTER_SPACING_MAX = 6
export const DEFAULT_BODY_LETTER_SPACING = 0

export function clampBodyLetterSpacing(value: unknown): number {
  const n = toFiniteNumber(value)
  if (n === null) return DEFAULT_BODY_LETTER_SPACING
  return Math.max(BODY_LETTER_SPACING_MIN, Math.min(BODY_LETTER_SPACING_MAX, Number(n.toFixed(1))))
}

/**
 * 左右边距范围（px）。`null` 是一个**有意义的取值**：跟随窗口。
 *
 * 改造前正文两侧的间距是响应式的 `clamp(20px, 4vw, 48px)`。
 * 若把默认值直接定成某个固定 px，所有现有用户打开后版面都会变 ——
 * 那是一次没人要求的视觉回归。所以默认是 null：不写这个变量，
 * 让 CSS 的 clamp 兜底，行为与改造前逐位相同；用户拖动滑块之后才固定。
 */
export const BODY_MARGIN_X_MIN = 0
export const BODY_MARGIN_X_MAX = 160
export const DEFAULT_BODY_MARGIN_X: number | null = null

/*
 * 「跟随窗口」时 CSS 兜底值 clamp(20px, 4vw, 48px) 的三个数。
 *
 * 为什么要把它们放进这个单一来源文件：设置页要告诉用户
 * 「当前实际边距是多少」，写作现场滑块的停靠位置也要跟它一致 ——
 * 各写一份就会漂移，而漂移的结果是**界面在说谎**
 * （显示 40px，实际渲染 20px）。任务 12 的静态守卫会拿这三个数
 * 去比对 ui-test-editor.css 里的字面量，让漂移变成红灯。
 */
export const BODY_MARGIN_X_VIEWPORT_MIN = 20
export const BODY_MARGIN_X_VIEWPORT_VW = 4
export const BODY_MARGIN_X_VIEWPORT_MAX = 48

/**
 * 未设置左右边距时，当前窗口宽度下 CSS 兜底 clamp 的实际取值。
 *
 * 为什么需要：`marginX` 的 null 表示「跟随窗口」，但滑块必须显示一个数字。
 * 显示 0 会让用户以为边距被设成了 0（其实正文还有 20–48px 的间距），
 * 显示某个写死的 48 则在小窗口下明显不符。让它停在"当前真正生效的位置"，
 * 是唯一不会误导的选项。
 *
 * 非法宽度（0 / 负数 / NaN / 非有限值）返回下限：此时"跟随窗口"还没有
 * 意义，给下限比给 0 更接近真实渲染。
 */
export function defaultBodyMarginXForViewport(viewportWidth: unknown): number {
  const w = toFiniteNumber(viewportWidth)
  if (w === null || w <= 0) return BODY_MARGIN_X_VIEWPORT_MIN
  const vw = (w * BODY_MARGIN_X_VIEWPORT_VW) / 100
  return Math.round(
    Math.min(BODY_MARGIN_X_VIEWPORT_MAX, Math.max(BODY_MARGIN_X_VIEWPORT_MIN, vw)),
  )
}

export function clampBodyMarginX(value: unknown): number | null {
  // 与另外四条不同：这里「没有值」的返回值是 null（跟随窗口），不是默认数字。
  // 关键是 `[]` / `"  "` 必须落到这里，而不是被 Number() 变成 0 ——
  // 0 的含义是「把边距钉死在 0」，那是用户明确的选择。
  const n = toFiniteNumber(value)
  if (n === null) return null
  return Math.max(BODY_MARGIN_X_MIN, Math.min(BODY_MARGIN_X_MAX, Math.round(n)))
}

/**
 * 底部安全距离范围（px）。
 *
 * 这是用户报的核心不适感：写作时当前行总贴在窗口最下沿，视线被迫一直在最下面。
 * 默认 51px 是用户确认的值（改造前是写死的 36px，窄屏还有条 28px 覆盖）。
 */
export const BODY_SAFE_BOTTOM_MIN = 0
export const BODY_SAFE_BOTTOM_MAX = 240
export const DEFAULT_BODY_SAFE_BOTTOM = 51

export function clampBodySafeBottom(value: unknown): number {
  const n = toFiniteNumber(value)
  if (n === null) return DEFAULT_BODY_SAFE_BOTTOM
  return Math.max(BODY_SAFE_BOTTOM_MIN, Math.min(BODY_SAFE_BOTTOM_MAX, Math.round(n)))
}

export interface BodyTypographySettings {
  fontPx: number
  lineHeight: number
  letterSpacing: number
  /** null = 跟随窗口，见 clampBodyMarginX 上方说明。 */
  marginX: number | null
  safeBottom: number
}

/**
 * 把 5 个排版参数写到 `documentElement` 的行内样式。
 *
 * ── 变量命名与那条「不能重复声明」的约束 ──
 * 这里写的 5 个变量（--qmai-body-font-px / --qmai-body-leading /
 * --qmai-body-letter-spacing / --qmai-body-margin-x / --qmai-body-safe-bottom）
 * 是**用户值的唯一入口**，`ui-test.css` 里**不得**再为它们声明字面量默认值。
 *
 * 原因：`.ui-test-root` 比 `html` 更靠近正文。若在 `.ui-test-root` 块里也声明
 * 同名变量，就会盖掉这里写的行内样式，表现为「设置保存了但界面不变」。
 * CSS 侧因此一律写成 `var(--qmai-body-xxx, 兜底值)`。
 * （旧代码的 --qmai-body-font-scale 没这个问题，因为字体栈那条读的是
 *   **继承**下来的值，而这里读的是**本元素自己的**声明。）
 *
 * marginX 为 null 时**移除**该属性：留着空字符串同样会盖掉 CSS 的 clamp。
 */
export function applyBodyTypography(settings: BodyTypographySettings, root?: HTMLElement): void {
  if (typeof document === "undefined" && !root) return
  const target = root ?? document.documentElement
  target.style.setProperty("--qmai-body-font-px", `${clampBodyFontPx(settings.fontPx)}px`)
  target.style.setProperty("--qmai-body-leading", String(clampBodyLineHeight(settings.lineHeight)))
  target.style.setProperty("--qmai-body-letter-spacing", `${clampBodyLetterSpacing(settings.letterSpacing)}px`)
  target.style.setProperty("--qmai-body-safe-bottom", `${clampBodySafeBottom(settings.safeBottom)}px`)
  const marginX = clampBodyMarginX(settings.marginX)
  if (marginX === null) target.style.removeProperty("--qmai-body-margin-x")
  else target.style.setProperty("--qmai-body-margin-x", `${marginX}px`)
}
