import { useCallback, useEffect, useRef, useState } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { IconSidebar } from "./icon-sidebar"
import { SidebarPanel } from "./sidebar-panel"
import { ContentArea } from "./content-area"
import { ErrorBoundary } from "@/components/error-boundary"
import { clampSidebarWidth } from "@/lib/workspace-layout"
import { useTranslation } from "react-i18next"
import { HelpCircle, X } from "lucide-react"

const USAGE_GUIDE_PROMPT_DISMISSED_KEY = "qmai-usage-guide-prompt-dismissed"

interface AppLayoutProps {
  onSwitchProject: () => void
}

export function AppLayout({ onSwitchProject }: AppLayoutProps) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const activeView = useWikiStore((s) => s.activeView)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setActiveSettingsCategory = useWikiStore((s) => s.setActiveSettingsCategory)
  const [leftWidth, setLeftWidth] = useState(220)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [usageGuidePromptDismissed, setUsageGuidePromptDismissed] = useState(() => {
    if (typeof localStorage === "undefined") return false
    return localStorage.getItem(USAGE_GUIDE_PROMPT_DISMISSED_KEY) === "1"
  })
  const isDraggingLeft = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const loadFileTree = useCallback(async () => {
    if (!project) return
    await refreshProjectFileTree(project.path, {
      projectId: project.id,
      clearDisplayTreeFirst: false,
    })
  }, [project])

  useEffect(() => {
    loadFileTree()
  }, [loadFileTree])

  const startDrag = useCallback(
    (side: "left") => (e: React.MouseEvent) => {
      e.preventDefault()
      if (side === "left") isDraggingLeft.current = true
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"
      document.body.dataset.panelResizing = "true"

      const handleMouseMove = (e: MouseEvent) => {
        if (!containerRef.current) return
        const rect = containerRef.current.getBoundingClientRect()

        if (isDraggingLeft.current) {
          const newWidth = e.clientX - rect.left
          setLeftWidth(clampSidebarWidth(newWidth))
        }
      }

      const handleMouseUp = () => {
        isDraggingLeft.current = false
        document.body.style.cursor = ""
        document.body.style.userSelect = ""
        delete document.body.dataset.panelResizing
        document.removeEventListener("mousemove", handleMouseMove)
        document.removeEventListener("mouseup", handleMouseUp)
      }

      document.addEventListener("mousemove", handleMouseMove)
      document.addEventListener("mouseup", handleMouseUp)
    },
    []
  )

  // Settings is a full-width admin view — the file tree / activity panel
  // are irrelevant there and their narrow column makes the settings form
  // cramped. Hide both the left sidebar (and the file preview on the
  // right) so the settings screen uses the whole content area.
  const isSettings = activeView === "settings"
  // Novel mode keeps the writing editor inside the chapter workspace only.
  // Outline/search/graph views no longer mount a secondary preview panel.

  useEffect(() => {
    const savedCollapsed = localStorage.getItem("lk-sidebar-collapsed")
    if (savedCollapsed === "1") {
      setSidebarCollapsed(true)
    }
  }, [])

  useEffect(() => {
    localStorage.setItem("lk-sidebar-collapsed", sidebarCollapsed ? "1" : "0")
  }, [sidebarCollapsed])

  const dismissUsageGuidePrompt = useCallback(() => {
    setUsageGuidePromptDismissed(true)
    localStorage.setItem(USAGE_GUIDE_PROMPT_DISMISSED_KEY, "1")
  }, [])

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {!isSettings && !usageGuidePromptDismissed && (
        <div className="fixed bottom-4 left-14 z-50 w-56 rounded-lg border border-primary/40 bg-background/95 p-3 shadow-xl backdrop-blur">
          <button
            type="button"
            onClick={dismissUsageGuidePrompt}
            className="absolute right-2 top-2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("common.close")}
            aria-label={t("appLayout.usageGuidePrompt.close")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              dismissUsageGuidePrompt()
              setActiveSettingsCategory("usage-guide")
              setActiveView("settings")
            }}
            className="flex w-full items-start gap-2 pr-5 text-left"
          >
            <span className="mt-0.5 rounded-md bg-primary/10 p-1.5 text-primary">
              <HelpCircle className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t("appLayout.usageGuidePrompt.title")}</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                {t("appLayout.usageGuidePrompt.description")}
              </span>
            </span>
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <IconSidebar
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
          onOpenSidebar={() => setSidebarCollapsed(false)}
          onSwitchProject={onSwitchProject}
        />
        <div ref={containerRef} className="flex min-w-0 min-h-0 flex-1 overflow-hidden">
        {!isSettings && !sidebarCollapsed && (
          <>
            <div
              className="flex shrink-0 flex-col overflow-hidden border-r"
              style={{ width: leftWidth }}
            >
              <div className="min-h-0 flex-1 overflow-hidden">
                <SidebarPanel />
              </div>
            </div>
            <div
              className="w-1 shrink-0 cursor-col-resize bg-border/20 transition-colors hover:bg-primary/25 active:bg-primary/30"
              onMouseDown={startDrag("left")}
            />
          </>
        )}
        <div className="min-w-0 min-h-0 flex-1 overflow-hidden">
          <ErrorBoundary>
            <ContentArea />
          </ErrorBoundary>
        </div>
        </div>
      </div>
    </div>
  )
}
