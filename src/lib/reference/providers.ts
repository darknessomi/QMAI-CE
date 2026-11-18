import { listDirectory, readFile } from "@/commands/fs"
import type { ReferenceCategory, ReferenceToken, SkillSubtype } from "./types"
import type { SkillKind, SkillMode, SkillStage } from "@/lib/novel/skill-library"

type ReferenceFileNode = {
  name: string
  path?: string
  is_dir: boolean
  children?: ReferenceFileNode[]
}

export interface ReferenceProvider {
  category: ReferenceCategory
  fetchItems: (projectPath: string) => Promise<ReferenceToken[]>
}

export interface SkillSummary {
  id: string
  name: string
  /** 界面展示名（中文）；title 仍是路由用的机器名。 */
  displayName?: string
  subtype: SkillSubtype
  kind?: SkillKind[]
  stages?: SkillStage[]
  modes?: SkillMode[]
}

interface ConversationSummary {
  id: string
  title: string
}

function simpleId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function truncateTitle(title: string, maxLen = 20): string {
  return title.length > maxLen ? title.slice(0, maxLen) + "..." : title
}

function normalizeProjectPath(projectPath: string): string {
  return projectPath.replace(/\\/g, "/")
}

function nodePath(baseDir: string, node: ReferenceFileNode): string {
  const normalizedPath = node.path ? normalizeProjectPath(node.path) : ""
  if (normalizedPath && normalizedPath !== node.name) return normalizedPath
  return `${baseDir}/${node.name}`
}

function stripExtension(name: string, extensions: string[]): string {
  const extension = extensions.find((candidate) => name.toLowerCase().endsWith(candidate))
  return extension ? name.slice(0, -extension.length) : name
}

function unquoteYamlValue(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "").trim()
}

function extractFrontmatterField(content: string, field: string): string | null {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!frontmatterMatch?.[1]) return null
  const fieldPattern = new RegExp(`^${field}:\\s*(.+?)\\s*$`, "m")
  const fieldMatch = frontmatterMatch[1].match(fieldPattern)
  return fieldMatch?.[1] ? unquoteYamlValue(fieldMatch[1]) : null
}

function extractMarkdownHeading(content: string): string | null {
  const headingMatch = content.match(/^#\s+(.+?)\s*$/m)
  return headingMatch?.[1]?.trim() || null
}

function extractMarkdownTitle(content: string): string | null {
  return extractFrontmatterField(content, "title") || extractMarkdownHeading(content)
}

function hasAsciiLetter(value: string): boolean {
  return /[A-Za-z]/.test(value)
}

function fallbackDisplayTitle(
  category: Extract<ReferenceCategory, "chapter" | "memory" | "outline">,
  rawTitle: string,
): string {
  const stem = rawTitle.split("/").pop() || rawTitle
  if (!hasAsciiLetter(rawTitle)) return rawTitle

  if (category === "chapter") {
    const chapterNumber = stem.match(/chapter[-_\s]*(\d+)/i)?.[1] || stem.match(/(\d+)/)?.[1]
    return chapterNumber ? `第${Number.parseInt(chapterNumber, 10)}章` : "章节"
  }

  if (category === "memory") return "记忆条目"
  return "大纲条目"
}

async function resolveDisplayTitle(
  category: Extract<ReferenceCategory, "chapter" | "memory" | "outline">,
  file: { title: string; path: string },
): Promise<string> {
  try {
    const content = await readFile(file.path)
    if (typeof content === "string" && content.trim()) {
      const parsedTitle = extractMarkdownTitle(content)
      if (parsedTitle?.trim()) return parsedTitle.trim()
    }
  } catch {
    // 文件内容读取失败时使用中文兜底名，避免把技术文件名暴露为主标题。
  }

  return fallbackDisplayTitle(category, file.title)
}

async function collectReferenceFiles(
  baseDir: string,
  nodes: ReferenceFileNode[],
  extensions: string[],
  parentParts: string[] = [],
  visitedDirs = new Set<string>(),
): Promise<Array<{ title: string; path: string }>> {
  const items: Array<{ title: string; path: string }> = []

  for (const node of nodes) {
    const path = nodePath(baseDir, node)
    if (node.is_dir) {
      const nextParentParts = [...parentParts, node.name]
      const childNodes = node.children ?? await (async () => {
        if (visitedDirs.has(path)) return []
        visitedDirs.add(path)
        try {
          return await listDirectory(path) as ReferenceFileNode[]
        } catch {
          return []
        }
      })()
      items.push(...await collectReferenceFiles(path, childNodes, extensions, nextParentParts, visitedDirs))
      continue
    }

    if (!extensions.some((extension) => node.name.toLowerCase().endsWith(extension))) {
      continue
    }

    const stem = stripExtension(node.name, extensions)
    const title = [...parentParts, stem].join("/")
    items.push({ title, path })
  }

  return items
}

function createFileProvider(
  category: Extract<ReferenceCategory, "chapter" | "memory" | "outline">,
  relativeDir: string,
  extensions: Array<".md" | ".json">,
): ReferenceProvider {
  return {
    category,
    fetchItems: async (projectPath) => {
      try {
        const pp = normalizeProjectPath(projectPath)
        const dirPath = `${pp}/${relativeDir}`
        const files = await collectReferenceFiles(
          dirPath,
          await listDirectory(dirPath) as ReferenceFileNode[],
          extensions,
        )
        return await Promise.all(files.map(async (file) => {
          const title = await resolveDisplayTitle(category, file)
          return {
            id: simpleId(),
            category,
            title,
            path: file.path,
            displayTitle: truncateTitle(title),
          }
        }))
      } catch {
        return []
      }
    },
  }
}

export const chapterProvider = createFileProvider(
  "chapter",
  "wiki/chapters",
  [".md"],
)

export const memoryProvider = createFileProvider(
  "memory",
  "wiki/memory",
  [".md"],
)

export const outlineProvider = createFileProvider(
  "outline",
  "wiki/outlines",
  [".md"],
)

export function createSkillProvider(getSkills: () => SkillSummary[]): ReferenceProvider {
  return {
    category: "skill",
    fetchItems: async () =>
      getSkills().map((skill) => {
        const label = skill.displayName?.trim() || skill.name
        return {
          id: simpleId(),
          category: "skill" as const,
          title: skill.name,
          skillId: skill.id,
          skillSubtype: skill.subtype,
          skillKinds: skill.kind,
          skillStages: skill.stages,
          skillModes: skill.modes,
          displayTitle: truncateTitle(label),
        }
      }),
  }
}

export function createChatHistoryProvider(
  getConversations: () => ConversationSummary[],
): ReferenceProvider {
  return {
    category: "chat_history",
    fetchItems: async () =>
      getConversations().map((conversation) => ({
        id: simpleId(),
        category: "chat_history" as const,
        title: conversation.title,
        conversationId: conversation.id,
        displayTitle: truncateTitle(conversation.title),
      })),
  }
}

export function createOutlineHistoryProvider(
  getConversations: () => ConversationSummary[],
): ReferenceProvider {
  return {
    category: "outline_history",
    fetchItems: async () =>
      getConversations().map((conversation) => ({
        id: simpleId(),
        category: "outline_history" as const,
        title: conversation.title,
        conversationId: conversation.id,
        displayTitle: truncateTitle(conversation.title),
      })),
  }
}
