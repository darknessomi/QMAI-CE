// 仅供同步测试使用的合成协议数据，不连接线上服务。
import { createHash } from "node:crypto"
import type { SyncRemoteManifest, SyncUploadResult } from "./client"

export const testGeneration = "a".repeat(64)
export const testRevision = "12345678-1234-1234-1234-123456789abc"
export const testHash = (content: string) => createHash("sha256").update(content).digest("hex")
export const testFile = (path: string, content: string) => ({
  path, size: Buffer.byteLength(content), mtime: 1, sha256: testHash(content), revision: testRevision,
})
export const testManifest = (projectId: string, files: SyncRemoteManifest["files"] = []): SyncRemoteManifest => ({
  protocolVersion: 2, projectId, storageGeneration: testGeneration, files,
})
export const testStamp = (content: string, mtime: number) => ({
  size: Buffer.byteLength(content), mtime, sha256: testHash(content),
  revision: testRevision, storageGeneration: testGeneration,
})
export const testReceipt = async (args: { projectId: string; relPath: string; content: string }): Promise<SyncUploadResult> => ({
  protocolVersion: 2, projectId: args.projectId, ...testFile(args.relPath, args.content), storageGeneration: testGeneration,
})
