// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core"
import { expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import { JevModelSettings } from "./jev-model"
import { changeInput, click, mountModel } from "./model-test-utils"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))

it("使用表单中的配置测试决策服务，按保存后生效，重新打开能读回", async () => {
  useWikiStore.setState({ jevConfig: null })
  const expected = { endpoint: "https://example.test/v1", model: "identity", apiKey: "fixture-key" }
  const panel = await mountModel(<JevModelSettings />)
  try {
    await changeInput(panel.host, "服务地址", expected.endpoint)
    await changeInput(panel.host, "模型 ID", expected.model)
    await changeInput(panel.host, "API 密钥", expected.apiKey)
    vi.mocked(invoke).mockRejectedValueOnce("Jev 服务返回 HTTP 403")
    await click(panel.host, "测试连接")
    expect(panel.host.textContent).toContain("鉴权失败")
    expect(panel.host.textContent).not.toContain(expected.apiKey)
    await click(panel.host, "测试连接")
    expect(invoke).toHaveBeenCalledWith("sag_test_jev", { config: expected })
    expect(useWikiStore.getState().jevConfig).toBeNull()
    await click(panel.host, "保存配置")
    expect(useWikiStore.getState().jevConfig).toEqual(expected)
  } finally {
    await panel.unmount()
  }
  const reopened = await mountModel(<JevModelSettings />)
  try {
    expect(reopened.host.querySelector<HTMLInputElement>('[aria-label="服务地址"]')?.value).toBe(expected.endpoint)
    expect(reopened.host.querySelector<HTMLInputElement>('[aria-label="API 密钥"]')?.type).toBe("password")
  } finally {
    await reopened.unmount()
  }
})
