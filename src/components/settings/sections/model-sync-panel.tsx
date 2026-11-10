/**
 * 设置 → 模型 里的「模型同步」面板。
 *
 * 只做三件事：开关、同步密码（设置/修改）、立即同步与状态提示。
 * 加解密、合并、推送全在 `lib/model-sync` 与 `stores/model-sync-store` 里。
 *
 * 名称：2026-11-02 由「账号同步」改为「模型同步」。它同步的是模型配置
 * （含 API Key），不是账号本身；旧名字会让人以为开了就能跨设备同步作品。
 *
 * 显示条件：2026-11-02 起**未登录整块不显示**。原来是显示但置灰 +
 * 提示先登录，但置灰的开关仍占一行、且会让人反复去点那个点不动的按钮，
 * 更像 bug 而不是限制。未登录本来就是开不了同步（同步要账号会话）。
 *
 * 布局（用户 2026-10-28 定）：
 * - 面板整体挂在四个模型页签**下方**（由 settings-view 渲染），可展开 / 收缩；
 * - 右上是「立即同步 / 修改同步密码」和一个与模型卡片同款的开关；
 * - 「关闭同步并清空云端配置（不可恢复）」是销毁式操作，放到「上次同步」那一行的右侧，
 *   与开关分开 —— 开关只负责停/继续，不该顺手清云端。
 */

import { useEffect, useState } from "react"
import { ChevronRight, Crown, Download, KeyRound, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { confirmModelAction } from "@/components/uitest/models/model-confirm"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ActivationCodeForm } from "@/components/membership/activation-code-form"
import { MemberBadge } from "@/components/membership/member-badge"
import { useMembership } from "@/lib/membership/use-membership"
import { useAccountStore } from "@/stores/account-store"
import { MIN_SYNC_PASSWORD_LENGTH, useModelSyncStore } from "@/stores/model-sync-store"

/* ── 视觉常量：与云备份卡保持一致（见文件头注释） ─────────────── */

/** 金色权益卡：会员态专用 */
const GOLD_BLOCK =
  "overflow-hidden rounded-[11px] border border-[rgba(245,207,107,0.62)] " +
  "bg-[radial-gradient(260px_140px_at_100%_0%,rgba(240,192,86,0.20),transparent_72%)," +
  "linear-gradient(158deg,#fffefb_0%,#fdf8ea_62%,#fbf2da_100%)] " +
  "shadow-[0_4px_16px_rgba(176,125,24,0.08)] " +
  "dark:border-[rgba(180,130,40,0.5)]"

const GOLD_TEXT = "text-[#7a4a05] dark:text-[#f0d089]"
const GOLD_SUB = "text-[#7a4a05]/78 dark:text-[#f0d089]/78"
const GOLD_LINE = "border-[rgba(245,207,107,0.34)]"

/** 图标方块：金色调，与云备份的图标组同款 */
const ICO_BASE =
  "relative grid h-[38px] place-items-center rounded-[9px] " +
  "border border-[rgba(245,207,107,0.38)] bg-white/60 leading-none text-[#7a4a05] " +
  "transition-colors hover:border-[rgba(245,207,107,0.62)] hover:bg-white " +
  "disabled:cursor-not-allowed disabled:opacity-50 " +
  "dark:bg-white/5 dark:text-[#f0d089]"

/**
 * 操作条宽度分配：**方案 ① 等分**（2026-11-09 用户确认）。
 *
 * 主按钮占一半、图标组占一半，形成 1:1 的对仗。撑满时主按钮约 700px、
 * 图标才 170px（4:1），像一条横带把卡片切成两半。
 */
const ACTION_ROW = "flex items-center gap-1.5 px-4 pb-3"
/*
 * 主按钮：**固定宽度**（2026-11-09 用户确认「立即同步不做成超宽效果」）。
 *
 * 原来是 `flex-1` —— 宽度由容器决定而不是内容：
 * 单列（980px）时被拉到 470px，而「立即同步」四个字 + 一个图标
 * 只需要 106px 左右。定宽后剩余空间交给图标组分配。
 */
