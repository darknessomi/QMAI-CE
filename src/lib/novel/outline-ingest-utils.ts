import { fileExists, listDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { hashTextHex } from "@/lib/text-hash"
import { getRelativePath, normalizePath } from "@/lib/path-utils"
import { flattenMdFiles } from "./chapter-utils"

function outlineKey(outlinePath: string, projectPath?: string): string {
  const path = projectPath ? getRelativePath(outlinePath, projectPath) : normalizePath(outlinePath)
  const root = /(?:^|\/)(?:wiki|QM)\/outlines\//.exec(path)
  return root ? path.slice(root.index + root[0].length) : path
}

export function getOutlineFileName(outlinePath: string): string {
  return normalizePath(outlinePath).split("/").pop()?.replace(/\.\w+$/, "") || "大纲"
}

export function legacyOutlineNumber(outlinePath: string): number {
  let hash = 0
  const name = getOutlineFileName(outlinePath)
  for (let i = 0; i < name.length; i++) hash = (Math.imul(hash, 31) + name.charCodeAt(i)) | 0
  return -(Math.abs(hash % 999) + 1)
}

export function getOutlineSnapshotNumberFromPath(outlinePath: string, projectPath?: string): number {
  // Keep legacy slots 1..999 reserved. 13 hex digits fit exactly in a JS number.
  return -(1000 + parseInt(hashTextHex(outlineKey(outlinePath, projectPath)).slice(0, 13), 16))
}

function identity(projectPath: string, path: string, chapterNumber: number) {
  const prefix = String(Math.abs(chapterNumber)).padStart(3, "0")
  const snapshotJsonPath = `${normalizePath(projectPath)}/.qmai/novel/snapshots/outline-${prefix}.snapshot.json`
  return { outlineName: getOutlineFileName(path), sourceKey: outlineKey(path, projectPath), chapterNumber, snapshotJsonPath }
}

export function getOutlineIngestIdentity(projectPath: string, path: string) {
  return identity(projectPath, path, getOutlineSnapshotNumberFromPath(path, projectPath))
}

const pendingBindings = new Map<string, Promise<string | null>>()

async function bindLegacySlot(projectPath: string, path: string, binding: string, snapshot: string): Promise<string | null> {
  if (await fileExists(binding)) {
    const owner: unknown = JSON.parse(await readFile(binding))
    if (owner !== null && typeof owner !== "string") throw new Error("大纲快照归属记录无效")
    return owner
  }
  const tree = await listDirectory(`${projectPath}/wiki/outlines`)
  // Deletion calls this after moving the file to trash. Include it when checking ambiguity.
  const key = outlineKey(path, projectPath)
  const keys = new Set([key, ...flattenMdFiles(tree)
    .filter(file => legacyOutlineNumber(file.path) === legacyOutlineNumber(path))
    .map(file => outlineKey(file.path, projectPath))])
  const ownerFor = (data: { chapterId?: string; chapterTitle?: string }) => {
    if (data.chapterId?.startsWith("outline-path:")) {
      const source = data.chapterId.slice("outline-path:".length)
      return keys.has(source) ? source : null
    }
    const title = data.chapterTitle || String(data.chapterId ?? "").replace(/^outline-/, "")
    const matches = [...keys].filter(candidate => getOutlineFileName(candidate) === title)
    return matches.length === 1 ? matches[0] : null
  }
  let owner = ownerFor(JSON.parse(await readFile(snapshot)))
  if (owner && keys.size > 1) {
    // Different titles can share a legacy number. Bind the slot only when its
    // revisions agree, irrespective of which colliding outline was opened first.
    const historyDir = snapshot.replace(/\/([^/]+)\.snapshot\.json$/, "/history/$1")
    if (await fileExists(historyDir)) {
      for (const revision of await listDirectory(historyDir)) {
        if (!revision.is_dir && revision.name.endsWith(".snapshot.json")
          && ownerFor(JSON.parse(await readFile(revision.path))) !== owner) {
          owner = null
          break
        }
      }
    }
  }
  // Remember unresolved collisions as well, so deleting one candidate cannot silently reassign history.
  await writeFileAtomic(binding, JSON.stringify(owner))
  return owner
}

export async function resolveOutlineIngestIdentity(projectPath: string, path: string) {
  const current = getOutlineIngestIdentity(projectPath, path)
  const legacy = identity(projectPath, path, legacyOutlineNumber(path))
  if (!await fileExists(legacy.snapshotJsonPath)) return current
  const binding = legacy.snapshotJsonPath.replace(/\.snapshot\.json$/, ".owner.json")
  let promise = pendingBindings.get(binding)
  if (!promise) {
    promise = bindLegacySlot(normalizePath(projectPath), path, binding, legacy.snapshotJsonPath)
      .finally(() => pendingBindings.delete(binding))
    pendingBindings.set(binding, promise)
  }
  return await promise === current.sourceKey ? legacy : current
}

export async function outlineSnapshotExists(projectPath: string, path: string): Promise<boolean> {
  try {
    const current = getOutlineIngestIdentity(projectPath, path)
    if (await fileExists(current.snapshotJsonPath)) return true
    return (await resolveOutlineIngestIdentity(projectPath, path)).chapterNumber !== current.chapterNumber
  } catch {
    return false
  }
}
