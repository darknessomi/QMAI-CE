// 桌面端随安装包使用同一套纯计算模块和 Node 运行时，无需用户安装 Node。
import { access, copyFile, mkdir, chmod } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "vite"

const root = fileURLToPath(new URL("../", import.meta.url))
const output = join(root, "src-tauri/migration/runtime")
await mkdir(output, { recursive: true })
await build({
  root,
  configFile: false,
  publicDir: false,
  resolve: { alias: [
    { find: "@/commands/fs", replacement: join(root, "src-tauri/migration/filesystem.mjs") },
    { find: "@", replacement: join(root, "src") },
  ] },
  build: {
    outDir: output,
    emptyOutDir: false,
    target: "node24",
    rolldownOptions: { external: [/^node:/] },
    lib: { entry: join(root, "src-tauri/migration/refresh.ts"), formats: ["es"], fileName: () => "worker.mjs" },
  },
})
const executable = process.platform === "win32" ? "node.exe" : "node"
await copyFile(process.execPath, join(output, executable))
if (process.platform !== "win32") await chmod(join(output, executable), 0o755)
const binDir = dirname(process.execPath)
const license = await Promise.any([binDir, dirname(binDir)].map(async (dir) => {
  const file = join(dir, "LICENSE")
  await access(file)
  return file
}))
await copyFile(license, join(output, "NODE-LICENSE"))
