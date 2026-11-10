/**
 * 兑换激活码表单。
 *
 * 只做三件事：输入、提交、报告结果。一切有效性判断都在服务端
 * （`POST /v1/membership/redeem`），这里**不做任何本地校验**——
 * 本地能判出「这个码有效」就意味着码可以被猜出来，那正是要防的东西。
 *
 * 输入框做了格式整理（去空格、大写），但只是**使用体验**上的整理，
 * 不拦截：用户把带空格的码粘进来也能提交，由服务端统一给出结论。
 */

import { useState } from "react"
import { KeyRound } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { accountErrorMessage, isAccountApiError } from "@/lib/account/errors"
import { toast } from "@/lib/toast"
import { useAccountStore } from "@/stores/account-store"

interface ActivationCodeFormProps {
  /** 兑换成功后回调（会员状态已写回账号 store）。 */
  onRedeemed?: (info: { addedDays: number; planLabel: string | null; expiresAt: number | null }) => void
  /** 紧凑布局：用于设置页小卡片（默认 false，用于开通引导页）。 */
  compact?: boolean
}

export function ActivationCodeForm({ onRedeemed, compact = false }: ActivationCodeFormProps) {
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const redeemCode = useAccountStore((state) => state.redeemCode)
  const loggedIn = useAccountStore((state) => Boolean(state.session))

  async function submit() {
    const trimmed = code.trim()
    if (!trimmed) {
      setError("请先填写激活码。")
      return
    }
    setBusy(true)
    setError("")
    try {
      const result = await redeemCode(trimmed)
      setCode("")
      /*
       * 只有服务端**确认兑换成功**才会走到这里（`redeemCode` 在断网 / 503 /
       * 码无效时都会抛错），所以这里的成功提示是真实的。
       *
       * 额外核对一次到期时间：`expiresAt === null` 说明服务端没有真的把会员
       * 写上去（数据异常），此时**不能**报「已即时生效」。
       */
      const expiresAt = result.membership.expiresAt
      if (!result.membership.active || expiresAt === null) {
        setError("服务端已收到激活码，但没有返回有效的会员时长，请联系客服处理。")
        return
      }
      toast.success(
        result.addedDays > 0
          ? `兑换成功：${result.planLabel ?? "会员"} +${result.addedDays} 天，已即时生效。`
          : "兑换成功，会员已生效。",
      )
      onRedeemed?.({
        addedDays: result.addedDays,
        planLabel: result.planLabel,
        expiresAt,
      })
    } catch (err) {
      /*
       * 服务端有意不区分「码不存在 / 已兑换 / 已作废」，所以这里也不做二次解释：
       * 任何额外提示都会削弱那道反枚举的闸门。
       * 断网时是 NETWORK 文案 —— 用户看到的是失败，不是「成功」。
       */
      setError(isAccountApiError(err) ? accountErrorMessage(err) : "兑换失败，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-ui="activation-code-form" className={compact ? "space-y-2" : "space-y-3"}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="激活码"
          placeholder="QMAI-XXXX-XXXX-XXXX-XXXX"
          value={code}
          disabled={busy || !loggedIn}
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          className={compact ? "h-9 max-w-64 font-mono" : "h-10 max-w-80 font-mono"}
          onChange={(event) => {
            setCode(event.currentTarget.value)
            if (error) setError("")
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <Button type="button" size={compact ? "sm" : "default"} disabled={busy || !loggedIn} onClick={() => void submit()}>
          <KeyRound aria-hidden="true" />
          {busy ? "兑换中…" : "兑换"}
        </Button>
      </div>
      {!loggedIn ? (
        <p className="text-xs text-muted-foreground">兑换激活码需要先登录账号（设置 › 账号）。</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
