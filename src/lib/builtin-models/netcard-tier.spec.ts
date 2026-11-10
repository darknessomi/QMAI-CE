import { describe, expect, it } from "vitest"

import { netcardTierOf } from "./netcard"

/**
 * 读网卡里的 `tier`。
 *
 * ## 为什么这个函数必须准（2026-11-09 线上 bug）
 *
 * 网卡是 JWT，`tier` 在签发那一刻就烘死了。网关据此决定云空间额度：
 * `free` = 100 MB，`member` = 5 GB。
 *
 * 用户开通会员后网卡没换 → 卡里还是 `free` → 额度一直显示 100 MB。
 * `refreshMembership` 靠这个函数判断「卡是旧的，该补签了」，
 * 判错了就修不了。
 */

/** 造一个只有 payload 的假 JWT（签名段随便填，这里不校验签名） */
function fakeCard(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>) => {
    const json = JSON.stringify(obj)
    // Node / jsdom 都有 Buffer；用 base64url 编码
    return Buffer.from(json, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  }
  return `${b64url({ alg: "EdDSA", typ: "JWT" })}.${b64url(payload)}.fakesignature`
}

describe("netcardTierOf", () => {
  it("会员卡 → member", () => {
    const card = fakeCard({ uid: 1, tier: "member", tierExp: 4_100_000_000 })
    expect(netcardTierOf({ netcard: card } as never)).toBe("member")
  })

  it("免费卡 → free", () => {
    const card = fakeCard({ uid: 1, tier: "free" })
    expect(netcardTierOf({ netcard: card } as never)).toBe("free")
  })

  it("老卡（没有 tier 字段）→ null，由调用方决定补签", () => {
    const card = fakeCard({ uid: 1, sid: "s" })
    expect(netcardTierOf({ netcard: card } as never)).toBeNull()
  })

  it("没有网卡 → null", () => {
    expect(netcardTierOf(null)).toBeNull()
    expect(netcardTierOf({} as never)).toBeNull()
    expect(netcardTierOf({ netcard: "" } as never)).toBeNull()
  })

  it("畸形 JWT 不抛错，返回 null", () => {
    expect(netcardTierOf({ netcard: "not-a-jwt" } as never)).toBeNull()
    expect(netcardTierOf({ netcard: "a.b" } as never)).toBeNull()
    expect(netcardTierOf({ netcard: "a.!!!notbase64!!!.c" } as never)).toBeNull()
  })

  it("payload 不是合法 JSON → null", () => {
    const bad = Buffer.from("not json", "utf8").toString("base64url")
    expect(netcardTierOf({ netcard: `h.${bad}.s` } as never)).toBeNull()
  })

  it("tier 是别的值 → null（不猜）", () => {
    const card = fakeCard({ uid: 1, tier: "pro" })
    expect(netcardTierOf({ netcard: card } as never)).toBeNull()
  })

  it("中文昵称等 UTF-8 字段不会让解码崩掉", () => {
    const card = fakeCard({ uid: 1, tier: "member", name: "青幕用户" })
    expect(netcardTierOf({ netcard: card } as never)).toBe("member")
  })
})
