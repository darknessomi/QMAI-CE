import { confirmAction } from "@/lib/confirm-action"
import { Fragment, useCallback, useEffect, useState } from "react"
import { Check, ChevronDown, ChevronRight, Trash2, User, UserPlus, Users } from "lucide-react"
import {
  deletePersonaSighting,
  promotePersonaSightingLocal,
} from "@/lib/novel/persona-skill-learning"
import { deleteFiledPersona } from "@/components/skill-library/delete-filed-persona"
import { usePersonaSkillState } from "@/components/skill-library/use-persona-skill-state"
import {
  getEffectivePersonaStatus,
  type PersonaSkillMeta,
  type PersonaSkillSighting,
} from "@/lib/novel/persona-skill-types"
import { useWikiStore } from "@/stores/wiki-store"

interface PersonaTreeSectionProps {
  /** 数据版本号：外部（建档 / 删除 / 学习）发生后 +1，用来触发重读。 */
  refreshKey?: number
  searchQuery?: string
}

type MenuState =
  | { kind: "candidate"; name: string; x: number; y: number }
  | { kind: "filed"; id: string; name: string; x: number; y: number }
  | null

const GROUPS = [
  { key: "active", label: "活跃角色" },
  { key: "dormant", label: "潜伏角色" },
  { key: "archived", label: "归档角色" },
  { key: "candidates", label: "候选角色" },
] as const
type GroupKey = typeof GROUPS[number]["key"]

