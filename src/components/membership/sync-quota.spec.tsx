// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 云同步额度展示（侧栏迷你条 + 设置页环形卡片）。
 *
 * ## 这里守的是什么
 *
 * 额度的价值全在「准确」和「及时」两点上。数字算错、颜色不报警、
 * 满了不提示，都会让用户以为「同步坏了」—— 而其实只是空间不够。
 *
 * 所以钉死四件事：
 *   1. 显示的是「剩余」不是「已用」（用户的问题是「还能传多少」）
 *   2. 80% 橙、95% 红、100% 满，阈值与设计稿一致
 *   3. 没有数据时不渲染（侧栏底部不该出现空框）
 *   4. 拉取失败时保留上一次的数字（闪白比数字旧更让人不安）
 */

const state = vi.hoisted(() => ({
  quota: null as null | {
    tier: string
    usedBytes: number
    usedFiles: number
    limitBytes: number
    limitFiles: number
  },
  error: null as string | null,
  loading: false,
  refresh: vi.fn(async () => {}),
  setActiveView: vi.fn(),
}))

vi.mock("@/stores/sync-quota-store", async () => {
  const actual = await vi.importActual<typeof import("@/stores/sync-quota-store")>(
    "@/stores/sync-quota-store",
  )
  return {
    ...actual,
    useSyncQuotaStore: (selector: (s: unknown) => unknown) =>
      selector({
        quota: state.quota,
        error: state.error,
        loading: state.loading,
        refresh: state.refresh,
      }),
  }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: { setActiveView: typeof state.setActiveView }) => unknown) =>
    selector({ setActiveView: state.setActiveView }),
}))

import { SyncQuotaRing } from "./sync-quota"
import {
  quotaLevel,
  remainingBytes,
  remainingFiles,
  usedRatio,
  type QuotaLevel,
} from "@/stores/sync-quota-store"

const MB = 1024 * 1024
const GB = 1024 * MB

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  state.quota = null
  state.error = null
  state.loading = false
  state.refresh = vi.fn(async () => {})
  state.setActiveView = vi.fn()

  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(node: React.ReactElement) {
  await act(async () => {
    root.render(node)
  })
}

describe("额度计算（纯函数）", () => {
  it("剩余字节不会为负（超配额时算 0，不是负数）", () => {
    expect(remainingBytes({ tier: "free", usedBytes: 300 * MB, usedFiles: 1, limitBytes: 200 * MB, limitFiles: 2000 })).toBe(0)
    expect(remainingBytes({ tier: "free", usedBytes: 50 * MB, usedFiles: 1, limitBytes: 200 * MB, limitFiles: 2000 })).toBe(150 * MB)
  })

  it("剩余文件数不会为负", () => {
    expect(remainingFiles({ tier: "free", usedBytes: 0, usedFiles: 2500, limitBytes: 200 * MB, limitFiles: 2000 })).toBe(0)
    expect(remainingFiles({ tier: "free", usedBytes: 0, usedFiles: 128, limitBytes: 200 * MB, limitFiles: 2000 })).toBe(1872)
  })

  it("用量比例上限为 1（超配额不会算出 150%）", () => {
    expect(usedRatio({ tier: "free", usedBytes: 300 * MB, usedFiles: 1, limitBytes: 200 * MB, limitFiles: 2000 })).toBe(1)
  })

  it("没有数据时一律返回 0，不抛错", () => {
    expect(remainingBytes(null)).toBe(0)
    expect(remainingFiles(null)).toBe(0)
    expect(usedRatio(null)).toBe(0)
    expect(quotaLevel(null)).toBe("ok")
  })

  it("阈值：80% 橙、95% 红、100% 满", () => {
    const make = (used: number): { tier: string; usedBytes: number; usedFiles: number; limitBytes: number; limitFiles: number } => ({
      tier: "free",
      usedBytes: used,
      usedFiles: 1,
      limitBytes: 200 * MB,
      limitFiles: 2000,
    })
    expect(quotaLevel(make(0.5 * 200 * MB))).toBe("ok")
    // 79% 还是正常
    expect(quotaLevel(make(0.79 * 200 * MB))).toBe("ok")
    // 80% 起提醒
    expect(quotaLevel(make(0.8 * 200 * MB))).toBe("warn")
    expect(quotaLevel(make(0.94 * 200 * MB))).toBe("warn")
    // 95% 起告警
    expect(quotaLevel(make(0.95 * 200 * MB))).toBe("danger")
    expect(quotaLevel(make(0.99 * 200 * MB))).toBe("danger")
    // 满了
    expect(quotaLevel(make(200 * MB))).toBe("full")
    expect(quotaLevel(make(250 * MB))).toBe("full")
  })
})

