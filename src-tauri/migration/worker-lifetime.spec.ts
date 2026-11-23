// @vitest-environment node
import { spawn } from "node:child_process"
import { once } from "node:events"
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it("父进程强制结束时，工作进程无权写入暂存区并随管道关闭退出", async () => {
  const root = await mkdtemp(join(tmpdir(), "qmai-worker-lifetime-"))
  const staging = join(root, "stage")
  const runtime = join(root, "runtime")
  await Promise.all([mkdir(staging), mkdir(runtime)])
  await copyFile(fileURLToPath(new URL("./runtime/run.mjs", import.meta.url)), join(runtime, "run.mjs"))
  await writeFile(join(runtime, "worker.mjs"), `
    import { writeFile } from "node:fs/promises"
    import { join } from "node:path"
    export async function refreshStagedProject(project) {
      try { await writeFile(join(project, "unexpected"), "意外写入") }
      catch (error) { process.stderr.write(error.code + "\\n") }
      await new Promise(resolve => setTimeout(resolve, 20000))
      return []
    }
  `)
  const launcher = `
    const { spawn } = require("node:child_process")
    const [runtime, stage] = process.argv.slice(1)
    const { join } = require("node:path")
    const child = spawn(process.execPath, ["--permission", "--allow-fs-read=" + runtime, "--allow-fs-read=" + stage,
      join(runtime, "run.mjs"), stage], { stdio: ["pipe", 1, 2] })
    setInterval(() => { void child.stdin }, 1000)
  `
  const parent = spawn(process.execPath, ["-e", launcher, runtime, staging], { stdio: ["ignore", "pipe", "pipe"] })
  const closed = once(parent, "close")
  try {
    const [message] = await once(parent.stderr, "data")
    expect(message.toString()).toContain("ERR_ACCESS_DENIED")
    parent.kill("SIGKILL")
    // The grandchild inherits stderr. Its pipe reaches EOF only when both
    // processes exit, not when the launcher alone receives SIGKILL.
    await closed
    expect(await readdir(staging)).toEqual([])
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL")
    await rm(root, { recursive: true, force: true })
  }
}, 8_000)
