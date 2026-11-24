import { confirmAction } from "@/lib/confirm-action"
import "@/components/uitest/ui-test-tools.css"
import { useEffect, useMemo, useState } from "react"
import { Search } from "lucide-react"
import { resolveNovelModel } from "@/lib/novel/model-resolver"
import {
  getEffectivePersonaStatus,
  PERSONA_ARCHIVED_GAP_CHAPTERS,
  PERSONA_DORMANT_GAP_CHAPTERS,
  type PersonaSkillMeta,
  type PersonaSkillSighting,
} from "@/lib/novel/persona-skill-types"
import {
  findPersonaByName,
  listPersonaSkillRevisions,
  setPersonaSkillPinned,
  setPersonaSkillStatus,
  readPersonaSkillDocument,
  readPersonaSkillResearch,
  restorePersonaSkillRevision,
  savePersonaSkillDocumentByUser,
  updatePersonaSkillIndex,
} from "@/lib/novel/persona-skill-store"
import {
  createPersonaSkillByUser,
  demotePersonaSkillToSighting,
  deletePersonaSighting,
  promotePersonaSightingLocal,
  regeneratePersonaSkillResearch,
  savePersonaSkillProfileByUser,
} from "@/lib/novel/persona-skill-learning"
import { deleteFiledPersona } from "./delete-filed-persona"
import { resolvePersonaOutlineRef } from "@/lib/novel/persona-outline-detach"
import { useWikiStore } from "@/stores/wiki-store"
import { usePersonaSkillState } from "./use-persona-skill-state"
import { PersonaCandidatePreview } from "./persona-candidate-preview"
import { PersonaPersonalityCreateForm } from "./persona-personality-create-form"
import { PERSONA_STATUS_LABELS, PersonaSkillProfilePanel, type PersonaStatusChoice } from "./persona-skill-profile-panel"

const TIER_LABELS = { major: "主要人物", minor: "次要人物" } as const
const STATUS_ORDER = ["all", "active", "dormant", "archived"] as const
type StatusFilter = (typeof STATUS_ORDER)[number]

export interface PersonaSkillViewProps {
  /**
   * 中栏面板模式。人物搬回大纲后，左栏已经有「活跃角色 / 候选角色」树，
   * 面板里再显示旧的整页列表（搜索框 / 状态筛选 / 档案卡墙 / 候选折叠条）
   * 就是重复且多余的信息 —— 用户明确要求删掉。
   * 面板模式下没有选中对象时不渲染列表，只给一句空态提示。
   */
  paneMode?: boolean
}

