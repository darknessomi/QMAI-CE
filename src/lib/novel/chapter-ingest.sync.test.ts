import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"
import type { ChapterSnapshot } from "./chapter-ingest"
import { clearGraphCache, buildRetrievalGraph } from "@/lib/graph-relevance"
import { deleteChapterSnapshots, finalizeProjectMemoryRebuild, ingestOutline, listSnapshotHistory, restoreSnapshotHistory, syncSnapshotToMemory } from "./chapter-ingest"
import * as llmClient from "@/lib/llm-client"
import * as modelResolver from "./model-resolver"
import { useWikiStore } from "@/stores/wiki-store"
import { deleteFile, writeFileAtomic } from "@/commands/fs"
import { hasPendingMemoryRefresh } from "./memory-refresh-status"

const files = new Map<string, string>()
const dirs = new Set<string>()

function normalizePathForTest(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "")
}

function parentDir(path: string): string {
  const normalized = normalizePathForTest(path)
  const index = normalized.lastIndexOf("/")
  return index >= 0 ? normalized.slice(0, index) : ""
}

function ensureDir(path: string): void {
  const normalized = normalizePathForTest(path)
  if (!normalized) return
  const parts = normalized.split("/")
  for (let i = 1; i <= parts.length; i += 1) {
    dirs.add(parts.slice(0, i).join("/"))
  }
}

function writeTestFile(path: string, content: string): void {
  const normalized = normalizePathForTest(path)
  ensureDir(parentDir(normalized))
  files.set(normalized, content)
}

function listDirRecursive(path: string): FileNode[] {
  const normalized = normalizePathForTest(path)
  const childDirs = new Set<string>()
  const childFiles: FileNode[] = []

  for (const filePath of files.keys()) {
    if (!filePath.startsWith(`${normalized}/`)) continue
    const rest = filePath.slice(normalized.length + 1)
    const [first] = rest.split("/")
    if (!first) continue
    if (rest.includes("/")) {
      childDirs.add(first)
    } else {
      childFiles.push({ name: first, path: filePath, is_dir: false })
    }
  }

  return [
    ...Array.from(childDirs).sort().map((name) => {
      const dirPath = `${normalized}/${name}`
      return { name, path: dirPath, is_dir: true, children: listDirRecursive(dirPath) }
    }),
    ...childFiles.sort((a, b) => a.name.localeCompare(b.name)),
  ]
}

vi.mock("@/commands/fs", () => ({
  readMarkdownBatch: async (paths: string[]) => paths.map(path => files.get(normalizePathForTest(path)) ?? null),
  readFile: vi.fn(async (path: string) => {
    const normalized = normalizePathForTest(path)
    const content = files.get(normalized)
    if (content === undefined) throw new Error(`missing file: ${normalized}`)
    return content
  }),
  writeFileAtomic: vi.fn(async (path: string, content: string) => {
    writeTestFile(path, content)
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    writeTestFile(path, content)
  }),
  listDirectory: vi.fn(async (path: string) => {
    const normalized = normalizePathForTest(path)
    if (!dirs.has(normalized)) throw new Error(`missing dir: ${normalized}`)
    return listDirRecursive(normalized)
  }),
  fileExists: vi.fn(async (path: string) => {
    const normalized = normalizePathForTest(path)
    return files.has(normalized) || dirs.has(normalized)
  }),
  createDirectory: vi.fn(async (path: string) => {
    ensureDir(path)
  }),
  deleteFile: vi.fn(async (path: string) => {
    const normalized = normalizePathForTest(path)
    files.delete(normalized)
    dirs.delete(normalized)
  }),
}))

const syncedSnapshot: ChapterSnapshot = {
  chapterId: "chapter-1",
  chapterNumber: 1,
  summary: "新的设定已经改成灵石。",
  characters: [],
  locations: [],
  organizations: [],
  items: ["灵石"],
  events: [],
  characterStateChanges: [],
  relationshipChanges: [],
  knowledgeChanges: [],
  foreshadowingChanges: [],
  newCanonFacts: [],
  timelineEvents: [],
  conflicts: [],
  endingHook: "",
  graphNodes: [],
  graphEdges: [],
}

