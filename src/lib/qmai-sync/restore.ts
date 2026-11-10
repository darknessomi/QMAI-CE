/**
 * 从会员云空间恢复作品到本地。
 *
 * ## 为什么这个功能比「备份」更重要
 *
 * 备份只在「用户自己发现丢了」的时候才有价值 —— 而真正需要它的时候
 * （换电脑、重装系统、硬盘坏了），用户手里已经没有本地文件了。
 * 这时候唯一能救数据的就是「从云端拉回来」，所以它是同步功能的核心。
 *
 * 已有文件保持原内容；需要下载的同名云端文件存入独立恢复目录。
 * 目标不存在时使用原生独占创建，下载间隙的新建/编辑也不会被替换。
 *
 * ## 为什么不删本地多余的文件
 *
 * 「云端没有」可能是云端删除，也可能是本地新建还没传。
 * 无法区分的情况下删除本地文件是不可接受的，所以只做「补齐」，不做「对齐」。
 */

import { listDirectory, writeFileIfAbsent } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

import { downloadSyncFile, fetchSyncList, type SyncFileEntry } from "./client"
import { appendSyncLog } from "./log"

/** 恢复时的单个文件结果 */
export type RestoreFileResult =
  | { kind: "restored"; path: string; size: number }
  | { kind: "skipped-newer"; path: string; localMtime: number; remoteMtime: number }
  | { kind: "failed"; path: string; message: string }

export interface RestoreOutcome {
  /** 实际写入本地的文件数 */
  restored: number
  /** 因为本地更新而跳过的文件数 */
  skippedNewer: number
  /** 失败的文件 */
  failed: Array<{ path: string; message: string }>
  /** 写入的总字节数 */
  totalBytes: number
  /** 云端一共列出多少文件 */
  remoteTotal: number
  /** 同名云端文件的副本位置（相对作品根目录），原文件保持不变。 */
  conflicts?: Array<{ path: string; savedPath: string }>
}

export interface RestoreOptions {
  baseUrl: string
  netcard: string
  projectId: string
  /** 本地工程根目录 */
  projectPath: string
  assertActive?: () => void
  /** 进度回调（便于 UI 显示「正在恢复 3/20」） */
  onProgress?: (info: { done: number; total: number; currentPath: string }) => void
  /** 注入用（测试） */
  listRemote?: (baseUrl: string, netcard: string, projectId: string) => Promise<SyncFileEntry[]>
  download?: (
    baseUrl: string,
    netcard: string,
    projectId: string,
    path: string,
  ) => Promise<string>
  /** 必须独占创建，已有目标返回 false，不能使用覆盖写入代替。 */
  createFile?: (absPath: string, content: string) => Promise<boolean>
}

/**
 * 把云端相对路径拼成本地绝对路径，并做一次穿越校验。
 *
 * 服务端已经校验过一遍，但客户端不能依赖「对面一定是对的」——
 * 万一服务端被换成了恶意实现，`../../..` 会直接写到用户磁盘别处去。
 */
