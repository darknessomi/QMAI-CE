/** 用 64 位 FNV-1a 生成文本指纹。 */
const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n

function fnv1a64(input: string): bigint {
  let hash = FNV_OFFSET
  const bytes = new TextEncoder().encode(input)
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i])
    hash = (hash * FNV_PRIME) & 0xffffffffffffffffn
  }
  return hash
}

function toHex16(value: bigint): string {
  return value.toString(16).padStart(16, "0")
}

export function fingerprintText(text: string): string {
  return toHex16(fnv1a64(text))
}
