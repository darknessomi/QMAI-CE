// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { testManifest, testReceipt, testFile } from "@/lib/qmai-sync/test-fixtures"

const remoteFiles = new Map<string, Map<string, string>>()
const remoteKey = (base: string, card: string, project: string) => JSON.stringify([base, card, project])

const io = vi.hoisted(() => ({ relay: "https://storage-a.test", content: "x", upload: vi.fn(), download: vi.fn(), create: vi.fn() }))
vi.mock("./account-store", async () => {
  const { create } = await import("zustand")
  return { useAccountStore: create(() => ({ user: null, session: null })) }
})
vi.mock("./wiki-store", async () => {
  const { create } = await import("zustand")
  return { useWikiStore: create(() => ({ project: null })) }
})
vi.mock("@/lib/builtin-models/relay-endpoints", () => ({ resolveSyncBaseUrl: async () => io.relay }))
vi.mock("@/lib/project-identity", () => ({ ensureProjectId: async () => "same-project" }))
vi.mock("@/commands/fs", () => ({
  listDirectory: async () => ["a.md", "b.md"].map(name => ({ name, path: "C:/synthetic/" + name, is_dir: false, size: 1, mtimeMs: 1 })),
  readFile: async () => io.content,
  writeFileIfAbsent: (...args: unknown[]) => io.create(...args),
}))
vi.mock("@/lib/qmai-sync/log", () => ({ appendSyncLog: vi.fn(async () => {}) }))
vi.mock("@/lib/qmai-sync/client", async original => ({
  ...await original<typeof import("@/lib/qmai-sync/client")>(),
  uploadSyncFile: (...args: unknown[]) => io.upload(...args),
  fetchSyncManifest: async (base: string, card: string, project: string) => testManifest(project,
    [...(remoteFiles.get(remoteKey(base, card, project)) ?? new Map<string, string>())].map(([path, text]) => testFile(path, text))),
  fetchSyncList: async () => [{ path: "remote.md", mtime: 100, size: 1 }],
  downloadSyncFile: (...args: unknown[]) => io.download(...args),
}))
import { useAccountStore } from "./account-store"
import { useWikiStore } from "./wiki-store"
import { useMemberCloudStore as cloud, readFailedUploads, writeFailedUploads } from "./member-cloud-store"
import { SyncError } from "@/lib/qmai-sync/client"

function login(id: number, baseUrl = "https://identity-a.test") {
  const user = { id, email: "same@example.test", displayName: "合成用户", createdAt: 1, avatarUpdatedAt: null, displayNameUpdatedAt: null,
    membership: { active: true, expiresAt: 4102444799, remainingDays: 1, planLabel: "月卡", forever: false } }
  useAccountStore.setState({ user, session: { user, baseUrl, accessToken: "synthetic-access-" + id,
    refreshToken: "synthetic-refresh-" + id, accessExpiresAt: 4102444799, refreshExpiresAt: 4102444799,
    netcard: "synthetic-card-" + id + (baseUrl === "https://identity-a.test" ? "" : "-identity-b"), savedAt: 1 } })
}
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); io.relay = "https://storage-a.test"; io.content = "x"
  useAccountStore.setState({ user: null, session: null }); cloud.getState().resetRuntime()
  useWikiStore.setState({ project: { path: "C:/synthetic", id: "same-project", name: "合成作品" } })
  remoteFiles.clear()
  io.upload.mockImplementation(async (base: string, card: string, project: string, relPath: string, content: string) => {
    const key = remoteKey(base, card, project)
    if (!remoteFiles.has(key)) remoteFiles.set(key, new Map())
    remoteFiles.get(key)!.set(relPath, content)
    return testReceipt({ projectId: project, relPath, content })
  }); io.download.mockResolvedValue("x"); io.create.mockResolvedValue(true)
})

