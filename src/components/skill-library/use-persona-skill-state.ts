import { useEffect, useState } from "react"
import { loadPersonaSkillState, type PersonaSkillState } from "@/lib/novel/persona-skill-store"
import { useWikiStore } from "@/stores/wiki-store"

const emptyState: PersonaSkillState = {
  index: { version: 1, skills: [] },
  sightings: { version: 1, sightings: [] },
}

export function usePersonaSkillState(projectPath?: string, refreshKey = 0): PersonaSkillState {
  const version = useWikiStore((state) => state.personaDataVersion)
  const [loaded, setLoaded] = useState<{ path: string; state: PersonaSkillState }>()
  useEffect(() => {
    if (!projectPath) return
    let current = true
    void loadPersonaSkillState(projectPath).then(({ index, sightings }) => {
      if (!current) return
      // 两个名单只在显示时排序。同分沿用原索引顺序，重建时仍能回到原位。
      const skills = [...index.skills].sort((a, b) =>
        Number(b.pinned) - Number(a.pinned) || b.appearanceCount - a.appearanceCount)
      const candidates = [...sightings.sightings].sort((a, b) =>
        b.lastChapter - a.lastChapter || b.appearanceCount - a.appearanceCount)
      setLoaded({ path: projectPath, state: {
        index: { ...index, skills }, sightings: { ...sightings, sightings: candidates },
      } })
    }).catch((error) => console.warn("读取人物档案失败", error))
    return () => { current = false }
  }, [projectPath, refreshKey, version])
  return loaded && loaded.path === projectPath ? loaded.state : emptyState
}
