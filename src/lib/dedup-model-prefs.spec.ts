import { beforeEach, expect, test, vi } from "vitest"
import { createDeferred, waitFor } from "@/test-helpers/deferred"

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  fileExists: vi.fn(),
}))

import { readFile, writeFileAtomic, fileExists } from "@/commands/fs"
import { loadDedupModelPrefs, saveDedupModelPrefs } from "./dedup-model-prefs"

const mockedReadFile = vi.mocked(readFile)
const mockedWriteFile = vi.mocked(writeFileAtomic)
const mockedFileExists = vi.mocked(fileExists)

beforeEach(() => {
  vi.clearAllMocks()
})

test("saveDedupModelPrefs writes detect and merge ids", async () => {
  await saveDedupModelPrefs("/Project", {
    detectModelId: "cheap/model",
    mergeModelId: "strong/model",
  })
  expect(mockedWriteFile).toHaveBeenCalledTimes(1)
  const written = JSON.parse(String(mockedWriteFile.mock.calls[0]?.[1]))
  expect(written).toEqual({
    detectModelId: "cheap/model",
    mergeModelId: "strong/model",
  })
})

test("loadDedupModelPrefs accepts legacy modelId as detect", async () => {
  mockedFileExists.mockResolvedValue(true)
  mockedReadFile.mockResolvedValue(
    JSON.stringify({ modelId: "legacy/detect-only" }),
  )
  const prefs = await loadDedupModelPrefs("/Project")
  expect(prefs).toEqual({
    detectModelId: "legacy/detect-only",
    mergeModelId: undefined,
  })
})

test("快速切换模型后重新打开项目会读到最后一次选择", async () => {
  const firstWrite = createDeferred()
  let saved = ""
  mockedFileExists.mockResolvedValue(true)
  mockedReadFile.mockImplementation(async () => saved)
  mockedWriteFile.mockImplementationOnce(async (_path, value) => {
    await firstWrite.promise
    saved = value
  }).mockImplementationOnce(async (_path, value) => { saved = value })
  const first = saveDedupModelPrefs("/project", { mergeModelId: "合并甲" })
  await waitFor(() => mockedWriteFile.mock.calls.length === 1)
  const last = saveDedupModelPrefs("/project", { mergeModelId: "合并乙" })
  const reopened = loadDedupModelPrefs("/project")
  firstWrite.resolve()
  await Promise.all([first, last])
  expect((await reopened)?.mergeModelId).toBe("合并乙")
})
