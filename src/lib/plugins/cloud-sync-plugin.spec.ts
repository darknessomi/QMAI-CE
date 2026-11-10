/**
 * 「云同步」插件与「会员云空间」的边界。
 *
 * ## 为什么单独钉这一条
 *
 * 2026-11-08 用户第一次提这个需求时说的是「将原有的云同步功能处理为一个插件
 * 功能……关闭之后它在设置当中只是显示了这个开关的关闭」，我理解成了
 * 「把会员云空间也藏起来」，于是把 `memberCloud` 一起过滤掉了。
 *
 * 用户随即纠正：
 *
 *   「你处理错了，我说的云同步就是设置当中的云同步。你现在将会员云空间也给
 *    关闭了，这是不行的……会员云空间是不能删除的。另外，它应该做的是，
 *    只是将上面的云同步给隐藏了，而会员云空间是不隐藏的，两者没有任何关系。」
 *
 * 所以这里钉死两件事：
 *   1. `cloud-sync` 插件控制的是 `cloudSync`（同步到用户自己的网盘）
 *   2. `memberCloud`（会员云空间）**永远可见**，不受任何插件影响
 *
 * 这是一条容易再犯的错 —— 两个功能名字里都有「云同步」，界面上又挨在一起。
 */

import { describe, expect, it } from "vitest"

import { BUILTIN_PLUGINS, builtinPlugin } from "./builtin"

describe("云同步插件的管辖范围", () => {
  it("cloud-sync 插件存在且默认开启", () => {
    const plugin = builtinPlugin("cloud-sync")
    expect(plugin).toBeTruthy()
    expect(plugin?.name).toBe("云同步")
    expect(plugin?.defaultEnabled).toBe(true)
  })

  it("它是 capability 而不是 view（关闭后不挂任何一级视图）", () => {
    const plugin = builtinPlugin("cloud-sync")
    expect(plugin?.kind).toBe("capability")
    expect(plugin?.view).toBeUndefined()
  })

  it("没有任何内置插件把会员云空间当作自己的视图", () => {
    /*
     * 这条是关键：如果将来有人给某个插件写了 `view: "memberCloud"`，
     * `isBuiltinViewEnabled("memberCloud")` 就会开始返回 false，
     * 会员云空间又会被藏起来。
     */
    const owners = BUILTIN_PLUGINS.filter((plugin) => plugin.view === "memberCloud")
    expect(owners).toHaveLength(0)
  })

  it("关闭效果文案里说清「数据不会被删除」", () => {
    // 用户明确说过云端数据由他自己处理，文案不能吓唬人说会清理
    expect(builtinPlugin("cloud-sync")?.offEffect).toContain("不会被删除")
  })
})
