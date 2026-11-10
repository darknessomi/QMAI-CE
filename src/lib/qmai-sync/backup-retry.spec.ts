/**
 * 上传重试。
 *
 * ## 为什么需要这组测试
 *
 * 2026-11-08 用户实测：一次备份里 6 个文件有 3 个失败，报错都是
 * `error sending request for url (...)`，而同一秒里其它文件成功。
 *
 * 这不是服务端拒绝（拒绝会返回中文 JSON），是**传输层偶发失败** ——
 * 最典型的原因是复用了刚被对端关闭的空闲 keep-alive 连接。
 * 这类失败重试一次几乎必然成功，但**原来的代码完全没有重试**，
 * 等于每抖动一次就永久丢一个文件（要等下次备份才补）。
 *
 * ## 这里钉住的四件事
 *
 * 1. 传输层错误会重试，且最终成功时算「上传成功」
 * 2. 服务端明确拒绝（400/401/413）**不重试** —— 重试一百次也一样，纯浪费时间
 * 3. 重试次数有上限，不会无限重试
 * 4. 重试过程写 `upload.retry` 日志，最终失败写 `upload.fail`
 */

import { describe, expect, it, vi } from "vitest"
import { testManifest, testReceipt, testStamp } from "./test-fixtures"

const state = vi.hoisted(() => ({
  upload: vi.fn(),
  read: vi.fn(),
  collect: vi.fn(),
  logs: [] as Array<Record<string, unknown>>,
}))

vi.mock("./client", async () => {
  const actual = await vi.importActual<typeof import("./client")>("./client")
  return {
    ...actual,
    uploadSyncFile: state.upload,
    fetchSyncManifest: async (_base: string, _card: string, projectId: string) => testManifest(projectId),
    SyncError: actual.SyncError,
  }
})

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(),
  readFile: state.read,
}))

vi.mock("./log", () => ({
  appendSyncLog: vi.fn(async (_projectPath: string, entry: Record<string, unknown>) => {
    state.logs.push(entry)
  }),
}))

import { backupProject } from "./backup"
import { SyncError } from "./client"

const baseArgs = {
  baseUrl: "https://relay.test",
  netcard: "card",
  projectPath: "/proj",
  projectId: "p1",
  known: {},
}

function oneFile(name = "a.md") {
  return {
    files: [{ relPath: name, absPath: `/proj/${name}`, size: 10, mtime: 1 }],
    skipped: 0,
    truncated: false,
  }
}

/** 清空上一轮调用记录（每个用例独立计数） */
function reset() {
  state.upload.mockReset()
  state.read.mockReset()
  state.collect.mockReset()
  state.logs = []
  state.read.mockResolvedValue("正文")
  state.collect.mockResolvedValue(oneFile())
}

describe("上传重试", () => {
  it("传输层错误（非 SyncError）会重试，第二次成功就算上传成功", async () => {
    reset()
    state.upload
      .mockRejectedValueOnce(new Error("error sending request for url (https://relay.test/...)"))
      .mockImplementationOnce(testReceipt)

    const result = await backupProject({ ...baseArgs, upload: state.upload, read: state.read, collect: state.collect })

    expect(state.upload).toHaveBeenCalledTimes(2)
    expect(result.uploaded).toBe(1)
    expect(result.failed).toHaveLength(0)
    // 重试要留痕，便于判断「是第一次就成功还是靠重试救回来的」
    expect(state.logs.some((l) => l.event === "upload.retry")).toBe(true)
  })

  it("SyncError 且 status=0（没拿到响应）也重试", async () => {
    reset()
    state.upload
      .mockRejectedValueOnce(new SyncError("sync_failed", "网络中断", 0))
      .mockImplementationOnce(testReceipt)

    const result = await backupProject({ ...baseArgs, upload: state.upload, read: state.read, collect: state.collect })

    expect(state.upload).toHaveBeenCalledTimes(2)
    expect(result.uploaded).toBe(1)
  })

  it("5xx 会重试（服务端临时问题）", async () => {
    reset()
    state.upload
      .mockRejectedValueOnce(new SyncError("server_error", "网关错误", 502))
      .mockImplementationOnce(testReceipt)

    const result = await backupProject({ ...baseArgs, upload: state.upload, read: state.read, collect: state.collect })
    expect(state.upload).toHaveBeenCalledTimes(2)
    expect(result.uploaded).toBe(1)
  })

  it("400 明确拒绝不重试（重试一百次也一样）", async () => {
    reset()
    state.upload.mockRejectedValue(new SyncError("bad_extension", "只允许同步文本文件。", 400))

    const result = await backupProject({ ...baseArgs, upload: state.upload, read: state.read, collect: state.collect })

    expect(state.upload).toHaveBeenCalledTimes(1)
    expect(result.uploaded).toBe(0)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].message).toContain("只允许同步文本文件")
  })

  it("401 登录失效不重试", async () => {
    reset()
    state.upload.mockRejectedValue(new SyncError("unauthorized", "登录状态已失效", 401))

    const result = await backupProject({ ...baseArgs, upload: state.upload, read: state.read, collect: state.collect })

    expect(state.upload).toHaveBeenCalledTimes(1)
    expect(result.failed).toHaveLength(1)
  })

  it("413 配额/文件过大不重试", async () => {
    reset()
    state.upload.mockRejectedValue(new SyncError("quota_exceeded", "同步空间不足", 413))

    const result = await backupProject({ ...baseArgs, upload: state.upload, read: state.read, collect: state.collect })

    expect(state.upload).toHaveBeenCalledTimes(1)
    expect(result.failed).toHaveLength(1)
  })

  it("一直失败时重试次数有上限（1 次原始 + 2 次重试 = 3 次）", async () => {
    reset()
    state.upload.mockRejectedValue(new Error("error sending request for url (...)"))

    const result = await backupProject({ ...baseArgs, upload: state.upload, read: state.read, collect: state.collect })

    expect(state.upload).toHaveBeenCalledTimes(3)
    expect(result.uploaded).toBe(0)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].message).toContain("error sending request")
  })

  it("最终失败的文件不进清单（下次备份会重传）", async () => {
    reset()
    state.upload.mockRejectedValue(new Error("boom"))

    const result = await backupProject({ ...baseArgs, upload: state.upload, read: state.read, collect: state.collect })

    expect(result.failed).toHaveLength(1)
    expect(result.manifest["a.md"]).toBeUndefined()
  })

  it("重试成功后该文件正常进清单（下次不会再传）", async () => {
    reset()
    state.upload.mockRejectedValueOnce(new Error("boom")).mockImplementationOnce(testReceipt)

    const result = await backupProject({ ...baseArgs, upload: state.upload, read: state.read, collect: state.collect })

    expect(result.manifest["a.md"]).toEqual(testStamp("正文", 1))
  })

  it("最终失败时写 upload.fail 日志（不是只写 retry）", async () => {
    reset()
    state.upload.mockRejectedValue(new Error("boom"))

    await backupProject({ ...baseArgs, upload: state.upload, read: state.read, collect: state.collect })

    expect(state.logs.some((l) => l.event === "upload.fail")).toBe(true)
    // 两次重试各一条 retry 日志
    expect(state.logs.filter((l) => l.event === "upload.retry")).toHaveLength(2)
  })
})