export function PersonaTreeSection({ refreshKey = 0, searchQuery = "" }: PersonaTreeSectionProps) {
  const projectPath = useWikiStore((s) => s.project?.path)
  const personaOutlinePane = useWikiStore((s) => s.personaOutlinePane)
  const setPersonaOutlinePane = useWikiStore((s) => s.setPersonaOutlinePane)
  const bumpPersonaDataVersion = useWikiStore((s) => s.bumpPersonaDataVersion)
  const { index, sightings } = usePersonaSkillState(projectPath, refreshKey)
  const skills = index.skills
  const candidates = sightings.sightings
  const [expanded, setExpanded] = useState<Partial<Record<GroupKey, boolean>>>({})
  const [menu, setMenu] = useState<MenuState>(null)
  const [busy, setBusy] = useState(false)
  const revealSelectedRow = useCallback((row: HTMLButtonElement | null) => {
    row?.scrollIntoView?.({ block: "nearest" })
  }, [])

  const currentId = personaOutlinePane?.mode === "persona" ? personaOutlinePane.id : null
  const currentCandidate = personaOutlinePane?.mode === "candidate" ? personaOutlinePane.name : null
  const currentPersona = currentId ? skills.find((meta) => meta.id === currentId) : undefined
  const focusedGroup = currentCandidate ? "candidates" : currentPersona && getEffectivePersonaStatus(currentPersona)
  useEffect(() => {
    if (!focusedGroup) return
    setExpanded((previous) => previous[focusedGroup] ? previous : { ...previous, [focusedGroup]: true })
  }, [personaOutlinePane, focusedGroup])

  /*
   * 点空白处收起菜单。
   *
   * 这里**不能**监听 `contextmenu`：菜单正是被 contextmenu 打开的，
   * 同一个事件冒泡到 window 时会把刚打开的菜单立刻关掉 ——
   * 表现就是「右键完全没反应」（用户实测）。
   * 用 `mousedown` 收起，并且忽略菜单内部的按下（否则点菜单项会先关菜单、
   * 再触发 click，动作就丢了）。
   */
  useEffect(() => {
    if (!menu) return
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest(".ui-test-ptree-menu")) return
      setMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null)
    }
    window.addEventListener("mousedown", close)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("mousedown", close)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [menu])

  async function handlePromote(name: string) {
    if (!projectPath) return
    setBusy(true)
    try {
      const created = await promotePersonaSightingLocal({ projectPath, characterName: name })
      bumpPersonaDataVersion()
      if (useWikiStore.getState().project?.path !== projectPath) return
      if (created) setPersonaOutlinePane({ mode: "persona", id: created.id })
      else window.alert(`「${name}」已不在候选列表中，人物列表已刷新。`)
    } catch (err) {
      // 左栏没有消息区：失败必须显式告知，否则又是「点了没反应」。
      console.error("[PersonaTree] 建档失败:", err)
      window.alert(`「${name}」建档失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
      setMenu(null)
    }
  }

  async function handleDeleteCandidate(name: string) {
    if (!projectPath) return
    setBusy(true)
    try {
      const confirmed = await confirmAction(
        `确定删除候选人物「${name}」吗？\n\n之后提取记忆也不会再把它加回候选区。`,
      )
      if (!confirmed) return
      await deletePersonaSighting({ projectPath, characterName: name })
      bumpPersonaDataVersion()
    } catch (err) {
      console.error("[PersonaTree] 删除候选失败:", err)
      window.alert(`「${name}」删除失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
      setMenu(null)
    }
  }

  async function handleDeletePersona(id: string, name: string) {
    if (!projectPath) return
    setBusy(true)
    try {
      await deleteFiledPersona(projectPath, id, name, skills.some((person) => person.id !== id && person.characterName === name))
    } catch (err) {
      console.error("[PersonaTree] 删除角色失败:", err)
      window.alert(`「${name}」删除失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
      setMenu(null)
    }
  }

  const keyword = searchQuery.trim().toLowerCase()
  const searching = Boolean(keyword)
  const matchesName = (person: PersonaSkillMeta | PersonaSkillSighting) =>
    person.characterName.toLowerCase().includes(keyword) || person.aliases.some(alias => alias.toLowerCase().includes(keyword))
  const members: Record<GroupKey, Array<PersonaSkillMeta | PersonaSkillSighting>> = {
    active: [], dormant: [], archived: [], candidates: searching ? candidates.filter(matchesName) : candidates,
  }
  for (const person of skills) {
    if (!searching || matchesName(person)) members[getEffectivePersonaStatus(person)].push(person)
  }

  if (searching && GROUPS.every(({ key }) => members[key].length === 0)) {
    return <p role="status" className="px-2 py-4 text-center text-xs text-muted-foreground">没有找到匹配的人物</p>
  }

  return (
    <div data-testid="persona-tree-section" className="ui-test-ptree">
      {GROUPS.map(({ key, label }) => {
        const people = members[key]
        if (searching && !people.length) return null
        const groupOpen = searching || expanded[key] === true
        const Icon = key === "candidates" ? Users : User
        return (
          <Fragment key={key}>
            <button
              type="button"
              className="ui-test-ptree-row is-group"
              data-persona-status={key}
              aria-expanded={groupOpen}
              disabled={searching}
              data-testid={`persona-tree-${key}-toggle`}
              onClick={() => setExpanded((previous) => ({ ...previous, [key]: !previous[key] }))}
            >
              <span className="ui-test-ptree-toggle" aria-hidden="true">
                {groupOpen ? <ChevronDown /> : <ChevronRight />}
              </span>
              <Icon className="ui-test-ptree-ico" aria-hidden="true" />
              <span className="ui-test-ptree-name">{label}</span>
              <span className="ui-test-ptree-count">{people.length}</span>
            </button>
            {groupOpen && people.map((person) => {
              const filed = "id" in person
              const name = person.characterName
              const selected = filed ? currentId === person.id : currentCandidate === name
              return (
                <button
                  key={filed ? person.id : name}
                  ref={selected ? revealSelectedRow : undefined}
                  type="button"
                  data-persona-status={key}
                  data-testid={`persona-tree-${filed ? "item" : "candidate"}-${name}`}
                  className={`ui-test-ptree-row is-leaf${filed ? "" : " is-candidate"}${selected ? " is-on" : ""}`}
                  title={filed ? `${name} · ${person.roleType || "未标注"} · 出场 ${person.appearanceCount} 次 · 右键更多`
                    : `${name} · 候选 · 出场 ${person.appearanceCount} 章 · 右键可建档或删除`}
                  onClick={() => setPersonaOutlinePane(filed ? { mode: "persona", id: person.id } : { mode: "candidate", name })}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    const position = { x: event.clientX, y: event.clientY }
                    setMenu(filed ? { kind: "filed", id: person.id, name, ...position }
                      : { kind: "candidate", name, ...position })
                  }}
                >
                  <i className="ui-test-ptree-dot" aria-hidden="true" />
                  <span className="ui-test-ptree-name">{name}</span>
                  {filed && person.pinned && (
                    <span className="ui-test-ptree-check" title="重要人物（生成研究文件）">
                      <Check aria-hidden="true" />
                    </span>
                  )}
                  {filed && person.autoUpdate === false && (
                    <span className="ui-test-ptree-badge" title="已关闭随章节自动更新">冻</span>
                  )}
                </button>
              )
            })}
          </Fragment>
        )
      })}

      {menu ? (
        <ul
          className="ui-test-ptree-menu"
          style={{ left: menu.x, top: menu.y }}
          data-testid="persona-tree-menu"
        >
          {menu.kind === "candidate" ? (
            <>
              <li>
                <button
                  type="button"
                  data-testid="persona-tree-menu-promote"
                  disabled={busy}
                  onClick={() => void handlePromote(menu.name)}
                >
                  <UserPlus aria-hidden="true" /> 建档
                </button>
              </li>
              <li>
                <button
                  type="button"
                  data-testid="persona-tree-menu-delete-candidate"
                  className="is-danger"
                  disabled={busy}
                  onClick={() => void handleDeleteCandidate(menu.name)}
                >
                  <Trash2 aria-hidden="true" /> 删除
                </button>
              </li>
            </>
          ) : (
            <>
              <li>
                <button
                  type="button"
                  data-testid="persona-tree-menu-open"
                  disabled={busy}
                  onClick={() => {
                    setPersonaOutlinePane({ mode: "persona", id: menu.id })
                    setMenu(null)
                  }}
                >
                  <User aria-hidden="true" /> 打开档案
                </button>
              </li>
              <li>
                <button
                  type="button"
                  data-testid="persona-tree-menu-delete-persona"
                  className="is-danger"
                  disabled={busy}
                  onClick={() => void handleDeletePersona(menu.id, menu.name)}
                >
                  <Trash2 aria-hidden="true" /> 删除角色
                </button>
              </li>
            </>
          )}
        </ul>
      ) : null}
    </div>
  )
}
