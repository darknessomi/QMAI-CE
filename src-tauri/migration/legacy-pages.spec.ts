import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { bindStagingRoot } from "./filesystem.mjs"
import { verifyLegacyPages } from "./legacy-pages"
import { refreshStagedProject } from "./refresh"

vi.mock("@/commands/fs", () => import("./filesystem.mjs"))

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "qmai-legacy-pages-"))
  root = await bindStagingRoot(root)
})
afterEach(() => rm(root, { recursive: true }))

async function write(path: string, content: string) {
  const dest = join(root, path)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, content)
}

it("阻止从快照重建时覆盖同名页上的手写补充", async () => {
  await write("QM/memory/timeline.md", "# 时间线\n- 作者手写的重要见证")
  await expect(verifyLegacyPages(root, [])).rejects.toThrow("QM/memory/timeline.md")
})

it("缺少来源时保留追踪页并报告作者需要检查的文件", async () => {
  await write("migration-input/角色状态.md", "# 角色状态快照\n## 林老师")
  await expect(verifyLegacyPages(root, [])).rejects.toThrow("QM/tracking/角色状态.md")
})

it("手工索引备注不能因旧分卷格式异常而消失", async () => {
  await write(".qmai/retrieval/volume-1.md", "# 第1卷\n\n作者手写的下章提醒")
  await expect(verifyLegacyPages(root, [])).rejects.toThrow("retrieval/volume-1.md")
})

it("遇到旧总索引中的独立手记时中止", async () => {
  await write(".qmai/retrieval/index.md", "# 检索主索引\n\n## 作者手记\n- 稍后回收")
  await expect(verifyLegacyPages(root, [])).rejects.toThrow("retrieval/index.md")
})

it("旧认知含大纲内容时保留原始文件并继续按正文重建", async () => {
  const cognitionPath = ".qmai/novel/cognition-state.json"
  const original = JSON.stringify({
    characters: [{ character: "林老师", knows: ["访客已到", "下卷会前往港口"], doesNotKnow: [] }],
    readerKnows: [],
    lastUpdatedChapter: 1,
  }, null, 2) + "\n"
  await write(cognitionPath, original)
  await write("QM/chapters/第1章.md", "---\ntype: chapter\nchapter_number: 1\n---\n正文")
  await write(".qmai/novel/snapshots/001.snapshot.json", JSON.stringify({ chapterNumber: 1, knowledgeChanges: ["林老师知道访客已到"] }))
  await write(".qmai/novel/snapshots/outline-2.snapshot.json", JSON.stringify({ chapterNumber: -2, sourceType: "outline", knowledgeChanges: ["林老师知道下卷会前往港口"] }))

  const files = await refreshStagedProject(root)
  const backup = files.find(file => /^\.qmai\/novel\/cognition-state\.legacy-[a-f0-9]{64}\.bak$/.test(file.path))
  expect(backup?.contents).toBe(original)
  const rebuilt = files.find(file => file.path === cognitionPath)
  expect(JSON.parse(rebuilt?.contents ?? "null")?.characters).toEqual([
    { character: "林老师", knows: ["访客已到"], doesNotKnow: [] },
  ])
})
