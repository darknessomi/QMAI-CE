import { useCallback, useEffect, useState } from "react"
import { LayoutGrid, List, Plus, X } from "lucide-react"

import { AddPluginDialog, type AddPluginMode } from "@/components/plugins/add-plugin-dialog"
import { BuiltinPluginCard } from "@/components/plugins/builtin-plugin-card"
import { BuiltinPluginRow } from "@/components/plugins/builtin-plugin-row"
import { ConfigForm } from "@/components/plugins/ConfigForm"
import { InstalledRow } from "@/components/plugins/installed-row"
import { SlotActions } from "@/components/plugins/SlotActions"
import { ContentPackBrowser } from "@/components/plugins/ContentPackBrowser"
import { Button } from "@/components/ui/button"
import { pluginsApi } from "@/lib/plugins/api"
import { declarativePluginsApi, usePluginSlotIndex } from "@/lib/plugins/declarative/api"
import { defaultTargetApplier } from "@/components/plugins/ActionDialog"
import type { ContentPackItem, OutputTarget } from "@/lib/plugins/declarative/types"
import { BUILTIN_PLUGINS } from "@/lib/plugins/builtin"
import { setBuiltinPluginEnabled } from "@/lib/plugins/builtin-state"
import type { PluginSummary } from "@/lib/plugins/types"
import { useBuiltinPluginsState } from "@/lib/plugins/use-builtin-plugins"
import { toast } from "@/lib/toast"

/**
 * 内置插件的显示方式。
 *
 * 两种视图各有各的用处（见 `builtin-plugin-card.tsx` 顶部注释），所以做成可切换，
 * 而不是替用户做主选一个。选择存 localStorage：这是纯粹的显示偏好，
 * 不跟项目走 —— 换一本书不该让插件页突然变个样子。
 */
export type BuiltinLayout = "grid" | "list"

const BUILTIN_LAYOUT_KEY = "qmai-builtin-plugins-layout-v1"

function readBuiltinLayout(): BuiltinLayout {
  try {
    const raw = localStorage.getItem(BUILTIN_LAYOUT_KEY)
    return raw === "grid" ? "grid" : "list"
  } catch {
    // 存储不可用（隐私模式 / 测试环境）时退回列表：信息更完整，是更安全的默认。
    return "list"
  }
}

function writeBuiltinLayout(layout: BuiltinLayout): void {
  try {
    localStorage.setItem(BUILTIN_LAYOUT_KEY, layout)
  } catch {
    // 存不进去不影响本次会话（state 已更新），也不值得弹一个用户无法处理的提示。
  }
}

export function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "string") return cause
  return "未知错误"
}

/** 读 `preview` 里的 configSchema；没有就返回 undefined（InstalledRow 据此决定显不显示「设置」）。 */
export function previewConfigSchema(preview: unknown): unknown {
  if (!preview || typeof preview !== "object") return undefined
  const record = preview as Record<string, unknown>
  return record.configSchema
}

