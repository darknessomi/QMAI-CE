import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

describe("人物区段必须能独立滚动", () => {
  const css = readFileSync(
    resolve(process.cwd(), "src/components/uitest/ui-test-tools.css"),
    "utf8",
  )

  const block = (() => {
    const start = css.indexOf(".ui-test-root .ui-test-ptree {")
    expect(start, "找不到 .ui-test-ptree 规则").toBeGreaterThan(-1)
    const end = css.indexOf("}", start)
    return css.slice(start, end)
  })()

  it("填满标签页的剩余空间，长名单在列表内滚动", () => {
    expect(block).toContain("overflow-y: auto")
    expect(block).toContain("flex: 1")
    expect(block).not.toContain("max-height")
  })

  it("允许在父 flex 列里收缩，不再写死 flex-shrink: 0", () => {
    expect(block).not.toContain("flex-shrink: 0")
    expect(block).toContain("min-height: 0")
  })
})
