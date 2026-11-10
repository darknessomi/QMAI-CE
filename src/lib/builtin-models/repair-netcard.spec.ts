// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 「会员兑换后补签网关卡」的客户端侧。
 *
 * 这条路径存在的原因：网关卡只在登录时签发。用户兑换激活码那一刻手上没有卡，
 * 而内置模型每次调用都要带卡。让用户重新登录是 2026-11-06 被明确否掉的体验，
 * 所以兑换成功后由这里当场补签。
 *
 * 钉住四件事：
 *   1. 先打的是 `/v1/netcard/refresh`（不是老补票入口），且只发 refreshToken + 设备字段；
 *   2. 拿到卡后**写回会话**，并顺手把内置模型登记进 provider 配置；
 *   3. 服务端说不是会员时返回 false，且**不写会话**（防止把空卡写进去）；
 *   4. 网络异常不抛（兑换已经成功了，补签失败不该让用户以为兑换失败）。
 */

const gateway = vi.hoisted(() => ({ gatewayListModelCatalog: vi.fn() }))
const bridge = vi.hoisted(() => ({ applyBuiltinModels: vi.fn() }))
const projectStore = vi.hoisted(() => ({ saveProviderConfigs: vi.fn(async () => {}) }))
const fetchMock = vi.hoisted(() => vi.fn())
const device = vi.hoisted(() => ({ getDeviceFingerprint: vi.fn(async () => "a".repeat(32)) }))
const sign = vi.hoisted(() => ({ ensureDeviceKey: vi.fn(async () => ({ publicKey: "b".repeat(43) })) }))
const store = vi.hoisted(() => ({ state: { session: null as unknown, replaceSession: vi.fn() } }))
const sessionIo = vi.hoisted(() => ({ saveAccountSession: vi.fn() }))

vi.mock("@/lib/tauri-fetch", () => ({ getHttpFetch: async () => fetchMock }))
vi.mock("@/lib/account/device", () => device)
vi.mock("@/lib/account/request-sign", () => sign)
vi.mock("@/lib/account/session", () => sessionIo)
vi.mock("@/lib/project-store", () => projectStore)
vi.mock("@/stores/account-store", () => ({
  useAccountStore: {
    getState: () => ({ session: store.state.session, replaceSession: store.state.replaceSession }),
  },
}))

vi.mock("@/lib/builtin-models/gateway-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/builtin-models/gateway-api")>(
    "@/lib/builtin-models/gateway-api",
  )
  return { ...actual, gatewayListModelCatalog: gateway.gatewayListModelCatalog }
})
vi.mock("@/lib/builtin-models/provider-bridge", async () => {
  const actual = await vi.importActual<typeof import("@/lib/builtin-models/provider-bridge")>(
    "@/lib/builtin-models/provider-bridge",
  )
  return { ...actual, applyBuiltinModels: bridge.applyBuiltinModels }
})

const { repairNetcardAfterMembershipChange, resetBuiltinSyncState } = await import(
  "@/lib/builtin-models/auto-sync"
)
const { NETCARD_REFRESH_PATH } = await import("@/lib/builtin-models/netcard")

function session(netcard: string | null = null) {
  return {
    baseUrl: "https://account.qmai.pro",
    accessToken: "access",
    accessExpiresAt: Math.floor(Date.now() / 1000) + 900,
    refreshToken: "r".repeat(43),
    refreshExpiresAt: Math.floor(Date.now() / 1000) + 86400,
    netcard,
    user: { id: 9, email: "a@b.c", displayName: "Moc" },
    savedAt: Math.floor(Date.now() / 1000),
  }
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

beforeEach(() => {
  resetBuiltinSyncState()
  fetchMock.mockReset()
  gateway.gatewayListModelCatalog.mockReset()
  gateway.gatewayListModelCatalog.mockResolvedValue([{ id: "qmai-standard", ratio: 1 }])
  bridge.applyBuiltinModels.mockReset()
  bridge.applyBuiltinModels.mockResolvedValue({ modelKey: "qmai-builtin/qmai-standard", modelCount: 1 })
  sessionIo.saveAccountSession.mockClear()
  store.state.replaceSession.mockClear()
  store.state.session = null
})

describe("repairNetcardAfterMembershipChange", () => {
  it("没有会话：直接返回 false，不发请求", async () => {
    await expect(repairNetcardAfterMembershipChange(null)).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("打到补签端点，只发 refreshToken 与设备字段（不把 accessToken 当卡用）", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { netcard: "new-card" } }))

    await repairNetcardAfterMembershipChange(session() as never)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://account.qmai.pro${NETCARD_REFRESH_PATH}`)
    expect(init.method).toBe("POST")
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      refreshToken: "r".repeat(43),
      deviceHash: "a".repeat(32),
      devicePublicKey: "b".repeat(43),
    })
  })

  it("拿到卡后写回会话，并重新登记内置模型（兑换完就能在下拉框里看到）", async () => {
    store.state.session = session()
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { netcard: "new-card" } }))
    /*
     * 补签结束后会再走一次 `syncBuiltinModels`，它会确认「会话里有卡」并去拉清单。
     * 真实实现里 `saveAccountSession` + `replaceSession` 就是把卡写回会话，
     * 所以这里让 replaceSession 同步更新夹具，模拟那条链路的真实效果；
     * 否则 syncBuiltinModels 读到的还是旧会话（没卡），拉不到清单。
     */
    store.state.replaceSession.mockImplementation((next: { netcard: string }) => {
      store.state.session = next
    })

    await expect(repairNetcardAfterMembershipChange(store.state.session as never)).resolves.toBe(true)

    // 会话里必须有新卡，否则下一次同步又会认为「没卡」
    expect(sessionIo.saveAccountSession).toHaveBeenCalledTimes(1)
    expect((sessionIo.saveAccountSession.mock.calls[0][0] as { netcard: string }).netcard).toBe("new-card")
    expect(store.state.replaceSession).toHaveBeenCalledTimes(1)
    // 顺手把清单登记进 provider 配置
    expect(gateway.gatewayListModelCatalog).toHaveBeenCalled()
    expect(bridge.applyBuiltinModels).toHaveBeenCalled()
  })

  it("服务端说不是会员（503）：返回 false，且绝不写会话", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, code: "MEMBERSHIP_UNAVAILABLE" }, 503),
    )

    await expect(repairNetcardAfterMembershipChange(session() as never)).resolves.toBe(false)
    expect(sessionIo.saveAccountSession).not.toHaveBeenCalled()
    expect(store.state.replaceSession).not.toHaveBeenCalled()
  })

  it("网络异常：返回 false 而不抛（兑换已经成功，不能让它看起来失败）", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"))

    await expect(repairNetcardAfterMembershipChange(session() as never)).resolves.toBe(false)
    expect(sessionIo.saveAccountSession).not.toHaveBeenCalled()
  })

  it("响应里没有卡：返回 false，不写空卡", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { netcard: null } }))

    await expect(repairNetcardAfterMembershipChange(session() as never)).resolves.toBe(false)
    expect(sessionIo.saveAccountSession).not.toHaveBeenCalled()
  })
})
