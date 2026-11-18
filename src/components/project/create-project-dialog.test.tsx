import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = readFileSync(resolve(__dirname, "create-project-dialog.tsx"), "utf8")

describe("新建小说项目弹窗", () => {
  it("支持表单回车直接创建", () => {
    expect(source).toContain("<form")
    expect(source).toContain('type="submit"')
    expect(source).toContain("event.preventDefault()")
  })

  it("打开时读取默认目录，创建时使用选定的父目录", () => {
    expect(source).toContain("getDefaultNovelDir()")
    expect(source).toContain("const parentDir = normalizePath(path)")
    expect(source).toContain("await createDirectory(parentDir)")
    expect(source).toContain("await createProject(name.trim(), parentDir)")
  })
})
