import { fileExists, readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { WritingProgress } from "./tracking-types"

export function progressPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/wiki/memory/writing-progress.md`
}

export function serializeContextMd(progress: WritingProgress): string {
  const chapter = progress.lastCompletedChapter ? `第${progress.lastCompletedChapter}章` : ""
  const latest = [chapter, progress.lastCompletedChapterTitle].filter(Boolean).join("：")
  const lines: string[] = [
    "# 写作进度追踪",
    "",
    "| 项目 | 内容 |",
    "|---|---|",
    `| 最近已提取正文 | ${latest || "暂无"} |`,
    `| 最后更新 | ${progress.lastUpdated} |`,
    `| 当前剧情阶段 | ${progress.currentArc} |`,
    `| 活跃伏笔数 | ${progress.activeForeshadowingCount}条 |`,
  ]

  if (progress.keyPendingForeshadowing.length > 0) {
    lines.push(`| 关键待回收伏笔 | ${progress.keyPendingForeshadowing.join("、")} |`)
  }
  lines.push(`| 当前关系状态 | ${progress.relationshipStatus} |`)
  lines.push("")

  if (progress.nextChapterGuidance) {
    lines.push("## 下一章指引")
    lines.push(progress.nextChapterGuidance)
    lines.push("")
  }

  if (progress.notes.length > 0) {
    lines.push("## 注意事项")
    for (const note of progress.notes) {
      lines.push(`- ${note}`)
    }
  }

  return lines.join("\n")
}

function parseContextMd(content: string): WritingProgress {
  const progress: WritingProgress = {
    lastCompletedChapter: 0,
    lastCompletedChapterTitle: "",
    lastUpdated: "",
    currentArc: "",
    activeForeshadowingCount: 0,
    keyPendingForeshadowing: [],
    relationshipStatus: "",
    nextChapterGuidance: "",
    notes: [],
  }

  // 解析表格行
  const tableLineRegex = /\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/
  for (const line of content.split("\n")) {
    const m = tableLineRegex.exec(line)
    if (!m) continue
    const key = m[1].trim()
    const value = m[2].trim()
    if (key === "最近已提取正文") {
      const match = value.match(/^第(\d+)章(?:[：:]\s*(.+))?$/)
      if (match) {
        progress.lastCompletedChapter = parseInt(match[1], 10)
        progress.lastCompletedChapterTitle = match[2] ?? ""
      }
    } else if (key === "最后更新") {
      progress.lastUpdated = value
    } else if (key === "当前剧情阶段") {
      progress.currentArc = value
    } else if (key === "活跃伏笔数") {
      const n = value.match(/(\d+)/)
      if (n) progress.activeForeshadowingCount = parseInt(n[1], 10)
    } else if (key === "关键待回收伏笔") {
      progress.keyPendingForeshadowing = value.split(/[、,，]\s*/).filter(Boolean)
    } else if (key === "当前关系状态") {
      progress.relationshipStatus = value
    }
  }

  // 解析下一章指引
  const guidanceMatch = content.match(/## 下一章指引\n([\s\S]*?)(?:\n## |$)/)
  if (guidanceMatch) {
    progress.nextChapterGuidance = guidanceMatch[1].trim()
  }

  // 解析注意事项
  const notesMatch = content.match(/## 注意事项\n([\s\S]*?)$/)
  if (notesMatch) {
    const noteLines = notesMatch[1].split("\n").map((l) => l.replace(/^- /, "").trim()).filter(Boolean)
    progress.notes = noteLines
  }

  return progress
}

export async function readContextMd(projectPath: string): Promise<WritingProgress | null> {
  const path = progressPath(projectPath)
  return await fileExists(path) ? parseContextMd(await readFile(path)) : null
}
