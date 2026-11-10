// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), remove: vi.fn(), push: vi.fn(), pull: vi.fn(), invoke: vi.fn(),
  saved: new Map<string, unknown>(),
  session: { baseUrl: "https://example.test", accessToken: "synthetic-token", accessExpiresAt: 9_000_000_000 },
}))
vi.mock("@/lib/account/api", () => ({ fetchModelConfig: mocks.fetch, deleteModelConfig: mocks.remove, putModelConfig: vi.fn() }))
vi.mock("./account-store", () => ({ useAccountStore: { getState: () => ({ session: mocks.session, user: null }) } }))
vi.mock("@/lib/platform", () => ({ isTauri: () => true }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
vi.mock("@/lib/web-store", () => ({ getStore: async () => ({ get: async (key: string) => mocks.saved.get(key), set: async (key: string, value: unknown) => mocks.saved.set(key, value), save: async () => {} }) }))
vi.mock("@/lib/project-store", () => ({ loadProviderConfigs: async () => ({}), loadEmbeddingConfig: async () => ({}), loadRerankConfig: async () => ({}), saveProviderConfigs: vi.fn(), saveEmbeddingConfig: vi.fn(), saveRerankConfig: vi.fn() }))
vi.mock("@/stores/wiki-store", () => ({ useWikiStore: { getState: () => ({ setProviderConfigs: vi.fn() }) } }))
vi.mock("@/lib/model-sync/service", async importOriginal => ({ ...await importOriginal<object>(), pushLocal: mocks.push, pullAndMerge: mocks.pull }))

import { useModelSyncStore } from "./model-sync-store"

beforeEach(() => {
  vi.clearAllMocks(); mocks.saved.clear()
  mocks.invoke.mockImplementation(async (name: string) => name === "secret_get" ? "synthetic-password" : undefined)
  mocks.fetch.mockResolvedValue({ kind: "config", record: { version: 7 } })
  mocks.remove.mockResolvedValue(undefined)
  mocks.pull.mockResolvedValue({ status: "unchanged", pushed: false, version: 7 })
  mocks.push.mockResolvedValue({ status: "conflict", version: 7 })
  useModelSyncStore.setState({ enabled: true, passwordReady: true, busy: false, status: "idle", message: "", version: 7 })
})
afterEach(() => vi.useRealTimers())

it("清空遇到冲突不会清本地密码或假报成功", async () => {
  mocks.remove.mockRejectedValue(Object.assign(new Error("配置已变化"), { code: "CONFLICT" }))
  await expect(useModelSyncStore.getState().disable({ clearCloud: true })).rejects.toMatchObject({ code: "CONFLICT" })
  expect(mocks.remove).toHaveBeenCalledWith("https://example.test", "synthetic-token", 7)
  expect(mocks.invoke.mock.calls.some(([name]) => name === "secret_clear")).toBe(false)
  expect(useModelSyncStore.getState()).toMatchObject({ enabled: true, status: "error", version: 7 })
})
it("清空网络重试使用同一原版本，不重新读取新版本", async () => {
  vi.useFakeTimers()
  mocks.remove.mockRejectedValueOnce(Object.assign(new Error("网络中断"), { code: "NETWORK" })).mockResolvedValue(undefined)
  const result = useModelSyncStore.getState().disable({ clearCloud: true })
  await vi.runAllTimersAsync(); await result
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  expect(mocks.remove.mock.calls.map(call => call[2])).toEqual([7, 7])
  expect(useModelSyncStore.getState()).toMatchObject({ enabled: false, passwordReady: false })
})
it("同步持续冲突必须保留错误状态，不能显示同步完成", async () => {
  await useModelSyncStore.getState().syncNow()
  expect(useModelSyncStore.getState().status).toBe("error")
  expect(useModelSyncStore.getState().message).not.toContain("同步完成")
})
it("更换同步密码发生冲突时保留原密码，不先写新密码", async () => {
  await expect(useModelSyncStore.getState().changePassword("synthetic-old-password", "synthetic-new-password")).rejects.toMatchObject({ code: "CONFLICT" })
  expect(mocks.invoke.mock.calls.some(([name]) => name === "secret_set")).toBe(false)
  expect(useModelSyncStore.getState().status).toBe("error")
})
it("更换密码强制重新加密，成功后才保存本地新密码", async () => {
  mocks.push.mockImplementation(async () => {
    expect(mocks.invoke.mock.calls.some(([name]) => name === "secret_set")).toBe(false)
    return { status: "pushed", version: 8 }
  })
  await useModelSyncStore.getState().changePassword("synthetic-old-password", "synthetic-new-password")
  expect(mocks.push).toHaveBeenCalledWith(expect.anything(), "synthetic-new-password", { force: true })
  expect(mocks.invoke).toHaveBeenCalledWith("secret_set", { name: expect.any(String), value: "synthetic-new-password" })
  expect(useModelSyncStore.getState()).toMatchObject({ status: "idle", version: 8 })
})
it("开启同步发生冲突不能报告已经上传", async () => {
  await expect(useModelSyncStore.getState().enable("synthetic-password")).rejects.toMatchObject({ code: "CONFLICT" })
  expect(useModelSyncStore.getState().status).toBe("error")
})
