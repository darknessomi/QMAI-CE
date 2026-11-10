import { create } from "zustand"

import { createPayOrder, fetchPayStatus, type PayPlanId, type PayType, type CreatePayOrderResult, type PayOrderStatus } from "@/lib/account/pay-api"
import { isMembershipActive, membershipOf, type MemberFeature } from "@/lib/membership/access"
import { accountErrorMessage, isAccountApiError } from "@/lib/account/errors"
import { readPendingOrder, savePendingOrder } from "@/lib/membership/order-recovery"
import { useAccountStore } from "@/stores/account-store"
import { useSyncQuotaStore } from "@/stores/sync-quota-store"

export interface MembershipOrder extends CreatePayOrderResult {
  plan: PayPlanId
  payType: PayType
  status: PayOrderStatus
  createdAt: number
  membershipUpdated: boolean
  restored?: boolean
  historical?: boolean
}

/** 查询记录以服务地址和账号隔离，会员权限始终从服务端刷新。 */
export function purchaseAccountKey(): string | null {
  const session = useAccountStore.getState().session
  return session ? JSON.stringify([session.baseUrl, session.user.id]) : null
}

interface PurchaseState {
  owner: string | null
  revision: number
  open: boolean
  view: "plans" | "order"
  plan: PayPlanId
  origin: MemberFeature | null
  order: MembershipOrder | null
  creating: boolean
  checking: boolean
  error: string
  storageError: boolean
  loginIntent: { plan: PayPlanId; payType: PayType | null; origin: MemberFeature | null } | null
  preferredPayType: PayType | null
  syncAccount: () => void
  show: (origin?: MemberFeature) => void
  close: () => void
  showOrder: () => void
  selectPlan: (plan: PayPlanId) => void
  showPlans: () => Promise<void>
  begin: (payType: PayType, origin?: MemberFeature) => Promise<void>
  check: () => Promise<void>
}

let returnFocus: HTMLElement | null = null

function rememberFocus() {
  const element = typeof document !== "undefined" ? document.activeElement : null
  if (typeof HTMLElement !== "undefined" && element instanceof HTMLElement && element !== document.body && !element.closest('[role="dialog"]')) returnFocus = element
}

export function membershipReturnFocus(): HTMLElement | true {
  if (typeof document === "undefined") return true
  if (returnFocus?.isConnected && !returnFocus.matches(":disabled") && returnFocus.getClientRects().length) return returnFocus
  return document.querySelector<HTMLElement>('.ui-test-nav-item[aria-current="page"]')
    ?? document.querySelector<HTMLElement>('[data-ui="sidebar-account-avatar"]') ?? true
}

function paymentError(error: unknown, query: boolean): string {
  if (isAccountApiError(error) && error.code !== "NETWORK") return accountErrorMessage(error) + (query ? " 订单仍保留，请勿重复付款。" : "")
  return query ? "暂时无法查询订单，请检查网络后重新查询。请勿重复付款。" : "暂时无法创建订单，请检查网络后重试。"
}

export function hasUnsettledOrder(order: MembershipOrder | null): boolean {
  return !!order && (order.status === "pending" || (order.status === "granted" && !order.membershipUpdated))
}

