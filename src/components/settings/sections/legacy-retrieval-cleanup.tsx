import { useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { Button } from "@/components/ui/button"
import { confirmAction } from "@/lib/confirm-action"
import { useWikiStore } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"

export function LegacyRetrievalCleanup({ project }: { project: WikiProject | null }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")

  async function clean(scope: "project" | "summaries" | "app") {
    if (busy) return
    setBusy(true)
    setMessage("")
    try {
      if (scope === "app") {
        const confirmed = await confirmAction(
          "将永久移除本机应用主配置和自动恢复副本中的旧向量模型、旧重排模型配置及密钥，包括所有项目在应用内保存的旧重排记录。",
          "清理应用内的旧模型凭据",
        )
        if (!confirmed) return
        const changed = await invoke<boolean>("clear_legacy_retrieval_credentials")
        setMessage(changed ? "已清理应用内的旧模型配置和凭据。" : "应用内没有旧模型配置或凭据。")
        return
      }
      if (!project) return
      const summaries = scope === "summaries"
      const description = summaries
        ? `将永久删除「${project.name}」中由旧版生成的社区摘要。章节摘要、章节快照和实体页均保留。`
        : `将永久删除「${project.name}」的旧 LanceDB 索引、向量清单和索引日志、查重向量缓存和旧重排配置。`
      const confirmed = await confirmAction(
        `${description}\n\n项目位置：${project.path}`,
        summaries ? "清理当前项目的旧社区摘要" : "清理当前项目的旧检索数据",
      )
      if (!confirmed || useWikiStore.getState().project?.path !== project.path) return
      const params = { projectPath: project.path }
      if (summaries) {
        const { removed, skipped } = await invoke<{ removed: number; skipped: number }>("clear_legacy_community_summaries", params)
        const result = removed ? `已清理当前项目的 ${removed} 份旧社区摘要。` : "当前项目没有可清理的旧社区摘要。"
        setMessage(result + (skipped ? `已保留 ${skipped} 个其他条目。` : ""))
      } else {
        const count = await invoke<number>("clear_legacy_project_retrieval", params)
        setMessage(count ? `已清理当前项目的 ${count} 项旧检索数据。` : "当前项目没有旧检索数据。")
      }
    } catch (error) {
      setMessage(`清理失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
      <h3 className="text-sm font-semibold">旧版检索数据</h3>
      <p className="text-xs leading-relaxed text-muted-foreground">
        可分别清理当前项目的旧索引和旧社区摘要。应用凭据清理对本机所有项目生效。SAG2 索引和 JEV 配置均保留。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy || !project} onClick={() => void clean("project")}>
          清理当前项目旧索引和配置
        </Button>
        <Button variant="outline" size="sm" disabled={busy || !project} onClick={() => void clean("summaries")}>
          清理当前项目旧社区摘要
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void clean("app")}>
          清理应用旧模型凭据
        </Button>
      </div>
      {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
    </section>
  )
}
