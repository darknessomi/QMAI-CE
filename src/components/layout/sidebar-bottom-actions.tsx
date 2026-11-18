import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { Check, ChevronRight, Palette, Settings, Wrench } from "lucide-react"

import { useWikiStore } from "@/stores/wiki-store"
import { UI_TEST_SKINS } from "@/lib/ui-test"
import { useAppearanceSkin } from "@/components/layout/appearance-context"

// 与 .ui-test-skin-menu 的设计宽度一致（窄了会让「名称 + 说明」换行、看着不像完整菜单）
const MENU_WIDTH = 290

export function SidebarBottomActions() {
  const { t } = useTranslation()
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setSearchPanelOpen = useWikiStore((s) => s.setSearchPanelOpen)
  const appearance = useAppearanceSkin()
  const currentSkin = appearance?.skin ?? "light"
  const [menuOpen, setMenuOpen] = useState(false)
  /** 鼠标是否停在外观子菜单区域上（悬停展开/收起）。 */
  const [appearanceHovered, setAppearanceHovered] = useState(false)
  /** 用户用点击打开/收起的外观子菜单（鼠标移开后再定位）。 */
  const [appearancePinned, setAppearancePinned] = useState(false)
  /** 外观子菜单是否真的显示：默认折叠，悬停中或点击固定住。 */
  const appearanceVisible = appearanceHovered || appearancePinned
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [menuStyle, setMenuStyle] = useState<{
    left: number
    bottom: number
  } | null>(null)

  useEffect(() => {
    if (!menuOpen) {
      setMenuStyle(null)
      return
    }
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const left = Math.min(
        Math.max(4, rect.left),
        Math.max(4, window.innerWidth - MENU_WIDTH - 4),
      )
      /*
       * 菜单**以底边锚定**在触发按钮上方，而不是按估算高度去算 top。
       *
       * 不要给弹层设 max-height / overflow:auto：菜单只有四项（头像 + 外观 + 设置 +
       * 维护工具，约 200px），从来不需要滚；而一旦它变成滚动容器，「外观」右侧的
       * 皮肤子菜单会被裁掉，还会给弹层撑出一条横向滚动条（用户 2026-10-28 截图）。
       * 子菜单要溢出到菜单外面，父级必须是 overflow: visible。
       */
      setMenuStyle({
        left,
        bottom: Math.max(8, window.innerHeight - rect.top + 6),
      })
    }
    updatePosition()
    window.addEventListener("resize", updatePosition)
    return () => window.removeEventListener("resize", updatePosition)
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return
    /*
     * 外部点击关闭。⚠️ 必须放行整个菜单（`.ui-test-avatar-menu`）：
     * 这里注册在**捕获阶段**，指针一按下就先跑；如果只放行旧的 `.ui-test-skin-menu`，
     * 在菜单里点任何一项都会先把菜单关掉，随后的 click 落在空气上 ——
     * 表现就是「这几个功能点了都没反应」（用户 2026-10-28 报的）。
     */
    const outside = (event: PointerEvent) => {
      if (triggerRef.current?.contains(event.target as Node)) return
      if ((event.target as HTMLElement)?.closest?.(".ui-test-avatar-menu")) return
      setMenuOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      setMenuOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener("pointerdown", outside, true)
    document.addEventListener("keydown", escape)
    return () => {
      document.removeEventListener("pointerdown", outside, true)
      document.removeEventListener("keydown", escape)
    }
  }, [menuOpen])

  const openMaintenance = () => {
    setMenuOpen(false)
    setSearchPanelOpen(false)
    setActiveView("maintenance")
  }

  /** 通用设置入口（用户报「点头像后下面没有设置了」——这里是它回来的地方）。 */
  const openGeneralSettings = () => {
    setMenuOpen(false)
    setSearchPanelOpen(false)
    setActiveView("settings")
  }

  /** 选皮肤：切换后立刻收起菜单（折叠的子列表点一下就该生效）。 */
  const selectSkin = (skin: (typeof UI_TEST_SKINS)[number]["id"]) => {
    appearance?.selectSkin(skin)
    setMenuOpen(false)
  }

  return (
      <div
        data-ui="sidebar-bottom-actions"
        className="flex shrink-0 items-center gap-1 border-t py-1 pr-1.5 pl-2.5"
      >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        aria-label="设置与外观"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-ui="sidebar-options"
        className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-0.5 py-1 text-left transition-colors ${
          menuOpen
            ? "bg-accent/60 text-accent-foreground"
            : "hover:bg-accent/50 hover:text-accent-foreground"
        }`}
      >
        <Settings className="size-4" />
        <span>设置与外观</span>
      </button>

      {menuOpen &&
        menuStyle &&
        createPortal(
          <div
            className="ui-test-menu-pop ui-test-avatar-menu"
            style={{
              // 覆盖 .ui-test-menu-pop 的 absolute/top/right，改为按底边锚定的 fixed 弹层
              position: "fixed",
              top: "auto",
              right: "auto",
              left: menuStyle.left,
              bottom: menuStyle.bottom,
              width: MENU_WIDTH,
              // 必须 visible：子菜单要弹到菜单右侧外面去（见 ui-test.css 的说明）
              overflow: "visible",
            }}
            role="menu"
            aria-label="设置与外观"
            data-tauri-drag-region="false"
          >
            {/*
             * 外观：**鼠标移上去就在它右侧弹出**皮肤主题，点击也仍然可以展开/收起。
             *
             * 为什么不做成「下方折叠列表」：菜单是 290px 的窄弹层，皮肤放在下面会把
             * 设置 / 维护工具顶到菜单外面（用户 2026-10-28 报「应该在右侧，不是下方」）。
             * 子菜单定位在 `.ui-avatar-appearance-group` 右侧，由 ui-test.css 负责。
             */}
            <div
              className="ui-avatar-appearance-group"
              onMouseEnter={() => setAppearanceHovered(true)}
              onMouseLeave={() => {
                setAppearanceHovered(false)
                setAppearancePinned(false)
              }}
            >
              <button
                type="button"
                role="menuitem"
                data-ui="sidebar-appearance-entry"
                className="ui-test-menu-item"
                aria-haspopup="menu"
                aria-expanded={appearanceVisible}
                onClick={() => setAppearancePinned((open) => !open)}
              >
                <Palette />
                <span className="ui-test-skin-copy">
                  <span>{t("sidebarActions.appearance")}</span>
                </span>
                <ChevronRight
                  className={`ml-auto h-3.5 w-3.5 shrink-0 transition-transform ${appearanceVisible ? "rotate-90" : ""}`}
                />
              </button>
              <div
                className="ui-avatar-appearance-sub"
                role="menu"
                aria-label={t("sidebarActions.appearance")}
                data-open={appearanceVisible ? "true" : "false"}
              >
                {UI_TEST_SKINS.map((item) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={currentSkin === item.id}
                    className="ui-test-menu-item"
                    key={item.id}
                    data-ui={`sidebar-skin-${item.id}`}
                    onClick={() => selectSkin(item.id)}
                  >
                    <span className={`ui-test-skin-dot ui-test-skin-dot-${item.id}`} />
                    <span className="ui-test-skin-copy">
                      <span>{item.name}</span>
                    </span>
                    {currentSkin === item.id && <Check />}
                  </button>
                ))}
              </div>
            </div>

            {/* 设置入口：从原左下角齿轮搬到这里，避免功能丢失。 */}
            <button
              type="button"
              role="menuitem"
              data-ui="sidebar-settings-entry"
              className="ui-test-menu-item"
              onClick={openGeneralSettings}
            >
              <Settings />
              <span className="ui-test-skin-copy">
                <span>{t("sidebarActions.settings")}</span>
              </span>
            </button>

            <button
              type="button"
              role="menuitem"
              data-ui="sidebar-maintenance-entry"
              className="ui-test-menu-item"
              onClick={openMaintenance}
            >
              <Wrench />
              <span className="ui-test-skin-copy">
                <span>维护工具</span>
              </span>
            </button>

          </div>,
          document.body,
        )}

      </div>
  )
}
