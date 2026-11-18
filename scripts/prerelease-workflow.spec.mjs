import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(__dirname, "..")

const workflow = readFileSync(".github/workflows/prerelease.yml", "utf8")
const official = readFileSync(".github/workflows/build.yml", "utf8")

describe("Windows prerelease workflow", () => {
  it("only runs on the prerelease branch or manual dispatch", () => {
    expect(workflow).toMatch(/branches:\s*\n\s+- prerelease/)
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).not.toMatch(/tags:\s*\n\s+- ["']v\*/)
  })

  it("builds Windows only", () => {
    expect(workflow).toContain("runs-on: windows-latest")
    expect(workflow).toContain("--bundles nsis")
    expect(workflow).not.toMatch(/macos-latest|macos-15-intel|ubuntu-22\.04/)
    expect(workflow).not.toMatch(/--bundles dmg|--bundles deb/)
  })

  it("publishes a GitHub prerelease without touching the stable updater channel", () => {
    expect(workflow).toContain("--prerelease")
    expect(workflow).toContain("--latest=false")
    expect(workflow).toContain('tag="prerelease"')
    expect(workflow).toContain("QMaiWrite_*_windows_X64_prerelease.exe")
    expect(workflow).not.toMatch(/gh release (create|upload)[\s\S]*latest\.json/)
    expect(official).toMatch(/gh release upload[\s\S]*latestPath/)
  })
})

describe("Windows 更新清单使用 GitHub Releases 直链", () => {
  it("本地发布指向社区版仓库的安装包", () => {
    const text = readFileSync(resolve(root, "scripts/prepare-github-release.mjs"), "utf8")
    expect(text).toContain('url: `https://github.com/darknessomi/QMAI-CE/releases/latest/download/${releaseAssetName}`')
  })

  it("CI 发布指向当前仓库的安装包", () => {
    expect(official).toContain('url = "https://github.com/$env:GITHUB_REPOSITORY/releases/latest/download/$assetName"')
  })
})
