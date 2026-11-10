/**
 * 网关端点选路（双通道 failover）。
 *
 * ## 为什么需要这个模块
 *
 * 2026-11-08 起内置模型有两条通道：
 *
 *   主通道 relay-home.qmai.work → Cloudflare Tunnel → 家庭网关（不限请求数）
 *   备通道 relay.qmai.work      → Cloudflare Worker（10 万次/天）
 *
 * 家庭网关跑在一台普通 PC 上：断电、重启、家宽抖动都会让它短暂不可用。
 * 如果客户端只认一个地址，那台机器一挂，所有用户的 AI 写作就全停了。
 *
 * ## 选路策略
 *
 * 「先探测、再决定」，而不是「先用、失败再换」：
 *   · 探测是一次 /health（毫秒级、无鉴权、不消耗额度）
 *   · 换来的是用户第一次请求就走对路，不会先白等一个超时
 *   · 结果缓存 5 分钟，避免每个请求都探测
 *
 * ## 失败兜底
 *
 * 两个都探测失败时，**退回 Cloudflare**。
 * 理由：Cloudflare 的可用性（99.99%）远高于家庭网关（90-95%），
 * 在都不确定的情况下选更稳的那个。
 */

import { getHttpFetch } from "@/lib/tauri-fetch"

/** 主通道优先：家庭网关不限请求数、不限带宽 */
export const RELAY_ENDPOINTS = [
  { name: "home", url: "https://relay-home.qmai.work" },
  { name: "cloud", url: "https://relay.qmai.work" },
] as const

export type RelayEndpointName = (typeof RELAY_ENDPOINTS)[number]["name"]

/**
 * 探测超时。
 *
 * 2026-11-08 从 1500ms 放宽到 4000ms。
 *
 * 原来写 1500ms 是按「家庭网关正常时 <200ms」估的，但那是局域网内的数字。
 * 实际链路是「用户 → Cloudflare 边缘（sjc/lax）→ 隧道 → 家里」，实测
 * 中位数 349ms，但冷启动第一次要 1100ms 以上，网络抖动时更高。
 * 1.5s 会让本来健康的家庭网关被判成「挂了」，白白切到备通道。
 */
const PROBE_TIMEOUT_MS = 4000

/** 选路结果缓存 5 分钟 */
const CACHE_TTL_MS = 5 * 60 * 1000

/** 全部探测失败时的兜底地址 */
export const FALLBACK_RELAY_URL = "https://relay.qmai.work"

interface RelaySelection {
  url: string
  name: RelayEndpointName | "fallback"
  at: number
}

let selection: RelaySelection | null = null

/**
 * 被动健康校验的节流时间。
 *
 * 家庭网关跑在普通 PC 上，随时可能断电/断网。如果只在 5 分钟缓存过期时
 * 才探测，主通道挂掉后最长 5 分钟内所有请求都会打到一个死地址。
 * 缓存命中时每 60 秒非阻塞地补探一次，能在 1 分钟内发现问题。
 */
const BACKGROUND_RECHECK_MS = 60_000

/** 上次后台校验时间戳（0 = 从未校验） */
let lastBackgroundCheckAt = 0

/**
 * 是否处于测试环境。
 *
 * 测试里不做真实网络探测：一是没有网络，二是每个用例白等 1.5s×2
 * 会把整个测试套件拖慢，甚至会因为超时而让无关用例失败
 * （2026-11-08 实际踩过：auto-sync 的两个用例因此超时）。
 *
 * 判定要**多路兜底**：只信 `import.meta.env.MODE` 不够稳 ——
 * 在某些测试环境下它是 undefined，于是一路走到真实 fetch。
 * 选路逻辑本身由 relay-endpoints.spec.ts 用注入式探测单独验证，
 * 所以这里跳过真实网络不影响覆盖度。
 */
function isTestEnv(): boolean {
  try {
    if (import.meta.env?.MODE === "test") return true
  } catch {
    // import.meta.env 不存在（非 Vite 环境）时继续往下判
  }
  try {
    if (typeof process !== "undefined" && process.env) {
      if (process.env.VITEST) return true
      if (process.env.NODE_ENV === "test") return true
    }
  } catch {
    // 某些沙箱里 process 不可用，忽略
  }
  return false
}

/**
 * 默认探测实现（只打 /health，不消耗额度、不需要网卡）
 *
 * ## 2026-11-08 修的一个致命 bug：必须走 getHttpFetch，不能用原生 fetch
 *
 * 这里原来直接调 `fetch()`。在 Tauri 的 WebView 里，跨域请求受 CORS 约束，
 * 而我们的网关（家里那台和 Cloudflare Worker）**都没有发
 * `Access-Control-Allow-Origin`** —— 于是两个探测在打包后的 App 里
 * **必然双双失败**，选路一路掉到兜底地址 `relay.qmai.work`。
 *
 * 后果不是「慢一点」，而是：同步接口只存在于家庭网关，Worker 上根本没有，
 * 所以用户点「备份」永远拿到 `404 接口不存在。`。
 *
 * 更隐蔽的是：真正发业务请求的 `gateway-api.ts` 一直用的是 `getHttpFetch()`
 * （Tauri 的 Rust 插件，绕过 CORS），所以「探测」和「实际请求」走的是
 * 两套完全不同的网络栈 —— 探测失败、业务却通，问题被藏得很好。
 *
 * `tauri-fetch.ts` 的文件头已经写明「所有访问用户配置 URL 的地方都应该
 * 从这里导入」，这个文件当时漏了。现在补上。
 */
