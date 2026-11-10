/**
 * 会员云空间的自动同步接线。
 *
 * ## 触发源只有「落盘」
 *
 * 现有云同步有三个触发源（落盘 / 窗口重新聚焦 / 刚连上网盘）。这里只接
 * 落盘这一个，理由：
 *   · 备份是「把用户的作品传上去」，用户保存了才有新内容可传；
 *   · 切窗口、连网络这些事件与「有没有新内容」无关，接上只会多传空跑；
 *   · 每多一个触发源，就多一条「为什么刚才传了一次」的疑问。
 *
 * ## 为什么用落盘信号而不是文件监听
 *
 * 与 cloud-sync 同一理由：同步自己写下的临时文件会被监听器当成用户改动，
 * 形成自我触发的死循环。落盘信号只在用户明确的保存动作后发出。
 *
 * ## 防抖
 *
 * 与 cloud-sync 共用 `SAVE_DEBOUNCE_MS`（8 秒）。连续打字时保存很频繁，
 * 不防抖会变成「每几秒传一遍整个工程」。
 */

import { useEffect } from "react"

import { isTauri } from "@/lib/platform"
import { SAVE_DEBOUNCE_MS } from "@/lib/cloud-sync/scheduler"
import { subscribeProjectSaved } from "@/lib/cloud-sync/save-signal"
import { useMembership } from "@/lib/membership/use-membership"
import { useMemberCloudStore } from "@/stores/member-cloud-store"
import { useAccountStore } from "@/stores/account-store"
import { useWikiStore } from "@/stores/wiki-store"

export function useMemberCloudAutoSync(): void {
  /*
   * 会员云空间是**会员专属**（2026-11-09 用户要求：「普通用户不能同步，
   * 只有开会员的才能使用同步功能」）。
   *
   * 非会员不接线：不订阅落盘信号，也就不会在保存后白跑一次必然被服务端
   * 拒绝的备份。服务端那边也会硬拒（见网关 sync.js），这里是省一次
   * 无谓请求 + 避免界面上冒出「同步失败」这种误导性提示。
   */
  const { active: isMember } = useMembership()
  const session = useAccountStore(s => s.session)
  const projectPath = useWikiStore(s => s.project?.path)

  useEffect(() => {
    if (!isTauri()) return
    if (!isMember) return

    let timer: ReturnType<typeof setTimeout> | null = null

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }

    const unsubscribe = subscribeProjectSaved(() => {
      // 每次落盘都重新计时：持续编辑时只在「停下来 8 秒」后传一次
      clearTimer()
      timer = setTimeout(() => {
        timer = null
        const store = useMemberCloudStore.getState()
        /*
         * 到点时再判一次开关：用户可能在 8 秒内把自动同步关掉了，
         * 那时候不该还传一次。
         */
        if (!store.autoEnabled) return
        void store.runBackup()
      }, SAVE_DEBOUNCE_MS)
    })

    return () => {
      clearTimer()
      unsubscribe()
    }
  }, [isMember, session?.baseUrl, session?.user.id, projectPath])
}
