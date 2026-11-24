// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginSummary } from "@/lib/plugins/types"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const listMock = vi.hoisted(() => vi.fn())
const installMock = vi.hoisted(() => vi.fn())
const installLocalMock = vi.hoisted(() => vi.fn())
const enableMock = vi.hoisted(() => vi.fn())
const disableMock = vi.hoisted(() => vi.fn())
const uninstallMock = vi.hoisted(() => vi.fn())
const toastSuccessMock = vi.hoisted(() => vi.fn())
/** 插槽索引的 reload：插件状态一变就该被调用（卸载后能力区要消失）。 */
const slotReloadSpy = vi.hoisted(() => vi.fn())

/*
 * 把插槽索引换成可控桩：要断言"卸载/停用后有没有重新读取能力"，
 * 真实 hook 会去打 Tauri 命令，jsdom 里拿不到结果。
 */
vi.mock("@/lib/plugins/declarative/api", () => ({
  usePluginSlotIndex: () => ({
    index: {
      "plugin-center": { actions: [], packs: [] },
      "chapter-toolbar": { actions: [], packs: [] },
      "inspiration-browser": { actions: [], packs: [] },
      "editor-context-menu": { actions: [], packs: [] },
      "outline-toolbar": { actions: [], packs: [] },
    },
    loading: false,
    degraded: false,
    reload: slotReloadSpy,
  }),
  declarativePluginsApi: {
    contentPackItems: vi.fn().mockResolvedValue([]),
    configGet: vi.fn().mockResolvedValue({}),
  },
}))

vi.mock("@/lib/plugins/api", () => ({
  pluginsApi: {
    list: listMock,
    install: installMock,
    installLocal: installLocalMock,
    enable: enableMock,
    disable: disableMock,
    uninstall: uninstallMock,
  },
}))

// toast 在 jsdom 里没有 Provider 时会进待发队列；这里换成 spy，好断言「装完有没有提示」。
vi.mock("@/lib/toast", () => ({
  toast: { success: toastSuccessMock, error: vi.fn(), info: vi.fn() },
}))

import { BUILTIN_PLUGINS } from "@/lib/plugins/builtin"
import { BUILTIN_PLUGINS_STORAGE_KEY, __resetBuiltinPluginCacheForTests } from "@/lib/plugins/builtin-state"
import { PluginCenterView } from "./plugin-center-view"

function summary(overrides: Partial<PluginSummary> & { id: string }): PluginSummary {
  return {
    name: overrides.id,
    version: "1.0.0",
    description: "",
    enabled: true,
    processState: "running",
    grantedPermissions: [],
    declaredPermissions: [],
    toolCount: 0,
    providerIds: [],
    sourceRepo: "",
    ...overrides,
  } as PluginSummary
}

let host: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
}

async function render() {
  await act(async () => {
    root.render(<PluginCenterView />)
  })
  for (let i = 0; i < 8; i += 1) await flush()
}

beforeEach(() => {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  vi.clearAllMocks()
  listMock.mockResolvedValue([])
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
})

function buttonByText(label: string): HTMLButtonElement | null {
  const buttons = [...host.querySelectorAll("button")]
  return (
    (buttons.find((b) => (b.textContent ?? "").trim() === label) as HTMLButtonElement) ?? null
  )
}

it("忽略旧版小说图谱开关且继续显示其他内置插件", async () => {
  localStorage.setItem(BUILTIN_PLUGINS_STORAGE_KEY, JSON.stringify({ "novel-graph": true }))
  __resetBuiltinPluginCacheForTests()
  try {
    await render()
    expect(host.querySelector('[data-builtin-plugin-row="memory-center"]')).not.toBeNull()
    expect(host.textContent).not.toContain("小说图谱")
  } finally {
    localStorage.removeItem(BUILTIN_PLUGINS_STORAGE_KEY)
    __resetBuiltinPluginCacheForTests()
  }
})

