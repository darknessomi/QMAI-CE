// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 「会员云空间」面板的渲染契约。
 *
 * ## 这个面板最容易出的四种错
 *
 * 1. **未登录时还显示备份按钮** → 用户点了必然失败，还以为是网络问题
 * 2. **没打开作品时还显示备份按钮** → 同上
 * 3. **配额读不到时白屏** → 用户不知道是「没数据」还是「坏了」
 * 4. **自动同步开关点了没反应** → 用户以为开了，其实每次都得手动点
 *
 * ## 为什么用真实 store 而不是 mock 掉它
 *
 * 面板的状态（running / lastResult / lastError）来自 `useMemberCloudStore`。
 * 把 store 整个 mock 掉，就只能测「给它什么就显示什么」，
 * 测不到「点按钮 → 跑备份 → 显示结果」这条真实链路。
 * 所以这里保留真实 store，只 mock 它依赖的网络与文件层。
 */

const state = vi.hoisted(() => ({
  session: null as null | { netcard?: string },
  projectPath: null as string | null,
  projectName: "",
  quota: null as null | {
    tier: string
    usedBytes: number
    usedFiles: number
    limitBytes: number
    limitFiles: number
  },
  quotaError: null as Error | null,
  /** 内置模型额度：null 表示网关不支持该端点（老网关），此时不显示额度条 */
  tokenQuota: null as null | {
    tier: "free" | "member"
    tokensUsed: number
    tokensLimit: number
    tokensRemaining: number
    requestsUsed: number
    requestsLimit: number
    resetAt: string
  },
  backupResult: null as unknown,
  backupError: null as Error | null,
  /** 恢复结果；null 表示还没点过 */
  restoreResult: null as null | {
    restored: number
    skippedNewer: number
    failed: Array<{ path: string; message: string }>
    totalBytes: number
    remoteTotal: number
  },
  restoreError: null as Error | null,
}))

const mocks = vi.hoisted(() => ({
  resolveRelay: vi.fn(async () => "https://relay-home.qmai.work"),
  fetchQuota: vi.fn(),
  fetchTokenQuota: vi.fn(),
  backup: vi.fn(),
  restore: vi.fn(),
  ensureProjectId: vi.fn(async () => "pid-1"),
}))

vi.mock("@/stores/account-store", () => {
  const store = (selector: (s: { session: typeof state.session }) => unknown) =>
    selector({ session: state.session })
  ;(store as unknown as { getState: () => unknown }).getState = () => ({
    session: state.session ? { ...state.session, baseUrl: "https://example.test", user: { id: 1 } } : null,
    /*
     * 会员云空间 2026-11-09 起是会员专属：`runBackup` 里会读
     * `user.membership` 并调 `isMembershipActive`，非会员直接返回 false。
     * 这个 spec 测的是旧面板的渲染逻辑，所以给一个有效会员身份，
     * 让它能跑到备份那一步。
     */
    user: {
      membership: {
        active: true,
        expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400,
        remainingDays: 30,
        planLabel: "月卡",
        forever: false,
      },
    },
  })
  Object.assign(store, { subscribe: () => () => {} })
  return { useAccountStore: store }
})

vi.mock("@/stores/wiki-store", () => {
  const store = (
    selector: (s: { project: { path: string | null; name: string } }) => unknown,
  ) => selector({ project: { path: state.projectPath, name: state.projectName } })
  ;(store as unknown as { getState: () => unknown }).getState = () => ({
    project: { path: state.projectPath, name: state.projectName },
  })
  Object.assign(store, { subscribe: () => () => {} })
  return { useWikiStore: store }
})

vi.mock("@/lib/builtin-models/netcard", () => ({
  netcardOf: (session: { netcard?: string } | null) => session?.netcard ?? null,
}))

vi.mock("@/lib/builtin-models/relay-endpoints", () => ({
  // 会员云空间用的是「只走家庭网关」的解析（同步与额度接口只存在于那里）
  resolveSyncBaseUrl: () => mocks.resolveRelay(),
}))

/*
 * 额度查询要 mock 掉：真实实现会发网络请求，测试环境没有网，
 * 每次用例白等超时会把整个套件拖慢（2026-11-08 在 relay-endpoints 上踩过）。
 */
vi.mock("@/lib/builtin-models/gateway-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/builtin-models/gateway-api")>(
    "@/lib/builtin-models/gateway-api",
  )
  return {
    ...actual,
    gatewayFetchQuota: (...args: unknown[]) => mocks.fetchTokenQuota(...args),
  }
})

vi.mock("@/lib/project-identity", () => ({
  ensureProjectId: (...args: unknown[]) => mocks.ensureProjectId(...args),
}))

