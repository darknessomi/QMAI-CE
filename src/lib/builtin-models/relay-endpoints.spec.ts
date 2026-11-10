/**
 * 网关双通道选路。
 *
 * ## 为什么这件事值得单独测
 *
 * 家庭网关跑在一台普通 PC 上，断电/重启/家宽抖动都会让它短暂不可用。
 * 选路一旦出错，后果是**所有用户的 AI 写作同时停摆** —— 而且是那种
 * 「看起来像软件坏了」的停摆，用户不会知道是我们的网关挂了。
 *
 * 所以这几条必须钉死：
 *   · 家庭网关健康 → 一定选它（不限请求数）
 *   · 家庭网关挂了 → 退回 Cloudflare，而不是直接报错
 *   · 两个都挂 → 退到 Cloudflare 兜底地址，仍然给用户一个能打的地址
 *   · 缓存 5 分钟 → 不能每个请求都探测
 *   · 请求失败要能作废缓存 → 否则缓存期内会一直打一个死地址
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  FALLBACK_RELAY_URL,
  RELAY_ENDPOINTS,
  __enableRealResolutionForTest,
  __setProbeForTest,
  currentRelaySelection,
  invalidateRelayCache,
  reportRelayFailure,
  resolveSyncBaseUrl,
  resolveRelayBaseUrl,
} from "./relay-endpoints"

const HOME = "https://relay-home.qmai.work"
const CLOUD = "https://relay.qmai.work"

/** 按地址表决定哪些端点「健康」 */
function probeReturning(healthy: string[]) {
  return vi.fn(async (url: string) => healthy.includes(url))
}

beforeEach(() => {
  __enableRealResolutionForTest()
  invalidateRelayCache()
})

afterEach(() => {
  __setProbeForTest(null)
  invalidateRelayCache()
})

describe("端点清单", () => {
  it("主通道是家庭网关，备用是 Cloudflare", () => {
    expect(RELAY_ENDPOINTS[0]).toEqual({ name: "home", url: HOME })
    expect(RELAY_ENDPOINTS[1]).toEqual({ name: "cloud", url: CLOUD })
  })

  it("兜底地址是 Cloudflare（可用性更高）", () => {
    expect(FALLBACK_RELAY_URL).toBe(CLOUD)
  })
})

