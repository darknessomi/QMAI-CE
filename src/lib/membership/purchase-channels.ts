/**
 * 会员开通渠道配置（2026-11-07）。
 *
 * ## 为什么单独一个文件
 *
 * 购买链接与客服联系方式是**运营配置**，不是业务逻辑：
 *   · 发卡站可能换链接、上架新卡种；
 *   · 客服 QQ/微信可能变；
 *   · 这些变化不应该逼迫改组件、跑测试、重新发版验证。
 *
 * 集中在一处后，运营侧改动只需要动这个文件里的字符串。
 *
 * ## 为什么网址不写死在各处
 *
 * 引导页（`member-gate-notice`）、账号页（`account-section`）、
 * 模型同步面板（`model-sync-panel`）三处都要展示「去哪买」。
 * 若三处各写一份，改一次要改三遍，迟早漏一处导致链接不一致。
 */

/** 一个购买渠道。 */
export interface PurchaseChannel {
  /** 展示名（按钮文字）。 */
  label: string
  /** 打开的目标：链接用 url，其它用 value。 */
  url?: string
  value?: string
  /** 一句话说明（卡片副标题）。 */
  note: string
}

/**
 * 发卡站：用户自助购买，付款后即时拿到激活码。
 *
 * ⚠️ 链接是**分类/列表页**。发卡站上架商品后如果换成了每个卡种独立链接，
 * 只需改这里的 url，不需要动任何组件。
 */
const CARD_STORE_URL = "https://www.houfaka.com/liebiao/E8C76032BAB4C50C"

/** 客服：人工发码（特殊需求、补偿、批量）。 */
const SUPPORT_CONTACT = "970235022"

export const CARD_STORE_CHANNEL: PurchaseChannel = {
  label: "去发卡站购买",
  url: CARD_STORE_URL,
  note: "支持月卡 / 季卡 / 年卡，付款后立即拿到激活码",
}

export const SUPPORT_CHANNEL: PurchaseChannel = {
  label: "联系客服发码",
  value: SUPPORT_CONTACT,
  note: `QQ：${SUPPORT_CONTACT}（特殊需求或批量购买）`,
}

/**
 * 展示给用户的卡种与参考价。
 *
 * ## 为什么要标注「以发卡站实价为准」
 *
 * 这里的价格是**引导用的参考值**，真正的成交价由发卡站决定。
 * 如果两边不一致而不说明，用户会拿软件里的价格去质问客服；写上这句话，
 * 冲突就变成一个已知的、可解释的差异，而不是「你们骗人」。
 *
 * 价格调整时只需改这里（以及发卡站后台）。
 */
export interface PlanDisplay {
  id: "month" | "quarter" | "year"
  name: string
  /** 参考价（元）。仅用于展示。 */
  price: number
  /** 折合月单价，用于展示性价比。 */
  pricePerMonth: number
  /** 是否主推。 */
  recommended?: boolean
}

/*
 * ⚠️ 2026-11-09 测试期：价格临时改成 0.5 元，与服务端 `pay-config.ts` 一致。
 *
 * 为什么不是 0.01：实测支付平台对 1 元以下小额会随机调整金额
 * （发 0.01 → 记 0.12/0.13），0.50 才能被精确记录。
 *
 * 正式上线时把这里和服务端 `PAY_PLANS` 一起改回 39/99/299。
 */
export const PLAN_DISPLAYS: readonly PlanDisplay[] = [
  { id: "month", name: "月卡", price: 0.5, pricePerMonth: 0.5 },
  { id: "quarter", name: "季卡", price: 0.5, pricePerMonth: 0.17 },
  { id: "year", name: "年卡", price: 0.5, pricePerMonth: 0.04, recommended: true },
]

/** 价格免责说明。 */
export const PRICE_DISCLAIMER = "价格以发卡站实际标价为准"

/**
 * 会员权益说明（「动作 + 结果」写法）。
 *
 * ## 为什么不沿用功能的技术描述
 *
 * 原来的写法是「导入参考作品，拆解结构、文风与人物后复用」——
 * 这是**功能说明书**，用户看完不知道能省他多少事。
 * 「拆解一本爆款，直接生成可用的写作模板」才是**价值主张**：
 * 用户能立刻代入「我可以拿它拆我最喜欢的那本书」。
 *
 * 顺序即展示顺序，第一个是记忆点权益（拆书库）。
 */
export interface BenefitItem {
  feature: string
  /** 一句话说清用户得到什么。 */
  headline: string
  /** 补充说明（可选）。 */
  detail?: string
}

export const MEMBER_BENEFITS: readonly BenefitItem[] = [
  {
    /*
     * 2026-11-09 补进「云备份」。
     *
     * 它一直是会员专属（`member-cloud-store.runBackup()` 有硬闸门），
     * 但买卡页从没提过它 —— 用户开通后才发现「原来还有个云备份」。
     * 放在最前是因为它解决的是**丢稿**这种最疼的场景，说服力最强。
     */
    feature: "云备份",
    headline: "作品自动备份到云端，换设备或重装都不丢稿",
    detail: "保存后约 8 秒自动同步一次，云空间 5 GB",
  },
  {
    feature: "拆书库",
    headline: "拆解一本爆款，直接生成可用的写作模板",
    detail: "结构、文风、人物一次拆完，省掉自己分析别人怎么写的几个小时",
  },
  {
    feature: "剧情推演室",
    headline: "动笔前试演 3 种走向，挑最好的那条写",
    detail: "避免写了几万字才发现路线走不通",
  },
  {
    feature: "灵魂库",
    headline: "让 AI 一直按同一文风写，不会越写越跑偏",
    detail: "长篇写到后期的「人设崩了」，多数是文风没有锚点",
  },
  {
    feature: "模型同步",
    headline: "换电脑不用重新配一遍模型",
    detail: "模型配置加密后同步到你的其它设备，Key 不会外泄",
  },
]

/** 单设备限制提示（必须在开通前告知，否则用户第二台设备被踢会困惑）。 */
export const SINGLE_DEVICE_NOTE =
  "账号同一时间只能在一台设备登录。在新设备登录时，其它设备会自动退出。"
