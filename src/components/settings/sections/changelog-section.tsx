import { useState } from "react"
import { useTranslation } from "react-i18next"
import { allChangelog } from "@/lib/changelog"

const COLLAPSED_CHANGELOG_ITEM_COUNT = 5

export function ChangelogSection() {
  const { t, i18n } = useTranslation()
  const lang: "en" | "zh" = i18n.language?.startsWith("zh") ? "zh" : "en"
  const entries = allChangelog()
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(() => new Set())
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.changelog.title", { defaultValue: "软件更新日志" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          社区维护版 v{__APP_VERSION__}
        </p>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <a
          href="https://github.com/darknessomi/QMAI-CE/releases"
          target="_blank"
          rel="noreferrer"
          className="font-medium text-primary hover:underline"
        >
          社区版发布页
        </a>
      </div>

      {/* 完整版本历史 */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground">上游版本历史</h3>
        {entries.map((entry) => {
          const lines = entry.highlights[lang]
          const isExpanded = expandedVersions.has(entry.version)
          const hiddenCount = Math.max(0, lines.length - COLLAPSED_CHANGELOG_ITEM_COUNT)
          const visibleLines = isExpanded ? lines : lines.slice(0, COLLAPSED_CHANGELOG_ITEM_COUNT)
          return (
            <div
              key={entry.version}
              data-changelog-version={entry.version}
              className="rounded-lg border border-border/60 bg-muted/20 p-4"
            >
              <div className="flex items-baseline gap-3">
                <span className={`rounded px-2 py-0.5 text-sm font-semibold ${
                  entry.version === __APP_VERSION__
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground"
                }`}>
                  v{entry.version}
                </span>
                <span className="text-xs text-muted-foreground">{entry.date}</span>
              </div>
              <ul className="mt-3 space-y-2 text-sm leading-relaxed text-foreground/90">
                {visibleLines.map((line, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
              {hiddenCount > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    setExpandedVersions((current) => {
                      const next = new Set(current)
                      if (next.has(entry.version)) {
                        next.delete(entry.version)
                      } else {
                        next.add(entry.version)
                      }
                      return next
                    })
                  }}
                  className="mt-3 text-xs font-medium text-primary hover:underline"
                >
                  {isExpanded ? "收起" : `查看更多 ${hiddenCount} 条`}
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
