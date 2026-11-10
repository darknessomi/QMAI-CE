// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { backupProject, type BackupOutcome } from "@/lib/qmai-sync/backup"
import { restoreProject } from "@/lib/qmai-sync/restore"
import { useAccountStore } from "./account-store"
import { useWikiStore } from "./wiki-store"
import { useMemberCloudStore as cloud } from "./member-cloud-store"

vi.mock("@/lib/qmai-sync/backup", () => ({ backupProject: vi.fn() }))
vi.mock("@/lib/qmai-sync/restore", () => ({ restoreProject: vi.fn() }))
vi.mock("@/lib/project-identity", () => ({ ensureProjectId: vi.fn(async () => "sample-project") }))
vi.mock("@/lib/builtin-models/relay-endpoints", async original => ({ ...await original<typeof import("@/lib/builtin-models/relay-endpoints")>(), resolveSyncBaseUrl: vi.fn(async () => "https://example.test") }))

const result: BackupOutcome = { uploaded: 2, skippedUnchanged: 0, failed: [], totalBytes: 20, skipped: 0, truncated: false, binarySkipped: [], manifest: {} }
beforeEach(() => {
  localStorage.clear(); vi.resetAllMocks(); cloud.setState(cloud.getInitialState(), true)
  const user = { id: 1, email: "test@example.test", displayName: "测试账号", createdAt: 1, avatarUpdatedAt: null, displayNameUpdatedAt: null,
    membership: { active: true, expiresAt: Date.now() / 1000 + 86400, remainingDays: 1, planLabel: "月卡", forever: false } }
  useAccountStore.setState({ user, session: { user, baseUrl: "https://example.test", netcard: "test-only", accessToken: "test-only", accessExpiresAt: 9999999999, refreshToken: "test-only", refreshExpiresAt: 9999999999, savedAt: 1 } })
  useWikiStore.setState({ project: { path: "C:/sample" } as NonNullable<ReturnType<typeof useWikiStore.getState>["project"]> })
  vi.mocked(backupProject).mockResolvedValue(result)
  vi.mocked(restoreProject).mockResolvedValue({ restored: 2, skippedNewer: 0, failed: [], totalBytes: 20, remoteTotal: 2 })
})

describe("会员中心的备份反馈来源", () => {
  it("备份记录账号和作品，完成后提供独立的备份时间", async () => {
    await cloud.getState().runBackup()
    expect(cloud.getState().backupContext).toEqual({ owner: JSON.stringify(["https://example.test", 1]), projectPath: "C:/sample" })
    expect(cloud.getState().lastBackupAt).toEqual(expect.any(Number))
    expect(cloud.getState().operation).toBeNull()
    expect(cloud.getState().lastResult).toEqual(result)
  })
  it("从云端恢复不改写备份时间和结果", async () => {
    await cloud.getState().runBackup()
    const before = cloud.getState().lastBackupAt
    let resolve!: (value: Awaited<ReturnType<typeof restoreProject>>) => void
    vi.mocked(restoreProject).mockReturnValueOnce(new Promise(r => { resolve = r }))
    const pending = cloud.getState().runRestore()
    await Promise.resolve(); await Promise.resolve()
    expect(cloud.getState().operation).toBe("restore")
    resolve({ restored: 2, skippedNewer: 0, failed: [], totalBytes: 20, remoteTotal: 2 }); await pending
    expect(cloud.getState().lastBackupAt).toBe(before)
    expect(cloud.getState().lastResult).toEqual(result)
  })
  it("备份失败保留失败原因，不沿用上一次成功结果", async () => {
    await cloud.getState().runBackup()
    vi.mocked(backupProject).mockRejectedValueOnce(new Error("测试网络失败"))
    await cloud.getState().runBackup()
    expect(cloud.getState().lastError).toBe("测试网络失败")
    expect(cloud.getState().lastResult).toBeNull()
    expect(cloud.getState().operation).toBeNull()
  })
})
