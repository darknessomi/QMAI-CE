import { listDirectory, readFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import type { FileNode, WikiProject } from "@/types/wiki"
import type { ExportDocument, ExportDocumentBlock, ExportSource } from "./types"

export interface CollectorFileApi {
  listDirectory(path: string): Promise<FileNode[]>
  readFile(path: string): Promise<string>
}

const defaultFileApi: CollectorFileApi = { listDirectory, readFile }
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" })
export const EXPORT_SOURCES: ExportSource[] = [
  "chapters",
  "outlines",
]

function joinPath(...parts: string[]): string {
  return parts.map((part, index) => index === 0 ? part.replace(/[\\/]+$/g, "") : part.replace(/^[\\/]+|[\\/]+$/g, "")).join("/")
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/i, "") || "未命名内容"
}

function parseChineseOrderNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10)
  const digits: Record<string, number> = {
    零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  }
  const tenIndex = value.indexOf("十")
  if (tenIndex >= 0) {
    const left = value.slice(0, tenIndex)
    const right = value.slice(tenIndex + 1)
    return (left ? digits[left] ?? 0 : 1) * 10 + (right ? digits[right] ?? 0 : 0)
  }
  let result = 0
  for (const character of value) {
    if (digits[character] === undefined) return null
    result = result * 10 + digits[character]
  }
  return result || null
}

function extractPageOrderFromTitle(title: string): number | null {
  const structured = title.match(/第\s*([0-9零一二两三四五六七八九十]+)\s*[章节卷]/)
  if (structured?.[1]) return parseChineseOrderNumber(structured[1])
  const numeric = title.match(/(\d+)/)
  return numeric?.[1] ? Number.parseInt(numeric[1], 10) : null
}

function readFrontmatterChapterNumber(content: string): number | null {
  const raw = parseFrontmatter(content).frontmatter?.chapter_number
  const number = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN
  return Number.isFinite(number) && number > 0 ? number : null
}

function contentBlock(content: string, fallbackTitle: string): ExportDocumentBlock {
  const parsed = parseFrontmatter(content)
  const normalized = parsed.body.replace(/\r\n/g, "\n").trim()
  const lines = normalized.split("\n")
  const headingIndex = lines.findIndex((line) => /^#\s+/.test(line))
  const headingTitle = headingIndex >= 0
    ? lines[headingIndex].replace(/^#\s+/, "").trim()
    : ""
  const frontmatterTitle = typeof parsed.frontmatter?.title === "string"
    ? parsed.frontmatter.title.trim()
    : ""
  const title = frontmatterTitle || headingTitle || fallbackTitle
  if (headingIndex >= 0) lines.splice(headingIndex, 1)
  const paragraphs = lines
    .join("\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
  return { title, paragraphs }
}

interface CollectedMarkdown {
  block: ExportDocumentBlock
  fileName: string
  order: number | null
}

function displayTitleFromFileName(fileName: string): string {
  return baseName(fileName).replace(/-/g, " ")
}

function sortCollectedMarkdown(items: CollectedMarkdown[]): CollectedMarkdown[] {
  return items.sort((left, right) => {
    if (left.order !== null && right.order !== null && left.order !== right.order) {
      return left.order - right.order
    }
    if (left.order !== null && right.order === null) return -1
    if (left.order === null && right.order !== null) return 1
    return collator.compare(left.block.title, right.block.title)
      || collator.compare(left.fileName, right.fileName)
  })
}

async function collectMarkdownTree(
  nodes: FileNode[],
  source: "chapters" | "outlines",
  api: CollectorFileApi,
): Promise<CollectedMarkdown[]> {
  const directories = nodes
    .filter((node) => node.is_dir)
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
  const result: CollectedMarkdown[] = []

  // KnowledgeTree 同级顺序：目录始终排在文件之前，并递归输出目录内容。
  for (const directory of directories) {
    result.push(...await collectMarkdownTree(directory.children ?? [], source, api))
  }

  const siblingFiles: CollectedMarkdown[] = []
  for (const file of nodes.filter((node) => !node.is_dir && node.name.toLowerCase().endsWith(".md"))) {
    try {
      const content = await api.readFile(file.path)
      const fallbackTitle = displayTitleFromFileName(file.name)
      const block = contentBlock(content, fallbackTitle)
      siblingFiles.push({
        block,
        fileName: file.name,
        order: source === "chapters"
          ? (readFrontmatterChapterNumber(content)
            ?? extractPageOrderFromTitle(block.title)
            ?? extractPageOrderFromTitle(fallbackTitle))
          : (extractPageOrderFromTitle(block.title)
            ?? extractPageOrderFromTitle(fallbackTitle)),
      })
    } catch {
      // 单个文件不可读时跳过，其余内容仍可导出。
    }
  }
  result.push(...sortCollectedMarkdown(siblingFiles))
  return result
}

async function collectMarkdownDirectory(
  project: WikiProject,
  source: "chapters" | "outlines",
  directory: string,
  api: CollectorFileApi,
): Promise<ExportDocument[]> {
  let nodes: FileNode[]
  try {
    nodes = await api.listDirectory(directory)
  } catch {
    return []
  }
  const collected = await collectMarkdownTree(nodes, source, api)
  const blocks = collected.map((item) => item.block)
  if (blocks.length === 0) return []
  return [{
    title: `${project.name}-${source === "chapters" ? "章节" : "大纲"}`,
    source,
    blocks,
  }]
}
export async function collectSourceDocuments(
  project: WikiProject,
  source: ExportSource,
  api: CollectorFileApi = defaultFileApi,
): Promise<ExportDocument[]> {
  switch (source) {
    case "chapters":
      return collectMarkdownDirectory(project, source, joinPath(project.path, "wiki/chapters"), api)
    case "outlines":
      return collectMarkdownDirectory(project, source, joinPath(project.path, "wiki/outlines"), api)
  }
}

export async function collectAllProjectSources(
  project: WikiProject,
  api: CollectorFileApi = defaultFileApi,
): Promise<Record<ExportSource, ExportDocument[]>> {
  const settled = await Promise.allSettled(
    EXPORT_SOURCES.map((source) => collectSourceDocuments(project, source, api)),
  )
  return Object.fromEntries(EXPORT_SOURCES.map((source, index) => [
    source,
    settled[index].status === "fulfilled" ? settled[index].value : [],
  ])) as Record<ExportSource, ExportDocument[]>
}
