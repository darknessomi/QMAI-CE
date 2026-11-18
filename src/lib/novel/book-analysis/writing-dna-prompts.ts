const CONSTITUTION_SECTION_TITLE = "风格硬约束"

/**
 * 从整合文档里摘掉「风格硬约束」小节。
 * 注入时硬约束单独放在最前面保证不被截断，正文再跟上，避免同一段内容注入两遍。
 */
export function stripConstitutionSection(integratedDna: string): string {
  const pattern = new RegExp(
    `^#{1,4}\\s*${CONSTITUTION_SECTION_TITLE}[^\\n]*\\n[\\s\\S]*?(?=\\n#{1,4}\\s|(?![\\s\\S]))`,
    "m",
  )
  return integratedDna.replace(pattern, "").replace(/\n{3,}/g, "\n\n").trim()
}
