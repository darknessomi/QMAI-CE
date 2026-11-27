export type ExportSource =
  | "chapters"
  | "outlines"

export interface ExportDocumentBlock {
  title: string
  paragraphs: string[]
}

export interface ExportDocument {
  title: string
  source: ExportSource
  blocks: ExportDocumentBlock[]
}
