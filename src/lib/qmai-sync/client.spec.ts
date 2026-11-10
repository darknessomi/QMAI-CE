/**
 * 云端同步客户端。
 *
 * ## 这条测试守的是什么
 *
 * 同步是「用户把作品交给我们保管」的动作，出错代价很高：
 *   · 传错路径 → 别人的文件被覆盖
 *   · 错误被吞掉 → 用户以为同步成功，实际没传上去
 *   · 配额错误没翻译 → 用户看到一串英文码，不知道该怎么办
 *
 * 所以这里逐条钉住：URL 编码、请求方法、错误翻译、字节语义。
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { testGeneration, testRevision, testHash } from "./test-fixtures"

const mockFetch = vi.fn()

vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: async () => mockFetch,
}))

/** 记录每次签名的入参，用来验证「签名路径不含 query」 */
const signCalls: Array<{ method: string; path: string; body: string }> = []

vi.mock("@/lib/builtin-models/gateway-api", () => ({
  gatewayAuthHeaders: async (_netcard: string, method: string, path: string, body = "") => {
    signCalls.push({ method, path, body })
    return { Authorization: "Bearer test-card" }
  },
}))

import {
  SyncError,
  deleteSyncFile,
  downloadSyncFile,
  fetchSyncList,
  fetchSyncQuota,
  formatBytes,
  uploadSyncFile,
} from "./client"

const BASE = "https://relay-home.qmai.work"
const CARD = "test-card"
const condition = { storageGeneration: testGeneration, revision: "absent" }

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

beforeEach(() => {
  mockFetch.mockReset()
  signCalls.length = 0
})

