import { isTauri } from "@/lib/platform"

let pending = false

/** 浏览器同步返回，桌面端等待原生弹窗。仅明确确认才执行操作。 */
export async function confirmAction(
  message: string, title = "操作确认", onError?: () => void,
): Promise<boolean> {
  if (pending || typeof window === "undefined") return false
  pending = true
  try {
    if (isTauri()) {
      const { confirm } = await import("@tauri-apps/plugin-dialog")
      return (await confirm(message, { title, kind: "warning", okLabel: "继续", cancelLabel: "取消" })) === true
    }
    return (await window.confirm(message)) === true
  } catch (error) {
    console.warn("无法打开确认框，本次操作已取消。", error)
    onError?.()
    return false
  } finally {
    pending = false
  }
}
