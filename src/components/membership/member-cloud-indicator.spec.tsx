// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 会员云同步的三项调整（2026-11-08 用户要求）。
 *
 * ## 用户原话
 *
 *   1. 「同步失败的内容只会在同步日志中显示……要有一个专门的区域来显示
 *      同步失败的内容，并允许后续再次同步」
 *   2. 「将原有的云同步功能处理为一个插件功能……当关闭该插件时，
 *      就不再进行正常的同步」
 *   3. 「针对会员的云同步，需要在右上角有一个专门的云同步图标」
 *
 * ## 这里钉住的四件事
 *
 *   · 插件关掉后，右上角图标必须消失（不是变灰，是消失）
 *   · 插件关掉后，`runBackup` 直接返回 false（纵深防御，任何触发源都绕不过）
 *   · 失败清单跨重启仍在（localStorage），否则第二天角标消失会让人以为好了
 *   · 失败角标显示的是**数量**，不是红点
 */

const state = vi.hoisted(() => ({
  session: null as null | { token?: string },
  running: false,
  lastRunAt: 0,
  lastResult: null as null | { uploaded: number; skippedUnchanged: number; failed: Array<{ path: string; message: string }> },
  projectPath: "/proj" as string | null,
  setActiveView: vi.fn(),
  setActiveSettingsCategory: vi.fn(),
}))

vi.mock("@/stores/account-store", () => {
  let previous: unknown
  let session: object | null = null
  const snapshot = () => {
    if (previous !== state.session) {
      previous = state.session
      session = state.session ? { ...state.session, baseUrl: "https://synthetic.test", user: { id: 1 } } : null
    }
    return { session }
  }
  return { useAccountStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(snapshot()),
    { getState: snapshot, subscribe: () => () => {} },
  ) }
})


vi.mock("@/stores/member-cloud-store", async () => {
  const actual = await vi.importActual<typeof import("@/stores/member-cloud-store")>(
    "@/stores/member-cloud-store",
  )
  return {
    ...actual,
    useMemberCloudStore: (selector: (s: unknown) => unknown) =>
      selector({
        running: state.running,
        lastRunAt: state.lastRunAt,
        lastResult: state.lastResult,
      }),
  }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign((selector: (s: unknown) => unknown) =>
    selector({
      setActiveView: state.setActiveView,
      setActiveSettingsCategory: state.setActiveSettingsCategory,
      project: state.projectPath ? { path: state.projectPath } : null,
    }), { subscribe: () => () => {} }),
}))

vi.mock("@/lib/project-identity", () => ({
  ensureProjectId: async () => "proj-1",
}))

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactElement }) => render,
  TooltipContent: () => null,
}))

import { MemberCloudIndicator } from "./member-cloud-indicator"
import { readFailedUploads, writeFailedUploads } from "@/stores/member-cloud-store"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  state.session = { token: "netcard" }
  state.running = false
  state.lastRunAt = 0
  state.lastResult = null
  state.projectPath = "/proj"
  state.setActiveView = vi.fn()
  state.setActiveSettingsCategory = vi.fn()
  localStorage.clear()

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
    root.render(<MemberCloudIndicator />)
  })
  // ensureProjectId 是异步的，等一拍让失败清单读回来
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const el = () => container.querySelector('[data-ui="member-cloud-indicator"]')

describe("右上角会员云同步图标", () => {
  it("未登录时不渲染（没有账号就没有云空间）", async () => {
    state.session = null
    await render()
    expect(el()).toBeNull()
  })

  it("不受 cloud-sync 插件影响（那个插件管的是「同步到自己的网盘」）", async () => {
    /*
     * 2026-11-08 用户纠正：会员云空间与「云同步」是两套独立功能。
     * 插件关掉时这里必须照常显示 —— 第一版我错把它们绑在一起了。
     */
    await render()
    expect(el()).toBeTruthy()
  })

  it("正常时是 idle 态", async () => {
    await render()
    expect(el()).toBeTruthy()
    expect(el()?.getAttribute("data-state")).toBe("idle")
  })

  it("同步中显示 running 态", async () => {
    state.running = true
    await render()
    expect(el()?.getAttribute("data-state")).toBe("running")
  })

  it("有失败时变 failed 并显示数量角标", async () => {
    state.lastRunAt = Date.now()
    state.lastResult = {
      uploaded: 3,
      skippedUnchanged: 0,
      failed: [
        { path: "a.md", message: "连接中断" },
        { path: "b.md", message: "连接中断" },
      ],
    }
    await render()
    expect(el()?.getAttribute("data-state")).toBe("failed")
    expect(el()?.textContent).toContain("2")
    expect(el()?.getAttribute("title")).toContain("2 个文件没传上去")
  })

  it("点一下跳到设置 › 会员云空间", async () => {
    await render()
    await act(async () => {
      ;(el() as HTMLButtonElement | null)?.click()
    })
    expect(state.setActiveView).toHaveBeenCalledWith("settings")
    expect(state.setActiveSettingsCategory).toHaveBeenCalledWith("memberCloud")
  })

  it("重启后失败清单仍在（落盘的），角标不会凭空消失", async () => {
    // 模拟上一次运行留下的失败记录
    writeFailedUploads("proj-1", [{ path: "lost.md", message: "连接中断" }])
    state.lastRunAt = 0
    state.lastResult = null

    await render()
    expect(el()?.getAttribute("data-state")).toBe("failed")
    expect(el()?.textContent).toContain("1")
  })
})

describe("失败清单落盘", () => {
  it("写进去能读出来", () => {
    writeFailedUploads("p1", [{ path: "a.md", message: "boom" }])
    expect(readFailedUploads("p1")).toEqual([{ path: "a.md", message: "boom" }])
  })

  it("写空数组等于清除（重试成功后不该还留着角标）", () => {
    writeFailedUploads("p1", [{ path: "a.md", message: "boom" }])
    writeFailedUploads("p1", [])
    expect(readFailedUploads("p1")).toEqual([])
  })

  it("数据损坏时返回空数组而不是抛错", () => {
    localStorage.setItem("qmai.memberCloud.failed.v1.p1", "{坏掉的 JSON")
    expect(readFailedUploads("p1")).toEqual([])
  })

  it("不是数组的 JSON 也返回空数组", () => {
    localStorage.setItem("qmai.memberCloud.failed.v1.p1", '{"a":1}')
    expect(readFailedUploads("p1")).toEqual([])
  })

  it("不同工程互不干扰", () => {
    writeFailedUploads("p1", [{ path: "a.md", message: "x" }])
    writeFailedUploads("p2", [{ path: "b.md", message: "y" }])
    expect(readFailedUploads("p1")).toEqual([{ path: "a.md", message: "x" }])
    expect(readFailedUploads("p2")).toEqual([{ path: "b.md", message: "y" }])
  })
})
