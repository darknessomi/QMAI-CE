import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const tauriDir = new URL("../../src-tauri/", import.meta.url)
const readTauriFile = (path: string) => readFileSync(new URL(path, tauriDir), "utf8")
const template = readTauriFile("windows/_tauri-installer-template.nsi")

describe("Windows NSIS updater template", () => {
  it("waits for the current app executable to be released before copying the update", () => {
    const appRunningCheck = '!insertmacro CheckIfAppIsRunning "$INSTDIR\\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"'
    const waitForRelease = "Call WaitForMainBinaryRelease"
    const copyExecutable = 'File "${MAINBINARYSRCPATH}"'

    expect(template).toContain('!include "Win\\RestartManager.nsh"')
    expect(template.split(appRunningCheck)).toHaveLength(3)
    expect(template).toContain("Function WaitForMainBinaryRelease")
    expect(template).toContain(waitForRelease)
    expect(template).toContain('Delete "$INSTDIR\\${MAINBINARYNAME}.exe"')

    const appRunningCheckIndex = template.indexOf(appRunningCheck)
    const waitForReleaseIndex = template.indexOf(waitForRelease)
    const copyExecutableIndex = template.indexOf(copyExecutable)

    expect(waitForReleaseIndex).toBeGreaterThan(appRunningCheckIndex)
    expect(waitForReleaseIndex).toBeLessThan(copyExecutableIndex)
  })
})

describe("CE 并排安装", () => {
  const config = JSON.parse(readTauriFile("tauri.conf.json"))

  it("两版共用单实例标识，CE 全局配置与模型凭据各用独立目录", () => {
    expect(config.identifier).toBe("com.qingmuai.writer")
    expect(config.app.appDirectoriesOverride.data).toBe("$DATA/com.qingmuai.writer.ce")
    expect(config.app.appDirectoriesOverride.localData).toBe("$LOCALDATA/com.qingmuai.writer.ce")
    expect(config.productName).toBe("青幕AI写作 CE")
    expect(config.mainBinaryName).toBe("qmai-ce")
    expect(config.app.windows[0].title).toBe(config.productName)
  })

  it("Windows 的快捷方式和卸载项使用 CE 名称，卸载不删除应用数据", () => {
    expect(template).toContain('!define INSTALLDIRNAME "QMaiWrite CE"')
    expect(template).toContain('Uninstall\\${PRODUCTNAME}"')
    expect(template).toContain('$DESKTOP\\${PRODUCTNAME}.lnk')
    expect(template).not.toMatch(/deleteAppData|RmDir[^\n]*(?:LOCALAPPDATA|APPDATA)/i)
  })

  it("Linux 软件包与桌面入口指向 CE 可执行文件", () => {
    const linux = JSON.parse(readTauriFile("tauri.linux.conf.json"))
    const desktop = readTauriFile(linux.bundle.linux.deb.desktopTemplate)
    expect(linux.productName).toBe("qmai-ce")
    expect(desktop).toContain(`Name=${config.productName}\n`)
    expect(desktop).toContain("Exec={{exec}}")
  })
})

describe("平台打包目标", () => {
  it.each([
    { platform: "macos", targets: ["app"] },
    { platform: "windows", targets: ["nsis"] },
    { platform: "linux", targets: ["deb", "appimage"] },
  ])("$platform 使用自己的默认打包目标", ({ platform, targets }) => {
    const config = JSON.parse(readTauriFile(`tauri.${platform}.conf.json`))
    expect(config.bundle.targets).toEqual(targets)
  })
})
