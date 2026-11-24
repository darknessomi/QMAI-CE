/**
 * 大纲文档的**伴生文件**（`.html` / `.json`）。
 *
 * 为什么需要统一处理：大纲在磁盘上是三个文件 ——
 * `大纲-第01卷.md`（正文）、`大纲-第01卷.html`（网页版）、`大纲-第01卷.json`（卷纲结构化数据）。
 * 过去删除/改名只动 `.md`，另外两个留在原地，于是：
 * - 大纲树里已经看不到这份大纲了，但 AI 通过 `list_outlines` / `read_outline` 仍能读到
 *   残留的 HTML 与 JSON（用户 2026-10-28 报的重大缺陷）；
 * - 预览还可能把旧 HTML 当成"这份大纲的网页版"显示出来。
 *
 * 删除走回收站（`trash.ts` 已把伴生文件一起搬走并随主文件还原）；
 * 这里提供的是**改名/移动**场景要用的搬运，以及一个显式的直接删除工具。
 */

import { deleteFile, fileExists, movePathIfAbsent, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"

/** 大纲 .md 可能带的伴生扩展名。 */
export const OUTLINE_COMPANION_EXTENSIONS = ["html", "json"] as const

/** 由 .md 路径推出伴生文件路径（不判断是否存在）。 */
export function outlineCompanionPaths(mdPath: string): string[] {
  const normalized = normalizePath(mdPath)
  if (!/\.md$/i.test(normalized)) return []
  const stem = normalized.replace(/\.md$/i, "")
  return OUTLINE_COMPANION_EXTENSIONS.map((extension) => `${stem}.${extension}`)
}

/** 在搜索、计数前按真实同级目录识别独立 HTML。 */
export function outlineDocumentNodes(nodes: FileNode[], isProjection: (path: string) => boolean): FileNode[] {
  const markdownStems = new Set(nodes.filter((node) => !node.is_dir && /\.md$/i.test(node.name))
    .map((node) => node.name.replace(/\.md$/i, "")))
  return nodes.flatMap((node) => {
    if (node.is_dir) return [{ ...node, children: outlineDocumentNodes(node.children ?? [], isProjection) }]
    if (/\.md$/i.test(node.name)) return isProjection(node.path) ? [] : [node]
    return /\.html$/i.test(node.name) && !markdownStems.has(node.name.replace(/\.html$/i, "")) ? [node] : []
  })
}

/** 直接删除伴生文件，返回实际删掉的个数。 */
export async function deleteOutlineCompanions(mdPath: string): Promise<number> {
  let deleted = 0
  for (const companion of outlineCompanionPaths(mdPath)) {
    if (!(await fileExists(companion))) continue
    try {
      await deleteFile(companion)
      deleted += 1
    } catch (error) {
      console.warn("[outline-companions] 删除伴生文件失败:", companion, error)
    }
  }
  return deleted
}

/** 连同角色卡 HTML、卷纲 JSON 搬运；任一目标冲突时保留双方原文。 */
export async function moveOutlineDocument(
  source: string,
  destination: string,
  renamedContent?: string,
): Promise<Array<{ source: string; destination: string }>> {
  const from = [...outlineCompanionPaths(source), source]
  const to = [...outlineCompanionPaths(destination), destination]
  const collisions = await Promise.all(to.map(fileExists))
  if (collisions.some(Boolean)) {
    throw new Error("目标目录已有同名大纲或伴生文件。")
  }
  const moved: number[] = []
  try {
    for (let index = 0; index < from.length; index++) {
      if (from[index] !== source && !(await fileExists(from[index]))) continue
      await movePathIfAbsent(from[index], to[index])
      moved.push(index)
    }
    if (renamedContent !== undefined) await writeFileAtomic(destination, renamedContent)
    return moved.map((index) => ({ source: from[index], destination: to[index] }))
  } catch (error) {
    const remaining: string[] = []
    for (const index of moved.reverse()) {
      try { await movePathIfAbsent(to[index], from[index]) }
      catch { remaining.push(to[index]) }
    }
    if (remaining.length) throw new Error(`移动中断，以下文件保留在新位置：${remaining.join("、")}`)
    throw error
  }
}