vi.mock("@/lib/qmai-sync/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/qmai-sync/client")>(
    "@/lib/qmai-sync/client",
  )
  return {
    ...actual,
    fetchSyncQuota: (...args: unknown[]) => mocks.fetchQuota(...args),
  }
})

vi.mock("@/lib/qmai-sync/backup", () => ({
  backupProject: (...args: unknown[]) => mocks.backup(...args),
}))

vi.mock("@/lib/qmai-sync/restore", () => ({
  restoreProject: (...args: unknown[]) => mocks.restore(...args),
}))

import { MemberCloudSection } from "./member-cloud-section"
import { useSyncQuotaStore } from "@/stores/sync-quota-store"
import { useMemberCloudStore } from "@/stores/member-cloud-store"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  state.session = null
  state.projectPath = null
  state.projectName = ""
  state.quota = null
  state.quotaError = null
  state.backupResult = null
  state.backupError = null

  state.tokenQuota = null
  mocks.fetchQuota.mockReset()
  mocks.fetchTokenQuota.mockReset()
  mocks.fetchTokenQuota.mockImplementation(async () => state.tokenQuota)
  mocks.backup.mockReset()
  mocks.restore.mockReset()
  state.restoreResult = null
  state.restoreError = null
  mocks.restore.mockImplementation(async () => {
    if (state.restoreError) throw state.restoreError
    return state.restoreResult
  })
  mocks.fetchQuota.mockImplementation(async () => {
    if (state.quotaError) throw state.quotaError
    return state.quota
  })
  mocks.backup.mockImplementation(async () => {
    if (state.backupError) throw state.backupError
    return state.backupResult
  })

  // 重置 store 的运行时状态（localStorage 在 jsdom 里跨用例保留）
  // 额度 store 有「5 分钟内不重复请求」的软过期缓存，用例之间必须清掉
  useSyncQuotaStore.setState({ quota: null, loading: false, error: null, lastFetchedAt: 0 })

  useMemberCloudStore.setState({
    autoEnabled: false,
    running: false,
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    lastRestore: null,
    lastRestoreError: null,
  })

  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render() {
  await act(async () => {
    root.render(<MemberCloudSection />)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const LOGGED_IN = { netcard: "card-abc" }

describe("会员云空间面板", () => {
  it("未登录时提示先登录，且不出现备份按钮", async () => {
    state.session = null
    state.projectPath = "/proj"
    await render()

    expect(container.querySelector('[data-ui="member-cloud-login-required"]')).toBeTruthy()
    expect(container.textContent).toContain("请先在「账号」里登录")
    expect(container.textContent).not.toContain("立即备份到云端")
  })

  it("已登录但没打开作品时提示打开作品，也不出现备份按钮", async () => {
    state.session = LOGGED_IN
    state.projectPath = null
    await render()

    expect(container.querySelector('[data-ui="member-cloud-no-project"]')).toBeTruthy()
    expect(container.textContent).toContain("当前没有打开的作品")
    expect(container.textContent).not.toContain("立即备份到云端")
  })

  it("正常状态显示配额、自动同步开关与备份按钮", async () => {
    state.session = LOGGED_IN
    state.projectPath = "/proj"
    state.projectName = "我的小说"
    state.quota = {
      tier: "member",
      usedBytes: 5 * 1048576,
      usedFiles: 12,
      limitBytes: 5368709120,
      limitFiles: 50000,
    }
    await render()

    /*
     * 2026-11-08 改版：原来是一行「已用 X / Y」的 QuotaBar，现在换成
     * 环形卡片（方案 A）—— 主数字是「剩余可用」，比「已用」更贴用户的问题。
     */
    const quota = container.querySelector('[data-ui="sync-quota-ring"]')
    expect(quota).toBeTruthy()
    expect(quota!.textContent).toContain("VIP 会员空间")
    expect(quota!.textContent).toContain("共 5.00 GB")
    expect(quota!.textContent).toContain("已用 5.0 MB")
    expect(container.textContent).toContain("我的小说")
    expect(container.textContent).toContain("立即备份到云端")
    expect(container.querySelector('[data-ui="member-cloud-auto-switch"]')).toBeTruthy()
  })

  it("免费用户看到「开通会员可扩容」的引导", async () => {
    state.session = LOGGED_IN
    state.projectPath = "/proj"
    state.quota = {
      tier: "free",
      usedBytes: 1024,
      usedFiles: 1,
      limitBytes: 209715200,
      limitFiles: 2000,
    }
    await render()

    expect(container.textContent).toContain("免费版")
    expect(container.textContent).toContain("扩容到 5 GB")
  })

  it("配额读取失败时给出错误文案，而不是白屏", async () => {
    state.session = LOGGED_IN
    state.projectPath = "/proj"
    state.quotaError = new Error("登录状态已失效，请重新登录后再同步。")
    await render()
    // store 的 refresh 是异步的，等一拍再断言
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain("登录状态已失效")
  })

  it("点备份按钮会真的跑一次，并报告上传数", async () => {
    state.session = LOGGED_IN
    state.projectPath = "/proj"
    state.quota = {
      tier: "member",
      usedBytes: 0,
      usedFiles: 0,
      limitBytes: 5368709120,
      limitFiles: 50000,
    }
    state.backupResult = {
      uploaded: 3,
      skippedUnchanged: 2,
      failed: [],
      totalBytes: 2048,
      skipped: 0,
      truncated: false,      binarySkipped: [],
      manifest: {},
    }
    await render()

    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("立即备份到云端"),
    )
    expect(button).toBeTruthy()

    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.backup).toHaveBeenCalledTimes(1)
    const msg = container.querySelector('[data-ui="member-cloud-message"]')
    expect(msg!.textContent).toContain("已备份 3 个文件")
    expect(msg!.textContent).toContain("2 个无改动已跳过")
  })

  it("没有新改动时明确说「没有新改动」，而不是假装传了 0 个", async () => {
    state.session = LOGGED_IN
    state.projectPath = "/proj"
    state.quota = {
      tier: "member",
      usedBytes: 0,
      usedFiles: 0,
      limitBytes: 5368709120,
      limitFiles: 50000,
    }
    state.backupResult = {
      uploaded: 0,
      skippedUnchanged: 7,
      failed: [],
      totalBytes: 0,
      skipped: 0,
      truncated: false,      binarySkipped: [],
      manifest: {},
    }
    await render()

    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("立即备份到云端"),
    )
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    const msg = container.querySelector('[data-ui="member-cloud-message"]')
    expect(msg!.textContent).toContain("没有新改动")
    expect(msg!.textContent).toContain("7 个文件已是最新")
  })

  it("部分文件失败时报告失败数并可展开明细", async () => {
    state.session = LOGGED_IN
    state.projectPath = "/proj"
    state.quota = {
      tier: "member",
      usedBytes: 0,
      usedFiles: 0,
      limitBytes: 5368709120,
      limitFiles: 50000,
    }
    state.backupResult = {
      uploaded: 2,
      skippedUnchanged: 0,
      failed: [{ path: "chapters/ch3.md", message: "同步空间不足。" }],
      totalBytes: 100,
      skipped: 0,
      truncated: false,      binarySkipped: [],
      manifest: {},
    }
    await render()

    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("立即备份到云端"),
    )
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    const msg = container.querySelector('[data-ui="member-cloud-message"]')
    expect(msg!.textContent).toContain("已备份 2 个文件")
    expect(msg!.textContent).toContain("1 个失败")

    const failed = container.querySelector('[data-ui="member-cloud-failed"]')
    expect(failed).toBeTruthy()
    expect(failed!.textContent).toContain("chapters/ch3.md")
  })

  it("自动同步开关反映 store 状态", async () => {
    state.session = LOGGED_IN
    state.projectPath = "/proj"
    state.quota = {
      tier: "member",
      usedBytes: 0,
      usedFiles: 0,
      limitBytes: 5368709120,
      limitFiles: 50000,
    }
    useMemberCloudStore.setState({ autoEnabled: true })
    await render()

    // Switch 是 role="switch" 的按钮，状态在 aria-checked 上
    const sw = container.querySelector('[data-ui="member-cloud-auto-switch"]')
    expect(sw).toBeTruthy()
    expect(sw!.getAttribute("aria-checked")).toBe("true")
  })
})