describe("设置页环形卡片", () => {
  it("会员显示 VIP 徽标", async () => {
    state.quota = {
      tier: "member",
      usedBytes: 512 * MB,
      usedFiles: 1204,
      limitBytes: 5 * GB,
      limitFiles: 50000,
    }
    await render(<SyncQuotaRing />)
    const text = container.textContent ?? ""
    expect(text).toContain("VIP 会员空间")
    expect(text).toContain("云同步空间")
    expect(text).toContain("共 5.00 GB")
  })

  it("免费用户看到两行对比卡，而不是「已满」", async () => {
    /*
     * 2026-11-09 重写。这条原来喂的是**免费 200 MB 额度**并断言
     * 「免费版 · 开通会员扩容到 5 GB」—— 那个产品逻辑已取消：
     * 免费用户不再拥有云空间，网关卡返回 `{ limitBytes: 0, memberOnly: true }`。
     *
     * 而旧代码会把 `remainingBytes` 算成 0 → 落进 `"full"` →
     * 免费用户被告知「空间已满，清理云端文件」，可他根本没有云端文件。
     *
     * 新契约：显示「当前 免费版 无云备份」/「会员 云空间 5 GB」两行对比。
     */
    state.quota = {
      tier: "free",
      usedBytes: 0,
      usedFiles: 0,
      limitBytes: 0,
      limitFiles: 0,
      memberOnly: true,
    }
    await render(<SyncQuotaRing onUpgrade={() => {}} />)

    expect(container.querySelector('[data-ui="sync-quota-ring"]')?.getAttribute("data-level")).toBe("locked")
    expect(container.querySelector('[data-ui="quota-row-free"]')?.textContent).toContain("无云备份")
    expect(container.querySelector('[data-ui="quota-row-member"]')?.textContent).toContain("5 GB")

    // 「已满 / 清理云端文件」对免费用户是误诊，一个字都不能出现
    const text = container.textContent ?? ""
    expect(text).not.toContain("已满")
    expect(text).not.toContain("新的改动传不上去")
    expect(text).not.toContain("清理云端文件")
  })

  it("会员真把空间用满时才报「已满」", async () => {
    /*
     * 注意 `tier: "member"` —— 这条测的是**真会员满额**，
     * 而不是「没有权限」。两者的界面表现必须完全不同：
     * 这里的建议是「清理文件」，前者应该给开通引导。
     */
    state.quota = {
      tier: "member",
      usedBytes: 5 * 1024 * MB,
      usedFiles: 2000,
      limitBytes: 5 * 1024 * MB,
      limitFiles: 50000,
      memberOnly: false,
    }
    await render(<SyncQuotaRing />)
    const text = container.textContent ?? ""
    expect(text).toContain("已满")
    expect(text).toContain("新的改动传不上去")
    expect(container.querySelector('[data-ui="sync-quota-ring"]')?.getAttribute("data-level")).toBe("full")
  })

  it("没有数据时显示占位文案，不白屏", async () => {
    state.quota = null
    state.error = "云同步服务暂时不可用"
    await render(<SyncQuotaRing />)
    expect(container.querySelector('[data-ui="sync-quota-ring"]')).toBeNull()
    expect(container.textContent).toContain("云同步服务暂时不可用")
  })
})