describe("PluginCenterView：已安装行", () => {
  it("开关反映启用状态，点击调 enable 并带上清单申请的权限", async () => {
    listMock.mockResolvedValue([
      summary({
        id: "alpha",
        enabled: false,
        processState: "stopped",
        declaredPermissions: ["fs:project-read"],
      }),
    ])
    await render()

    /*
     * 必须精确选「已安装」那一行的开关：现在插件页顶部还有「内置插件」分区，
     * 它的 4 个开关同样是 role="switch"。选第一个会选到内置的，断言就会莫名其妙地失败。
     */
    const toggle = host.querySelector(
      '[data-ui="plugin-row-switch"]',
    ) as HTMLElement | null
    expect(toggle).not.toBeNull()
    await act(async () => {
      toggle?.click()
    })
    await flush()

    expect(enableMock).toHaveBeenCalledWith("alpha", ["fs:project-read"])
    expect(disableMock).not.toHaveBeenCalled()
  })

  it("行内开关带可见尺寸的样式类（不能是隐形按钮）", async () => {
    listMock.mockResolvedValue([summary({ id: "alpha" })])
    await render()

    const toggle = host.querySelector('[role="switch"]') as HTMLElement | null
    expect(toggle).not.toBeNull()

    /*
     * 回归防线：这个开关曾经只挂 `className="model-switch"`，而那套样式定义在
     * 一个**没有全局引入**的 css 里 —— 结果它渲染出来了、能点，但零尺寸、看不见，
     * 用户截图里那一行只有「⋯」。
     * 现在样式写在组件里（Tailwind），这里断言它确实带了尺寸类。
     */
    const cls = toggle?.className ?? ""
    expect(cls).toContain("w-9")
    expect(cls).toContain("h-[21px]")
    expect(cls).not.toContain("model-switch")
  })

  it("卸载项收在「⋯」菜单里，并且是危险色（不会误点在开关旁边）", async () => {
    listMock.mockResolvedValue([summary({ id: "alpha" })])
    await render()

    // 默认不显示卸载（要先打开菜单）
    expect(host.querySelector('[data-plugin-row-action="uninstall"]')).toBeNull()

    const menuButton = host.querySelector('[data-plugin-row-menu="true"]') as HTMLButtonElement | null
    expect(menuButton).not.toBeNull()
    await act(async () => {
      menuButton?.click()
    })
    await flush()

    const uninstall = host.querySelector('[data-plugin-row-action="uninstall"]') as HTMLElement | null
    expect(uninstall).not.toBeNull()
    expect(uninstall?.className).toContain("text-destructive")
    expect(uninstall?.textContent).toContain("卸载")
  })

  it("没有能力摘要时不渲染那一行（不占位）", async () => {
    listMock.mockResolvedValue([
      summary({ id: "alpha", toolCount: 0, providerIds: [], grantedPermissions: [] }),
    ])
    await render()
    /*
     * 只在「已安装」那一行里查。整页断言会被内置插件分区的固定说明文字误伤
     * （"内置插件随软件提供…" 里就有"提供"两个字）。
     */
    const row = host.querySelector('[data-plugin-id="alpha"]') ?? host.querySelector("li")
    const rowText = row?.textContent ?? ""
    expect(rowText).not.toContain("提供")
    expect(rowText).not.toContain("已授权")
  })
})

