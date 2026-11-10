// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 「没有交换成功就不能显示成功」（2026-11-07 用户要求）。
 *
 * 两条真实存在过的谎报：
 *   1. 兑换激活码：断网时 `redeemCode` 抛 NETWORK，界面**不该**出现「兑换成功」；
 *   2. 「重新读取会员状态」：`refreshMembership` 早先静默吞掉网络错误，
 *      调用方 `await` 完就 `toast.success(...)` —— 断网也报成功。
 *
 * 这里用真实 store + 真实组件，只把网络层（账号 API）换成「抛 NETWORK」。
 */

const api = vi.hoisted(() => ({
  redeemActivationCode: vi.fn(),
  fetchMembership: vi.fn(),
}))

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))

vi.mock("@/lib/account/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/account/api")>("@/lib/account/api")
  return {
    ...actual,
    redeemActivationCode: api.redeemActivationCode,
    fetchMembership: api.fetchMembership,
  }
})

vi.mock("@/lib/toast", () => ({ toast: toastMock }))

import { AccountApiError } from "@/lib/account/errors"
import { useAccountStore } from "@/stores/account-store"
import { ActivationCodeForm } from "./activation-code-form"
import { MemberGateNotice } from "./member-gate-notice"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const MEMBER_USER = {
  id: 9,
  email: "a@b.c",
  displayName: "作者",
  createdAt: 1_793_000_000,
  avatarUpdatedAt: null,
  displayNameUpdatedAt: null,
}

function sessionWith(user = MEMBER_USER) {
  return {
    baseUrl: "https://account.qmai.pro",
    accessToken: "access",
    accessExpiresAt: Math.floor(Date.now() / 1000) + 900,
    refreshToken: "r".repeat(43),
    refreshExpiresAt: Math.floor(Date.now() / 1000) + 86400,
    netcard: null,
    user,
    savedAt: Math.floor(Date.now() / 1000),
  }
}

async function typeCode(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="激活码"]')
  expect(input).not.toBeNull()
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(input!, value)
    input!.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === text,
  )
  expect(found, text).toBeTruthy()
  return found!
}

beforeEach(() => {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  toastMock.success.mockClear()
  toastMock.error.mockClear()
  api.redeemActivationCode.mockReset()
  api.fetchMembership.mockReset()
  useAccountStore.setState({ status: "authenticated", user: MEMBER_USER, session: sessionWith() as never })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

describe("兑换激活码：断网不得显示成功", () => {
  it("网络失败：给错误提示、绝不弹「兑换成功」、输入框保留内容以便重试", async () => {
    api.redeemActivationCode.mockRejectedValueOnce(
      new AccountApiError("NETWORK", undefined, 0),
    )
    act(() => {
      root.render(<ActivationCodeForm />)
    })
    await typeCode("QMAI-7K2M-9XQP-3RTB-VWXZ")
    await act(async () => {
      buttonByText("兑换").click()
    })

    expect(toastMock.success).not.toHaveBeenCalled()
    expect(host.textContent).toContain("网络不可用")
    // 码不能被清空：用户要能直接再点一次
    expect(host.querySelector<HTMLInputElement>('input[aria-label="激活码"]')!.value).toBe(
      "QMAI-7K2M-9XQP-3RTB-VWXZ",
    )
    // 会员状态没变
    expect(useAccountStore.getState().user?.membership).toBeUndefined()
  })

  it("服务端返回「没有有效时长」（active:false）：不报成功", async () => {
    api.redeemActivationCode.mockResolvedValueOnce({
      membership: { active: false, expiresAt: null, remainingDays: 0, planLabel: null },
      addedDays: 0,
      planLabel: null,
    })
    act(() => {
      root.render(<ActivationCodeForm />)
    })
    await typeCode("QMAI-7K2M-9XQP-3RTB-VWXZ")
    await act(async () => {
      buttonByText("兑换").click()
    })

    expect(toastMock.success).not.toHaveBeenCalled()
    expect(host.textContent).toContain("没有返回有效的会员时长")
  })

  it("真的兑换成功（active + 到期时间）：才弹成功", async () => {
    api.redeemActivationCode.mockResolvedValueOnce({
      membership: {
        active: true,
        expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400,
        remainingDays: 30,
        planLabel: "月卡",
      },
      addedDays: 30,
      planLabel: "月卡",
    })
    act(() => {
      root.render(<ActivationCodeForm />)
    })
    await typeCode("QMAI-7K2M-9XQP-3RTB-VWXZ")
    await act(async () => {
      buttonByText("兑换").click()
    })

    expect(toastMock.success).toHaveBeenCalledTimes(1)
    expect(useAccountStore.getState().user?.membership?.active).toBe(true)
  })
})

describe("重新读取会员状态：断网不得显示成功", () => {
  it("断网：提示「读取失败」，不报「已重新读取」", async () => {
    api.fetchMembership.mockRejectedValueOnce(new AccountApiError("NETWORK", undefined, 0))
    act(() => {
      root.render(<MemberGateNotice feature="bookAnalysis" />)
    })
    await act(async () => {
      buttonByText("已开通？刷新会员状态").click()
    })

    expect(toastMock.success).not.toHaveBeenCalled()
    expect(host.textContent).toContain("暂时无法读取会员状态")
  })

  it("读到成功但服务端说未开通：提示「还没查到」，不报成功", async () => {
    api.fetchMembership.mockResolvedValueOnce({
      active: false,
      expiresAt: null,
      remainingDays: 0,
      planLabel: null,
    })
    act(() => {
      root.render(<MemberGateNotice feature="bookAnalysis" />)
    })
    await act(async () => {
      buttonByText("已开通？刷新会员状态").click()
    })

    expect(toastMock.success).not.toHaveBeenCalled()
    expect(host.textContent).toContain("当前账号还没有有效会员")
  })

  it("读到有效会员：才报「会员已生效」", async () => {
    api.fetchMembership.mockResolvedValueOnce({
      active: true,
      expiresAt: Math.floor(Date.now() / 1000) + 10 * 86400,
      remainingDays: 10,
      planLabel: "月卡",
    })
    act(() => {
      root.render(<MemberGateNotice feature="bookAnalysis" />)
    })
    await act(async () => {
      buttonByText("已开通？刷新会员状态").click()
    })

    expect(host.textContent).toContain("会员已生效")
  })
})

it("会员刷新期间切换账号，迟到结果不覆盖新账号", async () => {
  let resolve!: (value: { active: boolean; expiresAt: number; remainingDays: number; planLabel: string; forever: boolean }) => void
  api.fetchMembership.mockReturnValueOnce(new Promise(r => { resolve = r }))
  const pending = useAccountStore.getState().refreshMembership()
  const second = { ...MEMBER_USER, id: 10, email: "second@example.test" }
  useAccountStore.setState({ user: second, session: sessionWith(second) })
  resolve({ active: true, expiresAt: Math.floor(Date.now() / 1000) + 86400, remainingDays: 1, planLabel: "月卡", forever: false })
  expect(await pending).toBe(false)
  expect(useAccountStore.getState().user?.id).toBe(10)
  expect(useAccountStore.getState().user?.membership).toBeUndefined()
})
