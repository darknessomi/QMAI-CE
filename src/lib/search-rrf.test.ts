import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { join } from "node:path"
import { realFs, createTempProject } from "@/test-helpers/fs-temp"
import { useWikiStore } from "@/stores/wiki-store"
import { searchWiki } from "./search"
import { searchSagProject, sagSearchFiles } from "./sag-search"

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke }))
vi.mock("@/commands/fs", () => realFs)

const config = { endpoint: "http://test/decisions", model: "test" }
let project: Awaited<ReturnType<typeof createTempProject>>

beforeEach(async () => {
  project = await createTempProject("sag-search")
  invoke.mockReset()
  useWikiStore.setState({ jevConfig: null })
})
afterEach(async () => { await project.cleanup() })

describe("项目检索路由", () => {
  it("保留未配置判定模型时的关键词排名及分数", async () => {
    await realFs.writeFile(join(project.path, "wiki/attention.md"), "# Attention\n\n相关知识")
    await realFs.writeFile(join(project.path, "wiki/other.md"), "# Other\n\nmention attention")
    await realFs.writeFile(join(project.path, "wiki/private.md"), "---\nai_exclude: true\n---\nattention attention attention")
    const out = await searchWiki(project.path, "attention")
    expect(out.map(hit => hit.title)).toEqual(["Attention", "Other"])
    expect(out.map(hit => hit.score)).toEqual([1 / 61, 1 / 62])
    expect(invoke).not.toHaveBeenCalled()
  })

  it("配置后将项目内的 Markdown 清单交给原生层校验，保留同一页的多个原文位置", async () => {
    useWikiStore.setState({ jevConfig: config })
    const path = join(project.path, "wiki/visible.md")
    await realFs.writeFile(path, "这个文件连关键词也没有。")
    await realFs.writeFile(join(project.path, "wiki/secret.md"), "---\nai_exclude: yes\n---\n不得发送")
    await realFs.writeFile(join(project.path, "raw/other.md"), "其它来源")
    invoke.mockResolvedValue([2, 4].map(startLine => ({
      path, startLine, endLine: startLine + 1, title: "可见", content: "原文引句", score: 0.8,
    })))
    const out = await searchWiki(project.path, "提问")
    expect(out.map(hit => [hit.snippet, hit.startLine, hit.endLine])).toEqual([["原文引句", 2, 3], ["原文引句", 4, 5]])
    expect(invoke).toHaveBeenCalledExactlyOnceWith("sag_search", expect.objectContaining({ files: expect.arrayContaining([path, join(project.path, "wiki/secret.md")]), query: "提问", config }))
  })

  it("搜索面板从原页补回图片，保留段落排名并过滤刚被禁读的页面", async () => {
    useWikiStore.setState({ jevConfig: config })
    const path = join(project.path, "wiki/渡口.md")
    const privatePath = join(project.path, "wiki/工程图.md")
    await realFs.writeFile(path, "# 渡口\n\n原文。\n\n![码头](assets/port.png)\n![重复](assets/port.png)")
    await realFs.writeFile(privatePath, "# 工程图")
    invoke.mockImplementation(async () => {
      await realFs.writeFile(privatePath, "---\nai_exclude: true\n---\n![内部图](private.png)")
      return [path, privatePath, path].map((file, index) => ({
        path: file, title: "渡口", content: "段落" + index, startLine: 3 + index, endLine: 3 + index, score: 1 - index / 10,
      }))
    })
    const displayed = await searchWiki(project.path, "渡口", { includePageImages: true })
    expect(displayed.map(hit => [hit.snippet, hit.startLine])).toEqual([["段落0", 3], ["段落2", 5]])
    for (const hit of displayed) expect(hit.images).toEqual([{ url: "assets/port.png", alt: "码头" }])
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("port.png")
    invoke.mockResolvedValueOnce([{ path, title: "渡口", content: "段落0", startLine: 3, endLine: 3, score: 1 }])
    const evidence = await searchWiki(project.path, "渡口")
    expect(evidence).toMatchObject([{ snippet: "段落0", images: [] }])
  })

  it("写作只枚举章节目录并传入严格上界，第一章和空清单不发请求", async () => {
    useWikiStore.setState({ jevConfig: config })
    const chapter = (n: number, status: string, extra = "") => `---\nchapter_number: ${n}\nchapter_status: ${status}\n${extra}---\n原文`
    const dir = join(project.path, "wiki/chapters")
    await realFs.writeFile(join(dir, "one.md"), chapter(1, "final"))
    await realFs.writeFile(join(dir, "two.md"), chapter(2, "draft"))
    await realFs.writeFile(join(dir, "three.md"), chapter(3, "final", "ai_exclude: true\n"))
    await realFs.writeFile(join(dir, "four.md"), chapter(4, "final"))
    await realFs.writeFile(join(project.path, "wiki/memory/plot.md"), "跨章摘要")
    invoke.mockResolvedValue([])
    await searchSagProject(project.path, "查证", 8, { beforeChapter: 4 })
    const args = invoke.mock.calls.at(-1)![1]
    expect(args.beforeChapter).toBe(4)
    expect(args.files).toHaveLength(4)
    expect(args.files.every((path: string) => path.startsWith(dir + "/"))).toBe(true)
    expect(await searchSagProject(project.path, "查证", 8, { beforeChapter: 1 })).toEqual([])
    expect(await sagSearchFiles(project.path, "查证", [], 8)).toEqual([])
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it("模型失败显式返回错误，取消请求使用同一请求 ID", async () => {
    useWikiStore.setState({ jevConfig: config })
    const files = [join(project.path, "wiki/a.md")]
    invoke.mockRejectedValueOnce(new Error("模型请求超时"))
    await expect(sagSearchFiles(project.path, "q", files, 3)).rejects.toThrow("SAG2 检索失败")
    let finish!: () => void
    invoke.mockImplementation((name: string) => name === "sag_search"
      ? new Promise(resolve => { finish = () => resolve([]) })
      : Promise.resolve())
    const controller = new AbortController()
    const pending = sagSearchFiles(project.path, "q", files, 3, controller.signal)
    controller.abort()
    expect(invoke.mock.calls.at(-1)).toEqual(["sag_cancel", { requestId: invoke.mock.calls.at(-2)![1].requestId }])
    finish()
    await expect(pending).rejects.toThrow()
  })
})
