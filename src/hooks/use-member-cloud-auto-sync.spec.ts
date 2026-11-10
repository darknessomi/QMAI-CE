// @vitest-environment jsdom
import React, { act } from "react"
import ReactDOM from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 自动同步接线。
 *
 * ## 这几条为什么必须钉住
 *
 * 自动同步是「用户看不见的行为」，出错的两种方式都很伤：
 *   · **太频繁**：每打几个字就传一次整个工程 → 服务器被打爆、用户流量被吃
 *   · **该传不传**：开关开着却不动 → 用户以为备份了，实际没有
 *
 * 所以这里用假定时器精确验证「落盘 → 防抖 → 传一次」的时序，
 * 而不是靠真实等待（那样既慢又不稳）。
 */

const state = vi.hoisted(() => ({
  owner: 1,
  autoEnabled: false,
  runBackup: vi.fn(async () => true),
}))

const signal = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  return {
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    fire: () => {
      for (const fn of [...listeners]) fn()
    },
    clear: () => listeners.clear(),
    size: () => listeners.size,
  }
})

vi.mock("@/lib/platform", () => ({ isTauri: () => true }))
vi.mock("@/stores/account-store", () => ({ useAccountStore: (selector: (s: unknown) => unknown) => selector({ session: { baseUrl: "https://synthetic.test", user: { id: state.owner } } }) }))
vi.mock("@/stores/wiki-store", () => ({ useWikiStore: (selector: (s: unknown) => unknown) => selector({ project: { path: "C:/synthetic" } }) }))

/*
 * 会员云空间 2026-11-09 起是会员专属：hook 里 `if (!isMember) return`，
 * 非会员根本不订阅落盘信号。这个 spec 测的是「订阅之后」的行为，
 * 所以固定成会员态；非会员的行为另有专门用例。
 */
const membership = vi.hoisted(() => ({ active: true }))
vi.mock("@/lib/membership/use-membership", () => ({
  useMembership: () => ({ active: membership.active }),
}))

vi.mock("@/lib/cloud-sync/scheduler", () => ({ SAVE_DEBOUNCE_MS: 8000 }))

vi.mock("@/lib/cloud-sync/save-signal", () => ({
  subscribeProjectSaved: (fn: () => void) => signal.subscribe(fn),
}))

vi.mock("@/stores/member-cloud-store", () => ({
  useMemberCloudStore: {
    getState: () => ({ autoEnabled: state.autoEnabled, runBackup: state.runBackup }),
  },
}))

import { useMemberCloudAutoSync } from "./use-member-cloud-auto-sync"

function Harness() {
  useMemberCloudAutoSync()
  return null
}

let container: HTMLDivElement
let root: ReactDOM.Root | null = null

async function mount(): Promise<void> {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = ReactDOM.createRoot(container)
  await act(async () => {
    root!.render(React.createElement(Harness))
  })
}

async function unmount(): Promise<void> {
  if (root) {
    await act(async () => {
      root!.unmount()
    })
    root = null
  }
  container?.remove()
}

beforeEach(() => {
  vi.useFakeTimers()
  state.autoEnabled = false
  state.runBackup.mockClear()
  signal.clear()
})

afterEach(async () => {
  await unmount()
  vi.useRealTimers()
})

describe("useMemberCloudAutoSync", () => {
  it("开关关闭时不触发（哪怕一直在保存）", async () => {
    state.autoEnabled = false
    await mount()

    act(() => signal.fire())
    await act(async () => {
      vi.advanceTimersByTime(8000)
    })

    expect(state.runBackup).not.toHaveBeenCalled()
  })

  it("开关开启时，落盘 8 秒后触发一次", async () => {
    state.autoEnabled = true
    await mount()

    act(() => signal.fire())
    await act(async () => {
      vi.advanceTimersByTime(7999)
    })
    expect(state.runBackup).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(state.runBackup).toHaveBeenCalledTimes(1)
  })

  it("连续落盘只传一次（防抖：不能每打几个字就传整个工程）", async () => {
    state.autoEnabled = true
    await mount()

    // 模拟连续编辑：每 2 秒保存一次，共 5 次
    for (let i = 0; i < 5; i++) {
      act(() => signal.fire())
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
    }
    expect(state.runBackup).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(8000)
    })
    expect(state.runBackup).toHaveBeenCalledTimes(1)
  })

  it("防抖期间关掉开关 → 到点也不传", async () => {
    state.autoEnabled = true
    await mount()

    act(() => signal.fire())
    // 用户在 8 秒内把自动同步关了
    state.autoEnabled = false
    await act(async () => {
      vi.advanceTimersByTime(8000)
    })

    expect(state.runBackup).not.toHaveBeenCalled()
  })

  it("卸载后不再触发（避免离开设置页后还在后台传）", async () => {
    state.autoEnabled = true
    await mount()

    act(() => signal.fire())
    await unmount()
    await act(async () => {
      vi.advanceTimersByTime(8000)
    })

    expect(state.runBackup).not.toHaveBeenCalled()
    expect(signal.size()).toBe(0)
  })
describe("会员专属（2026-11-09）", () => {
    it("非会员不订阅落盘信号，保存后不触发备份", async () => {
      membership.active = false
      try {
        await mount()
        // 非会员根本不订阅：信号表里一个订阅者都没有
        expect(signal.size()).toBe(0)

        act(() => signal.fire())
        await act(async () => {
          vi.advanceTimersByTime(8000)
        })

        expect(state.runBackup).not.toHaveBeenCalled()
      } finally {
        membership.active = true
      }
    })
  })
})

describe("自动备份的账号切换", () => {
  it("旧账号保存触发的计时器不在新账号执行", async () => {
    state.owner = 1; state.autoEnabled = true
    await mount(); act(() => signal.fire())
    state.owner = 2
    await act(async () => root!.render(React.createElement(Harness)))
    await act(async () => { vi.advanceTimersByTime(8000) })
    expect(state.runBackup).not.toHaveBeenCalled()
    act(() => signal.fire())
    await act(async () => { vi.advanceTimersByTime(8000) })
    expect(state.runBackup).toHaveBeenCalledTimes(1)
  })
})
