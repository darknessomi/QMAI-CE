// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import postcss from "postcss"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  BodyTypographyFields,
  type BodyTypographyValue,
} from "@/components/settings/sections/body-typography-fields"
// 兜底边距不在这里定义，它和其余范围常量同住 font-settings（单一来源）。
// 本文件测的是"控件用了它"，不是"它算得对"——后者已在任务 1 的
// font-settings.spec.ts 里测过，不要在这里再抄一遍期望值。
import {
  BODY_FONT_PX_MAX,
  BODY_FONT_PX_MIN,
  BODY_LETTER_SPACING_MAX,
  BODY_LETTER_SPACING_MIN,
  BODY_LINE_HEIGHT_MAX,
  BODY_LINE_HEIGHT_MIN,
  BODY_MARGIN_X_MAX,
  BODY_MARGIN_X_MIN,
  BODY_SAFE_BOTTOM_MAX,
  BODY_SAFE_BOTTOM_MIN,
  defaultBodyMarginXForViewport,
} from "@/lib/font-settings"

/*
 * React 19 需要这个全局，act(...) 才会正常工作且不刷警告。
 * 同目录另外四个手写 createRoot+act 的 spec 都设了它
 * （data-management-section / user-memory-section / interface-section /
 *  uitest/ui-test-tools），这个文件原先漏了 —— 每条用例都会往 stderr 打
 * `The current testing environment is not configured to support act(...)`。
 */
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const BASE: BodyTypographyValue = {
  fontPx: 18,
  lineHeight: 1.95,
  letterSpacing: 0,
  marginX: null,
  safeBottom: 51,
}

/*
 * 这个回调类型必须与控件 prop 上的**泛型**签名同形。
 *
 * 不能写成 `onChange = () => {}` 让 TS 自己推断 —— 那样推断出来的是
 * `() => void`，于是每个 `render(BASE, (key, next) => …)` 都会变成
 * 「目标签名参数太少」的类型错误，而且 `key` / `next` 会落到隐式 any。
 */
type ChangeHandler = <K extends keyof BodyTypographyValue>(
  key: K,
  next: BodyTypographyValue[K],
) => void

function render(value: BodyTypographyValue, onChange: ChangeHandler = () => {}) {
  act(() => {
    root.render(<BodyTypographyFields value={value} onChange={onChange} idPrefix="t" />)
  })
  return container
}

function input(label: string) {
  const el = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!el) throw new Error(`找不到控件：${label}`)
  return el
}

/** jsdom 下的 React onChange：必须用原生 setter 再派发 input 事件。 */
function setRange(el: HTMLInputElement, next: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
  setter?.call(el, next)
  act(() => { el.dispatchEvent(new window.Event("input", { bubbles: true })) })
}

const SLIDER_LABELS = ["正文字号", "行间距", "字间距", "左右边距", "底部安全距离"] as const
const ALL_CONTROL_LABELS = ["正文字号预设", "正文字号", "行间距", "字间距", "左右边距", "底部安全距离"] as const

// 注意：这里不再单独测「兜底边距算得对不对」—— 那是 font-settings 的
// 职责，已在任务 1 的 font-settings.spec.ts 里用字面量钉住。
// 本文件只负责证明「控件用的确实是那一个来源」。

