import { parseFrontmatter } from "./frontmatter"
import { normalizePath } from "./path-utils"

// Keep the root prefix even for top-level pages. A legacy bare ID must never
// collide with a current page, and QM/ and wiki/ describe the same documents.
export function wikiEmbeddingId(projectPath: string, pagePath: string): string | null {
  const root = normalizePath(projectPath).replace(/\/+$/, "")
  const path = normalizePath(pagePath)
  const relative = path.startsWith(root + "/") ? path.slice(root.length + 1) : path
  if (!/^(?:wiki|QM)\//.test(relative) || !/\.md$/i.test(relative)) return null
  const parts = relative.split("/").slice(1)
  if (parts.some(part => !part || part === "." || part === ".." || /[\u0000-\u001f\u007f]/.test(part))) return null
  const stem = parts.join("/").slice(0, -3)
  if (!stem || stem.endsWith("/")) return null
  return "wiki/" + stem.replace(/%/g, "%25").replace(/'/g, "%27")
}

export function wikiEmbeddingPath(projectPath: string, id: string): string | null {
  if (!id.startsWith("wiki/")) return null
  const rel = id.replace(/%27/g, "'").replace(/%25/g, "%") + ".md"
  const path = normalizePath(projectPath).replace(/\/+$/, "") + "/" + rel
  return wikiEmbeddingId(projectPath, path) === id ? path : null
}

export function wikiEmbeddingTitle(content: string, fallback: string): string {
  const title = parseFrontmatter(content).frontmatter?.title
  return typeof title === "string" && title.trim() ? title.trim() : fallback
}
