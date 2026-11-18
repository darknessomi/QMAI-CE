/**
 * 性格面板（方案 T2「题材卡包」）。
 *
 * ── 旧版的问题 ──
 * 一长串平铺标签：选过的、没选的、别的题材的挤在同一排；「语气 / 怪癖 / 关系 / 反差」
 * 四组共用一套「展开更多」开关，展开后一屏 80 个标签，找一条要肉眼扫完。
 *
 * ── 这一版怎么排 ──
 *   1. 最上面是**已选**，带预算条（条数 / 字数）——先看清手上有什么
 *   2. **按分类挑单个**：语气 / 怪癖 / 关系 / 反差 各占一行，不再藏起来
 *   3. 自定义输入：拒绝抽象词，只收能演出来的具体特征
 *
 * 上限 4 条是注入预算决定的（PERSONA_INJECT_PERSONALITY_MAX_TAGS），
 * 所以在 UI 上就拦住，而不是等注入时静默截断 —— 用户选了 6 条却只生效 4 条，
 * 是那种「界面没骗人但结果不对」的坑。
 */
import { useState } from "react"
import {
  PERSONALITY_TAGS,
  PERSONALITY_TAG_MAX_CHARS,
  isPerformanceTag,
  type PersonalityTagGroup,
} from "@/lib/novel/personality-tags"
import {
  PERSONA_INJECT_PERSONALITY_MAX_CHARS,
  PERSONA_INJECT_PERSONALITY_MAX_TAGS,
} from "@/lib/novel/persona-skill-types"

const GROUPS: PersonalityTagGroup[] = ["语气", "怪癖", "关系", "反差"]

export interface PersonaPersonalityTabProps {
  tags: readonly string[]
  boundSoul: string
  raw: string
  onChange: (next: { tags: string[]; boundSoul: string }) => void
}

export function PersonaPersonalityTab({
  tags,
  boundSoul,
  raw,
  onChange,
}: PersonaPersonalityTabProps) {
  const [custom, setCustom] = useState("")
  const [hint, setHint] = useState("")

  const usedChars = tags.reduce((total, tag) => total + tag.length, 0)
  const full = tags.length >= PERSONA_INJECT_PERSONALITY_MAX_TAGS

  const toggle = (label: string) => {
    if (tags.includes(label)) {
      setHint("")
      onChange({ tags: tags.filter((tag) => tag !== label), boundSoul })
      return
    }
    if (full) {
      setHint(`最多选 ${PERSONA_INJECT_PERSONALITY_MAX_TAGS} 条，超出的不会进入写作注入`)
      return
    }
    setHint("")
    onChange({ tags: [...tags, label], boundSoul })
  }

  const addCustom = () => {
    const label = custom.trim()
    if (!label) return
    if (!isPerformanceTag(label)) {
      setHint(`请写能演出来的具体特征（不超过 ${PERSONALITY_TAG_MAX_CHARS} 字），例如「见到美酒走不动路」`)
      return
    }
    toggle(label)
    setCustom("")
  }

  const tagButton = (label: string) => (
    <button
      key={label}
      type="button"
      onClick={() => toggle(label)}
      aria-pressed={tags.includes(label)}
      className={`ui-test-skills-chip${tags.includes(label) ? " is-active" : ""}`}
    >
      {label}
    </button>
  )

  return (
    <div className="ui-test-ptab">
      {raw && (
        <p className="ui-test-persona-note">
          当前性格是一段手写文字，未按标签管理。改成标签会覆盖这段文字。
        </p>
      )}

      {boundSoul.trim() && (
        <div className="ui-test-soul-row">
          <span>已有角色绑定：{boundSoul}</span>
          <button type="button" data-testid="persona-soul-clear" className="ui-test-skills-action"
            onClick={() => onChange({ tags: [...tags], boundSoul: "" })}>
            解绑
          </button>
        </div>
      )}

      {/* 2. 已选性格 + 预算 */}
      <section className="ui-test-ptab-block">
        <header className="ui-test-ptab-head">
          <h6>性格</h6>
          <span className="ui-test-ptab-count">
            {tags.length} / {PERSONA_INJECT_PERSONALITY_MAX_TAGS} 条 · {usedChars} /{" "}
            {PERSONA_INJECT_PERSONALITY_MAX_CHARS} 字
          </span>
        </header>
        <div className="ui-test-ptab-budget" aria-hidden="true">
          <i
            style={{
              width: `${Math.min(100, (usedChars / PERSONA_INJECT_PERSONALITY_MAX_CHARS) * 100)}%`,
            }}
          />
        </div>
        {tags.length > 0 ? (
          <div className="ui-test-skills-chips">
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => toggle(tag)}
                className="ui-test-skills-chip is-active"
              >
                {tag} ×
              </button>
            ))}
          </div>
        ) : null}
        {hint && <p className="ui-test-persona-hint is-error">{hint}</p>}
      </section>

      {/* 4. 按分类挑单个 */}
      <section className="ui-test-ptab-block">
        <header className="ui-test-ptab-head">
          <h6>按分类挑单个</h6>
          <span className="ui-test-ptab-count">最多 {PERSONA_INJECT_PERSONALITY_MAX_TAGS} 条</span>
        </header>
        <div className="ui-test-ptab-groups">
          {GROUPS.map((group) => {
            const all = PERSONALITY_TAGS.filter((item) => item.group === group)
            return (
              <div key={group} className="ui-test-ptab-group">
                <span className="ui-test-ptab-group-name">{group}</span>
                <div className="ui-test-skills-chips">{all.map((item) => tagButton(item.label))}</div>
              </div>
            )
          })}
        </div>
      </section>

      {/* 5. 自定义 */}
      <section className="ui-test-ptab-block">
        <header className="ui-test-ptab-head">
          <h6>自定义输入</h6>
          <span className="ui-test-ptab-count">只收能演出来的具体特征</span>
        </header>
        <div className="ui-test-ptab-custom">
          <input
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder="例：见到美酒走不动路"
            className="ui-test-persona-input"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                addCustom()
              }
            }}
          />
          <button type="button" onClick={addCustom} className="ui-test-skills-action">
            添加
          </button>
        </div>
      </section>

    </div>
  )
}
