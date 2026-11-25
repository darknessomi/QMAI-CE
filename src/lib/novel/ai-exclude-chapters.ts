import { readFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { searchWiki } from "@/lib/search"
import { isAiExcludedContent } from "./ai-exclude"
import { parseChapterMeta } from "./chapter-meta"
import { eligibleChapterNumber } from "@/lib/sag-search"

/** 累计状态只有在整个来源区间可读时才可作为前情。 */
export function hasReadableHistory(through: number, readable: ReadonlyMap<number, string>): boolean {
  if (!Number.isSafeInteger(through) || through <= 0 || through > readable.size) return false
  for (let n = 1; n <= through; n++) if (!readable.has(n)) return false
  return true
}

export async function readVisibleChapter(projectPath: string, number: number, readable?: ReadonlyMap<number, string>): Promise<string> {
  const matches = (path: string, text: string) => eligibleChapterNumber(path, text, number + 1) === number
  const path = readable
    ? readable.get(number)
    : (await searchWiki(projectPath, `chapter_number:${number}`, { localOnly: true, topK: 1, acceptFile: matches }))[0]?.path
  if (!path) return ""
  const text = await readFile(path).catch(() => "")
  return matches(path, text) ? text : ""
}

/**
 * 按**章号**判断「这一章是否被选中（AI 不读取）」。
 *
 * 为什么需要它：`ai-exclude.ts` 只管得住"读正文"的路径；可记忆快照
 * （摘要 / 人物状态 / 时间线 / 结尾钩子）是**另一份数据**，按章号存放，
 * 根本不含章节 id。不按章号反查一次，被选中的章节依旧会通过快照进入模型 ——
 * 用户看到的就是"明明选中了，AI 还是知道这一章发生了什么"。
 *
 * 反查方式与既有降级链路一致：`searchWiki("chapter_number:N")` 找候选文件，
 * 再**用文件自己的 frontmatter 章号复核**。复核这一步不能省 ——
 * `searchWiki` 是全文检索（`chapter_number:7` 也会命中 17 / 70 的正文），
 * 只取 `results[0]` 会把别人的排除状态算到这一章头上。
 */
const MAX_CANDIDATES_PER_CHAPTER = 5

export async function isChapterNumberAiExcluded(
  projectPath: string,
  chapterNumber: number,
): Promise<boolean> {
  if (!Number.isFinite(chapterNumber) || chapterNumber <= 0) return false
  try {
    const results = await searchWiki(projectPath, `chapter_number:${chapterNumber}`, { localOnly: true, includeExcludedMetadata: true })
    for (const result of results.slice(0, MAX_CANDIDATES_PER_CHAPTER)) {
      const content = await readFile(result.path).catch(() => "")
      if (!content) continue
      const meta = parseChapterMeta(
        (parseFrontmatter(content).frontmatter ?? {}) as Record<string, unknown>,
      )
      if (meta?.chapterNumber !== chapterNumber) continue
      return isAiExcludedContent(content)
    }
  } catch {
    // 检索不可用（未建索引 / 读盘失败）时按"未排除"处理：宁可多给上下文，
    // 也不要让一次检索故障把整本书的快照全砍掉。
  }
  return false
}

/** 批量版：给快照窗口（几条到十几条）一次性算出"哪些章号要跳过"。 */
export async function listAiExcludedChapterNumbers(
  projectPath: string,
  chapterNumbers: readonly number[],
  readable?: ReadonlyMap<number, string>,
): Promise<Set<number>> {
  if (readable) return new Set(chapterNumbers.filter(n => !readable.has(n)))
  const unique = [...new Set(chapterNumbers.filter((value) => Number.isFinite(value) && value > 0))]
  if (unique.length === 0) return new Set()
  const flags = await Promise.all(
    unique.map(async (chapterNumber) => [chapterNumber, await isChapterNumberAiExcluded(projectPath, chapterNumber)] as const),
  )
  return new Set(flags.filter(([, excluded]) => excluded).map(([chapterNumber]) => chapterNumber))
}
