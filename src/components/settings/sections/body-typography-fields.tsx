import { useId } from "react"
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
  BODY_SAFE_BOTTOM_MAX,
  BODY_SAFE_BOTTOM_MIN,
  defaultBodyMarginXForViewport,
  type BodyTypographySettings,
} from "@/lib/font-settings"
export type BodyTypographyValue = BodyTypographySettings

interface Props {
  value: BodyTypographyValue
  onChange: <K extends keyof BodyTypographyValue>(key: K, next: BodyTypographyValue[K]) => void
  /** aria/id 前缀，避免同一页面出现重复 id。 */
  idPrefix?: string
}

interface SliderRowProps {
  id: string
  label: string
  min: number
  max: number
  step: number
  value: number
  display: string
  onChange: (next: number) => void
}

/**
 * 一行滑块：`[标签] [当前值] [滑块]`。
 *
 * ── 为什么数值放在滑块**左侧**而不是上方（用户第 2 条要求）──
 * 放在上方时，每个字段要占两行（值一行、滑块一行），六项就是十二行；
 * 而且值在滑块上方偏左、与滑块左端对齐，视觉重心是散的。
 * 放到左侧之后：值与滑块同一行、且**右对齐贴着滑块左端**，
 * 六行的数值列与滑块列各自对齐成一竖列，面板立刻整齐。
 *
 * 三列宽度由 CSS 的固定 em 轨道给（.body-font-field），
 * 所以六个字段的数值与滑块是**跨行对齐**的 —— 这是这个面板
 * "有美感"的主要来源，比加阴影或换配色有效得多。
 */
function SliderRow({ id, label, min, max, step, value, display, onChange }: SliderRowProps) {
  return (
    <div className="body-font-field">
      <label className="body-font-field__label" htmlFor={id}>{label}</label>
      {/*
        data-ui-typography-value 是给测试用的取值钩子（按参数名定位），不参与样式。
        注意：断言"当前显示值是 X"时必须对准**这一个元素**，
        不能扫整个容器文本 —— 标签文字里也可能含同样的词。
      */}
      <span className="body-font-field__value" data-ui-typography-value={label}>{display}</span>
      <input
        className="body-font-field__range"
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  )
}

/**
 * 正文字体与 5 个排版参数控件。
 *
 * ── 它现在只有**一个**调用方：章节工具栏的「字体设置」浮层 ──
 *
 * 原先它是共享组件，设置页（外观与界面）与写作现场浮层各渲染一次，
 * 理由是"两处各写一套 JSX 必然腐坏成两套行为"。用户后来明确要求
 * **设置页不再出现这 6 项**（它们属于章节、不属于全局设置），
 * 于是这条"两处必须一致"的理由随之消失，共享组件也只剩一个入口。
 * 这一变化由 `body-typography-fields.spec.tsx` 与
 * `interface-sidebar-nav.spec.ts` 的守卫钉住（含"设置页不得再出现它们"）。
 *
 * ── 样式为什么不再挂 data-ui="interface-fields" ──
 * 那个属性是为了借用设置页 `ui-test-tools.css` 的后代选择器；而那份 CSS
 * 属于**懒加载 chunk**，浮层路径不会加载它 → 首帧无样式、之后突然跳变。
 * 现在样式全部来自与浮层同生共死的 `body-font-popover.css`
 * （由 preview-panel.tsx 静态 import），结构上不可能再发生。
 * 详见该 CSS 顶部的说明与 .codex-temp/probe-popover-fouc.mjs 的实测。
 *
 * ── 关于「改回跟随窗口」按钮被删除 ──
 * 它原先负责把 `marginX` 单独改回 `null`（跟随窗口）。用户要求删掉它，
 * 于是「回到跟随窗口」现在只能通过标题栏的**「默认设置」**一并复位
 * （后者会把 6 项全部恢复默认，其中 marginX 的默认值就是 null = 跟随窗口）。
 * 这是一处真实的能力收缩，已如实记录，不是被忽略的副作用。
 */
