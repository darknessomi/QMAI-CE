import { parseForeshadowingChange } from "../foreshadowing-normalize"
import type { ChapterSnapshot } from "../chapter-ingest"
import type { RetrievalEntry, VolumeIndex, InvertedIndex } from "./types"
import { DEFAULT_CHAPTERS_PER_VOLUME } from "./types"
import { projectSnapshotToEntry, updateEntryFromSnapshot } from "./snapshot-projection"
import { parseVolumeEntries, serializeVolumeEntries } from "./markdown-serializer"

export interface FsAdapter {
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<void>
  fileExists: (path: string) => Promise<boolean>
  listDirectory: (path: string) => Promise<string[]>
  deleteFile?: (path: string) => Promise<void>
  createDirectory: (path: string) => Promise<void>
  joinPath: (...parts: string[]) => string
}

interface RetrievalStoreOptions {
  chaptersPerVolume?: number
}

export class RetrievalStore {
  private projectPath: string
  private fs: FsAdapter
  private chaptersPerVolume: number
  private cache: {
    entries: RetrievalEntry[] | null
    invertedIndex: InvertedIndex | null
    volumes: VolumeIndex[] | null
  } = { entries: null, invertedIndex: null, volumes: null }

  constructor(projectPath: string, fs: FsAdapter, options: RetrievalStoreOptions = {}) {
    this.projectPath = projectPath
    this.fs = fs
    this.chaptersPerVolume = options.chaptersPerVolume || DEFAULT_CHAPTERS_PER_VOLUME
  }

  get retrievalDir(): string {
    return this.fs.joinPath(this.projectPath, ".qmai", "retrieval")
  }

  get indexPath(): string {
    return this.fs.joinPath(this.retrievalDir, "index.md")
  }

  getVolumePath(volumeName: string): string {
    const fileName = this.volumeNameToFileName(volumeName)
    return this.fs.joinPath(this.retrievalDir, fileName)
  }

  volumeNameToFileName(volumeName: string): string {
    const match = volumeName.match(/第(\d+)卷/)
    if (match) return `volume-${match[1]}.md`
    return `${volumeName}.md`
  }

  chapterToVolumeName(chapterNumber: number): string {
    const volumeNum = Math.ceil(chapterNumber / this.chaptersPerVolume)
    return `第${volumeNum}卷`
  }

  async hasIndex(): Promise<boolean> {
    return this.fs.fileExists(this.indexPath)
  }

  async buildFromSnapshots(
    snapshots: ChapterSnapshot[],
    getFilePath: (snapshot: ChapterSnapshot) => string,
    getSourceHash: (snapshot: ChapterSnapshot) => string
  ): Promise<void> {
    await this.fs.createDirectory(this.retrievalDir)

    const previousFiles = new Map<string, string>()
    const oldEntries = new Map<number, RetrievalEntry>()
    for (const file of await this.fs.listDirectory(this.retrievalDir)) {
      if (!/^volume-\d+\.md$/.test(file)) continue
      const content = await this.fs.readFile(this.fs.joinPath(this.retrievalDir, file))
      previousFiles.set(file, content)
      for (const entry of parseVolumeEntries(content)) oldEntries.set(entry.chapterNumber, entry)
    }
    const entries = snapshots.map((snapshot) => {
      const previous = oldEntries.get(snapshot.chapterNumber)
      const filePath = getFilePath(snapshot) || previous?.filePath || ""
      const sourceHash = getSourceHash(snapshot) || undefined
      const volumeName = this.chapterToVolumeName(snapshot.chapterNumber)
      if (!previous) return projectSnapshotToEntry(snapshot, { filePath, volumeName, sourceHash })
      return { ...updateEntryFromSnapshot(previous, snapshot, { sourceHash }), volumeName, filePath }
    })
    const volumes = this.calculateVolumes(entries)
    for (const volume of volumes) {
      const content = serializeVolumeEntries(entries.filter((entry) => entry.volumeName === volume.name), volume.name)
      if (previousFiles.get(volume.fileName) !== content) await this.fs.writeFile(this.getVolumePath(volume.name), content)
      previousFiles.delete(volume.fileName)
    }
    for (const file of previousFiles.keys()) {
      const volumeName = `第${/^volume-(\d+)/.exec(file)![1]}卷`
      const path = this.fs.joinPath(this.retrievalDir, file)
      if (this.fs.deleteFile) await this.fs.deleteFile(path)
      else await this.fs.writeFile(path, serializeVolumeEntries([], volumeName))
    }
    const invertedIndex = this.buildInvertedIndex(entries)
    const indexContent = this.serializeMainIndex(volumes, invertedIndex)
    if (!await this.fs.fileExists(this.indexPath) || await this.fs.readFile(this.indexPath) !== indexContent) {
      await this.fs.writeFile(this.indexPath, indexContent)
    }
    this.cache = { entries, invertedIndex, volumes }
  }