describe("fetchSyncQuota", () => {
  it("GET /v1/sync/quota，返回配额结构", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        tier: "member",
        usedBytes: 1024,
        usedFiles: 2,
        limitBytes: 5368709120,
        limitFiles: 50000,
      }),
    )

    const quota = await fetchSyncQuota(BASE, CARD)
    expect(quota.tier).toBe("member")
    expect(quota.limitBytes).toBe(5368709120)

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe(`${BASE}/v1/sync/quota`)
    expect(init.method).toBe("GET")
  })

  it("末尾斜杠不会产生双斜杠", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ tier: "free", usedBytes: 0, usedFiles: 0, limitBytes: 1, limitFiles: 1 }))
    await fetchSyncQuota(`${BASE}///`, CARD)
    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/v1/sync/quota`)
  })

  it("401 翻译成「登录状态已失效」", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: { code: "netcard_required" } }, 401))
    await expect(fetchSyncQuota(BASE, CARD)).rejects.toThrow(/登录状态已失效/)
  })
})

describe("fetchSyncList", () => {
  it("projectId 会被 URL 编码（防路径注入）", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ files: [] }))
    await fetchSyncList(BASE, CARD, "a b/c")
    expect(mockFetch.mock.calls[0][0]).toContain("projectId=a%20b%2Fc")
  })

  it("返回文件列表", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ files: [{ path: "chapters/ch1.md", size: 100, mtime: 123 }] }),
    )
    const files = await fetchSyncList(BASE, CARD, "p1")
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe("chapters/ch1.md")
  })
})

describe("uploadSyncFile", () => {
  it("POST 原始字节（不是 JSON/base64），路径正确编码", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ protocolVersion: 2, projectId: "p1", path: "chapters/ch1.md", size: 9, sha256: testHash("第一章"), storageGeneration: testGeneration, revision: testRevision }),
    )

    const result = await uploadSyncFile(BASE, CARD, "p1", "chapters/ch1.md", "第一章", condition)
    expect(result.sha256).toBe(testHash("第一章"))

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toContain("/v1/sync/upload?projectId=p1&path=chapters%2Fch1.md")
    expect(init.method).toBe("POST")
    expect(init.headers["Content-Type"]).toBe("application/octet-stream")
    // body 是二进制（Blob），不是把文本塞进 JSON
    expect(init.body).toBeInstanceOf(Blob)
    // 中文按 UTF-8 编码成 9 字节（每字 3 字节）
    expect((init.body as Blob).size).toBe(9)
  })

  it("quota_exceeded 翻译成「空间已满」", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ error: { code: "quota_exceeded", message: "同步空间不足（已用 5MB，上限 5MB）。" } }, 413),
    )
    await expect(uploadSyncFile(BASE, CARD, "p1", "a.md", "x", condition)).rejects.toThrow(/同步空间不足/)
  })

  it("file_too_large 给出明确提示", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: { code: "file_too_large" } }, 413))
    await expect(uploadSyncFile(BASE, CARD, "p1", "a.md", "x", condition)).rejects.toThrow(/16MB/)
  })

  it("错误对象带 code，UI 能按类型分流", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: { code: "bad_path", message: "路径不合法。" } }, 400))
    try {
      await uploadSyncFile(BASE, CARD, "p1", "../x", "y", condition)
      expect.unreachable("应该抛错")
    } catch (e) {
      expect(e).toBeInstanceOf(SyncError)
      expect((e as SyncError).code).toBe("bad_path")
      expect((e as SyncError).status).toBe(400)
    }
  })
})

describe("downloadSyncFile", () => {
  it("返回文本内容", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "第一章 雨夜",
    } as unknown as Response)

    await expect(downloadSyncFile(BASE, CARD, "p1", "chapters/ch1.md")).resolves.toBe("第一章 雨夜")
  })

  it("404 抛错而不是返回空串（否则会静默覆盖本地文件）", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: { code: "not_found", message: "文件不存在。" } }, 404))
    await expect(downloadSyncFile(BASE, CARD, "p1", "missing.md")).rejects.toThrow(/文件不存在/)
  })
})

describe("deleteSyncFile", () => {
  it("POST JSON body 带 projectId 与 path", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }))
    await deleteSyncFile(BASE, CARD, "p1", "chapters/ch1.md", condition)

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe(`${BASE}/v1/sync/delete`)
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body as string)).toEqual({ projectId: "p1", path: "chapters/ch1.md" })
  })
})

describe("签名路径（必须不含 query）", () => {
  /*
   * 网关验签用的是 new URL(request.url).pathname —— 不含查询串。
   * 如果把 ?projectId=... 一起签进去，签名与网关重算的 payload 不一致，
   * 永远验不过。观察期不报错，一旦开强制验签所有带参请求集体 403。
   */
  it("list 签名只用 pathname", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ files: [] }))
    await fetchSyncList(BASE, CARD, "p1")

    expect(signCalls).toHaveLength(1)
    expect(signCalls[0].path).toBe("/v1/sync/list")
    expect(signCalls[0].path).not.toContain("?")
  })

  it("upload 签名只用 pathname，但请求 URL 仍带查询", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ protocolVersion: 2, projectId: "p1", path: "a.md", size: 1, sha256: testHash("x"), storageGeneration: testGeneration, revision: testRevision }),
    )
    await uploadSyncFile(BASE, CARD, "p1", "a.md", "x", condition)

    expect(signCalls[0].path).toBe("/v1/sync/upload")
    expect(signCalls[0].path).not.toContain("?")
    // 实际请求仍然要带 projectId / path
    expect(mockFetch.mock.calls[0][0]).toContain("?projectId=p1")
  })

  it("download 签名只用 pathname", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => "x" } as unknown as Response)
    await downloadSyncFile(BASE, CARD, "p1", "a.md")

    expect(signCalls[0].path).toBe("/v1/sync/download")
  })

  it("quota / delete 本身没有 query，路径不变", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ tier: "free", usedBytes: 0, usedFiles: 0, limitBytes: 1, limitFiles: 1 }))
    await fetchSyncQuota(BASE, CARD)
    expect(signCalls[0].path).toBe("/v1/sync/quota")
  })
})

describe("formatBytes", () => {
  it("按量级选择单位", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(2048)).toBe("2.0 KB")
    expect(formatBytes(5 * 1048576)).toBe("5.0 MB")
    expect(formatBytes(5368709120)).toBe("5.00 GB")
  })

  it("异常值不崩", () => {
    expect(formatBytes(Number.NaN)).toBe("—")
    expect(formatBytes(-1)).toBe("—")
  })
})
