/**
 * 帮助链接集中配置
 *
 * 用途：所有面板"标题 + 问号"的帮助超链接统一在这里管理。
 * 添加新链接：在 HELP_LINKS 里加一行即可。
 */
const guide = "https://github.com/darknessomi/QMAI-CE"
export const HELP_LINKS = {
  settings: `${guide}#基本使用流程`,
  graph: `${guide}#readme`,
  review: `${guide}#-审查系统`,
} as const

export type HelpLinkKey = keyof typeof HELP_LINKS

/**
 * 取帮助链接 URL。找不到时返回 null，调用方应当降级为不显示链接。
 */
export function getHelpLinkUrl(key: HelpLinkKey): string | null {
  return HELP_LINKS[key] ?? null
}
