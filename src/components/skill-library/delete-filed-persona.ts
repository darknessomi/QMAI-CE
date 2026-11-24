import { confirmAction } from "@/lib/confirm-action"
import { removePersonaFromProject } from "@/lib/novel/persona-outline-detach"
import { useWikiStore } from "@/stores/wiki-store"

export async function deleteFiledPersona(projectPath: string, id: string, name: string, hasSameName: boolean) {
  function isSelected() {
    const { project, personaOutlinePane } = useWikiStore.getState()
    return project?.path === projectPath && personaOutlinePane?.mode === "persona" && personaOutlinePane.id === id
  }

  const label = hasSameName ? `「${name}」（档案编号：${id}）` : `「${name}」`
  const discardsDraft = isSelected() && useWikiStore.getState().personaSkillLibraryDraftDirty
  const confirmed = await confirmAction(
    `确定从人物列表删除${label}吗？\n\n已保存的档案文件会保留在项目里。` +
      (discardsDraft ? "\n当前档案未保存的修改会被放弃。" : ""),
  )
  if (!confirmed) return

  const removed = await removePersonaFromProject(projectPath, [id])
  const state = useWikiStore.getState()
  if (isSelected()) {
    state.setPersonaSkillLibraryDraftDirty(false)
    state.setPersonaOutlinePane(null)
  }
  state.bumpPersonaDataVersion()
  return removed.length > 0
}