const defaultProbe: (baseUrl: string) => Promise<boolean> = async (baseUrl) => {
  let abortTimer: ReturnType<typeof setTimeout> | null = null
  let raceTimer: ReturnType<typeof setTimeout> | null = null
  try {
    const httpFetch = await getHttpFetch()
    const controller = new AbortController()
    abortTimer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)

    /*
     * 双保险超时。
     *
     * `AbortSignal` 是标准做法，但探测走的是 Tauri 的 Rust 插件 ——
     * 底层是否尊重 signal 取决于插件实现版本。一旦不尊重，探一个死端点
     * 就会永远挂着，`resolveRelayBaseUrl()` 永不 resolve，整个界面卡住。
     *
     * 所以再加一层 Promise.race：无论如何，超时后一定返回「不可用」。
     * 探测本身是「尽力而为」，宁可判错成不可用，也不能把调用方拖死。
     */
    const timeoutMarker = Symbol("probe-timeout")
    const raced = await Promise.race([
      httpFetch(`${baseUrl}/health`, {
        method: "GET",
        signal: controller.signal,
        // 探测请求不该带凭据，也不该被缓存
        cache: "no-store",
      }),
      new Promise<typeof timeoutMarker>((resolve) => {
        raceTimer = setTimeout(() => resolve(timeoutMarker), PROBE_TIMEOUT_MS + 500)
      }),
    ])

    if (raced === timeoutMarker) return false
    return raced.ok
  } catch {
    return false
  } finally {
    if (abortTimer) clearTimeout(abortTimer)
    if (raceTimer) clearTimeout(raceTimer)
  }
}

let probeImpl: (baseUrl: string) => Promise<boolean> = defaultProbe

async function probeHealth(baseUrl: string): Promise<boolean> {
  /*
   * 这里必须再包一层 try/catch。
   *
   * 默认实现自己已经吞了异常，但探测实现是可以被替换的（测试注入、
   * 将来换探测方式）。只要替换后的实现抛一次，整个选路就会 reject ——
   * 而选路失败意味着用户连「用哪个地址」都拿不到，直接影响可用性。
   *
   * 探测是「尽力而为」的操作：拿不到结果就当不可用，绝不往外抛。
   */
  try {
    return await probeImpl(baseUrl)
  } catch {
    return false
  }
}

/**
 * 仅测试用：替换探测实现。
 *
 * 选路逻辑的核心是「先探 home、不行再探 cloud、都不行退 fallback」，
 * 这个决策链必须能脱离真实网络验证，否则只能靠手测。
 *
 * 传 null 复位时回到 `defaultProbe` —— **不要在这里再写一份实现**：
 * 之前这里复制了一份原生 `fetch` 版本，测试跑完复位后就悄悄退回到
 * 会被 CORS 拦掉的旧实现，问题只在打包后暴露。
 */
export function __setProbeForTest(fn: ((baseUrl: string) => Promise<boolean>) | null): void {
  probeImpl = fn ?? defaultProbe
}

/**
 * 仅测试用：跳过「测试环境直接返回 fallback」的短路。
 *
 * 生产逻辑不能因为「在测试里」就走不同分支，所以测试要显式打开
 * 真实逻辑，再用 __setProbeForTest 控制探测结果。
 */
let bypassTestShortcut = false
export function __enableRealResolutionForTest(): void {
  bypassTestShortcut = true
}

/**
 * 解析当前应使用的网关地址。
 *
 * @param options.force 忽略缓存重新探测（切换网络、或上次请求失败后调用）
 */