export function PersonaSkillView({ paneMode = false }: PersonaSkillViewProps = {}) {
  const pathIndex = useWikiStore((s) => s.projectPathIndex)
  const projectPath = useWikiStore((s) => s.project?.path)
  const setDraftDirty = useWikiStore((s) => s.setPersonaSkillLibraryDraftDirty)
  const bumpPersonaDataVersion = useWikiStore((s) => s.bumpPersonaDataVersion)
  const setPersonaOutlinePane = useWikiStore((s) => s.setPersonaOutlinePane)
  const personaOutlinePane = useWikiStore((s) => s.personaOutlinePane)

  const { index, sightings: candidatePool } = usePersonaSkillState(projectPath)
  const skills = index.skills
  const sightings = candidatePool.sightings
  const selectedId = personaOutlinePane?.mode === "persona" ? personaOutlinePane.id : null
  const candidateFocus = personaOutlinePane?.mode === "candidate" ? personaOutlinePane.name : null
  const creating = personaOutlinePane?.mode === "create"
  const [loadedFor, setLoadedFor] = useState<{ id: string; projectPath: string } | null>(null)
  const [documentText, setDocumentText] = useState("")
  const [research, setResearch] = useState<Record<string, string>>({})
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [analysisOpen, setAnalysisOpen] = useState(false)
  const [revisionCount, setRevisionCount] = useState(0)
  /** 每次保存成功 +1：让档案面板重置草稿态（只改定位时正文没变，靠 document 变化触发不了）。 */
  const [resetToken, setResetToken] = useState(0)
  /** 候选人物默认折叠：9 张候选卡会把页面拉长一倍，先压成一条。 */
  const [candidatesOpen, setCandidatesOpen] = useState(false)

  useEffect(() => {
    if (!projectPath || !selectedId) {
      setLoadedFor(null)
      setDocumentText("")
      setResearch({})
      setRevisionCount(0)
      return
    }
    let cancelled = false
    void (async () => {
      const [document, docs, revisions] = await Promise.all([
        readPersonaSkillDocument(projectPath, selectedId),
        readPersonaSkillResearch(projectPath, selectedId),
        listPersonaSkillRevisions(projectPath, selectedId),
      ])
      if (cancelled) return
      setLoadedFor({ id: selectedId, projectPath })
      setDocumentText(document)
      setResearch(docs)
      setRevisionCount(revisions.length)
      setDraftDirty(false)
    })()
    return () => {
      cancelled = true
    }
  }, [projectPath, selectedId, setDraftDirty])

  const selected = useMemo(
    () => index.skills.find((meta) => meta.id === selectedId) ?? null,
    [index.skills, selectedId],
  )

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return skills.filter((meta) => {
      if (statusFilter !== "all" && getEffectivePersonaStatus(meta) !== statusFilter) return false
      if (!keyword) return true
      return meta.characterName.toLowerCase().includes(keyword)
    })
  }, [skills, query, statusFilter])

  const counts = useMemo(() => {
    const result = { all: skills.length, active: 0, dormant: 0, archived: 0 }
    for (const meta of skills) result[getEffectivePersonaStatus(meta)]++
    return result
  }, [skills])

  const analysisRows = useMemo(() =>
    skills.filter((meta) => meta.appearanceCount <= 1 || getEffectivePersonaStatus(meta) !== "active"), [skills])

  async function handlePromote(sighting: PersonaSkillSighting) {
    if (!projectPath) return
    setBusy(true)
    try {
      /*
       * 建档**不调模型**：用户点一下就该立刻看到结果。
       * 旧路径要先让模型读章节生成整份档案，模型没配置/超时/返回空时界面什么都不会变，
       * 用户点完只觉得「这个按钮没用」。内容留给下一次「提取记忆」或用户自己补。
       */
      const created = await promotePersonaSightingLocal({
        projectPath,
        characterName: sighting.characterName,
      })
      if (created) {
        // 建档成功后别再停在预览卡上：直接打开这份新档案，用户才看得到「确实生效了」。
        setPersonaOutlinePane({ mode: "persona", id: created.id })
        bumpPersonaDataVersion()
        setMessage(`「${sighting.characterName}」已建档。`)
      } else {
        setMessage(`「${sighting.characterName}」在建档时找不到了，可能已被别处处理，请刷新后再试。`)
      }
    } catch (err) {
      setMessage(`「${sighting.characterName}」建档失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  /**
   * 把误建档的人物退回候选区。这条路径存在的唯一理由，就是候选区那个动作
   * **只有建档、没有反悔**：一旦建成，候选池里的记录会被删掉，用户再也回不去。
   */
  async function handleDemote(meta: PersonaSkillMeta) {
    if (!projectPath) return
    setBusy(true)
    try {
      const discardsDraft = stillShowing(meta.id) && useWikiStore.getState().personaSkillLibraryDraftDirty
      const confirmed = await confirmAction(
        `把「${meta.characterName}」移入候选吗？\n\n` +
          "原档案会保留。提取记忆时仍会累计出场，达到条件后可自动重新建档。" +
          (discardsDraft ? "\n当前档案未保存的修改会被放弃。" : ""),
      )
      if (!confirmed) return
      const ok = await demotePersonaSkillToSighting({
        projectPath,
        id: meta.id,
      })
      if (ok) {
        bumpPersonaDataVersion()
        if (!stillShowing(meta.id)) return
        setDraftDirty(false)
        // 退回候选后停在候选预览上，也不再落到那套旧列表页。
        setPersonaOutlinePane({ mode: "candidate", name: meta.characterName })
        setMessage(`已把「${meta.characterName}」退回候选人物。`)
      } else {
        setMessage(`「${meta.characterName}」退回候选失败：没有找到对应的档案。`)
      }
    } catch (err) {
      setMessage(`「${meta.characterName}」退回候选失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  /**
   * 删除候选人物。
   * 同时写进带忽略名单 —— 候选池是每章重新数出来的，只删当下这一条，
   * 下次「提取记忆」就会把它加回来，删除按钮等于假的。
   */
  async function handleDeleteSighting(sighting: PersonaSkillSighting) {
    if (!projectPath) return
    setBusy(true)
    try {
      const confirmed = await confirmAction(
        `确定删除候选人物「${sighting.characterName}」吗？\n\n之后提取记忆也不会再把它加回候选区（已建档的角色不受影响）。`
      )
      if (!confirmed) return
      const removed = await deletePersonaSighting({
        projectPath,
        characterName: sighting.characterName,
      })
      bumpPersonaDataVersion()
      setMessage(
        removed
          ? `已删除候选「${sighting.characterName}」，以后不会再出现在候选区。`
          : `候选「${sighting.characterName}」已经不在了，请刷新后再试。`
      )
    } catch (err) {
      setMessage(`「${sighting.characterName}」删除失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function handleChangeStatus(meta: PersonaSkillMeta, choice: PersonaStatusChoice) {
    if (!projectPath) return
    if (choice === "candidate") return handleDemote(meta)
    setBusy(true)
    try {
      await setPersonaSkillStatus(projectPath, meta.id, choice === "auto" ? null : choice)
      if (useWikiStore.getState().project?.path !== projectPath) return
      bumpPersonaDataVersion()
      if (stillShowing(meta.id)) setMessage("")
    } catch (err) {
      if (stillShowing(meta.id)) setMessage(`状态保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function handleToggleImportant(meta: PersonaSkillMeta, next: boolean) {
    if (!projectPath) return
    setBusy(true)
    try {
      await setPersonaSkillPinned(projectPath, meta.id, next)
      bumpPersonaDataVersion()
      setMessage(next ? `已把「${meta.characterName}」标为重要人物。` : `已取消「${meta.characterName}」的重要标记。`)
    } catch (err) {
      setMessage(`标记没保存成功：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  /** 切换「随章节自动更新」。只改索引，不动正文。 */
  async function handleToggleAutoUpdate(meta: PersonaSkillMeta, next: boolean) {
    if (!projectPath) return
    setBusy(true)
    try {
      await updatePersonaSkillIndex(projectPath, (current) => ({
        version: 1,
        skills: current.skills.map((item) =>
          item.id === meta.id ? { ...item, autoUpdate: next, updatedAt: new Date().toISOString() } : item,
        ),
      }))
      bumpPersonaDataVersion()
      setMessage(
        next
          ? `「${meta.characterName}」已开启随章节自动更新。`
          : `「${meta.characterName}」已关闭自动更新，档案不会再被改写。`
      )
    } finally {
      setBusy(false)
    }
  }

  /**
   * 删除角色 = 从人物列表移除。
   * 只动索引，不删磁盘：`.qmai/persona-skills/<名>/` 留着，需要彻底清理时可手工删目录。
   * 「误删目录」不可逆，所以宁可留文件，也不给一个删了找不回来的按钮。
   */
  async function handleDeletePersona(meta: PersonaSkillMeta) {
    if (!projectPath) return
    setBusy(true)
    try {
      const hasSameName = skills.some((person) => person.id !== meta.id && person.characterName === meta.characterName)
      const removed = await deleteFiledPersona(projectPath, meta.id, meta.characterName, hasSameName)
      if (removed === undefined) return
      setMessage(
        removed
          ? `已从人物列表删除「${meta.characterName}」，档案文件仍保留在项目中。`
          : `「${meta.characterName}」没有删掉，可能已经不在了。`
      )
    } catch (err) {
      setMessage(`「${meta.characterName}」删除失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  /**
   * 新建人物角色。
   *
   * 走 createPersonaSkillByUser 而不是 savePersonaSkillProfileByUser：
   * 后者要求 id 已存在（它是「改档案」），前者才是「建档」。
   * origin 用默认的 manual —— 这是用户亲手建的，删大纲时不该被连带删掉。
   */
  async function handleCreatePersona(input: {
    characterName: string
    roleType: string
    fields: Record<string, string>
  }) {
    if (!projectPath) return
    setBusy(true)
    try {
      const created = await createPersonaSkillByUser({
        projectPath,
        characterName: input.characterName,
        roleType: input.roleType,
        fields: input.fields,
      })
      bumpPersonaDataVersion()
      setPersonaOutlinePane({ mode: "persona", id: created.id })
      setMessage(`已创建「${input.characterName}」。之后 AI 只会更新文末的「补充」段，不会覆盖你写的内容。`)
    } catch (err) {
      setMessage(`创建失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  function stillShowing(id: string) {
    const { project, personaOutlinePane: focus } = useWikiStore.getState()
    return project?.path === projectPath && focus?.mode === "persona" && focus.id === id
  }

  async function handleSave(edit: string | Record<string, string>, roleType: string) {
    if (!projectPath || !selected) return
    setBusy(true)
    try {
      if (typeof edit === "string") await savePersonaSkillDocumentByUser(projectPath, selected.id, edit, roleType)
      else await savePersonaSkillProfileByUser({ projectPath, id: selected.id, fields: edit, roleType })
      bumpPersonaDataVersion()
      const [document, revisions] = await Promise.all([
        readPersonaSkillDocument(projectPath, selected.id),
        listPersonaSkillRevisions(projectPath, selected.id),
      ])
      if (!stillShowing(selected.id)) return
      setDocumentText(document)
      setRevisionCount(revisions.length)
      setResetToken((token) => token + 1)
      setDraftDirty(false)
      setMessage("已保存。")
    } catch (err) {
      if (stillShowing(selected.id)) setMessage(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  /** 关系网里点到一个人：他身上有档案就跳过去。 */
  const findCharacter = (name: string) => findPersonaByName(index.skills, name)

  function handleOpenCharacter(name: string) {
    const target = findCharacter(name)
    if (target) {
      setPersonaOutlinePane({ mode: "persona", id: target.id })
      setMessage("")
    }
  }

  const hasCharacter = (name: string) => Boolean(findCharacter(name))

  async function handleRestoreRevision() {
    if (!projectPath || !selected) return
    setBusy(true)
    try {
      const restored = await restorePersonaSkillRevision(projectPath, selected.id)
      if (!restored) {
        setMessage("没有可回退的历史版本。")
        return
      }
      bumpPersonaDataVersion()
      const revisions = await listPersonaSkillRevisions(projectPath, selected.id)
      if (!stillShowing(selected.id)) return
      setDocumentText(restored.document)
      setRevisionCount(revisions.length)
      setDraftDirty(false)
      setMessage("已回退到上一版。")
    } catch (err) {
      setMessage(`回退失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function handleRegenerateResearch() {
    if (!projectPath || !selected) return
    setBusy(true)
    try {
      const state = useWikiStore.getState()
      const ok = await regeneratePersonaSkillResearch({
        projectPath,
        id: selected.id,
        llmConfig: resolveNovelModel(state.llmConfig, state.novelConfig, "extract"),
      })
      const docs = await readPersonaSkillResearch(projectPath, selected.id)
      if (!stillShowing(selected.id)) return
      setResearch(docs)
      setMessage(ok ? "研究文件已重新整理。" : "研究文件整理失败：模型没有返回可整理的内容。")
    } finally {
      setBusy(false)
    }
  }

  if (!projectPath) {
    return <div className="ui-test-skills-empty">先打开一本书，再管理人物 Skill。</div>
  }

  /*
   * 新建模式整页渲染：**不能**和列表挤在一起。
   * 早先把它放在列表工具栏下面，用户看到的是「搜索框 + 筛选按钮 + 一个巨大表单」
   * 叠在同一屏，既不知道自己在列表还是在新建，也得滚很久才看到字段。
   * 与「点开一个角色」同构：进入就是完整一页，返回即回列表。
   */
  if (creating) {
    return (
      <PersonaPersonalityCreateForm
        busy={busy}
        message={message}
        hasCharacter={hasCharacter}
        onCancel={() => {
          setPersonaOutlinePane(null)
          setMessage("")
        }}
        onSubmit={(input) => void handleCreatePersona(input)}
      />
    )
  }
  /*
   * 候选预览：候选没有档案，但它有出场分布与原句可看。
   * 找不到对应候选时（例如数据还没读完）也停在面板里，
   * 不要往下掉进「角色档案」或「整页列表」——那会让点候选看起来像点错了地方。
   */
  if (candidateFocus) {
    const sighting = sightings.find((item) => item.characterName === candidateFocus)
    return (
      <div data-testid="persona-skill-view" className="ui-test-skills-gallery ui-test-gdoc">
        <div className="ui-test-gbody">
          <div className="ui-test-gbody-inner">
            {sighting ? (
              <PersonaCandidatePreview
                projectPath={projectPath}
                sighting={sighting}
                busy={busy}
                message={message}
                onPromote={() => void handlePromote(sighting)}
                onDelete={() => void handleDeleteSighting(sighting)}
              />
            ) : (
              <div className="ui-test-pdoc-empty-pane" data-testid="persona-pane-empty" />
            )}
          </div>
        </div>
      </div>
    )
  }


  if (selected) {
    if (loadedFor?.projectPath !== projectPath || loadedFor.id !== selected.id) return null
    return (
      <PersonaSkillProfilePanel
        meta={selected}
        outlineSources={selected.outlineRefs.flatMap((ref) => {
          const path = resolvePersonaOutlineRef(projectPath, ref, pathIndex)
          return path ? [{ ref, path }] : []
        }).filter((entry, index, all) => all.findIndex((item) => item.path === entry.path) === index)}
        onOpenOutline={async (path) => {
          const store = useWikiStore.getState()
          if (!(await store.setActiveView("sources"))) return
          store.setSelectedFile(path)
        }}
        document={documentText}
        research={research}
        revisionCount={revisionCount}
        resetToken={resetToken}
        busy={busy}
        message={message}
        onDirtyChange={setDraftDirty}
        onSaveProfile={({ fields, roleType }) => void handleSave(fields, roleType)}
        onSaveRaw={(text, roleType) => void handleSave(text, roleType)}
        onRestoreRevision={() => void handleRestoreRevision()}
        onRegenerateResearch={() => void handleRegenerateResearch()}
        onOpenCharacter={handleOpenCharacter}
        hasCharacter={hasCharacter}
        onChangeStatus={(choice) => void handleChangeStatus(selected, choice)}
        onToggleImportant={(next) => void handleToggleImportant(selected, next)}
        onToggleAutoUpdate={(next) => void handleToggleAutoUpdate(selected, next)}
        onDeletePersona={() => void handleDeletePersona(selected)}
      />
    )
  }

  /*
   * 面板模式下没有选中对象时不渲染旧的整页列表：左栏已经承担列表职责，
   * 两处都显示只会让人不知道该看哪个。这里留一块空白，不写指引文案。
   */
  if (paneMode) {
    return (
      <div data-testid="persona-skill-view" className="ui-test-skills-gallery ui-test-gdoc">
        <div className="ui-test-gbody">
          <div className="ui-test-gbody-inner">
            <div className="ui-test-pdoc-empty-pane" data-testid="persona-pane-empty" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div data-testid="persona-skill-view" className="ui-test-skills-gallery ui-test-pdoc">
      <div className="ui-test-pdoc-scroll">
        <div className="ui-test-pdoc-inner">
      <div className="ui-test-skills-toolbar">
        <label className="ui-test-skills-search">
          <Search />
          <input
            data-testid="persona-skill-search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索人物名"
          />
        </label>
        <button
          type="button"
          data-testid="persona-skill-create-toggle"
          onClick={() => setPersonaOutlinePane({ mode: "create" })}
          className="ui-test-skills-action is-primary"
        >
          新建人物角色
        </button>
        <div className="ui-test-skills-chips">
          {STATUS_ORDER.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={statusFilter === key}
              onClick={() => setStatusFilter(key)}
              className={`ui-test-skills-chip${statusFilter === key ? " is-active" : ""}`}
            >
              {key === "all" ? `全部 ${counts.all}` : `${PERSONA_STATUS_LABELS[key]} ${counts[key]}`}
            </button>
          ))}
        </div>
        <button
          type="button"
          data-testid="persona-skill-analysis-toggle"
          aria-pressed={analysisOpen}
          onClick={() => setAnalysisOpen((open) => !open)}
          className={`ui-test-skills-chip${analysisOpen ? " is-active" : ""}`}
        >
          出场频次分析
        </button>
      </div>

      {message ? <span className="ui-test-skills-message">{message}</span> : null}

      {analysisOpen ? (
        <section data-testid="persona-skill-analysis" className="ui-test-skills-section">
          <h4 className="ui-test-skills-section-title">出场频次分析</h4>
          <p className="ui-test-skills-section-hint">
            自动模式下，普通人物连续 {PERSONA_DORMANT_GAP_CHAPTERS} 章未出场转为潜伏，连续 {PERSONA_ARCHIVED_GAP_CHAPTERS} 章未出场转为归档。
          </p>
          {analysisRows.length === 0 ? (
            <p className="ui-test-skills-empty">没有需要关注的人物。</p>
          ) : (
            <div className="ui-test-skills-grid">
              {analysisRows.map((meta) => (
                <article
                  key={meta.id}
                  data-testid={`persona-skill-analysis-${meta.id}`}
                  className="ui-test-skill-card"
                >
                  <header className="ui-test-skill-card-head">
                    <h3 className="ui-test-skill-card-name" title={meta.characterName}>
                      {meta.characterName}
                    </h3>
                  </header>
                  <div className="ui-test-skill-card-badges">
                    <span className="ui-test-skill-badge is-type">{TIER_LABELS[meta.tier]}</span>
                    <span className="ui-test-skill-badge">首次第 {meta.firstChapter} 章</span>
                    <span className="ui-test-skill-badge">最近第 {meta.lastChapter} 章</span>
                    <span className="ui-test-skill-badge">{PERSONA_STATUS_LABELS[getEffectivePersonaStatus(meta)]}</span>
                    {meta.manualStatus ? (
                      <span className="ui-test-skill-badge is-type">手动设置</span>
                    ) : meta.status === "archived" ? (
                      <span className="ui-test-skill-badge is-type">建议归档</span>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {visible.length === 0 ? (
        <div className="ui-test-skills-empty">
          {index.skills.length === 0
            ? "还没有人物 Skill。点章节工具栏的「提取记忆」时，AI 会自动为主要人物建档。"
            : "没有匹配的人物。"}
        </div>
      ) : (
        <div className="ui-test-skills-grid">
          {visible.map((meta) => (
            <article
              key={meta.id}
              data-testid={`persona-skill-card-${meta.id}`}
              className="ui-test-skill-card"
            >
              <header className="ui-test-skill-card-head">
                <div className="ui-test-persona-card-headtext">
                  <span className="ui-test-persona-card-avatar" aria-hidden="true">
                    {meta.characterName.slice(0, 1)}
                  </span>
                  <div className="ui-test-persona-card-meta">
                    <h3 className="ui-test-skill-card-name" title={meta.characterName}>
                      {meta.characterName}
                    </h3>
                    <span className="ui-test-persona-card-sub">
                      出场 {meta.appearanceCount} 次 · 最近第 {meta.lastChapter} 章
                    </span>
                  </div>
                </div>
                {meta.pinned && <span className="ui-test-skill-badge">重要人物</span>}
              </header>
              <div className="ui-test-skill-card-badges">
                <span className="ui-test-skill-badge is-type">{TIER_LABELS[meta.tier]}</span>
                <span className="ui-test-skill-badge">{PERSONA_STATUS_LABELS[getEffectivePersonaStatus(meta)]}</span>
                {meta.roleType ? <span className="ui-test-skill-badge">{meta.roleType}</span> : null}
                <span className="ui-test-skill-badge">出场 {meta.appearanceCount} 次</span>
                {meta.editedByUser ? <span className="ui-test-skill-badge">已手改</span> : null}
                {meta.hasResearch ? <span className="ui-test-skill-badge">有研究文件</span> : null}
              </div>
              <div className="ui-test-skills-actions">
                <button
                  type="button"
                  className="ui-test-skills-action is-primary"
                  onClick={() => setPersonaOutlinePane({ mode: "persona", id: meta.id })}
                >
                  打开档案
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <section data-testid="persona-skill-candidates" className="ui-test-skills-section">
        <div className="ui-test-skills-section-head">
          <h4 className="ui-test-skills-section-title">候选人物（未建档）</h4>
          {sightings.length > 0 ? (
            <button
              type="button"
              data-testid="persona-skill-candidates-toggle"
              className="ui-test-skills-action is-small"
              aria-expanded={candidatesOpen}
              onClick={() => setCandidatesOpen((open) => !open)}
            >
              {candidatesOpen ? "收起" : `展开 ${sightings.length} 位`}
            </button>
          ) : null}
        </div>
        <p className="ui-test-skills-section-hint">
          这些名字在章节里出现过但还没建档。建档后可以在档案顶部的「状态」里移回候选区。
        </p>
        {sightings.length === 0 ? (
          <p className="ui-test-skills-empty">暂无候选人物</p>
        ) : !candidatesOpen ? (
          <div className="ui-test-skills-collapsed">
            <b>{sightings.length} 位候选</b>
            <span className="names">{sightings.slice(0, 8).map((s) => s.characterName).join(" · ")}</span>
            {sightings.length > 8 ? <span className="more">等 {sightings.length} 位</span> : null}
          </div>
        ) : (
          <div className="ui-test-skills-grid">
            {sightings.map((sighting) => (
              <article
                key={sighting.characterName}
                data-testid={`persona-skill-candidate-${sighting.characterName}`}
                className="ui-test-skill-card"
              >
                <header className="ui-test-skill-card-head">
                  <div className="ui-test-persona-card-headtext">
                    <span className="ui-test-persona-card-avatar" aria-hidden="true">
                      {sighting.characterName.slice(0, 1)}
                    </span>
                    <div className="ui-test-persona-card-meta">
                      <h3 className="ui-test-skill-card-name" title={sighting.characterName}>
                        {sighting.characterName}
                      </h3>
                      <span className="ui-test-persona-card-sub">候选 · 出场 {sighting.appearanceCount} 章</span>
                    </div>
                  </div>
                </header>
                <div className="ui-test-skill-card-badges">
                  {sighting.aliases.length > 0 ? (
                    <span className="ui-test-skill-badge">别名：{sighting.aliases.join("、")}</span>
                  ) : null}
                  <span className="ui-test-skill-badge">出场 {sighting.appearanceCount} 章</span>
                  <span className="ui-test-skill-badge">首次第 {sighting.firstChapter} 章</span>
                  <span className="ui-test-skill-badge">最近第 {sighting.lastChapter} 章</span>
                </div>
                {/*
                  这里原先复用了档案卡那枚绿勾（class 写死 is-on），于是渲染出来
                  永远是「已勾选」——它看着像重要角色开关，实际是「立即建档」动作，
                  而且没有取消分支。用户点它就是想把勾取消掉，结果只得到一次建档，
                  人还从候选区消失。改成一个说清后果的按钮。
                */}
                <div className="ui-test-skills-actions">
                  <button
                    type="button"
                    data-testid={`persona-skill-delete-sighting-${sighting.characterName}`}
                    className="ui-test-skills-action is-danger"
                    title="从候选区删除，且以后提取记忆不再加回"
                    onClick={() => void handleDeleteSighting(sighting)}
                    disabled={busy}
                  >
                    删除
                  </button>
                  <button
                    type="button"
                    data-testid={`persona-skill-promote-${sighting.characterName}`}
                    className="ui-test-skills-action is-primary"
                    title="建档并打开人物档案"
                    onClick={() => void handlePromote(sighting)}
                    disabled={busy}
                  >
                    建档
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
        </div>
      </div>
    </div>
  )
}
