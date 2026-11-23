import { refreshStagedProject } from "./worker.mjs"

// Rust holds this pipe open until the child finishes. The read-only permission
// boundary also holds during CPU-bound work before Node can handle the EOF.
process.stdin.on("end", () => process.exit(1))
process.stdin.resume()
try {
  const files = await refreshStagedProject(process.argv[2])
  const response = JSON.stringify({ files })
  await new Promise((resolve, reject) => process.stdout.write(response, (error) => error ? reject(error) : resolve()))
} catch (error) {
  console.error("重建迁移项目失败", error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  process.stdin.destroy()
}
