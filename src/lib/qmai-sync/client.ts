/**
 * QMAI 云端同步客户端（把小说工程同步到我们自己的服务器磁盘）。
 *
 * ## 与现有 cloud-sync 的区别
 *
 * `lib/cloud-sync` 对接的是**用户自己的**云盘（GitHub / 百度网盘 / WebDAV），
 * 授权凭证是用户自己的。
 *
 * 这里是**我们的服务器**：`/var/qmai/sync/{userId}/{projectId}/...`，
 * 鉴权用的是网关卡（会员体系的一部分）。两者并存，不是替代关系。
 *
 * ## 为什么按文件同步而不是打包
 *
 * 小说工程里改一章只该传一章。整包上传在几十万字的书上每次都要传几十 MB，
 * 家宽上行扛不住，也浪费流量。按文件传还能让「只同步改动过的」变得自然。
 *
 * ## 错误处理
 *
 * 服务端返回的错误码要翻译成人话。特别是 `quota_exceeded`（空间不足）
 * 和 `bad_path`（文件名非法）—— 这两个是用户能自己解决的，必须说清楚。
 */

import { gatewayAuthHeaders } from "@/lib/builtin-models/gateway-api"
import { getHttpFetch } from "@/lib/tauri-fetch"

/** 同步配额 */
export interface SyncQuota {
  tier: string
  usedBytes: number
  usedFiles: number
  limitBytes: number
  limitFiles: number
  /**
   * 服务端标记「云备份是会员专属」（2026-11-09 补进类型）。
   *
   * ## 为什么必须有这个字段
   *
   * 网关对非会员返回 `{ limitBytes: 0, memberOnly: true }`。以前类型里
   * 没有它，`as SyncQuota` 会把这个字段**悄悄丢掉** —— 于是前端读不到
   * 官方给的「这是会员专属」标记，只能靠 `limitBytes === 0` 反推。
   *
   * 而 `limitBytes === 0` 是个**有歧义**的信号：它既可能是「没有权限」，
   * 也可能是「额度配成了 0」（服务端配置失误）。有了这个字段，
   * 前者可以明确区分出来 —— 界面就能说「未开通」而不是「空间已满」。
   *
   * 老版本网关不返回它，所以是可选的：缺失时回退到 `limitBytes` 判断。
   */
  memberOnly?: boolean
}

/** 服务端上的一个文件 */
export interface SyncFileEntry {
  path: string
  size: number
  mtime: number
}

export interface SyncVersionedFileEntry extends SyncFileEntry {
  sha256: string
  revision: string
}

export interface SyncRemoteManifest {
  protocolVersion: 2
  projectId: string
  storageGeneration: string
  files: SyncVersionedFileEntry[]
}

export interface SyncWriteCondition {
  storageGeneration: string
  /** 首次创建必须显式传 absent；不能省略后由服务端猜测。 */
  revision: string
}

/** 上传结果 */
export interface SyncUploadResult {
  protocolVersion: 2
  projectId: string
  path: string
  size: number
  sha256: string
  storageGeneration: string
  revision: string
}

/**
 * 同步接口错误。
 *
 * 带 `code` 是为了让 UI 能按错误类型给不同引导
 * （空间不足 → 提示清理或升级；路径非法 → 提示改文件名）。
 */
export class SyncError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 0) {
    super(message)
    this.name = "SyncError"
    this.code = code
    this.status = status
  }
}

/** 把服务端返回的错误体翻译成 SyncError */
async function toSyncError(res: Response): Promise<SyncError> {
  let code = "sync_failed"
  let message = "同步失败，请稍后重试。"

  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    if (body?.error?.code) code = body.error.code
    if (body?.error?.message) message = body.error.message
  } catch {
    // 响应不是 JSON：保留默认文案
  }

  // 几个高频错误给更明确的指引
  if (res.status === 401) {
    message = "登录状态已失效，请重新登录后再同步。"
  } else if (code === "quota_exceeded") {
    message = message || "同步空间已满，请先清理不需要的文件。"
  } else if (code === "file_too_large") {
    message = "单个文件超过 16MB 上限，请拆分后再同步。"
  }

  return new SyncError(code, message, res.status)
}

function baseOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "")
}

const SHA256 = /^[a-f0-9]{64}$/
const REVISION = /^[a-f0-9-]{36}$/