const syncedOutlineSnapshot: ChapterSnapshot = {
  ...syncedSnapshot,
  chapterId: "outline-main",
  chapterNumber: -1,
  chapterTitle: "总大纲",
}

describe("syncSnapshotToMemory", () => {
  beforeEach(() => {
    files.clear()
    dirs.clear()
    clearGraphCache()
    ensureDir("/project/wiki/entities")
    ensureDir("/project/wiki/chapters")
    ensureDir("/project/.qmai/novel/snapshots")
    writeTestFile("/project/wiki/chapters/chapter-001.md", [
      "---",
      "type: chapter",
      "chapter_number: 1",
      "chapter_status: final",
      "---",
      "",
      "# 第一章",
    ].join("\n"))
    writeTestFile("/project/wiki/entities/手机.md", [
      "---",
      "type: entity",
      'title: "手机"',
      "tags: [item]",
      'sources: ["001.snapshot.json"]',
      "---",
      "",
      "# 手机",
      "",
      "旧的手机设定。",
    ].join("\n"))
  })

  it("刷新同步后的图谱缓存，避免章节生成继续读取旧实体", async () => {
    const beforeSync = await buildRetrievalGraph("/project")
    expect(Array.from(beforeSync.nodes.values()).map((node) => node.title)).toContain("手机")

    await syncSnapshotToMemory("/project", syncedSnapshot)

    const afterSync = await buildRetrievalGraph("/project")
    const titles = Array.from(afterSync.nodes.values()).map((node) => node.title)
    expect(titles).not.toContain("手机")
    expect(titles).toContain("灵石")
  })

  it("长大纲从正式入口完整提取，源文件变更保留断点，重试写盘不重复请求模型", async () => {
    const outline = "/project/wiki/outlines/卷三/转折.md"
    const original = "首段约定。" + "风雨未停。".repeat(4000) + "末段交还信件。"
    writeTestFile(outline, original)
    const model = vi.spyOn(modelResolver, "resolveNovelModel").mockReturnValue({
      ...useWikiStore.getState().llmConfig, provider: "custom", apiKey: "fixture", model: "local-test", maxContextSize: 4096,
    })
    const stream = vi.spyOn(llmClient, "streamChat").mockImplementation(async (_config, messages, callbacks) => {
      const last = String(messages[1].content).includes("末段交还信件。")
      callbacks.onToken(JSON.stringify({ summary: "约定还信", events: [last ? "还信" : "约定"], endingHook: last ? "交还" : "" }))
    })
    try {
      const first = await ingestOutline("/project", outline, undefined, { skipSync: true })
      expect(stream.mock.calls.length).toBeGreaterThan(1)
      expect(first.snapshot?.events).toEqual(["约定", "还信"])
      expect(first.snapshot?.endingHook).toBe("交还")
      expect(first.truncated).toBe(false)
      const options = { outlineExtraction: { filePath: outline, checkpointPath: first.checkpointPath! } }
      writeTestFile(outline, original + "新稿")
      await expect(syncSnapshotToMemory("/project", first.snapshot!, options)).rejects.toThrow("大纲已修改")
      expect(files.has(first.checkpointPath!)).toBe(true)
      writeTestFile(outline, original)
      stream.mockClear()
      const saved = await ingestOutline("/project", outline)
      expect(saved.snapshot?.events).toEqual(["约定", "还信"])
      expect(stream).not.toHaveBeenCalled()
      expect(files.has(first.checkpointPath!)).toBe(false)
    } finally {
      model.mockRestore()
      stream.mockRestore()
    }
  })

  it("同步大纲快照时清理旧格式来源名留下的旧实体", async () => {
    clearGraphCache()
    files.delete(normalizePathForTest("/project/wiki/entities/手机.md"))
    writeTestFile("/project/wiki/entities/手机.md", [
      "---",
      "type: entity",
      'title: "手机"',
      "tags: [item]",
      'sources: ["0-1.snapshot.json"]',
      "---",
      "",
      "# 手机",
      "",
      "旧的大纲手机设定。",
    ].join("\n"))

    await syncSnapshotToMemory("/project", syncedOutlineSnapshot)

    const afterSync = await buildRetrievalGraph("/project")
    const titles = Array.from(afterSync.nodes.values()).map((node) => node.title)
    expect(titles).not.toContain("手机")
    expect(titles).toContain("灵石")
  })

  it("鍚屾澶х翰蹇収鏃朵細鐢熸垚鍙洖鐪嬬殑鍘嗗彶蹇収", async () => {
    writeTestFile("/project/.qmai/novel/snapshots/outline-001.snapshot.json", JSON.stringify({
      ...syncedOutlineSnapshot,
      summary: "鍚屾鍓嶇殑澶х翰蹇収",
    }, null, 2))

    await syncSnapshotToMemory("/project", syncedOutlineSnapshot)

    const history = await listSnapshotHistory("/project", syncedOutlineSnapshot.chapterNumber)
    expect(history).toHaveLength(1)
    const backupContent = files.get(normalizePathForTest(history[0].path))
    expect(backupContent).toContain("鍚屾鍓嶇殑澶х翰蹇収")
    expect(backupContent).not.toContain("memorySyncedAt")
  })
  it("writes revision metadata to the current snapshot and archives the superseded snapshot as history", async () => {
    writeTestFile("/project/.qmai/novel/snapshots/001.snapshot.json", JSON.stringify({
      ...syncedSnapshot,
      summary: "old synced snapshot",
      sourceType: "chapter",
      sourceSequence: 1,
      revision: 1,
      snapshotId: "chapter-1-r1",
      isHistorical: false,
    }, null, 2))

    await syncSnapshotToMemory("/project", syncedSnapshot)

    const current = JSON.parse(files.get("/project/.qmai/novel/snapshots/001.snapshot.json") ?? "{}")
    expect(current.sourceType).toBe("chapter")
    expect(current.sourceSequence).toBe(1)
    expect(current.revision).toBe(2)
    expect(current.snapshotId).toBe("chapter-1-r2")
    expect(current.supersedes).toBe("chapter-1-r1")
    expect(current.isHistorical).toBe(false)
    expect(current.memorySyncedAt).toEqual(expect.any(String))

    const history = await listSnapshotHistory("/project", 1)
    expect(history).toHaveLength(1)
    const archived = JSON.parse(files.get(normalizePathForTest(history[0].path)) ?? "{}")
    expect(archived.revision).toBe(1)
    expect(archived.snapshotId).toBe("chapter-1-r1")
    expect(archived.isHistorical).toBe(true)
  })

  it("removes stale projection pages that only belong to the superseded snapshot id", async () => {
    writeTestFile("/project/.qmai/novel/snapshots/001.snapshot.json", JSON.stringify({
      ...syncedSnapshot,
      summary: "old synced snapshot",
      sourceType: "chapter",
      sourceSequence: 1,
      revision: 1,
      snapshotId: "chapter-1-r1",
      isHistorical: false,
    }, null, 2))
    writeTestFile("/project/wiki/entities/mobile-phone.md", [
      "---",
      "type: entity",
      'title: "手机"',
      'snapshot_id: "chapter-1-r1"',
      'source_type: "chapter"',
      "source_sequence: 1",
      "source_revision: 1",
      "is_historical: false",
      "sources: []",
      "---",
      "",
      "# 手机",
      "",
      "旧的手机设定。",
    ].join("\n"))

    await syncSnapshotToMemory("/project", syncedSnapshot)

    expect(files.has("/project/wiki/entities/mobile-phone.md")).toBe(false)
  })

  it("编辑、恢复及删除同步检索、人物页、时间线和进度，重提早章不使进度回退", async () => {
    const initial = { ...syncedSnapshot, chapterTitle: "钟声", characterStateChanges: ["林默：在车站"], timelineEvents: ["夜里抵达车站"] }
    const later = { ...syncedSnapshot, chapterNumber: 2, chapterId: "chapter-2", chapterTitle: "返程" }
    const people = "/project/wiki/memory/character-states.md", timeline = "/project/wiki/memory/timeline.md"
    const index = "/project/.qmai/retrieval/index.md", volume = "/project/.qmai/retrieval/volume-1.md"
    const progress = "/project/wiki/memory/writing-progress.md"
    await syncSnapshotToMemory("/project", initial)
    await syncSnapshotToMemory("/project", later)
    writeTestFile(volume, files.get(volume)!.replace("- 人工备注：", "- 人工备注：保留第一行\n保留第二行"))
    await syncSnapshotToMemory("/project", { ...initial, characterStateChanges: [], timelineEvents: [] })
    expect(files.get(people)).not.toContain("在车站")
    expect(files.get(volume)).not.toContain("夜里抵达车站")
    expect(files.get(progress)).toContain("第2章：返程")
    const [revision] = await listSnapshotHistory("/project", 1)
    await restoreSnapshotHistory("/project", 1, revision.fileName)
    expect(files.get(people)).toContain("在车站")
    expect(files.get(timeline)).toContain("夜里抵达车站")
    expect(files.get(volume)).toContain("夜里抵达车站")
    expect(files.get(volume)).toContain("保留第一行\n保留第二行")
    expect(files.has(index)).toBe(true)
    await deleteChapterSnapshots("/project", 2)
    expect(files.get(progress)).toContain("第1章：钟声")
    expect(files.get(volume)).not.toContain("## 第2章")
    await deleteChapterSnapshots("/project", 1)
    expect(files.has(volume)).toBe(false)
    expect(files.get(index)).not.toContain("volume-1")
  })

  it("索引写入失败后用原快照补刷，保留提取时的正文指纹和修订号", async () => {
    const index = "/project/.qmai/retrieval/index.md"
    const writer = vi.mocked(writeFileAtomic)
    const normalWrite = writer.getMockImplementation()!
    writer.mockImplementation(async (path, content) => {
      if (path === index) throw new Error("模拟磁盘写入失败")
      await normalWrite(path, content)
    })
    try {
      await expect(syncSnapshotToMemory("/project", syncedSnapshot, {
        source: { filePath: "wiki/chapters/chapter-001.md", sourceHash: "12345" },
      })).rejects.toThrow("可在记忆中心")
    } finally {
      writer.mockImplementation(normalWrite)
    }
    expect(await hasPendingMemoryRefresh("/project")).toBe(true)
    const snapshotPath = "/project/.qmai/novel/snapshots/001.snapshot.json"
    const original = files.get(snapshotPath)
    expect(original).toBeTruthy()
    writeTestFile("/project/wiki/chapters/chapter-001.md", "---\nchapter_number: 1\n---\n正文已修改")
    await finalizeProjectMemoryRebuild("/project")
    expect(await hasPendingMemoryRefresh("/project")).toBe(false)
    expect(files.get(snapshotPath)).toBe(original)
    expect(files.get(index)).toContain("volume-1")
    expect(files.get("/project/.qmai/retrieval/volume-1.md")).toContain("sourceHash：12345")
  })

  it("同一毫秒保存和恢复不覆盖所选历史快照", async () => {
    const time = vi.spyOn(Date, "now").mockReturnValue(1780000000000)
    try {
      await syncSnapshotToMemory("/project", { ...syncedSnapshot, summary: "原稿" })
      await syncSnapshotToMemory("/project", { ...syncedSnapshot, summary: "修改稿" })
      const [original] = await listSnapshotHistory("/project", 1)
      const restored = await restoreSnapshotHistory("/project", 1, original.fileName)
      expect(restored.summary).toBe("原稿")
      const versions = await listSnapshotHistory("/project", 1)
      expect(versions.map((v) => JSON.parse(files.get(v.path)!).summary)).toEqual(["修改稿", "原稿"])
      expect(versions.every((v) => Number.isFinite(Date.parse(v.createdAt)))).toBe(true)
    } finally {
      time.mockRestore()
    }
  })

  it("在写章节附属文件和删除快照中途出错时，重试完成原操作", async () => {
    const md = "/project/.qmai/novel/snapshots/001.snapshot.md"
    const writer = vi.mocked(writeFileAtomic)
    const normalWrite = writer.getMockImplementation()!
    writer.mockImplementation(async (path, content) => {
      if (path === md) throw new Error("写盘失败")
      await normalWrite(path, content)
    })
    try {
      await expect(syncSnapshotToMemory("/project", syncedSnapshot)).rejects.toThrow("写盘失败")
    } finally { writer.mockImplementation(normalWrite) }
    await finalizeProjectMemoryRebuild("/project")
    expect(files.get(md)).toContain(syncedSnapshot.summary)
    expect(files.has("/project/.qmai/novel/chapter-ingest-output/001.output.json")).toBe(true)

    const remove = vi.mocked(deleteFile)
    const normalRemove = remove.getMockImplementation()!
    remove.mockImplementation(async (path) => {
      if (path.endsWith(".snapshot.json")) throw new Error("删除失败")
      await normalRemove(path)
    })
    try {
      await expect(deleteChapterSnapshots("/project", 1)).rejects.toThrow("删除失败")
    } finally { remove.mockImplementation(normalRemove) }
    await finalizeProjectMemoryRebuild("/project")
    expect([...files.keys()].some((path) => path.includes("/001."))).toBe(false)
    expect(await hasPendingMemoryRefresh("/project")).toBe(false)
    expect(files.has("/project/.qmai/retrieval/volume-1.md")).toBe(false)
  })

  it("clears derived memory files when deleting the last snapshot", async () => {
    const snapshotWithMemory: ChapterSnapshot = {
      ...syncedSnapshot,
      knowledgeChanges: ["主角: 误以为手机仍在手里"],
      characterStateChanges: ["主角: 正在追查旧手机"],
      foreshadowingChanges: ["新增伏笔: 旧手机 - 屏幕仍会亮"],
    }
    writeTestFile("/project/.qmai/novel/snapshots/001.snapshot.json", JSON.stringify(snapshotWithMemory, null, 2))
    await syncSnapshotToMemory("/project", snapshotWithMemory)

    expect(files.get("/project/wiki/memory/chapter-snapshots.md")).toContain("新的设定")

    await deleteChapterSnapshots("/project", 1)

    expect(files.has("/project/.qmai/novel/snapshots/001.snapshot.json")).toBe(false)
    expect(files.get("/project/wiki/memory/chapter-snapshots.md")).not.toContain("新的设定")
    expect(files.get("/project/wiki/memory/character-cognition.md")).not.toContain("误以为手机")
    expect(files.get("/project/wiki/memory/character-states.md")).not.toContain("正在追查")
    expect(files.get("/project/wiki/memory/foreshadowing-tracker.md")).not.toContain("旧手机")
  })

  it("大纲快照的编辑和删除只更新大纲记忆，不改写正式状态", async () => {
    const state = JSON.stringify({ characters: [{ characterName: "手改角色", status: "保留" }] })
    writeTestFile("/project/.qmai/novel/character-states.json", state)
    await syncSnapshotToMemory("/project", { ...syncedOutlineSnapshot,
      characterStateChanges: ["手改角色：改写"], timelineEvents: ["大纲计划"], foreshadowingChanges: ["新增：大纲计划"],
    })
    await deleteChapterSnapshots("/project", syncedOutlineSnapshot.chapterNumber)
    expect(files.has("/project/.qmai/novel/snapshots/outline-001.snapshot.json")).toBe(false)
    expect(files.get("/project/.qmai/novel/character-states.json")).toBe(state)
    expect(files.has("/project/wiki/memory/timeline.md")).toBe(false)
    expect(files.has("/project/.qmai/novel/foreshadowing-tracker.json")).toBe(false)
  })
})
