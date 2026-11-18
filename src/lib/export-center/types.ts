export type ExportSource =
  | "chapters"
  | "outlines"

export type ExportFormat = "txt" | "docx"

export interface ExportDocumentBlock {
  title: string
  paragraphs: string[]
}

export interface ExportDocument {
  title: string
  source: ExportSource
  blocks: ExportDocumentBlock[]
}
