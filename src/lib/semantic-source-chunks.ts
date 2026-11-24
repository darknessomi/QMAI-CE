export interface SourceChunk {
  id: string
  index: number
  total: number
  headingPath: string
  overlapBefore: string
  main: string
}

function splitOversizedBlock(block: string, targetChars: number): string[] {
  if (block.length <= targetChars * 1.25) return [block]

  const pieces = block.match(/[^.!?。！？\n]+[.!?。！？]*|[.!?。！？]+|\n+/g) ?? [block]
  const out: string[] = []
  let current = ""
  for (const piece of pieces) {
    if (current && current.length + piece.length > targetChars) {
      out.push(current.trim())
      current = ""
    }
    if (piece.length > targetChars) {
      for (let i = 0; i < piece.length;) {
        let end = Math.min(i + targetChars, piece.length)
        if (end < piece.length && /[\uD800-\uDBFF]/.test(piece[end - 1])) end--
        const slice = piece.slice(i, end).trim()
        if (slice) out.push(slice)
        i = end
      }
    } else {
      current += piece
    }
  }
  if (current.trim()) out.push(current.trim())
  return out
}

function semanticBlocks(content: string, targetChars: number): Array<{ text: string; headingPath: string }> {
  const blocks: Array<{ text: string; headingPath: string }> = []
  const headingStack: string[] = []
  let paragraph: string[] = []
  let paragraphHeading = ""

  const currentHeadingPath = () => headingStack.filter(Boolean).join(" > ")
  const flushParagraph = () => {
    const text = paragraph.join("\n").trim()
    if (text) {
      for (const piece of splitOversizedBlock(text, targetChars)) {
        blocks.push({ text: piece, headingPath: paragraphHeading })
      }
    }
    paragraph = []
  }

  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      flushParagraph()
      const depth = heading[1].length
      headingStack.length = depth - 1
      headingStack[depth - 1] = heading[2].trim()
      blocks.push({ text: line.trim(), headingPath: currentHeadingPath() })
      paragraphHeading = currentHeadingPath()
      continue
    }

    if (line.trim() === "") {
      flushParagraph()
      paragraphHeading = currentHeadingPath()
      continue
    }

    if (paragraph.length === 0) paragraphHeading = currentHeadingPath()
    paragraph.push(line)
  }
  flushParagraph()

  return blocks
}

function overlapSuffix(text: string, maxChars: number): string {
  if (!text || maxChars <= 0) return ""
  if (text.length <= maxChars) return text
  const raw = text.slice(-maxChars)
  const paragraphBreak = raw.search(/\n\s*\n/)
  if (paragraphBreak > 0 && raw.length - paragraphBreak > maxChars * 0.4) {
    return raw.slice(paragraphBreak).trim()
  }
  const sentenceBreak = raw.search(/[.!?。！？]\s+/)
  if (sentenceBreak > 0 && raw.length - sentenceBreak > maxChars * 0.4) {
    return raw.slice(sentenceBreak + 1).trim()
  }
  return raw.trim()
}

export function splitSourceIntoSemanticChunks(
  content: string,
  targetChars: number,
  overlapChars: number,
): SourceChunk[] {
  const target = Math.max(1_000, targetChars)
  const blocks = semanticBlocks(content, target)
  if (blocks.length === 0) return []

  const rawChunks: Array<{ main: string; headingPath: string }> = []
  let current: string[] = []
  let currentLength = 0
  let currentHeading = blocks[0]?.headingPath ?? ""

  const flush = () => {
    const main = current.join("\n\n").trim()
    if (main) rawChunks.push({ main, headingPath: currentHeading })
    current = []
    currentLength = 0
  }

  for (const block of blocks) {
    const nextLength = currentLength + block.text.length + (current.length > 0 ? 2 : 0)
    if (current.length > 0 && nextLength > target) {
      flush()
    }
    if (current.length === 0) currentHeading = block.headingPath
    current.push(block.text)
    currentLength += block.text.length + (current.length > 1 ? 2 : 0)
  }
  flush()

  return rawChunks.map((chunk, idx) => ({
    id: `chunk-${idx + 1}`,
    index: idx + 1,
    total: rawChunks.length,
    headingPath: chunk.headingPath,
    overlapBefore: idx > 0 ? overlapSuffix(rawChunks[idx - 1].main, overlapChars) : "",
    main: chunk.main,
  }))
}
