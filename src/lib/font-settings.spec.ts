// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import {
  BODY_FONT_PX_MAX,
  BODY_FONT_PX_MIN,
  BODY_FONT_PX_PRESETS,
  BODY_LETTER_SPACING_MAX,
  BODY_LETTER_SPACING_MIN,
  BODY_LINE_HEIGHT_MAX,
  BODY_LINE_HEIGHT_MIN,
  BODY_MARGIN_X_MAX,
  BODY_MARGIN_X_MIN,
  BODY_MARGIN_X_VIEWPORT_MAX,
  BODY_MARGIN_X_VIEWPORT_MIN,
  BODY_MARGIN_X_VIEWPORT_VW,
  BODY_SAFE_BOTTOM_MAX,
  BODY_SAFE_BOTTOM_MIN,
  DEFAULT_BODY_FONT_PX,
  DEFAULT_BODY_LETTER_SPACING,
  DEFAULT_BODY_LINE_HEIGHT,
  DEFAULT_BODY_MARGIN_X,
  DEFAULT_BODY_SAFE_BOTTOM,
  LEGACY_BODY_FONT_PX_AT_SCALE_1,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  UI_FONT_SIZE_PRESETS,
  applyBodyTypography,
  bodyFontPxFromScale,
  clampBodyFontPx,
  clampBodyLetterSpacing,
  clampBodyLineHeight,
  clampBodyMarginX,
  clampBodySafeBottom,
  clampUiFontSizeScale,
  defaultBodyMarginXForViewport,
  resolveMigratedBodyFontPx,
} from "./font-settings"

describe("界面字号范围", () => {
  it("范围是 80%–150%（用户确认）", () => {
    expect(UI_FONT_SIZE_MIN).toBe(0.8)
    expect(UI_FONT_SIZE_MAX).toBe(1.5)
  })

  it("钳制到范围内，且不动范围内的值", () => {
    expect(clampUiFontSizeScale(1.5)).toBe(1.5)
    expect(clampUiFontSizeScale(1)).toBe(1)
    expect(clampUiFontSizeScale(0.8)).toBe(0.8)
    // 超出边界
    expect(clampUiFontSizeScale(1.6)).toBe(1.5)
    expect(clampUiFontSizeScale(0.7)).toBe(0.8)
    // 旧上限 1.3 与旧下限 0.85 现在都必须原样保留 —— 这正是过去会被截断的取值
    expect(clampUiFontSizeScale(1.3)).toBe(1.3)
    expect(clampUiFontSizeScale(0.85)).toBe(0.85)
  })

  it("非法输入退回默认档而不是产生 NaN", () => {
    expect(clampUiFontSizeScale(Number.NaN)).toBe(1)
    expect(clampUiFontSizeScale("abc")).toBe(1)
    expect(clampUiFontSizeScale(null)).toBe(1)
    expect(clampUiFontSizeScale(undefined)).toBe(1)
    expect(clampUiFontSizeScale(Number.POSITIVE_INFINITY)).toBe(1)
  })

  it("钳制是幂等的（存 150% 后读回仍是 150%，不会被二次截断）", () => {
    for (const v of [0.8, 0.85, 1, 1.25, 1.3, 1.5]) {
      const once = clampUiFontSizeScale(v)
      expect(clampUiFontSizeScale(once)).toBe(once)
      expect(once).toBe(v)
    }
  })

  it("保留两位小数，避免浮点尾巴", () => {
    expect(clampUiFontSizeScale(1.234)).toBe(1.23)
    expect(clampUiFontSizeScale(1.236)).toBe(1.24)
    expect(clampUiFontSizeScale(1.0001)).toBe(1)
    // 注意：1.005 不能用来测"四舍五入到 1.01" —— 它在二进制里略小于 1.005，
    // toFixed(2) 会得到 "1.00"。这是浮点表示的现实，不是本函数的缺陷，
    // 故此处只用无歧义的取值，避免写出一条会随引擎实现漂移的断言。
  })

  it("预设全部落在范围内且含 150% 特大档", () => {
    expect(UI_FONT_SIZE_PRESETS.map((p) => p.value)).toEqual([0.85, 1, 1.25, 1.5])
    for (const preset of UI_FONT_SIZE_PRESETS) {
      expect(preset.value).toBeGreaterThanOrEqual(UI_FONT_SIZE_MIN)
      expect(preset.value).toBeLessThanOrEqual(UI_FONT_SIZE_MAX)
      // 预设必须能被钳制原样通过，否则选中态永远匹配不上
      expect(clampUiFontSizeScale(preset.value)).toBe(preset.value)
    }
  })
})

