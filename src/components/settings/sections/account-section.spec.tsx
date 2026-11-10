// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetAccountStoreForTests, useAccountStore } from "@/stores/account-store"
const openMemberCenter = vi.hoisted(() => vi.fn())
vi.mock("@/stores/membership-purchase-store", () => ({ useMembershipPurchaseStore: (selector: (s: { show: typeof openMemberCenter }) => unknown) => selector({ show: openMemberCenter }) }))

import { AccountSection } from "./account-section"

/*
 * 购买弹窗在本文件里只关心「有没有被打开」，真实内容由
 * member-purchase-dialog.spec.tsx 覆盖。它自己还会拉支付渠道、
 * 起轮询 —— 在账号页的用例里跑那些只是噪音。
 */
vi.mock("@/components/membership/member-purchase-dialog", () => ({
  MemberPurchaseDialog: ({ open }: { open: boolean }) =>
    open ? <div data-ui="mock-purchase-dialog" /> : null,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const USER = {
  id: 12,
  email: "writer@example.com",
  displayName: "青禾",
  createdAt: 1_793_000_000,
  avatarUpdatedAt: null,
  displayNameUpdatedAt: null,
  membership: {
    active: true,
    expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    remainingDays: 30,
    planLabel: "月卡",
    forever: false,
  },
}

/** 非会员账号：没有会员快照（老服务端 / 试用到期后的形状）。 */
const FREE_USER = {
  id: 13,
  email: "free@example.com",
  displayName: "白纸",
  createdAt: 1_793_000_000,
  avatarUpdatedAt: null,
  displayNameUpdatedAt: null,
}

let host: HTMLDivElement
let root: Root

function render() {
  act(() => {
    root.render(<AccountSection />)
  })
}

function textButton(label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  )
  expect(button, label).not.toBeUndefined()
  return button!
}

/**
 * 展开账号管理面板（2026-11-09 用户要求）。
 *
 * 「更换头像 / 修改密码 / 修改昵称 / 退出登录」四个动作收进了头像栏，
 * 默认折叠 —— 原来它们平铺在卡片里占了大半屏，而账号页的主角应该是
 * 会员状态。所以下面这些用例都要先点头像栏。
 */
function openAccountMenu() {
  const row = host.querySelector<HTMLButtonElement>('[data-ui="account-idrow"]')
  expect(row, "头像栏").not.toBeNull()
  act(() => row!.click())
}

beforeEach(() => {
  resetAccountStoreForTests()
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  resetAccountStoreForTests()
})

describe("AccountSection", () => {
  it("匿名时说明本地写作不受影响，并提供登录与注册入口", async () => {
    useAccountStore.setState({ status: "anonymous", user: null, dialogOpen: false })
    render()

    expect(host.querySelector('[data-ui="account-section"]')).not.toBeNull()
    expect(host.textContent).toContain("登录青幕账号，云同步与后续服务会记在这个账号下。不登录也可以正常写作。")
    expect(host.textContent).not.toContain("会员")

    await act(async () => textButton("登录").click())
    expect(useAccountStore.getState().dialogOpen).toBe(true)
    expect(useAccountStore.getState().authMode).toBe("login")

    await act(async () => textButton("注册").click())
    expect(useAccountStore.getState().authMode).toBe("register")
  })

  it("非会员账号：账号页显示「未开通」并给出兑换入口", async () => {
    useAccountStore.setState({ status: "authenticated", user: FREE_USER, session: null })
    render()

    expect(host.textContent).toContain("未开通")
    /*
     * 2026-11-09 用户要求：免费态主卡里不再有说明段落与按钮
     * （「未开通会员 / 当前为免费账号… / 下方列出的是会员专属功能…」全删），
     * 入口统一到下方「会员专属功能」区底部的唯一入口组。
     *
     * 所以这里断言的是**新的入口位置**：
     *   · 「会员专属功能」清单出现
     *   · 底部有「开通会员」+「使用兑换」
     * 而不是旧的 account-free-benefits / activation-code-form。
     */
    expect(host.querySelector('[data-ui="member-benefits"]')).not.toBeNull()
    expect(host.querySelector('[data-ui="account-open-purchase"]')?.textContent).toContain("开通会员")
    expect(host.querySelector('[data-ui="account-use-redeem"]')).toBeNull()
  })

  it("已登录时显示账号、注册日期与退出登录", async () => {
    useAccountStore.setState({ status: "authenticated", user: USER, session: null })
    vi.spyOn(window, "confirm").mockReturnValue(true)
    render()

    expect(host.textContent).toContain("青禾")
    expect(host.textContent).toContain("writer@example.com")
    expect(host.textContent).toContain(new Date(USER.createdAt * 1000).toLocaleDateString("zh-CN"))
    expect(host.textContent).not.toContain("会员功能即将上线")
    /*
     * 2026-11-06 起「会员」字样在这里是**预期**的：账号页承担会员状态展示与
     * 续费入口。这条断言从「不出现会员」改为「出现会员状态与到期日」——
     * 校验的是新契约，而不是把旧断言删掉了事。
     */
    expect(host.textContent).toContain("会员")
    /*
     * 2026-11-09 用户要求：会员态删掉「已开通」绿标签 ——
     * VIP 徽标已经说明了身份，再挂一个标签是冗余。
     *
     * 改成断言那块**留在页面上**的徽标，而不是把断言删掉 ——
     * 这样「身份是否被正确显示」仍然被测到。
     */
    expect(host.textContent).toContain("VIP 会员")
    expect(host.textContent).not.toContain("已开通")
    expect(host.textContent).toContain("月卡")
    /*
     * 2026-11-09 用户要求：按钮文案从「续费 / 顺延」简化为「续费」。
     * 断言按钮自己的文字，而不是 `host.textContent` —— 后者会被
     * 「续费后顺延」这类说明文字命中，测不出按钮文案写错了。
     */
    expect(host.querySelector('[data-ui="account-renew"]')?.textContent).toContain("会员中心")
    // 退出登录在账号管理面板里：先点头像栏展开（2026-11-09 改）
    openAccountMenu()
    await act(async () => textButton("退出登录").click())
    // 文案必须与真实行为一致：勾了「记住密码」时本机 30 天内仍可一键登录，
    // 不能说成「需要重新登录」（见 account-display.ts 的注释）。
    expect(window.confirm).toHaveBeenCalledWith(
      "退出后云同步会停用；若之前勾选了「记住密码」，本机 30 天内仍可一键登录。本地小说和模型配置不会被删除。",
    )
    expect(useAccountStore.getState().status).toBe("anonymous")
    expect(useAccountStore.getState().user).toBeNull()
    expect(host.textContent).toContain("登录青幕账号，云同步与后续服务会记在这个账号下")
  })

  it("账号状态尚未读取时显示加载说明", () => {
    useAccountStore.setState({ status: "booting", user: null })
    render()
    expect(host.textContent).toContain("正在读取账号状态…")
    expect(host.querySelector("button")).toBeNull()
  })

  it("账号服务暂时不可用但保留登录态时显示灰色提示", () => {
    useAccountStore.setState({
      status: "authenticated",
      user: USER,
      sessionUnverified: true,
    })
    render()

    expect(host.textContent).toContain("账号服务暂时不可用，已保留本地登录状态；云同步稍后再试。")
    expect(host.querySelector('[role="status"]')).not.toBeNull()
  })
})

describe("昵称修改（每月一次）", () => {
  it("可以改昵称：点铅笔 → 输入 → 回车，调用 store 的 rename", async () => {
    useAccountStore.setState({ status: "authenticated", user: USER, session: null })
    const rename = vi.fn(async (next: string) => ({ ...USER, displayName: next, displayNameUpdatedAt: 1 }))
    useAccountStore.setState({ rename } as never)
    render()

    openAccountMenu()
    const pencil = host.querySelector<HTMLButtonElement>('button[aria-label="修改昵称"]')!
    expect(pencil).toBeTruthy()
    act(() => pencil.click())

    const input = host.querySelector<HTMLInputElement>('input[aria-label="昵称"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    act(() => {
      setter.call(input, "新名字")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    })

    expect(rename).toHaveBeenCalledWith("新名字")
  })

  it("冷却期内铅笔禁用，并提示下次可修改日期", () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 5 * 24 * 60 * 60 // 5 天前改过
    useAccountStore.setState({
      status: "authenticated",
      user: { ...USER, displayNameUpdatedAt: updatedAt },
      session: null,
    })
    render()

    openAccountMenu()
    /*
     * 冷却期内那行**仍然渲染但禁用**（2026-11-09 改）。
     *
     * 原版是整行消失。收进账号管理面板后，消失会让用户以为
     * 「这里没有修改昵称这个功能」；禁用则明确「有，但现在不能用」。
     */
    const row = host.querySelector<HTMLButtonElement>('button[aria-label="修改昵称"]')
    expect(row?.disabled).toBe(true)
    expect(host.textContent).toContain("昵称下次可修改")
  })

  it("服务端返回 NAME_LOCKED 时给出中文提示", async () => {
    useAccountStore.setState({ status: "authenticated", user: USER, session: null })
    const { AccountApiError } = await import("@/lib/account/errors")
    const rename = vi.fn(async () => {
      throw new AccountApiError("NAME_LOCKED")
    })
    useAccountStore.setState({ rename } as never)
    render()

    openAccountMenu()
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="修改昵称"]')!.click())
    const input = host.querySelector<HTMLInputElement>('input[aria-label="昵称"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    act(() => {
      setter.call(input, "另一个名字")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    })

    expect(host.textContent).toContain("昵称每个月只能修改一次")
  })
})

