import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import { useWikiStore, type ModelSettingsTabId } from "@/stores/wiki-store"
import { LlmProviderSection } from "./llm-provider-section"
import { JevModelSettings } from "@/components/uitest/models/jev-model"
import { DefaultModelSettingsPanel } from "./default-model-settings-panel"

type ModelTabId = ModelSettingsTabId

/**
 * 说明：设置页实际渲染的是 settings-view.tsx 里的 UiTestModelSettingsSection，
 * 本组件是同一套页签的另一份实现（当前仅测试引用）。教程链接两处都挂，
 * 避免将来切回这份实现时少了入口。
 */

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

/**
 * 模型设置聚合页：左侧设置分类中的「模型设置」入口进入本页。
 * 页面上方按用途切换模型配置，
 * 默认选中「大语言模型」。
 */
export function ModelSettingsSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()

  const TABS: Array<{ id: ModelTabId; label: string }> = [
    { id: "default", label: t("settings.categories.defaultModel", { defaultValue: "默认模型" }) },
    { id: "llm", label: t("settings.categories.llm", { defaultValue: "大语言模型" }) },
    { id: "jev", label: "SAG2 决策模型" },
  ]

  const requestedTab = useWikiStore((s) => s.activeModelSettingsTab)
  const setRequestedTab = useWikiStore((s) => s.setActiveModelSettingsTab)
  const [active, setActive] = useState<ModelTabId>(() => requestedTab ?? "llm")
  // 三个「要自己填密钥/地址」的页签才给教程入口。

  useEffect(() => {
    if (!requestedTab) return
    setActive(requestedTab)
    setRequestedTab(null)
  }, [requestedTab, setRequestedTab])

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.categories.model", { defaultValue: "模型设置" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          配置写作模型和检索使用的 SAG2 决策模型。
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-0">
        <div role="tablist" aria-label="模型设置" className="flex flex-wrap gap-2">
          {TABS.map((tab) => {
            const isActive = active === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActive(tab.id)}
                className={`rounded-t-md border-b-2 px-4 py-2 text-sm transition-colors ${
                  isActive
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="min-h-0 pt-2">
        {active === "llm" && <LlmProviderSection />}
        {active === "default" && <DefaultModelSettingsPanel draft={draft} setDraft={setDraft} />}
        {active === "jev" && <JevModelSettings />}
      </div>
    </div>
  )
}