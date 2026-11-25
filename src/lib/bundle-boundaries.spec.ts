import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(/\r\n/g, "\n")

describe("frontend bundle boundaries", () => {
  it("uses focused vendor chunks instead of one forced book-analysis chunk", () => {
    const viteConfig = read("../../vite.config.ts")

    expect(viteConfig).toContain('return "yaml-vendor"')
    expect(viteConfig).not.toContain('return "book-analysis-vendor"')
  })

  it("keeps retired graph and text-analysis vendors out of the bundle", () => {
    const viteConfig = read("../../vite.config.ts")
    const { dependencies } = JSON.parse(read("../../package.json"))
    for (const name of ["graphology", "graphology-communities-louvain", "pinyin-pro", "opencc-js"]) {
      expect(dependencies).not.toHaveProperty(name)
      expect(viteConfig).not.toContain(name)
    }
    expect(viteConfig).not.toContain('return "sigma-vendor"')
    expect(viteConfig).not.toContain('return "cytoscape-vendor"')
  })

  it("loads optional search and skill views on demand", () => {
    const contentArea = read("../components/layout/content-area.tsx")
    const sidebarPanel = read("../components/layout/sidebar-panel.tsx")

    expect(contentArea).not.toContain('import { SearchView } from')
    expect(contentArea).not.toContain('import { UnifiedSkillLibraryView } from')
    expect(contentArea).toContain('await import("@/components/search/search-view")')
    expect(contentArea).toContain('await import("@/components/skill-library/unified-skill-library-view")')
    expect(sidebarPanel).not.toContain('import { SoulSidebarPanel } from')
    expect(sidebarPanel).not.toContain('import { BookAnalysisSidebarPanel } from')
    expect(sidebarPanel).not.toContain('import { UnifiedSkillLibrarySidebarPanel } from')
    expect(sidebarPanel).not.toContain('import { SoulSidebarPanel } from')
    expect(sidebarPanel).not.toContain('await import("./soul-sidebar-panel")')
    expect(sidebarPanel).not.toContain('await import("./book-analysis-sidebar-panel")')
  })

  it("keeps the lazy-loading fallback user-facing text in Chinese", () => {
    const contentArea = read("../components/layout/content-area.tsx")

    expect(contentArea).toContain("加载中...")
    expect(contentArea).not.toContain("Loading...")
  })
})