describe("BodyTypographyFields", () => {
  it("5 个参数各有一个可访问的控件，标签互不重复", () => {
    render(BASE)
    for (const label of ALL_CONTROL_LABELS) {
      const found = container.querySelectorAll(`[aria-label="${label}"]`)
      // ① 存在性
      expect(found.length, `缺少控件：${label}`).toBeGreaterThan(0)
      /*
       * ② 唯一性 —— 标题承诺的"互不重复"。
       * 原稿只做 querySelector + not.toBeNull()，那是**只查存在性**：
       * 变异验证实测（M11b：把 aria-label="正文字体" 也挂到根 div 上，
       * 7 个标签一个不少），8 条用例**全绿** —— 重复完全抓不住。
       * 重复的 aria-label 会让读屏用户听到两个同名控件、也让测试的
       * 选择器变得不确定，所以这条补上。
       */
      expect(found.length, `标签重复：${label} 匹配到 ${found.length} 个元素`).toBe(1)
    }
  })

  /**
   * ── 首帧即有样式（用户报的"刚开始没有美感，等一会儿才有边框"）──
   *
   * 这一条替换了原先的「根元素保留 data-ui="interface-fields"」。
   *
   * 那一条守的是"控件能借到设置页那套样式"，而**那正是缺陷本身**：
   * `ui-test-tools.css` 只被路由级懒 chunk 加载，浮层路径拿不到它，
   * 于是浮层先无样式渲染、稍后才跳成两列。
   * 所以旧判据不仅没抓住缺陷，还把缺陷固化成契约
   * （按它的要求去改，只会一直维持"借用懒加载样式"这个错误结构）。
   *
   * 新判据直接钉住修法本身，四件事缺一不可：
   *   ① 浮层样式有独立的 CSS 文件，且定义了组件真正渲染的那些类名；
   *   ② 渲染浮层的模块**静态** import 它（不是动态 import、不是懒加载）；
   *   ③ 组件与那份 CSS 都**不再**提 `interface-fields`（不再回借懒加载样式）；
   *   ④ 组件确实渲染了那些类名（否则 CSS 定义了也没用）。
   * 实测根因见 .codex-temp/probe-popover-fouc.mjs。
   */
  it("浮层样式与渲染它的模块同生共死——不再依赖懒加载 chunk（首帧即有样式）", () => {
    const cssPath = resolve(__dirname, "../../layout/body-font-popover.css")
    const previewPath = resolve(__dirname, "../../layout/preview-panel.tsx")
    const componentPath = resolve(__dirname, "body-typography-fields.tsx")

    expect(existsSync(cssPath), "浮层应当有自己的样式文件 body-font-popover.css").toBe(true)
    const css = readFileSync(cssPath, "utf8")
    const previewSource = readFileSync(previewPath, "utf8")
    const componentSource = readFileSync(componentPath, "utf8")

    /*
     * ⚠ 判据必须落在**代码**上，不是散文上。
     *
     * 下面两条断言都要用文本匹配，而这两个源文件里到处在解释"为什么不能再
     * 借用 interface-fields 那套懒加载样式"、preview-panel 顶部的 import
     * 注释里还**原样写着**那行 import —— 直接对原文断言，会因为我自己的
     * 说明文字而报红，而真正的问题（属性被加回去 / import 被改成懒加载）
     * 反倒看不出区别。这正是本仓库已经吃过一次的亏（见 eb59957 里
     * chrome-pin 守卫被自己的注释骗过那一例）。
     */
    const stripComments = (src: string) =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, "")     // 块注释（含 JSDoc）
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1") // 行注释；[^:] 避开 http:// 这类前缀

    /*
     * 先给 stripComments 本身做反向控制：它不能把**真代码**也一起吃掉。
     * 造一段带该属性的真样式喂进去，必须仍能被找到 ——
     * 否则后面两条 not.toContain 可能只是"清洗过度"造成的恒真。
     */
    expect(
      stripComments('.x[data-ui="interface-fields"] { color: red } /* interface-fields */'),
      "反向控制：清洗只该去掉注释，真代码必须留下",
    ).toContain("interface-fields")
    expect(
      stripComments('/* import "./body-font-popover.css" */\nconst a = 1'),
      "反向控制：被注释掉的 import 必须被清掉，否则第 ② 条没有鉴别力",
    ).not.toContain("body-font-popover.css")

    // ① CSS 必须定义组件渲染的每一个类名（少一个就是"没上样式"）
    for (const cls of [
      ".body-font-popover",
      ".body-font-popover__head",
      ".body-font-popover__title",
      ".body-font-popover__action",
      ".body-font-fields",
      ".body-font-field",
      ".body-font-field__label",
      ".body-font-field__value",
      ".body-font-field__select",
      ".body-font-field__range",
    ]) {
      expect(css, `body-font-popover.css 里缺少 ${cls} 的样式`).toContain(cls)
    }

    // ② 静态 import —— 这是"同生共死"的机制本身
    expect(
      stripComments(previewSource),
      'preview-panel.tsx 必须**静态** import "./body-font-popover.css"：'
      + "浮层与样式同属一个 chunk，才能保证浮层一渲染样式就已生效",
    ).toContain('import "./body-font-popover.css"')
    // 反向控制：不许改成动态 import（那会把懒加载这个成因原样搬回来）
    expect(
      stripComments(previewSource),
      "不许动态 import 浮层样式 —— 那就等于把「首帧无样式」的成因搬了回来",
    ).not.toContain('import("./body-font-popover.css")')

    // ③ 两边都不许再提 interface-fields（它是懒加载样式表的入口属性）
    expect(
      stripComments(componentSource),
      '组件代码里不该再有 interface-fields —— 那是设置页懒加载样式的入口属性',
    ).not.toContain("interface-fields")
    expect(
      stripComments(css),
      "浮层自己的 CSS 不该去借 interface-fields 的后代选择器",
    ).not.toContain("interface-fields")

    // ④ 组件真的渲染了这些类名（CSS 定义了但没人用等于没接上）
    render(BASE)
    for (const cls of ["body-font-fields", "body-font-field", "body-font-field__label", "body-font-field__value", "body-font-field__range"]) {
      expect(container.querySelector(`.${cls}`), `组件没有渲染 .${cls}`).not.toBeNull()
    }
    expect(container.querySelector(".body-font-field__select"), "组件没有渲染 .body-font-field__select").not.toBeNull()
  })

  /**
   * ── 浮层字体必须钉在界面层，不许继承正文字体 ──
   *
   * 这个浮层是 `position: fixed` 的**界面**元素，但它渲染在
   * `.ui-test-editor-body` 里面 —— 那个容器把 `--body-font` 派生成了
   * 用户选的正文字体（'sys:LXGW WenKai' 这种）。
   * 于是浮层里任何一行**没写 font-family** 的文字都会继承正文字体：
   * 用户把正文换成霞鹜文楷，浮层里的「行间距」标签也跟着变成手写体。
   *
   * 这不是假想 —— 上一轮就在同类位置栽过：查找条的计数 `<span>`
   * 因为不在 `button,input,textarea,select` 兜底里而静默继承了正文字体
   * （见 ui-test-editor.spec.tsx 的 KNOWN_IN_BODY_CHROME，那条守的是
   * **别的**文件里的浮层）。
   *
   * ── 为什么用 postcss 而不是文本正则 ──
   * 这个 CSS 文件的注释里反复出现 `var(--body-font)`、`var(--ui)` 这些字样
   * （就在解释"为什么必须钉住"）。对原文跑正则会**被自己的注释骗到**，
   * 上一轮的 chrome-pin 守卫就是这么漏掉一次变异的（M2）。
   * postcss 把注释和声明分开了，`decl.value` 里永远不会出现注释。
   */
  it("浮层里每一处字体声明都钉在 var(--ui)，绝不继承正文字体", () => {
    const css = readFileSync(resolve(__dirname, "../../layout/body-font-popover.css"), "utf8")
    const parsed = postcss.parse(css)

    /** 判断一条规则是不是"把字体带到界面层"。 */
    const isFontDecl = (decl: postcss.Declaration) =>
      decl.prop === "font" || decl.prop === "font-family"
    /** 简写 `font:` 里只有 `font:` 能带 family；`font-size` 等不算。 */
    const fontDecls: postcss.Declaration[] = []
    parsed.walkDecls((decl) => { if (isFontDecl(decl)) fontDecls.push(decl) })

    /*
     * ⚠ 光判"所有字体声明都钉住了 var(--ui)"是不够的 —— 它漏掉**把声明整个删掉**。
     *
     * 变异验证实测（M2b：删掉 .body-font-field__label 的 font 声明），
     * 只判 value 的版本**照样全绿**：少一条声明就没有 value 可判，
     * 而"条数 ≥ 6"那种计数式底线也拦不住（删一条还剩 6 条）。
     * 后果恰恰是最严重的那种：那一行静默继承 .ui-test-editor-body 的
     * `--body-font`，用户改正文字体时浮层里的标签跟着变字形。
     *
     * 所以必须**逐个点名**：这些类渲染的都是界面文字，各自都得有一条
     * 钉住 var(--ui) 的字体声明，一个都不能靠继承。
     */
    const MUST_PIN = [
      ".body-font-popover",
      ".body-font-popover__title",
      ".body-font-popover__action",
      ".body-font-field__label",
      ".body-font-field__value",
      ".body-font-field__select",
      ".body-font-popover__error",
    ]
    for (const sel of MUST_PIN) {
      const rule = [...parsed.nodes].find(
        (n): n is postcss.Rule => n.type === "rule" && n.selector.trim() === sel,
      )
      expect(rule, `body-font-popover.css 里找不到 ${sel} 的规则`).toBeDefined()
      const own: postcss.Declaration[] = []
      rule!.walkDecls((d) => { if (isFontDecl(d)) own.push(d) })
      expect(
        own.length,
        `${sel} 没有任何字体声明 —— 它会继承正文字体（用户改正文字体时跟着变）`,
      ).toBeGreaterThan(0)
      expect(
        own.some((d) => d.value.includes("var(--ui)")),
        `${sel} 的字体声明没有钉住 var(--ui)`,
      ).toBe(true)
    }

    // 前提检查：一条字体声明都没有的话，下面的 for 是空转的（恒真判据）
    expect(
      fontDecls.length,
      "浮层 CSS 里一条字体声明都没有 —— 那说明文字会全部继承正文字体，且这条判据恒真",
    ).toBeGreaterThanOrEqual(6)

    for (const decl of fontDecls) {
      expect(
        decl.value,
        `${decl.prop} 没有钉住界面字体：${decl.value}`,
      ).toContain("var(--ui)")
      // 反向：绝不能引用正文字体那一族变量
      expect(
        decl.value,
        `${decl.prop} 引用了正文字体变量 —— 改正文字体时浮层会跟着变`,
      ).not.toMatch(/--body-font|--qmai-body-font/)
    }

    /*
     * 反向控制：判定必须能识破"没钉住"的声明，否则它可能恒真。
     * 两个反例都**真的过一遍 postcss**，而不是在字符串上做假设 ——
     * 这正是上面被注释骗到的根因。
     */
    const pinsUi = (src: string) => {
      const root = postcss.parse(src)
      const decls: postcss.Declaration[] = []
      root.walkDecls((d) => { if (isFontDecl(d)) decls.push(d) })
      return decls.length > 0 && decls.every((d) => d.value.includes("var(--ui)"))
    }
    expect(pinsUi(".a { font-family: var(--body-font); }"), "反例①：钉到正文字体必须被判为未钉住").toBe(false)
    expect(pinsUi("/* font-family: var(--ui) */ .a { font-size: 12px; }"), "反例②：注释里写了不算，且没有字体声明时不得判为已钉住").toBe(false)
    expect(pinsUi(".a { font: 400 13px/1.5 var(--ui); }"), "反例③：简写形式必须被判为已钉住（不许误报）").toBe(true)
  })

  /**
   * 面板必须保持紧凑：不渲染任何说明段落。
   *
   * 这一条替换了原先的「dense 模式省掉说明段落」。
   * `dense` 之所以被删掉：那个 prop 存在的唯一理由是"设置页要显示说明、
   * 写作现场浮层不要"，而用户已要求把这 6 项从设置页移除 ——
   * 于是非紧凑分支成了永远走不到的死代码，留着它只会让下一个人
   * 以为还有第二个消费方。判据本身没弱化，"面板里没有说明段落"
   * 这条不变量照旧，只是换了个不含死开关的表达。
   */
  it("面板保持紧凑：不渲染任何说明段落，但 6 个控件一个不少", () => {
    render(BASE)
    expect(
      container.querySelectorAll("p").length,
      "浮层里不该有说明段落（用户要求紧凑、有美感）",
    ).toBe(0)

    for (const label of ALL_CONTROL_LABELS) {
      expect(container.querySelector(`[aria-label="${label}"]`), `缺少控件：${label}`).not.toBeNull()
    }
    // 显示值那一行不能被当成"说明段落"一起省掉，否则用户拖动时看不到当前值
    expect(container.querySelector('[data-ui-typography-value="左右边距"]')?.textContent).toBe("跟随窗口")
  })

  /**
   * 数值必须显示在滑块的**左侧**（用户第 2 条要求）。
   *
   * 断言的是 **DOM 顺序**而不是 CSS —— 顺序决定了读屏顺序与
   * tab 顺序，也是"左/上"这个视觉关系在无样式时的兜底形态；
   * 只断言 CSS 的 grid-column 会漏掉"DOM 里数值在滑块后面"这种错法。
   */
  it("每一行的当前值都排在滑块之前（显示在滑块左侧，不是上方）", () => {
    render(BASE)
    for (const label of SLIDER_LABELS) {
      const valueEl = container.querySelector(`[data-ui-typography-value="${label}"]`)
      expect(valueEl, `缺少「${label}」的显示值`).not.toBeNull()
      const rangeEl = input(label)
      const relation = valueEl!.compareDocumentPosition(rangeEl)
      expect(
        (relation & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        `「${label}」的数值必须排在滑块之前（用户要求显示在滑块左侧）`,
      ).toBe(true)
    }
    // 三列轨道由 CSS 给；这里钉住"固定轨道"这个机制，否则跨行不会对齐
    const css = readFileSync(resolve(__dirname, "../../layout/body-font-popover.css"), "utf8")
    expect(css, "数值列必须是固定轨道，否则六行的数字与滑块对不齐").toMatch(
      /\.body-font-fields\s*\{[^}]*grid-template-columns:\s*[\d.]+em\s+[\d.]+em\s+minmax\(0,\s*1fr\)/,
    )
  })

  /**
   * 「底部安全距离」必须单行显示，且排在最后一个（用户第 3 条要求）。
   *
   * 两件事都要断言：
   *   · DOM 顺序 —— 它是最后一个字段（截图里它跑到中间去了）；
   *   · CSS nowrap —— 它是六个标签里唯一的长标签（6 个字），
   *     窄面板下会折成两行（用户截图里的「底部安全 / 距离」）。
   *     只改顺序不改 nowrap 的话，折行照旧。
   */
  it("底部安全距离标签单行显示，且排在所有字段的最后", () => {
    render(BASE)
    const fields = Array.from(container.querySelectorAll(".body-font-field"))
    expect(fields.length, "应有 5 个字段").toBe(5)
    const lastLabel = fields[fields.length - 1].querySelector(".body-font-field__label")?.textContent
    expect(lastLabel, "最后一个字段必须是底部安全距离").toBe("底部安全距离")

    const css = readFileSync(resolve(__dirname, "../../layout/body-font-popover.css"), "utf8")
    const labelRule = css.match(/\.body-font-field__label\s*\{[^}]*\}/)
    expect(labelRule, "找不到 .body-font-field__label 的样式块").not.toBeNull()
    expect(
      labelRule![0],
      "标签必须 white-space: nowrap —— 否则「底部安全距离」在窄面板里会折成两行",
    ).toContain("white-space: nowrap")
    // 轨道宽度必须容得下 6 个汉字（1em/字），否则 nowrap 会变成溢出
    const track = css.match(/grid-template-columns:\s*([\d.]+)em\s+[\d.]+em\s+minmax\(0,\s*1fr\)/)
    expect(track, "找不到三列轨道定义").not.toBeNull()
    expect(
      Number(track![1]),
      `标签列 ${track![1]}em 容不下 6 个汉字的「底部安全距离」（需要 ≥ 6em）`,
    ).toBeGreaterThanOrEqual(6)
  })

  it("6 个滑块的范围与单一来源常量一致（不在组件里重写数字）", () => {
    render(BASE)
    const cases: [string, string, string][] = [
      ["正文字号", String(BODY_FONT_PX_MIN), String(BODY_FONT_PX_MAX)],
      ["行间距", String(BODY_LINE_HEIGHT_MIN), String(BODY_LINE_HEIGHT_MAX)],
      ["字间距", String(BODY_LETTER_SPACING_MIN), String(BODY_LETTER_SPACING_MAX)],
      ["左右边距", String(BODY_MARGIN_X_MIN), String(BODY_MARGIN_X_MAX)],
      ["底部安全距离", String(BODY_SAFE_BOTTOM_MIN), String(BODY_SAFE_BOTTOM_MAX)],
    ]
    for (const [label, min, max] of cases) {
      const el = input(label)
      expect(el.min, label).toBe(min)
      expect(el.max, label).toBe(max)
    }

    /*
     * 光比属性值还不够 —— 上面那一段只能抓住"常量本身被改了"，
     * 抓不住标题承诺的"不在组件里重写数字"：
     * 把 min={BODY_LINE_HEIGHT_MIN} 改成 min={1.2} 时，
     * 只要 1.2 恰好等于 BODY_LINE_HEIGHT_MIN，属性比较照样通过。
     * 所以再补一条源码文本守卫：这个组件里不许出现字面量 min=/max=。
     */
    const source = readFileSync(resolve(__dirname, "body-typography-fields.tsx"), "utf8")
    for (const [prop, constName] of [
      ["min", "BODY_FONT_PX_MIN"], ["max", "BODY_FONT_PX_MAX"],
      ["min", "BODY_LINE_HEIGHT_MIN"], ["max", "BODY_LINE_HEIGHT_MAX"],
      ["min", "BODY_LETTER_SPACING_MIN"], ["max", "BODY_LETTER_SPACING_MAX"],
      ["min", "BODY_MARGIN_X_MIN"], ["max", "BODY_MARGIN_X_MAX"],
      ["min", "BODY_SAFE_BOTTOM_MIN"], ["max", "BODY_SAFE_BOTTOM_MAX"],
    ]) {
      expect(source, `范围必须引用 ${constName} 而不是写字面量`).toContain(`${prop}={${constName}}`)
    }
  })

  it("拖动滑块把新值交给调用方，且只交自己那一个键", () => {
    const seen: [string, unknown][] = []
    render(BASE, (key, next) => { seen.push([key, next]) })
    /*
     * 五个滑块必须**逐个**拖一遍。
     * 只挑两个测的话，把 onChange("letterSpacing", next) 误写成
     * onChange("fontPx", next) 这种串味不会被任何断言抓住 ——
     * 而"串味"正是这类"一个 onChange 按 key 分发"的写法最容易犯的错。
     */
    const drags: [string, string, string, unknown][] = [
      ["正文字号", "22", "fontPx", 22],
      ["行间距", "2.2", "lineHeight", 2.2],
      ["字间距", "1.5", "letterSpacing", 1.5],
      ["左右边距", "60", "marginX", 60],
      ["底部安全距离", "120", "safeBottom", 120],
    ]
    for (const [label, raw, key, want] of drags) {
      seen.length = 0
      setRange(input(label), raw)
      expect(seen, `拖「${label}」应只交 ${key} 一个键`).toEqual([[key, want]])
    }
  })

  /**
   * 左右边距的 null 语义，以及「改回跟随窗口」按钮**已被删除**。
   *
   * 这条替换了原先的「提供按钮切回 null」。用户明确要求删掉那个按钮，
   * 所以这里**反向**断言它不存在 —— 把"删掉"这件事变成会红的判据，
   * 否则下一个人加回来（或漏删）不会有任何提示。
   *
   * 连带的能力收缩（真实存在，必须记下来）：
   *   `marginX` 回到 `null`（跟随窗口）现在只有一条路 —— 标题栏的
   *   「默认设置」，它会把 6 项一起复位（其中 marginX 的默认值就是 null）。
   *   于是"只把左右边距改回跟随窗口、其余不变"这个动作**不再可能**。
   *   这不是疏漏，是删除该按钮的直接后果，已记入交付说明。
   */
  it("左右边距的 null 显示为「跟随窗口」，且「改回跟随窗口」按钮已删除", () => {
    const marginDisplay = () => {
      const el = container.querySelector('[data-ui-typography-value="左右边距"]')
      if (!el) throw new Error("找不到左右边距的显示值")
      return el.textContent
    }

    // ① 非 null：显示具体像素值（不是「跟随窗口」），且渲染本身不发出任何改动
    const seen: [string, unknown][] = []
    render({ ...BASE, marginX: 40 }, (key, next) => { seen.push([key, next]) })
    expect(marginDisplay()).toBe("40px")
    expect(seen, "仅仅渲染不该产生任何改动").toEqual([])

    // ② null：显示「跟随窗口」
    render({ ...BASE, marginX: null })
    expect(marginDisplay()).toBe("跟随窗口")

    // ③ 按钮必须不存在 —— 用户第 5 条要求（"改回跟随窗口删除了"）
    expect(
      container.querySelector('[aria-label="左右边距跟随窗口"]'),
      "「改回跟随窗口」按钮必须已删除（用户明确要求）",
    ).toBeNull()
    expect(
      container.textContent,
      "面板里不该再出现「改回跟随窗口」字样",
    ).not.toContain("改回跟随窗口")

    // ④ 反向控制：断言机制本身要有鉴别力 —— 造一个"按钮还在"的 DOM，
    //    同一个选择器必须能命中它，否则 ③ 可能是恒真的。
    const probe = document.createElement("button")
    probe.setAttribute("aria-label", "左右边距跟随窗口")
    container.appendChild(probe)
    expect(
      container.querySelector('[aria-label="左右边距跟随窗口"]'),
      "反向控制：选择器必须能命中真实存在的按钮，否则上面那条断言没有鉴别力",
    ).not.toBeNull()
    probe.remove()
  })

  it("左右边距为 null 时，滑块停在当前真正生效的位置", () => {
    render(BASE)
    // BASE.marginX 是 null：滑块不能显示 0，那会让用户以为边距被设成了 0
    expect(input("左右边距").value).toBe(String(defaultBodyMarginXForViewport(window.innerWidth)))
  })

  it("字号下拉的预设来自单一来源，且选中态能匹配上", () => {
    render({ ...BASE, fontPx: 21 })
    const select = container.querySelector<HTMLSelectElement>('[aria-label="正文字号预设"]')
    expect(select).not.toBeNull()
    expect(select?.value).toBe("21")
  })
})
