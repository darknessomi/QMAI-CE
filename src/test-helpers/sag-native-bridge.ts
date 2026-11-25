import { execFileSync, spawn } from "node:child_process"
import { createInterface } from "node:readline"

export function nativeBridge() {
  const messages = execFileSync("cargo", ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml",
    "--lib", "--no-run", "--message-format=json"], { encoding: "utf8" }).trim().split("\n")
  const binary = messages.map(line => JSON.parse(line)).find(m => m.target?.name === "qmai"
    && m.profile?.test && typeof m.executable === "string")?.executable
  if (!binary) throw new Error("未找到原生测试程序")
  const child = spawn(binary, ["commands::sag::tests::sag_dedup_bridge", "--exact", "--ignored", "--nocapture"], {
    stdio: ["pipe", "pipe", "inherit"],
  })
  type Reply = { value?: unknown; error?: string; calls: number }
  let pending: { resolve(value: Reply): void; reject(error: Error): void } | undefined
  let stopped = false
  createInterface({ input: child.stdout }).on("line", line => {
    const marker = "QMAI_SAG_BRIDGE="
    const index = line.indexOf(marker)
    if (index < 0) return
    const reply: Reply = JSON.parse(line.slice(index + marker.length))
    pending?.resolve(reply)
    pending = undefined
  })
  child.on("exit", () => { stopped = true; pending?.reject(new Error("原生评测提前结束")) })
  return {
    call(args: Record<string, unknown>): Promise<Reply> {
      if (stopped || pending) throw new Error("原生评测进程当前不可用")
      return new Promise((resolve, reject) => {
        pending = { resolve, reject }
        child.stdin.write(JSON.stringify(args) + "\n", error => {
          if (error) reject(error)
        })
      })
    },
    close() { child.stdin.end() },
  }
}