export async function resolveRelayBaseUrl(options?: { force?: boolean }): Promise<string> {
  if (!bypassTestShortcut && isTestEnv()) return FALLBACK_RELAY_URL

  if (!options?.force && selection && Date.now() - selection.at < CACHE_TTL_MS) {
    /*
     * 缓存命中时的被动健康校验（2026-11-08 加）。
     *
     * 缓存期内直接返回，避免每个请求都多一次网络往返。
     * 但主通道挂在普通 PC 上，随时可能断电 —— 只在缓存过期时才探测的话，
     * 它挂掉后最长 5 分钟内所有请求都会打到死地址。
     *
     * 折中：选的是家庭网关、且距上次后台校验超过 60 秒时，**非阻塞**补探一次。
     * 探测失败立刻作废缓存，下一次调用就会走备通道。
     * 本次调用照常返回缓存值，不增加延迟。
     */
    if (
      selection.name === "home" &&
      Date.now() - lastBackgroundCheckAt > BACKGROUND_RECHECK_MS
    ) {
      lastBackgroundCheckAt = Date.now()
      const probedUrl = selection.url
      void probeHealth(probedUrl).then((ok) => {
        if (ok) return
        // 只有缓存仍指向同一地址时才作废，避免把刚选出的新结果冲掉
        if (selection && selection.url === probedUrl) {
          console.warn("[relay] 家庭网关被动校验失败，作废选路缓存")
          selection = null
        }
      })
    }
    return selection.url
  }

  for (const endpoint of RELAY_ENDPOINTS) {
    if (await probeHealth(endpoint.url)) {
      selection = { url: endpoint.url, name: endpoint.name, at: Date.now() }
      /*
       * 选定地址时同步重置被动校验计时。
       *
       * 不重置的话，lastBackgroundCheckAt 还是 0（或很久以前），
       * 下一次缓存命中就会立刻再探一次 —— 等于白探，还让「第二次调用不再探测」
       * 这个契约失效（测试直接抓到了）。
       */
      lastBackgroundCheckAt = Date.now()
      return endpoint.url
    }
  }

  // 全部不可用：退回 Cloudflare（可用性更高）
  selection = { url: FALLBACK_RELAY_URL, name: "fallback", at: Date.now() }
  lastBackgroundCheckAt = Date.now()
  return FALLBACK_RELAY_URL
}

/**
 * 同步专用的地址解析。
 *
 * ## 为什么同步不能直接用 `resolveRelayBaseUrl()`
 *
 * 那个函数在两条通道都不通时会退回 `relay.qmai.work`（Cloudflare Worker）——
 * 对聊天是合理的（Worker 能转发模型请求），但 **Worker 上根本没有
 * `/v1/sync/*` 接口**，退过去只会拿到 `404 接口不存在。`。
 *
 * 2026-11-08 用户实际踩到了：探测因 CORS 失败 → 退到 Worker → 备份全部失败，
 * 而且错误信息「接口不存在」完全看不出真正原因。
 *
 * 所以同步走这条独立路径：
 *   · 家庭网关可用 → 用它
 *   · 家庭网关不可用 → 抛一个**说人话**的错误，让用户知道该等一会儿重试
 * 而不是悄悄退到一个明知道会失败的地方。
 */
export async function resolveSyncBaseUrl(): Promise<string> {
  const home = RELAY_ENDPOINTS.find((e) => e.name === "home")
  if (!home) throw new Error("同步通道未配置。")

  // 缓存里已经是 home，直接用（避免每次备份都多一次探测）
  if (selection?.name === "home" && Date.now() - selection.at < CACHE_TTL_MS) {
    return selection.url
  }

  if (await probeHealth(home.url)) {
    selection = { url: home.url, name: "home", at: Date.now() }
    lastBackgroundCheckAt = Date.now()
    return home.url
  }

  throw new Error(
    "云同步服务暂时不可用（家庭网关未响应）。请稍后重试；如果持续失败，请联系客服。",
  )
}

/**
 * 作废当前选路缓存。
 *
 * 在「请求失败」时调用：说明这个端点其实不通，下次应该重新探测。
 * 不做这一步的话，缓存期内会一直往一个已经挂掉的地址打。
 */
export function invalidateRelayCache(): void {
  selection = null
  // 一并重置被动校验节流，让下次调用立刻重新探测，而不是再等 60 秒
  lastBackgroundCheckAt = 0
}

/**
 * 上报一次请求失败。
 *
 * 与 `invalidateRelayCache()` 的区别：那个是「无条件作废」，适合
 * 「我刚试过、确定不通」的场景；这个只在**失败的地址正是当前选中的地址**时
 * 才作废 —— 避免并发请求里某个老请求的失败，把刚切换到备通道的新选择冲掉。
 *
 * 传空或无法识别的地址时什么都不做（调用方不必先判断）。
 */
export function reportRelayFailure(failedUrl: string | null | undefined): void {
  if (!failedUrl || !selection) return
  const norm = (u: string) => u.replace(/\/+$/, "").toLowerCase()
  if (norm(selection.url) !== norm(failedUrl)) return
  console.warn("[relay] 请求失败，作废选路缓存", { failedUrl })
  selection = null
  lastBackgroundCheckAt = 0
}

/** 当前选中的端点（诊断用；未选路时返回 null） */
export function currentRelaySelection(): { url: string; name: string } | null {
  return selection ? { url: selection.url, name: selection.name } : null
}

/** 仅测试用：直接写入选路结果，跳过网络探测 */
export function __setRelaySelectionForTest(value: RelaySelection | null): void {
  selection = value
  // 与真实选路保持一致：写入即视为「刚校验过」，避免立刻触发被动探测
  lastBackgroundCheckAt = value ? Date.now() : 0
}