function resolveLocalPath(projectPath: string, rel: string): string | null {
  const unified = rel.replace(/\\/g, "/")
  if (!unified || unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) return null
  const parts = unified.split("/")
  for (const seg of parts) {
    if (!seg || seg.startsWith(".") || /[. ]$/.test(seg) || /[<>:"|?*\x00-\x1f]/.test(seg)) return null
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(seg)) return null
  }
  return `${normalizePath(projectPath)}/${parts.join("/")}`
}

/** 读取本地文件树的 mtime 索引：相对路径 → mtimeMs */
async function buildLocalMtimeIndex(projectPath: string): Promise<Map<string, number>> {
  const index = new Map<string, number>()
  const tree = await listDirectory(projectPath, { includeHidden: false, maxDepth: 8 })
  const walk = (nodes: typeof tree, prefix: string) => {
    for (const node of nodes) {
      const rel = prefix ? `${prefix}/${node.name}` : node.name
      if (node.is_dir) {
        if (node.children && node.children.length > 0) walk(node.children, rel)
        continue
      }
      if (typeof node.mtimeMs === "number") index.set(rel, node.mtimeMs)
    }
  }
  walk(tree, "")
  return index
}

/**
 * 执行一次恢复。
 *
 * 与备份一样：单个文件失败不中断整体，最后汇总报告。
 * 用户最怕的是「传到一半停了，也不知道哪些成功了」。
 */
export async function restoreProject(options: RestoreOptions): Promise<RestoreOutcome> {
  options.assertActive?.()
  const startedAt = Date.now()
  const listRemote = options.listRemote ?? fetchSyncList
  const download = options.download ?? downloadSyncFile
  const create = options.createFile ?? writeFileIfAbsent
  const restoreId = crypto.randomUUID()

  await appendSyncLog(options.projectPath, {
    event: "restore.start",
    projectId: options.projectId,
  })

  let remoteFiles: SyncFileEntry[] = []
  try {
    options.assertActive?.()
    remoteFiles = await listRemote(options.baseUrl, options.netcard, options.projectId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await appendSyncLog(options.projectPath, {
      event: "error",
      projectId: options.projectId,
      message: `拉取云端清单失败：${message}`,
    })
    await appendSyncLog(options.projectPath, {
      event: "restore.end",
      projectId: options.projectId,
      uploaded: 0,
      skipped: 0,
      failed: 1,
      message: "清单拉取失败",
    })
    throw error
  }

  let localMtime: Map<string, number>
  try {
    localMtime = await buildLocalMtimeIndex(options.projectPath)
  } catch (error) {
    await appendSyncLog(options.projectPath, {
      event: "restore.end", projectId: options.projectId, uploaded: 0, failed: 1,
      message: "无法检查本地目录，已停止恢复，原文件保持不变。",
    })
    throw error
  }

  const failed: Array<{ path: string; message: string }> = []
  const conflicts: Array<{ path: string; savedPath: string }> = []
  let restored = 0
  let skippedNewer = 0
  let totalBytes = 0

  for (let i = 0; i < remoteFiles.length; i++) {
    options.assertActive?.()
    const entry = remoteFiles[i]
    const rel = entry.path
    options.onProgress?.({ done: i, total: remoteFiles.length, currentPath: rel })

    const abs = resolveLocalPath(options.projectPath, rel)
    if (!abs) {
      failed.push({ path: rel, message: "云端返回的路径不合法，已跳过" })
      await appendSyncLog(options.projectPath, {
        event: "download.fail",
        projectId: options.projectId,
        path: rel,
        message: "路径不合法",
      })
      continue
    }

    // 本地更新 → 跳过，避免覆盖用户刚写的内容
    const local = localMtime.get(rel)
    if (typeof local === "number" && typeof entry.mtime === "number" && local > entry.mtime) {
      skippedNewer++
      await appendSyncLog(options.projectPath, {
        event: "restore.skip",
        projectId: options.projectId,
        path: rel,
        message: "本地文件比云端新，未覆盖",
      })
      continue
    }

    try {
      const content = await download(options.baseUrl, options.netcard, options.projectId, rel)
      options.assertActive?.()

      // 原生 create_new 在写入时判断是否存在，避免 JS 检查与写入之间的竞争。
      // 同名目标只写独立副本；本地mtime较旧也不代表内容可以安全覆盖。
      let savedPath = rel.replace(/\\/g, "/")
      if (!(await create(abs, content))) {
        options.assertActive?.()
        savedPath = `.qmai/restores/${restoreId}/${savedPath}`
        if (!(await create(`${normalizePath(options.projectPath)}/${savedPath}`, content))) {
          throw new Error("恢复副本已存在，已保留原文件，请重新执行恢复。")
        }
        conflicts.push({ path: rel, savedPath })
      }
      const bytes = new TextEncoder().encode(content).byteLength
      restored++
      totalBytes += bytes

      await appendSyncLog(options.projectPath, {
        event: "download.ok",
        projectId: options.projectId,
        path: rel,
        size: bytes,
        message: savedPath !== rel ? `原文件已保留，云端副本：${savedPath}` : undefined,
      })
    } catch (error) {
      options.assertActive?.()
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ path: rel, message })
      await appendSyncLog(options.projectPath, {
        event: "download.fail",
        projectId: options.projectId,
        path: rel,
        message,
      })
    }
  }

  options.assertActive?.()
  options.onProgress?.({ done: remoteFiles.length, total: remoteFiles.length, currentPath: "" })

  const elapsedMs = Date.now() - startedAt
  await appendSyncLog(options.projectPath, {
    event: "restore.end",
    projectId: options.projectId,
    uploaded: restored,
    skipped: skippedNewer,
    failed: failed.length,
    elapsedMs,
    message: `云端共 ${remoteFiles.length} 个文件`,
  })

  return {
    restored,
    skippedNewer,
    failed,
    totalBytes,
    remoteTotal: remoteFiles.length,
    conflicts,
  }
}
