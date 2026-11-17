// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { saveSearchApiConfig } from "@/lib/project-store"
import { useWikiStore } from "@/stores/wiki-store"
import { WebSearchSection } from "./web-search-section"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock("@/lib/project-store", () => ({
  saveSearchApiConfig: vi.fn().mockResolvedValue(undefined),
}))

it("keeps Gemini key edits visible immediately and persists the latest value", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const previous = useWikiStore.getState().searchApiConfig
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)

  try {
    useWikiStore.getState().setSearchApiConfig({ provider: "gemini", apiKey: "" })
    act(() => root.render(<WebSearchSection />))
    const gemini = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Gemini（Google 搜索）"),
    )!
    act(() => gemini.click())

    const input = host.querySelector<HTMLInputElement>('input[type="password"]')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    for (const [value, inputType] of [
      ["t", "insertText"],
      ["test-key", "insertFromPaste"],
      ["", "deleteContentBackward"],
    ]) {
      await act(async () => {
        setValue.call(input, value)
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }))
        expect(input.value).toBe(value)
        expect(useWikiStore.getState().searchApiConfig.apiKey).toBe(value)
      })
      expect(saveSearchApiConfig).toHaveBeenLastCalledWith(expect.objectContaining({
        apiKey: value,
        providerConfigs: { gemini: { apiKey: value } },
      }))
    }
  } finally {
    await act(async () => root.unmount())
    host.remove()
    useWikiStore.getState().setSearchApiConfig(previous)
    vi.unstubAllGlobals()
  }
})
