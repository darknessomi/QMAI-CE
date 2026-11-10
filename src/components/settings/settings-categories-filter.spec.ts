/**
 * 设置分类的插件过滤。
 *
 * ## 为什么单独测这个
 *
 * 「关掉云同步插件后，设置里那一栏到底有没有消失」这条逻辑埋在组件里时
 * 只能靠手动点。而它恰好是 2026-11-08 改错的地方 —— 第一次误把
 * `memberCloud`（会员云空间）也过滤掉了，用户截图指出后才修正。
 *
 * 所以把它抽成纯函数，用测试钉死「该藏的藏、不该藏的绝不藏」。
 */

import { describe, expect, it } from "vitest"

import { visibleSettingsCategories } from "./settings-view"

const ids = (list: { id: string }[]) => list.map((c) => c.id)

describe("设置分类的插件过滤", () => {
  it("插件开着：所有分类都在", () => {
    const list = visibleSettingsCategories(true)
    expect(ids(list)).toContain("cloudSync")
    expect(ids(list)).toContain("account")
  })

  it("会员云空间已并入「账号」，不再是独立分类（2026-11-09）", () => {
    /*
     * 用户要求把「会员云空间」从独立设置分类搬进「账号」页。
     * 如果将来有人又把它加回 CATEGORIES，这条会失败 —— 那说明合并被回退了。
     */
    expect(ids(visibleSettingsCategories(true))).not.toContain("memberCloud")
  })

  it("插件关掉：只藏「云同步」", () => {
    const list = visibleSettingsCategories(false)
    expect(ids(list)).not.toContain("cloudSync")
  })

  it("插件关掉：「账号」分类必须保留（云空间就挂在它下面）", () => {
    /*
     * 用户原话：「会员云空间是不能删除的……只是将上面的云同步给隐藏了，
     * 而会员云空间是不隐藏的，两者没有任何关系。」
     *
     * 云空间现在并进了「账号」，所以这里守的是「账号永不被插件隐藏」——
     * 只要账号还在，云空间就还在。
     */
    const list = visibleSettingsCategories(false)
    expect(ids(list)).toContain("account")
  })

  it("插件关掉只少一项，其余分类不受影响", () => {
    const on = ids(visibleSettingsCategories(true))
    const off = ids(visibleSettingsCategories(false))
    expect(off).toHaveLength(on.length - 1)
    // 差集恰好是 cloudSync
    expect(on.filter((id) => !off.includes(id))).toEqual(["cloudSync"])
  })

  it("过滤不会打乱顺序（用户记住的是位置）", () => {
    const on = ids(visibleSettingsCategories(true))
    const off = ids(visibleSettingsCategories(false))
    const expected = on.filter((id) => id !== "cloudSync")
    expect(off).toEqual(expected)
  })

  it("不返回同一个数组引用（避免调用方改到常量）", () => {
    const a = visibleSettingsCategories(false)
    const b = visibleSettingsCategories(false)
    expect(a).not.toBe(b)
  })
})
