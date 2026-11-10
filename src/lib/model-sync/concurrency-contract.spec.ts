import { expect, it, vi } from "vitest"
import { deleteModelConfig } from "@/lib/account/api"
import { emptySyncState, pullAndMerge, pushLocal, type ModelSyncIo } from "./service"
import { canonicalJson, fingerprint } from "./canonical"
import { decryptModelConfig } from "./crypto"

it("清空请求发送原版本，服务端冲突会传回调用方", async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(init?.method).toBe("DELETE")
    expect(JSON.parse(String(init?.body))).toEqual({ baseVersion: 7 })
    return new Response(JSON.stringify({ success: false, code: "CONFLICT", message: "配置已变化" }), { status: 409 })
  })
  await expect(deleteModelConfig("https://example.test", "synthetic-token", 7, fetcher)).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it("指纹相同不会重复上传，但更换密码可强制写入新密文", async () => {
  const config = { local: { model: "synthetic-model" } }
  let state = { ...emptySyncState(), version: 1, snapshot: { local: fingerprint(canonicalJson(config.local)) } }
  const puts: Array<{ payload: string; baseVersion: number | null }> = []
  const io: ModelSyncIo = {
    now: () => 2, loadState: async () => state, saveState: async next => { state = next as typeof state },
    loadConfigs: async () => config, saveConfigs: vi.fn(), loadSettings: async () => ({}), saveSettings: vi.fn(),
    fetchCloud: async () => ({ kind: "unchanged" }), putCloud: async input => { puts.push(input); return { version: 2, updatedAt: 2 } },
  }
  expect((await pushLocal(io, "synthetic-old-password")).status).toBe("unchanged")
  expect(puts).toHaveLength(0)
  expect((await pushLocal(io, "synthetic-new-password", { force: true })).status).toBe("pushed")
  expect(await decryptModelConfig(puts[0].payload, "synthetic-new-password")).toContain("synthetic-model")
  await expect(decryptModelConfig(puts[0].payload, "synthetic-old-password")).rejects.toThrow()
})

it("云端清空后同步保留本地配置，重建不携带已经失效的旧版本", async () => {
  let state = { ...emptySyncState(), version: 9 }
  const config = { local: { model: "synthetic-model" } }
  const saveConfigs = vi.fn(), putCloud = vi.fn(async () => ({ version: 11, updatedAt: 2 }))
  const io: ModelSyncIo = {
    now: () => 2, loadState: async () => state, saveState: async next => { state = next },
    loadConfigs: async () => config, saveConfigs, loadSettings: async () => ({}), saveSettings: vi.fn(),
    fetchCloud: async () => ({ kind: "none" }), putCloud,
  }
  expect((await pullAndMerge(io, "synthetic-password")).version).toBe(0)
  await pushLocal(io, "synthetic-password")
  expect(putCloud).toHaveBeenCalledWith(expect.objectContaining({ baseVersion: null }))
  expect(saveConfigs).not.toHaveBeenCalled()
  expect(state.version).toBe(11)
})
