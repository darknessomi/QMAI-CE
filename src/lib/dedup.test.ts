import { parseFrontmatter } from "./frontmatter"
import { describe, it, expect, vi } from "vitest"
import {
  extractEntitySummary,
  detectDuplicateGroups,
  mergeDuplicateGroup,
  rewriteIndexMd,
  type DuplicateGroup,
  type EntitySummary,
} from "./dedup"
import { parseFrontmatterArray } from "./sources-merge"

const PAGE = (fm: string, body: string) => `---\n${fm}\n---\n\n${body}`

const FIXED_TODAY = () => "2026-04-30"

/** Minimal EntitySummary for one slug. */
const mkSummary = (slug: string, title = slug, type = "entity"): EntitySummary => ({
  slug,
  path: `wiki/entities/${slug}.md`,
  type,
  title,
  tags: [],
})

// ──────────────────────────────────────────────────────────────────
// Stage 1: extractEntitySummary
// ──────────────────────────────────────────────────────────────────

describe("extractEntitySummary", () => {
  it("returns null for content with no frontmatter", () => {
    expect(extractEntitySummary("wiki/entities/foo.md", "# Just body")).toBeNull()
  })

  it("derives slug from filename", () => {
    const s = extractEntitySummary(
      "wiki/entities/accumulibacter.md",
      PAGE("type: entity\ntitle: Accumulibacter", "body"),
    )
    expect(s?.slug).toBe("accumulibacter")
  })

  it("uses frontmatter description when present", () => {
    const s = extractEntitySummary(
      "wiki/entities/foo.md",
      PAGE(
        'type: entity\ntitle: Foo\ndescription: "A short summary."\ntags: [a, b]',
        "Body text",
      ),
    )
    expect(s?.description).toBe("A short summary.")
    expect(s?.tags).toEqual(["a", "b"])
  })

  it("falls back to first non-heading body paragraph for description", () => {
    const s = extractEntitySummary(
      "wiki/entities/foo.md",
      PAGE("type: entity\ntitle: Foo", "# Foo\n\nFirst real paragraph here."),
    )
    expect(s?.description).toBe("First real paragraph here.")
  })

  it("truncates long descriptions to ~200 chars", () => {
    const long = "x".repeat(400)
    const s = extractEntitySummary(
      "wiki/entities/foo.md",
      PAGE(`type: entity\ntitle: Foo\ndescription: "${long}"`, "body"),
    )
    expect(s?.description?.length).toBeLessThanOrEqual(200)
    expect(s?.description?.endsWith("…")).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────
// Stage 2: parseDetectorResponse (private since 01aab5f — driven via
// detectDuplicateGroups, which passes the raw response straight to it)
// ──────────────────────────────────────────────────────────────────

/**
 * Run a raw LLM response through the public detector. Every slug the
 * response may mention is declared as a valid summary so that slug
 * validation can never mask what the parser itself does.
 */
async function parseVia(raw: string, slugs: string[]): Promise<DuplicateGroup[]> {
  const llm = vi.fn().mockResolvedValue(raw)
  return detectDuplicateGroups(slugs.map((s) => mkSummary(s)), llm)
}

describe("parseDetectorResponse", () => {
  it("parses a clean JSON response", async () => {
    const raw = JSON.stringify({
      groups: [
        { slugs: ["a", "b"], reason: "same thing", confidence: "high" },
      ],
    })
    expect(await parseVia(raw, ["a", "b"])).toEqual([
      { slugs: ["a", "b"], reason: "same thing", confidence: "high" },
    ])
  })

  it("strips ```json code fences if the LLM wrapped its output", async () => {
    const raw = '```json\n{"groups": [{"slugs": ["a","b"], "reason": "x", "confidence": "high"}]}\n```'
    const out = await parseVia(raw, ["a", "b"])
    expect(out).toHaveLength(1)
    expect(out[0].slugs).toEqual(["a", "b"])
  })

  it("strips conversational preamble before the JSON", async () => {
    const raw =
      'Sure, here are the duplicates I found:\n\n{"groups": [{"slugs": ["foo","bar"], "reason": "synonyms", "confidence": "medium"}]}\n\nLet me know if you need anything else.'
    const out = await parseVia(raw, ["foo", "bar"])
    expect(out[0].slugs).toEqual(["foo", "bar"])
    expect(out[0].confidence).toBe("medium")
  })

  it("rejects groups with fewer than 2 slugs", async () => {
    const raw = '{"groups": [{"slugs": ["only-one"], "reason": "x", "confidence": "high"}]}'
    // "only-one" is a declared summary, so this group is rejected purely
    // because it carries a single slug.
    expect(await parseVia(raw, ["only-one", "unrelated"])).toEqual([])
  })

  it("defaults invalid confidence values to 'low'", async () => {
    const raw = '{"groups": [{"slugs": ["a","b"], "reason": "", "confidence": "extremely-high"}]}'
    expect((await parseVia(raw, ["a", "b"]))[0].confidence).toBe("low")
  })

  it("reports an incomplete scan for malformed JSON", async () => {
    await expect(parseVia("not json at all", ["a", "b"])).rejects.toThrow("本次扫描未完成")
    await expect(parseVia('{"groups": [unclosed', ["a", "b"])).rejects.toThrow("本次扫描未完成")
    await expect(parseVia("", ["a", "b"])).rejects.toThrow("本次扫描未完成")
  })

  it("reports an incomplete scan when the JSON object has no groups field", async () => {
    await expect(parseVia('{"other_field": []}', ["a", "b"])).rejects.toThrow("本次扫描未完成")
  })

  it("survives quoted braces inside reason strings", async () => {
    const raw =
      '{"groups": [{"slugs": ["a","b"], "reason": "Same thing { really }", "confidence": "high"}]}'
    const out = await parseVia(raw, ["a", "b"])
    expect(out[0].reason).toBe("Same thing { really }")
  })
})

// ──────────────────────────────────────────────────────────────────
// Stage 2: detectDuplicateGroups (full pipeline w/ mock LLM)
// ──────────────────────────────────────────────────────────────────

describe("detectDuplicateGroups", () => {
  const summary = (slug: string, title: string, type = "entity"): EntitySummary => ({
    slug,
    path: `wiki/entities/${slug}.md`,
    type,
    title,
    tags: [],
  })

  it("returns [] when fewer than 2 summaries are passed", async () => {
    const llm = vi.fn()
    expect(await detectDuplicateGroups([summary("foo", "Foo")], llm)).toEqual([])
    expect(llm).not.toHaveBeenCalled()
  })

  it("filters out groups whose slugs aren't in the input list", async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({
        groups: [
          { slugs: ["real-a", "real-b"], reason: "x", confidence: "high" },
          { slugs: ["fake", "real-a"], reason: "x", confidence: "high" },
        ],
      }),
    )
    const result = await detectDuplicateGroups(
      [summary("real-a", "A"), summary("real-b", "B")],
      llm,
    )
    expect(result).toHaveLength(1)
    expect(result[0].slugs).toEqual(["real-a", "real-b"])
  })

  it("filters out groups already on the user's not-duplicates whitelist", async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({
        groups: [
          { slugs: ["foo", "bar"], reason: "x", confidence: "high" },
          { slugs: ["x", "y"], reason: "x", confidence: "high" },
        ],
      }),
    )
    const result = await detectDuplicateGroups(
      [
        summary("foo", "Foo"),
        summary("bar", "Bar"),
        summary("x", "X"),
        summary("y", "Y"),
      ],
      llm,
      { notDuplicates: [["foo", "bar"]] },
    )
    expect(result.map((g) => g.slugs.sort())).toEqual([["x", "y"]])
  })

  it("treats whitelist entries case-insensitively and order-independently", async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({
        groups: [{ slugs: ["foo", "bar"], reason: "", confidence: "high" }],
      }),
    )
    // Whitelist stored with reversed casing/order — should still match.
    const result = await detectDuplicateGroups(
      [summary("foo", "Foo"), summary("bar", "Bar")],
      llm,
      { notDuplicates: [["BAR", "FOO"]] },
    )
    expect(result).toEqual([])
  })

  it("formats the user message with type / slug / title / tags / description", async () => {
    const llm = vi.fn().mockResolvedValue('{"groups":[]}')
    await detectDuplicateGroups(
      [
        {
          slug: "foo",
          path: "wiki/entities/foo.md",
          type: "entity",
          title: "Foo",
          description: "Short desc.",
          tags: ["t1", "t2"],
        },
        summary("bar", "Bar"),
      ],
      llm,
    )
    expect(llm).toHaveBeenCalledOnce()
    const userMsg = llm.mock.calls[0][1]
    expect(userMsg).toContain("type=entity")
    expect(userMsg).toContain("slug=foo")
    expect(userMsg).toContain('"Foo"')
    expect(userMsg).toContain("[t1, t2]")
    expect(userMsg).toContain("Short desc.")
  })
})

