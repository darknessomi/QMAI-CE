// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { GUIDE_STORAGE_KEY } from "@/lib/guide/guide-store"
import { UI_TEST_SKIN_KEY, UI_TEST_AI_HINT_KEY, UI_TEST_DIRECTORY_HINT_KEY } from "@/lib/ui-test"
import { loadTheme } from "@/lib/project-store"
import { restoreImportedUiPreferences } from "./imported-ui-preferences"

const { values, read } = vi.hoisted(() => ({ values: new Map<string, unknown>(), read: vi.fn() }))
vi.mock("@/lib/platform", () => ({ isTauri: () => true }))
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: async () => "/ce", join: async (...s: string[]) => s.join("/") }))
vi.mock("@/commands/fs", () => ({ readFile: read }))
vi.mock("@/lib/web-store", () => ({ getStore: async () => ({
  get: async (k: string) => values.get(k),
  set: async (k: string, v: unknown) => values.set(k, v),
  save: async () => {},
}) }))

describe("导入后的界面偏好", () => {
  beforeEach(() => {
    localStorage.clear()
    values.clear()
    read.mockReset().mockResolvedValue(JSON.stringify({ imported: true, skin: "xing", guide: { status: "done" } }))
  })

  it("修复旧 CE 自动写入的青瓷和首步引导，重启保留用户的新选择", async () => {
    localStorage.setItem(UI_TEST_SKIN_KEY, "jing")
    localStorage.setItem(GUIDE_STORAGE_KEY, JSON.stringify({ status: "running", stepIndex: 0 }))
    await restoreImportedUiPreferences()
    expect(localStorage.getItem(UI_TEST_SKIN_KEY)).toBe("dark")
    expect(values.get("theme__uiTest")).toBe("dark")
    expect(JSON.parse(localStorage.getItem(GUIDE_STORAGE_KEY)!).status).toBe("done")
    expect(localStorage.getItem(UI_TEST_AI_HINT_KEY)).toBe("1")
    expect(localStorage.getItem(UI_TEST_DIRECTORY_HINT_KEY)).toBe("1")
    localStorage.setItem(UI_TEST_SKIN_KEY, "light")
    await restoreImportedUiPreferences()
    expect(read).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(UI_TEST_SKIN_KEY)).toBe("light")
  })

  it("保留已选择的 CE 配色和已推进的引导", async () => {
    values.set("uiTestSkin", "jing")
    const running = JSON.stringify({ status: "running", stepIndex: 5 })
    localStorage.setItem(GUIDE_STORAGE_KEY, running)
    await restoreImportedUiPreferences()
    expect(localStorage.getItem(UI_TEST_SKIN_KEY)).toBe("light")
    expect(values.get("theme__uiTest")).toBe("light")
    expect(localStorage.getItem(GUIDE_STORAGE_KEY)).toBe(running)
  })

  it("导入数据没有配色记录时，启动不把默认浅色写回", async () => {
    read.mockResolvedValue('{"imported":true}')
    await restoreImportedUiPreferences()
    expect(localStorage.getItem(UI_TEST_SKIN_KEY)).toBeNull()
    expect(values.has("theme__uiTest")).toBe(false)
    expect(JSON.parse(localStorage.getItem(GUIDE_STORAGE_KEY)!).status).toBe("off")
  })

  it("旧宣纸配置迁移为青瓷，清除 WebView 缓存后保留后来选择的石墨", async () => {
    read.mockResolvedValue('{"imported":true,"skin":"zhi"}')
    await restoreImportedUiPreferences()
    expect(values.get("theme__uiTest")).toBe("light")
    values.set("theme__uiTest", "dark")
    localStorage.clear()
    await restoreImportedUiPreferences()
    expect(await loadTheme()).toBe("dark")
    expect(localStorage.getItem(UI_TEST_SKIN_KEY)).toBe("dark")
  })

  it("重启以全局主题修正过期的 WebView 缓存", async () => {
    localStorage.setItem(UI_TEST_SKIN_KEY, "jing")
    values.set("theme__uiTest", "dark")
    expect(await loadTheme()).toBe("dark")
    expect(localStorage.getItem(UI_TEST_SKIN_KEY)).toBe("dark")
  })

  it("全新安装仍可自动播放引导", async () => {
    read.mockResolvedValue('{"imported":false}')
    await restoreImportedUiPreferences()
    expect(localStorage.getItem(GUIDE_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(UI_TEST_AI_HINT_KEY)).toBeNull()
    expect(values.has("theme__uiTest")).toBe(false)
  })
})
