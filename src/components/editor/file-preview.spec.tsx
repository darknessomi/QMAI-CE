// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FilePreview } from "./file-preview"
import { WikiReader } from "./wiki-reader"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const SOURCE = "<!DOCTYPE html><html><head></head><body>原文</body></html>"

describe("文件预览", () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement("div")
    document.body.appendChild(host)
    root = createRoot(host)
    document.documentElement.dataset.uiTestSkin = "dark"
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    delete document.documentElement.dataset.uiTestSkin
  })

  it("预览 iframe 带当前皮肤，源码框保持未注入的原文", async () => {
    await act(async () => {
      root.render(<FilePreview filePath="outline.html" textContent={SOURCE} />)
    })

    const iframe = host.querySelector("iframe") as HTMLIFrameElement
    expect(iframe).not.toBeNull()
    expect(iframe.srcdoc).toContain("qmai-document-appearance")
    expect(iframe.srcdoc).toContain("#222f2a")
    expect(iframe.srcdoc).toContain("原文")
    expect(iframe.className).toContain("bg-transparent")

    const sourceButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("源码"),
    ) as HTMLButtonElement
    await act(async () => {
      sourceButton.click()
    })

    const textarea = host.querySelector("textarea") as HTMLTextAreaElement
    expect(textarea.value).toBe(SOURCE)
    expect(textarea.value).not.toContain("qmai-document-appearance")
  })

  it("文本预览和阅读页将旧 Mermaid 内容显示为代码块", async () => {
    const markdown = ["```mermaid", "flowchart LR", "A --> B", "```", "", "```text", "普通代码", "```"].join("\n")
    await act(async () => {
      root.render(
        <>
          <FilePreview filePath="outline.txt" textContent={markdown} />
          <WikiReader body={markdown} />
        </>,
      )
    })

    const codeBlocks = [...host.querySelectorAll("pre > code")]
    expect(codeBlocks.map((block) => block.textContent?.trim())).toEqual([
      "flowchart LR\nA --> B", "普通代码", "flowchart LR\nA --> B", "普通代码",
    ])
  })
})
