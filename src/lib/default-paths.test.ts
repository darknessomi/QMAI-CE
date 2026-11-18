import { beforeEach, describe, expect, it, vi } from "vitest"
import { homeDir } from "@tauri-apps/api/path"
import { getExecutableDir } from "@/commands/fs"
import { isMacOS } from "./platform"
import { getDefaultNovelDir } from "./default-paths"

vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn() }))
vi.mock("@/commands/fs", () => ({ getExecutableDir: vi.fn() }))
vi.mock("./platform", () => ({ isMacOS: vi.fn() }))

describe("default paths", () => {
  beforeEach(() => { vi.resetAllMocks() })

  it("Windows 使用安装盘，无法识别时回退到 D 盘", async () => {
    vi.mocked(getExecutableDir).mockResolvedValueOnce("e:\\QMaiWrite\\resources")
      .mockResolvedValueOnce("QMaiWrite").mockRejectedValueOnce(new Error())
    await expect(getDefaultNovelDir()).resolves.toBe("E:\\QM-BOOK")
    await expect(getDefaultNovelDir()).resolves.toBe("D:\\QM-BOOK")
    await expect(getDefaultNovelDir()).resolves.toBe("D:\\QM-BOOK")
    expect(homeDir).not.toHaveBeenCalled()
  })

  it("macOS 使用系统返回的主目录，支持非标准位置和末尾斜杠", async () => {
    vi.mocked(isMacOS).mockReturnValue(true)
    vi.mocked(homeDir).mockResolvedValue("/Volumes/资料盘/小说作者/")
    await expect(getDefaultNovelDir()).resolves.toBe("/Volumes/资料盘/小说作者/QM-BOOK")
    expect(getExecutableDir).not.toHaveBeenCalled()
  })

  it("macOS 的主目录必须是绝对路径", async () => {
    vi.mocked(isMacOS).mockReturnValue(true)
    vi.mocked(homeDir).mockResolvedValue("")
    await expect(getDefaultNovelDir()).rejects.toThrow("无法读取当前用户的主目录")
  })
})