// ──────────────────────────────────────────────────────────────────
// Stage 3: rewriteCrossReferences (private since 01aab5f — driven via
// mergeDuplicateGroup, which applies it to every otherWikiPages entry)
// ──────────────────────────────────────────────────────────────────

/**
 * Apply `redirects` (old-slug → canonical-slug) to one cross-reference
 * page through the public merge path and return the resulting content.
 * mergeDuplicateGroup() reports only pages that actually changed, so a
 * page that is left untouched falls back to the original content —
 * exactly the contract the old pure function had.
 */
async function rewriteContent(
  content: string,
  redirects: Map<string, string>,
  path = "wiki/concepts/ref.md",
): Promise<string> {
  // mergeDuplicateGroup derives its redirects from group members that
  // are not the canonical slug, so rebuild that group from the map.
  const canonicalSlug = Array.from(redirects.values())[0]
  const slugs = [canonicalSlug, ...redirects.keys()].filter(
    (s, i, all) => all.indexOf(s) === i,
  )
  const result = await mergeDuplicateGroup(
    {
      group: slugs.map((slug) => ({
        slug,
        path: `wiki/entities/${slug}.md`,
        content: PAGE("type: entity", "x"),
      })),
      canonicalSlug,
      otherWikiPages: [{ path, content }],
    },
    vi.fn().mockResolvedValue(PAGE("type: entity", "merged")),
    { today: FIXED_TODAY },
  )
  return result.rewrites.find((r) => r.path === path)?.newContent ?? content
}