describe("正文排版参数", () => {
  it("正文字号范围 12–32px，默认 18px", () => {
    expect(BODY_FONT_PX_MIN).toBe(12)
    expect(BODY_FONT_PX_MAX).toBe(32)
    expect(DEFAULT_BODY_FONT_PX).toBe(18)
  })

  it("正文字号取整并夹到范围内", () => {
    expect(clampBodyFontPx(15)).toBe(15)
    expect(clampBodyFontPx(15.4)).toBe(15)
    expect(clampBodyFontPx(15.6)).toBe(16)
    expect(clampBodyFontPx(1)).toBe(BODY_FONT_PX_MIN)
    expect(clampBodyFontPx(999)).toBe(BODY_FONT_PX_MAX)
    // 关键的不对称：数字 0 是用户真的想要最小字号（→12），
    // 而 bodyFontPxFromScale(0) 是「根本没存过正文倍数」（→18，见那一组用例）。
    // 日后若有人「统一」这两处判断，存储语义会被静默改掉。
    expect(clampBodyFontPx(0)).toBe(BODY_FONT_PX_MIN)
  })

  it("正文字号对无效输入退回默认，而不是被隐式转成 0 再夹到下限", () => {
    // Number(null) === 0，若不特殊处理会得到 12px ——
    // 「没存过值」与「用户要最小字号」是两件事
    expect(clampBodyFontPx(null)).toBe(DEFAULT_BODY_FONT_PX)
    expect(clampBodyFontPx(undefined)).toBe(DEFAULT_BODY_FONT_PX)
    expect(clampBodyFontPx("")).toBe(DEFAULT_BODY_FONT_PX)
    expect(clampBodyFontPx("abc")).toBe(DEFAULT_BODY_FONT_PX)
    expect(clampBodyFontPx(Number.NaN)).toBe(DEFAULT_BODY_FONT_PX)
    // Number("  ") === 0、Number([]) === 0：只特判 "" 是不够的 ——
    // 同一个文件里 clampBodyFontPx("  ") 与 bodyFontPxFromScale("  ")
    // 必须给出同一个答案（默认档），否则存储里的空白串会被读成「最小字号」
    expect(clampBodyFontPx("  ")).toBe(DEFAULT_BODY_FONT_PX)
    expect(clampBodyFontPx([])).toBe(DEFAULT_BODY_FONT_PX)
    // Number(true) === 1 / Number(false) === 0：布尔值同样不是「用户选了值」
    expect(clampBodyFontPx(true)).toBe(DEFAULT_BODY_FONT_PX)
    expect(clampBodyFontPx(false)).toBe(DEFAULT_BODY_FONT_PX)
    // 与迁移函数口径一致（同一输入 → 同一答案）
    expect(bodyFontPxFromScale("  ")).toBe(DEFAULT_BODY_FONT_PX)
    expect(bodyFontPxFromScale([])).toBe(DEFAULT_BODY_FONT_PX)
  })

  it("数字字符串必须照常可用：localStorage 里存的就是 String(number)", () => {
    // 为什么单独立一条：getItem() 返回的永远是字符串。
    // 若某个钳制函数改成只接受 typeof value === "number"，
    // 用户存过的值会被当成"没存过"而悄悄退回默认 ——
    // 界面一切正常，只是设置"不生效"，属于最难发现的那类缺陷。
    // 注意 toFiniteNumber 会先 trim：读取路径上出现带空白的字符串
    // 是有可能的（手改过 app-state.json / 老版本写入格式不同）。
    expect(clampBodyFontPx("18")).toBe(18)
    expect(clampBodyFontPx(" 21 ")).toBe(21)
    expect(clampBodyLineHeight("1.95")).toBe(1.95)
    expect(clampBodyLetterSpacing("2")).toBe(2)
    expect(clampBodyMarginX("40")).toBe(40)
    expect(clampBodySafeBottom("60")).toBe(60)
    // 越界的字符串同样要钳制，而不是原样漏出去
    expect(clampBodyFontPx("999")).toBe(BODY_FONT_PX_MAX)
    expect(clampBodyLineHeight("9")).toBe(BODY_LINE_HEIGHT_MAX)
    // 负数也得能读出来（字间距允许负值）
    expect(clampBodyLetterSpacing("-0.5")).toBe(-0.5)
  })

  it("旧倍数迁移成 px：0.85→15 / 1→18 / 1.25→23 / 1.5→27", () => {
    // 第二参数缺省 = 界面字号 100%，老调用与老语义不变
    expect(bodyFontPxFromScale(0.85)).toBe(15)
    expect(bodyFontPxFromScale(1)).toBe(18)
    expect(bodyFontPxFromScale(1.25)).toBe(23)
    expect(bodyFontPxFromScale(1.5)).toBe(27)
    expect(bodyFontPxFromScale(1, 1)).toBe(18)
    expect(bodyFontPxFromScale(1.5, 1)).toBe(27)
  })

  it("界面字号非 100% 时，迁移必须把它乘进去——否则老用户一升级正文就变小", () => {
    // 改造前正文渲染高度 = 18px × 界面倍数 × 正文倍数：
    //   --qmai-body-font-size: calc(1.125rem * var(--qmai-body-font-scale, 1))
    //   而 rem 的基准是根字号，App 把它设成 uiFontSizeScale×100%。
    // 例：界面 150% + 正文 100% 改造前渲染 27px；只乘正文倍数会得到 18px。
    expect(bodyFontPxFromScale(1, 1.5)).toBe(27)
    // 18 × 0.85 × 1.5 = 22.95 → 23
    expect(bodyFontPxFromScale(0.85, 1.5)).toBe(23)
    // 18 × 1.25 × 1.5 = 33.75 → 被新的 32px 上限钳住。
    // 这是「上限 32px」的既定代价，钉在这里以免日后被当成 bug 顺手改掉。
    expect(bodyFontPxFromScale(1.25, 1.5)).toBe(BODY_FONT_PX_MAX)
    expect(bodyFontPxFromScale(1.5, 1.5)).toBe(BODY_FONT_PX_MAX)
    // 界面字号缩小同理：18 × 1 × 0.85 = 15.3 → 15
    expect(bodyFontPxFromScale(1, 0.85)).toBe(15)
  })

  it("旧倍数迁移对垃圾值不抛错", () => {
    expect(bodyFontPxFromScale(null)).toBe(DEFAULT_BODY_FONT_PX)
    expect(bodyFontPxFromScale("")).toBe(DEFAULT_BODY_FONT_PX)
    expect(bodyFontPxFromScale(0)).toBe(DEFAULT_BODY_FONT_PX)
    expect(bodyFontPxFromScale(-3)).toBe(DEFAULT_BODY_FONT_PX)
    expect(bodyFontPxFromScale(Number.NaN)).toBe(DEFAULT_BODY_FONT_PX)
    expect(bodyFontPxFromScale("  ")).toBe(DEFAULT_BODY_FONT_PX)
    expect(bodyFontPxFromScale([])).toBe(DEFAULT_BODY_FONT_PX)
  })

  it("迁移基准常量是「历史的 18px」，与默认字号数值相同但含义不同", () => {
    // 这两个常量一旦被「去重」成一个，日后改默认字号就会静默改掉迁移结果 ——
    // 所以名字里必须带 LEGACY，并且这里把它单独钉住。
    expect(LEGACY_BODY_FONT_PX_AT_SCALE_1).toBe(18)
  })

  it("字号预设全部是范围内的整数且钳制后原样通过", () => {
    // 若预设值钳制后会变，设置页的「选中态」就永远匹配不上
    expect(BODY_FONT_PX_PRESETS.map((p) => p.value)).toEqual([15, 18, 21, 24])
    for (const preset of BODY_FONT_PX_PRESETS) {
      expect(Number.isInteger(preset.value)).toBe(true)
      expect(clampBodyFontPx(preset.value)).toBe(preset.value)
    }
  })

  it("行间距范围 1.2–2.6，默认 1.95，保留两位小数", () => {
    // 上下限写成字面量：否则 clampBodyLineHeight(1) === BODY_LINE_HEIGHT_MIN
    // 对任何 MIN ≥ 1 都成立，范围被悄悄挪走也不会红
    expect(BODY_LINE_HEIGHT_MIN).toBe(1.2)
    expect(BODY_LINE_HEIGHT_MAX).toBe(2.6)
    expect(DEFAULT_BODY_LINE_HEIGHT).toBe(1.95)
    expect(clampBodyLineHeight(1.95)).toBe(1.95)
    expect(clampBodyLineHeight(1)).toBe(BODY_LINE_HEIGHT_MIN)
    expect(clampBodyLineHeight(9)).toBe(BODY_LINE_HEIGHT_MAX)
    expect(clampBodyLineHeight(1.234)).toBe(1.23)
    expect(clampBodyLineHeight(null)).toBe(DEFAULT_BODY_LINE_HEIGHT)
    expect(clampBodyLineHeight("  ")).toBe(DEFAULT_BODY_LINE_HEIGHT)
    expect(clampBodyLineHeight([])).toBe(DEFAULT_BODY_LINE_HEIGHT)
  })

  it("行间距钳制幂等", () => {
    for (const v of [1.2, 1.5, 1.95, 2.05, 2.6]) {
      const once = clampBodyLineHeight(v)
      expect(clampBodyLineHeight(once)).toBe(once)
    }
  })

  it("字间距范围 -1–6px，默认 0", () => {
    // 字面量下限/上限：只用常量自比的话，把范围整体挪走测试照样绿
    expect(BODY_LETTER_SPACING_MIN).toBe(-1)
    expect(BODY_LETTER_SPACING_MAX).toBe(6)
    expect(DEFAULT_BODY_LETTER_SPACING).toBe(0)
    expect(clampBodyLetterSpacing(0)).toBe(0)
    expect(clampBodyLetterSpacing(-9)).toBe(BODY_LETTER_SPACING_MIN)
    expect(clampBodyLetterSpacing(99)).toBe(BODY_LETTER_SPACING_MAX)
    expect(clampBodyLetterSpacing(0.5)).toBe(0.5)
    expect(clampBodyLetterSpacing(null)).toBe(DEFAULT_BODY_LETTER_SPACING)
    // 注意：字间距的默认值恰好是 0，而 Number("  ") 与 Number([]) 也是 0，
    // 所以下面这两条在"不修"的实现下**同样会绿**（无法证伪）。它们留着是为了
    // 与另外四条钳制保持同一份输入矩阵；真正能证伪的是布尔那条：
    // Number(true) === 1，不修的话会得到 1px 而不是默认的 0。
    expect(clampBodyLetterSpacing("  ")).toBe(DEFAULT_BODY_LETTER_SPACING)
    expect(clampBodyLetterSpacing([])).toBe(DEFAULT_BODY_LETTER_SPACING)
    expect(clampBodyLetterSpacing(true)).toBe(DEFAULT_BODY_LETTER_SPACING)
  })

  it("左右边距 null = 跟随窗口，这是默认值", () => {
    // null 不是"忘了设"，而是一个有意义的取值：让 CSS 的
    // clamp(20px, 4vw, 48px) 生效，老用户打开后界面与改造前逐位相同
    expect(DEFAULT_BODY_MARGIN_X).toBeNull()
    expect(clampBodyMarginX(null)).toBeNull()
    expect(clampBodyMarginX(undefined)).toBeNull()
    expect(clampBodyMarginX("")).toBeNull()
    expect(clampBodyMarginX("abc")).toBeNull()
    // 必须是 null 而不是 0：0 的含义是「把边距钉死在 0」，那是另一个选择
    expect(clampBodyMarginX("  ")).toBeNull()
    expect(clampBodyMarginX([])).toBeNull()
    expect(clampBodyMarginX(true)).toBeNull()
  })

  it("左右边距一旦给了数字就钳到 0–160 并取整", () => {
    // 字面量下限/上限：常量自比无法发现范围被改
    expect(BODY_MARGIN_X_MIN).toBe(0)
    expect(BODY_MARGIN_X_MAX).toBe(160)
    expect(clampBodyMarginX(0)).toBe(0)
    expect(clampBodyMarginX(10)).toBe(10)
    expect(clampBodyMarginX(10.6)).toBe(11)
    expect(clampBodyMarginX(-5)).toBe(BODY_MARGIN_X_MIN)
    expect(clampBodyMarginX(9999)).toBe(BODY_MARGIN_X_MAX)
  })

  it("底部安全距离范围 0–240px，默认 51px", () => {
    // 字面量下限/上限：常量自比无法发现范围被改
    expect(BODY_SAFE_BOTTOM_MIN).toBe(0)
    expect(BODY_SAFE_BOTTOM_MAX).toBe(240)
    expect(DEFAULT_BODY_SAFE_BOTTOM).toBe(51)
    expect(clampBodySafeBottom(51)).toBe(51)
    expect(clampBodySafeBottom(-1)).toBe(BODY_SAFE_BOTTOM_MIN)
    expect(clampBodySafeBottom(9999)).toBe(BODY_SAFE_BOTTOM_MAX)
    expect(clampBodySafeBottom(null)).toBe(DEFAULT_BODY_SAFE_BOTTOM)
    expect(clampBodySafeBottom("  ")).toBe(DEFAULT_BODY_SAFE_BOTTOM)
    expect(clampBodySafeBottom([])).toBe(DEFAULT_BODY_SAFE_BOTTOM)
  })

  it("每个默认值都落在自己的范围内，并且是自己那条钳制的不动点", () => {
    // 守的是一类真实事故：默认值被改到范围外时，store 按默认值初始化，
    // 渲染前 applyBodyTypography 又把它钳回去，于是设置页显示「自定义 · 34px」
    // 而实际渲染 32px —— 正是「设了 150% 下次启动被截成别的值」那一类。
    const ranges = [
      { name: "正文字号", min: BODY_FONT_PX_MIN, max: BODY_FONT_PX_MAX, def: DEFAULT_BODY_FONT_PX, clamp: clampBodyFontPx },
      { name: "行间距", min: BODY_LINE_HEIGHT_MIN, max: BODY_LINE_HEIGHT_MAX, def: DEFAULT_BODY_LINE_HEIGHT, clamp: clampBodyLineHeight },
      { name: "字间距", min: BODY_LETTER_SPACING_MIN, max: BODY_LETTER_SPACING_MAX, def: DEFAULT_BODY_LETTER_SPACING, clamp: clampBodyLetterSpacing },
      { name: "底部安全距离", min: BODY_SAFE_BOTTOM_MIN, max: BODY_SAFE_BOTTOM_MAX, def: DEFAULT_BODY_SAFE_BOTTOM, clamp: clampBodySafeBottom },
    ]
    for (const range of ranges) {
      expect(range.min, `${range.name} 的下限大于默认值`).toBeLessThanOrEqual(range.def)
      expect(range.def, `${range.name} 的默认值大于上限`).toBeLessThanOrEqual(range.max)
      expect(range.clamp(range.def), `${range.name} 的默认值不是自身钳制的不动点`).toBe(range.def)
    }
    // 第五条范围（左右边距）的默认值是 null = 跟随窗口，
    // 它的不变量是「钳制后仍然是 null」，而不是等于某个数
    expect(clampBodyMarginX(DEFAULT_BODY_MARGIN_X)).toBeNull()
  })

  it("「跟随窗口」的 CSS 兜底范围 clamp(20px, 4vw, 48px) 收在单一来源里", () => {
    // 任务 8 的滑块停靠位置、任务 12 对 ui-test-editor.css 的静态守卫
    // 都引用这三个数；各抄一份就会出现第七处「两处定义的范围」。
    expect(BODY_MARGIN_X_VIEWPORT_MIN).toBe(20)
    expect(BODY_MARGIN_X_VIEWPORT_VW).toBe(4)
    expect(BODY_MARGIN_X_VIEWPORT_MAX).toBe(48)
  })

  it("defaultBodyMarginXForViewport 复现 clamp(20px, 4vw, 48px) 的取值", () => {
    // 4vw = 16 → 夹到下限
    expect(defaultBodyMarginXForViewport(400)).toBe(20)
    // 4vw = 40 → 区间内
    expect(defaultBodyMarginXForViewport(1000)).toBe(40)
    // 4vw = 80 → 夹到上限
    expect(defaultBodyMarginXForViewport(2000)).toBe(48)
    // 边界要真的落在 clamp 的拐点上：500 × 4% = 20（正好下限），1200 × 4% = 48（正好上限）
    expect(defaultBodyMarginXForViewport(500)).toBe(20)
    expect(defaultBodyMarginXForViewport(1200)).toBe(48)
    // 取整：900 × 4% = 36
    expect(defaultBodyMarginXForViewport(900)).toBe(36)
    expect(Number.isInteger(defaultBodyMarginXForViewport(913))).toBe(true)
  })

  it("defaultBodyMarginXForViewport 对非法宽度给下限，而不是 0", () => {
    // 0 会被读成「边距被设成了 0」，而实际正文仍有 20–48px 的间距 ——
    // 显示 0 就是界面在说谎。非法宽度下给下限最接近真实渲染。
    expect(defaultBodyMarginXForViewport(0)).toBe(BODY_MARGIN_X_VIEWPORT_MIN)
    expect(defaultBodyMarginXForViewport(-5)).toBe(BODY_MARGIN_X_VIEWPORT_MIN)
    expect(defaultBodyMarginXForViewport("abc")).toBe(BODY_MARGIN_X_VIEWPORT_MIN)
    expect(defaultBodyMarginXForViewport(Number.NaN)).toBe(BODY_MARGIN_X_VIEWPORT_MIN)
    expect(defaultBodyMarginXForViewport([])).toBe(BODY_MARGIN_X_VIEWPORT_MIN)
    expect(defaultBodyMarginXForViewport(null)).toBe(BODY_MARGIN_X_VIEWPORT_MIN)
    expect(defaultBodyMarginXForViewport(undefined)).toBe(BODY_MARGIN_X_VIEWPORT_MIN)
    expect(defaultBodyMarginXForViewport(Number.POSITIVE_INFINITY)).toBe(BODY_MARGIN_X_VIEWPORT_MIN)
    // 数字字符串可用（localStorage 里存的是 String(number)）
    expect(defaultBodyMarginXForViewport("1000")).toBe(40)
  })
})

