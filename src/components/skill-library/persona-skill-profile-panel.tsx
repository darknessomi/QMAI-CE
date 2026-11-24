/** 人物档案。所有页签和显示模式共用顶栏中的重要人物标记和状态菜单。 */
import { useEffect, useMemo, useState } from "react"
import { Check, RefreshCw } from "lucide-react"
import {
  PERSONA_INJECT_PERSONALITY_MAX_CHARS,
  PERSONA_MAJOR_FIELDS,
  PERSONA_LIVE_FIELDS,
  PERSONA_MAJOR_ROLE_TYPES,
  PERSONA_MINOR_ROLE_TYPES,
  type PersonaSkillMeta,
  type PersonaSkillStatus,
} from "@/lib/novel/persona-skill-types"
import {
  applyPersonaProfileEdits,
  formatPersonaPersonalityForWriting,
  parsePersonalitySection,
  parsePersonaRelations,
  readPersonaDocumentFields,
  readPersonaSupplement,
  renderPersonalitySection,
} from "@/lib/novel/persona-skill-profile"
import { PersonaDocumentView } from "./persona-document-view"
import { PersonaPersonalityTab } from "./persona-personality-tab"

const TIER_LABELS = { major: "主要人物", minor: "次要人物" } as const
export const PERSONA_STATUS_LABELS: Record<PersonaSkillStatus, string> = {
  active: "活跃", dormant: "潜伏", archived: "归档",
}
export type PersonaStatusChoice = PersonaSkillStatus | "auto" | "candidate"

const ROLE_OPTIONS = [...PERSONA_MAJOR_ROLE_TYPES, ...PERSONA_MINOR_ROLE_TYPES]

/** 子页面。顺序即页签顺序，也决定用户默认落在哪一页。 */
const PAGES = [
  { key: "profile", label: "档案" },
  { key: "persona", label: "性格" },
  { key: "act", label: "语言与行为" },
  { key: "relation", label: "关系与状态" },
  { key: "research", label: "研究文件" },
] as const
type PageKey = (typeof PAGES)[number]["key"]

export interface PersonaSkillProfilePanelProps {
  meta: PersonaSkillMeta
  document: string
  research: Record<string, string>
  revisionCount: number
  /** 每次保存成功 +1：正文没变（例如只改了定位）时，靠它把「未保存」重置掉。 */
  resetToken?: number
  outlineSources: Array<{ ref: string; path: string }>
  onOpenOutline: (path: string) => void
  busy: boolean
  message: string
  onDirtyChange: (dirty: boolean) => void
  /** 保存结构化字段（含定位）。 */
  onSaveProfile: (input: { fields: Record<string, string>; roleType: string }) => void
  /** 保存原始 Markdown。 */
  onSaveRaw: (text: string, roleType: string) => void
  onRestoreRevision: () => void
  onRegenerateResearch: () => void
  /** 关系里点到一个已建档人物：跳到他那份档案。 */
  onOpenCharacter?: (name: string) => void
  onChangeStatus: (choice: PersonaStatusChoice) => void
  /** 切换「重要人物」（绿勾）。重要人物才会生成研究文件。 */
  onToggleImportant?: (next: boolean) => void
  /** 切换「随章节自动更新」。 */
  onToggleAutoUpdate?: (next: boolean) => void
  /** 从人物列表里移除这个角色（档案文件保留）。 */
  onDeletePersona?: () => void
  /** 判断某个人名有没有档案（用于关系列表的「可跳转」标记）。 */
  hasCharacter?: (name: string) => boolean
}

