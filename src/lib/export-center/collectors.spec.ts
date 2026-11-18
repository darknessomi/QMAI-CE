import { describe, expect, it } from "vitest"
import { collectAllProjectSources, collectSourceDocuments, type CollectorFileApi } from "./collectors"
import type { FileNode, WikiProject } from "@/types/wiki"

const project: WikiProject = { id: "p1", name: "长安夜雨", path: "C:/Novel" }

function file(name: string, path: string): FileNode {
  return { name, path, is_dir: false }
}

function dir(name: string, path: string): FileNode {
  return { name, path, is_dir: true }
}

function api(
  directories: Record<string, FileNode[]>,
  files: Record<string, string>,
): CollectorFileApi {
  return {
    listDirectory: async (path) => {
      if (!(path in directories)) throw new Error("目录不存在")
      return directories[path]
    },
    readFile: async (path) => {
      if (!(path in files)) throw new Error("文件不存在")
      return files[path]
    },
  }
}

describe("统一导出 Collector", () => {
  it("按自然章节号顺序只读收集章节", async () => {
    const source = api(
      { "C:/Novel/wiki/chapters": [file("第10章.md", "c10"), file("第2章.md", "c2")] },
      { c10: "# 第十章\n\n后发生", c2: "# 第二章\n\n先发生\n\n第二段" },
    )

    const documents = await collectSourceDocuments(project, "chapters", source)

    expect(documents).toHaveLength(1)
    expect(documents[0].title).toBe("长安夜雨-章节")
    expect(documents[0].blocks.map((block) => block.title)).toEqual(["第二章", "第十章"])
    expect(documents[0].blocks[0].paragraphs).toEqual(["先发生", "第二段"])
  })

  it("章节文件名与 frontmatter chapter_number 冲突时优先按 chapter_number 排序", async () => {
    const source = api(
      {
        "C:/Novel/wiki/chapters": [
          file("chapter-001.md", "named-first"),
          file("chapter-999.md", "named-last"),
        ],
      },
      {
        "named-first": "---\nchapter_number: 2\ntitle: 文件名靠前但实际第二章\n---\n# 文件名靠前但实际第二章\n\n第二章正文",
        "named-last": "---\nchapter_number: 1\ntitle: 文件名靠后但实际第一章\n---\n# 文件名靠后但实际第一章\n\n第一章正文",
      },
    )

    const [document] = await collectSourceDocuments(project, "chapters", source)

    expect(document.blocks.map((block) => block.title)).toEqual([
      "文件名靠后但实际第一章",
      "文件名靠前但实际第二章",
    ])
  })

  it("大纲按产品显示标题规则提取序号，而不是按文件名排序", async () => {
    const source = api(
      { "C:/Novel/wiki/outlines": [file("a-文件名靠前.md", "o10"), file("z-文件名靠后.md", "o2")] },
      {
        o10: "---\ntitle: 第十卷 终局\n---\n# 被 frontmatter 标题覆盖\n\n终局",
        o2: "# 第二卷 发展\n\n发展",
      },
    )

    const [document] = await collectSourceDocuments(project, "outlines", source)

    expect(document.blocks.map((block) => block.title)).toEqual(["第二卷 发展", "第十卷 终局"])
  })

  it("大纲同级目录使用 KnowledgeTree 的 zh-CN localeCompare 顺序递归导出", async () => {
    const source = api(
      {
        "C:/Novel/wiki/outlines": [
          {
            ...dir("卷10", "dir-10"),
            children: [file("chapter-001.md", "dir10-child")],
          },
          file("root-000.md", "root-file"),
          {
            ...dir("卷2", "dir-2"),
            children: [file("chapter-100.md", "dir2-child")],
          },
        ],
      },
      {
        "dir10-child": "# 第1章 卷十内容\n\n卷十",
        "dir2-child": "# 第100章 卷二内容\n\n卷二",
        "root-file": "# 第0章 根目录文件\n\n根目录",
      },
    )

    const [document] = await collectSourceDocuments(project, "outlines", source)

    expect(document.blocks.map((block) => block.title)).toEqual([
      "第1章 卷十内容",
      "第100章 卷二内容",
      "第0章 根目录文件",
    ])
  })

  it("大纲无元数据和标题时将文件名短横线转换为空格作为显示标题", async () => {
    const source = api(
      { "C:/Novel/wiki/outlines": [file("long-night-plan.md", "hyphen-outline")] },
      { "hyphen-outline": "没有 frontmatter，也没有 Markdown 标题。" },
    )

    const [document] = await collectSourceDocuments(project, "outlines", source)

    expect(document.blocks[0].title).toBe("long night plan")
  })

  it("大纲只有二级到六级标题时使用文件名显示标题并保留低级标题正文", async () => {
    const source = api(
      { "C:/Novel/wiki/outlines": [file("deep-outline-note.md", "deep-heading-outline")] },
      { "deep-heading-outline": "## 二级标题\n\n正文段落\n\n###### 六级标题\n\n结尾" },
    )

    const [document] = await collectSourceDocuments(project, "outlines", source)

    expect(document.blocks[0].title).toBe("deep outline note")
    expect(document.blocks[0].paragraphs).toEqual([
      "## 二级标题",
      "正文段落",
      "###### 六级标题",
      "结尾",
    ])
  })

  it("单一来源异常时 collectAllProjectSources 保留其他来源结果", async () => {
    const isolatedApi: CollectorFileApi = {
      listDirectory: async (path) => {
        if (path.endsWith("wiki/chapters")) return null as unknown as FileNode[]
        if (path.endsWith("wiki/outlines")) return [file("outline.md", "good-outline")]
        throw new Error("目录不存在")
      },
      readFile: async (path) => {
        if (path === "good-outline") return "# 可用大纲\n\n内容"
        throw new Error("文件不存在")
      },
    }

    const result = await collectAllProjectSources(project, isolatedApi)

    expect(result.chapters).toEqual([])
    expect(result.outlines[0].blocks[0].title).toBe("可用大纲")
  })

  it("章节与大纲来源缺失时返回空结果并标记不可用", async () => {
    const missingApi = api({}, {})

    const result = await collectAllProjectSources(project, missingApi)

    expect(Object.values(result).every((documents) => documents.length === 0)).toBe(true)
  })
})
