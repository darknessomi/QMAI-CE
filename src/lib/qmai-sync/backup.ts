/**
 * 把本地小说工程备份到我们自己的服务器。
 *
 * ## 为什么不复用 lib/cloud-sync
 *
 * 那套对接的是用户自己的云盘（GitHub / 百度网盘 / WebDAV），要用户自己去
 * 授权、自己管配额。这里是**我们的服务器**，凭证是网关卡，配额按会员等级给。
 * 两者的鉴权、错误语义、限流模型都不同，硬套只会让两边都别扭。
 *
 * ## 同步策略：按文件，不打包
 *
 * 改一章只该传一章。整包上传在几十万字的书上每次都要传几十 MB，
 * 家宽上行扛不住，用户等不起。
 *
 * ## 只同步文本
 *
 * 正文、大纲、设定都是文本。图片和附件体积大、变化少，
 * 放进同一个配额里会把空间吃光，反而挤掉真正重要的内容。
 */

import { listDirectory, readFile } from "@/commands/fs"
import {
  SyncError, uploadSyncFile, fetchSyncManifest, syncContentHash, validateSyncManifest, validateSyncUpload,
  type SyncRemoteManifest, type SyncWriteCondition,
} from "./client"
import { appendSyncLog } from "./log"

/**
 * 上传重试策略。
 *
 * ## 为什么需要重试
 *
 * 2026-11-08 用户实测发现：一次备份里 6 个文件有 3 个失败，报错都是
 * `error sending request for url (...)`，而同一秒里其它文件成功。
 *
 * 这不是服务端拒绝（拒绝会返回中文 JSON），是**传输层偶发失败** ——
 * 最典型的原因是复用了刚被对端关闭的空闲 keep-alive 连接。
 * 这类失败**重试一次几乎必然成功**，但不重试就等于永久丢一个文件。
 *
 * ## 为什么只重试「传输层」错误
 *
 * `SyncError` 带 `status`，表示服务端**真的回了响应**：
 *   · 400 bad_extension / bad_path   → 重试一百次也一样，纯浪费
 *   · 401 登录失效                    → 重试无意义
 *   · 413 文件太大 / 配额超限         → 重试无意义
 * 只有「没拿到响应」（非 SyncError，或 status 为 0）和 5xx/429 才值得重试。
 *
 * ## 为什么退避是 300/900ms 而不是更久
 *
 * 备份是用户能感知的等待。三次尝试总耗时控制在 2 秒内 ——
 * 能救回绝大多数连接抖动，又不会让「传一个文件」看起来像卡住。
 */
const UPLOAD_RETRY_DELAYS_MS = [300, 900]

