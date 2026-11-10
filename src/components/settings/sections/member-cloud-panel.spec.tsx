// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RestoreOutcome } from "@/lib/qmai-sync/restore"

/**
 * 会员云空间面板（并入账号页后的双态设计）。
 *
 * ## 2026-11-09 用户要求
 *
 *   「会员用会员的，不是会员要有不是会员的设计」
 *
 * 所以这里钉死的是**两态的差异**，而不只是「渲染出来了」：
 *
 *   会员态 → 金色会员卡 + 金色云空间卡（两列都金）
 *   免费态 → 中性云空间卡 + 金色升级引导卡（金只在一处）
 *
 * 免费态如果云空间也用金，用户会以为「我已经是会员了」，
 * 然后发现额度只有 100 MB —— 落差感比完全不用金更大。
 */

const state = vi.hoisted(() => ({
  isMember: false,
  session: { accessToken: "tok", baseUrl: "https://account.qmai.pro" } as null | object,
  quota: {
    tier: "free",
    usedBytes: 12 * 1024 * 1024,
    usedFiles: 12,
    limitBytes: 100 * 1024 * 1024,
    limitFiles: 2000,
  } as null | {
    tier: string
    usedBytes: number
    usedFiles: number
    limitBytes: number
    limitFiles: number
  },
  failed: [] as Array<{ path: string; message: string }>,
  restored: null as RestoreOutcome | null,
  restoreError: null as string | null,
  projectPath: "/proj" as string | null,
}))

vi.mock("@/lib/membership/use-membership", () => ({
  useMembership: () => ({
    active: state.isMember,
    membership: state.isMember
      ? { active: true, expiresAt: 4_100_000_000, remainingDays: 30, planLabel: "月卡", forever: false }
      : null,
    user: { id: 1, email: "u@e.com" },
  }),
}))

vi.mock("@/lib/membership/purchase-channels", () => ({
  PLAN_DISPLAYS: [{ id: "month", name: "月卡", price: 39, pricePerMonth: 39 }],
}))

vi.mock("@/stores/account-store", () => ({
  useAccountStore: Object.assign((sel: (s: unknown) => unknown) =>
    sel({ session: state.session, refreshMembership: vi.fn(async () => true) }),
    { getState: () => ({ session: null }), subscribe: () => () => {} }),
}))

vi.mock("@/stores/sync-quota-store", async () => {
  const actual = await vi.importActual<typeof import("@/stores/sync-quota-store")>(
    "@/stores/sync-quota-store",
  )
  return {
    ...actual,
    useSyncQuotaStore: (sel: (s: unknown) => unknown) =>
      sel({ quota: state.quota, error: null, refresh: vi.fn(async () => {}) }),
  }
})

vi.mock("@/stores/member-cloud-store", async () => {
  const actual = await vi.importActual<typeof import("@/stores/member-cloud-store")>(
    "@/stores/member-cloud-store",
  )
  return {
    ...actual,
    useMemberCloudStore: (sel: (s: unknown) => unknown) =>
      sel({
        autoEnabled: true,
        setAutoEnabled: vi.fn(),
        running: false,
        lastRunAt: 0,
        lastResult: state.failed.length ? { failed: state.failed } : null,
        lastError: null,
        runBackup: vi.fn(async () => {}),
        runRestore: vi.fn(async () => {}),
        lastRestore: state.restored,
        lastRestoreError: state.restoreError,
      }),
    readFailedUploads: () => state.failed,
  }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign((sel: (s: unknown) => unknown) =>
    sel({
      project: state.projectPath ? { path: state.projectPath } : null,
      setActiveView: vi.fn(),
      setActiveSettingsCategory: vi.fn(),
    }), { subscribe: () => () => {} }),
}))

vi.mock("@/lib/project-identity", () => ({ ensureProjectId: async () => "proj-1" }))
vi.mock("@/lib/qmai-sync/client", () => ({ formatBytes: (n: number) => `${Math.round(n / 1048576)} MB` }))
vi.mock("./member-cloud-log-dialog", () => ({
  MemberCloudLogDialog: () => <div data-ui="mock-log-dialog" />,
}))

vi.mock("@/components/membership/member-purchase-dialog", () => ({
  MemberPurchaseDialog: ({ open }: { open: boolean }) =>
    open ? <div data-ui="mock-purchase-dialog" /> : null,
}))

