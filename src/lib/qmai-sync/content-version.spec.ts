import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"

vi.mock("@/commands/fs", () => ({ listDirectory: vi.fn(), readFile: vi.fn() }))
vi.mock("./log", () => ({ appendSyncLog: vi.fn(async () => {}) }))
vi.mock("@/lib/builtin-models/gateway-api", () => ({ gatewayAuthHeaders: async () => ({ Authorization: "Bearer synthetic" }) }))

import { backupProject } from "./backup"
import * as client from "./client"

const generation = "a".repeat(64), revision = "12345678-1234-1234-1234-123456789abc"
const hash = (content: string) => createHash("sha256").update(content).digest("hex")
const file = (content: string) => ({ path: "a.md", size: Buffer.byteLength(content), mtime: 1, sha256: hash(content), revision })
const view = (content?: string) => ({ protocolVersion: 2, projectId: "project", storageGeneration: generation, files: content === undefined ? [] : [file(content)] })
const baseline = (content: string) => ({ "a.md": { size: Buffer.byteLength(content), mtime: 1, sha256: hash(content), revision, storageGeneration: generation } })
const upload = vi.fn(async (args: { projectId: string; relPath: string; content: string }) => ({
  protocolVersion: 2, projectId: args.projectId, path: args.relPath, size: Buffer.byteLength(args.content),
  sha256: hash(args.content), revision, storageGeneration: generation,
}))
const options = (content: string, remote?: string) => ({
  baseUrl: "http://synthetic.test", netcard: "synthetic", projectPath: "/synthetic", projectId: "project",
  read: async () => content, upload,
  collect: async () => ({ files: [{ absPath: "/synthetic/a.md", relPath: "a.md", size: Buffer.byteLength(content), mtime: 1 }], skipped: 0, truncated: false }),
  listRemote: async () => view(remote),
})
beforeEach(() => vi.clearAllMocks())

describe("内容版本保护", () => {
  it("本地缓存未变化但云端丢失时必须补传", async () => {
    const result = await backupProject({ ...options("AA"), known: baseline("AA") })
    expect(result.uploaded).toBe(1)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(result.skippedUnchanged).toBe(0)
  })
  it("大小和mtime相同但内容已改时仍上传", async () => {
    const result = await backupProject({ ...options("BB", "AA"), known: baseline("AA") })
    expect(result.uploaded).toBe(1)
    expect(upload.mock.calls[0][0]).toMatchObject({ condition: { storageGeneration: generation, revision } })
  })
  it("云端和本地内容相同才跳过，并建立可信回执", async () => {
    const result = await backupProject(options("正文", "正文"))
    expect(result.skippedUnchanged).toBe(1)
    expect(upload).not.toHaveBeenCalled()
    expect(result.manifest["a.md"]).toMatchObject({ sha256: hash("正文"), storageGeneration: generation, revision })
  })
  it("云端与上次回执不同且本地也不同，保留双方并报冲突", async () => {
    const result = await backupProject({ ...options("本地新稿", "另一设备新稿"), known: baseline("旧稿") })
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].message).toContain("冲突")
    expect(result.manifest["a.md"]).toBeUndefined()
    expect(upload).not.toHaveBeenCalled()
  })
  it("旧缓存只有mtime不构成覆盖云端不同内容的授权", async () => {
    const result = await backupProject({ ...options("本地", "云端"), known: { "a.md": { size: 6, mtime: 1 } } })
    expect(result.failed).toHaveLength(1)
    expect(upload).not.toHaveBeenCalled()
  })
  it("存储代次改变后不能沿用旧回执覆盖不同内容", async () => {
    const args = options("本地", "旧稿")
    args.listRemote = async () => ({ ...view("旧稿"), storageGeneration: "b".repeat(64) })
    const result = await backupProject({ ...args, known: baseline("旧稿") })
    expect(result.failed).toHaveLength(1)
    expect(upload).not.toHaveBeenCalled()
  })
  it("清单失败时整次中止，不按空清单上传", async () => {
    await expect(backupProject({ ...options("正文"), listRemote: async () => { throw new Error("清单读取失败") } })).rejects.toThrow("清单读取失败")
    expect(upload).not.toHaveBeenCalled()
  })
  it("伪造成功回执不得计作备份成功", async () => {
    const result = await backupProject({ ...options("正文"), upload: async () => ({ protocolVersion: 2, ...file("错误内容"), projectId: "project", storageGeneration: generation }) })
    expect(result.uploaded).toBe(0)
    expect(result.failed).toHaveLength(1)
    expect(result.manifest["a.md"]).toBeUndefined()
  })
  it("中文上传统计实际UTF-8字节数", async () => {
    const args = options("正文")
    args.collect = async () => ({ files: [{ absPath: "/synthetic/a.md", relPath: "a.md", size: 999, mtime: 1 }], skipped: 0, truncated: false })
    const result = await backupProject(args)
    expect(result.totalBytes).toBe(6)
    expect(result.manifest["a.md"].size).toBe(6)
  })
})

describe("客户端版本协议", () => {
  it("旧服务无manifest协议时拒绝自动降级", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ files: [] })))
    await expect(client.fetchSyncManifest("http://synthetic.test", "card", "project", fetcher)).rejects.toThrow(/清单|版本|升级/)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it("拒绝重复路径与其他工程的manifest", async () => {
    for (const body of [{ ...view("AA"), files: [file("AA"), file("BB")] }, { ...view(), projectId: "other" }]) {
      await expect(client.fetchSyncManifest("http://synthetic.test", "card", "project", async () => new Response(JSON.stringify(body)))).rejects.toThrow()
    }
  })
})