const MAIN_BTN =
  "h-[38px] w-[106px] shrink-0 justify-center border border-[#c9942c] " +
  "bg-gradient-to-b from-[#f3c95f] to-[#d9a334] text-[0.75rem] font-bold text-[#3d2a05] " +
  "hover:from-[#f6d27a] hover:to-[#e0ae44]"
const ICO_GROUP = "flex min-w-0 flex-1 gap-1.5"
const ICO_BOX = "flex min-w-0 flex-1 flex-col gap-px"

/**
 * 未开通会员时的「模型同步」面板。
 *
 * 为什么单独一个组件而不是在 `ModelSyncPanel` 里内联一段 JSX：
 * 主组件的 hooks 已经很多，把这段大块分支写进去会让「哪条路径读了哪个
 * store」更难看清；而且它一点同步逻辑都不碰，混在一起只会误导。
 * 这里只做三件事：说清是会员功能、锁住开关、给兑换入口。
 */
function MemberLockedModelSyncPanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <section
      className="my-4 space-y-3 rounded-lg border p-4"
      data-ui="model-sync-panel"
      data-member-locked="true"
      data-open={open ? "true" : "false"}
    >
      <div className={`flex flex-wrap justify-between gap-2 ${open ? "items-start" : "items-center"}`}>
        <button
          type="button"
          className="flex min-w-0 items-start gap-1.5 text-left"
          aria-expanded={open}
          onClick={onToggle}
          title={open ? "收起模型同步" : "展开模型同步"}
        >
          <ChevronRight
            className={`${open ? "mt-1" : ""} h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
          />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="block font-medium">模型同步</span>
              <MemberBadge />
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              模型同步是会员功能：把模型配置（含 API Key）加密后同步到你的其它设备。
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onToggle}>
            <Crown aria-hidden="true" />
            开通会员
          </Button>
          <button
            type="button"
            role="switch"
            aria-checked={false}
            data-ui="model-sync-switch"
            disabled
            className="model-switch disabled:cursor-not-allowed disabled:opacity-50"
            title="开通会员后可开启同步"
            aria-label="开启同步（需要会员）"
          >
            <span />
          </button>
        </div>
      </div>

      {open ? (
        <div className="space-y-3 border-t pt-3">
          <p className="text-xs leading-5 text-muted-foreground">
            开通后即可使用模型同步；已保存的本地模型配置不会被删除，也不会被改动。
          </p>
          <ActivationCodeForm compact />
          <p className="text-xs text-muted-foreground">
            兑换成功后会在本机自动补签内置模型凭证，开关随即可用，无需重新登录。
          </p>
        </div>
      ) : null}
    </section>
  )
}

export function ModelSyncPanel() {
  const enabled = useModelSyncStore((state) => state.enabled)
  const passwordReady = useModelSyncStore((state) => state.passwordReady)
  const busy = useModelSyncStore((state) => state.busy)
  const status = useModelSyncStore((state) => state.status)
  const message = useModelSyncStore((state) => state.message)
  const pendingConflicts = useModelSyncStore((state) => state.pendingConflicts)
  const resolveConflict = useModelSyncStore((state) => state.resolveConflict)
  const lastSyncAt = useModelSyncStore((state) => state.lastSyncAt)
  const init = useModelSyncStore((state) => state.init)
  const enable = useModelSyncStore((state) => state.enable)
  const setEnabled = useModelSyncStore((state) => state.setEnabled)
  const disable = useModelSyncStore((state) => state.disable)
  const syncNow = useModelSyncStore((state) => state.syncNow)
  const restoreFromCloud = useModelSyncStore((state) => state.restoreFromCloud)
  const changePassword = useModelSyncStore((state) => state.changePassword)

  const accountSession = useAccountStore((state) => state.session)
  /** 默认**折叠**（用户 2026-10-28 定）：收起后只留一行，设置页不被这块占地方。 */
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<"idle" | "setup" | "change">("idle")
  const [first, setFirst] = useState("")
  const [second, setSecond] = useState("")
  const [formError, setFormError] = useState("")

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (mode === "idle") {
      setFirst("")
      setSecond("")
      setFormError("")
    }
  }, [mode])

  const loggedIn = Boolean(accountSession)
  const syncing = status === "pulling" || status === "pushing"
  const syncText = lastSyncAt ? `上次同步：${new Date(lastSyncAt).toLocaleString()}` : "还没有同步过"
  /*
   * 会员闸门（2026-11-06）：模型同步是会员功能。
   *
   * 形态是**入口保留 + 开通引导**，不是整块消失：用户得知道有这个功能、
   * 以及它要开通，否则会以为「我的软件没有这个能力」。
   * 关闭同步（已开通用户主动关）与「未开通」是两种状态，文案不能混。
   */
  const { canUse } = useMembership()
  const memberOk = canUse("modelSync")

  /*
   * 未登录整块不显示（2026-11-02 用户指定：同步入口放在账号登录之后）。
   *
   * 原来是显示但置灰、外加一句「请先登录」。改掉的理由：置灰的开关仍占一整行，
   * 用户会反复去点那个点不动的按钮，看起来像坏了；而未登录确实开不了同步
   * （同步需要账号会话）。自动同步的心跳在别处接线，不依赖这块是否渲染。
   */
  if (!loggedIn) return null

  /*
   * 未开通会员：保留标题与说明，禁用开关与所有同步动作，展开后给兑换入口。
   *
   * 为什么不直接 return null：这个面板是「模型同步」这个功能在界面上**唯一**
   * 的存在。整块消失等于用户永远不知道该功能存在，也就无从开通。
   * 所以这里只锁**操作**，不锁**说明**。
   */
  if (!memberOk) {
    return <MemberLockedModelSyncPanel open={open} onToggle={() => setOpen((value) => !value)} />
  }

  async function submitSetup() {
    if (first !== second) {
      setFormError("两次输入的同步密码不一致。")
      return
    }
    try {
      await enable(first)
      setMode("idle")
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "开启同步失败。")
    }
  }

  async function submitChange() {
    if (second.trim().length < MIN_SYNC_PASSWORD_LENGTH) {
      setFormError(`新同步密码至少 ${MIN_SYNC_PASSWORD_LENGTH} 位。`)
      return
    }
    if (first === second) {
      setFormError("新同步密码不能与当前密码相同。")
      return
    }
    try {
      await changePassword(first, second)
      setMode("idle")
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "修改同步密码失败。")
    }
  }

  /**
   * 从云端下载：会覆盖本机同名项，所以先弹确认框再说。
   * 典型用途就是「本机把模型删了，想从云端捞回来」。
   */
  async function download() {
    const ok = await confirmModelAction(
      "将用云端的模型配置覆盖本机的同名项（大语言模型提供方、重排模型、向量模型）；本机独有的配置会保留，不会被删除。确定下载吗？",
      "从云端下载配置",
    )
    if (!ok) return
    await restoreFromCloud()
  }

  /**
   * 开关：关 = 停止同步（密码与云端配置都留着）；开 = 直接用已存密码同步一次。
   * 只有本机还没有密码时才退回去让用户设置密码 —— 那是一次性的引导，不是每次开关都要做。
   */
  const toggle = () => {
    if (busy) return
    if (enabled) {
      void setEnabled(false)
      return
    }
    if (passwordReady) {
      void setEnabled(true)
      return
    }
    setOpen(true)
    setMode("setup")
  }

  return (
    <section
      className="my-4 space-y-2.5"
      data-ui="model-sync-panel"
      data-open={open ? "true" : "false"}
    >
      {/*
       * 金色权益卡 —— 与「云备份」同一套视觉（2026-11-09 用户要求）。
       *
       * 两个都是会员专属功能，长得却像两个层级的东西时，用户看不出
       * 「这是同一类权益」。所以：同一个金色渐变底、同宽图标区、
       * 同尺寸开关、同一套操作按钮样式。
       */}
      <div className={GOLD_BLOCK}>
        {/* ── 卡头：图标 + 状态摘要 + 开关 ── */}
        <div className="flex items-center gap-2.5 px-4 py-3">
          <span className="grid size-6 shrink-0 place-items-center rounded-md bg-[rgba(245,207,107,0.28)] text-[0.75rem] text-[#7a4a05] dark:text-[#f0d089]">
            ◈
          </span>
          <div className="min-w-0 flex-1">
            <div className={`text-[0.78125rem] font-semibold ${GOLD_TEXT}`}>模型同步</div>
            <div
              className={`mt-0.5 truncate text-[0.65625rem] ${GOLD_SUB}`}
              data-ui="model-sync-status"
            >
              {enabled ? syncText : "同步已关闭，云端配置与密码都还保留着"}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            data-ui="model-sync-switch"
            onClick={toggle}
            disabled={busy}
            title={enabled ? "关闭同步（保留云端配置）" : "开启同步"}
            aria-label={enabled ? "关闭同步" : "开启同步"}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              enabled ? "bg-gradient-to-b from-[#f5cf6b] to-[#dda63a]" : "bg-muted"
            }`}
          >
            <span
              className={`absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-all ${
                enabled ? "right-0.5" : "left-0.5"
              }`}
            />
          </button>
        </div>

        {/*
         * ── 操作条：主按钮与图标组各占一半 ──
         *
         * 「立即同步」是这一区唯一的高频动作（配好之后基本不用再点别的），
         * 所以给它主按钮的位置；「从云端下载」和「修改同步密码」是低频的
         * 维护操作，收成两个图标方块。
         */}
        <div className={ACTION_ROW}>
          <Button
            type="button"
            size="sm"
            className={MAIN_BTN}
            disabled={busy || !enabled}
            onClick={() => void syncNow()}
            title={enabled ? "立即同步一次" : "先打开右侧开关"}
            data-ui="model-sync-now"
          >
            <RefreshCw className="mr-1.5 size-3.5" aria-hidden="true" />
            {syncing ? "同步中…" : "立即同步"}
          </Button>

          <div className={ICO_GROUP}>
            <button
              type="button"
              className={`${ICO_BASE} ${ICO_BOX}`}
              disabled={busy || !enabled}
              title="把云端的模型配置下载到本机（覆盖同名项，本地独有的保留）"
              onClick={() => void download()}
              data-ui="model-sync-download"
            >
              <Download className="size-3.5" aria-hidden="true" />
              <span className={`whitespace-nowrap text-[0.5625rem] ${GOLD_SUB}`}>下载</span>
            </button>

            <button
              type="button"
              className={`${ICO_BASE} ${ICO_BOX}`}
              disabled={busy || !enabled}
              title="修改同步密码"
              onClick={() => setMode(mode === "change" ? "idle" : "change")}
              data-ui="model-sync-password-toggle"
            >
              <KeyRound className="size-3.5" aria-hidden="true" />
              <span className={`whitespace-nowrap text-[0.5625rem] ${GOLD_SUB}`}>密码</span>
            </button>

            {/*
             * 「清空云端配置」是销毁式操作，不该和日常操作并排。
             * 它在下面「上次同步」那一行右侧（保留原有的位置约定）。
             */}
          </div>
        </div>

        {/* ── 说明：默认折叠，点标题展开 ── */}
        <div className={`border-t px-4 py-2.5 ${GOLD_LINE}`}>
          <button
            type="button"
            className={`flex w-full items-center gap-1.5 text-left text-[0.65625rem] ${GOLD_SUB}`}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            title={open ? "收起模型同步说明" : "展开模型同步说明"}
          >
            <ChevronRight
              className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
              aria-hidden="true"
            />
            {open ? "模型配置在本机加密后再上传，云端只存密文" : "同步说明与危险操作"}
          </button>

          {open ? (
            <div className="mt-2 space-y-2">
              <p className={`text-[0.65625rem] leading-relaxed ${GOLD_SUB}`}>
                模型配置（含 API Key）用你的同步密码在本机加密后再上传，云端只存密文，我们也解不开。
              </p>
              {enabled ? (
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  <span className={`text-[0.65625rem] ${GOLD_SUB}`}>{syncText}</span>
                  <button
                    type="button"
                    className="text-[0.65625rem] text-destructive underline-offset-2 hover:underline"
                    disabled={busy}
                    onClick={() => void disable({ clearCloud: true })}
                  >
                    关闭同步并清空云端配置（不可恢复）
                  </button>
                </div>
              ) : (
                <p className={`text-[0.65625rem] ${GOLD_SUB}`}>
                  打开右侧开关即开始同步；关闭只停止同步，云端配置和同步密码都会保留。
                </p>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {/* ── 同步失败：折叠时也要显示，否则「点了没反应」会被当成 bug ── */}
      {status === "error" && message ? (
        <p className="px-1 text-[0.6875rem] text-destructive">{message}</p>
      ) : null}

      {/* ── 两端都改过的冲突：逐条让用户选保留哪一份 ── */}
      {pendingConflicts.length > 0 ? (
        <div
          className="space-y-2 rounded-[11px] border border-dashed border-[rgba(245,207,107,0.5)] bg-white/60 p-3 text-[0.6875rem] dark:bg-white/5"
          data-ui="model-sync-conflicts"
        >
          <p className={GOLD_SUB}>
            下面这些模型配置两边都改过。同步时先按更新时间保留了较新的一份，你可以逐条改成另一份：
          </p>
          {pendingConflicts.map((conflict) => (
            <div key={conflict.key} className="flex flex-wrap items-center justify-between gap-2">
              <span className="break-all">{conflict.key}</span>
              <span className="flex gap-2">
                <Button
                  size="sm"
                  variant={conflict.chosen === "local" ? "default" : "outline"}
                  disabled={busy}
                  onClick={() => void resolveConflict(conflict.key, "local")}
                >
                  用本地这份
                </Button>
                <Button
                  size="sm"
                  variant={conflict.chosen === "cloud" ? "default" : "outline"}
                  disabled={busy}
                  onClick={() => void resolveConflict(conflict.key, "cloud")}
                >
                  用云端这份
                </Button>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* ── 同步密码表单 / 操作反馈 ── */}
      {mode !== "idle" ? (
        <div
          className="space-y-2 rounded-[11px] border border-[rgba(245,207,107,0.5)] bg-white/70 p-3 dark:bg-white/5"
          data-ui="model-sync-password-form"
        >
          <p className={`text-[0.65625rem] leading-relaxed ${GOLD_SUB}`}>
            {mode === "setup"
              ? `设置一个同步密码（≥${MIN_SYNC_PASSWORD_LENGTH} 位）。它与登录密码相互独立：忘记它，云端密文将无法恢复。`
              : "修改同步密码：先用当前密码解锁，再用新密码重新加密并覆盖上传。"}
          </p>
          <div className="space-y-1">
            <Label htmlFor="model-sync-password">
              {mode === "setup" ? "同步密码" : "当前同步密码"}
            </Label>
            <Input
              id="model-sync-password"
              type="password"
              value={first}
              onChange={(event) => setFirst(event.currentTarget.value)}
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="model-sync-password-confirm">
              {mode === "setup" ? "重复同步密码" : `新同步密码（≥${MIN_SYNC_PASSWORD_LENGTH} 位）`}
            </Label>
            <Input
              id="model-sync-password-confirm"
              type="password"
              value={second}
              onChange={(event) => setSecond(event.currentTarget.value)}
              autoComplete="new-password"
            />
          </div>
          {formError ? <p className="text-[0.65625rem] text-destructive">{formError}</p> : null}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void (mode === "setup" ? submitSetup() : submitChange())}
            >
              {mode === "setup" ? "开启并上传" : "保存新密码"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMode("idle")}>
              取消
            </Button>
          </div>
        </div>
      ) : null}

      {message && status !== "error" && mode === "idle" ? (
        <p className={`px-1 text-[0.6875rem] ${GOLD_SUB}`}>{message}</p>
      ) : null}
    </section>
  )
}