describe("rewriteCrossReferences", () => {
  it("rewrites bare wikilinks", async () => {
    const out = await rewriteContent(
      "See [[old-slug]] for context.",
      new Map([["old-slug", "new-slug"]]),
    )
    expect(out).toBe("See [[new-slug]] for context.")
  })

  it("rewrites wikilinks with aliases, preserving the alias", async () => {
    const out = await rewriteContent(
      "See [[old-slug|the old display]] here.",
      new Map([["old-slug", "new-slug"]]),
    )
    expect(out).toBe("See [[new-slug|the old display]] here.")
  })

  it("does not touch wikilinks pointing at unrelated slugs", async () => {
    const input = "Both [[paos]] and [[unrelated]] are mentioned."
    const out = await rewriteContent(
      input,
      new Map([["paos", "phosphorus-accumulating-organisms"]]),
    )
    expect(out).toContain("[[phosphorus-accumulating-organisms]]")
    expect(out).toContain("[[unrelated]]")
  })

  it("rewrites the related field (inline form)", async () => {
    const input = PAGE(
      "type: entity\ntitle: Foo\nrelated: [old-slug, kept]",
      "body",
    )
    const out = await rewriteContent(input, new Map([["old-slug", "new-slug"]]))
    expect(parseFrontmatterArray(out, "related")).toEqual(["new-slug", "kept"])
  })

  it("rewrites the related field (block form)", async () => {
    const input = PAGE(
      "type: entity\ntitle: Foo\nrelated:\n  - old-slug\n  - kept",
      "body",
    )
    const out = await rewriteContent(input, new Map([["old-slug", "new-slug"]]))
    expect(parseFrontmatterArray(out, "related")).toEqual(["new-slug", "kept"])
  })

  it("dedupes related when canonical was already in the list", async () => {
    // Page already linked to BOTH the canonical AND the duplicate.
    // After redirect, we'd have ["new-slug", "new-slug"] before dedup.
    const input = PAGE(
      "type: entity\nrelated: [old-slug, new-slug, kept]",
      "body",
    )
    const out = await rewriteContent(input, new Map([["old-slug", "new-slug"]]))
    expect(parseFrontmatterArray(out, "related")).toEqual(["new-slug", "kept"])
  })

  it("returns content unchanged when no redirects apply", async () => {
    const input = PAGE("type: entity\nrelated: [a, b]", "[[c]] and [[d]] here.")
    const out = await rewriteContent(input, new Map([["nonexistent", "other"]]))
    expect(out).toBe(input)
  })

  it("rewrites multiple slugs in one pass", async () => {
    const input = "[[old-a]] and [[old-b]] and [[keep-me]]."
    const out = await rewriteContent(
      input,
      new Map([
        ["old-a", "canonical"],
        ["old-b", "canonical"],
      ]),
    )
    expect(out).toBe("[[canonical]] and [[canonical]] and [[keep-me]].")
  })
})

