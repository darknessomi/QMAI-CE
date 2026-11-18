// UI 界面版本：已统一为只保留新版界面，恒为最新版。
export const IS_UI_TEST_BUILD = true

/** UI 测试版用于本机偏好存储的键前缀（仅在测试版内使用，不写入正式配置）。 */
export const UI_TEST_STORAGE_PREFIX = "qm-uitest-"

export type UiTestSkin = "light" | "dark"

export const UI_TEST_SKIN_KEY = `${UI_TEST_STORAGE_PREFIX}skin`

export const UI_TEST_SKINS: Array<{
  id: UiTestSkin
  name: string
  hint: string
}> = [
  { id: "light", name: "青瓷", hint: "青绿主色 · 清晰沉静" },
  { id: "dark", name: "石墨", hint: "深灰底色 · 柔和夜读" },
]

export function isUiTestSkin(value: unknown): value is UiTestSkin {
  return value === "light" || value === "dark"
}

/** 旧配置和备份使用独立的皮肤编号。 */
export function normalizeUiTestSkin(value: unknown): UiTestSkin | undefined {
  if (isUiTestSkin(value)) return value
  if (value === "jing" || value === "zhi") return "light"
  if (value === "xing") return "dark"
}

export function readUiTestSkin(): UiTestSkin {
  if (typeof localStorage === "undefined") return "light"
  const value = localStorage.getItem(UI_TEST_SKIN_KEY)
  return normalizeUiTestSkin(value) ?? "light"
}

export function writeUiTestSkin(skin: UiTestSkin): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(UI_TEST_SKIN_KEY, skin)
}

/** 目录开关搬到左上角后的一次性引导气泡：点过「知道了」就永久关闭。 */
export const UI_TEST_DIRECTORY_HINT_KEY = `${UI_TEST_STORAGE_PREFIX}directory-hint-v1`

export function readUiTestDirectoryHintDismissed(): boolean {
  if (typeof localStorage === "undefined") return false
  return localStorage.getItem(UI_TEST_DIRECTORY_HINT_KEY) === "1"
}

export function writeUiTestDirectoryHintDismissed(): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(UI_TEST_DIRECTORY_HINT_KEY, "1")
}

/** 顶栏「AI 对话」改为纯图标后的一次性引导气泡：点过「知道了」就永久关闭。 */
export const UI_TEST_AI_HINT_KEY = `${UI_TEST_STORAGE_PREFIX}ai-chat-hint-v1`

export function readUiTestAiHintDismissed(): boolean {
  if (typeof localStorage === "undefined") return false
  return localStorage.getItem(UI_TEST_AI_HINT_KEY) === "1"
}

export function writeUiTestAiHintDismissed(): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(UI_TEST_AI_HINT_KEY, "1")
}