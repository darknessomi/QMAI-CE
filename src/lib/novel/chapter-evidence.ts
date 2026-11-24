import { listDirectory, readFile } from "@/commands/fs"
import { mapWithConcurrency } from "@/lib/async-pool"
import { parseFrontmatter } from "@/lib/frontmatter"
import { isAiExcluded } from "./ai-exclude"
import { isChapterPage, isFinalChapter, parseChapterNumber } from "./chapter-meta"
import { extractChapterNumber, flattenMdFiles } from "./chapter-utils"

export function chapterBound(value: unknown): number | undefined {
  if (value === undefined || value === "") return undefined
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) throw new Error("章号必须是正整数")
  return n
}

function quoteAt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 160)
  const end = Math.min(text.length, index + length + 160)
  const before = text.slice(start, index)
  const after = text.slice(index + length, end)
  const left = before.match(/[^。！？\n]*$/u)?.[0] ?? ""
  const right = after.match(/^[^。！？\n]*[。！？]?/u)?.[0] ?? ""
  return text.slice(index - left.length, index + length + right.length)
}

export async function searchChapterEvidence(chaptersDir: string, query: string, options: {
  from?: number; to?: number; read?: typeof readFile; signal?: AbortSignal
} = {}) {
  const from = chapterBound(options.from) ?? 1
  const to = chapterBound(options.to)
  if (to !== undefined && to < from) throw new Error("结束章号不能小于起始章号")
  const keyword = query.trim()
  if (!keyword) throw new Error("请输入要在定稿正文中核对的原词或短句")
  options.signal?.throwIfAborted()
  const files = flattenMdFiles(await listDirectory(chaptersDir))
  let scanned = 0
  let failed = 0
  const matches = await mapWithConcurrency(files, 12, async file => {
    options.signal?.throwIfAborted()
    let content: string
    try { content = await (options.read ?? readFile)(file.path) } catch { failed++; return null }
    const { frontmatter, body } = parseFrontmatter(content)
    if (!frontmatter || isAiExcluded(frontmatter) || !isChapterPage(frontmatter) || !isFinalChapter(frontmatter)) return null
    const number = parseChapterNumber(frontmatter.chapter_number) ?? extractChapterNumber(file.name)
    if (number === null || number < from || (to !== undefined && number > to)) return null
    scanned++
    const index = body.indexOf(keyword)
    if (index === -1) return null
    const title = typeof frontmatter.title === "string" && frontmatter.title.trim() || file.name.replace(/\.md$/i, "")
    return { number, path: file.path, title, quote: quoteAt(body, index, keyword.length) }
  }, { signal: options.signal })
  options.signal?.throwIfAborted()
  const all = matches.filter(item => item !== null).sort((a, b) => a.number - b.number)
  const hits = all.slice(0, 20)
  const range = to === undefined ? `第 ${from} 章起` : `第 ${from} 至 ${to} 章`
  const coverage = `${range}，已核对 ${scanned} 份定稿正文，${all.length} 章含原词「${keyword}」` +
    (all.length > hits.length ? `，显示前 ${hits.length} 章` : "") +
    (failed ? `；另有 ${failed} 份文件读取失败` : "")
  return { hits, coverage }
}
