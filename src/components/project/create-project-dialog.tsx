import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ArrowRight, FolderOpen, X } from "lucide-react"
import { createProject, writeFile, createDirectory } from "@/commands/fs"
import { getTemplate } from "@/lib/templates"
import type { WikiProject } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore, type OutputLanguage } from "@/stores/wiki-store"
import { saveOutputLanguage } from "@/lib/project-store"
import { pickDirectory } from "@/lib/platform"
import { getDefaultNovelDir } from "@/lib/default-paths"
import { pickGuideDemoNovel, readGuideDemoNovel, rememberGuideDemoNovel } from "@/lib/guide/guide-demo-novel"
import { useGuideStore } from "@/lib/guide/guide-store"
import "@/components/uitest/ui-test-shelf.css"

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (project: WikiProject) => void
}

export function CreateProjectDialog({ open: isOpen, onOpenChange, onCreated }: CreateProjectDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState("")
  const [path, setPath] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [creating, setCreating] = useState(false)
  const setOutputLanguage = useWikiStore((s) => s.setOutputLanguage)

  useEffect(() => {
    if (!isOpen) {
      setPath(null)
      return
    }
    let cancelled = false
    void getDefaultNovelDir().catch(() => "").then((defaultPath) => {
      if (!cancelled) setPath((current) => current ?? defaultPath)
    })
    return () => { cancelled = true }
  }, [isOpen])

  /**
   * 新手引导里「随机填一个示例书名」。
   *
   * 只在引导进行中生效，普通用户点「新建小说」不会看到被塞进来的名字。
   * 书名同时写进 localStorage（`rememberGuideDemoNovel`）：走到章节阶段要往
   * **同一本书**里放示例正文，不能重新随机一本。
   */
  useEffect(() => {
    if (!isOpen) return
    if (useGuideStore.getState().status !== "running") return
    const novel = readGuideDemoNovel() ?? pickGuideDemoNovel()
    rememberGuideDemoNovel(novel)
    setName((current) => (current.trim() ? current : novel.name))
  }, [isOpen])

  async function handleBrowse() {
    const dir = await pickDirectory()
    if (dir) setPath(dir)
  }

  async function handleCreate() {
    if (!name.trim()) {
      setError(t("project.errorNameRequired"))
      return
    }
    if (!path || creating) return
    setCreating(true)
    setError("")
    try {
      const parentDir = normalizePath(path)
      await createDirectory(parentDir)

      const project = await createProject(name.trim(), parentDir)
      const pp = normalizePath(project.path)

      const template = getTemplate("general")
      await writeFile(`${pp}/schema.md`, template.schema)
      await writeFile(`${pp}/purpose.md`, template.purpose)
      for (const dir of template.extraDirs) {
        await createDirectory(`${pp}/${dir}`)
      }

      const lang: OutputLanguage = "Chinese"
      setOutputLanguage(lang)
      await saveOutputLanguage(lang, project.id)

      onCreated(project)
      onOpenChange(false)
      setName("")
      setPath(null)
    } catch (err) {
      setError(String(err))
    } finally {
      setCreating(false)
    }
  }

  const uiError = error && (error === t("project.errorNameRequired")
      ? "请输入小说名称。"
      : /[\u4e00-\u9fff]/.test(error)
        ? error.replace(/^Error:\s*/, "")
        : "创建失败，请检查目录权限或是否已存在同名小说后重试。")

    return (
      <Dialog open={isOpen} onOpenChange={(open) => { if (!creating) onOpenChange(open) }}>
        <DialogContent
          className="ui-test-create-project-dialog"
          data-ui-test-dialog="create-project"
          showCloseButton={false}
          initialFocus={() => document.getElementById("ui-test-novel-name")}
        >
          <div className="ui-test-create-header">
            <div>
              <DialogTitle className="ui-test-create-title">让一个新故事开始</DialogTitle>
              <DialogDescription className="ui-test-create-caption">创建后直接进入大纲，从故事的起点开始。</DialogDescription>
            </div>
            <button
              type="button"
              className="ui-test-create-close"
              aria-label="关闭新建小说"
              title="关闭新建小说"
              disabled={creating}
              onClick={() => onOpenChange(false)}
            >
              <X aria-hidden="true" />
            </button>
          </div>
          <form
            className="ui-test-create-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (!creating) void handleCreate()
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) {
                event.preventDefault()
              }
            }}
          >
            <div className="ui-test-create-body">
              <div className="ui-test-create-field">
                <Label htmlFor="ui-test-novel-name">小说名称</Label>
                <Input
                  id="ui-test-novel-name"
                  data-guide="create.name"
                  className="ui-test-create-name"
                  aria-required="true"
                  aria-invalid={!!uiError && error === t("project.errorNameRequired")}
                  aria-describedby={uiError ? "ui-test-create-error" : undefined}
                  value={name}
                  disabled={creating}
                  onChange={(event) => { setName(event.target.value); if (error) setError("") }}
                  placeholder="给你的故事起个名字"
                />
              </div>
              <div className="ui-test-create-field">
                <Label htmlFor="ui-test-novel-location">存放位置</Label>
                <div className="ui-test-create-location" data-guide="create.location">
                  <output id="ui-test-novel-location" className="ui-test-create-path">
                    {path === null ? "正在读取默认小说目录…" : path || "无法读取默认目录，请选择存放位置。"}
                  </output>
                  <button
                    type="button"
                    className="ui-test-create-button browse"
                    disabled={creating}
                    onClick={() => {
                      void handleBrowse().catch(() => setError("无法打开目录选择器，请稍后重试。"))
                    }}
                  >
                    <FolderOpen aria-hidden="true" />
                    选择目录
                  </button>
                </div>
                <p className="ui-test-create-hint">使用本机默认小说目录，可另选位置。</p>
                {uiError && <p id="ui-test-create-error" className="ui-test-create-error" role="alert">{uiError}</p>}
              </div>
              <div className="ui-test-create-note">
                <p>先写清故事大纲，再开始第一章。</p>
                <p>已有资料也可以导入，手动写作不需要配置 AI 模型。</p>
              </div>
            </div>
            <div className="ui-test-create-footer">
              <button type="button" className="ui-test-create-button" disabled={creating} onClick={() => onOpenChange(false)}>取消</button>
              <button type="submit" className="ui-test-create-button primary" data-guide="create.submit" disabled={creating || !name.trim() || !path}>
                <ArrowRight aria-hidden="true" />
                {creating ? "创建中…" : "创建并写大纲"}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    )
}
