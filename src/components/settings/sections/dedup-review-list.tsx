import { useMemo, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { normalizeGroupKey, type DuplicateGroup } from "@/lib/dedup"
import type { DedupScanCacheEntry } from "@/lib/dedup-scan-cache"

const levels = ["high", "medium", "low"] as const
type Level = DuplicateGroup["confidence"]
export const confidenceLabels = { high: "高置信度", medium: "中置信度", low: "低置信度" }
const pageSize = 25

export function useReviewPage(count: number) {
  const [requested, setPage] = useState(1)
  const total = Math.max(1, Math.ceil(count / pageSize))
  const page = Math.min(requested, total)
  return { page, total, start: (page - 1) * pageSize, end: page * pageSize, setPage }
}

export function ReviewPageNav({ page, total, setPage }: ReturnType<typeof useReviewPage>) {
  if (total < 2) return null
  return (
    <nav aria-label="翻页" className="flex items-center gap-2 text-xs text-muted-foreground">
      <Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</Button>
      <span>第 {page} / {total} 页</span>
      <Button size="sm" variant="outline" disabled={page === total} onClick={() => setPage(page + 1)}>下一页</Button>
    </nav>
  )
}

interface Props {
  entries: DedupScanCacheEntry[]
  queued: ReadonlyMap<string, unknown>
  busy: boolean
  mergeReady: boolean
  onBatchMerge: (entries: DedupScanCacheEntry[]) => void
  renderCard: (entry: DedupScanCacheEntry, key: string, checkbox: ReactNode) => ReactNode
}

export function DedupReviewList({ entries, queued, busy, mergeReady, onBatchMerge, renderCard }: Props) {
  const [active, setActive] = useState<Level>("high")
  // Only store explicit decisions. Refreshes and edits to a main entry must preserve them.
  const [overrides, setOverrides] = useState(() => new Map<string, boolean>())
  const buckets = useMemo(() => {
    type Row = { key: string; entry: DedupScanCacheEntry }
    const result: Record<Level, Row[]> = { high: [], medium: [], low: [] }
    for (const entry of entries) {
      result[entry.group.confidence].push({ key: normalizeGroupKey(entry.group.slugs), entry })
    }
    return result
  }, [entries])
  const level = buckets[active].length ? active : levels.find((item) => buckets[item].length) ?? active
  const pagination = useReviewPage(buckets[level].length)
  const rows = buckets[level].slice(pagination.start, pagination.end)
  const eligible = useMemo(() => levels.flatMap((item) => buckets[item]).filter(({ key }) => !queued.has(key)), [buckets, queued])
  const selected = useMemo(() => eligible.filter(({ key, entry }) =>
    overrides.get(key) ?? entry.group.confidence === "high"), [eligible, overrides])
  const selectedKeys = useMemo(() => new Set(selected.map(({ key }) => key)), [selected])
  const canSelect = ({ key }: typeof rows[number]) => !queued.has(key) && !selectedKeys.has(key)

  function select(items: typeof rows, checked: boolean) {
    setOverrides((previous) => {
      const next = new Map(previous)
      for (const { key } of items) {
        if (!queued.has(key)) next.set(key, checked)
      }
      return next
    })
  }

  return (
    <section aria-label="重复候选" className="space-y-3">
      <div role="group" aria-label="按置信度分组" className="flex flex-wrap gap-2">
        {levels.map((item) => (
          <Button
            key={item}
            size="sm"
            variant={item === level ? "default" : "outline"}
            aria-pressed={item === level}
            disabled={!buckets[item].length}
            onClick={() => {
              setActive(item)
              pagination.setPage(1)
            }}
          >
            {confidenceLabels[item]}（{buckets[item].length}）
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy || !rows.some(canSelect)} onClick={() => select(rows, true)}>
          选中本页
        </Button>
        <Button size="sm" variant="outline" disabled={busy || !buckets[level].some(canSelect)} onClick={() => select(buckets[level], true)}>
          选中此置信组
        </Button>
        <Button size="sm" variant="outline" disabled={busy || selected.length === eligible.length} onClick={() => select(eligible, true)}>
          全选所有候选
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || !selected.length} onClick={() => select(selected, false)}>
          清空选择
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || !mergeReady || !selected.length} onClick={() => onBatchMerge(selected.map(({ entry }) => entry))}>
          批量合并（{selected.length} 组）
        </Button>
        <span className="text-xs text-muted-foreground">默认勾选高置信度候选。每批最多 50,000 token（含输入和回复），模型为每组单独选择主条目。</span>
      </div>
      <ReviewPageNav {...pagination} />
      {rows.map(({ key, entry }) => renderCard(entry, key, (
        <input
          type="checkbox"
          aria-label={`选择候选组：${entry.group.slugs.join("、")}`}
          checked={selectedKeys.has(key)}
          disabled={busy || queued.has(key)}
          onChange={(event) => select([{ key, entry }], event.target.checked)}
        />
      )))}
      <ReviewPageNav {...pagination} />
    </section>
  )
}
