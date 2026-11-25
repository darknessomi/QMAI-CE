/**
 * Unit tests for cascadeDeleteWikiPage — the one helper that every
 * wiki-page delete flow goes through. By centralizing the cascade
 * here we get test coverage for slug derivation + ordering once,
 * instead of having to test it at every React-component call site.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockDeleteFile = vi.fn<(path: string) => Promise<void>>()
const mockReadFile = vi.fn<(path: string) => Promise<string>>()
const mockWriteFile = vi.fn<(path: string, content: string) => Promise<void>>()
const mockListDirectory = vi.fn<(path: string) => Promise<unknown>>()

vi.mock("@/commands/fs", () => ({
  deleteFile: (path: string) => mockDeleteFile(path),
  readFile: (path: string) => mockReadFile(path),
  writeFile: (path: string, content: string) => mockWriteFile(path, content),
  listDirectory: (path: string) => mockListDirectory(path),
}))


import { cascadeDeleteWikiPage, cascadeDeleteWikiPagesWithRefs } from "./wiki-page-delete"
import type { FileNode } from "@/types/wiki"

beforeEach(() => {
  mockDeleteFile.mockReset()
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  mockListDirectory.mockReset()
  mockDeleteFile.mockResolvedValue(undefined)
  mockWriteFile.mockResolvedValue(undefined)
})

describe("cascadeDeleteWikiPage", () => {
  it("deletes the requested page", async () => {
    await cascadeDeleteWikiPage("/proj", "/proj/wiki/concepts/rope.md")
    expect(mockDeleteFile).toHaveBeenCalledExactlyOnceWith("/proj/wiki/concepts/rope.md")
  })

  it("preserves associated media if removing the source page fails", async () => {
    mockDeleteFile.mockRejectedValueOnce(new Error("EACCES"))
    await expect(cascadeDeleteWikiPage("/proj", "/proj/wiki/sources/rope.md")).rejects.toThrow("EACCES")
    expect(mockDeleteFile).toHaveBeenCalledTimes(1)
  })

  // ── Media cascade: source-summary deletion drops images too ──────
  //
  // The image-extraction step writes to wiki/media/<slug>/ keyed by
  // the SOURCE document's slug. The source-summary page at
  // wiki/sources/<slug>.md is the canonical home for those images
  // (we append a markdown section to it post-write). When the
  // source page is deleted (either via source-delete cascade in
  // sources-view, or a manual delete), the matching media directory
  // becomes orphaned — these tests pin that we drop it too.

  it("deleting wiki/sources/<slug>.md also deletes wiki/media/<slug>/", async () => {
    await cascadeDeleteWikiPage("/proj", "/proj/wiki/sources/rope-paper.md")

    expect(mockDeleteFile).toHaveBeenCalledTimes(2)
    expect(mockDeleteFile).toHaveBeenNthCalledWith(1, "/proj/wiki/sources/rope-paper.md")
    expect(mockDeleteFile).toHaveBeenNthCalledWith(2, "/proj/wiki/media/rope-paper")
  })

  it("does NOT cascade media when deleting a non-source page (concept / entity / queries)", async () => {
    // Concept / entity pages don't own a media directory of their own.
    // Multiple pages can reference images from any source's media/.
    // Deleting one concept page must not destroy the source's images.
    await cascadeDeleteWikiPage("/proj", "/proj/wiki/concepts/rope.md")

    expect(mockDeleteFile).toHaveBeenCalledTimes(1)
    expect(mockDeleteFile).toHaveBeenCalledWith("/proj/wiki/concepts/rope.md")

    await cascadeDeleteWikiPage("/proj", "/proj/wiki/entities/transformer.md")
    expect(mockDeleteFile).toHaveBeenCalledTimes(2)
    expect(mockDeleteFile).toHaveBeenLastCalledWith("/proj/wiki/entities/transformer.md")

    await cascadeDeleteWikiPage("/proj", "/proj/wiki/queries/some-query-2026-04-27-150000.md")
    expect(mockDeleteFile).toHaveBeenCalledTimes(3)
  })

  it("media-cascade tolerates a missing media directory (no images were extracted)", async () => {
    // Most wiki/sources/ pages won't have an associated media/<slug>/
    // — only PDF/PPTX/DOCX sources with embedded images do. The
    // delete attempt fails with ENOENT and we swallow it silently.
    mockDeleteFile
      .mockResolvedValueOnce(undefined) // source page delete: OK
      .mockRejectedValueOnce(new Error("ENOENT: no such directory")) // media: doesn't exist

    // Should NOT throw — media absence is normal.
    await expect(
      cascadeDeleteWikiPage("/proj", "/proj/wiki/sources/text-only-source.md"),
    ).resolves.toBeUndefined()
    // Both attempts happened.
    expect(mockDeleteFile).toHaveBeenCalledTimes(2)
  })

  it("handles Windows backslash paths in the source-page detection", async () => {
    // sources-view in some flows may pass paths that haven't been
    // normalized yet. The detector flips backslashes via
    // normalizePath before matching `/wiki/sources/`.
    await cascadeDeleteWikiPage(
      "C:/proj",
      "C:\\proj\\wiki\\sources\\winsrc.md",
    )

    expect(mockDeleteFile).toHaveBeenCalledTimes(2)
    // Second call is the media dir, normalized to forward slashes
    // because we built it from project path + literal path.
    expect(mockDeleteFile).toHaveBeenNthCalledWith(2, "C:/proj/wiki/media/winsrc")
  })

  it("does not attempt media deletion when slug is empty or hidden (defensive)", async () => {
    // wiki/sources/.md → getFileStem returns ".md" (since lastIndexOf
    // is at position 0, the function falls back to the full name).
    // Without the dot-prefix guard we'd build a media path of
    // `wiki/media/.md`, which is at best a leak and at worst risks
    // touching dotfiles. Both `.md` (slug-from-pure-ext) and `.foo`
    // (hidden-name) must be rejected by the media cascade even though
    // the file delete still happens.
    await cascadeDeleteWikiPage("/proj", "/proj/wiki/sources/.md")
    expect(mockDeleteFile).toHaveBeenCalledTimes(1)
    expect(mockDeleteFile).toHaveBeenCalledWith("/proj/wiki/sources/.md")

    mockDeleteFile.mockClear()
    await cascadeDeleteWikiPage("/proj", "/proj/wiki/sources/.hidden.md")
    expect(mockDeleteFile).toHaveBeenCalledTimes(1)
    expect(mockDeleteFile).toHaveBeenCalledWith("/proj/wiki/sources/.hidden.md")
  })
})

// ── cascadeDeleteWikiPagesWithRefs (new) ─────────────────────────────────
//
// User-driven "delete this entity" wants more than the file-level
// helper above: it must also strip every reference to the deleted
// page so we don't leave dangling links / phantom related entries
// across the wiki. Pin every cleanup pathway here.

const PROJECT = "/test/project"

function fileNode(rel: string): FileNode {
  const segs = rel.split("/")
  return {
    name: segs[segs.length - 1] ?? "",
    path: `${PROJECT}/${rel}`,
    is_dir: false,
  }
}

function dirNode(rel: string, children: FileNode[]): FileNode {
  const segs = rel.split("/")
  return {
    name: segs[segs.length - 1] ?? "",
    path: `${PROJECT}/${rel}`,
    is_dir: true,
    children,
  }
}

describe("cascadeDeleteWikiPagesWithRefs", () => {
  it("deletes the file, and reports the path", async () => {
    const target = `${PROJECT}/wiki/entities/alice-chen.md`
    mockReadFile.mockImplementationOnce(async () =>
      `---\ntype: entity\ntitle: "Alice Chen"\n---\n\n# Alice`,
    )
    mockListDirectory.mockResolvedValueOnce([
      dirNode("wiki", [
        dirNode("wiki/entities", [fileNode("wiki/entities/alice-chen.md")]),
      ]),
    ])

    const result = await cascadeDeleteWikiPagesWithRefs(PROJECT, [target])
    expect(result.deletedPaths).toEqual([target])
    expect(mockDeleteFile).toHaveBeenCalledWith(target)
  })

  it("strips [[deleted]] body wikilinks from sibling pages", async () => {
    const target = `${PROJECT}/wiki/entities/alice-chen.md`
    mockReadFile.mockImplementation(async (p: string) => {
      if (p === target) return `---\ntitle: "Alice Chen"\n---\n\n# Alice`
      if (p === `${PROJECT}/wiki/entities/bob.md`) {
        return `---\ntitle: Bob\n---\n\nBob worked with [[alice-chen]] on the migration.`
      }
      throw new Error(`unexpected read ${p}`)
    })
    mockListDirectory.mockResolvedValueOnce([
      dirNode("wiki", [
        dirNode("wiki/entities", [
          fileNode("wiki/entities/alice-chen.md"),
          fileNode("wiki/entities/bob.md"),
        ]),
      ]),
    ])

    await cascadeDeleteWikiPagesWithRefs(PROJECT, [target])

    const writeCall = mockWriteFile.mock.calls.find(
      (c) => c[0] === `${PROJECT}/wiki/entities/bob.md`,
    )
    expect(writeCall).toBeTruthy()
    const written = writeCall![1]
    expect(written).not.toContain("[[alice-chen]]")
    expect(written).toContain("Bob worked with alice-chen on the migration.")
  })

  it("strips title-form [[Alice Chen]] wikilinks too", async () => {
    const target = `${PROJECT}/wiki/entities/alice-chen.md`
    mockReadFile.mockImplementation(async (p: string) => {
      if (p === target) return `---\ntitle: "Alice Chen"\n---\nbody`
      if (p === `${PROJECT}/wiki/entities/bob.md`) {
        return `---\ntitle: Bob\n---\n\nBob and [[Alice Chen]] led the project.`
      }
      throw new Error(`unexpected read ${p}`)
    })
    mockListDirectory.mockResolvedValueOnce([
      dirNode("wiki", [
        dirNode("wiki/entities", [
          fileNode("wiki/entities/alice-chen.md"),
          fileNode("wiki/entities/bob.md"),
        ]),
      ]),
    ])

    await cascadeDeleteWikiPagesWithRefs(PROJECT, [target])
    const written = mockWriteFile.mock.calls.find(
      (c) => c[0] === `${PROJECT}/wiki/entities/bob.md`,
    )![1]
    expect(written).not.toContain("[[Alice Chen]]")
  })

  it("removes the deleted page's listing line from index.md", async () => {
    const target = `${PROJECT}/wiki/entities/alice-chen.md`
    mockReadFile.mockImplementation(async (p: string) => {
      if (p === target) return `---\ntitle: "Alice Chen"\n---\nbody`
      if (p === `${PROJECT}/wiki/index.md`) {
        return [
          "# Wiki Index",
          "",
          "## Entities",
          "- [[alice-chen]] — engineering lead",
          "- [[bob]] — designer",
        ].join("\n")
      }
      throw new Error(`unexpected read ${p}`)
    })
    mockListDirectory.mockResolvedValueOnce([
      dirNode("wiki", [
        fileNode("wiki/index.md"),
        dirNode("wiki/entities", [fileNode("wiki/entities/alice-chen.md")]),
      ]),
    ])

    await cascadeDeleteWikiPagesWithRefs(PROJECT, [target])

    const indexWrite = mockWriteFile.mock.calls.find(
      (c) => c[0] === `${PROJECT}/wiki/index.md`,
    )!
    const written = indexWrite[1]
    expect(written).not.toContain("[[alice-chen]]")
    expect(written).toContain("[[bob]]")
  })

  it("drops the deleted slug from `related:` frontmatter arrays", async () => {
    const target = `${PROJECT}/wiki/entities/alice-chen.md`
    mockReadFile.mockImplementation(async (p: string) => {
      if (p === target) return `---\ntitle: "Alice Chen"\n---\nbody`
      if (p === `${PROJECT}/wiki/projects/migration.md`) {
        return [
          "---",
          "type: project",
          "title: Migration",
          "related: [alice-chen.md, wiki/entities/bob.md, carol]",
          "---",
          "",
          "Project body.",
        ].join("\n")
      }
      throw new Error(`unexpected read ${p}`)
    })
    mockListDirectory.mockResolvedValueOnce([
      dirNode("wiki", [
        dirNode("wiki/entities", [fileNode("wiki/entities/alice-chen.md")]),
        dirNode("wiki/projects", [fileNode("wiki/projects/migration.md")]),
      ]),
    ])

    await cascadeDeleteWikiPagesWithRefs(PROJECT, [target])

    const projWrite = mockWriteFile.mock.calls.find(
      (c) => c[0] === `${PROJECT}/wiki/projects/migration.md`,
    )!
    const written = projWrite[1]
    // alice-chen filtered out even when stored with a .md suffix; bob & carol kept.
    expect(written).not.toMatch(/\balice-chen\b/)
    expect(written).toContain("wiki/entities/bob.md")
    expect(written).toContain("carol")
  })

  it("drops path-style `related:` entries that point at deleted pages", async () => {
    const target = `${PROJECT}/wiki/entities/bob.md`
    mockReadFile.mockImplementation(async (p: string) => {
      if (p === target) return `---\ntitle: "Bob"\n---\nbody`
      if (p === `${PROJECT}/wiki/projects/migration.md`) {
        return [
          "---",
          "type: project",
          "title: Migration",
          "related: [alice-chen, wiki/entities/bob.md, carol]",
          "---",
          "",
          "Project body.",
        ].join("\n")
      }
      throw new Error(`unexpected read ${p}`)
    })
    mockListDirectory.mockResolvedValueOnce([
      dirNode("wiki", [
        dirNode("wiki/entities", [fileNode("wiki/entities/bob.md")]),
        dirNode("wiki/projects", [fileNode("wiki/projects/migration.md")]),
      ]),
    ])

    await cascadeDeleteWikiPagesWithRefs(PROJECT, [target])

    const projWrite = mockWriteFile.mock.calls.find(
      (c) => c[0] === `${PROJECT}/wiki/projects/migration.md`,
    )!
    const written = projWrite[1]
    expect(written).toContain("alice-chen")
    expect(written).not.toContain("wiki/entities/bob.md")
    expect(written).toContain("carol")
  })

  it("does NOT touch a sibling whose slug merely contains the deleted slug as a substring", async () => {
    // Deleting "ai" must not corrupt [[OpenAI]] / [[AI Safety]] —
    // the bug class wiki-cleanup was originally written to prevent.
    const target = `${PROJECT}/wiki/concepts/ai.md`
    mockReadFile.mockImplementation(async (p: string) => {
      if (p === target) return `---\ntitle: AI\n---\nbody`
      if (p === `${PROJECT}/wiki/entities/openai.md`) {
        return `---\ntitle: "OpenAI"\n---\n\nFounded as [[ai]] safety lab. Now also see [[OpenAI]] product line.`
      }
      throw new Error(`unexpected read ${p}`)
    })
    mockListDirectory.mockResolvedValueOnce([
      dirNode("wiki", [
        dirNode("wiki/concepts", [fileNode("wiki/concepts/ai.md")]),
        dirNode("wiki/entities", [fileNode("wiki/entities/openai.md")]),
      ]),
    ])

    await cascadeDeleteWikiPagesWithRefs(PROJECT, [target])
    const written = mockWriteFile.mock.calls.find(
      (c) => c[0] === `${PROJECT}/wiki/entities/openai.md`,
    )?.[1]
    if (written) {
      expect(written).toContain("[[OpenAI]]")
      expect(written).not.toContain("[[ai]]")
    }
  })

  it("handles batch deletes (multiple targets) with one cleanup sweep", async () => {
    const t1 = `${PROJECT}/wiki/entities/alice-chen.md`
    const t2 = `${PROJECT}/wiki/entities/alice-chen-1.md`
    mockReadFile.mockImplementation(async (p: string) => {
      if (p === t1) return `---\ntitle: "Alice Chen"\n---\nbody`
      if (p === t2) return `---\ntitle: "Alice Chen"\n---\nbody`
      if (p === `${PROJECT}/wiki/entities/bob.md`) {
        return `---\ntitle: Bob\n---\n\nWorked with [[alice-chen]] and [[alice-chen-1]] both.`
      }
      throw new Error(`unexpected read ${p}`)
    })
    mockListDirectory.mockResolvedValueOnce([
      dirNode("wiki", [
        dirNode("wiki/entities", [
          fileNode("wiki/entities/alice-chen.md"),
          fileNode("wiki/entities/alice-chen-1.md"),
          fileNode("wiki/entities/bob.md"),
        ]),
      ]),
    ])

    const result = await cascadeDeleteWikiPagesWithRefs(PROJECT, [t1, t2])
    expect(result.deletedPaths).toEqual([t1, t2])
    expect(mockDeleteFile).toHaveBeenCalledWith(t1)
    expect(mockDeleteFile).toHaveBeenCalledWith(t2)
    const bobWrite = mockWriteFile.mock.calls.find(
      (c) => c[0] === `${PROJECT}/wiki/entities/bob.md`,
    )!
    expect(bobWrite[1]).not.toContain("[[alice-chen]]")
    expect(bobWrite[1]).not.toContain("[[alice-chen-1]]")
  })
})