export const useMembershipPurchaseStore = create<PurchaseState>((set, get) => ({
  owner: null, revision: 0, open: false, view: "plans", plan: "month", origin: null,
  order: null, creating: false, checking: false, error: "", storageError: false, loginIntent: null, preferredPayType: null,
  syncAccount: () => {
    const owner = purchaseAccountKey()
    if (owner === get().owner) {
      if (!owner && get().loginIntent && !useAccountStore.getState().dialogOpen) set({ loginIntent: null })
      return
    }
    const intent = get().owner === null && owner !== null ? get().loginIntent : null
    const plan = get().owner === null && owner !== null ? get().plan : "month"
    const saved = owner ? readPendingOrder(owner) : null
    set({ owner, revision: get().revision + 1, open: !!intent, view: intent && saved ? "order" : "plans",
      plan: intent?.plan ?? plan, origin: intent?.origin ?? null, preferredPayType: intent?.payType ?? null, loginIntent: null,
      order: saved ? { ...saved, ok: true, qrCode: null, payUrl: null, urlScheme: null, status: "pending", membershipUpdated: false, restored: true } : null,
      creating: false, checking: false, error: "", storageError: false })
  },
  show: (origin) => {
    if (!get().open) rememberFocus()
    get().syncAccount()
    if (!get().owner) {
      set({ loginIntent: { plan: get().plan, payType: null, origin: origin ?? null } })
      useAccountStore.getState().openDialog("login"); return
    }
    set({ open: true, origin: origin ?? null, view: hasUnsettledOrder(get().order) || get().creating || get().checking ? "order" : "plans" })
    if (hasUnsettledOrder(get().order)) void get().check()
  },
  close: () => set({ open: false }),
  showOrder: () => {
    if (get().order) { set({ open: true, view: "order" }); void get().check() }
  },
  selectPlan: (plan) => set({ plan }),
  showPlans: async () => {
    if (get().creating || get().checking) return
    const revision = get().revision
    if (hasUnsettledOrder(get().order)) await get().check()
    if (get().revision === revision) set({ view: get().order?.membershipUpdated ? "order" : "plans" })
  },
  begin: async (payType, origin) => {
    if (!get().open) rememberFocus()
    get().syncAccount()
    const session = useAccountStore.getState().session
    if (!session) {
      set({ loginIntent: { plan: get().plan, payType, origin: origin ?? null } })
      useAccountStore.getState().openDialog("login"); return
    }
    const membership = membershipOf(useAccountStore.getState().user)
    if (membership.forever && isMembershipActive(membership)) { get().show(origin); return }
    // 多个入口共享同一把创建锁，关闭弹窗也不会释放在途请求。
    if (get().creating || get().checking) { set({ open: true, view: "order" }); return }
    if (hasUnsettledOrder(get().order)) {
      set({ open: true, view: "order", origin: origin ?? get().origin })
      await get().check()
      return
    }
    const { owner, revision, plan } = get()
    const current = () => get().revision === revision && purchaseAccountKey() === owner
    set({ open: true, view: "order", origin: origin ?? null, preferredPayType: null, creating: true, order: null, error: "" })
    try {
      const result = await createPayOrder(session.baseUrl, session.accessToken, { plan, payType })
      if (!current()) return
      if (!result.ok || !result.outTradeNo) {
        set({ error: "订单未创建成功，请稍后重试。", creating: false })
        return
      }
      const order: MembershipOrder = { ...result, plan, payType, status: "pending", createdAt: Date.now(), membershipUpdated: false }
      const saved = owner ? savePendingOrder(owner, order) : false
      set({ order, creating: false, storageError: !saved })
    } catch (error) {
      if (current()) set({ error: paymentError(error, false), creating: false })
    }
  },
  check: async () => {
    get().syncAccount()
    const { order, owner, revision, checking } = get()
    const session = useAccountStore.getState().session
    if (!order || !session || checking || order.membershipUpdated) return
    const current = () => get().revision === revision && purchaseAccountKey() === owner && get().order?.outTradeNo === order.outTradeNo
    set({ checking: true, error: "" })
    try {
      const status = order.status === "granted" ? { status: "granted" as const, amount: order.amount }
        : await fetchPayStatus(session.baseUrl, session.accessToken, order.outTradeNo)
      if (!current()) return
      set({ order: { ...order, status: status.status, amount: status.amount || order.amount } })
      if (status.status === "granted") {
        const refreshed = await useAccountStore.getState().refreshMembership()
        if (!current()) return
        const membership = membershipOf(useAccountStore.getState().user)
        const active = isMembershipActive(membership)
        // 很久以前的未确认订单可能已发放且已到期，不能因此永远拦住新的续费。
        const historical = !!order.restored && !!membership.expiresAt && membership.expiresAt * 1000 > order.createdAt && membership.expiresAt * 1000 <= Date.now()
        if (refreshed && (active || historical)) {
          set({ order: { ...get().order!, membershipUpdated: true, historical: !active && historical } })
          void useSyncQuotaStore.getState().refresh({ force: true })
        } else set({ error: "付款已确认，会员信息暂未更新，请点击重新查询。无需再次付款。" })
      }
      if (current() && owner) {
        const latest = get().order
        set({ storageError: !savePendingOrder(owner, hasUnsettledOrder(latest) ? latest : null) })
      }
    } catch (error) {
      if (current()) set({ error: paymentError(error, true) })
    } finally {
      if (current()) set({ checking: false })
    }
  },
}))
