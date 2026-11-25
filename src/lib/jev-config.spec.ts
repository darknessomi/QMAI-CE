import { invoke } from "@tauri-apps/api/core"
import { beforeEach, expect, test, vi } from "vitest"
import { getJevConfig, getJevConfigState, loadJevConfig, saveJevConfig, testJevConfig } from "./jev-config"
import { useWikiStore } from "@/stores/wiki-store"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))
const model = { endpoint: "http://localhost:8686/v1", model: "jev", apiKey: "example-fixture" }
beforeEach(() => {
  vi.resetAllMocks()
  useWikiStore.setState({ jevConfig: null, jevConfigLoadError: null })
})

test("测试不保存，保存后重启从独立配置读取，清空只影响 JEV", async () => {
  await testJevConfig(model)
  expect(invoke).toHaveBeenCalledWith("sag_test_jev", { config: model })
  expect(getJevConfig()).toBeNull()
  await saveJevConfig(model)
  expect(invoke).toHaveBeenCalledWith("jev_config_save", { contents: JSON.stringify(model) })
  expect(getJevConfig()).toEqual(model)
  useWikiStore.setState({ jevConfig: null, jevConfigLoadError: null })
  vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify(model))
  await loadJevConfig()
  expect(getJevConfig()).toEqual(model)
  await saveJevConfig(null)
  expect(getJevConfig()).toBeNull()
})

test("保存失败保留原配置，拒绝把密钥放进地址", async () => {
  useWikiStore.setState({ jevConfig: model })
  vi.mocked(invoke).mockRejectedValueOnce(new Error("存储不可用"))
  await expect(saveJevConfig(null)).rejects.toThrow()
  expect(getJevConfig()).toEqual(model)
  await expect(testJevConfig({ ...model, endpoint: "https://api.example.test/?key=x" })).rejects.toThrow("专用输入框")
  expect(invoke).toHaveBeenCalledTimes(1)
})

test.each([
  ["Jev 服务返回 HTTP 401 私密文本", "鉴权失败"],
  ["无法连接 Jev 判定服务 私密文本", "无法连接"],
  ["Jev 返回了无效概率 私密文本", "无效响应"],
])("测试失败只展示对应的中文原因", async (failure, explanation) => {
  vi.mocked(invoke).mockRejectedValueOnce(failure)
  const error = await testJevConfig(model).catch(reason => reason as Error)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain(explanation)
  expect((error as Error).message).not.toContain("私密文本")
})

test("本机解密或解析失败时阻止降级，重新保存后解除错误", async () => {
  useWikiStore.setState({ jevConfig: model })
  vi.mocked(invoke).mockRejectedValueOnce(new Error("私密文本"))
  await loadJevConfig()
  expect(getJevConfigState().config).toBeNull()
  expect(getJevConfig).toThrow("无法读取已保存的决策配置")
  expect(getJevConfigState().error).not.toContain("私密文本")
  vi.mocked(invoke).mockResolvedValueOnce("")
  await loadJevConfig()
  expect(getJevConfig).toThrow("无法读取已保存的决策配置")
  await saveJevConfig(model)
  expect(getJevConfig()).toEqual(model)
})
