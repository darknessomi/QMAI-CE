import { describe, expect, it } from "vitest"
import { wikiEmbeddingId, wikiEmbeddingPath, wikiEmbeddingTitle } from "./embedding-page-id"

describe("小说向量页面身份", () => {
  it("物理与逻辑路径一致，同名的不同页面仍然各有身份", () => {
    const id = wikiEmbeddingId("C:/书", "C:\\书\\QM\\outlines\\卷一\\O'Brien%27.md")
    expect(id).toBe("wiki/outlines/卷一/O%27Brien%2527")
    expect(wikiEmbeddingPath("C:/书", id!)).toBe("C:/书/wiki/outlines/卷一/O'Brien%27.md")
    expect(wikiEmbeddingId("C:/书", "wiki/entities/O'Brien%27.md")).not.toBe(id)
    expect(wikiEmbeddingPath("C:/书", "wiki/entities/../../secret")).toBeNull()
    expect(wikiEmbeddingPath("C:/书", "community:abcd")).toBeNull()
  })
  it("正文里的 title: 不参与资料标题提取", () => {
    expect(wikiEmbeddingTitle("---\ntype: entity\n---\n# 记录\ntitle: 错误", "后备")).toBe("后备")
    expect(wikiEmbeddingTitle("---\ntitle: 正确\n---\ntitle: 错误", "后备")).toBe("正确")
  })
})