  async getAllEntries(): Promise<RetrievalEntry[]> {
    if (this.cache.entries) return this.cache.entries

    const allEntries = await this.loadAllEntriesFromDisk()
    this.cache.entries = allEntries
    return allEntries
  }

  async getVolumes(): Promise<VolumeIndex[]> {
    if (this.cache.volumes) return this.cache.volumes

    const exists = await this.fs.fileExists(this.indexPath)
    if (!exists) {
      this.cache.volumes = []
      return []
    }

    const content = await this.fs.readFile(this.indexPath)
    const volumes = this.parseMainIndexVolumes(content)
    this.cache.volumes = volumes
    return volumes
  }

  async getInvertedIndex(): Promise<InvertedIndex> {
    if (this.cache.invertedIndex) return this.cache.invertedIndex

    const entries = await this.getAllEntries()
    const invertedIndex = this.buildInvertedIndex(entries)
    this.cache.invertedIndex = invertedIndex
    return invertedIndex
  }

  async getEntry(chapterNumber: number): Promise<RetrievalEntry | null> {
    const entries = await this.getAllEntries()
    return entries.find((e) => e.chapterNumber === chapterNumber) || null
  }

  async validateEntry(chapterNumber: number, currentHash: string): Promise<{
    valid: boolean
    status: "valid" | "maybe_outdated" | "conflict"
  }> {
    const entry = await this.getEntry(chapterNumber)
    if (!entry) {
      return { valid: false, status: "maybe_outdated" }
    }
    if (!entry.sourceHash) {
      return { valid: false, status: "maybe_outdated" }
    }
    if (entry.sourceHash !== currentHash) {
      return { valid: false, status: "maybe_outdated" }
    }
    return { valid: entry.indexStatus === "valid", status: entry.indexStatus }
  }

  async checkOutdatedEntries(): Promise<{
    total: number
    outdated: number
    maybeOutdated: number
    conflict: number
    chapterNumbers: {
      maybeOutdated: number[]
      conflict: number[]
    }
  }> {
    const entries = await this.getAllEntries()
    const maybeOutdatedChapters: number[] = []
    const conflictChapters: number[] = []

    for (const entry of entries) {
      if (entry.indexStatus === "maybe_outdated") {
        maybeOutdatedChapters.push(entry.chapterNumber)
      } else if (entry.indexStatus === "conflict") {
        conflictChapters.push(entry.chapterNumber)
      }
    }

    return {
      total: entries.length,
      outdated: maybeOutdatedChapters.length + conflictChapters.length,
      maybeOutdated: maybeOutdatedChapters.length,
      conflict: conflictChapters.length,
      chapterNumbers: {
        maybeOutdated: maybeOutdatedChapters.sort((a, b) => a - b),
        conflict: conflictChapters.sort((a, b) => a - b),
      },
    }
  }

  private calculateVolumes(entries: RetrievalEntry[]): VolumeIndex[] {
    if (entries.length === 0) return []

    const maxChapter = Math.max(...entries.map((e) => e.chapterNumber))
    const occupied = new Set(entries.map((entry) => Math.ceil(entry.chapterNumber / this.chaptersPerVolume)))
    const volumes: VolumeIndex[] = []

    for (const i of [...occupied].sort((a, b) => a - b)) {
      const start = (i - 1) * this.chaptersPerVolume + 1
      const end = Math.min(i * this.chaptersPerVolume, maxChapter)
      volumes.push({
        name: `第${i}卷`,
        fileName: `volume-${i}.md`,
        chapterStart: start,
        chapterEnd: end,
      })
    }

    return volumes
  }