export async function syncContentHash(content: string | Uint8Array): Promise<string> {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : Uint8Array.from(content)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function invalidManifest(): SyncError {
  return new SyncError("invalid_manifest", "云端清单缺少有效的版本或内容信息，请升级网关并重新核对。", 422)
}

export function validateSyncManifest(value: unknown, projectId: string): SyncRemoteManifest {
  const body = value as SyncRemoteManifest | null
  if (!body || body.protocolVersion !== 2 || body.projectId !== projectId ||
      typeof body.storageGeneration !== "string" || !SHA256.test(body.storageGeneration) ||
      !Array.isArray(body.files) || body.files.length > 100000) throw invalidManifest()
  const paths = new Set<string>()
  for (const entry of body.files) {
    if (!entry || typeof entry.path !== "string" || !entry.path || entry.path.length > 400 ||
        entry.path.split("/").some(part => !part || part.startsWith(".") || /[. ]$/.test(part) ||
          /[\\\x00-\x1f<>:"|?*]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(part)) ||
        paths.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        !Number.isFinite(entry.mtime) || typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256) ||
        typeof entry.revision !== "string" || !REVISION.test(entry.revision)) throw invalidManifest()
    paths.add(entry.path)
  }
  return body
}

function conditionHeaders(condition: SyncWriteCondition): Record<string, string> {
  if (!condition || !SHA256.test(condition.storageGeneration) ||
      (condition.revision !== "absent" && !REVISION.test(condition.revision))) {
    throw new SyncError("version_required", "缺少有效的云端版本，请重新核对清单后再操作。", 428)
  }
  return { "X-Qmai-Storage-Generation": condition.storageGeneration, "X-Qmai-File-Revision": condition.revision }
}

export function validateSyncUpload(
  value: unknown,
  expected: { projectId: string; path: string; size: number; sha256: string; storageGeneration: string },
): SyncUploadResult {
  const result = value as SyncUploadResult | null
  if (!result || result.protocolVersion !== 2 || result.projectId !== expected.projectId ||
      result.path !== expected.path || result.size !== expected.size || result.sha256 !== expected.sha256 ||
      result.storageGeneration !== expected.storageGeneration || typeof result.revision !== "string" ||
      !REVISION.test(result.revision)) {
    throw new SyncError("invalid_receipt", "云端上传回执与文件不一致，尚未确认备份成功，请重新核对。", 422)
  }
  return result
}

/** 备份必须获取支持条件写入的完整清单；旧协议不能自动降级为无条件上传。 */
export async function fetchSyncManifest(
  baseUrl: string, netcard: string, projectId: string, fetchImpl?: typeof fetch,
): Promise<SyncRemoteManifest> {
  const fetcher = fetchImpl ?? (await getHttpFetch())
  const path = `/v1/sync/manifest?projectId=${encodeURIComponent(projectId)}`
  const headers = await gatewayAuthHeaders(netcard, "GET", signingPath(path))
  const res = await fetcher(`${baseOf(baseUrl)}${path}`, { method: "GET", headers })
  if (res.status === 404) throw invalidManifest()
  if (!res.ok) throw await toSyncError(res)
  return validateSyncManifest(await res.json(), projectId)
}

/**
 * 取用于签名的路径：**只保留 pathname，去掉 query**。
 *
 * 网关侧验签用的是 `new URL(request.url).pathname`（见 QMAI-API 的
 * index.ts 与 signature.ts），不含查询串。如果把 `?projectId=...`
 * 一起签进去，签名与网关重算的 payload 不一致，**永远验不过**。
 *
 * 这个 bug 在「网关只观察不强制」的阶段不会暴露 —— 一旦开启强制验签，
 * 所有带查询参数的同步请求会集体 403。属于必须在客户端侧先对齐的约定。
 */
function signingPath(requestPath: string): string {
  const index = requestPath.indexOf("?")
  return index === -1 ? requestPath : requestPath.slice(0, index)
}

/** 查询配额 */
export async function fetchSyncQuota(
  baseUrl: string,
  netcard: string,
  fetchImpl?: typeof fetch,
): Promise<SyncQuota> {
  const fetcher = fetchImpl ?? (await getHttpFetch())
  const path = "/v1/sync/quota"
  const headers = await gatewayAuthHeaders(netcard, "GET", signingPath(path))
  const res = await fetcher(`${baseOf(baseUrl)}${path}`, { method: "GET", headers })
  if (!res.ok) throw await toSyncError(res)
  return (await res.json()) as SyncQuota
}

/** 列出某个工程下已同步的文件 */
export async function fetchSyncList(
  baseUrl: string,
  netcard: string,
  projectId: string,
  fetchImpl?: typeof fetch,
): Promise<SyncFileEntry[]> {
  const fetcher = fetchImpl ?? (await getHttpFetch())
  const path = `/v1/sync/list?projectId=${encodeURIComponent(projectId)}`
  const headers = await gatewayAuthHeaders(netcard, "GET", signingPath(path))
  const res = await fetcher(`${baseOf(baseUrl)}${path}`, { method: "GET", headers })
  if (!res.ok) throw await toSyncError(res)
  const body = (await res.json()) as { files?: SyncFileEntry[] }
  return body.files ?? []
}

/**
 * 上传（或覆盖）一个文件。
 *
 * 请求体是原始字节而不是 JSON/base64：base64 会让体积涨 33%，
 * 而小说正文动辄几百 KB，白涨三成不划算。
 */
export async function uploadSyncFile(
  baseUrl: string,
  netcard: string,
  projectId: string,
  filePath: string,
  content: string | Uint8Array,
  condition: SyncWriteCondition,
  fetchImpl?: typeof fetch,
): Promise<SyncUploadResult> {
  const versionHeaders = conditionHeaders(condition)
  const fetcher = fetchImpl ?? (await getHttpFetch())
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content

  const path = `/v1/sync/upload?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(filePath)}`
  /*
   * 签名必须覆盖真实 body。
   * 这里传的是 UTF-8 解码后的字符串 —— 与服务端看到的字节一致，
   * 否则签名对不上（中文内容尤其明显）。
   */
  const headers = await gatewayAuthHeaders(
    netcard,
    "POST",
    signingPath(path),
    typeof content === "string" ? content : new TextDecoder().decode(bytes),
  )
  headers["Content-Type"] = "application/octet-stream"
  Object.assign(headers, versionHeaders)

  /*
   * 先拷进一个干净的 ArrayBuffer 再发。
   *
   * 直接传 Uint8Array 在部分 TS lib 定义里不被 BodyInit 接受
   * （Uint8Array<ArrayBufferLike> 与 BlobPart 的泛型差异）；
   * 而 ArrayBuffer 两边都认。这一份拷贝换来的是跨环境一致的行为，
   * 相对几百 KB 的正文开销可以忽略。
   */
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)

  const res = await fetcher(`${baseOf(baseUrl)}${path}`, {
    method: "POST",
    headers,
    body: new Blob([buffer], { type: "application/octet-stream" }),
  })
  if (!res.ok) throw await toSyncError(res)
  return validateSyncUpload(await res.json(), {
    projectId, path: filePath, size: bytes.byteLength,
    sha256: await syncContentHash(bytes), storageGeneration: condition.storageGeneration,
  })
}

/** 下载文件内容（按 UTF-8 文本返回） */
export async function downloadSyncFile(
  baseUrl: string,
  netcard: string,
  projectId: string,
  filePath: string,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const fetcher = fetchImpl ?? (await getHttpFetch())
  const path = `/v1/sync/download?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(filePath)}`
  const headers = await gatewayAuthHeaders(netcard, "GET", signingPath(path))
  const res = await fetcher(`${baseOf(baseUrl)}${path}`, { method: "GET", headers })
  if (!res.ok) throw await toSyncError(res)
  return await res.text()
}

/** 删除一个文件 */
export async function deleteSyncFile(
  baseUrl: string,
  netcard: string,
  projectId: string,
  filePath: string,
  condition: SyncWriteCondition,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const versionHeaders = conditionHeaders(condition)
  const fetcher = fetchImpl ?? (await getHttpFetch())
  const path = "/v1/sync/delete"
  const body = JSON.stringify({ projectId, path: filePath })
  const headers = await gatewayAuthHeaders(netcard, "POST", signingPath(path), body)
  Object.assign(headers, versionHeaders, { "Content-Type": "application/json" })
  const res = await fetcher(`${baseOf(baseUrl)}${path}`, { method: "POST", headers, body })
  if (!res.ok) throw await toSyncError(res)
}

/** 把字节数格式化成人类可读（用于配额展示） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(2)} GB`
}