const openMemberCenter = vi.hoisted(() => vi.fn())
vi.mock("@/stores/membership-purchase-store", () => ({ useMembershipPurchaseStore: (selector: (s: { show: typeof openMemberCenter }) => unknown) => selector({ show: openMemberCenter }) }))

import { MemberCloudPanel } from "./member-cloud-panel"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  state.isMember = false
  state.session = { accessToken: "tok", baseUrl: "https://account.qmai.pro" }
  state.quota = {
    tier: "free",
    usedBytes: 12 * 1024 * 1024,
    usedFiles: 12,
    limitBytes: 100 * 1024 * 1024,
    limitFiles: 2000,
  }
  state.failed = []
  state.restored = null
  state.restoreError = null
  state.projectPath = "/proj"

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
    root.render(<MemberCloudPanel />)
  })
  await act(async () => {
    await Promise.resolve()
  })
}

const q = <T extends Element = Element>(sel: string) => container.querySelector<T>(sel)

describe("会员云空间面板 · 免费态", () => {
  it("渲染锁定卡 + 升级引导卡，两列并排", async () => {
    await render()
    // 2026-11-09：会员云空间改成会员专属，免费态不再显示额度卡
    expect(q('[data-ui="member-cloud-locked"]')).toBeTruthy()
    expect(q('[data-ui="member-cloud-upsell"]')).toBeTruthy()
    // 免费态不该有会员卡，也不该有可用的额度卡
    expect(q('[data-ui="member-cloud-vip-card"]')).toBeNull()
    expect(q('[data-ui="member-cloud-space-card"]')).toBeNull()
  })

  it("升级引导卡里写清「扩容到 5 GB」和价格", async () => {
    await render()
    const text = container.textContent ?? ""
    expect(text).toContain("升级会员")
    expect(text).toContain("5 GB")
    expect(text).toContain("¥39")
  })

  it("锁定卡说清「会员专属」，不显示任何额度数字", async () => {
    await render()
    const card = q('[data-ui="member-cloud-locked"]')
    expect(card?.textContent).toContain("会员专属")
    // 关键：不能出现「剩 X MB」这种「你有额度」的暗示
    expect(card?.textContent).not.toMatch(/剩\s*\d/)
    expect(card?.textContent).not.toContain("100 MB")
  })

  it("锁定条不该出现「点了没反应」的禁用备份按钮", async () => {
    await render()
    /*
     * 2026-11-09 方案②：免费态**不再**渲染禁用的「立即备份」按钮。
     *
     * 原来是渲染但 disabled —— 用户会反复去点那个点不动的按钮，
     * 看起来像坏了。现在整块只给一个能用的「开通会员」。
     */
    expect(q('[data-ui="member-cloud-backup"]')).toBeNull()
    expect(q<HTMLButtonElement>('[data-ui="member-cloud-open-purchase"]')?.disabled).toBe(false)
  })

  it("免费态不显示失败块（没有同步就没有失败）", async () => {
    state.failed = [{ path: "a.md", message: "连接中断" }]
    await render()
    expect(q('[data-ui="member-cloud-failed"]')).toBeNull()
  })

  it("没有失败时不渲染失败块", async () => {
    await render()
    expect(q('[data-ui="member-cloud-failed"]')).toBeNull()
  })
})

describe("会员云空间面板 · 会员态", () => {
  beforeEach(() => {
    state.isMember = true
    state.quota = {
      tier: "member",
      usedBytes: 512 * 1024 * 1024,
      usedFiles: 1204,
      limitBytes: 5 * 1024 * 1024 * 1024,
      limitFiles: 50000,
    }
  })

  it("云备份卡是金色（金色 = 会员身份）", async () => {
    await render()
    const space = q('[data-ui="member-cloud-space-card"]')
    expect(space).toBeTruthy()
    // 金色描边（rgba(245,207,107,…)）
    expect(space?.className).toContain("member-gold-surface")
  })

  it("会员态不显示升级引导卡", async () => {
    await render()
    expect(q('[data-ui="member-cloud-upsell"]')).toBeNull()
  })

  /*
   * 「剩余天数 / 到期时间」的断言已移到 account-section.spec.tsx。
   *
   * 2026-11-09 方案 B：会员卡**合并进了账号主卡** —— 头像、邮箱、
   * 剩余天数、到期时间、云空间本来就是「我的会员身份」的不同侧面，
   * 拆成两张卡会让用户看到两处都在说会员。云备份面板现在只管云功能，
   * 不再重复会员时长。
   */
  it("云空间卡显示会员额度 5 GB", async () => {
    await render()
    const text = q('[data-ui="member-cloud-space-card"]')?.textContent ?? ""
    expect(text).toContain("5120 MB") // 5 GB
  })
})

