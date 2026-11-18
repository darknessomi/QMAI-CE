import { homeDir } from "@tauri-apps/api/path"
import { getExecutableDir } from "@/commands/fs"
import { joinPath } from "./path-utils"
import { isMacOS } from "./platform"

// 新版为唯一正式版，直接使用正式小说目录 QM-BOOK。
const DEFAULT_NOVEL_DIR_NAME = "QM-BOOK"

export async function getDefaultNovelDir(): Promise<string> {
  if (isMacOS()) {
    const home = await homeDir()
    if (!home.startsWith("/")) throw new Error("无法读取当前用户的主目录")
    return joinPath(home, DEFAULT_NOVEL_DIR_NAME)
  }

  const executableDir = await getExecutableDir().catch(() => "")
  const drive = executableDir.trim().match(/^([a-zA-Z]):[\\/]/)?.[1].toUpperCase() ?? "D"
  return `${drive}:\\${DEFAULT_NOVEL_DIR_NAME}`
}
