// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 「模型同步」面板的渲染契约。
 *
 * 2026-10-28 定的新版：
 * - 默认**折叠**：只留一行 = 标题 + 上次同步时间 + 立即同步 + 开关；
 * - 「修改同步密码」只在展开后出现；
 * - 开关就是同步开关：开 = 同步、关 = 停止同步（保留密码与云端配置）；
 * - 「关闭同步并清空云端配置」是独立链接，放在展开后「上次同步」那一行的右端。
 *
 * 2026-11-02 用户两点改动：
 * - 名称从「账号同步」改为「模型同步」：它同步的是模型配置，不是账号本身，
 *   原名会让人以为开了就能跨设备同步作品；
 * - **未登录时整块不显示**（原来是显示但置灰）：未登录根本开不了同步，
 *   留一行点不动的开关只会让人以为是 bug。
 *
 * 这里只验渲染与交互接线，加解密/合并逻辑在 lib/model-sync 的单测里覆盖。
 */

const state = vi.hoisted(() => ({
  enabled: false,
  passwordReady: false,
  busy: false,
  status: "idle" as "idle" | "pulling" | "pushing" | "error",
  message: "",
  pendingConflicts: [] as Array<{ key: string; localValue: unknown; cloudValue: unknown; chosen: "local" | "cloud" }>,
  lastSyncAt: null as number | null,
  init: vi.fn(async () => undefined),
  enable: vi.fn(async () => undefined),
  setEnabled: vi.fn(async () => undefined),
  disable: vi.fn(async () => undefined),
  syncNow: vi.fn(async () => undefined),
  restoreFromCloud: vi.fn(async () => undefined),
  changePassword: vi.fn(async () => undefined),
  resolveConflict: vi.fn(async () => undefined),
}))

/**
 * 账号状态夹具。
 *
 * 2026-11-06 起「模型同步」是**会员功能**，所以这里必须同时给出登录态与会员状态：
 * 只给 session 的话面板会渲染成「未开通」形态，开关是锁的。
 * 会员判定走真实实现（`@/lib/membership/access`），不在这里 mock ——
 * 否则「判定改坏了」这件事在本 spec 里看不出来。
 */
const account = vi.hoisted(() => ({
  session: null as null | { baseUrl: string; user?: unknown },
  user: null as unknown,
}))

vi.mock("@/stores/model-sync-store", () => ({
  useModelSyncStore: (selector: (value: typeof state) => unknown) => selector(state),
  MIN_SYNC_PASSWORD_LENGTH: 8,
}))
vi.mock("@/stores/account-store", () => ({
  useAccountStore: (selector: (value: typeof account) => unknown) => selector(account),
}))

const confirmMock = vi.hoisted(() => ({ confirmModelAction: vi.fn(async () => true) }))
vi.mock("@/components/uitest/models/model-confirm", () => confirmMock)

import { ModelSyncPanel } from "./model-sync-panel"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function render() {
  act(() => {
    root.render(<ModelSyncPanel />)
  })
}

function button(text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === text,
  )
}

function toggleButton(): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('button[aria-expanded]')!
}

function switchButton(): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('[data-ui="model-sync-switch"]')!
}

const LOGGED_IN = { baseUrl: "https://qmai-account.qmai.workers.dev" }
/** 会员在有效期内的账号：绝大多数用例要测的是「会员能正常用同步」。 */
const MEMBER_USER = {
  id: 1,
  email: "author@example.com",
  displayName: "作者",
  createdAt: 1_793_000_000,
  avatarUpdatedAt: null,
  displayNameUpdatedAt: null,
  membership: {
    active: true,
    expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    remainingDays: 30,
    planLabel: "月卡",
  },
}
const LOGGED_IN_MEMBER = { ...LOGGED_IN, user: MEMBER_USER }