/** 一格密排字段。span 控制占几列。 */
function Field(input: {
  name: string
  value: string
  span?: 1 | 2 | 3 | "full"
  row?: boolean
  long?: boolean
  onChange?: (name: string, value: string) => void
  placeholder?: string
  testId?: string
}) {
  const spanClass =
    input.span === "full" ? " is-full" : input.span && input.span > 1 ? ` is-${input.span}` : ""
  const testId = input.testId ?? `persona-field-${input.name}`
  return (
    <div className={`ui-test-fitem${spanClass}${input.row ? " is-row" : ""}`}>
      <span>{input.name}</span>
      {!input.onChange ? (
        <div className="ui-test-fed is-readonly" style={{ cursor: "default" }}>
          {input.value || "—"}
        </div>
      ) : input.long || input.row ? (
        // 整行字段装的都是句子：用 textarea，才能换行与变高。
        <textarea
          className="ui-test-fed"
          data-testid={testId}
          value={input.value}
          placeholder={input.placeholder}
          onChange={(event) => input.onChange?.(input.name, event.target.value)}
        />
      ) : (
        <input
          className="ui-test-fed"
          data-testid={testId}
          value={input.value}
          placeholder={input.placeholder}
          onChange={(event) => input.onChange?.(input.name, event.target.value)}
        />
      )}
    </div>
  )
}

