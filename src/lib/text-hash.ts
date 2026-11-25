/** 按 UTF-16 码元计算指纹，兼容已保存的章纲编号、记忆签名和导入进度。 */
export function hashTextHex(text: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i))
    hash = BigInt.asUintN(64, hash * prime)
  }
  return hash.toString(16).padStart(16, "0")
}
