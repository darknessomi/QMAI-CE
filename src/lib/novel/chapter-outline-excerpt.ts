/** 章纲超预算时优先保留场景、标题及作者的执行约束，保留原文顺序。 */
export function fitChapterOutline(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const marker = "【章纲已按预算节选】"
  if (maxChars <= marker.length + 2) return text.slice(0, Math.max(0, maxChars))
  const room = maxChars - marker.length - 2
  const lines = text.split(/\r?\n/)
  const isKey = (line: string) => /^\s*(?:#{1,6}\s|S\d+\b)/i.test(line) || /场景|目标|必须|禁止|不得|不能|伏笔|钩子|边界/.test(line)
  const keyLines = lines.filter(isKey).join("\n")
  if (keyLines && keyLines.length <= room) {
    let extra = room - keyLines.length
    const selected: string[] = []
    for (const line of lines) {
      if (isKey(line)) selected.push(line)
      else if (extra > 1) {
        const excerpt = line.slice(0, extra - 1)
        selected.push(excerpt)
        extra -= excerpt.length + 1
      }
    }
    return [marker, ...selected].join("\n")
  }
  const source = keyLines || text
  const head = Math.floor(room / 2)
  return `${source.slice(0, head)}\n${marker}\n${source.slice(-(room - head))}`
}
