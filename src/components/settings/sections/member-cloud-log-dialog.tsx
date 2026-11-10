/**
 * 同步日志查看弹窗。
 *
 * ## 为什么需要这个
 *
 * 日志写在 `{工程}/.qmai/member-cloud-sync.log`，但要求用户自己去翻文件系统
 * 是不现实的 —— 大部分用户不知道作品目录在哪，更不会去开隐藏的 `.qmai`。
 * 没有查看入口，日志等于白记。
 *
 * ## 展示策略
 *
 * 倒序（最新的在上）—— 出问题时用户关心的是「刚才发生了什么」，
 * 不是三天前的成功记录。
 *
 * 每条都带上事件的中文说明，而不是直接甩 `upload.fail` 这种内部标识 ——
 * 用户看不懂内部枚举，看到了也没法判断。
 */

import { useCallback, useEffect, useState } from "react"
import { Copy, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  readSyncLogEntries,
  memberCloudLogPath,
  type SyncLogEntry,
  type SyncLogEvent,
} from "@/lib/qmai-sync/log"

/** 事件 → 中文说明 + 颜色 */
const EVENT_META: Record<SyncLogEvent, { label: string; tone: string }> = {
  "backup.start": { label: "开始备份", tone: "text-muted-foreground" },
  "backup.end": { label: "备份完成", tone: "text-emerald-600 dark:text-emerald-400" },
  "upload.ok": { label: "上传成功", tone: "text-muted-foreground" },
  "upload.fail": { label: "上传失败", tone: "text-destructive" },
  // 重试是过程事件，用琥珀色区分：它不代表最终失败，但值得注意
  "upload.retry": { label: "重试中", tone: "text-amber-600 dark:text-amber-400" },
  "upload.skip_binary": { label: "已跳过（非文本）", tone: "text-amber-600 dark:text-amber-400" },
  "restore.start": { label: "开始恢复", tone: "text-muted-foreground" },
  "restore.end": { label: "恢复完成", tone: "text-emerald-600 dark:text-emerald-400" },
  "download.ok": { label: "下载成功", tone: "text-muted-foreground" },
  "download.fail": { label: "下载失败", tone: "text-destructive" },
  "restore.skip": { label: "已跳过", tone: "text-amber-600 dark:text-amber-400" },
  error: { label: "异常", tone: "text-destructive" },
}

/** 一次显示多少条（避免几千条把弹窗卡死） */
const VISIBLE_LIMIT = 300

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
      d.getMinutes(),
    )}:${pad(d.getSeconds())}`
  } catch {
    return iso
  }
}

/** 把一条日志压成一行可读文本（复制用） */
function toLine(entry: SyncLogEntry): string {
  const parts = [formatTime(entry.at), EVENT_META[entry.event]?.label ?? entry.event]
  if (entry.path) parts.push(entry.path)
  if (typeof entry.size === "number") parts.push(`${entry.size} 字节`)
  if (typeof entry.elapsedMs === "number") parts.push(`${entry.elapsedMs}ms`)
  if (typeof entry.uploaded === "number") parts.push(`成功 ${entry.uploaded}`)
  if (typeof entry.skipped === "number" && entry.skipped > 0) parts.push(`跳过 ${entry.skipped}`)
  if (typeof entry.failed === "number" && entry.failed > 0) parts.push(`失败 ${entry.failed}`)
  if (entry.message) parts.push(entry.message)
  return parts.join(" | ")
}

export interface MemberCloudLogDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 当前作品目录；为空时无法定位日志 */
  projectPath: string | null
}

export function MemberCloudLogDialog({ open, onOpenChange, projectPath }: MemberCloudLogDialogProps) {
  const [entries, setEntries] = useState<SyncLogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    if (!projectPath) {
      setEntries([])
      return
    }
    setLoading(true)
    try {
      const all = await readSyncLogEntries(projectPath)
      // 倒序：最新的在最上面
      setEntries(all.slice().reverse().slice(0, VISIBLE_LIMIT))
    } finally {
      setLoading(false)
    }
  }, [projectPath])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const handleCopy = useCallback(async () => {
    if (entries.length === 0) return
    const text = entries.map(toLine).join("\n")
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板不可用时不做处理：用户可以手动选中文本
    }
  }, [entries])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" data-ui="member-cloud-log-dialog">
        <DialogHeader>
          <DialogTitle>同步日志</DialogTitle>
          <DialogDescription>
            记录备份与恢复的每一步。遇到问题时把这里的内容发给我们，能快速定位。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {loading ? "读取中…" : "刷新"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => void handleCopy()}
            disabled={entries.length === 0}
          >
            <Copy className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {copied ? "已复制" : "复制全部"}
          </Button>
          <span className="text-xs text-muted-foreground">
            共 {entries.length} 条{entries.length >= VISIBLE_LIMIT ? "（仅显示最近部分）" : ""}
          </span>
        </div>

        {!projectPath ? (
          <div className="rounded-lg border p-4 text-sm text-muted-foreground">
            当前没有打开的作品，无法定位日志。
          </div>
        ) : entries.length === 0 ? (
          <div className="rounded-lg border p-4 text-sm text-muted-foreground">
            {loading ? "正在读取…" : "还没有同步记录。执行一次备份后这里会出现日志。"}
          </div>
        ) : (
          <div
            className="max-h-[50vh] overflow-y-auto rounded-lg border"
            data-ui="member-cloud-log-list"
          >
            <table className="w-full text-xs">
              <tbody>
                {entries.map((entry, index) => {
                  const meta = EVENT_META[entry.event] ?? {
                    label: entry.event,
                    tone: "text-muted-foreground",
                  }
                  return (
                    <tr key={`${entry.at}-${index}`} className="border-b last:border-0">
                      <td className="whitespace-nowrap px-2 py-1.5 align-top font-mono text-muted-foreground">
                        {formatTime(entry.at)}
                      </td>
                      <td className={`whitespace-nowrap px-2 py-1.5 align-top ${meta.tone}`}>
                        {meta.label}
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        {entry.path ? (
                          <span className="break-all font-mono">{entry.path}</span>
                        ) : null}
                        {entry.message ? (
                          <span className="ml-1 text-muted-foreground">{entry.message}</span>
                        ) : null}
                        {typeof entry.uploaded === "number" ? (
                          <span className="ml-1 text-muted-foreground">
                            成功 {entry.uploaded}
                            {typeof entry.skipped === "number" ? `，跳过 ${entry.skipped}` : ""}
                            {typeof entry.failed === "number" ? `，失败 ${entry.failed}` : ""}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {projectPath ? (
          <p className="break-all text-xs text-muted-foreground">
            日志文件：{memberCloudLogPath(projectPath)}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
