import { useEffect, useState } from "react"
import { useWikiStore, type JevConfig } from "@/stores/wiki-store"
import { saveJevConfig, testJevConfig } from "@/lib/jev-config"
import { ModelSecretInput } from "./model-secret-input"
import { useModelDraftGuard } from "./model-draft-guard"
import "./model-settings.css"

const blank: JevConfig = { endpoint: "", model: "" }

export function JevModelSettings() {
  const saved = useWikiStore(state => state.jevConfig)
  const loadError = useWikiStore(state => state.jevConfigLoadError)
  const [draft, setDraft] = useState<JevConfig>(saved ?? blank)
  const [changed, setChanged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean } | null>(null)
  useEffect(() => { if (!changed) setDraft(saved ?? blank) }, [saved, changed])

  const update = (patch: Partial<JevConfig>) => {
    setDraft(current => ({ ...current, ...patch }))
    setChanged(true)
    setFeedback(null)
  }
  const save = async () => {
    setBusy(true)
    try {
      const empty = !draft.endpoint.trim() && !draft.model.trim() && !draft.apiKey?.trim()
      await saveJevConfig(empty ? null : draft)
      setChanged(false)
      setFeedback({ text: empty ? "已保存，使用基础检索。" : "JEV 配置已保存。" })
      return true
    } catch (error) {
      setFeedback({ text: error instanceof Error ? error.message : "JEV 配置保存失败。", error: true })
      return false
    } finally { setBusy(false) }
  }
  useModelDraftGuard("jev", "SAG2 决策模型", changed, busy, save, () => setChanged(false))

  const test = async () => {
    setBusy(true)
    setFeedback({ text: "正在测试连接…" })
    try {
      await testJevConfig(draft)
      setFeedback({ text: "测试通过，服务返回了有效判断。" })
    } catch (error) {
      setFeedback({ text: error instanceof Error ? error.message : "决策服务测试失败。", error: true })
    } finally { setBusy(false) }
  }

  const status = feedback ?? (loadError ? { text: loadError, error: true } : null)
  return <section className="model-provider-card" aria-label="SAG2 决策模型">
    <header>
      <div className="model-provider-main">
        <h3 className="model-provider-name">JEV 决策接口</h3>
        <p className="model-note">写作和问答用它筛选原文，查重时用它核对页面身份。全部留空并保存即可使用基础检索。</p>
      </div>
    </header>
    <fieldset className="model-form" disabled={busy}>
      <div className="model-fields">
        <label className="model-field full">
          <span>服务地址</span>
          <input aria-label="服务地址" placeholder="https://api.example.com/v1/decisions" value={draft.endpoint} onChange={e => update({ endpoint: e.target.value })} spellCheck={false} />
        </label>
        <label className="model-field">
          <span>模型 ID</span>
          <input aria-label="模型 ID" value={draft.model} onChange={e => update({ model: e.target.value })} spellCheck={false} />
        </label>
        <div className="model-field">
          <label htmlFor="jev-api-key">访问密钥（可选）</label>
          <ModelSecretInput id="jev-api-key" value={draft.apiKey ?? ""} onChange={apiKey => update({ apiKey })} />
        </div>
      </div>
    </fieldset>
    <footer className="model-save-footer">
      <p role="status" className={status?.error ? "model-feedback error" : "model-feedback"}>
        {status?.text ?? (changed ? "有未保存的修改。" : "")}
      </p>
      <div className="model-actions">
        <button type="button" className="model-button" onClick={() => void test()} disabled={busy || !draft.endpoint.trim() || !draft.model.trim()}>测试连接</button>
        <button type="button" className="model-button primary" onClick={() => void save()} disabled={busy || !changed}>保存配置</button>
      </div>
    </footer>
  </section>
}
