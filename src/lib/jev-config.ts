import { invoke } from "@tauri-apps/api/core"
import { useWikiStore, type JevConfig } from "@/stores/wiki-store"

export type { JevConfig } from "@/stores/wiki-store"

export function getJevConfigState(): { config: JevConfig | null; error: string | null } {
  const { jevConfig: config, jevConfigLoadError: error } = useWikiStore.getState()
  return { config, error }
}

export function getJevConfig(): JevConfig | null {
  const { config, error } = getJevConfigState()
  if (error) throw new Error(error)
  return config
}

export function normalizeJevConfig(config: JevConfig): JevConfig {
  const endpoint = config.endpoint.trim()
  const model = config.model.trim()
  let url: URL
  try { url = new URL(endpoint) } catch { throw new Error("请输入有效的 JEV 服务地址。") }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("JEV 服务地址须为 HTTP 或 HTTPS 地址，密钥请填写在专用输入框。")
  }
  if (!model) throw new Error("请填写 JEV 模型 ID。")
  return { endpoint, model, ...(config.apiKey?.trim() ? { apiKey: config.apiKey.trim() } : {}) }
}

let savedRevision = 0

export async function loadJevConfig(): Promise<void> {
  const revision = savedRevision
  try {
    const raw = await invoke<string | null>("jev_config_load")
    const value = raw === null ? null : JSON.parse(raw)
    const config = value === null ? null : normalizeJevConfig(value)
    if (savedRevision === revision) useWikiStore.setState({ jevConfig: config, jevConfigLoadError: null })
  } catch {
    if (savedRevision === revision) useWikiStore.setState({
      jevConfig: null,
      jevConfigLoadError: "无法读取已保存的决策配置。请检查本机凭据文件，或重新填写后保存。",
    })
  }
}

export async function saveJevConfig(value: JevConfig | null): Promise<void> {
  const config = value && normalizeJevConfig(value)
  try {
    await invoke("jev_config_save", { contents: JSON.stringify(config) })
  } catch {
    throw new Error("决策配置未保存。请确认已打开新版桌面应用，并检查本机凭据目录的写入权限。")
  }
  savedRevision++
  useWikiStore.setState({ jevConfig: config, jevConfigLoadError: null })
}

export async function testJevConfig(config: JevConfig): Promise<void> {
  const normalized = normalizeJevConfig(config)
  try {
    await invoke("sag_test_jev", { config: normalized })
  } catch (error) {
    throw jevServiceError(error)
  }
}

export function jevServiceError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (/(?:资料|原文|禁读状态).*(?:已变化|已删除|已移动)/.test(message)) {
    return new Error("项目原文或禁读状态已变化，请重新扫描。")
  }
  const status = message.match(/HTTP\s+(\d{3})/i)?.[1]
  if (status === "401" || status === "403") return new Error(`鉴权失败（HTTP ${status}），请检查访问密钥和模型权限。`)
  if (status === "404") return new Error("找不到决策接口（HTTP 404），请检查服务地址和模型 ID。")
  if (status === "429") return new Error("服务请求过于频繁（HTTP 429），请稍后重试。")
  if (status) return new Error(`决策服务返回 HTTP ${status}，请检查模型配置和服务状态。`)
  if (/超时|timed out/i.test(message)) return new Error("决策服务请求超时，请检查网络或稍后重试。")
  if (/连接|connect|network/i.test(message)) return new Error("无法连接决策服务，请检查地址、网络和代理设置。")
  if (/概率|评分|数量|JSON|响应|判定|answers|decisions/i.test(message)) return new Error("决策服务返回了无效响应，请确认接口支持 JEV 判定并返回有效概率。")
  return new Error("决策服务不可用，请检查配置和服务状态。")
}