  private buildInvertedIndex(entries: RetrievalEntry[]): InvertedIndex {
    const foreshadowing: Record<string, number[]> = Object.create(null)
    const characters: Record<string, number[]> = Object.create(null)
    const timeline: Record<string, number[]> = Object.create(null)

    for (const entry of entries) {
      for (const change of entry.foreshadowingChanges.split("；")) {
        if (!change || change === "无") continue
        const parsed = parseForeshadowingChange(change)
        if (!parsed) continue
        const refs = foreshadowing[parsed.name] ??= []
        if (!refs.includes(entry.chapterNumber)) refs.push(entry.chapterNumber)
      }

      for (const change of entry.characterStates.split("；")) {
        const match = change.match(/^([^：:（(]+)[：:（(]/u)
        const name = match?.[1]?.trim()
        if (!name) continue
        const refs = characters[name] ??= []
        if (!refs.includes(entry.chapterNumber)) refs.push(entry.chapterNumber)
      }

      const timelineMatches = entry.timelineEvents.match(/([^；,，。]+?)[-—]/g)
      if (timelineMatches) {
        for (const match of timelineMatches) {
          const point = match.replace(/[-—].*$/, "").trim()
          if (point) {
            if (!timeline[point]) timeline[point] = []
            if (!timeline[point].includes(entry.chapterNumber)) {
              timeline[point].push(entry.chapterNumber)
            }
          }
        }
      }
    }

    return { foreshadowing, characters, timeline }
  }

  private serializeMainIndex(volumes: VolumeIndex[], invertedIndex: InvertedIndex): string {
    const lines: string[] = []
    lines.push("# 检索主索引")
    lines.push("")
    lines.push("## 分卷目录")
    for (const v of volumes) {
      lines.push(`- ${v.name}：.qmai/retrieval/${v.fileName}（第${v.chapterStart}-${v.chapterEnd}章）`)
    }
    lines.push("")
    lines.push("## 伏笔倒排索引")
    for (const [name, chapters] of Object.entries(invertedIndex.foreshadowing)) {
      lines.push(`- ${name}：${chapters.map((c) => `第${c}章`).join(", ")}`)
    }
    if (Object.keys(invertedIndex.foreshadowing).length === 0) {
      lines.push("- 暂无")
    }
    lines.push("")
    lines.push("## 人物倒排索引")
    for (const [name, chapters] of Object.entries(invertedIndex.characters)) {
      lines.push(`- ${name}：${chapters.map((c) => `第${c}章`).join(", ")}`)
    }
    if (Object.keys(invertedIndex.characters).length === 0) {
      lines.push("- 暂无")
    }
    lines.push("")
    lines.push("## 时间线倒排索引")
    for (const [point, chapters] of Object.entries(invertedIndex.timeline)) {
      lines.push(`- ${point}：${chapters.map((c) => `第${c}章`).join(", ")}`)
    }
    if (Object.keys(invertedIndex.timeline).length === 0) {
      lines.push("- 暂无")
    }
    lines.push("")
    return lines.join("\n")
  }

  private parseMainIndexVolumes(content: string): VolumeIndex[] {
    const volumes: VolumeIndex[] = []
    const lines = content.split("\n")
    let inVolumeSection = false

    for (const line of lines) {
      if (line.startsWith("## 分卷目录")) {
        inVolumeSection = true
        continue
      }
      if (inVolumeSection && line.startsWith("## ")) {
        break
      }
      if (inVolumeSection && line.startsWith("- ")) {
        const match = line.match(/- (第\d+卷)：\.qmai\/retrieval\/([^（]+)（第(\d+)-(\d+)章）/)
        if (match) {
          volumes.push({
            name: match[1],
            fileName: match[2].trim(),
            chapterStart: parseInt(match[3], 10),
            chapterEnd: parseInt(match[4], 10),
          })
        }
      }
    }

    return volumes
  }

  private async loadAllEntriesFromDisk(): Promise<RetrievalEntry[]> {
    const allEntries: RetrievalEntry[] = []
    try {
      const files = await this.fs.listDirectory(this.retrievalDir)
      const volumeFiles = files.filter((f) => /volume-\d+\.md$/.test(f))

      for (const file of volumeFiles) {
        try {
          const filePath = this.fs.joinPath(this.retrievalDir, file)
          const content = await this.fs.readFile(filePath)
          const entries = parseVolumeEntries(content)
          allEntries.push(...entries)
        } catch {
          // 跳过无法读取的卷
        }
      }
    } catch {
      // 目录不存在或无法列出
    }
    return allEntries
  }

  invalidateCache(): void {
    this.cache = { entries: null, invertedIndex: null, volumes: null }
  }
}
