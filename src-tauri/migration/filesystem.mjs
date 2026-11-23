// The worker has read-only Node permissions. All writes are returned to the
// transaction owner, so a surviving child cannot modify a recovered project.
import * as fs from "node:fs/promises"
import path from "node:path"

let root
const files = new Map()
const directories = new Set()

export async function bindStagingRoot(directory) {
  root = await fs.realpath(directory)
  files.clear()
  directories.clear()
  return root.replaceAll(path.sep, "/")
}

function physicalPath(file) {
  const relative = path.relative(root, file)
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("迁移工作文件超出暂存目录")
  }
  const parts = relative.split(path.sep)
  if (parts[0] === "wiki") parts[0] = "QM"
  return path.join(root, ...parts)
}

export function projectedFiles() {
  return [...files].map(([file, contents]) => ({
    path: path.relative(root, file).replaceAll(path.sep, "/"),
    contents,
  }))
}

export async function readFile(file) {
  const full = physicalPath(file)
  if (files.has(full)) {
    const content = files.get(full)
    if (content === null) throw new Error("工作文件已撤除")
    return content
  }
  return fs.readFile(full, "utf8")
}
export async function fileExists(file) {
  const full = physicalPath(file)
  if (files.has(full)) return files.get(full) !== null
  if (directories.has(full)) return true
  try {
    await fs.access(full)
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}
export async function createDirectory(dir) {
  let full = physicalPath(dir)
  while (full !== root) {
    directories.add(full)
    full = path.dirname(full)
  }
}
export async function writeFileAtomic(file, content) {
  const full = physicalPath(file)
  await createDirectory(path.dirname(full))
  files.set(full, content)
}
export const writeFile = writeFileAtomic
export async function deleteFile(file) {
  files.set(physicalPath(file), null)
}
export async function listDirectory(dir, options = {}) {
  const includeHidden = typeof options === "boolean" ? options : options.includeHidden
  const maxDepth = Math.max(1, Math.min(30, options.maxDepth ?? 30))
  async function walk(parent, depth) {
    const full = physicalPath(parent)
    const entries = new Map()
    try {
      for (const entry of await fs.readdir(full, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) entries.set(entry.name, entry.isDirectory())
      }
    } catch (error) {
      if (error.code !== "ENOENT" || !directories.has(full)) throw error
    }
    for (const directory of directories) {
      if (path.dirname(directory) === full) entries.set(path.basename(directory), true)
    }
    for (const [file, contents] of files) {
      if (path.dirname(file) !== full) continue
      if (contents === null) entries.delete(path.basename(file))
      else entries.set(path.basename(file), false)
    }
    // Match the desktop list_directory order and visibility, including staged writes.
    const visible = [...entries].filter(([name]) => includeHidden || !name.startsWith("."))
    visible.sort(([a, aDir], [b, bDir]) => Number(bDir) - Number(aDir) || Buffer.from(a).compare(Buffer.from(b)))
    return Promise.all(visible.map(async ([name, isDir]) => {
      const file = path.join(parent, name).replaceAll(path.sep, "/")
      const children = isDir && depth < maxDepth ? await walk(file, depth + 1) : undefined
      return { name, path: file, is_dir: isDir, children: children?.length ? children : undefined }
    }))
  }
  return walk(dir, 1)
}
