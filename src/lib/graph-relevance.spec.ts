import { beforeEach, expect, test, vi } from "vitest"
import type { FileNode } from "@/types/wiki"

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
}))

import { listDirectory, readFile } from "@/commands/fs"
import { buildRetrievalGraph, clearGraphCache, getRelatedNodes } from "./graph-relevance"

const mockedListDirectory = vi.mocked(listDirectory)
const mockedReadFile = vi.mocked(readFile)

function wikiTree(projectPath: string): FileNode[] {
  return [
    {
      name: "entities",
      path: `${projectPath}/wiki/entities`,
      is_dir: true,
      children: [
        { name: "A.md", path: `${projectPath}/wiki/entities/A.md`, is_dir: false },
        { name: "B.md", path: `${projectPath}/wiki/entities/B.md`, is_dir: false },
      ],
    },
  ]
}

beforeEach(() => {
  clearGraphCache()
  vi.clearAllMocks()
})

test("shares in-flight graph builds for the same project and data version", async () => {
  mockedListDirectory.mockResolvedValue(wikiTree("/Project"))
  mockedReadFile.mockImplementation(async (path) => {
    if (path.endsWith("A.md")) {
      return "---\ntype: entity\ntitle: Alpha\n---\n\n# Alpha\n[[B]]"
    }
    return "---\ntype: entity\ntitle: Beta\n---\n\n# Beta\n"
  })

  const [first, second] = await Promise.all([
    buildRetrievalGraph("/Project", 12),
    buildRetrievalGraph("/Project", 12),
  ])

  expect(first).toBe(second)
  expect(mockedListDirectory).toHaveBeenCalledTimes(1)
  expect(mockedReadFile).toHaveBeenCalledTimes(2)
})

test("does not reuse graph cache across projects with the same data version", async () => {
  mockedListDirectory.mockImplementation(async (wikiRoot) => {
    const projectPath = String(wikiRoot).replace(/\/wiki$/, "")
    return wikiTree(projectPath)
  })
  mockedReadFile.mockImplementation(async (path) => {
    if (String(path).startsWith("/ProjectA/")) {
      return "---\ntype: entity\ntitle: Project A Node\n---\n\n# Project A Node\n"
    }
    return "---\ntype: entity\ntitle: Project B Node\n---\n\n# Project B Node\n"
  })

  const first = await buildRetrievalGraph("/ProjectA", 12)
  const second = await buildRetrievalGraph("/ProjectB", 12)

  expect([...first.nodes.values()][0]?.title).toBe("Project A Node")
  expect([...second.nodes.values()][0]?.title).toBe("Project B Node")
  expect(mockedListDirectory).toHaveBeenCalledTimes(2)
})

test("别名冲突保留目录中第一个候选，精确匹配及直接关系排序仍独立", async () => {
  const ids = ["Crown Gate", "Crown-Gate", "远航", "独立页"]
  mockedListDirectory.mockResolvedValue(ids.map((id) => ({
    name: `${id}.md`, path: `/Project/wiki/entities/${id}.md`, is_dir: false,
  })))
  mockedReadFile.mockImplementation(async (path) => {
    const text = path.endsWith("/远航.md")
      ? "- [[CROWN  GATE|城门]] — 合作\n- [[Crown-Gate]] — 位于"
      : ""
    return `---\ntype: entity\n---\n${text}`
  })

  const graph = await buildRetrievalGraph("/Project")
  const source = graph.nodes.get("远航")!
  expect([...source.outLinks]).toEqual(["Crown Gate", "Crown-Gate"])
  expect(source.relationEdges).toEqual([
    { target: "Crown Gate", relation: "ALLY_OF" },
    { target: "Crown-Gate", relation: "LOCATED_AT" },
  ])
  expect(graph.nodes.get("Crown Gate")!.inLinks.has("远航")).toBe(true)
  expect(graph.nodes.get("Crown-Gate")!.inLinks.has("远航")).toBe(true)
  expect(getRelatedNodes("远航", graph).map(({ node }) => node.id)).toEqual([
    "Crown Gate", "Crown-Gate", "独立页",
  ])
})
