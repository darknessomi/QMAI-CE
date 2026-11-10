/**
 * 账号模块的共享类型。
 *
 * 这里只描述客户端与账号 Worker 之间的稳定契约：
 * - 网络层用 `AccountAuthPayload` / `AccountUser`；
 * - 登录态持久化用 `StoredAccountSession`；
 * - store 与 UI 共用 `AccountStatus` / `AccountAuthMode`。
 */

export type AccountErrorCode =
  | "VALIDATION"
  | "EMAIL_TAKEN"
  | "CODE_INVALID"
  | "CODE_EXPIRED"
  | "CODE_ATTEMPTS"
  | "RATE_LIMITED"
  | "INVALID_CREDENTIALS"
  | "WRONG_PASSWORD"
  | "ACCOUNT_DISABLED"
  | "TOKEN_EXPIRED"
  | "INVALID_REFRESH"
  | "EMAIL_SEND_FAILED"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "SERVER_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "NAME_LOCKED"
  | "NETWORK"
  /** 激活码无效或已被使用（服务端不区分「不存在 / 已兑换 / 已作废」）。 */
  | "CODE_NOT_FOUND"
  /** 会员服务不可用（服务端未配置密钥、或内置模型需要会员）。 */
  | "MEMBERSHIP_UNAVAILABLE"

export interface AccountUser {
  id: number
  email: string
  displayName: string
  createdAt: number
  /** 头像版本号（Unix 秒）；null 表示没有头像。 */
  avatarUpdatedAt: number | null
  /**
   * 头像读取用的随机 token；没有头像时可能为 null。
   *
   * 头像 URL 用它寻址而不是自增 id：后者公开可枚举，任何人能从 1 开始
   * 把全站头像拉一遍。老会话里没有这个字段，届时界面退回首字母头像。
   */
  avatarToken?: string | null
  /** 上次修改昵称的时间（Unix 秒）；从未改过为 null。 */
  displayNameUpdatedAt: number | null
  /**
   * 会员状态（服务端按**当前时间**算好的快照）。
   *
   * 老会话里没有这个字段：缺失一律按「非会员」处理，下一次刷新登录态就会补上。
   * 注意它是**快照**——本地跨过到期时间后，`expiresAt` 已经不可信，
   * 所以客户端判定必须同时看 `expiresAt > now`（见 `lib/membership/access.ts`）。
   */
  membership?: MembershipInfo | null
}

/** 会员信息的对外形状，与服务端 `PublicUser.membership` 保持一致。 */
export interface MembershipInfo {
  /** 服务端判定此刻是否有效。 */
  active: boolean
  /** 到期时间（Unix 秒）；从未开通为 null。永久卡是一个极远的固定值。 */
  expiresAt: number | null
  /** 剩余天数（向上取整）；非会员为 0，永久卡为 null。 */
  remainingDays: number | null
  /** 卡种标签（如「年卡」）；非会员为 null。 */
  planLabel: string | null
  /**
   * 是否永久会员（2026-11-07）。
   *
   * 界面必须看这个字段显示「永不过期」，不要拿 `expiresAt` 自己算 ——
   * 否则会显示成「剩余 27000 天」，看起来像 bug。
   * 老服务端不返回这个字段时按 false 处理（`parseMembershipInfo` 兜底）。
   */
  forever: boolean
}

export interface AccountAuthPayload {
  user: AccountUser
  accessToken: string
  accessExpiresAt: number
  refreshToken: string
  refreshExpiresAt: number
  /**
   * 网关卡：与本次登录的 session 绑定的**长期** EdDSA 凭证，供内置模型中转站验签。
   * 登录一次拿到，之后永久不用换；失效靠服务端吊销，不靠过期。
   * 为 null 表示账号服务没配签名私钥（登录仍成功，内置模型不可用）。
   */
  netcard?: string | null
}

export type AccountPurpose = "register" | "reset"
export type AccountAuthMode = "login" | "register" | "reset"
export type AccountStatus = "idle" | "booting" | "anonymous" | "authenticated"

export interface StoredAccountSession {
  baseUrl: string
  accessToken: string
  accessExpiresAt: number
  refreshToken: string
  refreshExpiresAt: number
  user: AccountUser
  /** 本地保存时间（Unix 秒）。 */
  savedAt: number
  /**
   * 网关卡（内置模型凭证）。与登录态同生共死：退出登录一起清掉。
   * 老版本存的会话没有这个字段，登录后会补上。
   */
  netcard?: string | null
}

export interface SendCodeResult {
  cooldownSeconds: number
  devCode?: string
}

export interface LoginInput {
  email: string
  password: string
  deviceLabel?: string
}

export interface RegisterInput {
  email: string
  code: string
  password: string
  displayName?: string
}

export interface ResetPasswordInput {
  email: string
  code: string
  password: string
}

export interface ChangePasswordInput {
  currentPassword: string
  newPassword: string
}

/** 头像上传时的图片原始字节与 MIME。 */
export interface AvatarUpload {
  data: ArrayBuffer
  mime: string
}

/** 兑换激活码的结果。 */
export interface RedeemCodeResult {
  membership: MembershipInfo
  /** 这张码加了多少天。 */
  addedDays: number
  /** 卡种标签（如「月卡」）；服务端认不出时为 null。 */
  planLabel: string | null
}
