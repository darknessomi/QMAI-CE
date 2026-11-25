import "@/components/uitest/ui-test-tools.css"
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AlertTriangle,
  ArrowLeft,
  FileText,
  RefreshCw,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { readFile } from "@/commands/fs"
import { WikiReader } from "@/components/editor/wiki-reader"
import { parseFrontmatter } from "@/lib/frontmatter"
import { useWikiStore } from "@/stores/wiki-store"
import { loadMemoryCenterData, type MemoryCenterData } from "@/lib/novel/memory-center"
import { hasPendingMemoryRefresh } from "@/lib/novel/memory-refresh-status"
import {
  MEMORY_TAB_ICONS,
  MEMORY_TAB_KEYS,
  MEMORY_TAB_LABEL_KEYS,
  isMemoryFileTab,
  resolveMemoryTabCount,
  selectChapterSnapshotCards,
  selectOutlineSnapshotCards,
  type MemoryTabKey,
} from "./memory-center-tabs"
import { SnapshotCollection } from "./memory-center-snapshots"

const SnapshotViewer = lazy(async () => {
  const mod = await import("@/components/novel/snapshot-viewer")
  return { default: mod.SnapshotViewer }
})

/**
 * 记忆中心：单个页面。
 *
 * 这里曾经是**嵌套两层双栏**：
 *   ① 外层 —— 中间栏（8 个记忆分类列表）↔ 右侧内容区；
 *   ② 内层 —— 内容区里的「章节列表 + 区间搜索」↔「快照详情」。
 *
 * 现在两层都拆了：分类变成页面顶部的标签条，内容独占整幅宽度；
 * 章节列表不再是竖栏，区间筛选降级成工具行，快照卡片全宽纵向堆叠。
 *
 * 随之消失的还有双栏赖以通信的那条全局状态：`selectedMemoryCenterEntry`
 * （写在 wiki-store，只有中间栏写、内容区读）。两栏并成一页后它没有存在意义，
 * 改成这里的 `activeTab`。所以这次是拆结构 + 拆耦合，不只是搬 UI。
 */

type SnapshotMarkdownDetail = {
  title: string
  content: string
  chapterNumber: number | null
}

type PendingDelete = {
  title: string
  chapterNumber: number
}

function markdownBody(markdown: string): string {
  const parsed = parseFrontmatter(markdown)
  return parsed.rawBlock ? parsed.body : markdown
}

/** 旧版快照 Markdown 带有图谱栏，仅在打开快照详情时过滤。 */
function snapshotMarkdownBody(markdown: string): string {
  const body = markdownBody(markdown)
  const graphHeading = /^##[ \t]+图谱(?:节点|关系边|边)[ \t]*$/m
  if (!graphHeading.test(body)) return body

  let hidden = false
  let fence = ""
  return body.split(/\r?\n/).filter(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1].startsWith(fence) && !marker[2].trim()) fence = ""
    } else if (!fence && /^#{1,2}(?:[ \t]|$)/.test(line)) {
      hidden = graphHeading.test(line)
    }
    return !hidden
  }).join("\n")
}

/**
 * 把元素滚入视野。
 *
 * 为什么要特性检测：jsdom 不实现 Element.prototype.scrollIntoView，
 * 直接调用会在 requestAnimationFrame 回调里抛出未处理异常 —— 测试仍然
 * "通过"，但进程会报 Errors 并以非 0 退出，而且时序相关、时有时无。
 * 浏览器（WebView2 / WKWebView）里有该方法，所以这不是用户可见缺陷，
 * 但未处理异常会污染测试与 Sentry，故统一在这里挡掉。
 */
export function scrollIntoViewIfSupported(
  element: HTMLElement | null | undefined,
  options: ScrollIntoViewOptions,
): void {
  if (!element) return
  if (typeof element.scrollIntoView !== "function") return
  element.scrollIntoView(options)
}

function snapshotNumberFromMarkdownPath(path: string): number | null {
  const fileName = path.replace(/\\/g, "/").split("/").pop() ?? ""
  const outlineMatch = fileName.match(/^outline-(\d+)\.snapshot\.md$/i)
  if (outlineMatch) return -Number(outlineMatch[1])
  const chapterMatch = fileName.match(/^(\d+)\.snapshot\.md$/i)
  if (chapterMatch) return Number(chapterMatch[1])
  return null
}

