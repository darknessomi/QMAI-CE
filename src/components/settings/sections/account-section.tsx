import { useEffect, useRef, useState, type ChangeEvent } from "react"
import { Check, ChevronRight, ImageUp, KeyRound, LogIn, LogOut, Pencil, UserPlus, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ActivationCodeForm } from "@/components/membership/activation-code-form"
import { useMembershipPurchaseStore } from "@/stores/membership-purchase-store"
import { processAvatarImage } from "@/lib/account/avatar"
import { accountErrorMessage, isAccountApiError } from "@/lib/account/errors"
import { memberExpiryLabel, memberRemainingLabel } from "@/lib/membership/access"
import { useMembership } from "@/lib/membership/use-membership"
import { formatBytes } from "@/lib/qmai-sync/client"
import { toast } from "@/lib/toast"
import { useAccountStore } from "@/stores/account-store"
import { remainingBytes, useSyncQuotaStore, usedRatio } from "@/stores/sync-quota-store"
import { AccountAvatar } from "@/components/account/account-avatar"
import { AccountBenefitsFree } from "./account-benefits-free"
import { MemberCloudPanel } from "./member-cloud-panel"
import { ModelSyncPanel } from "./model-sync-panel"
import {
  ACCOUNT_AVATAR_ACCEPT,
  ACCOUNT_LOGOUT_CONFIRM,
  accountCreatedDate,
  accountDisplayName,
} from "@/components/account/account-display"

const ACCOUNT_DESCRIPTION =
  "登录青幕账号，云同步与后续服务会记在这个账号下。不登录也可以正常写作。"

/** 昵称长度上限，与服务端保持一致（按字符数）。 */
const DISPLAY_NAME_MAX_CHARS = 24
/** 昵称修改冷却：30 天（服务端口径，这里只用于提示下次可改时间）。 */
const NAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000

function nextNameChangeDate(updatedAt: number | null): Date | null {
  if (!updatedAt) return null
  return new Date(updatedAt * 1000 + NAME_CHANGE_COOLDOWN_MS)
}

/* ── 金色主卡的视觉常量 ─────────────────────────────────────
 *
 * 金色 = 会员身份。整页只用在这张卡上：云备份、模型同步都是**功能**，
 * 用中性描边。三处都染金会让用户看不出主次（2026-11-09 用户反馈）。
 */

const GOLD_CARD = "member-gold-surface overflow-hidden rounded-[13px] border"

const GOLD_TEXT = "member-gold-text"
const GOLD_NUM = "member-gold-text"
const GOLD_SUB = "text-muted-foreground"
const GOLD_LINE = "member-gold-line"

const GOLD_BTN_PRIMARY = "member-primary-action font-semibold"

/*
 * `GOLD_BTN_SECONDARY` 已删除（2026-11-09）：
 * 它只服务过「使用兑换码」描边按钮，而那个按钮改成了文字链接。
 * 留着就是一个没人用的常量。
 */

/**
 * 头像外圈（2026-11-09 用户要求补回）。
 *
 * 两层 `box-shadow`：内层白圈做**间隙**，外层是环。
 * 环直接贴在浅黄卡底上会糊成一片，垫一层白才能让环「立起来」。
 */
const RING_VIP = "shadow-[0_0_0_2px_#fff,0_0_0_4px_#f0c056]"
const RING_FREE = "shadow-[0_0_0_2px_#fff,0_0_0_4px_var(--border)]"

function SectionHeader() {
  return (
    <div>
      <h2 className="text-xl font-semibold">账号</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        账号用于云同步与后续服务；本地写作和模型配置始终不受影响。
      </p>
    </div>
  )
}