// ──────────────────────────────────────────────────────────────────
// Stage 3: rewriteIndexMd
// ──────────────────────────────────────────────────────────────────

describe("rewriteIndexMd", () => {
  it("removes lines linking to merged-away slugs (markdown link form)", () => {
    const input = [
      "## Entities",
      "- [Accumulibacter](entities/accumulibacter.md)",
      "- [DPAOs (deprecated)](entities/dpaos.md)",
      "- [DPAO](entities/dpao.md)",
    ].join("\n")
    const out = rewriteIndexMd(input, new Set(["dpaos"]))
    expect(out).not.toContain("dpaos")
    expect(out).toContain("accumulibacter")
    expect(out).toContain("[DPAO](entities/dpao.md)")
  })

  it("removes lines with wikilinks to merged-away slugs", () => {
    const input = [
      "## Concepts",
      "- [[vfa]] — Volatile fatty acids",
      "- [[volatile-fatty-acids]] — VFAs (long form)",
      "- [[pha]] — PHA storage polymer",
    ].join("\n")
    const out = rewriteIndexMd(input, new Set(["volatile-fatty-acids"]))
    expect(out).not.toContain("volatile-fatty-acids")
    expect(out).toContain("[[vfa]]")
    expect(out).toContain("[[pha]]")
  })

  it("preserves headings and prose between lists", () => {
    const input = [
      "# Wiki Index",
      "",
      "Generated overview.",
      "",
      "## Entities",
      "- [DPAOs](entities/dpaos.md)",
      "- [DPAO](entities/dpao.md)",
      "",
      "## Concepts",
      "Some intro prose here, no slugs.",
    ].join("\n")
    const out = rewriteIndexMd(input, new Set(["dpaos"]))
    expect(out).toContain("# Wiki Index")
    expect(out).toContain("Generated overview.")
    expect(out).toContain("## Entities")
    expect(out).toContain("[DPAO](entities/dpao.md)")
    expect(out).toContain("## Concepts")
    expect(out).toContain("Some intro prose here")
    expect(out).not.toContain("dpaos.md")
  })

  it("is a no-op when removedSlugs is empty", () => {
    const input = "- [Foo](entities/foo.md)\n- [Bar](entities/bar.md)"
    expect(rewriteIndexMd(input, new Set())).toBe(input)
  })
})

// ──────────────────────────────────────────────────────────────────
// Stage 3: mergeDuplicateGroup (full integration with mock LLM)
// ──────────────────────────────────────────────────────────────────

