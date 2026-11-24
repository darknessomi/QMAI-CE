import { parseFrontmatter } from "./frontmatter"

type Redirect = (target: string) => string

function relativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^(?:wiki|QM)\//, "").replace(/\.md$/, "")
}

/** Build against the pre-merge tree. A bare reference is usable only if its old owner is unique. */
export function createMergeRedirect(removedPaths: string[], canonicalPath: string, allPaths: string[]): Redirect {
  const removed = new Set(removedPaths.map(relativePath))
  const owners = new Map<string, Set<string>>()
  for (const path of allPaths.map(relativePath)) {
    const stem = path.split("/").pop()!
    const paths = owners.get(stem) ?? new Set<string>()
    paths.add(path)
    owners.set(stem, paths)
  }
  const destination = relativePath(canonicalPath)
  const destName = destination.split("/").pop()!
  return (target: string) => {
    const match = /^(\s*)([^#|]+?)(\s*)([#|][\s\S]*)?$/.exec(target)
    if (!match) return target
    const [, leading, path, trailing, suffix = ""] = match
    const normalized = path.replace(/\\/g, "/")
    const key = relativePath(normalized)
    if (!key || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(normalized) || key.split("/").some(s => !s || s === "." || s === "..")) return target
    const prefix = /^(\.\/)?((?:wiki|QM)\/)?/.exec(normalized)![0]
    const pathStyle = normalized.slice(prefix.startsWith("./") ? 2 : 0).includes("/")
    const matches = owners.get(key)
    const source = pathStyle ? key : matches?.size === 1 ? [...matches][0] : undefined
    if (!source || !removed.has(source)) return target
    const canonical = pathStyle || owners.get(destName)?.size !== 1 ? destination : destName
    return leading + prefix + canonical + (normalized.endsWith(".md") ? ".md" : "") + trailing + suffix
  }
}

const WIKI_LINK = /\[\[([^\]\n]+)\]\]/g
// Keep literal examples untouched when rewriting rendered links.
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`+[^`\n]*?`+)/g

function redirectWikilinks(text: string, redirect: Redirect): string {
  return text.split(CODE).map((part, i) => i % 2 ? part : part.replace(WIKI_LINK, (_m, target: string) => "[[" + redirect(target) + "]]")).join("")
}

const RELATED_FIELD = /^related[ \t]*:[^\r\n]*(?:\r?\n(?:[ \t]+[^\r\n]+|-[ \t]+[^\r\n]+))*/m

function relatedValues(parsed: ReturnType<typeof parseFrontmatter>): string[] {
  let values = parsed.frontmatter?.related
  // Unquoted [[target]] is a nested array in YAML, but older project files
  // use it as a literal link, either alone or as a block list item.
  const field = RELATED_FIELD.exec(parsed.rawBlock)?.[0]
  if (field?.includes("[[")) {
    const quoted = field.replace(/(^related[ \t]*:[ \t]*|^[ \t]*-[ \t]+)(\[\[[^\]\r\n]+\]\])(?=[ \t]*(?:#.*)?\r?$)/gm,
      (_m, prefix: string, link: string) => prefix + JSON.stringify(link))
    if (quoted !== field) values = parseFrontmatter("---\n" + quoted + "\n---\n").frontmatter?.related
  }
  return typeof values === "string" ? [values] : values ?? []
}

export function rewritePageLinks(content: string, redirect: Redirect, inherited: string[] = []): string {
  if (!inherited.length && !content.includes("[[") && !/^related[ \t]*:/m.test(content)) return content
  const parsed = parseFrontmatter(content)
  const { rawBlock } = parsed
  if (!rawBlock) return redirectWikilinks(content, redirect)
  const offset = content.indexOf(rawBlock)
  let header = rawBlock
  const existing = relatedValues(parsed)
  const seen = new Set<string>()
  const next = [...existing, ...inherited].map(value => value.startsWith("[[") && value.endsWith("]]")
    ? "[[" + redirect(value.slice(2, -2)) + "]]" : redirect(value)).filter(value => {
    const key = /[\/#|]/.test(value) ? value : value.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (next.length !== existing.length || next.some((v, i) => v !== existing[i])) {
    const field = "related: " + JSON.stringify(next)
    // Keep other YAML keys and the original newline convention intact. Match the entire
    // field, including quoted wikilinks that themselves contain closing brackets.
    header = RELATED_FIELD.test(header) ? header.replace(RELATED_FIELD, () => field)
      : header.replace(/(\r?\n)---[ \t]*(?=\r?\n|$)/, (_m, nl: string) => nl + field + nl + "---")
  }
  return content.slice(0, offset) + header + redirectWikilinks(content.slice(offset + rawBlock.length), redirect)
}

export function inheritedRelated(pages: { content: string }[]): string[] {
  return pages.flatMap(page => relatedValues(parseFrontmatter(page.content)))
}

// A stand-alone index entry for a removed page disappears. In a mixed-reference
// line, keep its other entries and update the affected link in place.
export function rewriteIndexLinks(content: string, redirect: Redirect): string {
  const { rawBlock } = parseFrontmatter(content)
  const offset = rawBlock ? content.indexOf(rawBlock) + rawBlock.length : 0
  const header = offset ? rewritePageLinks(content.slice(0, offset), redirect) : ""
  const body = content.slice(offset)
  let inFence = ""
  const lines = body.split(/\n/).flatMap(line => {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (!inFence) inFence = fence
      else if (fence[0] === inFence[0] && fence.length >= inFence.length) inFence = ""
      return [line]
    }
    if (inFence) return [line]
    let changed = 0
    let other = 0
    function replace(target: string): string {
      const next = redirect(target)
      if (next === target) other++
      else changed++
      return next
    }
    const rewritten = line.split(CODE).map((part, i) => i % 2 ? part : part.replace(
      /\[\[([^\]\n]+)\]\]|(\[[^\]\n]*\]\()(?:<([^>\n]+)>|([^\s)]+))((?:\s+"[^"]*")?\))/g,
      (original, wiki: string | undefined, open: string, bracketed: string | undefined, plain: string, close: string) => {
        if (wiki !== undefined) return "[[" + replace(wiki) + "]]"
        const target = bracketed ?? plain
        const next = replace(target)
        return target === next ? original : open + (bracketed === undefined ? next : "<" + next + ">") + close
      },
    )).join("")
    const standalone = /^\s*(?:(?:[-*+]\s+|\d+[.)]\s+))?(?:\[\[|\[[^\]\n]+\]\()/.test(line)
    if (changed && !other && standalone) return []
    if (!changed && !other) {
      const bare = /^\s*(?:[-*+]\s+)?([^\s`]+\.md(?:#[^\s]*)?)\s*$/.exec(line)
      if (bare && redirect(bare[1]) !== bare[1]) return []
    }
    return [rewritten]
  })
  return header + lines.join("\n")
}