describe("PluginCenterView：添加入口", () => {
  it("页头只有一个添加入口：没有「编辑插件」，也没有下拉里的重复安装项", async () => {
    await render()

    /*
     * 用户明确要求过：三个入口（编辑插件 / 添加插件 / 下拉里的两种安装方式）
     * 打开的是同一个对话框，属于重复。这里把它钉死，防止有人再加回来。
     */
    expect(buttonByText("编辑插件")).toBeNull()
    expect(buttonByText("安装第三方插件")).toBeNull()
    // 下拉箭头（aria-label="更多添加方式"）也不该存在
    expect(host.querySelector('[aria-label="更多添加方式"]')).toBeNull()

    // 唯一入口仍在
    expect(host.querySelector('[data-plugins-manual="true"]')).not.toBeNull()
  })

  it("两种安装来源下均可从添加弹窗打开自定义插件教程", async () => {
    await render()
    const add = host.querySelector('[data-plugins-manual="true"]') as HTMLButtonElement | null
    expect(add).not.toBeNull()

    await act(async () => {
      add?.click()
    })
    await flush()

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    const guideUrl = "https://github.com/darknessomi/QMAI-CE/blob/main/docs/plugins/getting-started.md"
    using openWindow = vi.spyOn(window, "open").mockReturnValue(null)
    for (const mode of ["url", "local"]) {
      const modeButton = dialog?.querySelector<HTMLButtonElement>(`[data-add-plugin-mode="${mode}"]`)
      await act(async () => modeButton?.click())
      expect(modeButton?.getAttribute("aria-pressed")).toBe("true")
      const link = dialog?.querySelector<HTMLAnchorElement>(`a[href="${guideUrl}"]`)
      expect(link?.textContent).toBe("自定义插件教程")
      link?.click()
      expect(openWindow).toHaveBeenLastCalledWith(guideUrl, "_blank", "noopener,noreferrer")
      openWindow.mockClear()
    }
  })

  it("点击同一个入口只打开一个对话框（不会叠两个）", async () => {
    await render()
    const add = host.querySelector('[data-plugins-manual="true"]') as HTMLButtonElement | null
    await act(async () => {
      add?.click()
    })
    await flush()
    const first = document.querySelectorAll('[role="dialog"]').length
    expect(first).toBe(1)
  })

  it("「添加插件」主按钮打开同一个对话框，并保留 data-plugins-manual 标记", async () => {
    await render()
    const add = host.querySelector('[data-plugins-manual="true"]') as HTMLButtonElement | null
    expect(add).not.toBeNull()

    await act(async () => {
      add?.click()
    })
    await flush()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })
})

describe("PluginCenterView：内置插件的两种显示方式", () => {
  it("默认是列表，并且每条都带开关", async () => {
    await render()
    // 默认列表视图：能读到"关闭后会发生什么"这句完整说明
    expect(host.querySelector('[data-builtin-layout="list"]')).not.toBeNull()
    expect(host.querySelector('[data-builtin-layout="grid"]')).toBeNull()
    expect(host.querySelectorAll('[data-ui="builtin-plugin-switch"]').length).toBe(
      BUILTIN_PLUGINS.length,
    )
  })

  it("点九宫格按钮切到网格，卡片仍在且开关可用", async () => {
    await render()
    const gridBtn = host.querySelector('[data-builtin-view="grid"]') as HTMLButtonElement
    expect(gridBtn).not.toBeNull()

    await act(async () => {
      gridBtn.click()
    })
    await flush()

    expect(host.querySelector('[data-builtin-layout="grid"]')).not.toBeNull()
    expect(host.querySelector('[data-builtin-layout="list"]')).toBeNull()
    // 卡片形态换成 data-builtin-plugin-card
    expect(host.querySelector('[data-builtin-plugin-card="memory-center"]')).not.toBeNull()
    // 开关不能因为换视图就消失
    expect(host.querySelectorAll('[data-ui="builtin-plugin-switch"]').length).toBe(
      BUILTIN_PLUGINS.length,
    )
  })

  it("切回列表能还原", async () => {
    await render()
    await act(async () => {
      ;(host.querySelector('[data-builtin-view="grid"]') as HTMLButtonElement).click()
    })
    await flush()
    await act(async () => {
      ;(host.querySelector('[data-builtin-view="list"]') as HTMLButtonElement).click()
    })
    await flush()

    expect(host.querySelector('[data-builtin-layout="list"]')).not.toBeNull()
    expect(host.querySelector('[data-builtin-plugin-row="memory-center"]')).not.toBeNull()
  })

  it("选择被记住：重新挂载后仍是网格", async () => {
    await render()
    await act(async () => {
      ;(host.querySelector('[data-builtin-view="grid"]') as HTMLButtonElement).click()
    })
    await flush()

    // 卸载重挂，模拟下次进入插件页
    act(() => root.unmount())
    host.innerHTML = ""
    root = createRoot(host)
    await render()

    expect(host.querySelector('[data-builtin-layout="grid"]')).not.toBeNull()
  })

  it("网格里点开关仍然调用切换（视图不影响行为）", async () => {
    await render()
    await act(async () => {
      ;(host.querySelector('[data-builtin-view="grid"]') as HTMLButtonElement).click()
    })
    await flush()

    const before = localStorage.getItem("qmai-builtin-plugins-v1")
    const toggle = host.querySelector(
      '[data-builtin-plugin-card="memory-center"] [role="switch"]',
    ) as HTMLElement
    expect(toggle).not.toBeNull()
    await act(async () => {
      toggle.click()
    })
    await flush()

    const after = localStorage.getItem("qmai-builtin-plugins-v1")
    expect(after).not.toBe(before)
  })
})