describe("选路决策", () => {
  it("家庭网关健康 → 选家庭网关", async () => {
    const probe = probeReturning([HOME, CLOUD])
    __setProbeForTest(probe)

    await expect(resolveRelayBaseUrl()).resolves.toBe(HOME)
    expect(currentRelaySelection()?.name).toBe("home")
    // 只探了第一个就返回，不该继续探 Cloudflare
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it("家庭网关挂了 → 退回 Cloudflare", async () => {
    __setProbeForTest(probeReturning([CLOUD]))

    await expect(resolveRelayBaseUrl()).resolves.toBe(CLOUD)
    expect(currentRelaySelection()?.name).toBe("cloud")
  })

  it("两个都挂 → 仍然返回 Cloudflare 兜底地址", async () => {
    __setProbeForTest(probeReturning([]))

    await expect(resolveRelayBaseUrl()).resolves.toBe(FALLBACK_RELAY_URL)
    expect(currentRelaySelection()?.name).toBe("fallback")
  })

  it("探测抛异常按「不可用」处理，不能把整个流程带崩", async () => {
    __setProbeForTest(async (url: string) => {
      if (url === HOME) throw new Error("network down")
      return true
    })

    await expect(resolveRelayBaseUrl()).resolves.toBe(CLOUD)
  })
})

describe("缓存", () => {
  it("第二次调用不再探测", async () => {
    const probe = probeReturning([HOME])
    __setProbeForTest(probe)

    await resolveRelayBaseUrl()
    await resolveRelayBaseUrl()

    expect(probe).toHaveBeenCalledTimes(1)
  })

  it("force 会强制重新探测", async () => {
    const probe = probeReturning([HOME])
    __setProbeForTest(probe)

    await resolveRelayBaseUrl()
    await resolveRelayBaseUrl({ force: true })

    expect(probe).toHaveBeenCalledTimes(2)
  })

  it("invalidateRelayCache 之后会重新探测（这是失败切换的关键）", async () => {
    __setProbeForTest(probeReturning([HOME]))
    await expect(resolveRelayBaseUrl()).resolves.toBe(HOME)

    // 家庭网关断了
    __setProbeForTest(probeReturning([CLOUD]))
    invalidateRelayCache()

    await expect(resolveRelayBaseUrl()).resolves.toBe(CLOUD)
  })

  it("不作废缓存时会继续用旧结果（说明作废是必要的）", async () => {
    __setProbeForTest(probeReturning([HOME]))
    await resolveRelayBaseUrl()

    // 网关断了，但没作废缓存
    __setProbeForTest(probeReturning([CLOUD]))

    await expect(resolveRelayBaseUrl()).resolves.toBe(HOME)
  })
})

describe("请求失败上报", () => {
  it("失败地址与当前选中一致时作废缓存", async () => {
    __setProbeForTest(probeReturning([HOME]))
    expect(await resolveRelayBaseUrl()).toBe(HOME)

    reportRelayFailure(HOME)
    expect(currentRelaySelection()).toBeNull()
  })

  it("失败地址与当前选中不一致时不动缓存（避免并发请求互相冲掉）", async () => {
    __setProbeForTest(probeReturning([HOME]))
    expect(await resolveRelayBaseUrl()).toBe(HOME)

    // 一个打到备通道的老请求失败了，不能把「当前选主通道」这个结论冲掉
    reportRelayFailure(CLOUD)
    expect(currentRelaySelection()?.url).toBe(HOME)
  })

  it("容忍结尾斜杠与大小写的差异", async () => {
    __setProbeForTest(probeReturning([HOME]))
    expect(await resolveRelayBaseUrl()).toBe(HOME)

    reportRelayFailure(`${HOME}/`)
    expect(currentRelaySelection()).toBeNull()
  })

  it("空地址不产生副作用", async () => {
    __setProbeForTest(probeReturning([HOME]))
    expect(await resolveRelayBaseUrl()).toBe(HOME)

    reportRelayFailure("")
    reportRelayFailure(null)
    reportRelayFailure(undefined)
    expect(currentRelaySelection()?.url).toBe(HOME)
  })
})

describe("缓存期内的被动健康校验", () => {
  it("选定地址后 60 秒内不再补探", async () => {
    const probe = probeReturning([HOME])
    __setProbeForTest(probe)
    await resolveRelayBaseUrl()
    const first = probe.mock.calls.length

    // 立刻再调一次：缓存命中，且刚校验过 → 不应新增探测
    await resolveRelayBaseUrl()
    expect(probe.mock.calls.length).toBe(first)
  })

  it("超过 60 秒后补探失败会作废缓存，下次走备通道", async () => {
    const now = Date.now()
    const spy = vi.spyOn(Date, "now").mockReturnValue(now)

    let homeHealthy = true
    __setProbeForTest(vi.fn(async (url: string) => (url === HOME ? homeHealthy : true)))

    expect(await resolveRelayBaseUrl()).toBe(HOME)

    // 快进 61 秒，并让家庭网关挂掉
    spy.mockReturnValue(now + 61_000)
    homeHealthy = false

    // 这次调用仍返回缓存值（不增加延迟）
    expect(await resolveRelayBaseUrl()).toBe(HOME)

    // 等待后台探测完成
    await vi.waitFor(() => {
      expect(currentRelaySelection()).toBeNull()
    })

    // 下一次调用就会重新探测并选到备通道
    expect(await resolveRelayBaseUrl()).toBe(CLOUD)
    spy.mockRestore()
  })
})
describe("同步专用选路（不允许退回 Worker）", () => {
  it("家庭网关可用时返回家庭网关", async () => {
    __setProbeForTest(probeReturning([HOME, CLOUD]))
    expect(await resolveSyncBaseUrl()).toBe(HOME)
  })

  it("家庭网关不可用时抛错，而不是退回没有同步接口的 Worker", async () => {
    // 只有 cloud 健康 —— 通用选路会退到 cloud，但同步不能这么做
    __setProbeForTest(probeReturning([CLOUD]))
    await expect(resolveSyncBaseUrl()).rejects.toThrow(/云同步服务暂时不可用/)
  })

  it("两个都不可用时同样抛错", async () => {
    __setProbeForTest(probeReturning([]))
    await expect(resolveSyncBaseUrl()).rejects.toThrow(/云同步服务暂时不可用/)
  })

  it("错误信息要说人话，不能出现 404 / 接口不存在", async () => {
    __setProbeForTest(probeReturning([]))
    try {
      await resolveSyncBaseUrl()
      throw new Error("应当抛错")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      expect(msg).not.toContain("404")
      expect(msg).not.toContain("接口不存在")
      expect(msg).toContain("请稍后重试")
    }
  })

  it("已选中家庭网关时走缓存，不再重复探测", async () => {
    const probe = probeReturning([HOME])
    __setProbeForTest(probe)
    await resolveSyncBaseUrl()
    const first = probe.mock.calls.length
    await resolveSyncBaseUrl()
    expect(probe.mock.calls.length).toBe(first)
  })
})