describe("mergeDuplicateGroup", () => {
  it("throws when canonicalSlug isn't in the group", async () => {
    await expect(
      mergeDuplicateGroup(
        {
          group: [
            { slug: "a", path: "wiki/entities/a.md", content: PAGE("type: entity", "ax") },
            { slug: "b", path: "wiki/entities/b.md", content: PAGE("type: entity", "bx") },
          ],
          canonicalSlug: "z",
          otherWikiPages: [],
        },
        vi.fn(),
      ),
    ).rejects.toThrow(/canonicalSlug/)
  })

  it("throws when group has fewer than 2 pages", async () => {
    await expect(
      mergeDuplicateGroup(
        {
          group: [{ slug: "a", path: "wiki/entities/a.md", content: PAGE("type: entity", "x") }],
          canonicalSlug: "a",
          otherWikiPages: [],
        },
        vi.fn(),
      ),
    ).rejects.toThrow(/at least 2/)
  })

  it("merges bodies via LLM, unions sources/tags/related, stamps updated", async () => {
    const pageA = PAGE(
      'type: entity\ntitle: Accumulibacter\ncreated: 2026-04-09\nupdated: 2026-04-09\ntags: [microbiology, ebpr]\nrelated: [dpao, vfa]\nsources: ["doc-A.pdf"]',
      "## Anaerobic Phase\n\nDescription from page A.",
    )
    const pageB = PAGE(
      'type: entity\ntitle: 聚磷菌\ncreated: 2026-04-15\nupdated: 2026-04-15\ntags: [paos, propionate]\nrelated: [pha]\nsources: ["doc-B.pdf"]',
      "## 厌氧阶段\n\n来自页面 B 的描述。",
    )
    const llmMerged = PAGE(
      'type: entity\ntitle: Accumulibacter\ncreated: 2026-04-09\nupdated: 2026-04-09\ntags: [microbiology, ebpr]\nrelated: [dpao, vfa]\nsources: ["doc-A.pdf"]',
      "## Anaerobic Phase\n\nDescription from page A.\n\n## 厌氧阶段\n\n来自页面 B 的描述。",
    )
    const llm = vi.fn().mockResolvedValue(llmMerged)

    const result = await mergeDuplicateGroup(
      {
        group: [
          { slug: "accumulibacter", path: "wiki/entities/accumulibacter.md", content: pageA },
          { slug: "聚磷菌", path: "wiki/entities/聚磷菌.md", content: pageB },
        ],
        canonicalSlug: "accumulibacter",
        otherWikiPages: [],
      },
      llm,
      { today: FIXED_TODAY },
    )

    // Canonical body has both versions' content
    expect(result.canonicalContent).toContain("Anaerobic Phase")
    expect(result.canonicalContent).toContain("厌氧阶段")

    // Frontmatter unioned (set semantics — order not part of contract)
    expect(parseFrontmatterArray(result.canonicalContent, "sources").sort()).toEqual(
      ["doc-A.pdf", "doc-B.pdf"].sort(),
    )
    expect(parseFrontmatterArray(result.canonicalContent, "tags").sort()).toEqual(
      ["ebpr", "microbiology", "paos", "propionate"].sort(),
    )
    expect(parseFrontmatterArray(result.canonicalContent, "related").sort()).toEqual(
      ["dpao", "pha", "vfa"].sort(),
    )

    // Updated stamped to today
    expect(result.canonicalContent).toContain("updated: 2026-04-30")

    // Canonical path correct
    expect(result.canonicalPath).toBe("wiki/entities/accumulibacter.md")

    // The other group member's path is in pagesToDelete
    expect(result.pagesToDelete).toEqual(["wiki/entities/聚磷菌.md"])

    // Backup includes both pre-merge contents
    expect(result.backup).toEqual([
      { path: "wiki/entities/accumulibacter.md", content: pageA },
      { path: "wiki/entities/聚磷菌.md", content: pageB },
    ])
  })

  it("rewrites cross-references in other wiki pages", async () => {
    const pageA = PAGE("type: entity\ntitle: A\nrelated: [bar]", "body a")
    const pageB = PAGE("type: entity\ntitle: B\nrelated: [bar]", "body b")
    const referencingPage = PAGE(
      "type: concept\ntitle: Other\nrelated: [a, b, kept]",
      "See [[a]] and [[b|the b]] and [[unrelated]].",
    )
    const llm = vi.fn().mockResolvedValue(PAGE("type: entity\ntitle: A\n", "merged body"))

    const result = await mergeDuplicateGroup(
      {
        group: [
          { slug: "a", path: "wiki/entities/a.md", content: pageA },
          { slug: "b", path: "wiki/entities/b.md", content: pageB },
        ],
        canonicalSlug: "a",
        otherWikiPages: [
          { path: "wiki/concepts/other.md", content: referencingPage },
        ],
      },
      llm,
      { today: FIXED_TODAY },
    )

    expect(result.rewrites).toHaveLength(1)
    const rewritten = result.rewrites[0].newContent
    // wikilinks rewritten
    expect(rewritten).toContain("[[a]]")
    expect(rewritten).toContain("[[a|the b]]")
    expect(rewritten).toContain("[[unrelated]]")
    expect(rewritten).not.toMatch(/\[\[b(\|[^\]]*)?\]\]/)
    // related field rewritten + deduped
    expect(parseFrontmatterArray(rewritten, "related")).toEqual(["a", "kept"])
  })

  it("doesn't include unchanged pages in rewrites", async () => {
    const llm = vi.fn().mockResolvedValue(PAGE("type: entity\ntitle: A\n", "merged"))
    const irrelevant = PAGE(
      "type: concept\nrelated: [unrelated-slug]",
      "[[totally-different]] page.",
    )

    const result = await mergeDuplicateGroup(
      {
        group: [
          { slug: "a", path: "wiki/entities/a.md", content: PAGE("type: entity", "x") },
          { slug: "b", path: "wiki/entities/b.md", content: PAGE("type: entity", "y") },
        ],
        canonicalSlug: "a",
        otherWikiPages: [{ path: "wiki/concepts/irrelevant.md", content: irrelevant }],
      },
      llm,
      { today: FIXED_TODAY },
    )
    expect(result.rewrites).toEqual([])
    // Backup also doesn't include unchanged pages
    expect(result.backup.map((b) => b.path)).not.toContain("wiki/concepts/irrelevant.md")
  })

  it("backup snapshots the pre-merge state of every touched file", async () => {
    const pageA = PAGE("type: entity\ntitle: A", "body a")
    const pageB = PAGE("type: entity\ntitle: B", "body b")
    const refOrig = PAGE("type: concept\nrelated: [b]", "[[b]]")
    const llm = vi.fn().mockResolvedValue(PAGE("type: entity\ntitle: A", "merged"))

    const result = await mergeDuplicateGroup(
      {
        group: [
          { slug: "a", path: "wiki/entities/a.md", content: pageA },
          { slug: "b", path: "wiki/entities/b.md", content: pageB },
        ],
        canonicalSlug: "a",
        otherWikiPages: [{ path: "wiki/concepts/ref.md", content: refOrig }],
      },
      llm,
      { today: FIXED_TODAY },
    )

    // Backup has all 3 pre-merge files; rewrites only has the changed cross-ref
    const backupPaths = result.backup.map((b) => b.path).sort()
    expect(backupPaths).toEqual([
      "wiki/concepts/ref.md",
      "wiki/entities/a.md",
      "wiki/entities/b.md",
    ])
    // The backup content is the ORIGINAL, not the post-merge version
    const refBackup = result.backup.find((b) => b.path === "wiki/concepts/ref.md")
    expect(refBackup?.content).toBe(refOrig)
  })
})

