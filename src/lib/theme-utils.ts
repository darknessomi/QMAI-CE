import type { UiTestSkin } from "@/lib/ui-test"

export function applyTheme(theme: UiTestSkin): void {
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("dark", theme === "dark")
  }
}