describe("内置模型额度显示", () => {
  beforeEach(() => {
    state.session = { netcard: "card-1" }
    state.projectPath = "/tmp/proj"
    state.projectName = "测试作品"
    state.quota = {
      tier: "member",
      usedBytes: 1024,
      usedFiles: 1,
      limitBytes: 1024 * 1024,
      limitFiles: 100,
    }
  })

  it("显示今日已用与剩余 token", async () => {
    state.tokenQuota = {
      tier: "free",
      tokensUsed: 12000,
      tokensLimit: 30000,
      tokensRemaining: 18000,
      requestsUsed: 5,
      requestsLimit: 100,
      resetAt: "2026-11-09T16:00:00.000Z",
    }
    await render()
    const el = document.querySelector('[data-ui="token-quota"]')
    expect(el).toBeTruthy()
    const text = el?.textContent ?? ""
    // 12000 / 30000 都要出现（用「万」缩写时是 1.2 万 / 3.0 万）
    expect(text).toContain("1.2 万")
    expect(text).toContain("3.0 万")
    expect(text).toContain("剩余")
  })

  it("免费档提示升级到 100 万", async () => {
    state.tokenQuota = {
      tier: "free",
      tokensUsed: 100,
      tokensLimit: 30000,
      tokensRemaining: 29900,
      requestsUsed: 1,
      requestsLimit: 100,
      resetAt: "2026-11-09T16:00:00.000Z",
    }
    await render()
    const text = document.querySelector('[data-ui="token-quota"]')?.textContent ?? ""
    expect(text).toContain("100 万")
  })

  it("会员档不显示升级提示", async () => {
    state.tokenQuota = {
      tier: "member",
      tokensUsed: 100,
      tokensLimit: 1000000,
      tokensRemaining: 999900,
      requestsUsed: 1,
      requestsLimit: 2000,
      resetAt: "2026-11-09T16:00:00.000Z",
    }
    await render()
    const text = document.querySelector('[data-ui="token-quota"]')?.textContent ?? ""
    expect(text).not.toContain("开通会员")
  })

  it("额度用完时给出明确提示", async () => {
    state.tokenQuota = {
      tier: "free",
      tokensUsed: 30000,
      tokensLimit: 30000,
      tokensRemaining: 0,
      requestsUsed: 50,
      requestsLimit: 100,
      resetAt: "2026-11-09T16:00:00.000Z",
    }
    await render()
    const text = document.querySelector('[data-ui="token-quota"]')?.textContent ?? ""
    expect(text).toContain("已用完")
  })

  it("网关不支持额度端点时（返回 null）不渲染额度条，也不影响其他内容", async () => {
    state.tokenQuota = null
    await render()
    expect(document.querySelector('[data-ui="token-quota"]')).toBeNull()
    // 云空间配额照常显示 —— 一个可选功能失败不能拖垮整页
    expect(document.querySelector('[data-ui="sync-quota-ring"]')).toBeTruthy()
  })
})