export function MemoryCenterView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)

  const [activeTab, setActiveTab] = useState<MemoryTabKey>("snapshots")
  const [data, setData] = useState<MemoryCenterData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState("")
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [detailView, setDetailView] = useState<SnapshotMarkdownDetail | null>(null)
  const [snapshotEditorNumber, setSnapshotEditorNumber] = useState<number | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [deleting, setDeleting] = useState(false)

  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef(new Map<MemoryTabKey, HTMLButtonElement>())
  const restoreScrollTop = useRef(0)
  const restoreFocusId = useRef<string | null>(null)
  const shouldRestorePosition = useRef(false)

  const projectPath = project?.path
  const latestLoad = useRef(0)

  const loadData = useCallback(async () => {
    const request = ++latestLoad.current
    if (!projectPath) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const next = await loadMemoryCenterData(projectPath)
      if (request === latestLoad.current) setData(next)
    } catch (err) {
      if (request !== latestLoad.current) return
      setError(err instanceof Error ? err.message : String(err))
      setData(null)
    } finally {
      if (request === latestLoad.current) setLoading(false)
    }
  }, [projectPath])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const refresh = async () => {
    if (!projectPath || loading) return
    setStatusMessage("")
    setLoading(true)
    try {
      if (await hasPendingMemoryRefresh(projectPath)) {
        const { finalizeProjectMemoryRebuild } = await import("@/lib/novel/chapter-ingest")
        await finalizeProjectMemoryRebuild(projectPath)
      }
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setLoading(false)
    }
  }

  // markdown 记忆文件按需读取：只有切到对应标签时才读盘。
  useEffect(() => {
    if (!data || !isMemoryFileTab(activeTab)) {
      setFileContent(null)
      setFileLoading(false)
      return
    }
    const file = data.files.find((item) => item.key === activeTab)
    if (!file) {
      setFileContent(null)
      setFileLoading(false)
      return
    }
    let cancelled = false
    setFileLoading(true)
    void readFile(file.path)
      .then((markdown) => {
        if (cancelled) return
        setFileContent(markdownBody(markdown))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setFileContent(null)
      })
      .finally(() => {
        if (!cancelled) setFileLoading(false)
      })
    return () => { cancelled = true }
  }, [activeTab, data])

  // 关闭详情后回到原来的滚动位置与焦点。
  useEffect(() => {
    if (detailView || !shouldRestorePosition.current) return
    shouldRestorePosition.current = false
    requestAnimationFrame(() => {
      const container = scrollContainerRef.current
      if (container) container.scrollTop = restoreScrollTop.current
      if (!restoreFocusId.current) return
      const target = document.getElementById(restoreFocusId.current)
      if (!(target instanceof HTMLElement)) return
      scrollIntoViewIfSupported(target, { block: "center" })
      target.focus({ preventScroll: true })
    })
  }, [detailView])

  const rememberOpenLocation = useCallback((focusId: string) => {
    restoreScrollTop.current = scrollContainerRef.current?.scrollTop ?? 0
    restoreFocusId.current = focusId
  }, [])

  const selectTab = useCallback((key: MemoryTabKey) => {
    setActiveTab(key)
    setDetailView(null)
    setStatusMessage("")
    // 标签条是单排横向滚动，选中的标签若在视野外要滚进来。
    requestAnimationFrame(() => {
      scrollIntoViewIfSupported(tabRefs.current.get(key), { block: "nearest", inline: "nearest" })
    })
  }, [])

  const openSnapshotDetail = useCallback(async (path: string, title: string, focusId: string) => {
    rememberOpenLocation(focusId)
    setError(null)
    try {
      const markdown = await readFile(path)
      setDetailView({
        title,
        content: snapshotMarkdownBody(markdown),
        chapterNumber: snapshotNumberFromMarkdownPath(path),
      })
      requestAnimationFrame(() => {
        const container = scrollContainerRef.current
        if (container) container.scrollTop = 0
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [rememberOpenLocation])

  const closeDetail = useCallback(() => {
    shouldRestorePosition.current = true
    setDetailView(null)
  }, [])

  const requestDeleteSnapshot = useCallback((chapterNumber: number, title: string) => {
    setPendingDelete({ title, chapterNumber })
  }, [])

  const requestDeleteDetail = useCallback(() => {
    if (!detailView || detailView.chapterNumber === null) return
    setPendingDelete({ title: detailView.title, chapterNumber: detailView.chapterNumber })
  }, [detailView])

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || !projectPath || deleting) return
    setDeleting(true)
    setError(null)
    try {
      const { deleteChapterSnapshots } = await import("@/lib/novel/chapter-ingest")
      await deleteChapterSnapshots(projectPath, pendingDelete.chapterNumber)
      bumpDataVersion()
      await loadData()
      setPendingDelete(null)
      setDetailView(null)
      setStatusMessage(t("novel.memoryCenter.deleteSuccess"))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }, [bumpDataVersion, deleting, loadData, pendingDelete, projectPath, t])

  const chapterCards = useMemo(() => selectChapterSnapshotCards(data), [data])
  const outlineCards = useMemo(() => selectOutlineSnapshotCards(data), [data])

  const stats = data?.stats
  const memoryEmpty = Boolean(data) && !loading
    && chapterCards.length === 0
    && outlineCards.length === 0
    && data!.files.length === 0

  const pageState = error
    ? "error"
    : detailView
      ? "detail"
      : loading && !data
        ? "loading"
        : memoryEmpty
          ? "empty"
          : "ready"

  return (
    <div data-ui-page="memory" data-ui-state={pageState} className="flex h-full flex-col">
      <div data-ui="tool-heading" className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <nav aria-label="面包屑" className="ui-test-breadcrumb">
            <span>{project?.name ?? "未选择项目"}</span>
            <span aria-hidden="true">/</span>
            <span aria-current="page">记忆中心</span>
          </nav>
          <h2 data-ui="tool-title" className="text-sm font-semibold">
            {detailView?.title ?? t("novel.memoryCenter.title")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {detailView
              ? t("novel.memoryCenter.snapshots.detailDescription")
              : t("novel.memoryCenter.description")}
          </p>
        </div>
        {detailView ? (
          <Button
            id="memory-center-close-detail"
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={closeDetail}
          >
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            {t("novel.memoryCenter.back")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {data?.refreshPending ? "重试记忆刷新" : t("novel.memoryCenter.refresh")}
          </Button>
        )}
      </div>

      {data?.refreshPending && (
        <p role="status" className="border-b px-4 py-2 text-sm">记忆或检索索引尚未刷新。重试会使用已保存的章节快照，无需重新提取。</p>
      )}

      {!detailView ? (
        <>
          {/* 统计条：保留原中间栏「一览各分类规模」的职能。 */}
          <div
            data-ui="memory-stats"
            className="flex shrink-0 flex-nowrap items-center gap-2 overflow-x-auto border-b px-4 py-2 text-xs"
          >
            {[
              ["novel.memoryCenter.stats.totalSnapshots", stats?.snapshotCount ?? 0],
              ["novel.memoryCenter.stats.synced", stats?.syncedSnapshotCount ?? 0],
              ["novel.memoryCenter.stats.characters", stats?.characterCount ?? 0],
              ["novel.memoryCenter.stats.foreshadowing", stats?.activeForeshadowingCount ?? 0],
            ].map(([labelKey, value]) => (
              <span
                key={String(labelKey)}
                className="shrink-0 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-muted-foreground"
              >
                {t(String(labelKey))} <b className="font-semibold text-foreground">{value}</b>
              </span>
            ))}
          </div>

          {/*
            标签条：单排、横向滚动，**绝不换行**。
            换行会读作"排错了"（本项目刚修过同类缺陷），横向滚动是可预期的。
          */}
          <div
            role="tablist"
            aria-label={t("novel.memoryCenter.title")}
            data-ui="memory-tabs"
            className="flex shrink-0 flex-nowrap items-center gap-1 overflow-x-auto border-b px-4 pt-2"
          >
            {MEMORY_TAB_KEYS.map((key) => {
              const Icon = MEMORY_TAB_ICONS[key]
              const selected = activeTab === key
              return (
                <button
                  key={key}
                  ref={(node) => {
                    if (node) tabRefs.current.set(key, node)
                    else tabRefs.current.delete(key)
                  }}
                  type="button"
                  role="tab"
                  id={`memory-tab-${key}`}
                  aria-selected={selected}
                  aria-controls={`memory-tabpanel-${key}`}
                  data-ui="memory-tab"
                  data-tab-key={key}
                  onClick={() => selectTab(key)}
                  className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 py-1.5 text-xs transition-colors ${
                    selected
                      ? "border-primary font-semibold text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span>{t(MEMORY_TAB_LABEL_KEYS[key])}</span>
                  <span className="text-muted-foreground">{resolveMemoryTabCount(key, data)}</span>
                </button>
              )
            })}
          </div>
        </>
      ) : null}

      {/*
        内容区本身就是 tabpanel —— 而不是在某个分支里再套一层。
        套在分支里会让「记忆文件」那几个标签没有对应的 tabpanel，
        aria-controls 就指向了不存在的元素。详情态没有标签条，也就不该声明 tabpanel。
      */}
      <div
        data-ui="memory-body"
        ref={scrollContainerRef}
        role={detailView ? undefined : "tabpanel"}
        id={detailView ? undefined : `memory-tabpanel-${activeTab}`}
        aria-labelledby={detailView ? undefined : `memory-tab-${activeTab}`}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        {error ? (
          <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {statusMessage ? (
          <div className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
            {statusMessage}
          </div>
        ) : null}

        {detailView ? (
          <MarkdownPanel
            dataUi="memory-detail"
            description={t("novel.memoryCenter.snapshots.detailDescription")}
            content={detailView.content}
            onDelete={detailView.chapterNumber === null ? undefined : requestDeleteDetail}
            t={t}
          />
        ) : isMemoryFileTab(activeTab) ? (
          fileLoading ? (
            <LoadingRow label={t("novel.memoryCenter.loading")} />
          ) : fileContent !== null ? (
            <MarkdownPanel
              dataUi="memory-detail"
              description="本页根据章节快照生成。要修改或删除一条记忆，请在「章节快照」中编辑对应章节。"
              content={fileContent}
              t={t}
            />
          ) : (
            <EmptyHint title={t("novel.memoryCenter.emptyFile")} hint="" />
          )
        ) : loading && !data ? (
          <LoadingRow label={t("novel.memoryCenter.loading")} />
        ) : memoryEmpty ? (
          <EmptyHint title={t("novel.memoryCenter.empty")} hint={t("novel.memoryCenter.emptyHint")} />
        ) : (
          <SnapshotCollection
            key={activeTab}
            cards={activeTab === "snapshots" ? chapterCards : outlineCards}
            variant={activeTab === "snapshots" ? "chapter" : "outline"}
            onOpen={(path, title, focusId) => void openSnapshotDetail(path, title, focusId)}
            onEdit={setSnapshotEditorNumber}
            onDelete={requestDeleteSnapshot}
            t={t}
          />
        )}
      </div>

      {snapshotEditorNumber !== null && project ? (
        <Suspense fallback={<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 text-sm text-white">{t("novel.snapshot.loading")}</div>}>
          <SnapshotViewer
            projectPath={project.path}
            chapterNumber={snapshotEditorNumber}
            onClose={() => {
              setSnapshotEditorNumber(null)
              void loadData()
            }}
          />
        </Suspense>
      ) : null}
      <DeleteMemoryConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.title ?? ""}
        deleting={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
        t={t}
      />
    </div>
  )
}

function LoadingRow({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
      {label}
    </div>
  )
}

function EmptyHint({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
      <FileText className="h-8 w-8 text-muted-foreground/30" />
      <p>{title}</p>
      {hint ? <p className="text-xs">{hint}</p> : null}
    </div>
  )
}

function MarkdownPanel({ dataUi, description, content, onDelete, t }: {
  dataUi: string
  description: string
  content: string
  onDelete?: () => void
  t: (key: string) => string
}) {
  return (
    <div data-ui={dataUi} className="rounded-lg border bg-background p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{description}</p>
        {onDelete && (
          <Button size="sm" variant="outline" className="border-destructive/50 text-destructive hover:bg-destructive/10" onClick={onDelete}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            {t("novel.memoryCenter.delete")}
          </Button>
        )}
      </div>
      <WikiReader body={content} />
    </div>
  )
}

function DeleteMemoryConfirmDialog({
  open,
  title,
  deleting,
  onCancel,
  onConfirm,
  t,
}: {
  open: boolean
  title: string
  deleting: boolean
  onCancel: () => void
  onConfirm: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4">
      <div className="w-full max-w-md rounded-lg border border-destructive/60 bg-background shadow-xl">
        <div className="flex items-start gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-3 text-destructive">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{t("novel.memoryCenter.deleteConfirmTitle")}</h3>
            <p className="mt-1 truncate text-xs opacity-80">{title}</p>
          </div>
        </div>
        <div className="px-4 py-4">
          <p className="text-sm leading-6 text-foreground">
            {t("novel.memoryCenter.deleteConfirmBody")}
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <Button type="button" variant="outline" disabled={deleting} onClick={onCancel}>
            {t("novel.memoryCenter.cancel")}
          </Button>
          <Button
            type="button"
            disabled={deleting}
            onClick={onConfirm}
            className="border border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleting ? t("novel.memoryCenter.deleting") : t("novel.memoryCenter.deleteConfirmAction")}
          </Button>
        </div>
      </div>
    </div>
  )
}
