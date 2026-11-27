import "@/components/uitest/ui-test-tools.css"
import { useState, useCallback, useEffect, useRef, memo } from "react"
import { Search, FileText } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile } from "@/commands/fs"
import type { SearchResult } from "@/lib/search"
import { useTranslation } from "react-i18next"
import { normalizePath } from "@/lib/path-utils"
import { isImeComposing } from "@/lib/keyboard-utils"

const MAX_HISTORY = 20
const SEARCH_PAGE_TOP_K = 20
const STOP_WORDS = new Set([
  "的", "是", "了", "在", "有", "和", "中", "对", "们",
  "the", "is", "a", "an", "what", "how", "are", "was", "were",
  "do", "does", "did", "be", "been", "being", "have", "has", "had",
  "it", "its", "in", "on", "at", "to", "for", "of", "with", "by",
  "this", "that", "these", "those",
])

interface NovelSearchUiOptions {
  includeKeyword: boolean
  includeGraph: boolean
  includeRecentChapters: boolean
  includeCanon: boolean
}

function tokenizeSearchQuery(query: string): string[] {
  const rawTokens = query
    .toLowerCase()
    .split(/[\s,锛屻€傦紒锛熴€侊紱:"''锛堬級()\-_/\\路~锝炩€?]+/)
    .filter((token) => token.length > 1)
    .filter((token) => !STOP_WORDS.has(token))

  const tokens: string[] = []
  for (const token of rawTokens) {
    const hasCjk = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token)
    if (hasCjk && token.length > 2) {
      const chars = [...token]
      for (let index = 0; index < chars.length - 1; index += 1) {
        tokens.push(chars[index] + chars[index + 1])
      }
      for (const char of chars) {
        if (!STOP_WORDS.has(char)) tokens.push(char)
      }
    }
    tokens.push(token)
  }

  return [...new Set(tokens)]
}

function shouldUseAdvancedNovelSearch(options: NovelSearchUiOptions): boolean {
  return (
    options.includeGraph ||
    options.includeRecentChapters ||
    options.includeCanon ||
    !options.includeKeyword
  )
}

async function runWikiPanelSearch(
  projectPath: string,
  query: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const { searchWiki } = await import("@/lib/search")
  return searchWiki(projectPath, query, { topK: SEARCH_PAGE_TOP_K, recheckPageVisibility: true, signal })
}

async function runNovelPanelSearch(
  projectPath: string,
  query: string,
  options: NovelSearchUiOptions,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (
    !options.includeKeyword &&
    !options.includeGraph &&
    !options.includeRecentChapters &&
    !options.includeCanon
  ) {
    return []
  }

  if (!shouldUseAdvancedNovelSearch(options)) {
    console.log("[Search] using minimal novel keyword search")
    return runWikiPanelSearch(projectPath, query, signal)
  }

  console.log("[Search] using advanced novel mixed search")
  const { searchPlot } = await import("@/lib/novel/search-adapter")
  const novelResults = await searchPlot(projectPath, query, { ...options, signal })
  return novelResults.map((result) => ({
    path: result.path,
    title: result.title,
    snippet: result.snippet,
    score: result.relevance,
  }))
}

function getHistoryKey(projectId: string): string {
  return `qmai_search_history_${projectId}`
}

function loadSearchHistory(projectId: string): string[] {
  try {
    const raw = localStorage.getItem(getHistoryKey(projectId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string" && item.length > 0)
    return []
  } catch {
    return []
  }
}

function saveSearchHistory(projectId: string, history: string[]): void {
  try {
    localStorage.setItem(getHistoryKey(projectId), JSON.stringify(history.slice(0, MAX_HISTORY)))
  } catch { /* ignore */ }
}

interface SearchViewProps {
  onClose?: () => void
  onOpenFile?: (payload: { path: string }) => Promise<void> | void
}

export function SearchView({ onClose, onOpenFile }: SearchViewProps) {
  const { t } = useTranslation()
  const novelMode = useWikiStore((s) => s.novelMode)
  const jevConfig = useWikiStore((s) => s.jevConfig)
  const jevError = useWikiStore((s) => s.jevConfigLoadError)
  const project = useWikiStore((s) => s.project)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setSearchPanelOpen = useWikiStore((s) => s.setSearchPanelOpen)
  const setSearchHistory = useWikiStore((s) => s.setSearchHistory)
  const searchTrigger = useWikiStore((s) => s.searchTrigger)
  const setSearchTriggerInStore = useWikiStore((s) => s.setSearchTrigger)

  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  const [evidenceOnly, setEvidenceOnly] = useState(false)
  const [fromChapter, setFromChapter] = useState("")
  const [toChapter, setToChapter] = useState("")
  const [coverage, setCoverage] = useState("")
  const request = useRef(0)
  const evidenceScan = useRef<AbortController | null>(null)
  useEffect(() => {
    request.current++
    setCoverage("")
    setResults([])
    setSearching(false)
    setHasSearched(false)
    return () => {
      request.current++
      evidenceScan.current?.abort()
    }
  }, [project?.id, evidenceOnly, fromChapter, toChapter, jevConfig, jevError])

  const [searchOpts, setSearchOpts] = useState<NovelSearchUiOptions>({
    includeKeyword: true,
    includeGraph: false,
    includeRecentChapters: false,
    includeCanon: false,
  })

  const toggleSearchOpt = useCallback((key: keyof NovelSearchUiOptions) => {
    setSearchOpts((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  useEffect(() => {
    if (!project?.id) return
    const loaded = loadSearchHistory(project.id)
    if (loaded.length > 0) setSearchHistory(loaded)
  }, [project?.id, setSearchHistory])

  const doSearch = useCallback(
    async (q: string) => {
      const id = ++request.current
      evidenceScan.current?.abort()
      setCoverage("")
      console.log("[Search] START", q, "novelMode=", novelMode)
      if (!project || !q.trim()) {
        console.log("[Search] SKIP - no project or empty query")
        setResults([])
        setSearching(false)
        setHasSearched(false)
        return
      }
      setSearching(true)
      setHasSearched(true)
      const trimmedQuery = q.trim()
      const current = useWikiStore.getState().searchHistory
      const filtered = current.filter((h) => h !== trimmedQuery)
      const next = [trimmedQuery, ...filtered].slice(0, MAX_HISTORY)
      saveSearchHistory(project.id, next)
      setSearchHistory(next)
      try {
        const projectPath = normalizePath(project.path)
        const controller = new AbortController()
        evidenceScan.current = controller
        if (novelMode && evidenceOnly) {
          const { chapterBound, searchChapterEvidence } = await import("@/lib/novel/chapter-evidence")
          const { hits, coverage } = await searchChapterEvidence(`${projectPath}/wiki/chapters`, trimmedQuery, {
            from: chapterBound(fromChapter), to: chapterBound(toChapter), signal: controller.signal,
          })
          if (id !== request.current) return
          setCoverage(coverage)
          setResults(hits.map(hit => ({
            path: hit.path, title: `第${hit.number}章 · ${hit.title}`, snippet: hit.quote, score: 1,
          })))
        } else if (novelMode && !jevConfig && !jevError) {
          const t0 = performance.now()
          const novelResults = await runNovelPanelSearch(projectPath, q, searchOpts, controller.signal)
          console.log("[Search] novel panel search done in", Math.round(performance.now() - t0), "ms, got", novelResults.length, "results")
          if (id === request.current) setResults(novelResults)
        } else {
          const t0 = performance.now()
          const found = await runWikiPanelSearch(projectPath, q, controller.signal)
          console.log("[Search] searchWiki done in", Math.round(performance.now() - t0), "ms, got", found.length, "results")
          if (id === request.current) setResults(found)
        }
      } catch (err) {
        if (id !== request.current) return
        setCoverage(`${evidenceOnly ? "原文查证未完成" : "搜索未完成"}：${err instanceof Error ? err.message : String(err)}`)
        console.error("[Search] FAILED:", err)
        setResults([])
      } finally {
        console.log("[Search] FINISHED, searching=", false)
        if (id === request.current) setSearching(false)
      }
    },
    [project, novelMode, jevConfig, jevError, searchOpts, setSearchHistory, evidenceOnly, fromChapter, toChapter],
  )

  useEffect(() => {
    if (searchTrigger) {
      setQuery(searchTrigger.query)
      doSearch(searchTrigger.query)
      setSearchTriggerInStore(null)
    }
  }, [searchTrigger, doSearch, setSearchTriggerInStore])

  const handleOpen = useCallback(
    async (path: string) => {
      try {
        if (onOpenFile) {
          await onOpenFile({ path })
          return
        }
        const content = await readFile(path)
        if (!(await setActiveView("wiki"))) return
        setSearchPanelOpen(false)
        if (!(await setSelectedFile(path))) return
        setFileContent(content)
        onClose?.()
      } catch (err) {
        console.error("Failed to open search result:", err)
      }
    },
    [onClose, onOpenFile, setActiveView, setFileContent, setSearchPanelOpen, setSelectedFile],
  )

  return (
    <div data-ui-page="search" data-ui-state={(searching ? "loading" : !hasSearched ? "idle" : results.length ? "results" : "empty")} className="flex h-full flex-col overflow-hidden">
      {(
        <header data-ui="tool-heading"><div>
          <nav aria-label="面包屑" className="ui-test-breadcrumb"><span>{project?.name ?? "未选择项目"}</span><span aria-hidden="true">/</span><span aria-current="page">搜索</span></nav>
          <h1 className="ui-test-page-title">找到故事的线索。</h1>
        </div></header>
      )}
      <div data-ui="search-query" className="shrink-0 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              aria-label="搜索书内内容"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return
                if (e.key === "Enter") doSearch(query)
              }}
              placeholder={evidenceOnly && novelMode ? "输入定稿中的原词或短句" : t(novelMode ? "novel.search.placeholder" : "search.placeholder")}
              autoFocus
              className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-md border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              关闭
            </button>
          ) : null}
        </div>
        {novelMode && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={evidenceOnly} onChange={e => setEvidenceOnly(e.target.checked)} />
              定稿原文查证
            </label>
            {evidenceOnly ? <>
              <input type="number" min="1" aria-label="起始章号" placeholder="起始章" value={fromChapter}
                onChange={e => setFromChapter(e.target.value)} className="w-20 rounded border px-1 text-xs" />
              <input type="number" min="1" aria-label="结束章号" placeholder="结束章" value={toChapter}
                onChange={e => setToChapter(e.target.value)} className="w-20 rounded border px-1 text-xs" />
            </> : jevError || jevConfig ? <span className="text-xs text-muted-foreground">{jevError || "SAG2 原文检索"}</span> : ([
              ["keyword", "includeKeyword"],
              ["graph", "includeGraph"],
              ["recentChapters", "includeRecentChapters"],
              ["canon", "includeCanon"],
            ] as const).map(([labelKey, optKey]) => {
              const active = searchOpts[optKey] as boolean
              return (
                <button
                  key={optKey}
                  type="button"
                  onClick={() => toggleSearchOpt(optKey)}
                  className={`rounded-full px-2.5 py-0.5 text-[0.6875rem] font-medium transition-colors ${
                    active
                      ? "bg-primary/10 text-primary ring-1 ring-primary/30"
                      : "bg-muted text-muted-foreground hover:bg-muted/80"
                  }`}
                >
                  {t(`novel.search.${labelKey}`)}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {coverage && <div role="status" className="px-4 py-2 text-xs text-muted-foreground">{coverage}</div>}
      {searching ? (
        <div className="flex-1 p-4 text-center text-sm text-muted-foreground">
          {t("search.searching")}
        </div>
      ) : !hasSearched ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
          <Search className="h-8 w-8 text-muted-foreground/30" />
          <p>{t("search.pressEnter")}</p>
        </div>
      ) : results.length === 0 ? (
        <div className="flex-1 p-4 text-center text-sm text-muted-foreground">
          {!coverage && !(novelMode && evidenceOnly) && <>{t(novelMode ? "novel.search.noResults" : "search.noResults")} <span className="font-medium">"{query}"</span></>}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 px-3 pt-3 pb-1 text-xs text-muted-foreground">
            {t("search.pageCount", { count: results.length })}
          </div>

          <div className="shrink-0 px-3 pt-1">
            <SectionHeader
              icon={<FileText className="h-3.5 w-3.5" />}
              label={t("search.pagesSection")}
              count={results.length}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-3">
            <div className="flex flex-col gap-1">
              {results.map((result) => (
                <SearchResultCard
                  key={JSON.stringify([result.path, result.startLine, result.endLine])}
                  result={result}
                  query={query}
                  path={result.path}
                  onOpen={handleOpen}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SectionHeader({
  icon,
  label,
  count,
}: {
  icon: React.ReactNode
  label: string
  count: number
}) {
  return (
    <div className="flex items-center justify-between border-b pb-1">
      <div className="flex items-center gap-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
        <span className="text-muted-foreground/60">({count})</span>
      </div>
    </div>
  )
}

const SearchResultCard = memo(function SearchResultCard({
  result,
  query,
  path,
  onOpen,
}: {
  result: SearchResult
  query: string
  path: string
  onOpen: (path: string) => void
}) {
  const shortPath = result.path.split("/wiki/").pop() ?? result.path

  return (
    <button
      type="button"
      onClick={() => onOpen(path)}
      className="w-full rounded-lg border p-3 text-left text-sm hover:bg-accent transition-colors"
    >
      <div className="flex items-start gap-2 mb-1.5">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">
            <HighlightedText text={result.title} query={query} />
          </div>
          <div className="text-[0.6875rem] text-muted-foreground truncate">{shortPath}</div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground line-clamp-2">
        {result.startLine !== undefined && <span className="mr-1">第 {result.startLine}–{result.endLine} 行</span>}
        <HighlightedText text={result.snippet} query={query} />
      </p>
    </button>
  )
})

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>

  const tokens = tokenizeSearchQuery(query)
  const patterns = tokens.length > 0 ? tokens : [query.trim()]
  const escapedTokens = patterns.map(escapeRegex).join("|")
  const regex = new RegExp(`(${escapedTokens})`, "gi")
  const parts = text.split(regex)

  return (
    <>
      {parts.map((part, i) =>
        i % 2 !== 0 ? (
          <mark key={i} className="bg-yellow-200 dark:bg-yellow-800 rounded px-0.5">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