/*
 * ── 2026-11-09 方案 B：账号主卡 ────────────────────────────────
 *
 * 用户确认的设计：
 *   · 账号操作（换头像 / 改密码 / 改昵称 / 退出登录）**折叠**在头像栏里
 *   · 头像栏下面直接是「剩余天数 / 到期时间 / 云空间」三个数据
 *   · 金色只出现在这张主卡上（云备份、模型同步都是中性描边）
 *
 * 这几条钉住的是**新契约**。之前「会员卡 + 云空间卡两列并排」的断言
 * 已经删掉了 —— 不是把失败的测试删掉了事，而是那两张卡合并进了这里，
 * 断言随之搬到了它们现在真正所在的位置。
 */
describe("账号主卡（2026-11-09 方案 B）", () => {
  it("账号操作默认折叠在头像栏里", () => {
    useAccountStore.setState({ status: "authenticated", user: USER, session: null })
    render()

    expect(host.querySelector('[data-ui="account-idrow"]')).not.toBeNull()
    // 折叠时四个动作都不在 DOM 里 —— 用户第一眼看到的是会员身份，不是一排管理按钮
    expect(host.querySelector('[data-ui="account-menu"]')).toBeNull()
    expect(host.querySelector('[data-ui="account-menu-logout"]')).toBeNull()
  })

  it("会员态在头像栏下方显示剩余天数、到期时间与云空间", () => {
    useAccountStore.setState({ status: "authenticated", user: USER, session: null })
    render()

    const metrics = host.querySelector('[data-ui="account-metrics"]')
    expect(metrics).not.toBeNull()
    expect(metrics?.textContent).toContain("剩余天数")
    expect(metrics?.textContent).toContain("到期时间")
    expect(metrics?.textContent).toContain("云空间")
    expect(metrics?.textContent).toContain("30 天")
    expect(metrics?.textContent).toContain("月卡")
  })

  it("免费态显示权益清单，且不显示任何额度数字", () => {
    useAccountStore.setState({ status: "authenticated", user: FREE_USER, session: null })
    render()

    /*
     * 免费态的清单从 `account-free-benefits`（主卡内的一段说明）
     * 换成了 `member-feature-list`（下方独立的 5 项清单）——
     * 2026-11-09 用户要求主卡不再罗列功能，避免和下方清单说两遍。
     */
    expect(host.querySelector('[data-ui="account-metrics"]')).toBeNull()
    const list = host.querySelector('[data-ui="member-benefits"]')
    expect(list).not.toBeNull()

    // 5 项会员功能都在（云备份本次也补进了清单）
    expect(list?.textContent).toContain("云备份")
    expect(list?.textContent).toContain("模型同步")
    expect(list?.textContent).toContain("灵魂库")
    expect(list?.textContent).toContain("拆书库")
    expect(list?.textContent).toContain("剧情推演室")

    // 免费用户的云空间根本不能用，显示任何额度数字都会误导
    expect(list?.textContent).not.toMatch(/剩\s*\d/)
    expect(list?.textContent).not.toContain("100 MB")
  })

  it("点「续费 / 顺延」打开购买弹窗", async () => {
    useAccountStore.setState({ status: "authenticated", user: USER, session: null })
    render()

    expect(host.querySelector('[data-ui="mock-purchase-dialog"]')).toBeNull()
    const btn = host.querySelector<HTMLButtonElement>('[data-ui="account-renew"]')
    expect(btn).not.toBeNull()

    await act(async () => {
      btn!.click()
    })

    expect(openMemberCenter).toHaveBeenCalled()
  })

  it("会员态的兑换链接默认收起，点「使用兑换」才展开", async () => {
    useAccountStore.setState({ status: "authenticated", user: USER, session: null })
    render()

    /*
     * 会员态的兑换是**次路径**（主路径是扫码付款），默认收起省版面。
     * 免费态的兑换入口在下方入口组里，见上面「非会员账号」那条用例。
     *
     * 2026-11-09 用户要求：它从描边按钮改成**文字链接**，
     * 文案从「使用兑换码」简化为「使用兑换」。
     */
    expect(host.querySelector('[data-ui="account-redeem-panel"]')).toBeNull()

    const toggle = host.querySelector<HTMLButtonElement>('[data-ui="account-redeem-toggle"]')!
    expect(toggle.textContent).toContain("使用兑换")
    await act(async () => {
      toggle.click()
    })

    expect(host.querySelector('[data-ui="account-redeem-panel"]')).not.toBeNull()
    expect(host.querySelector('[data-ui="activation-code-form"]')).not.toBeNull()
  })

  it("「重新读取」已删除，改为进页面自动刷新", async () => {
    /*
     * 2026-11-09 用户确认删除这个按钮。
     *
     * 它是「不确定什么时候该点」的按钮 —— 用户不知道自己在等什么更新，
     * 点了没变化也不知道算不算成功。改为挂载时静默刷新一次会员状态。
     *
     * 这条测试的意义是**防止它被误加回来**：那个按钮看起来无害，
     * 但它把「该刷新」的责任推给了用户。
     */
    const refreshMembership = vi.fn().mockResolvedValue(true)
    useAccountStore.setState({
      status: "authenticated",
      user: USER,
      session: null,
      refreshMembership,
    } as never)

    await act(async () => {
      render()
      await new Promise((r) => setTimeout(r, 20))
    })

    expect(host.querySelector('[data-ui="account-refresh"]')).toBeNull()
    expect(host.textContent).not.toContain("重新读取")
  })
})