export function BodyTypographyFields({ value, onChange, idPrefix }: Props) {
  const generatedId = useId()
  const id = idPrefix ?? generatedId
  const sizePreset = BODY_FONT_PX_PRESETS.find((preset) => preset.value === value.fontPx)
  // 兜底边距来自 font-settings 的单一来源（与 ui-test-editor.css 的
  // clamp(20px,4vw,48px) 由静态守卫绑在一起）。
  // marginX 为 null 时必须让滑块停在这个位置而不是 0 ——
  // 显示 0 会让用户以为边距被设成了 0，而正文其实还有 20–48px 的间距。
  const marginXShown = value.marginX ?? defaultBodyMarginXForViewport(
    typeof window === "undefined" ? 0 : window.innerWidth,
  )

  return (
    /*
     * 根节点用 body-font-fields（本组件自己的类），不再用 data-ui="interface-fields"：
     * 后者是设置页那套懒加载样式的入口属性，浮层用它会回到"首帧无样式"的老问题。
     */
    <div className="body-font-fields">
      {/*
        正文字号：预设下拉在上、滑块在下，两者都是"正文字号"的控件。
        自动排布顺序即 [标签][下拉] / [数值][滑块]，正好落在与其它行相同的三列轨道上。
      */}
      <div className="body-font-field">
        <label className="body-font-field__label" htmlFor={`${id}-body-size-preset`}>正文字号</label>
        <select
          className="body-font-field__select"
          id={`${id}-body-size-preset`}
          aria-label="正文字号预设"
          value={sizePreset ? String(sizePreset.value) : "custom"}
          onChange={(event) => onChange("fontPx", Number(event.target.value))}
        >
          {!sizePreset && <option value="custom" disabled>自定义 · {value.fontPx}px</option>}
          {BODY_FONT_PX_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>{preset.label} · {preset.value}px</option>
          ))}
        </select>
        <span className="body-font-field__value" data-ui-typography-value="正文字号">{value.fontPx}px</span>
        <input
          className="body-font-field__range"
          id={`${id}-body-size`}
          type="range"
          min={BODY_FONT_PX_MIN}
          max={BODY_FONT_PX_MAX}
          step={1}
          value={value.fontPx}
          aria-label="正文字号"
          onChange={(event) => onChange("fontPx", Number(event.target.value))}
        />
      </div>

      <SliderRow
        id={`${id}-line-height`}
        label="行间距"
        min={BODY_LINE_HEIGHT_MIN}
        max={BODY_LINE_HEIGHT_MAX}
        step={0.05}
        value={value.lineHeight}
        display={value.lineHeight.toFixed(2)}
        onChange={(next) => onChange("lineHeight", next)}
      />

      <SliderRow
        id={`${id}-letter-spacing`}
        label="字间距"
        min={BODY_LETTER_SPACING_MIN}
        max={BODY_LETTER_SPACING_MAX}
        step={0.5}
        value={value.letterSpacing}
        display={`${value.letterSpacing}px`}
        onChange={(next) => onChange("letterSpacing", next)}
      />

      {/*
        左右边距。marginX 为 null 时显示「跟随窗口」而不是数字 —— 那是它的
        真实语义（不写变量、交给 CSS 的 clamp 兜底），显示 0 会误导。
        原先紧跟其后的「改回跟随窗口」按钮已按用户要求删除；要回到跟随窗口
        请用标题栏的「默认设置」（见组件头注释）。
      */}
      <SliderRow
        id={`${id}-margin-x`}
        label="左右边距"
        min={BODY_MARGIN_X_MIN}
        max={BODY_MARGIN_X_MAX}
        step={2}
        value={marginXShown}
        display={value.marginX === null ? "跟随窗口" : `${value.marginX}px`}
        onChange={(next) => onChange("marginX", next)}
      />

      {/* 底部安全距离：按用户要求排在最后一个 */}
      <SliderRow
        id={`${id}-safe-bottom`}
        label="底部安全距离"
        min={BODY_SAFE_BOTTOM_MIN}
        max={BODY_SAFE_BOTTOM_MAX}
        step={1}
        value={value.safeBottom}
        display={`${value.safeBottom}px`}
        onChange={(next) => onChange("safeBottom", next)}
      />

    </div>
  )
}