describe("resolveMigratedBodyFontPx 决定升级后第一次读正文字号", () => {
  it("存过旧倍数：把它乘入界面字号后迁移（与 bodyFontPxFromScale 同一条公式）", () => {
    expect(resolveMigratedBodyFontPx(1, 1)).toBe(18)
    expect(resolveMigratedBodyFontPx(1, 1.5)).toBe(27)
    expect(resolveMigratedBodyFontPx(1.25, 1.5)).toBe(BODY_FONT_PX_MAX)
    expect(resolveMigratedBodyFontPx(0.85, 1)).toBe(15)
  })

  it("没存过旧倍数、界面字号非默认：按界面字号补种，否则正文会凭空变小", () => {
    // 改造前 18px 也被界面字号放大着（rem 基准是根字号），
    // 这里若不补种，界面 150% 的用户升级后会从 27px 掉到 store 默认 18px。
    expect(resolveMigratedBodyFontPx(null, 1.5)).toBe(27)
    expect(resolveMigratedBodyFontPx(undefined, 1.5)).toBe(27)
    expect(resolveMigratedBodyFontPx("", 1.5)).toBe(27)
    // 补种值与「旧倍数 = 1」的迁移结果必须是同一个数（单一来源，不各写一份）
    expect(resolveMigratedBodyFontPx(null, 1.5)).toBe(bodyFontPxFromScale(1, 1.5))
    // 18 × 1.25 = 22.5 → 23
    expect(resolveMigratedBodyFontPx(null, 1.25)).toBe(23)
    // 垃圾值（0 / 负数 / 空格串 / 数组 / 布尔）等同于「没存过」，
    // 不能当成「用户选了最小倍数」而在界面 150% 时补种出一个 12px
    expect(resolveMigratedBodyFontPx(0, 1.5)).toBe(27)
    expect(resolveMigratedBodyFontPx(-3, 1.5)).toBe(27)
    expect(resolveMigratedBodyFontPx("  ", 1.5)).toBe(27)
    expect(resolveMigratedBodyFontPx([], 1.5)).toBe(27)
    expect(resolveMigratedBodyFontPx(true, 1.5)).toBe(27)
  })

  it("没存过、界面字号为 1：返回 null，不写值（让「未设置」保持未设置）", () => {
    // 此时补种的值恰好等于默认值，写它没有任何意义，只会把「未设置」变成「设成了 18」
    expect(resolveMigratedBodyFontPx(null, 1)).toBeNull()
    expect(resolveMigratedBodyFontPx(undefined, undefined)).toBeNull()
    expect(resolveMigratedBodyFontPx("", 1)).toBeNull()
    expect(resolveMigratedBodyFontPx("  ", 1)).toBeNull()
    expect(resolveMigratedBodyFontPx([], 1)).toBeNull()
    expect(resolveMigratedBodyFontPx(0, 1)).toBeNull()
  })

  it("界面字号越界时先钳进 80%–150% 再补种，结果不会跑出字号范围", () => {
    expect(resolveMigratedBodyFontPx(null, 9)).toBe(27)
    expect(resolveMigratedBodyFontPx(1, 9)).toBe(27)
    expect(resolveMigratedBodyFontPx(null, 0.1)).toBe(14) // 钳到 0.8 → 18 × 0.8 = 14.4 → 14
  })
})