/**
 * 已登录时的账号主卡（2026-11-09 用户确认方案 B）。
 *
 * ## 结构
 *
 * ```
 * ┌─ ⬤M  Moc [VIP]        管理账号 ⌄ ─┐
 * │    pairy0@sina.com               │
 * ├──────────┬──────────┬────────────┤   ← 会员态才有
 * │ 剩余天数  │ 到期时间  │ 云空间      │
 * │ 60 天     │ 2027/1/8 │ 5.00 GB    │
 * ├──────────┴──────────┴────────────┤
 * │ [续费] [使用兑换码]      重新读取 ›│
 * └──────────────────────────────────┘
 * ```
 *
 * ## 为什么账号操作收进头像栏（用户要求）
 *
 * 「更换头像 / 修改密码 / 修改昵称 / 退出登录」四个动作原来平铺在卡片里，
 * 占了大半屏 —— 但它们是**低频操作**。账号页的主角应该是「我的会员状态」。
 *
 * 收进头像栏后，默认只看到一行身份信息；点头像栏才在下方**就地展开**
 * （不是模态框，也不是浮层）—— 这样上方的「剩余天数 / 到期时间 / 云空间」
 * 仍然可见，用户改完密码抬头就能核对。
 *
 * ## 为什么免费态不显示三数据栏
 *
 * 免费用户的额度是 100MB 且**根本不能用**（服务端会拒）。显示一个用不了的
 * 数字比不显示更糟 —— 用户会以为「我有 100MB」。这里直接换成权益清单，
 * 告诉他能得到什么。
 */