describe("会员云空间面板 · 共用部分", () => {
  it("未登录时不渲染", async () => {
    state.session = null
    await render()
    expect(q('[data-ui="member-cloud-panel"]')).toBeNull()
  })

  it("只有会员才有自动同步开关、恢复、日志", async () => {
    // 免费态：控制区整块不渲染
    state.isMember = false
    await render()
    expect(q('[data-ui="member-cloud-controls"]')).toBeNull()
    expect(q('[data-ui="member-cloud-auto-switch"]')).toBeNull()
    expect(q('[data-ui="member-cloud-restore"]')).toBeNull()

    // 会员态：三样都在
    state.isMember = true
    await render()
    expect(q('[data-ui="member-cloud-controls"]')).toBeTruthy()
    expect(q('[data-ui="member-cloud-auto-switch"]')).toBeTruthy()
    expect(q('[data-ui="member-cloud-restore"]')).toBeTruthy()
    expect(q('[data-ui="member-cloud-open-log"]')).toBeTruthy()
  })

  it("没有打开的作品时备份按钮禁用", async () => {
    state.isMember = true
    state.projectPath = null
    await render()
    expect(q<HTMLButtonElement>('[data-ui="member-cloud-backup"]')?.disabled).toBe(true)
  })
})

describe("会员云空间面板 · 续费 / 开通入口（2026-11-09）", () => {
  /*
   * 第一版这两个按钮是「切到账号页的会员区」—— 用户已经在账号页了，
   * 等于点了一个没反应的按钮。现在直接打开购买弹窗。
   */
  it("免费态点「立即开通」会打开购买弹窗", async () => {
    state.isMember = false
    await render()

    expect(q('[data-ui="mock-purchase-dialog"]')).toBeNull()
    const btn = q<HTMLButtonElement>('[data-ui="member-cloud-open-purchase"]')
    expect(btn).toBeTruthy()

    await act(async () => {
      btn!.click()
    })

    expect(openMemberCenter).toHaveBeenCalledWith("cloudBackup")
  })

  /*
   * 会员态的「续费 / 顺延」已移到账号主卡（2026-11-09 方案 B）。
   *
   * 理由同「剩余天数」那条：会员续费属于**身份**操作，放在账号主卡里
   * 与「我还剩多久」在一起，用户不用在两处找续费入口。
   * 这里只保留免费态的「开通会员 / 选择套餐」—— 那是说服新用户开通，
   * 与云功能的使用场景贴在一起最合适。
   */
})

describe("恢复结果保护提示", () => {
  it("显示原文件保留、副本位置及部分失败明细", async () => {
    state.isMember = true
    state.restored = {
      restored: 1, skippedNewer: 0, totalBytes: 6, remoteTotal: 2,
      conflicts: [{ path: "chapter.md", savedPath: ".qmai/restores/synthetic/chapter.md" }],
      failed: [{ path: "other.md", message: "磁盘写入失败" }],
    }
    await render()
    const result = q('[data-ui="member-cloud-restore-result"]')
    expect(result?.textContent).toContain("原文件已保留")
    expect(result?.textContent).toContain(".qmai/restores/synthetic/chapter.md")
    expect(result?.textContent).toContain("失败 1 个")
    expect(result?.textContent).toContain("other.md：磁盘写入失败")
  })
  it("检查目录失败会直接显示恢复错误", async () => {
    state.isMember = true; state.restoreError = "目录无法读取，已停止恢复"
    await render()
    expect(q('[role="alert"]')?.textContent).toBe("目录无法读取，已停止恢复")
  })
  it("恢复入口说明同名文件另存副本", async () => {
    state.isMember = true; await render()
    await act(async () => q<HTMLButtonElement>('[data-ui="member-cloud-restore"]')!.click())
    expect(q('[data-ui="member-cloud-restore-panel"]')?.textContent).toContain("本机已有文件会保留")
    expect(q('[data-ui="member-cloud-restore-panel"]')?.textContent).toContain("同名云端文件另存恢复副本")
  })
})
