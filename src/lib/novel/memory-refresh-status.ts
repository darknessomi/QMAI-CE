import { deleteFile, fileExists, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

function pendingPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.qmai/novel/refresh-pending.json`
}

export function hasPendingMemoryRefresh(projectPath: string): Promise<boolean> {
  return fileExists(pendingPath(projectPath))
}

export async function markMemoryRefreshPending(projectPath: string): Promise<void> {
  await writeFileAtomic(pendingPath(projectPath), '{"version":1}')
}

export async function finishMemoryRefresh(projectPath: string): Promise<void> {
  if (await hasPendingMemoryRefresh(projectPath)) await deleteFile(pendingPath(projectPath))
}