beforeEach(() => {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  Object.assign(state, {
    enabled: false,
    passwordReady: false,
    busy: false,
    status: "idle",
    message: "",
    pendingConflicts: [],
    lastSyncAt: null,
  })
  account.session = null
  account.user = null
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

describe("模型同步面板", () => {
  it("未登录：整块不显示（未登录开不了同步，留个按不动的开关只会像 bug）", () => {
    render()
    expect(host.querySelector('[data-ui="model-sync-panel"]')).toBeNull()
    expect(host.textContent).toBe("")
  })

  it("标题已从「账号同步」改为「模型同步」：它同步的是模型配置，不是账号", () => {
    account.session = LOGGED_IN_MEMBER
    account.user = MEMBER_USER
    render()
    expect(host.textContent).toContain("模型同步")
    expect(host.textContent).not.toContain("账号同步")
    /*
     * 2026-11-09：标题不再是折叠按钮，改成卡头文字 + 右侧开关。
     * 所以「标题带 title」这条改成断言开关的 title —— 它才是有提示的那个。
     */
    expect(switchButton().getAttribute("title")).toContain("同步")
  })

  it("会员：标题 + 开关都显示，开关可用", () => {
    account.session = LOGGED_IN_MEMBER
    account.user = MEMBER_USER
    render()
    expect(host.querySelector('[data-ui="model-sync-panel"]')).toBeTruthy()
    expect(switchButton().disabled).toBe(false)
  })

  /*
   * 会员闸门（2026-11-06）。
   *
   * 「模型同步」是会员功能：未开通时**面板保留**（它是这个功能在界面上唯一的存在），
   * 但开关锁死、给兑换入口。整块消失会让用户永远不知道该功能存在，也就无从开通。
   */
  it("已登录但未开通会员：面板保留、开关锁死，展开后给兑换入口", () => {
    account.session = LOGGED_IN
    account.user = null
    render()
    const panel = host.querySelector('[data-ui="model-sync-panel"]')
    expect(panel).toBeTruthy()
    expect(panel!.getAttribute("data-member-locked")).toBe("true")
    expect(switchButton().disabled).toBe(true)
    expect(host.textContent).toContain("模型同步是会员功能")
    expect(button("开通会员")).toBeTruthy()

    act(() => toggleButton().click())
    expect(host.querySelector('[data-ui="activation-code-form"]')).toBeTruthy()
  })

  it("会员到期（expiresAt 已过）按未开通处理，即使服务端快照写着 active", () => {
    account.session = LOGGED_IN
    account.user = {
      ...MEMBER_USER,
      membership: {
        active: true,
        expiresAt: Math.floor(Date.now() / 1000) - 60,
        remainingDays: 1,
        planLabel: "月卡",
      },
    }
    render()
    expect(switchButton().disabled).toBe(true)
    expect(host.querySelector('[data-ui="model-sync-panel"]')!.getAttribute("data-member-locked")).toBe("true")
  })

  it("默认折叠：只有标题 + 开关，没有「修改同步密码」", () => {
    account.session = LOGGED_IN_MEMBER
    account.user = MEMBER_USER
    Object.assign(state, { enabled: true, lastSyncAt: Date.now() })
    render()
    expect(toggleButton().getAttribute("aria-expanded")).toBe("false")
    expect(button("修改同步密码")).toBeUndefined()
    // 折叠时仍给出上次同步时间（放在「立即同步」左侧）
    expect(host.textContent).toContain("上次同步：")
    expect(button("立即同步")).toBeTruthy()
  })

  it("展开后才出现「修改同步密码」与清空云端配置入口", () => {
    account.session = LOGGED_IN_MEMBER
    account.user = MEMBER_USER
    Object.assign(state, { enabled: true, lastSyncAt: Date.now() })
    render()

    /*
     * 2026-11-09 结构调整后，这两项分别收敛成：
     *   · 「修改同步密码」→ 操作条上的「密码」图标方块
     *   · 「关闭同步并清空云端配置」→ 说明区展开后出现（销毁式操作不跟日常操作并排）
     *
     * 折叠状态下两者都不该出现。
     */
    expect(host.querySelector('[data-ui="model-sync-password-form"]')).toBeNull()
    expect(host.textContent).not.toContain("关闭同步并清空云端配置（不可恢复）")

    act(() => button("密码")!.click())
    expect(host.querySelector('[data-ui="model-sync-password-form"]')).toBeTruthy()

    act(() => toggleButton().click())
    expect(toggleButton().getAttribute("aria-expanded")).toBe("true")
    expect(host.textContent).toContain("关闭同步并清空云端配置（不可恢复）")
  })

  it("开关即同步开关：点一下关闭只调 setEnabled(false)，不碰 disable（不清云端）", () => {
    account.session = LOGGED_IN_MEMBER
    account.user = MEMBER_USER
    Object.assign(state, { enabled: true, passwordReady: true })
    render()
    act(() => switchButton().click())
    expect(state.setEnabled).toHaveBeenCalledWith(false)
    expect(state.disable).not.toHaveBeenCalled()
  })

  it("已关闭且本机有密码：再点开关直接恢复同步，不再要求输密码", () => {
    account.session = LOGGED_IN_MEMBER
    account.user = MEMBER_USER
    Object.assign(state, { enabled: false, passwordReady: true })
    render()
    act(() => switchButton().click())
    expect(state.setEnabled).toHaveBeenCalledWith(true)
    expect(button("开启并上传")).toBeUndefined()
  })

  it("本机没有密码时打开开关：就地展开密码表单（一次性引导）", () => {
    account.session = LOGGED_IN_MEMBER
    account.user = MEMBER_USER
    Object.assign(state, { enabled: false, passwordReady: false })
    render()
    act(() => switchButton().click())
    expect(toggleButton().getAttribute("aria-expanded")).toBe("true")
    expect(host.querySelector('[data-ui="model-sync-password-form"]')).toBeTruthy()
    expect(state.setEnabled).not.toHaveBeenCalled()
  })

  it("「从云端下载」：确认后调用 restoreFromCloud（取消则不动）", async () => {
    account.session = LOGGED_IN_MEMBER
    account.user = MEMBER_USER
    Object.assign(state, { enabled: true, passwordReady: true, lastSyncAt: Date.now() })
    render()

    // 2026-11-09：「从云端下载」收成了操作条上的「下载」图标方块
    const download = host.querySelector<HTMLButtonElement>('[data-ui="model-sync-download"]')
    expect(download).toBeTruthy()

    confirmMock.confirmModelAction.mockResolvedValueOnce(false)
    await act(async () => download!.click())
    expect(state.restoreFromCloud).not.toHaveBeenCalled()

    confirmMock.confirmModelAction.mockResolvedValueOnce(true)
    await act(async () => download!.click())
    expect(state.restoreFromCloud).toHaveBeenCalledTimes(1)
  })

  it("冲突时逐条给出两份可选，点击即按选中的那份解决", () => {
    account.session = LOGGED_IN_MEMBER
    account.user = MEMBER_USER
    Object.assign(state, {
      enabled: true,
      pendingConflicts: [{ key: "deepseek", localValue: { m: 1 }, cloudValue: { m: 2 }, chosen: "cloud" }],
    })
    render()
    act(() => toggleButton().click())

    expect(host.textContent).toContain("deepseek")
    const localButton = button("用本地这份")
    expect(localButton).toBeTruthy()

    act(() => localButton!.click())
    expect(state.resolveConflict).toHaveBeenCalledWith("deepseek", "local")
  })

  it("折叠时同步失败仍要看得到报错（否则点「立即同步」像没反应）", () => {
    account.session = LOGGED_IN_MEMBER
    account.user = MEMBER_USER
    Object.assign(state, { enabled: true, status: "error", message: "网络不可用" })
    render()
    expect(host.textContent).toContain("网络不可用")
  })
})
