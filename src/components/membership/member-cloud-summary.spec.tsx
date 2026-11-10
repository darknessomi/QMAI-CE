// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useAccountStore } from "@/stores/account-store"
import { useMemberCloudStore } from "@/stores/member-cloud-store"
import { useWikiStore } from "@/stores/wiki-store"
import { MemberCloudSummary } from "./member-cloud-summary"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
beforeEach(() => {
  useMemberCloudStore.setState(useMemberCloudStore.getInitialState(), true)
  const user = { id: 1, email: "test@example.test", displayName: "测试账号", createdAt: 1, avatarUpdatedAt: null, displayNameUpdatedAt: null }
  useAccountStore.setState({ user, session: { user, baseUrl: "https://example.test", accessToken: "test-only", accessExpiresAt: 9999999999, refreshToken: "test-only", refreshExpiresAt: 9999999999, savedAt: 1 } })
  useWikiStore.setState({ project: { path: "C:/sample" } as NonNullable<ReturnType<typeof useWikiStore.getState>["project"]> })
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })
const result = { uploaded: 2, skippedUnchanged: 0, failed: [], totalBytes: 20, skipped: 0, truncated: false, binarySkipped: [], manifest: {} }
const context = { owner: JSON.stringify(["https://example.test", 1]), projectPath: "C:/sample" }
async function mount() { await act(async () => root.render(<MemberCloudSummary onManage={vi.fn()} />)) }

describe("会员中心云备份状态", () => {
  it("自动备份开启不等于已备份成功", async () => {
    useMemberCloudStore.setState({ autoEnabled: true }); await mount()
    expect(host.textContent).toContain("已开启")
    expect(host.textContent).toContain("尚无备份结果")
    expect(host.textContent).not.toContain("备份完成")
  })
  it("区分备份进行中与恢复进行中", async () => {
    useMemberCloudStore.setState({ running: true, operation: "backup", backupContext: context }); await mount()
    expect(host.textContent).toContain("正在备份当前作品")
    await act(async () => useMemberCloudStore.setState({ operation: "restore" }))
    expect(host.textContent).not.toContain("正在备份当前作品")
  })
  it.each(["账号", "作品"])("切换%s不展示另一个上下文的成功记录", async change => {
    useMemberCloudStore.setState({ backupContext: { ...context, ...(change === "账号" ? { owner: "another-account" } : { projectPath: "C:/other" }) }, lastResult: result, lastBackupAt: Date.now() })
    await mount()
    expect(host.textContent).not.toContain("最近备份完成")
  })
  it("部分文件失败与数量截断不显示完整备份成功", async () => {
    useMemberCloudStore.setState({ backupContext: context, lastResult: { ...result, failed: [{ path: "sample.md", message: "测试失败" }] }, lastBackupAt: Date.now() }); await mount()
    expect(host.textContent).toContain("1 个文件未上传")
    await act(async () => useMemberCloudStore.setState({ lastResult: { ...result, truncated: true } }))
    expect(host.textContent).toContain("文件数量上限")
    expect(host.textContent).not.toContain("最近备份完成")
  })
  it("成功结果显示备份时间", async () => {
    useMemberCloudStore.setState({ backupContext: context, lastResult: result, lastBackupAt: Date.now() }); await mount()
    expect(host.textContent).toContain("最近备份完成")
  })
})
