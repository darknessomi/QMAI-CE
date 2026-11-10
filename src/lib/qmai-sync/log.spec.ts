// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 同步日志（本地文件）。
 *
 * ## 为什么值得单独测
 *
 * 日志是「出事时唯一能看的东西」。它自己要是坏了（写不进、写乱、
 * 把同步搞崩），等于在最需要它的时候失效 —— 而且用户不会知道，
 * 只会觉得「同步有问题，但也不知道哪有问题」。
 *
 * 这里钉三条：
 *   · 并发写不能互相覆盖（同步是多文件并发的）
 *   · 超过上限要截断，不能无限长
 *   · 写日志失败不能把调用方带崩
 */

const store = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
  failWrite: false,
}))

vi.mock("@/commands/fs", () => ({
  fileExists: vi.fn(async (p: string) => store.files.has(p) || store.dirs.has(p)),
  createDirectory: vi.fn(async (p: string) => {
    store.dirs.add(p)
  }),
  readFile: vi.fn(async (p: string) => {
    const v = store.files.get(p)
    if (v === undefined) throw new Error("not found")
    return v
  }),
  writeFileAtomic: vi.fn(async (p: string, c: string) => {
    if (store.failWrite) throw new Error("磁盘只读")
    store.files.set(p, c)
  }),
}))

vi.mock("@/lib/path-utils", () => ({
  normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, ""),
}))

import { appendSyncLog, memberCloudLogPath, readSyncLogEntries } from "./log"

const PROJECT = "/data/proj"
const LOG_FILE = "/data/proj/.qmai/member-cloud-sync.log"

beforeEach(() => {
  store.files.clear()
  store.dirs.clear()
  store.failWrite = false
})

describe("日志路径", () => {
  it("落在工程的 .qmai 目录下", () => {
    expect(memberCloudLogPath(PROJECT)).toBe(LOG_FILE)
  })
})

describe("追加日志", () => {
  it("首次写入会创建目录和文件", async () => {
    await appendSyncLog(PROJECT, { event: "backup.start", projectId: "p1" })

    expect(store.dirs.has("/data/proj/.qmai")).toBe(true)
    const raw = store.files.get(LOG_FILE)
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!.split("\n")[0])
    expect(parsed.event).toBe("backup.start")
    expect(parsed.projectId).toBe("p1")
    expect(typeof parsed.at).toBe("string")
  })

  it("连续追加不会互相覆盖", async () => {
    await appendSyncLog(PROJECT, { event: "backup.start", projectId: "p1" })
    await appendSyncLog(PROJECT, { event: "upload.ok", path: "a.md" })
    await appendSyncLog(PROJECT, { event: "backup.end", uploaded: 1 })

    const lines = store.files.get(LOG_FILE)!.split("\n").filter(Boolean)
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]).event).toBe("backup.start")
    expect(JSON.parse(lines[1]).event).toBe("upload.ok")
    expect(JSON.parse(lines[2]).event).toBe("backup.end")
  })

  it("并发追加全部落盘（不丢条目）", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        appendSyncLog(PROJECT, { event: "upload.ok", path: `f${i}.md` }),
      ),
    )

    const lines = store.files.get(LOG_FILE)!.split("\n").filter(Boolean)
    expect(lines).toHaveLength(10)
    const paths = lines.map((l) => JSON.parse(l).path).sort()
    expect(paths).toEqual(Array.from({ length: 10 }, (_, i) => `f${i}.md`).sort())
  })
})

describe("容错", () => {
  it("写盘失败不抛错（不能把同步带崩）", async () => {
    store.failWrite = true
    await expect(
      appendSyncLog(PROJECT, { event: "backup.start" }),
    ).resolves.toBeUndefined()
  })

  it("项目路径为空时直接返回", async () => {
    await expect(appendSyncLog("", { event: "backup.start" })).resolves.toBeUndefined()
    expect(store.files.size).toBe(0)
  })

  it("读取时跳过坏行", async () => {
    store.files.set(LOG_FILE, '{"event":"backup.start"}\n半截行没写完\n{"event":"backup.end"}')
    const entries = await readSyncLogEntries(PROJECT)
    expect(entries).toHaveLength(2)
    expect(entries[0].event).toBe("backup.start")
    expect(entries[1].event).toBe("backup.end")
  })

  it("文件不存在时返回空数组", async () => {
    expect(await readSyncLogEntries(PROJECT)).toEqual([])
  })
})
