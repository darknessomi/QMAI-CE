/**
 * 伴生文件（.html / .json）的路径推导与搬移。
 *
 * 这些函数是「删大纲留下孤儿 HTML/JSON」缺陷的修复基础：
 * - 删除走回收站（trash.ts）；
 * - 改名/移动走这里的 moveOutlineDocument；
 * - 直接清理走 deleteOutlineCompanions。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/commands/fs", () => ({
  movePathIfAbsent: vi.fn(),
  writeFileAtomic: vi.fn(),
  deleteFile: vi.fn(),
  fileExists: vi.fn(),
}))

import {
  OUTLINE_COMPANION_EXTENSIONS,
  deleteOutlineCompanions,
  moveOutlineDocument,
  outlineCompanionPaths,
  outlineDocumentNodes,
} from "./outline-companions"

import { deleteFile, fileExists, movePathIfAbsent, writeFileAtomic } from "@/commands/fs"

const mockMove = vi.mocked(movePathIfAbsent)
const mockWrite = vi.mocked(writeFileAtomic)
const mockDeleteFile = vi.mocked(deleteFile)
const mockFileExists = vi.mocked(fileExists)

const mdPath = "E:/Novel/wiki/outlines/卷纲/卷纲-第01卷.md"

beforeEach(() => {
  mockMove.mockReset()
  mockWrite.mockReset()
  mockDeleteFile.mockReset()
  mockFileExists.mockReset()
})

describe("outlineCompanionPaths", () => {
  it("由 .md 推出 .html 与 .json", () => {
    expect(outlineCompanionPaths(mdPath)).toEqual([
      "E:/Novel/wiki/outlines/卷纲/卷纲-第01卷.html",
      "E:/Novel/wiki/outlines/卷纲/卷纲-第01卷.json",
    ])
    expect(OUTLINE_COMPANION_EXTENSIONS).toEqual(["html", "json"])
  })

  it("反斜杠路径归一化后再推导", () => {
    expect(outlineCompanionPaths("E:\\Novel\\wiki\\outlines\\a.md")[0]).toBe(
      "E:/Novel/wiki/outlines/a.html",
    )
  })

  it("非 .md 文件没有伴生文件", () => {
    expect(outlineCompanionPaths("E:/Novel/wiki/outlines/a.html")).toEqual([])
  })
})

describe("outlineDocumentNodes", () => {
  it.each(["人物小传", "自定义/迁移后"])("在 %s 打开独存 HTML，双格式和投影不占重复入口", (folder) => {
    const root = `/book/wiki/outlines/${folder}`
    const files = ["独存.html", "双格式.md", "双格式.html", "双格式.json", "投影.md", "投影.html"]
    const nodes = [{ name: folder, path: root, is_dir: true, children:
      files.map((name) => ({ name, path: `${root}/${name}`, is_dir: false })) }]
    const tree = outlineDocumentNodes(nodes, (path) => path.endsWith("/投影.md"))
    expect(tree[0].children?.map((node) => node.path)).toEqual([`${root}/独存.html`, `${root}/双格式.md`])
  })
})

describe("deleteOutlineCompanions", () => {
  it("只删存在的伴生文件，返回删除个数", async () => {
    mockFileExists.mockImplementation(async (path: string) => path.endsWith(".html"))
    mockDeleteFile.mockResolvedValue(undefined)

    const deleted = await deleteOutlineCompanions(mdPath)

    expect(deleted).toBe(1)
    expect(mockDeleteFile).toHaveBeenCalledTimes(1)
    expect(mockDeleteFile).toHaveBeenCalledWith("E:/Novel/wiki/outlines/卷纲/卷纲-第01卷.html")
  })

  it("删除失败不抛出（删主文件不能被伴生文件拖住）", async () => {
    mockFileExists.mockResolvedValue(true)
    mockDeleteFile.mockRejectedValue(new Error("EBUSY"))
    await expect(deleteOutlineCompanions(mdPath)).resolves.toBe(0)
  })
})

describe("moveOutlineDocument", () => {
  const dest = "E:/Novel/wiki/outlines/人物小传/新名字.md"
  function setupFiles() {
    const [html, json] = outlineCompanionPaths(mdPath)
    const files = new Map([[mdPath, "# 原文"], [html, "<html/>"], [json, "{}"]])
    mockFileExists.mockImplementation(async (path) => files.has(path))
    mockMove.mockImplementation(async (source, destination) => {
      if (!files.has(source) || files.has(destination)) throw new Error("文件冲突")
      files.set(destination, files.get(source)!)
      files.delete(source)
    })
    mockWrite.mockImplementation(async (path, content) => { files.set(path, content) })
    return files
  }

  it("主文和所有伴生内容同组改名，只改主文标题", async () => {
    const files = setupFiles()
    const moved = await moveOutlineDocument(mdPath, dest, "# 改名后")
    const [html, json] = outlineCompanionPaths(dest)
    expect(files).toEqual(new Map([[dest, "# 改名后"], [html, "<html/>"], [json, "{}"]]))
    expect(moved).toContainEqual({ source: outlineCompanionPaths(mdPath)[0], destination: html })
  })

  it("目标已有 HTML 时保护双方，即使源只有 MD", async () => {
    const files = setupFiles()
    files.delete(outlineCompanionPaths(mdPath)[0])
    files.set(outlineCompanionPaths(dest)[0], "另存的手写小传")
    const before = new Map(files)
    await expect(moveOutlineDocument(mdPath, dest)).rejects.toThrow("同名")
    expect(files).toEqual(before)
    expect(mockMove).not.toHaveBeenCalled()
  })

  it("改标题失败时原路径与内容均恢复", async () => {
    const files = setupFiles()
    const before = new Map(files)
    mockWrite.mockRejectedValueOnce(new Error("写入失败"))
    await expect(moveOutlineDocument(mdPath, dest, "新标题")).rejects.toThrow("写入失败")
    expect(files).toEqual(before)
  })
})
