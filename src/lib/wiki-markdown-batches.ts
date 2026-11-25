import { readMarkdownBatch } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"

const MAX_BATCH_FILES = 128
const MAX_BATCH_BYTES = 1_048_576
const MAX_CONCURRENT_BATCHES = 16

interface MarkdownBatch {
  files: FileNode[]
  slots: number
}

function* batchWindows(files: FileNode[]): Generator<MarkdownBatch[]> {
  let window: MarkdownBatch[] = []
  let windowSlots = 0
  let start = 0
  while (start < files.length) {
    let end = start + 1
    let bytes = files[start].size ?? 0
    while (end < files.length && end - start < MAX_BATCH_FILES) {
      const size = files[end].size ?? 0
      if (bytes + size > MAX_BATCH_BYTES) break
      bytes += size
      end++
    }
    // 一个超预算的文件独占整个窗口和桌面读取名额。
    const slots = bytes > MAX_BATCH_BYTES ? MAX_CONCURRENT_BATCHES : 1
    if (windowSlots + slots > MAX_CONCURRENT_BATCHES) {
      yield window
      window = []
      windowSlots = 0
    }
    window.push({ files: files.slice(start, end), slots })
    windowSlots += slots
    start = end
  }
  if (window.length) yield window
}

const pendingReads = new Map<string, Promise<(string | null)[]>>()
const queue: { slots: number; start: () => void }[] = []
let availableSlots = MAX_CONCURRENT_BATCHES

function startQueuedReads(): void {
  while (queue.length && queue[0].slots <= availableSlots) {
    const next = queue.shift()!
    availableSlots -= next.slots
    next.start()
  }
}

function readBatch({ files, slots }: MarkdownBatch): Promise<(string | null)[]> {
  // 路径、顺序和文件版本全部相同才能共享。请求结束即释放，下一次检索重新读盘。
  const key = JSON.stringify(files.map(file => [file.path, file.mtimeMs, file.size]))
  const pending = pendingReads.get(key)
  if (pending) return pending

  const paths = files.map(file => file.path)
  const ready = new Promise<void>(start => {
    queue.push({ slots, start })
    startQueuedReads()
  })
  const request = ready.then(() => readMarkdownBatch(paths)).finally(() => {
    pendingReads.delete(key)
    availableSlots += slots
    startQueuedReads()
  })
  pendingReads.set(key, request)
  return request
}

/** 同时发出一组读取，依目录顺序在各批就绪时处理正文。 */
export async function mapWikiMarkdown<T>(
  files: FileNode[],
  map: (file: FileNode, content: string) => T | null,
): Promise<T[]> {
  const results: T[] = []
  for (const window of batchWindows(files)) {
    // 每个请求立即接住错误，轮到该批时再抛出，其他批次可以继续读盘。
    const reads = window.map(batch => readBatch(batch).then(
      pages => ({ pages }),
      (error: unknown) => ({ error }),
    ))
    for (const [index, batch] of window.entries()) {
      const loaded = await reads[index]
      if ("error" in loaded) throw loaded.error
      for (const [offset, content] of loaded.pages.entries()) {
        if (content === null) continue
        const result = map(batch.files[offset], content)
        if (result !== null) results.push(result)
      }
    }
  }
  return results
}