export function PersonaSkillProfilePanel(props: PersonaSkillProfilePanelProps) {
  const { meta, document, onDirtyChange } = props
  const [fieldEdits, setFieldEdits] = useState<Record<string, string>>({})
  const [rawDraft, setRawDraft] = useState<string | null>(null)
  const base = rawDraft ?? document
  const fields = useMemo(() => ({ ...readPersonaDocumentFields(base), ...fieldEdits }), [base, fieldEdits])
  const raw = useMemo(() => Object.keys(fieldEdits).length ? applyPersonaProfileEdits(base, fieldEdits) : base, [base, fieldEdits])
  const [roleType, setRoleType] = useState(meta.roleType)
  const [dirty, setDirty] = useState<"profile" | "raw" | null>(null)
  const [page, setPage] = useState<PageKey>("profile")
  /**
   * H2：表格 / 并排 / MD 三态。
   * 并排 = 左边表格、右边 MD 镜像，改哪边另一边都跟着变。
   */
  const [viewMode, setViewMode] = useState<"table" | "split" | "md">("table")

  // 文档换了（切换人物 / 保存后重读）就重置草稿。只在 document / resetToken 真变时触发：
  // 依赖 fields 会把用户正在敲的字打回去。
  useEffect(() => {
    setFieldEdits({})
    setRawDraft(null)
    setRoleType(meta.roleType)
    setDirty(null)
    onDirtyChange(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, meta.id, props.resetToken])

  // 表单停止输入 800ms 后保存。直接编辑 Markdown 时由「保存原文」提交。
  useEffect(() => {
    if (dirty !== "profile") return
    const timer = window.setTimeout(() => {
      if (rawDraft !== null) props.onSaveRaw(raw, roleType)
      else props.onSaveProfile({ fields: fieldEdits, roleType })
    }, 800)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, rawDraft, raw, fieldEdits, roleType])

  const markDirty = (source: "profile" | "raw" = "profile") => {
    setDirty(source)
    onDirtyChange(true)
  }

  function setField(name: string, value: string) {
    // 空串要**留在键上**：`applyPersonaProfileEdits` 用「键存在但为空」表示
    // 用户清空了这一格（删除该段），用「键不存在」表示没动过（保留原值）。
    // 在这里 delete 掉空键，清空就变成了「没动过」—— 用户会发现自己删不掉东西。
    setFieldEdits((previous) => ({ ...previous, [name]: value }))
    markDirty()
  }

  const relations = useMemo(() => parsePersonaRelations(fields["关系网"] ?? ""), [fields])
  const personality = useMemo(() => parsePersonalitySection(fields["性格"] ?? ""), [fields])
  const supplement = useMemo(() => readPersonaSupplement(base), [base])
  const personalityValue = formatPersonaPersonalityForWriting(fields["性格"] ?? "")
  const injectPreview = personalityValue ? `人物性格：${personalityValue}` : "还没有可注入的性格描述。"

  const roleChoices = useMemo(() => {
    const current = meta.roleType.trim()
    return current && !ROLE_OPTIONS.includes(current as (typeof ROLE_OPTIONS)[number])
      ? [...ROLE_OPTIONS, current]
      : [...ROLE_OPTIONS]
  }, [meta.roleType])

  return (
    <div data-testid="persona-skill-view" className="ui-test-skills-gallery ui-test-gdoc">
      <header className="ui-test-gbar">
        <b className="ui-test-gbar-name" data-testid="persona-profile-name">
          {meta.characterName}
        </b>
        {/* 重要人物：绿勾放在名字后面。点了左右两端都必须立刻一致 ——
            所以除了写索引，还要 bump 版本号让左栏重读。 */}
        <label
          className="ui-test-gbar-important"
          title="标记为重要人物：会重点分析，并在出场时生成研究文件"
        >
          <input
            type="checkbox"
            data-testid="persona-mark-important"
            checked={meta.pinned}
            disabled={props.busy}
            onChange={(event) => props.onToggleImportant?.(event.target.checked)}
          />
          <span aria-hidden="true">
            <Check />
          </span>
          <em>重要人物</em>
        </label>
        <label className="ui-test-gbar-status">
          状态
          <select
            aria-label="人物状态"
            value={meta.manualStatus ?? "auto"}
            onChange={(event) => props.onChangeStatus(event.target.value as PersonaStatusChoice)}
            disabled={props.busy}
          >
            <option value="auto">自动（{PERSONA_STATUS_LABELS[meta.status]}）</option>
            {Object.entries(PERSONA_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
            <option value="candidate">候选（待建档）</option>
          </select>
        </label>

        <div className="ui-test-gbar-right">
          <span className="ui-test-gbar-autosave" data-testid="persona-autosave">
            {props.busy ? "处理中…" : props.message}
          </span>
          <div className="ui-test-viewseg" role="group" aria-label="显示形式">
            {([
              { key: "table", label: "表格" },
              { key: "split", label: "并排" },
              { key: "md", label: "MD" },
            ] as const).map((item) => (
              <button
                key={item.key}
                type="button"
                data-testid={`persona-viewmode-${item.key}`}
                aria-pressed={viewMode === item.key}
                className={viewMode === item.key ? "is-on" : ""}
                onClick={() => setViewMode(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* 页签 */}
      {/* 页签只在「表格」模式出现：MD / 并排 已经是整份文档，不需要再按区块跳转。 */}
      <nav className="ui-test-gtabs" role="tablist" hidden={viewMode !== "table"}>
        {PAGES.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={page === item.key}
            data-testid={`persona-page-${item.key}`}
            className={`ui-test-gtab${page === item.key ? " is-on" : ""}`}
            onClick={() => setPage(item.key)}
          >
            {item.label}
            {item.key === "persona" && personality.tags.length > 0 ? (
              <span className="n">{personality.tags.length}</span>
            ) : null}
            {item.key === "research" && Object.keys(props.research).length > 0 ? (
              <span className="n">{Object.keys(props.research).length}</span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className="ui-test-gbody" inert={props.busy}>
        <div className="ui-test-gbody-inner">
          <div className={`ui-test-h2-body${viewMode === "split" ? " is-split" : ""}`}>
            {/* 只看 MD 时字段区整块不渲染：留在 DOM 里会留下隐藏的可聚焦元素。 */}
            {viewMode !== "md" ? (
            <div className="ui-test-h2-fields">

          {/* ===== 档案 ===== */}
          {page === "profile" ? (
            <>
              <section className="ui-test-fsec">
                <h5>基本</h5>
                <div className="ui-test-fgrid is-2">
                  <Field name="姓名" value={meta.characterName} />
                  <Field onChange={setField} name="性别" value={fields["性别"] ?? ""} placeholder="留空" />
                  <Field onChange={setField} name="年龄" value={fields["年龄"] ?? ""} placeholder="二十出头" />
                  <div className="ui-test-fitem">
                    <span>定位</span>
                    <select
                      className="ui-test-fed"
                      data-testid="persona-field-定位"
                      value={roleType}
                      onChange={(event) => {
                        setRoleType(event.target.value)
                        markDirty()
                      }}
                    >
                      <option value="">未标注</option>
                      {roleChoices.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </section>


              <section className="ui-test-fsec">
                <h5>归属与出场</h5>
                <div className="ui-test-fgrid is-2">
                  <Field onChange={setField} name="势力组织" value={fields["势力组织"] ?? ""} />
                  <Field name="出场次数" value={`${meta.appearanceCount} 次`} />
                  <Field name="首次出场" value={`第 ${meta.firstChapter} 章`} />
                  <Field name="最近出场" value={`第 ${meta.lastChapter} 章`} />
                </div>
              </section>

              {props.outlineSources.length > 0 && (
                <section className="ui-test-fsec">
                  <h5>关联大纲</h5>
                  {props.outlineSources.map(({ ref, path }) => (
                    <button type="button" key={path} className="ui-test-skills-action" disabled={props.busy || Boolean(dirty)}
                      onClick={() => props.onOpenOutline(path)}>{ref}</button>
                  ))}
                </section>
              )}

              <section className="ui-test-fsec">
                <h5>外形 · 能力 · 成长</h5>
                {/* 这三格装的都是整句话：两列平分后每格只剩两百来像素，
                    读起来还是被切断。所以与「语言与行为」同规格，一行一条。 */}
                <div className="ui-test-frows">
                  <Field onChange={setField} name="外貌" value={fields["外貌"] ?? ""} row placeholder="体型、衣着、伤疤、习惯性的小动作" />
                  <Field onChange={setField} name="能力" value={fields["能力"] ?? ""} row placeholder="擅长什么、弱点在哪" />
                  <Field onChange={setField} name="成长轨迹" value={fields["成长轨迹"] ?? ""} row placeholder="从哪来、往哪去" />
                </div>
              </section>

              <section className="ui-test-fsec">
                <h5>背景与动机</h5>
                <div className="ui-test-frows">
                  <Field onChange={setField} name="背景" value={fields["背景"] ?? ""} row placeholder="出身、经历、现在的处境" />
                  <Field onChange={setField} name="动机" value={fields["动机"] ?? ""} row placeholder="他想要什么" />
                </div>
              </section>

              <section className="ui-test-fsec">
                <h5>其他</h5>
                <div className="ui-test-frows" style={{ marginBottom: 11 }}>
                  <Field onChange={setField} name="备注" value={fields["备注"] ?? ""} row placeholder="给自己看的" />
                </div>
                <div className="ui-test-fgrid is-2">
                  <Field name="建档章节" value={`第 ${meta.createdChapter} 章`} />
                  <Field name="最近学习" value={`第 ${meta.lastLearnedChapter} 章`} />
                </div>
              </section>
              <section className="ui-test-fsec">
                <h5>危险操作</h5>
                <div className="ui-test-ptab-soul">
                  <span className="ui-test-ptab-count">
                    从人物列表移除这个角色。档案文件仍留在 .qmai/persona-skills/ 下，不会删盘。
                  </span>
                  <button
                    type="button"
                    data-testid="persona-delete"
                    className="ui-test-skills-action is-danger"
                    style={{ marginLeft: "auto" }}
                    onClick={() => props.onDeletePersona?.()}
                    disabled={props.busy}
                  >
                    删除角色
                  </button>
                </div>
              </section>
            </>
          ) : null}

          {/* ===== 性格 ===== */}
          {page === "persona" ? (
            <>
              <section className="ui-test-fsec">
                <h5>性格 · 会进入写作注入</h5>
                <PersonaPersonalityTab
                  tags={personality.tags}
                  raw={personality.raw}
                  onChange={(next) => {
                    setField("性格", renderPersonalitySection({ tags: next.tags }))
                  }}
                />
              </section>

              {/* 注入预览不再是独立卡片：改成贴在性格区底部的虚线细条。
                  它和「性格」是同一件事的上下游，独立成卡片只会和上面那块
                  形成两个并列的浅色方框（用户描述为「双蓝」）。 */}
              <div className="ui-test-injline" data-testid="persona-inject-preview">
                <span className="k">注入预览</span>
                <span className="v">
                  {injectPreview}
                </span>
                <span className="n">
                  {personalityValue.length} / {PERSONA_INJECT_PERSONALITY_MAX_CHARS} 字
                </span>
              </div>
            </>
          ) : null}

          {/* ===== 语言与行为 ===== */}
          {page === "act" ? (
            <>
              <section className="ui-test-fsec">
                <h5>写正文时真正喂给模型的 5 条</h5>
                {/* 这 5 条内容都不长，一行一条比两列并排更好读：
                    两列时视线要在左右之间来回跳，且长短不齐会互相撑高。 */}
                <div className="ui-test-frows">
                  {PERSONA_MAJOR_FIELDS.map((name) => (
                    <Field onChange={setField} key={name} name={name} value={fields[name] ?? ""} long row />
                  ))}
                </div>
              </section>

              {supplement ? (
                <section className="ui-test-fsec">
                  <h5>AI 追加观察</h5>
                  <div className="ui-test-gnote" data-testid="persona-profile-supplement">
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", font: "inherit" }}>{supplement}</pre>
                  </div>
                </section>
              ) : null}
            </>
          ) : null}

          {/* ===== 关系与状态 ===== */}
          {page === "relation" ? (
            <>
              <section className="ui-test-fsec">
                <h5>关系网 · 每行一位：对象：关系（性质）</h5>
                <div className="ui-test-fgrid is-2">
                  <Field onChange={setField}
                    name="关系网"
                    value={fields["关系网"] ?? ""}
                    long
                    span="full"
                    placeholder={"陆云飞：竞争对手（权力斗争）\n沈砚：旧识（互相提防）"}
                  />
                </div>
                {relations.length > 0 ? (
                  <ul className="ui-test-persona-relations">
                    {relations.map((line, index) => {
                      const openable = Boolean(props.hasCharacter?.(line.name))
                      return (
                        <li key={`${line.name}-${index}`} className="ui-test-persona-relation">
                          <button
                            type="button"
                            className="ui-test-persona-relation-name"
                            disabled={!openable}
                            title={openable ? `打开「${line.name}」的档案` : "还没有这个人的档案"}
                            onClick={() => props.onOpenCharacter?.(line.name)}
                          >
                            {line.name}
                          </button>
                          {line.relation ? <span className="is-relation">{line.relation}</span> : null}
                          {line.nature ? <span className="is-nature">{line.nature}</span> : null}
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className="ui-test-skills-empty">
                    「关系网」还没有内容。AI 会在该人物出场时补上；也可以自己写。
                  </p>
                )}
              </section>

              <section className="ui-test-fsec">
                <h5>当前状态 · 由「提取记忆」自动维护，手改会被覆盖</h5>
                <div className="ui-test-ptab-soul" style={{ marginBottom: 12 }}>
                  <label className="ui-test-switch">
                    <input
                      type="checkbox"
                      data-testid="persona-auto-update"
                      checked={meta.autoUpdate !== false}
                      onChange={(event) => props.onToggleAutoUpdate?.(event.target.checked)}
                    />
                    <span>随章节自动更新</span>
                  </label>
                  <span className="ui-test-ptab-count" style={{ marginLeft: "auto" }}>
                    {meta.autoUpdate === false
                      ? "已关闭：提取记忆仍会计出场，但不再改写这份档案"
                      : "开启：每章提取后会更新下面四段"}
                  </span>
                </div>
                <div className="ui-test-fgrid is-2">
                  {PERSONA_LIVE_FIELDS.map((name) => (
                    <Field onChange={setField}
                      key={name}
                      name={name}
                      value={fields[name] ?? ""}
                      long
                      testId={`persona-live-${name}`}
                      placeholder="还没有内容。下一次「提取记忆」会自动写入。"
                    />
                  ))}
                </div>
              </section>

              <section className="ui-test-fsec">
                <h5>档案版本</h5>
                <div className="ui-test-fgrid is-5">
                  <Field
                    name="档位"
                    value={`${TIER_LABELS[meta.tier]}${meta.pinned ? " · ★重点" : ""}`}
                  />
                  <Field name="版本" value={`第 ${meta.skillRevision} 版`} />
                  <Field name="可回退" value={`${props.revisionCount} 版`} />
                  <Field name="手改过" value={meta.editedByUser ? "是" : "否"} />
                  <div className="ui-test-fitem">
                    <span>操作</span>
                    {props.revisionCount > 0 ? (
                      <button
                        type="button"
                        data-testid="persona-skill-restore"
                        className="ui-test-skills-action"
                        title={`保留了最近 ${props.revisionCount} 个历史版本`}
                        onClick={props.onRestoreRevision}
                        disabled={props.busy}
                      >
                        回退上一版
                      </button>
                    ) : (
                      <div className="ui-test-fed is-readonly" style={{ cursor: "default" }}>
                        暂无可回退版本
                      </div>
                    )}
                  </div>
                </div>
              </section>
            </>
          ) : null}

          {/* ===== 研究文件 ===== */}
          {page === "research" ? (
            <>
              <section className="ui-test-fsec">
                <h5>研究文件 {meta.pinned ? "" : "· 点亮绿勾后才会生成"}</h5>
                {Object.keys(props.research).length > 0 && meta.pinned ? (
                  <div data-testid="persona-skill-research" className="ui-test-persona-research">
                    {Object.entries(props.research).map(([name, content]) => (
                      <details key={name}>
                        <summary>{name}</summary>
                        <pre>{content}</pre>
                      </details>
                    ))}
                    <button
                      type="button"
                      className="ui-test-skills-action"
                      onClick={props.onRegenerateResearch}
                      disabled={props.busy}
                    >
                      <RefreshCw /> 重新整理研究文件
                    </button>
                  </div>
                ) : (
                  <p className="ui-test-skills-empty">
                    {meta.pinned
                      ? "研究文件会在该人物下次出场时自动生成。"
                      : "点亮绿勾后，该人物会生成研究文件。"}
                  </p>
                )}
              </section>

              <section className="ui-test-fsec">
                <h5>原始 Markdown · 整份 SKILL.md，改了等于跳过上面的表单</h5>
                <div className="ui-test-gnote" style={{ marginBottom: 8 }}>
                  标题写错（比如把「怎么说话」写成「说话方式」）会让那一格在表单里读不出来。
                </div>
                <div className="ui-test-skills-actions" style={{ marginBottom: 8 }}>
                  <button
                    type="button"
                    data-testid="persona-raw-save"
                    className="ui-test-skills-action is-primary"
                    onClick={() => props.onSaveRaw(raw, roleType)}
                    disabled={props.busy}
                  >
                    保存原文
                  </button>
                </div>
                <textarea
                  data-testid="persona-skill-editor"
                  className="ui-test-persona-editor"
                  value={raw}
                  onChange={(event) => {
                    setRawDraft(event.target.value)
                    setFieldEdits({})
                    markDirty("raw")
                  }}
                />
              </section>
            </>
          ) : null}
            </div>
            ) : null}

            {viewMode !== "table" ? (
              <div className="ui-test-h2-md">
                {/* 点开即编辑：没有页签、没有「编辑原文」、没有保存按钮。
                    文档本身就是可编辑的，改完自动保存。 */}
                <div className="ui-test-h2-md-doc" data-testid="persona-md-editor">
                  <PersonaDocumentView
                    characterName={meta.characterName}
                    roleType={roleType}
                    fields={fields}
                    research={props.research}
                    injectPreview={injectPreview}
                    onCommitField={(name, value) => setField(name, value)}
                  />
                </div>
              </div>
            ) : null}
        </div>
      </div>
    </div>
    </div>
  )
}