describe("mergeDuplicateGroup 按路径更新引用", () => {
  const canonical = { slug: "新名", path: "wiki/concepts/新名.md", content: PAGE("type: concept", "新页") }
  const removed = {
    slug: "旧名", path: "wiki/entities/北境/旧名.md",
    content: PAGE('type: entity\nrelated: ["[[QM/entities/北境/旧名.md#头衔|尊称]]", "旧名"]', "旧页"),
  }
  const oldPath = "entities/北境/旧名"
  const newPath = "concepts/新名"
  const ambiguous = [
    { path: "wiki/chapters/旧名.md", content: "同名章节" },
    { path: "wiki/chapters/新名.md", content: "同名章节" },
  ]
  async function merge(other: {path: string; content: string}[], body: string) {
    return mergeDuplicateGroup({ group: [canonical, removed], canonicalSlug: "新名", otherWikiPages: other },
      vi.fn().mockResolvedValue(PAGE("type: concept", body)))
  }

  it("跨目录重定向正文和模型生成的主条目，保留后缀、代码及歧义引用", async () => {
    const body = (path: string) => [
      `[[${path}#头衔|尊称]] [[QM/${path}.md|显示]] [[./wiki/${path}.md#章节]]`,
      "[[旧名]] [[chapters/旧名]] [[entities/旧名]] [[../entities/北境/旧名]]",
      "`[[entities/北境/旧名]]`",
      '~~~md\n[[entities/北境/旧名]]\n~~~',
    ].join("\n")
    const ref = PAGE('type: note\nrelated:\n  - "wiki/entities/北境/旧名.md#头衔"\n  - "[[entities/北境/旧名|旧称]]"\n  - "chapters/旧名"\n  - 旧名\nsources: ["[[entities/北境/旧名]]"]', body(oldPath))
    const result = await merge([...ambiguous, { path: "wiki/notes/引文.md", content: ref }], body(oldPath))
    expect(result.pagesToDelete).toEqual([removed.path])
    expect(result.rewrites).toHaveLength(1)
    const revised = result.rewrites[0].newContent
    expect(revised).toContain(body(newPath))
    expect(parseFrontmatter(revised).frontmatter).toMatchObject({
      related: ["wiki/concepts/新名.md#头衔", "[[concepts/新名|旧称]]", "chapters/旧名", "旧名"],
      sources: ["[[entities/北境/旧名]]"],
    })
    expect(result.canonicalContent).toContain(body(newPath))
    expect(parseFrontmatter(result.canonicalContent).frontmatter?.related).toEqual(["[[QM/concepts/新名.md#头衔|尊称]]", "旧名"])
  })

  it.each(["related: [[entities/北境/旧名#头衔|旧称]]", "related:\n  - [[entities/北境/旧名#头衔|旧称]]"])("旧版 YAML 无引号双链 %s", async field => {
    const result = await merge([{ path: "wiki/notes/说明.md", content: PAGE(field + "\ntitle: 说明", "正文") }], "正文")
    expect(parseFrontmatter(result.rewrites[0].newContent).frontmatter).toEqual({
      related: ["[[concepts/新名#头衔|旧称]]"], title: "说明",
    })
  })

  it("唯一旧名指向有重名的主条目时补全路径", async () => {
    const result = await merge([ambiguous[1]], "[[旧名#身份|本名]]")
    expect(result.canonicalContent).toContain("[[concepts/新名#身份|本名]]")
  })

  it.each(["wiki/index.md", "QM/index.md"])("%s 识别独立旧条目，混合行保留其他引用", async (path) => {
    const index = [
      '# 索引', '- [旧条目](<QM/entities/北境/旧名.md#头衔>)', '- wiki/entities/北境/旧名.md',
      '- [[旧名]]', '- [[entities/北境/旧名#身世|旧名]] 和 [章节](chapters/旧名.md)',
      '接续 [入口](<./wiki/entities/北境/旧名.md#位置> "提示")。', '- [外站](https://example.org/旧名.md)',
      '`[[entities/北境/旧名]]`',
    ]
    const result = await merge([...ambiguous, { path, content: index.join("\n") }], "正文")
    expect(result.rewrites).toEqual([{ path, newContent: [
      index[0], index[3], '- [[concepts/新名#身世|旧名]] 和 [章节](chapters/旧名.md)',
      '接续 [入口](<./wiki/concepts/新名.md#位置> "提示")。', index[6], index[7],
    ].join("\n") }])
  })
})
