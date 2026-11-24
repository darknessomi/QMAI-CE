

export function makeSafeFileSlug(title: string, fallback = "untitled", maxBytes = 240): string {
  const slug = title
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/[^\p{L}\p{N}._-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  let value = ""
  let bytes = 0
  const encoder = new TextEncoder()
  for (const character of slug) {
    const size = encoder.encode(character).length
    if (value.length + character.length > 80 || bytes + size > maxBytes) break
    bytes += size
    value += character
  }
  return value || fallback
}

function stripChapterPrefix(title: string): string {
  const normalized = title.normalize("NFKC").trim()
  return normalized
    .replace(/^第\s*(?:\d+|[零〇一二三四五六七八九十百千万两]+)\s*[章节卷回]\s*[-_:：，、.。]?\s*/, "")
    .trim()
}

export function makeDefaultChapterTitle(chapterNumber: number, chapterName = ""): string {
  const normalizedNumber = Math.max(1, Math.trunc(chapterNumber))
  const cleanedName = stripChapterPrefix(chapterName)
  return cleanedName ? `第${normalizedNumber}章-${cleanedName}` : `第${normalizedNumber}章`
}

export function makeChapterFileStem(title: string, chapterNumber?: number | null): string {
  const cleanTitle = title.normalize("NFKC").trim()
  if (typeof chapterNumber === "number" && Number.isFinite(chapterNumber) && chapterNumber > 0) {
    const namePart = stripChapterPrefix(cleanTitle)
    // Allow room for the extension and duplicate-name suffix added by callers.
    const budget = 240 - new TextEncoder().encode(`第${chapterNumber}章-`).length
    const safeName = namePart ? makeSafeFileSlug(namePart, "untitled", budget) : ""
    return safeName ? `第${chapterNumber}章-${safeName}` : `第${chapterNumber}章`
  }
  return makeSafeFileSlug(cleanTitle)
}

export function makeChapterFileName(title: string, chapterNumber?: number | null): string {
  return `${makeChapterFileStem(title, chapterNumber)}.md`
}
