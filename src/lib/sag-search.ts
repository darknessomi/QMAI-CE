import { invoke } from "@tauri-apps/api/core"
import { listDirectory } from "@/commands/fs"
import { getJevConfig } from "@/lib/jev-config"
import { normalizePath } from "@/lib/path-utils"
import { parsePersonaProjectionFrontmatter } from "@/lib/novel/persona-projection"
import { isAiExcluded } from "@/lib/novel/ai-exclude"
import { isFinalChapter, parseChapterNumber } from "@/lib/novel/chapter-meta"
import type { FileNode } from "@/types/wiki"

export interface SagHit {
  path: string
  title: string
  content: string
  startLine: number
  endLine: number
  score: number
}

export interface SagSourceVersion {
  path: string
  contentHash: string
}

function markdownFiles(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap(node => node.is_dir
    ? markdownFiles(node.children ?? [])
    : /\.md$/i.test(node.name) ? [node] : [])
}

/** 精确文件清单。调用方必须已配置 Jev，文件为空时不会扩大到全项目。 */
export async function sagSearchFiles(
  projectPath: string, query: string, files: string[], topK: number, signal?: AbortSignal,
  options: { beforeChapter?: number; scopeFingerprint?: string; querySource?: SagSourceVersion } = {},
): Promise<SagHit[]> {
  signal?.throwIfAborted()
  const config = getJevConfig()
  if (!config) throw new Error("请先配置 Jev 判定模型。")
  if (!query.trim() || !files.length || topK <= 0) return []
  const requestId = crypto.randomUUID()
  const cancel = () => { void invoke("sag_cancel", { requestId }).catch(() => {}) }
  signal?.addEventListener("abort", cancel, { once: true })
  try {
    const hits = await invoke<SagHit[]>("sag_search", {
      projectPath: normalizePath(projectPath), query, files: [...new Set(files)], topK,
      config, requestId, ...options,
    })
    signal?.throwIfAborted()
    return hits
  } catch (error) {
    signal?.throwIfAborted()
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(message.startsWith("SAG2 检索失败") ? message : `SAG2 检索失败：${message}`)
  } finally {
    signal?.removeEventListener("abort", cancel)
  }
}

export function eligibleChapterNumber(path: string, content: string, beforeChapter: number): number | null {
  if (!/\/(?:QM|wiki)\/chapters\//.test(normalizePath(path))) return null
  const { frontmatter } = parsePersonaProjectionFrontmatter(content)
  if (!frontmatter || isAiExcluded(frontmatter) || !isFinalChapter(frontmatter)) return null
  const name = normalizePath(path).split("/").pop() ?? ""
  const number = parseChapterNumber(frontmatter.chapter_number)
    ?? Number(/^(?:第\s*(\d+)\s*章|chapter[-_ ]?(\d+))/i.exec(name)?.slice(1).find(Boolean))
  return Number.isInteger(number) && number > 0 && number < beforeChapter ? number : null
}

async function listSagFiles(projectPath: string, beforeChapter?: number): Promise<string[]> {
  if (beforeChapter !== undefined && beforeChapter <= 1) return []
  const root = normalizePath(projectPath).replace(/\/+$/, "")
  const directory = beforeChapter === undefined ? `${root}/wiki` : `${root}/wiki/chapters`
  return markdownFiles(await listDirectory(directory)).map(file => file.path)
}

export async function prepareSagChapterScope(projectPath: string, beforeChapter: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const files = await listSagFiles(projectPath, beforeChapter)
  signal?.throwIfAborted()
  const result = files.length
    ? await invoke<{ fingerprint: string; chapters: { path: string; chapterNumber: number }[] }>("sag_scope_fingerprint", { projectPath, files, beforeChapter })
    : { fingerprint: "empty", chapters: [] }
  signal?.throwIfAborted()
  return { files, fingerprint: result.fingerprint, chapters: new Map(result.chapters.map(ch => [ch.chapterNumber, ch.path])) }
}

export async function searchSagProject(
  projectPath: string, query: string, topK: number,
  options: { beforeChapter?: number; signal?: AbortSignal; scope?: Awaited<ReturnType<typeof prepareSagChapterScope>> } = {},
): Promise<SagHit[]> {
  const { beforeChapter, signal, scope } = options
  signal?.throwIfAborted()
  const files = scope?.files ?? await listSagFiles(projectPath, beforeChapter)
  return sagSearchFiles(projectPath, query, files, topK, signal, { beforeChapter, scopeFingerprint: scope?.fingerprint })
}

export function formatSagEvidence(projectPath: string, hits: SagHit[]): string {
  const prefix = normalizePath(projectPath).replace(/\/+$/, "") + "/"
  return hits.map(hit => {
    const path = normalizePath(hit.path)
    const relative = path.startsWith(prefix) ? path.slice(prefix.length) : path
    return `【${hit.title} · ${relative} 第 ${hit.startLine}–${hit.endLine} 行】\n${hit.content}`
  }).join("\n\n")
}

/** 保留引文开头的出处，不能把后一个段落的末尾拼到前一条引文上。 */
export function fitSagEvidence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const prefix = text.slice(0, Math.max(0, maxChars - 1))
  const lastAnchor = prefix.lastIndexOf("【")
  const partial = lastAnchor >= 0 && !prefix.slice(lastAnchor).includes("】\n")
  const result = (partial ? prefix.slice(0, lastAnchor) : prefix).trimEnd()
  return result ? result + "…" : ""
}
