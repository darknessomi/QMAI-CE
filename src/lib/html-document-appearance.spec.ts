import { describe, expect, it } from "vitest"
import {
  DOCUMENT_APPEARANCE_STYLE_ID,
  applyDocumentAppearance,
} from "./html-document-appearance"

const SOURCE = "<!DOCTYPE html><html><head><style>.chip{background:#fff}</style></head><body>折叠树</body></html>"

/**
 * 带页内锚点的 editorial-v2 文档（Preview iframe 用 srcdoc 渲染的那一类）。
 * 用卷纲的「跳到故事」胶囊导航作样本：档案文档的左侧分区导航已按用户要求删除，
 * 但卷纲/章纲仍靠这类锚点在同一页内跳转，基址注入的需求不变。
 */
const EDITORIAL =
  '<!DOCTYPE html><html lang="zh-CN" data-qmai-layout="editorial-v2"><head><style>.nav{position:sticky}</style></head>' +
  '<body><nav class="nav"><span class="navt">跳到故事</span><a class="navlink" href="#story-1"><b>1</b>开篇</a><a class="navlink" href="#story-2"><b>2</b>转折</a></nav></body></html>'

const SRCDOC_BASE = '<base href="about:srcdoc">'

function styleCount(html: string): number {
  return html.match(new RegExp(`id="${DOCUMENT_APPEARANCE_STYLE_ID}"`, "g"))?.length ?? 0
}

function baseCount(html: string): number {
  return html.match(new RegExp(SRCDOC_BASE, "g"))?.length ?? 0
}

describe("applyDocumentAppearance", () => {
  it("按青瓷和石墨写入对应纸底、墨色和强调色", () => {
    const light = applyDocumentAppearance(SOURCE, "light")
    expect(light).toContain("#fcfdfb")
    expect(light).toContain("#273c35")
    expect(light).toContain("#45624f")
    expect(light).toContain("color-scheme:light")

    const dark = applyDocumentAppearance(SOURCE, "dark")
    expect(dark).toContain("#222f2a")
    expect(dark).toContain("#e6eee7")
    expect(dark).toContain("#b0c9ae")
    expect(dark).toContain("color-scheme:dark")
    expect(dark).not.toContain("#F4EEE8")
    expect(dark).toContain("#2a3832")
  })

  it("注入盖住旧文档的白底，并只保留一段样式", () => {
    const once = applyDocumentAppearance(SOURCE, "dark")
    expect(once).toContain("折叠树")
    expect(once).toContain(".chip{background:#fff}")
    expect(once.indexOf(DOCUMENT_APPEARANCE_STYLE_ID)).toBeGreaterThan(once.indexOf(".chip{background:#fff}"))
    expect(once).toContain('.bt[data-b="顶"]')
    expect(styleCount(once)).toBe(1)

    const twice = applyDocumentAppearance(once, "light")
    expect(styleCount(twice)).toBe(1)
    expect(twice).toContain("#fcfdfb")
    expect(twice).not.toContain("#222f2a")
    expect(twice).toContain("折叠树")
  })

  it("不修改入参，没有 head 时也能注入", () => {
    const snapshot = SOURCE.slice()
    applyDocumentAppearance(SOURCE, "dark")
    expect(SOURCE).toBe(snapshot)

    const bare = applyDocumentAppearance("<p>正文</p>", "light")
    expect(bare.startsWith("<head><style")).toBe(true)
    expect(bare).toContain("#fcfdfb")
    expect(bare).toContain("<p>正文</p>")
    expect(styleCount(bare)).toBe(1)
  })
})

