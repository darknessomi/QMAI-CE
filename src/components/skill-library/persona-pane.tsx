import { PersonaSkillView } from "./persona-skill-view"

export function PersonaPane() {
  return (
    <div className="h-full min-h-0" data-testid="persona-pane">
      <PersonaSkillView paneMode />
    </div>
  )
}