function AccountHero({ user }: { user: NonNullable<ReturnType<typeof useAccountStore.getState>["user"]> }) {
  const session = useAccountStore((state) => state.session)
  const sessionUnverified = useAccountStore((state) => state.sessionUnverified)
  const logout = useAccountStore((state) => state.logout)
  const setAvatar = useAccountStore((state) => state.setAvatar)
  const renameDisplayName = useAccountStore((state) => state.rename)
  const openPasswordPanel = useAccountStore((state) => state.openPasswordPanel)
  const refreshMembership = useAccountStore((state) => state.refreshMembership)
  const refreshSession = useAccountStore((state) => state.refreshSession)

  const { active, membership } = useMembership()
  const quota = useSyncQuotaStore((s) => s.quota)

  const [menuOpen, setMenuOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState("")
  const [nameBusy, setNameBusy] = useState(false)
  const [nameError, setNameError] = useState("")
  const [redeemOpen, setRedeemOpen] = useState(false)
  const openMembership = useMembershipPurchaseStore(s => s.show)
  const didRefreshRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  /*
   * ── 进账号页自动刷新（2026-11-09 取代「重新读取」按钮）──
   *
   * ## 为什么需要
   *
   * 「重新读取」按钮已被用户要求删除：它是「不确定什么时候该点」的按钮 ——
   * 用户不知道自己在等什么更新，点了没变化也不知道算不算成功。
   * 改成本组件挂载时**静默刷新一次**，把主动权从用户手里收回来。
   *
   * ## 两件事一起做
   *
   * · `refreshMembership()` —— 读最新的会员状态。用户在后台补发、
   *   或在另一台设备兑换过，进这一页就能看到。
   * · `refreshSession()` —— 但仅在 `sessionUnverified` 为真时调用。
   *   这个标记由**启动时**的续期失败设上（断网、DNS 冷启动、
   *   Tauri plugin-http 首次初始化等瞬时问题），而在此之前
   *   **没有任何东西会去清它** —— 于是用户明明在线，
   *   账号页却一直挂着「账号服务暂时不可用」，直到他重新登录。
   *
   * ## 只试一次
   *
   * `didRefreshRef` 挡住重复：真断网时不该在每次渲染都打一次请求。
   * 两次都失败就保留原有的提示 —— 那是真的连不上，如实告诉用户。
   */
  useEffect(() => {
    if (didRefreshRef.current) return
    didRefreshRef.current = true
    void refreshMembership().catch(() => {
      // 静默失败：页面其余部分仍然可用，不需要打断用户
    })
    if (sessionUnverified) {
      void refreshSession().catch(() => {
        // 仍然失败就保留「服务暂时不可用」提示 —— 那是真的连不上
      })
    }
  }, [refreshMembership, refreshSession, sessionUnverified])

  const planLabel = membership.planLabel ?? "会员"
  const expiry = memberExpiryLabel(membership)
  const remaining = memberRemainingLabel(membership)
  const remainBytes = quota ? formatBytes(remainingBytes(quota)) : ""
  const usedPercent = quota ? Math.round(usedRatio(quota) * 100) : 0

  const cooldownUntil = nextNameChangeDate(user.displayNameUpdatedAt)
  const cooldownActive = cooldownUntil !== null && cooldownUntil.getTime() > Date.now()

  async function handleLogout() {
    if (loggingOut) return
    if (!window.confirm(ACCOUNT_LOGOUT_CONFIRM)) return
    setLoggingOut(true)
    await logout()
    setLoggingOut(false)
    toast.success("已退出登录")
  }

  async function handleAvatarFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return

    setAvatarBusy(true)
    try {
      const processed = await processAvatarImage(file)
      await setAvatar({ data: processed.data, mime: processed.mime })
      toast.success("头像已更新")
      setMenuOpen(false)
    } catch (error) {
      toast.error(accountErrorMessage(error))
    } finally {
      setAvatarBusy(false)
    }
  }

  function startRename() {
    setNameDraft(accountDisplayName(user.displayName, user.email))
    setNameError("")
    setEditingName(true)
  }

  async function submitRename() {
    const next = nameDraft.trim()
    if (!next) {
      setNameError("昵称不能为空。")
      return
    }
    if (Array.from(next).length > DISPLAY_NAME_MAX_CHARS) {
      setNameError(`昵称最多 ${DISPLAY_NAME_MAX_CHARS} 个字。`)
      return
    }
    if (next === user.displayName) {
      setEditingName(false)
      return
    }
    setNameBusy(true)
    setNameError("")
    try {
      await renameDisplayName(next)
      setEditingName(false)
      setMenuOpen(false)
      toast.success("昵称已更新")
    } catch (error) {
      // 服务端是权威：冷却期内的 429 会带 NAME_LOCKED，这里按文案提示即可
      setNameError(
        isAccountApiError(error) && error.code === "NAME_LOCKED"
          ? "昵称每个月只能修改一次，请在提示的日期之后再试。"
          : accountErrorMessage(error),
      )
    } finally {
      setNameBusy(false)
    }
  }

  /*
   * `refresh()`（「重新读取」按钮的处理函数）已删除（2026-11-09 用户确认）。
   *
   * ## 为什么删
   *
   * 它是「不确定什么时候该点」的按钮：用户不知道自己在等什么更新，
   * 点了没变化也不知道算不算成功。而三个更自然的时机已经覆盖了它：
   *
   *   ① 打开账号页时自动刷新（见上面的 useEffect）
   *   ② 支付成功后自动刷新（dialog 的 onGranted 里调 refreshMembership）
   *   ③ 启动 bootstrap 读一次会话与会员
   *
   * ## 代价
   *
   * 极少数情况下（后台刚补发、页面已打开）要切走再切回来才看到。
   * 可以接受 —— 比留一个让人困惑的按钮好。
   */

  return (
    <>
      <div className={GOLD_CARD} data-ui="membership-section" data-state={active ? "active" : "inactive"} data-ui-role="account-hero">
        {/* ── 头像栏：点击展开账号管理 ── */}
        <button
          type="button"
          className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-white/50 dark:hover:bg-white/5"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-label={menuOpen ? "收起账号管理" : "展开账号管理"}
          data-ui="account-idrow"
        >
          {/*
           * 头像外圈（2026-11-09 用户要求补回）。
           *
           * 会员戴**金环**、免费戴**灰环**。金环用两层 box-shadow：
           * 内层白圈做间隙 —— 金环直接贴在浅黄卡底上会糊成一片，
           * 垫一层白才能让环「立起来」。
           *
           * 免费态不戴金环：金色是「你是会员」的标识，免费用户戴会误导。
           */}
          <span className={`shrink-0 rounded-full ${active ? RING_VIP : RING_FREE}`}>
            <AccountAvatar user={user} baseUrl={session?.baseUrl ?? null} size="lg" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-[0.9375rem] font-bold">
                {accountDisplayName(user.displayName, user.email)}
              </span>
              {/*
               * 会员态只留 VIP 徽标 —— 原来的「已开通」绿标签是冗余
               * （徽标已经说明身份），2026-11-09 用户要求删掉。
               */}
              {active ? (
                <span className="inline-flex shrink-0 items-center rounded bg-gradient-to-b from-[#ffe9a8] via-[#f5cf6b] to-[#dda63a] px-1.5 py-px text-[0.625rem] font-extrabold tracking-wide text-[#3d2a05]">
                  VIP 会员
                </span>
              ) : (
                <span className="inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-px text-[0.625rem] font-normal text-muted-foreground">
                  {membership.expiresAt ? "会员已到期" : "未开通"}
                </span>
              )}
            </span>
            <span className={`block truncate text-[0.71875rem] ${GOLD_SUB}`}>
              {user.email}
              <span className="hidden sm:inline"> · 注册于 {accountCreatedDate(user.createdAt)}</span>
            </span>
          </span>
          <span className={`hidden shrink-0 text-[0.625rem] sm:block ${GOLD_SUB}`}>
            {menuOpen ? "" : "管理账号"}
          </span>
          <ChevronRight
            className={`size-4 shrink-0 transition-transform ${GOLD_TEXT} ${menuOpen ? "rotate-90" : ""}`}
            aria-hidden="true"
          />
        </button>

        {/* ── 账号管理面板：就地展开 ── */}
        {menuOpen ? (
          <div
            className={`border-t bg-white/55 dark:bg-white/[0.03] ${GOLD_LINE}`}
            data-ui="account-menu"
          >
            {/* 更换头像 */}
            <button
              type="button"
              className="flex w-full items-center gap-3 border-t border-[rgba(245,207,107,0.22)] px-4 py-2.5 text-left first:border-t-0 hover:bg-white/80 dark:hover:bg-white/5"
              disabled={avatarBusy}
              onClick={() => fileInputRef.current?.click()}
              data-ui="account-menu-avatar"
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-md bg-[rgba(245,207,107,0.28)]">
                <ImageUp className={`size-3.5 ${GOLD_TEXT}`} aria-hidden="true" />
              </span>
              <span className="flex-1 text-[0.78125rem] font-semibold">
                {avatarBusy ? "处理中…" : user.avatarUpdatedAt ? "更换头像" : "上传头像"}
              </span>
              <ChevronRight className="size-3.5 text-muted-foreground/50" aria-hidden="true" />
            </button>

            {/* 修改密码 */}
            <button
              type="button"
              className="flex w-full items-center gap-3 border-t border-[rgba(245,207,107,0.22)] px-4 py-2.5 text-left hover:bg-white/80 dark:hover:bg-white/5"
              onClick={() => {
                setMenuOpen(false)
                openPasswordPanel()
              }}
              data-ui="account-menu-password"
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-md bg-[rgba(245,207,107,0.28)]">
                <KeyRound className={`size-3.5 ${GOLD_TEXT}`} aria-hidden="true" />
              </span>
              <span className="flex-1 text-[0.78125rem] font-semibold">修改密码</span>
              <ChevronRight className="size-3.5 text-muted-foreground/50" aria-hidden="true" />
            </button>

            {/* 修改昵称 */}
            {editingName ? (
              <div
                className="border-t border-[rgba(245,207,107,0.22)] px-4 py-2.5"
                data-ui="account-menu-nickname-editor"
              >
                <div className="flex items-center gap-1.5">
                  <Input
                    aria-label="昵称"
                    value={nameDraft}
                    autoFocus
                    maxLength={DISPLAY_NAME_MAX_CHARS}
                    disabled={nameBusy}
                    onChange={(event) => setNameDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault()
                        void submitRename()
                      } else if (event.key === "Escape") {
                        event.preventDefault()
                        setEditingName(false)
                        setNameError("")
                      }
                    }}
                    className="h-8 max-w-56"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 px-2"
                    aria-label="保存昵称"
                    disabled={nameBusy}
                    onClick={() => void submitRename()}
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 px-2"
                    aria-label="取消修改昵称"
                    disabled={nameBusy}
                    onClick={() => {
                      setEditingName(false)
                      setNameError("")
                    }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                {nameError ? <p className="mt-1 text-xs text-destructive">{nameError}</p> : null}
              </div>
            ) : (
              <button
                type="button"
                className="flex w-full items-center gap-3 border-t border-[rgba(245,207,107,0.22)] px-4 py-2.5 text-left hover:bg-white/80 dark:hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60"
                aria-label="修改昵称"
                disabled={cooldownActive}
                title={cooldownActive ? "昵称每个月只能修改一次" : "修改昵称（每月一次）"}
                onClick={startRename}
                data-ui="account-menu-nickname"
              >
                <span className="grid size-6 shrink-0 place-items-center rounded-md bg-[rgba(245,207,107,0.28)]">
                  <Pencil className={`size-3.5 ${GOLD_TEXT}`} aria-hidden="true" />
                </span>
                <span className="flex-1 text-[0.78125rem] font-semibold">修改昵称</span>
                <span className={`truncate text-[0.65625rem] ${GOLD_SUB}`}>
                  {cooldownActive && cooldownUntil
                    ? `下次可修改：${cooldownUntil.toLocaleDateString("zh-CN")}`
                    : ""}
                </span>
                <ChevronRight className="size-3.5 text-muted-foreground/50" aria-hidden="true" />
              </button>
            )}

            {/* 退出登录 */}
            <button
              type="button"
              className="flex w-full items-center gap-3 border-t border-[rgba(245,207,107,0.22)] px-4 py-2.5 text-left hover:bg-destructive/5 disabled:opacity-60"
              disabled={loggingOut}
              onClick={() => void handleLogout()}
              data-ui="account-menu-logout"
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-md bg-destructive/10">
                <LogOut className="size-3.5 text-destructive" aria-hidden="true" />
              </span>
              <span className="flex-1 text-[0.78125rem] font-semibold text-destructive">
                {loggingOut ? "正在退出…" : "退出登录"}
              </span>
              <ChevronRight className="size-3.5 text-destructive/40" aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {/* ── 会员态：三数据栏 ── */}
        {active ? (
          <div className={`flex border-t ${GOLD_LINE}`} data-ui="account-metrics">
            <div className="flex-1 px-4 py-2.5">
              <div className={`mb-0.5 text-[0.65625rem] ${GOLD_SUB}`}>剩余天数</div>
              <div className={`text-[1.0625rem] font-extrabold leading-tight tracking-tight ${GOLD_NUM}`}>
                {membership.forever ? "永久" : remaining || "—"}
              </div>
              <div className={`mt-0.5 text-[0.625rem] ${GOLD_SUB}`}>{planLabel}</div>
            </div>
            <div className={`flex-1 border-l px-4 py-2.5 ${GOLD_LINE}`}>
              <div className={`mb-0.5 text-[0.65625rem] ${GOLD_SUB}`}>到期时间</div>
              <div className={`text-[1.0625rem] font-extrabold leading-tight tracking-tight ${GOLD_NUM}`}>
                {membership.forever ? "永久有效" : expiry || "—"}
              </div>
              <div className={`mt-0.5 text-[0.625rem] ${GOLD_SUB}`}>续费后顺延</div>
            </div>
            <div className={`flex-1 border-l px-4 py-2.5 ${GOLD_LINE}`}>
              <div className={`mb-0.5 text-[0.65625rem] ${GOLD_SUB}`}>云空间</div>
              <div className={`text-[1.0625rem] font-extrabold leading-tight tracking-tight ${GOLD_NUM}`}>
                {quota ? remainBytes : "—"}
              </div>
              <div className={`mt-0.5 text-[0.625rem] ${GOLD_SUB}`}>
                {quota ? `已用 ${usedPercent}%` : "正在读取…"}
              </div>
            </div>
          </div>
        ) : null}
        {/*
         * ⚠️ 免费态主卡**到此结束** —— 没有任何说明段落，也没有按钮
         * （2026-11-09 用户要求）。
         *
         * 原来这里有「未开通会员 / 当前为免费账号… / 下方列出的是会员专属功能…」
         * 三段说明 + 一个「开通会员」，而底部又有一组入口 ——
         * 同一件事说两遍。现在主卡只剩头像行与「管理账号」。
         *
         * 功能清单与开通入口统一在 `AccountBenefitsFree`（免费态渲染器）里。
         */}

        {/* ── 会员态底部：主按钮在左，兑换链接靠右 ── */}
        {active ? (
          <div className={`flex flex-wrap items-center gap-2 border-t px-4 py-2.5 ${GOLD_LINE}`}>
            <Button
              type="button"
              size="sm"
              className={`text-[0.75rem] ${GOLD_BTN_PRIMARY}`}
              onClick={() => openMembership()}
              data-ui="account-renew"
            >
              会员中心
            </Button>
            {/*
             * 「使用兑换」做成文字链接（2026-11-09 用户确认）。
             *
             * 它和「续费」不是同一层级：续费是主路径（多数人扫码付款），
             * 兑换是侧门（只有手里已经有码的人走）。原来给它一个描边按钮
             * 等于说「这两件事一样重要」。
             */}
            <span className="flex-1" />
            <button
              type="button"
              className={`text-[0.6875rem] underline underline-offset-[3px] ${GOLD_SUB} hover:opacity-100`}
              onClick={() => setRedeemOpen((v) => !v)}
              data-ui="account-redeem-toggle"
              aria-expanded={redeemOpen}
            >
              {redeemOpen ? "收起兑换" : "使用兑换"}
            </button>
          </div>
        ) : null}

        {/*
         * 兑换面板只在会员态展开（免费态的兑换入口在下方入口区）。
         *
         * 「重新读取」已删除（2026-11-09 用户确认）：它是「不确定什么时候
         * 该点」的按钮 —— 用户不知道自己在等什么更新，点了没变化也不知道
         * 算不算成功。改为进账号页时自动刷新一次（见上面的 useEffect）。
         */}
        {active && redeemOpen ? (
          <div
            className={`space-y-2 border-t px-4 py-3 ${GOLD_LINE}`}
            data-ui="account-redeem-panel"
          >
            <p className={`text-[0.71875rem] font-semibold ${GOLD_TEXT}`}>
              {active ? "续费" : "用激活码开通"}
            </p>
            <ActivationCodeForm compact />
            <p className="text-[0.65625rem] text-muted-foreground">
              {active
                ? "新买的码会在当前到期日上顺延，不会浪费剩余天数。"
                : "激活码需要在青幕账号服务上兑换才生效；本机无法离线开通。"}
            </p>
          </div>
        ) : null}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCOUNT_AVATAR_ACCEPT}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => void handleAvatarFile(event)}
      />

      {sessionUnverified ? (
        <p
          className="rounded-md bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground"
          role="status"
        >
          账号服务暂时不可用，已保留本地登录状态；云同步稍后再试。
        </p>
      ) : null}


    </>
  )
}