describe("applyBodyTypography 写 CSS 变量", () => {
  function makeRoot() {
    const el = document.createElement("div")
    return el
  }

  it("五行变量一次写齐，字号与两处 px 值带单位", () => {
    const root = makeRoot()
    applyBodyTypography(
      { fontPx: 15, lineHeight: 2.1, letterSpacing: 0.5, marginX: 40, safeBottom: 80 },
      root,
    )
    expect(root.style.getPropertyValue("--qmai-body-font-px")).toBe("15px")
    expect(root.style.getPropertyValue("--qmai-body-leading")).toBe("2.1")
    expect(root.style.getPropertyValue("--qmai-body-letter-spacing")).toBe("0.5px")
    expect(root.style.getPropertyValue("--qmai-body-margin-x")).toBe("40px")
    expect(root.style.getPropertyValue("--qmai-body-safe-bottom")).toBe("80px")
  })

  it("marginX 为 null 时移除该属性，让 CSS 兜底生效", () => {
    const root = makeRoot()
    applyBodyTypography({ fontPx: 15, lineHeight: 1.95, letterSpacing: 0, marginX: 40, safeBottom: 51 }, root)
    expect(root.style.getPropertyValue("--qmai-body-margin-x")).toBe("40px")
    applyBodyTypography({ fontPx: 15, lineHeight: 1.95, letterSpacing: 0, marginX: null, safeBottom: 51 }, root)
    // 留着空字符串也会盖掉 CSS 的 clamp，必须是彻底移除
    expect(root.style.getPropertyValue("--qmai-body-margin-x")).toBe("")
  })

  it("行高不带单位（带了 px 会让行高不随字号变化）", () => {
    const root = makeRoot()
    applyBodyTypography({ fontPx: 18, lineHeight: 1.95, letterSpacing: 0, marginX: null, safeBottom: 51 }, root)
    expect(root.style.getPropertyValue("--qmai-body-leading")).not.toMatch(/px/)
  })

  it("不传 root 时写的是 documentElement（生产路径，必须真跑一次）", () => {
    // 之前每条用例都传了一个游离的 div，于是「不传 root」这条分支
    // （以及 typeof document === "undefined" 的守卫）从来没被跑过。
    const root = document.documentElement
    const props = [
      "--qmai-body-font-px",
      "--qmai-body-leading",
      "--qmai-body-letter-spacing",
      "--qmai-body-margin-x",
      "--qmai-body-safe-bottom",
    ]
    try {
      // 先留一个脏值，确认 marginX=null 时是「移除」而不是「没写过」
      root.style.setProperty("--qmai-body-margin-x", "40px")
      applyBodyTypography({ fontPx: 21, lineHeight: 2.05, letterSpacing: 0.5, marginX: null, safeBottom: 80 })
      expect(root.style.getPropertyValue("--qmai-body-font-px")).toBe("21px")
      expect(root.style.getPropertyValue("--qmai-body-leading")).toBe("2.05")
      expect(root.style.getPropertyValue("--qmai-body-letter-spacing")).toBe("0.5px")
      expect(root.style.getPropertyValue("--qmai-body-safe-bottom")).toBe("80px")
      expect(root.style.getPropertyValue("--qmai-body-margin-x")).toBe("")
    } finally {
      // documentElement 是跨用例共享的，写进去的变量必须清干净，否则会泄漏到别的用例
      for (const prop of props) root.style.removeProperty(prop)
      expect(root.style.getPropertyValue("--qmai-body-font-px")).toBe("")
    }
  })
})