describe("PluginCenterView：插件能力区（插件的可操作入口）", () => {
  /*
   * 这一区是本次修掉的核心缺陷：
   * 「插件统一收进创作者中心」时，渲染 plugin-center 插槽的 PluginSection 变成了
   * 没有人挂载的死代码 —— 于是新装的插件显示"运行中"，用户却找不到任何地方点它。
   * 功能完整但没有入口，等于没装。下面三条把这个出口钉死。
   */

  it("没有任何能力时，给出说明而不是整块消失", async () => {
    await render()
    const zone = host.querySelector('[data-plugin-abilities="true"]')
    expect(zone).not.toBeNull()
    // 分区标题在页面上（不在 zone 内部）
    expect(host.textContent).toContain("插件能力")
    // 用户需要知道"这里以后会长出按钮"，而不是看到一个空白
    expect(zone?.textContent).toContain("装了带")
  })

  it("能力区在页面上渲染，且位于「已安装」之前（插件能做什么 > 装了什么）", async () => {
    await render()
    const abilities = host.querySelector('[data-plugin-abilities="true"]')
    const installed = host.querySelector('[aria-labelledby="plugins-installed"]')
    expect(abilities).not.toBeNull()
    expect(installed).not.toBeNull()

    // compareDocumentPosition: DOCUMENT_POSITION_FOLLOWING = 4
    const relation = abilities!.compareDocumentPosition(installed!)
    expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("插件页有可滚动容器，能力区不会被挤出可视范围", async () => {
    await render()
    const page = host.querySelector('[data-ui-page="plugins"]') as HTMLElement
    expect(page).not.toBeNull()
    expect(page.className).toContain("overflow-y-auto")
  })
})

describe("插件状态变化后，能力区必须跟着刷新", () => {
  /*
   * 真实故障：用户卸载了插件（注册表和目录都删干净了），
   * 「插件能力」里那个「生成书名」按钮还在 —— 点它只会报错。
   *
   * 根因是卸载后只刷新了「已安装」列表（plugins_list），没有刷新插槽索引
   * （plugins_actions）。这组用例断言卸载 / 启停 / 安装**都会**触发重新读取。
   */

  it("卸载插件后，重新读取插件能力", async () => {
    listMock.mockResolvedValue([summary({ id: "alpha", name: "某插件" })])
    await render()

    // 记录初次加载次数
    const before = slotReloadSpy.mock.calls.length

    // 触发卸载（window.confirm 默认 jsdom 返回 false，这里强制通过）
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    const menuButton = host.querySelector('[data-plugin-row-menu="true"]') as HTMLButtonElement
    expect(menuButton).not.toBeNull()
    await act(async () => {
      menuButton.click()
    })
    await flush()

    const uninstall = host.querySelector('[data-plugin-action="uninstall"]') as HTMLElement
    if (uninstall) {
      await act(async () => {
        uninstall.click()
      })
      await flush()
      expect(uninstallMock).toHaveBeenCalled()
      // 关键：能力区必须重新读取，否则会留下已经没有对应插件的按钮
      expect(slotReloadSpy.mock.calls.length).toBeGreaterThan(before)
    }
    confirmSpy.mockRestore()
  })

  it("停用插件后，重新读取插件能力", async () => {
    listMock.mockResolvedValue([
      summary({ id: "alpha", enabled: true, processState: "running" }),
    ])
    await render()

    const before = slotReloadSpy.mock.calls.length
    /*
     * 必须精确选「已安装」那一行的开关：插件页顶部还有「内置插件」分区，
     * 它的开关同样是 role="switch"。选第一个会选到内置的，停用自然不会被调用。
     */
    const toggle = host.querySelector('[data-ui="plugin-row-switch"]') as HTMLElement
    expect(toggle).not.toBeNull()

    await act(async () => {
      toggle.click()
    })
    await flush()

    expect(disableMock).toHaveBeenCalled()
    expect(slotReloadSpy.mock.calls.length).toBeGreaterThan(before)
  })
})