describe("备份账号及任务隔离", () => {
  it("部分上传失败保留上次确认基线，下次重试不会误报自身冲突", async () => {
    login(1); await cloud.getState().runBackup()
    io.content = "y"
    io.upload.mockRejectedValueOnce(new SyncError("quota_exceeded", "合成配额不足", 413))
    await cloud.getState().runBackup()
    expect(cloud.getState().lastResult?.failed).toHaveLength(1)
    await cloud.getState().runBackup()
    expect(cloud.getState().lastResult?.failed).toHaveLength(0)
    expect(cloud.getState().lastResult?.uploaded).toBe(1)
    expect(cloud.getState().lastResult?.skippedUnchanged).toBe(1)
    expect(remoteFiles.get(remoteKey(io.relay, "synthetic-card-1", "same-project"))?.get("a.md")).toBe("y")
  })
  it("A备份后切到B，同一作品仍须上传到B", async () => {
    login(1); await cloud.getState().runBackup(); expect(io.upload).toHaveBeenCalledTimes(2)
    login(2); cloud.getState().resetRuntime(); await cloud.getState().runBackup()
    expect(io.upload).toHaveBeenCalledTimes(4)
    expect(io.upload.mock.calls[2][1]).toBe("synthetic-card-2")
    expect(cloud.getState().lastResult?.skippedUnchanged).toBe(0)
  })
  it("同账号更换存储目标不能沿用旧目标成功清单", async () => {
    login(1); await cloud.getState().runBackup(); io.relay = "https://storage-b.test"
    await cloud.getState().runBackup(); expect(io.upload).toHaveBeenCalledTimes(4)
  })
  it("相同数字ID在不同账号服务中也独立", async () => {
    login(1); await cloud.getState().runBackup(); login(1, "https://identity-b.test")
    await cloud.getState().runBackup(); expect(io.upload).toHaveBeenCalledTimes(4)
  })
  it("自动备份偏好和失败记录按账号保留，切换不继承", () => {
    login(1); cloud.getState().setAutoEnabled(true); writeFailedUploads("same-project", [{ path: "a.md", message: "合成失败" }])
    login(2); expect(cloud.getState().autoEnabled).toBe(false); expect(readFailedUploads("same-project")).toEqual([])
    cloud.getState().setAutoEnabled(false); login(1)
    expect(cloud.getState().autoEnabled).toBe(true); expect(readFailedUploads("same-project")).toHaveLength(1)
  })
  it("退出清除结果和偏好展示，旧任务不得继续第二个上传", async () => {
    login(1)
    let finish!: () => void
    io.upload.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const pending = cloud.getState().runBackup()
    await vi.waitFor(() => expect(io.upload).toHaveBeenCalledTimes(1))
    useAccountStore.setState({ user: null, session: null }); finish(); await pending
    expect(io.upload).toHaveBeenCalledTimes(1); expect(cloud.getState().lastResult).toBeNull()
    expect(cloud.getState().running).toBe(false); expect(cloud.getState().autoEnabled).toBe(false)
  })
  it("恢复下载期间切换账号，不写入旧账号文件及反馈", async () => {
    login(1); io.download.mockImplementationOnce(async () => { login(2); return "旧账号内容" })
    await cloud.getState().runRestore()
    expect(io.create).not.toHaveBeenCalled(); expect(cloud.getState().lastRestore).toBeNull()
    expect(cloud.getState().lastRestoreError).toBeNull(); expect(cloud.getState().running).toBe(false)
  })
  it("恢复下载期间切换作品，不继续旧作品写入", async () => {
    login(1); io.download.mockImplementationOnce(async () => {
      useWikiStore.setState({ project: { path: "C:/other", id: "other", name: "其他作品" } }); return "旧作品内容"
    })
    await cloud.getState().runRestore()
    expect(io.create).not.toHaveBeenCalled(); expect(cloud.getState().lastRestore).toBeNull()
  })
  it("旧上传晚返回不能抹掉新账号已经完成的结果", async () => {
    login(1); let finish!: () => void
    io.upload.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const old = cloud.getState().runBackup()
    await vi.waitFor(() => expect(io.upload).toHaveBeenCalledTimes(1))
    login(2); await cloud.getState().runBackup()
    const current = cloud.getState().lastResult; finish(); await old
    expect(io.upload).toHaveBeenCalledTimes(3)
    expect(cloud.getState().lastResult).toBe(current)
    expect(cloud.getState().backupContext?.owner).toBe(JSON.stringify(["https://identity-a.test", 2]))
  })
  it("同账号按内容增量，恢复后重新核对，缓存不含凭据", async () => {
    login(1); await cloud.getState().runBackup(); await cloud.getState().runBackup()
    expect(io.upload).toHaveBeenCalledTimes(2)
    login(2); await cloud.getState().runBackup(); expect(io.upload).toHaveBeenCalledTimes(4)
    login(1); await cloud.getState().runRestore(); await cloud.getState().runBackup()
    expect(io.upload).toHaveBeenCalledTimes(4)
    login(2); await cloud.getState().runBackup(); expect(io.upload).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(localStorage)).not.toContain("synthetic-card")
    expect(JSON.stringify(localStorage)).not.toContain("synthetic-access")
    expect(JSON.stringify(localStorage)).not.toContain("synthetic-refresh")
  })
})