export function PluginCenterView() {
  const [installed, setInstalled] = useState<PluginSummary[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addMode, setAddMode] = useState<AddPluginMode>("url")
  const [configFor, setConfigFor] = useState<PluginSummary | null>(null)

  const refreshInstalled = useCallback(async () => {
    try {
      setInstalled(await pluginsApi.list())
    } catch (cause) {
      console.warn("[plugins] 读取已安装列表失败：", cause)
    }
  }, [])

  useEffect(() => {
    void refreshInstalled()
  }, [refreshInstalled])

  const togglePlugin = async (plugin: PluginSummary, next: boolean) => {
    setBusyId(plugin.id)
    try {
      if (next) {
        // 授予「清单里申请的权限」——传空数组会让插件拿不到读项目的资格（后端会照实拒绝）。
        await pluginsApi.enable(plugin.id, plugin.declaredPermissions ?? [])
      } else {
        await pluginsApi.disable(plugin.id)
      }
      await refreshPluginState()
    } catch (cause) {
      toast.error(describeError(cause))
    } finally {
      setBusyId(null)
    }
  }

  const uninstallPlugin = async (plugin: PluginSummary) => {
    if (!window.confirm(`确定卸载「${plugin.name || plugin.id}」吗？插件自己的数据会保留。`)) return
    setBusyId(plugin.id)
    try {
      await pluginsApi.uninstall(plugin.id, false)
      toast.success("已卸载")
      await refreshPluginState()
    } catch (cause) {
      toast.error(describeError(cause))
    } finally {
      setBusyId(null)
    }
  }

  const openAddDialog = (mode: AddPluginMode) => {
    setAddMode(mode)
    setAddOpen(true)
  }

  /*
   * 内置插件的开关状态：应用级（localStorage），不跟项目走。
   * 一次订阅整张表，避免 4 行各自订阅一次；`builtinOn` 用来算分区标题右侧的计数。
   */
  const builtinState = useBuiltinPluginsState()
  /*
   * 插件的界面能力（`plugin-center` 插槽）。
   *
   * 这一区是**插件唯一的可操作入口**：声明式 action（如「生成书名」）会在这里
   * 出现成按钮。它原来挂在设置页的 PluginSection 里，而那个组件在
   * 「插件统一收进创作者中心」之后已无人渲染 —— 于是新装的插件虽然显示"运行中"，
   * 用户却找不到任何地方点它。功能再完整，没有入口就等于没装。
   */
  const pluginSlots = usePluginSlotIndex()
  const centerSlot = pluginSlots.index["plugin-center"]
  const hasCenterAbilities = centerSlot.actions.length > 0 || centerSlot.packs.length > 0

  /*
   * 插件状态变化后，**能力区必须跟着刷新**。
   *
   * 之前卸载插件只刷新了「已安装」列表（`plugins_list`），没有刷新插槽索引
   * （`plugins_actions`）—— 于是插件已经卸载、目录都删了，「插件能力」里那个
   * 按钮还在，点它只会报错。用户看到的是"卸载了却还在"，而界面没有任何自愈迹象。
   *
   * 卸载、启用、停用、安装，四种状态变化都会影响"有哪些能力可用"，
   * 所以统一走这一个函数，避免以后新增一种操作又漏刷。
   */
  const refreshPluginState = useCallback(async () => {
    await refreshInstalled()
    pluginSlots.reload()
  }, [refreshInstalled, pluginSlots])

  /*
   * 内容包浏览器的两个依赖。
   * `loadItems` 收的是合成键（`<pluginId>/<packId>`），不是包内 id ——
   * 宿主的取条目命令只认前者。
   */
  const loadPackItems = useCallback(
    (loadKey: string) => declarativePluginsApi.contentPackItems(loadKey),
    [],
  )
  const applyPackItem = useCallback(async (item: ContentPackItem, target: OutputTarget) => {
    await defaultTargetApplier(target, { kind: "text", text: item.body })
  }, [])
  const [builtinView, setBuiltinView] = useState<BuiltinLayout>(() => readBuiltinLayout())
  const setBuiltinViewMode = useCallback((next: BuiltinLayout) => {
    setBuiltinView(next)
    writeBuiltinLayout(next)
  }, [])
  const builtinOn = BUILTIN_PLUGINS.filter((plugin) => builtinState[plugin.id]).length

  return (
    /*
     * `data-ui-page="plugins"` 是**路由标记**：`content-area` 的 routing 测试与
     * UI 测试壳都按它确认「当前渲染的是插件页，而不是掉进 default 的 AI 会话」。
     * 没有它，页面能画出来但自动化测试会认不出这一页 —— 这是上一版就有、
     * 重做视觉时不能丢的东西。
     */
    <div data-ui-page="plugins" className="flex h-full min-h-0 flex-col overflow-y-auto">
      <header className="flex flex-wrap items-start justify-between gap-3 px-6 pb-4 pt-6">
        <div>
          <h1 className="text-xl font-semibold">插件</h1>
          <p className="mt-1 text-sm text-muted-foreground">安装、启用和配置插件</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            data-plugins-manual="true"
            onClick={() => openAddDialog("url")}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            添加插件
          </Button>
        </div>
      </header>

      {/*
        「内置插件」分区放在「已安装」**之上**：内置是软件自带的，用户一进插件页
        最该先看到的是"我本来就有哪些功能、现在开了哪些"，而不是"我还没装什么"。
      */}
      <section aria-labelledby="plugins-builtin" className="px-6">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <h2 id="plugins-builtin" className="text-sm font-medium">
              内置插件
            </h2>
            <span data-builtin-summary="true" className="text-xs text-muted-foreground">
              共 {BUILTIN_PLUGINS.length} 个 · 已开启 {builtinOn} 个
            </span>
          </div>
          {/*
            视图切换。两种视图不是谁替代谁：
              · 列表 — 描述与"关闭后会发生什么"完整可读，适合"我要关掉某个功能"；
              · 网格 — 图标与名字一屏扫完，适合"我有哪些、哪些开着"。
            选择记在 localStorage，用户下次进来还是同一个视图。
          */}
          <div
            className="flex shrink-0 items-center gap-0.5 rounded-lg border p-0.5"
            role="group"
            aria-label="内置插件显示方式"
          >
            <Button
              type="button"
              size="sm"
              variant={builtinView === "grid" ? "secondary" : "ghost"}
              className="h-7 px-2"
              aria-pressed={builtinView === "grid"}
              data-builtin-view="grid"
              title="九宫格显示"
              onClick={() => setBuiltinViewMode("grid")}
            >
              <LayoutGrid className="h-4 w-4" />
              <span className="sr-only">九宫格显示</span>
            </Button>
            <Button
              type="button"
              size="sm"
              variant={builtinView === "list" ? "secondary" : "ghost"}
              className="h-7 px-2"
              aria-pressed={builtinView === "list"}
              data-builtin-view="list"
              title="列表显示"
              onClick={() => setBuiltinViewMode("list")}
            >
              <List className="h-4 w-4" />
              <span className="sr-only">列表显示</span>
            </Button>
          </div>
        </div>

        {/*
          ⚠️ 诚实性说明，不能删、不能改软。
          内置插件**不是真的卸载**：代码仍在安装包里、磁盘占用不变、也不能单独分发。
          关掉只是让入口消失、功能不加载。不写清这句，用户会以为"关掉 = 卸掉了"，
          然后惊讶于"卸载了怎么还占空间"。
        */}
        <p
          data-builtin-notice="true"
          className="mb-3 rounded-lg border border-dashed px-3 py-2 text-xs leading-relaxed text-muted-foreground"
        >
          内置插件随软件提供，可以关闭但不占用额外空间，也不能卸载。
        </p>

        {builtinView === "grid" ? (
          <ul
            data-builtin-layout="grid"
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
          >
            {BUILTIN_PLUGINS.map((plugin) => (
              <BuiltinPluginCard
                key={plugin.id}
                plugin={plugin}
                enabled={builtinState[plugin.id]}
                onToggle={(next) => setBuiltinPluginEnabled(plugin.id, next)}
              />
            ))}
          </ul>
        ) : (
          <ul data-builtin-layout="list" className="space-y-2">
            {BUILTIN_PLUGINS.map((plugin) => (
              <BuiltinPluginRow
                key={plugin.id}
                plugin={plugin}
                enabled={builtinState[plugin.id]}
                onToggle={(next) => setBuiltinPluginEnabled(plugin.id, next)}
              />
            ))}
          </ul>
        )}
      </section>

      {/*
        「插件能力」——**插件的可操作入口**。
        声明式 action 在这里长成按钮（如「生成书名」），点开就是表单 + 调模型 + 出结果。
        没有这一区，用户装了插件之后会看到"运行中"却找不到任何地方点它 ——
        这正是本次修掉的问题：功能完整但没有入口，等于没装。
      */}
      <section aria-labelledby="plugins-abilities" className="mt-6 px-6">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <h2 id="plugins-abilities" className="text-sm font-medium">
              插件能力
            </h2>
            {hasCenterAbilities ? (
              <span className="text-xs text-muted-foreground">
                {centerSlot.actions.length + centerSlot.packs.length} 项可用
              </span>
            ) : null}
          </div>
          {pluginSlots.degraded ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => pluginSlots.reload()}>
              重新读取
            </Button>
          ) : null}
        </div>

        {pluginSlots.loading ? (
          <div
            role="status"
            className="rounded-lg border border-dashed px-4 py-4 text-sm text-muted-foreground"
          >
            正在读取插件能力…
          </div>
        ) : hasCenterAbilities ? (
          <div data-plugin-abilities="true" className="space-y-3">
            <SlotActions entries={centerSlot.actions} variant="toolbar" />
            {centerSlot.packs.length > 0 ? (
              <ContentPackBrowser
                packs={centerSlot.packs}
                loadItems={loadPackItems}
                onUse={applyPackItem}
                actions={centerSlot.actions}
              />
            ) : null}
          </div>
        ) : (
          <div
            data-plugin-abilities="true"
            role="status"
            className="rounded-lg border border-dashed px-4 py-4 text-xs leading-relaxed text-muted-foreground"
          >
            还没有插件提供可操作的能力。装了带<strong>动作</strong>或
            <strong>灵感包</strong>的插件后，按钮会出现在这里。
            <br />
            只提供「工具」的插件（由 AI 在对话里自动调用）不会出现在这里。
          </div>
        )}
      </section>

      <section aria-labelledby="plugins-installed" className="mt-6 px-6 pb-8">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 id="plugins-installed" className="text-sm font-medium">
            已安装
          </h2>
          <span className="text-xs text-muted-foreground">共 {installed.length} 个</span>
        </div>
        {installed.length === 0 ? (
          <div
            role="status"
            className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground"
          >
            还没有安装第三方插件。点击「添加插件」，可从 GitHub 仓库或本地目录安装。
          </div>
        ) : (
          <ul className="space-y-2">
            {installed.map((plugin) => (
              <InstalledRow
                key={plugin.id}
                plugin={plugin}
                busy={busyId === plugin.id}
                onToggle={(target, next) => void togglePlugin(target, next)}
                onConfigure={setConfigFor}
                onUninstall={(target) => void uninstallPlugin(target)}
              />
            ))}
          </ul>
        )}
      </section>

      <AddPluginDialog
        open={addOpen}
        mode={addMode}
        onModeChange={setAddMode}
        onOpenChange={setAddOpen}
        onInstalled={async () => {
          await refreshPluginState()
        }}
      />

      {configFor && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="插件设置"
        >
          <div className="w-full max-w-lg rounded-xl border bg-card p-4 shadow-lg">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-medium">设置 · {configFor.name || configFor.id}</h3>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="关闭"
                onClick={() => setConfigFor(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <ConfigForm
              pluginId={configFor.id}
              pluginName={configFor.name || configFor.id}
              configSchema={previewConfigSchema(configFor.preview)}
              onSaved={() => setConfigFor(null)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
