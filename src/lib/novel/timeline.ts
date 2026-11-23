import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

export interface TimelineEntry {
  manual?: boolean
  chapterNumber: number
  event: string
}

interface TimelineFile {
  version: 1
  entries: TimelineEntry[]
  serial: number
  updatedAt: string
}

function timelinePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.qmai/novel/timeline.json`
}

export async function loadTimeline(projectPath: string): Promise<TimelineFile> {
  const path = timelinePath(projectPath)
  try {
    const raw = await readFile(path)
    const data = JSON.parse(raw)
    if (data.version === 1 && Array.isArray(data.entries)) {
      return data as TimelineFile
    }
  } catch {}
  return { version: 1, entries: [], serial: 0, updatedAt: "" }
}