describe("从云端恢复", () => {
  beforeEach(() => {
    state.session = { netcard: "card-1" }
    state.projectPath = "/tmp/proj"
    state.projectName = "测试作品"
    state.quota = {
      tier: "member",
      usedBytes: 1024,
      usedFiles: 1,
      limitBytes: 1024 * 1024,
      limitFiles: 100,
    }
  })

  it("渲染「从云端恢复」按钮", async () => {
    await render()
    const btn = document.querySelector('[data-ui="member-cloud-restore"]')
    expect(btn).toBeTruthy()
    expect(btn?.textContent).toContain("从云端恢复")
  })

  it("用户取消确认时不发起恢复", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false)
    await render()

    const btn = document.querySelector('[data-ui="member-cloud-restore"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })

    expect(confirmSpy).toHaveBeenCalled()
    expect(mocks.restore).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it("用户确认后执行恢复并显示结果", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    state.restoreResult = {
      restored: 3,
      skippedNewer: 1,
      failed: [],
      totalBytes: 2048,
      remoteTotal: 4,
    }
    await render()

    const btn = document.querySelector('[data-ui="member-cloud-restore"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.restore).toHaveBeenCalled()
    const msg = document.querySelector('[data-ui="member-cloud-restore-message"]')?.textContent ?? ""
    expect(msg).toContain("已恢复 3 个文件")
    expect(msg).toContain("1 个本地更新已跳过")
    confirmSpy.mockRestore()
  })

  it("云端没有文件时如实提示", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    state.restoreResult = {
      restored: 0,
      skippedNewer: 0,
      failed: [],
      totalBytes: 0,
      remoteTotal: 0,
    }
    await render()

    const btn = document.querySelector('[data-ui="member-cloud-restore"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const msg = document.querySelector('[data-ui="member-cloud-restore-message"]')?.textContent ?? ""
    expect(msg).toContain("云端还没有")
    confirmSpy.mockRestore()
  })

  it("恢复失败时显示错误，不白屏", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    state.restoreError = new Error("网卡无效")
    await render()

    const btn = document.querySelector('[data-ui="member-cloud-restore"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const msg = document.querySelector('[data-ui="member-cloud-restore-message"]')?.textContent ?? ""
    expect(msg).toContain("网卡无效")
    confirmSpy.mockRestore()
  })
})

describe("同步日志入口", () => {
  beforeEach(() => {
    state.session = { netcard: "card-1" }
    state.projectPath = "/tmp/proj"
    state.projectName = "测试作品"
    state.quota = {
      tier: "member",
      usedBytes: 0,
      usedFiles: 0,
      limitBytes: 1024 * 1024,
      limitFiles: 100,
    }
  })

  it("渲染「查看同步日志」按钮", async () => {
    await render()
    const btn = document.querySelector('[data-ui="member-cloud-log-button"]')
    expect(btn).toBeTruthy()
    expect(btn?.textContent).toContain("查看同步日志")
  })

  it("点击后弹出日志弹窗", async () => {
    await render()
    const btn = document.querySelector('[data-ui="member-cloud-log-button"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.querySelector('[data-ui="member-cloud-log-dialog"]')).toBeTruthy()
  })
})