/** 这个错误值不值得重试 */
function isRetriableUploadError(error: unknown): boolean {
  if (error instanceof SyncError) {
    // status 为 0 表示请求根本没拿到响应
    if (error.status === 0) return true
    // 5xx 是服务端临时问题；429 是限流
    return error.status >= 500 || error.status === 429
  }
  // 非 SyncError：传输层/运行时错误，一律重试
  return true
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 会被同步的扩展名。只收文本，不收图片/附件。 */
const TEXT_EXTENSIONS = [
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".html",
  ".markdown",
]

/**
 * 跳过的目录。
 *
 * `.git` / `node_modules` 里有成千上万个文件，同步它们既没意义又会瞬间
 * 打满配额；`.trash` 是回收站，同步了等于把删掉的东西又备份一遍。
 *
 * `.qmai` 是软件自己的元数据目录（上下文缓存、推演记录、同步日志、
 * 将来的版本历史）。目前靠 `includeHidden: false` 已经过滤掉了，
 * 但那是**隐式依赖** —— 哪天有人为了同步某个隐藏目录把参数改成 true，
 * 这些文件会一起被传上去，瞬间打满配额。显式列在这里更稳。
 */
const SKIPPED_DIRS = new Set([
  ".git",
  "node_modules",
  ".obsidian",
  ".trash",
  "__pycache__",
  ".cache",
  ".venv",
  ".qmai",
])

/** 单文件上限：超过这个大小不参与同步（正常正文远小于此） */
const MAX_FILE_BYTES = 8 * 1024 * 1024

/** 一次同步最多处理的文件数，防止误选巨大目录时卡死 */
const MAX_FILES = 5000

export interface ProjectFile {
  /** 相对工程根目录的路径，用 / 分隔 */
  relPath: string
  /** 绝对路径，用于读取 */
  absPath: string
  size: number
  /** 最后修改时间（毫秒）。增量同步靠它与 size 判断文件有没有变。 */
  mtime: number
}

export interface CollectResult {
  files: ProjectFile[]
  /** 被跳过的文件数（非文本 / 超大） */
  skipped: number
  /** 是否因为达到文件数上限而截断 */
  truncated: boolean
}

function hasTextExtension(name: string): boolean {
  const lower = name.toLowerCase()
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * 判断读出来的内容是不是二进制。
 *
 * ## 为什么要在客户端做这一步
 *
 * 扩展名是可以随便改的：把一个 .exe 改成 .txt，扩展名白名单照样放行。
 * 服务端当然也会拦（见网关 sync.js 的 NUL 嗅探），但那时候**文件已经传上去了** ——
 * 一个 8MB 的假文本要占满整条上行带宽才被拒绝，纯属浪费。
 *
 * 在客户端读完之后立刻判断，可以在**发出请求之前**就跳过，
 * 一个字节都不上传。服务端那道检查保留作为纵深防御（客户端可以被绕过）。
 *
 * ## 判据为什么是 NUL 字节
 *
 * 纯文本（UTF-8）里不可能出现 0x00：ASCII 控制字符里 NUL 在文本文件中
 * 没有任何合法用途，而几乎所有二进制格式（exe / 图片 / 压缩包 / 数据库）
 * 头部都含大量 NUL。这个判据简单、零依赖、误判率极低。
 *
 * 只查前 8KB：与和服务端保持一致，也避免对超大文件做无谓的全量扫描 ——
 * 二进制文件不可能前 8KB 一个 NUL 都没有。
 */
const BINARY_SNIFF_CHARS = 8192

export function looksBinary(text: string): boolean {
  if (!text) return false
  const head = text.length > BINARY_SNIFF_CHARS ? text.slice(0, BINARY_SNIFF_CHARS) : text
  return head.includes("\u0000")
}

/**
 * 收集工程目录下所有可同步的文本文件。
 *
 * 走一次 `listDirectory` 拿整棵树（带 maxDepth 限制），
 * 比递归调用快得多，也不会因为深目录把 IPC 打爆。
 */
export async function collectProjectFiles(
  projectPath: string,
  options?: { maxFiles?: number; maxFileBytes?: number },
): Promise<CollectResult> {
  const maxFiles = options?.maxFiles ?? MAX_FILES
  const maxFileBytes = options?.maxFileBytes ?? MAX_FILE_BYTES

  const tree = await listDirectory(projectPath, { includeHidden: false, maxDepth: 8 })

  const files: ProjectFile[] = []
  let skipped = 0
  let truncated = false

  const walk = (nodes: typeof tree, prefix: string) => {
    for (const node of nodes) {
      if (truncated) return

      const rel = prefix ? `${prefix}/${node.name}` : node.name

      if (node.is_dir) {
        if (SKIPPED_DIRS.has(node.name)) {
          skipped++
          continue
        }
        if (node.children && node.children.length > 0) {
          walk(node.children, rel)
        }
        continue
      }

      if (!hasTextExtension(node.name)) {
        skipped++
        continue
      }
      if (typeof node.size === "number" && node.size > maxFileBytes) {
        skipped++
        continue
      }

      if (files.length >= maxFiles) {
        truncated = true
        return
      }

      files.push({
        relPath: rel,
        absPath: node.path,
        size: node.size ?? 0,
        mtime: node.mtimeMs ?? 0,
      })
    }
  }

  walk(tree, "")
  return { files, skipped, truncated }
}

/** 上次确认的云端内容；旧缓存缺少版本字段时仅供展示，不能用于覆盖授权。 */
export interface FileStamp {
  size: number
  mtime: number
  sha256?: string
  revision?: string
  storageGeneration?: string
}

/** 工程级清单：相对路径 → 指纹 */
export type SyncManifest = Record<string, FileStamp>

export interface BackupProgress {
  done: number
  total: number
  currentPath: string
}

export interface BackupOutcome {
  uploaded: number
  /** 因为没变化而跳过的文件数（增量同步的主要收益） */
  skippedUnchanged: number
  failed: Array<{ path: string; message: string }>
  totalBytes: number
  skipped: number
  truncated: boolean
  /**
   * 因为内容像二进制而被跳过的文件。
   *
   * 单独列出来而不是并进 `skipped`：用户看到「跳过了 3 个文件」会以为
   * 是正常的非文本文件，但如果是他把一个 .exe 改名成 .txt，需要明确告诉他
   * 「这个文件看着不像文本，所以没传」—— 否则他会以为同步坏了。
   */
  binarySkipped: string[]
  /** 本次之后的清单，调用方应持久化，下次传给 known 实现增量 */
  manifest: SyncManifest
}

export interface BackupOptions {
  baseUrl: string
  netcard: string
  projectPath: string
  projectId: string
  /** 上次确认的内容回执。每次仍读取云端与本地内容，不能单凭mtime跳过。 */
  known?: SyncManifest
  listRemote?: (baseUrl: string, netcard: string, projectId: string) => Promise<SyncRemoteManifest>
  /** 在每次读取、网络尝试和结果提交前核对启动时的账号与作品。 */
  assertActive?: () => void
  onProgress?: (progress: BackupProgress) => void
  /** 单个文件上传实现，默认走真实网络。测试可注入。 */
  upload?: (args: {
    baseUrl: string
    netcard: string
    projectId: string
    relPath: string
    content: string
    condition: SyncWriteCondition
  }) => Promise<unknown>
  /** 读取文件实现，默认走 Tauri。测试可注入。 */
  read?: (absPath: string) => Promise<string>
  /** 收集文件实现，默认走 Tauri。测试可注入。 */
  collect?: (projectPath: string) => Promise<CollectResult>
}

/**
 * 执行一次备份（支持增量）。
 *
 * ## 单个文件失败不中断整体
 *
 * 某个文件读不出来（被占用、权限问题）不该让整次备份白跑。
 * 记录下来继续传下一个，最后一起报告 —— 用户至少能看到「哪些没传上去」。
 *
 * ## 增量判定
 *
 * 每次实读本地内容并核对云端SHA256。相同内容不重传；远端缺失补传。
 * 远端不同内容只有仍匹配上次确认的版本与存储代次时才允许更新，否则保留双方。
 *
 * ## 删除不同步
 *
 * 本地删掉的文件不会从服务器删掉。这是**刻意的**：这是备份不是镜像，
 * 用户误删时服务器上还留着一份才有意义。代价是服务器会积累旧文件，
 * 由配额与手动清理来管。
 */
export async function backupProject(options: BackupOptions): Promise<BackupOutcome> {
  options.assertActive?.()
  const read = options.read ?? readFile
  const collect = options.collect ?? ((p: string) => collectProjectFiles(p))
  const upload =
    options.upload ??
    ((args: {
      baseUrl: string
      netcard: string
      projectId: string
      relPath: string
      content: string
      condition: SyncWriteCondition
    }) =>
      uploadSyncFile(args.baseUrl, args.netcard, args.projectId, args.relPath, args.content, args.condition))

  const { files, skipped, truncated } = await collect(options.projectPath)
  options.assertActive?.()
  const known = options.known ?? {}
  const view = validateSyncManifest(await (options.listRemote ?? fetchSyncManifest)(
    options.baseUrl, options.netcard, options.projectId,
  ), options.projectId)
  options.assertActive?.()
  const remote = new Map(view.files.map(entry => [entry.path, entry]))

  const failed: Array<{ path: string; message: string }> = []
  const binarySkipped: string[] = []
  const manifest: SyncManifest = Object.create(null)
  let uploaded = 0
  let skippedUnchanged = 0
  let totalBytes = 0

  const startedAt = Date.now()
  await appendSyncLog(options.projectPath, {
    event: "backup.start",
    projectId: options.projectId,
    message: `共 ${files.length} 个文件待检查`,
  })

  for (let i = 0; i < files.length; i++) {
    options.assertActive?.()
    const file = files[i]
    options.onProgress?.({ done: i, total: files.length, currentPath: file.relPath })

    try {
      const content = await read(file.absPath)
      options.assertActive?.()

      /*
       * 客户端内容校验（2026-11-08 加）。
       *
       * 扩展名白名单拦不住「把 .exe 改名成 .txt」—— 那种文件读出来是一串
       * 含 NUL 的乱码，传上去服务端也会拒，但**带宽已经浪费了**。
       * 在发出请求之前判掉，一个字节都不上传。
       *
       * 服务端那道 NUL 嗅探保留不动：客户端是可以被绕过的（改代码、
       * 直接发 HTTP 请求），两边都做才是纵深防御。
       */
      if (looksBinary(content)) {
        binarySkipped.push(file.relPath)
        // 不进清单：内容没同步成功，下次还要重新判断
        delete manifest[file.relPath]
        await appendSyncLog(options.projectPath, {
          event: "upload.skip_binary",
          projectId: options.projectId,
          path: file.relPath,
          message: "内容含 NUL 字节，判定为非文本，未上传",
        })
        continue
      }

      const size = new TextEncoder().encode(content).byteLength
      const sha256 = await syncContentHash(content)
      options.assertActive?.()
      const current = remote.get(file.relPath)
      const prev = Object.prototype.hasOwnProperty.call(known, file.relPath) ? known[file.relPath] : undefined
      if (current && current.sha256 === sha256 && current.size === size) {
        manifest[file.relPath] = { size, mtime: file.mtime, sha256,
          revision: current.revision, storageGeneration: view.storageGeneration }
        skippedUnchanged++
        continue
      }
      if (current && (!prev || prev.storageGeneration !== view.storageGeneration ||
          prev.sha256 !== current.sha256 || prev.revision !== current.revision)) {
        throw new SyncError("file_conflict", "云端与本地内容存在冲突，已保留双方内容。请先恢复副本核对后再处理。", 412)
      }
      const condition = { storageGeneration: view.storageGeneration, revision: current?.revision ?? "absent" }

      /*
       * 带重试的上传。
       *
       * 传输层抖动（连接被复用后又立刻断开）重试一两次就能过；
       * 服务端明确拒绝（400/401/413）则立刻放弃，不浪费时间。
       * 每次重试都写一条日志，出问题时能看出「是第一次就成功还是重试后成功」。
       */
      let lastError: unknown = null
      for (let attempt = 0; attempt <= UPLOAD_RETRY_DELAYS_MS.length; attempt++) {
        options.assertActive?.()
        try {
          const response = await upload({
            baseUrl: options.baseUrl,
            netcard: options.netcard,
            projectId: options.projectId,
            relPath: file.relPath,
            content,
            condition,
          })
          options.assertActive?.()
          const receipt = validateSyncUpload(response, {
            projectId: options.projectId, path: file.relPath, size, sha256,
            storageGeneration: view.storageGeneration,
          })
          manifest[file.relPath] = { size, mtime: file.mtime, sha256,
            storageGeneration: receipt.storageGeneration, revision: receipt.revision }
          lastError = null
          break
        } catch (error) {
          options.assertActive?.()
          lastError = error
          const retriable = isRetriableUploadError(error)
          const hasNext = attempt < UPLOAD_RETRY_DELAYS_MS.length
          if (!retriable || !hasNext) throw error

          await appendSyncLog(options.projectPath, {
            event: "upload.retry",
            projectId: options.projectId,
            path: file.relPath,
            message: `第 ${attempt + 1} 次失败，${UPLOAD_RETRY_DELAYS_MS[attempt]}ms 后重试：${
              error instanceof Error ? error.message : String(error)
            }`,
          })
          await sleep(UPLOAD_RETRY_DELAYS_MS[attempt])
        }
      }
      if (lastError) throw lastError

      uploaded++
      totalBytes += size

      await appendSyncLog(options.projectPath, {
        event: "upload.ok",
        projectId: options.projectId,
        path: file.relPath,
        size,
      })
    } catch (error) {
      options.assertActive?.()
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ path: file.relPath, message })
      /*
       * 失败的文件不能写进清单 —— 写了下次就会认为「已同步」而跳过，
       * 那份内容就永远传不上去了。
       */
      delete manifest[file.relPath]

      await appendSyncLog(options.projectPath, {
        event: "upload.fail",
        projectId: options.projectId,
        path: file.relPath,
        message,
      })
    }
  }

  options.assertActive?.()
  options.onProgress?.({ done: files.length, total: files.length, currentPath: "" })

  await appendSyncLog(options.projectPath, {
    event: "backup.end",
    projectId: options.projectId,
    uploaded,
    skipped: skippedUnchanged,
    failed: failed.length,
    elapsedMs: Date.now() - startedAt,
    message:
      binarySkipped.length > 0 ? `另有 ${binarySkipped.length} 个文件被判为非文本` : undefined,
  })

  return {
    uploaded,
    skippedUnchanged,
    failed,
    totalBytes,
    skipped,
    truncated,
    binarySkipped,
    manifest,
  }
}