/** 设置 › 账号：只展示登录态，不请求接口，也不影响其它设置。 */
export function AccountSection() {
  const status = useAccountStore((state) => state.status)
  const user = useAccountStore((state) => state.user)
  const openDialog = useAccountStore((state) => state.openDialog)
  /* 会员态渲染两张权益卡，免费态渲染合并区 —— 分流在这里。 */
  const { active } = useMembership()

  if (status === "idle" || status === "booting") {
    return (
      <div data-ui="account-section" className="space-y-6">
        <SectionHeader />
        <p className="text-sm text-muted-foreground" role="status">正在读取账号状态…</p>
      </div>
    )
  }

  if (status === "authenticated" && user) {
    return (
      <div data-ui="account-section" className="space-y-6">
        <SectionHeader />
        <AccountHero user={user} />

        {/*
         * ── 会员态：上下两张权益卡（2026-11-09 用户确认）──
         *
         * ## 为什么是上下而不是两列
         *
         * 曾经做过两列并排，但窄窗口下每列只剩 200px 左右 ——
         * 主按钮（106px）+ 三个图标（各约 30px）挤在一起非常局促。
         * 上下结构每张卡都占满宽度，按钮和图标都有足够空间。
         *
         * ## 免费态为什么不是这两张卡
         *
         * 免费用户看不到可用的额度与开关，两张卡只会变成两个「空壳」。
         * 免费态改由 `AccountBenefitsFree` 渲染：**一处列出全部 5 项**
         * + 底部唯一入口。这样也消掉了「同一批功能说两遍」的问题
         * （那正是 2026-11-09 用户指出的）。
         */}
        {active ? (
          <div className="flex flex-col gap-2.5" data-ui="account-benefits">
            <MemberCloudPanel />

            {/*
             * 「模型同步」面板（2026-11-02 从模型页移入）：同步的是账号的模型
             * 配置，入口放在账号页与「记在这个账号下」的心智一致。
             * 面板在账号会话缺失时自己返回 null。
             */}
            <ModelSyncPanel />
          </div>
        ) : (
          <AccountBenefitsFree />
        )}
      </div>
    )
  }

  return (
    <div data-ui="account-section" className="space-y-6">
      <SectionHeader />
      <div className="rounded-lg border border-border p-4">
        <p className="text-sm text-muted-foreground">{ACCOUNT_DESCRIPTION}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" onClick={() => openDialog("login")}>
            <LogIn aria-hidden="true" />
            登录
          </Button>
          <Button type="button" variant="outline" onClick={() => openDialog("register")}>
            <UserPlus aria-hidden="true" />
            注册
          </Button>
        </div>
      </div>
    </div>
  )
}