describe("srcdoc iframe 里的分区锚点", () => {
  it("给 editorial-v2 文档补 about:srcdoc 基址，点击导航不再跳到空白页", () => {
    const out = applyDocumentAppearance(EDITORIAL, "light")
    expect(baseCount(out)).toBe(1)
    // 必须落在 head 内，且在任何相对地址解析之前
    expect(out.indexOf(SRCDOC_BASE)).toBeGreaterThan(out.indexOf("<head>"))
    expect(out.indexOf(SRCDOC_BASE)).toBeLessThan(out.indexOf("</head>"))
    expect(out).toContain('href="#story-2"')
  })

  it("换肤重复套用不会叠加基址", () => {
    const once = applyDocumentAppearance(EDITORIAL, "light")
    const twice = applyDocumentAppearance(once, "dark")
    expect(baseCount(twice)).toBe(1)
    expect(styleCount(twice)).toBe(1)
    expect(twice).toContain("#222f2a")
  })

  it("文档自带 base 时尊重原值，不覆盖", () => {
    const withBase = EDITORIAL.replace("<head>", '<head><base href="about:blank">')
    const out = applyDocumentAppearance(withBase, "light")
    expect(out).toContain('<base href="about:blank">')
    expect(out).not.toContain("about:srcdoc")
  })

  it("普通 HTML 文件不注入基址，相对图片照旧解析", () => {
    const plain = '<html><head></head><body><img src="pic.png"><a href="#x">x</a></body></html>'
    const out = applyDocumentAppearance(plain, "light")
    expect(out).not.toContain("<base")
    expect(out).toContain('src="pic.png"')
  })

  it("没有 head 的 editorial 文档也能补上基址", () => {
    const bare = '<p data-qmai-layout="editorial-v2">正文</p>'
    const out = applyDocumentAppearance(bare, "light")
    expect(baseCount(out)).toBe(1)
    expect(styleCount(out)).toBe(1)
    expect(out).toContain("正文")
  })
})

describe("注入样式表的合法性", () => {
  /*
   * `--rail-bg` 虽然已随档案模板的左侧分区导航退场（新生成的文件不再使用它），
   * 但**历史 .html 里仍写着 `background:var(--rail-bg)`**。注入表继续声明它，
   * 才能保证那些旧文件换肤时不会拿到空值 —— 所以它留在清单里是有意的，不是漏删。
   */
  const TOKENS = [
    "--card", "--card-head", "--zebra", "--rail-bg", "--line-strong",
    "--tint-gold", "--tint-jade", "--tint-rose", "--tint-sand", "--shadow-1", "--shadow-2",
  ]

  function injectedCss(skin: "light" | "dark"): string {
    const out = applyDocumentAppearance(EDITORIAL, skin)
    return out.match(new RegExp(`<style id="${DOCUMENT_APPEARANCE_STYLE_ID}">([\\s\\S]*?)</style>`))![1]
  }

  it("两条规则之间不夹分号，否则后一条会被浏览器整条丢弃", () => {
    for (const skin of ["light", "dark"] as const) {
      const css = injectedCss(skin)
      for (const match of css.matchAll(/\}([^{}]*)\{/g)) {
        expect(match[1], `${skin} 的规则之间多了一个分隔符`).not.toContain(";")
      }
    }
  })

  it("档案配色令牌在两种皮肤里都被声明", () => {
    for (const skin of ["light", "dark"] as const) {
      const css = injectedCss(skin)
      const declared = [...css.matchAll(/:root\{([^}]*)\}/g)].flatMap((match) =>
        [...match[1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((token) => token[1]),
      )
      for (const token of TOKENS) {
        expect(declared, `${skin} 皮肤缺少 ${token}`).toContain(token)
      }
    }
  })

  it("石墨皮肤是深色纸面，卡片底不能漏成浅色", () => {
    const read = (skin: "light" | "dark", token: string) =>
      injectedCss(skin).match(new RegExp(`${token}:([^;}]+)`))?.[1] ?? ""
    expect(read("dark", "--card")).toMatch(/^#2/i)
    expect(read("dark", "--tint-gold")).toMatch(/^#2/i)
    expect(read("light", "--card")).toMatch(/^#f/i)
    expect(read("dark", "--card")).not.toBe(read("light", "--card"))
  })
})
