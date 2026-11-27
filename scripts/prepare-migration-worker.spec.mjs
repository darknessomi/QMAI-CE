import { expect, it, vi } from "vitest"

const { build, execFileSync, mkdir } = vi.hoisted(() => ({
  build: vi.fn(),
  execFileSync: vi.fn(),
  mkdir: vi.fn(),
}))

vi.mock("node:child_process", () => ({ execFileSync }))
vi.mock("node:fs/promises", () => ({ access: vi.fn(), chmod: vi.fn(), copyFile: vi.fn(), mkdir }))
vi.mock("vite", () => ({ build }))

it.runIf(process.platform === "darwin")("迁移构建拒绝依赖安装目录动态库的 Node", async () => {
  execFileSync.mockReturnValue(
    "/opt/homebrew/bin/node:\n\t@rpath/libnode.137.dylib (compatibility version 0.0.0, current version 0.0.0)\n",
  )

  await expect(import("./prepare-migration-worker.mjs")).rejects.toThrow("macOS 构建需要可独立运行的 Node.js")
  expect(mkdir).not.toHaveBeenCalled()
  expect(build).not.toHaveBeenCalled()
})
