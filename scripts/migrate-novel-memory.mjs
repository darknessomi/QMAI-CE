// 源码版入口。与桌面端共用原生迁移事务和同一套记忆计算。
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { join, resolve } from "node:path"

const root = fileURLToPath(new URL("../", import.meta.url))
const args = process.argv.slice(2)
if (!args.length) {
  console.error("用法：node scripts/migrate-novel-memory.mjs [--dry-run|--apply|--rollback] 小说项目目录")
  process.exit(1)
}
// 保持相对路径相对于调用者的当前目录。
const last = args.length - 1
if (!args[last].startsWith("--")) args[last] = resolve(args[last])
const writing = args[0] === "--apply" || args[0] === "--rollback"
if (writing) {
  const interrupted = () => console.error("迁移或恢复完成前已锁定正常退出，请等待操作结束。")
  process.on("SIGINT", interrupted)
  process.on(process.platform === "win32" ? "SIGBREAK" : "SIGQUIT", interrupted)
  console.error("正在准备迁移工具。请勿强制退出、关机或移动项目文件，否则可能导致内容损坏。")
}
async function execute(command, childArgs) {
  const child = spawn(command, childArgs, { cwd: root, stdio: "inherit", detached: writing, windowsHide: true })
  const code = await new Promise((resolve, reject) => {
    child.once("error", (error) => reject(new Error(`启动迁移工具失败：${error.message}`)))
    child.once("exit", (status, signal) => resolve(status ?? (signal === "SIGINT" ? 130 : 1)))
  })
  if (code !== 0) process.exit(code)
}
if (!args.includes("--rollback")) await execute(process.execPath, [join(root, "scripts/prepare-migration-worker.mjs")])
await execute("cargo", ["run", "--locked", "--quiet", "--manifest-path", join(root, "src-tauri/Cargo.toml"), "--bin", "qmai-migrate", "--", ...args])
