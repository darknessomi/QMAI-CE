/**
 * Map a wiki-side image reference back to its raw source file.
 *
 * Chat reference badges can open the source of an image stored by an
 * earlier import. For `media/<slug>/img-N.<ext>` references, match the
 * slug against the filenames under `<project>/raw/sources/`.
 *
 * Returns null when:
 *   - the URL doesn't match the expected media-directory shape, OR
 *   - no file with that stem exists under raw/sources/ (e.g. the
 *     user moved / deleted the original after ingest, leaving only
 *     the wiki summary). Callers fall back gracefully.
 */
import { listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"

export async function findRawSourceForImage(
  imageUrl: string,
  projectPath: string,
): Promise<string | null> {
  // Image URLs reach us in TWO shapes:
  //   1. ABSOLUTE: `/Users/.../wiki/media/<slug>/img-N.png`
  //   2. WIKI-RELATIVE: `media/<slug>/img-N.png`
  // Match `media/<slug>/` either at the URL start or after any `/`.
  const m = imageUrl.replace(/\\/g, "/").match(/(?:^|\/)media\/([^/]+)\//)
  if (!m) return null
  const slug = m[1]

  let tree: FileNode[]
  try {
    tree = await listDirectory(`${projectPath}/raw/sources`)
  } catch {
    return null
  }

  const findByStem = (nodes: FileNode[]): string | null => {
    for (const node of nodes) {
      if (node.is_dir) {
        if (node.children) {
          const found = findByStem(node.children)
          if (found) return found
        }
        continue
      }
      const stem = node.name.replace(/\.[^.]+$/, "")
      if (stem === slug) return node.path
    }
    return null
  }

  return findByStem(tree)
}

/**
 * Turn a wiki-relative image URL into an absolute scroll target
 * for a source preview that uses absolute image paths.
 *
 * Idempotent: passing an already-absolute URL returns it unchanged.
 */
export function imageUrlToAbsolute(
  imageUrl: string,
  projectPath: string,
): string {
  const isAbsolute =
    imageUrl.startsWith("/") ||
    /^[a-zA-Z]:/.test(imageUrl) ||
    imageUrl.startsWith("\\\\")
  if (isAbsolute) return imageUrl
  const cleaned = imageUrl.replace(/^\.\//, "")
  return `${projectPath.replace(/\/+$/, "")}/wiki/${cleaned}`
}
