import { chapterBound, searchChapterEvidence } from "@/lib/novel/chapter-evidence"
import { isAiExcludedContent } from "@/lib/novel/ai-exclude"
import type { Tool } from "../types"
import { listDirectory, readFile } from "@/commands/fs"
import type { ReadTextFile } from "./read-markdown-resource"

interface ChapterSearchMatch {
  chapterName: string
  path: string
  location: "正文" | "文件名"
  snippet: string
}

const MAX_RESULTS = 10
const SNIPPET_RADIUS = 80

function normalizeSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function createContentSnippet(content: string, index: number, keywordLength: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS)
  const end = Math.min(content.length, index + keywordLength + SNIPPET_RADIUS)
  const prefix = start > 0 ? "..." : ""
  const suffix = end < content.length ? "..." : ""
  return `${prefix}${normalizeSnippet(content.slice(start, end))}${suffix}`
}

function createLeadingSnippet(content: string): string {
  const normalized = normalizeSnippet(content)
  if (!normalized) return "（章节内容为空）"
  return normalized.length > 160 ? `${normalized.slice(0, 160)}...` : normalized
}

export function createSearchChaptersTool(
  chaptersDir: string,
  readTextFile: ReadTextFile = readFile,
): Tool {
  return {
    name: "search_chapters",
    description: "按关键词在所有章节中搜索匹配内容。核对剧情、原文或角色何时知情时启用 evidenceOnly，按章号范围仅从定稿正文引用，给出命中章号和路径。未命中该词时须说明查找范围。",
    category: "read",
    parameters: {
      evidenceOnly: { type: "boolean", description: "仅查定稿原文并逐字引用；查证剧情时开启" },
      fromChapter: { type: "integer", description: "起始章号（含）" },
      toChapter: { type: "integer", description: "结束章号（含）" },
      keyword: { type: "string", description: "搜索关键词", required: true },
    },
    execute: async (params, signal) => {
      const keyword = typeof params.keyword === "string" ? params.keyword.trim() : ""
      if (!keyword) {
        return "错误：缺少搜索关键词，无法搜索章节。"
      }

      if (params.evidenceOnly === true || params.fromChapter !== undefined || params.toChapter !== undefined) {
        try {
          const { hits, coverage } = await searchChapterEvidence(chaptersDir, keyword, {
            from: chapterBound(params.fromChapter), to: chapterBound(params.toChapter), read: readTextFile, signal,
          })
          return [coverage, ...hits.map(hit => `第${hit.number}章 · ${hit.path}\n原文：${hit.quote}`)].join("\n")
        } catch (error) {
          return `原文查证未完成：${error instanceof Error ? error.message : String(error)}`
        }
      }

      let files
      try {
        files = await listDirectory(chaptersDir)
      } catch {
        return "错误：无法搜索章节目录，请确认章节库存在。"
      }

      const keywordLower = keyword.toLowerCase()
      const chapterFiles = files
        .filter((file) => !file.is_dir && file.name.toLowerCase().endsWith(".md"))
        .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }))

      const matches: ChapterSearchMatch[] = []
      const failedFiles: string[] = []

      for (const file of chapterFiles) {
        if (matches.length >= MAX_RESULTS) break

        let content: string
        try {
          content = await readTextFile(file.path)
        } catch {
          failedFiles.push(file.name)
          continue
        }

        if (isAiExcludedContent(content)) continue
        const chapterName = file.name.replace(/\.md$/i, "")
        const nameMatches = chapterName.toLowerCase().includes(keywordLower)
        const contentIndex = content.toLowerCase().indexOf(keywordLower)
        if (!nameMatches && contentIndex === -1) continue

        matches.push({
          chapterName,
          path: file.path,
          location: contentIndex >= 0 ? "正文" : "文件名",
          snippet: contentIndex >= 0
            ? createContentSnippet(content, contentIndex, keyword.length)
            : createLeadingSnippet(content),
        })
      }

      if (matches.length === 0) {
        const failedText = failedFiles.length > 0 ? `\n另有 ${failedFiles.length} 个章节读取失败，未纳入搜索。` : ""
        return `未找到匹配章节：${keyword}\n已搜索 ${chapterFiles.length - failedFiles.length} 个章节文件。${failedText}`
      }

      const lines = [`搜索章节内容中匹配「${keyword}」的结果：`]
      for (const [index, match] of matches.entries()) {
        lines.push(`${index + 1}. ${match.chapterName}`)
        lines.push(`路径：${match.path}`)
        lines.push(`命中位置：${match.location}`)
        lines.push(`命中片段：${match.snippet}`)
      }
      if (matches.length >= MAX_RESULTS) {
        lines.push(`仅显示前 ${MAX_RESULTS} 条匹配结果。`)
      }
      if (failedFiles.length > 0) {
        lines.push(`另有 ${failedFiles.length} 个章节读取失败，未纳入搜索。`)
      }
      return lines.join("\n")
    },
  }
}
