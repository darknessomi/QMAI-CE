import { extractChapterNumber } from "@/lib/novel/chapter-utils"
import { pruneVersions, saveVersion, type VersionKind } from "@/lib/novel/version-store"
import { isChapterPath, isOutlinePath } from "@/lib/path-utils"

/** 从完整路径取文件名并去掉 `.md` 扩展名（只取最后一段，兼容 Windows 反斜杠）。 */
function fileNameStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return base.replace(/\.md$/i, "")
}

/**
 * 版本 key 的派生规则。
 *
 * 章节用「章节号」（`第12章` → 12）：同一章的多个版本要落在同一个目录里，
 * 否则改了标题就会换目录、历史断开。
 *
 * 大纲用「文件名」：大纲没有稳定的编号，文件名是它唯一的身份。
 */
function versionKeyOf(path: string, kind: VersionKind): number | string | null {
  const stem = fileNameStem(path)
  return kind === "chapter" ? extractChapterNumber(stem) : stem
}

/**
 * 保存前的历史版本钩子（章节 + 大纲）。
 *
 * 抽成独立函数是为了可单测：preview-panel 有六千多行，
 * 挂载它来验证「保存前有没有留版本」成本太高、也太脆。
 *
 * 历史版本是「保险」而非「主流程」：写不进去只能说明这次没有回退点，
 * 但绝不能挡住用户的保存——所以任何失败都只记日志，不向外抛。
 */
async function snapshotBeforeSave(
  kind: VersionKind,
  input: { projectPath: string; path: string; previousContent: string },
): Promise<void> {
  const { projectPath, path, previousContent } = input
  // 没内容可回退：新文件第一次保存、或旧文件本来是空的，不留版本。
  if (previousContent.trim() === "") return

  const key = versionKeyOf(path, kind)

  try {
    await saveVersion({ projectPath, kind, key, content: previousContent })
  } catch (error) {
    console.warn(`[history] 保存${kind === "chapter" ? "章节" : "大纲"}历史版本失败（不影响本次保存）：`, path, error)
    return
  }

  // 清理旧版本不 await：它只是容量/时效维护，和这次保存结果无关，
  // 等它跑完会白白拖慢保存。失败也只记日志。
  void pruneVersions(projectPath, kind, key).catch((error) => {
    console.warn("[history] 清理历史版本失败：", path, error)
  })
}

/** 编辑器保存章节前的历史版本钩子。 */
export async function snapshotChapterBeforeSave(input: {
  projectPath: string
  path: string
  previousContent: string
}): Promise<void> {
  await snapshotBeforeSave("chapter", input)
}

/** 编辑器保存大纲前的历史版本钩子。 */
export async function snapshotOutlineBeforeSave(input: {
  projectPath: string
  path: string
  previousContent: string
}): Promise<void> {
  await snapshotBeforeSave("outline", input)
}

/**
 * 按路径自动选择钩子：章节走章节版本，大纲走大纲版本，其它文件不处理。
 *
 * 调用方只需要判一次「要不要留版本」，不用自己区分章节与大纲 ——
 * 少一处分支就少一处「加了新类型忘了改」的机会。
 */
export async function snapshotVersionBeforeSave(input: {
  projectPath: string
  path: string
  previousContent: string
}): Promise<void> {
  if (isChapterPath(input.path)) return snapshotBeforeSave("chapter", input)
  if (isOutlinePath(input.path)) return snapshotBeforeSave("outline", input)
}
