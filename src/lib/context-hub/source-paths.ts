import type { ContextSourceKind } from "./types"

const DATA_SOURCE_KINDS: Record<string, ContextSourceKind[]> = {
  outline: ["outline"],
  chapterOutline: ["outline"],
  volumeContext: ["outline", "snapshot"],
  snapshots: ["snapshot"],
  recentChapterContents: ["chapter"],
  fallbackRecentSummaries: ["chapter"],
  fallbackPreviousEnding: ["chapter", "snapshot"],
  fallbackCharacterStates: ["entity"],
  fallbackForeshadowingStates: ["memory", "entity"],
  fallbackTimeline: ["memory"],
  relatedSettings: ["entity", "setting", "reference"],
  canonRules: ["entity", "setting", "reference"],
  sourceCanon: ["setting"],
  writingStyle: ["entity", "setting", "reference"],
  searchResults: ["chapter", "outline", "memory", "setting", "entity", "snapshot"],
  graphSearchResults: ["chapter", "outline", "memory", "setting", "entity", "snapshot"],
  revisionFeedback: ["chapter", "snapshot"],
  cognitionText: ["entity", "outline"],
  sectionBriefing: ["outline", "snapshot", "entity", "memory"],
  retrieval: ["retrieval"],
}

export function normalizeContextPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "")
}

export function classifyContextSourcePath(projectPath: string, path: string): ContextSourceKind {
  const project = normalizeContextPath(projectPath).toLowerCase()
  const normalized = normalizeContextPath(path)
  const lower = normalized.toLowerCase()
  const relative = (lower.startsWith(`${project}/`) ? lower.slice(project.length + 1) : lower).replace(/^qm\//, "wiki/")

  if (relative === ".qmai/context-cache" || relative.startsWith(".qmai/context-cache/")) return "ignored"
  if (relative === ".qmai/writing-style.json") return "setting"
  if (relative.startsWith("wiki/chapters/")) return "chapter"
  if (relative.startsWith("wiki/outlines/")) return "outline"
  if (relative.startsWith("wiki/memory/")) return "memory"
  if (relative.startsWith("wiki/entities/") || relative.startsWith("wiki/concepts/") || relative.startsWith("wiki/characters/")) return "entity"
  if (relative.startsWith("wiki/settings/") || relative === "wiki/canon.md" || relative === "wiki/writing-style.md") return "setting"
  if (relative.startsWith("wiki/") && relative.endsWith(".md")) return "reference"
  if (relative === ".qmai/persona-skills/index.json") return "entity"
  if (relative === ".qmai/novel/cognition-state.json") return "entity"
  if (relative === ".qmai/novel/character-states.json") return "entity"
  if (relative === ".qmai/novel/foreshadowing-tracker.json") return "memory"
  if (relative === ".qmai/novel/fanfic-canon.md") return "setting"
  if (relative === ".qmai/novel/revision-feedback.json") return "snapshot"
  if (relative === ".qmai/novel/timeline.json") return "memory"
  if (relative.startsWith(".qmai/novel/snapshots/")) return "snapshot"
  if (relative.startsWith(".qmai/retrieval/")) return "retrieval"
  return "other"
}

export function getDataSourceKinds(sourceName: string): ContextSourceKind[] {
  return [...(DATA_SOURCE_KINDS[sourceName] ?? ["other"])]
}

/**
 * 每个数据源的依赖路径前缀（项目相对路径，已归一化）。
 * 命中依赖戳时只哈希这些前缀下的文件，避免同类其它文件变化导致整类缓存失效。
 * 未列出的源回退到 `DATA_SOURCE_KINDS` 聚合（兜底，保持现有行为）。
 * 原则：宁可过覆盖、不可漏（漏了会命中过时缓存）。
 */
export const SOURCE_DEPENDENCY_PREFIXES: Record<string, string[]> = {
  cognitionText: [".qmai/novel/cognition-state.json", "wiki/outlines/"],
  // 三个设定源可从任意知识库 Markdown 回退，使用上方的来源类别计算依赖戳。
  sourceCanon: [".qmai/novel/fanfic-canon.md"],
  outline: ["wiki/outlines/"],
  chapterOutline: ["wiki/outlines/"],
  volumeContext: ["wiki/outlines/", "wiki/settings/", "wiki/canon.md"],
  snapshots: [".qmai/novel/snapshots/", ".qmai/novel/revision-feedback.json"],
  recentChapterContents: ["wiki/chapters/"],
  fallbackRecentSummaries: ["wiki/chapters/"],
  fallbackPreviousEnding: ["wiki/chapters/", ".qmai/novel/snapshots/"],
  fallbackCharacterStates: [".qmai/novel/character-states.json", "wiki/chapters/"],
  fallbackForeshadowingStates: [".qmai/novel/foreshadowing-tracker.json", "wiki/chapters/"],
  fallbackTimeline: [".qmai/novel/timeline.json", "wiki/chapters/"],
  revisionFeedback: ["wiki/chapters/", ".qmai/novel/snapshots/", ".qmai/novel/revision-feedback.json"],
  retrieval: [".qmai/retrieval/"],
  sectionBriefing: [".qmai/persona-skills/index.json", "wiki/outlines/", ".qmai/novel/snapshots/", ".qmai/novel/foreshadowing-tracker.json", ".qmai/novel/character-states.json", "wiki/memory/writing-progress.md"],
}

/** 返回某数据源的依赖路径前缀；未声明则返回空（调用方回退到 kind 聚合）。 */
export function getSourceDependencyPrefixes(sourceName: string): string[] {
  return SOURCE_DEPENDENCY_PREFIXES[sourceName] ?? []
}

export function sortContextSourcePaths(paths: string[]): string[] {
  return paths
    .map(normalizeContextPath)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}
