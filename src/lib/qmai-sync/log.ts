/**
 * 会员云空间同步日志（本地文件）。
 *
 * ## 为什么日志要落在本地而不是云端
 *
 * 同步出问题时最需要日志，但恰恰在那个时候云端多半也是不通的 ——
 * 日志要是存在云端，等于「出事时正好拿不到」。落本地磁盘，用户随时能发给我们。
 *
 * ## 为什么不直接 console.log
 *
 * 桌面端的控制台输出用户看不到，出了问题只能靠我们远程复现。
 * 落成文件后，用户一句「我把日志发你」就能定位，不用来回猜。
 *
 * ## 存放位置
 *
 *   {工程目录}/.qmai/member-cloud-sync.log
 *
 * 跟作品放在一起：换电脑时跟着作品走，用户不会找不到。
 * `.qmai` 目录已经在备份的跳过名单里（避免日志自己触发同步）。
 */

import { createDirectory, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

/** 日志相对工程目录的路径 */
export const MEMBER_CLOUD_LOG_REL = ".qmai/member-cloud-sync.log"

/**
 * 日志文件上限。
 *
 * 512 KB 大约能记几千条 —— 足够定位问题，又不会让用户的作品目录里
 * 躺着一个几 MB 的日志文件。超过就截掉前半段。
 */
const MAX_LOG_BYTES = 512 * 1024

/** 保留最近多少条（截断时用） */
const KEEP_LINES = 2000

export type SyncLogEvent =
  /** 开始一次备份 */
  | "backup.start"
  /** 备份结束 */
  | "backup.end"
  /** 单个文件上传成功 */
  | "upload.ok"
  /** 单个文件上传失败 */
  | "upload.fail"
  /**
   * 单次上传失败后准备重试。
   *
   * 与 `upload.fail` 分开：`upload.fail` 是**最终**失败（文件这次没传上去），
   * 而 `upload.retry` 只是过程中的一次抖动，重试后往往就成功了。
   * 混在一起会让日志看起来像「失败了很多次」，实际只丢了一个文件。
   */
  | "upload.retry"
  /** 内容像二进制，客户端直接跳过（未上传） */
  | "upload.skip_binary"
  /** 开始一次恢复 */
  | "restore.start"
  /** 恢复结束 */
  | "restore.end"
  /** 单个文件下载成功 */
  | "download.ok"
  /** 单个文件下载失败 */
  | "download.fail"
  /** 恢复时发现本地有更新版本，跳过 */
  | "restore.skip"
  /** 其他异常 */
  | "error"

export interface SyncLogEntry {
  /** ISO 时间戳 */
  at: string
  event: SyncLogEvent
  /** 作品标识 */
  projectId?: string
  /** 相对路径 */
  path?: string
  /** 字节数 */
  size?: number
  /** 耗时（毫秒） */
  elapsedMs?: number
  /** 汇总数字（backup.end / restore.end 用） */
  uploaded?: number
  skipped?: number
  failed?: number
  /** 失败原因或补充说明 */
  message?: string
}

/*
 * 串行写入队列。
 *
 * 同步是并发上传的，多个文件同时写同一个日志文件会互相覆盖。
 * 用一条 Promise 链把它们排队，比加锁简单且不会有死锁。
 */
let writeQueue: Promise<void> = Promise.resolve()

export function memberCloudLogPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${MEMBER_CLOUD_LOG_REL}`
}

/**
 * 追加一条日志。
 *
 * 任何失败都静默吞掉 —— 日志写不进去不应该让同步失败。
 * 这是「辅助功能」的基本要求：它坏了不能拖垮主流程。
 */
export async function appendSyncLog(
  projectPath: string,
  entry: Omit<SyncLogEntry, "at">,
): Promise<void> {
  if (!projectPath) return
  const full: SyncLogEntry = { at: new Date().toISOString(), ...entry }
  const line = JSON.stringify(full)

  writeQueue = writeQueue
    .then(async () => {
      const file = memberCloudLogPath(projectPath)
      const dir = file.slice(0, file.lastIndexOf("/"))
      try {
        if (!(await fileExists(dir))) await createDirectory(dir)

        let prev = ""
        if (await fileExists(file)) {
          try {
            prev = await readFile(file)
          } catch {
            prev = ""
          }
        }

        let next = prev ? `${prev}\n${line}` : line

        // 超限时只保留最近 KEEP_LINES 条
        if (next.length > MAX_LOG_BYTES) {
          const lines = next.split("\n")
          next = lines.slice(Math.max(0, lines.length - KEEP_LINES)).join("\n")
        }

        await writeFileAtomic(file, next)
      } catch {
        // 日志写失败不影响同步本身
      }
    })
    .catch(() => {})

  await writeQueue
}

/** 读取日志内容（诊断用；文件不存在返回空串） */
export async function readSyncLog(projectPath: string): Promise<string> {
  const file = memberCloudLogPath(projectPath)
  try {
    if (!(await fileExists(file))) return ""
    return await readFile(file)
  } catch {
    return ""
  }
}

/** 把日志解析成条目数组（解析失败的行走忽略，不抛错） */
export async function readSyncLogEntries(projectPath: string): Promise<SyncLogEntry[]> {
  const raw = await readSyncLog(projectPath)
  if (!raw) return []
  const out: SyncLogEntry[] = []
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as SyncLogEntry)
    } catch {
      // 半截行（写入时进程被杀）直接跳过
    }
  }
  return out
}
