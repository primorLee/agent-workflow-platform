/**
 * 工程记数法（Engineering Notation）格式化/解析
 *
 * 科学与工程工具中常用的 SI 单位前缀：
 *   f(1e-15) p(1e-12) n(1e-9) u(1e-6) m(1e-3)
 *   k(1e3) M(1e6) G(1e9) T(1e12)
 */

const SI_PREFIXES: [number, string][] = [
  [1e-15, 'f'],
  [1e-12, 'p'],
  [1e-9, 'n'],
  [1e-6, 'u'],
  [1e-3, 'm'],
  [1e0, ''],
  [1e3, 'k'],
  [1e6, 'M'],
  [1e9, 'G'],
  [1e12, 'T'],
]

const PREFIX_TO_EXPONENT: Record<string, number> = {
  f: 1e-15,
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  μ: 1e-6,
  m: 1e-3,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
}

/**
 * 将数值格式化为工程记数法字符串
 * @example formatEngineering(1e-12)  → "1p"
 * @example formatEngineering(2.5e-6) → "2.5u"
 * @example formatEngineering(10000)  → "10k"
 * @example formatEngineering(0)      → "0"
 */
export function formatEngineering(value: number, decimals = 3): string {
  if (value === 0) return '0'
  if (!Number.isFinite(value)) return String(value)

  const absVal = Math.abs(value)
  const sign = value < 0 ? '-' : ''

  // 找到最合适的前缀：最大的不超过 absVal 的前缀
  let bestScale = 1
  let bestPrefix = ''

  for (const [scale, prefix] of SI_PREFIXES) {
    if (absVal >= scale * 0.9999) {
      bestScale = scale
      bestPrefix = prefix
    }
  }

  // 超出 T 范围
  if (absVal >= 1e15) {
    return value.toExponential(decimals)
  }

  const scaled = absVal / bestScale
  // 去掉尾部零
  const formatted = parseFloat(scaled.toFixed(decimals)).toString()

  return `${sign}${formatted}${bestPrefix}`
}

/**
 * 解析工程记数法字符串为数值
 * @example parseEngineering("1p")    → 1e-12
 * @example parseEngineering("2.5u")  → 2.5e-6
 * @example parseEngineering("10k")   → 10000
 * @example parseEngineering("-3.3m") → -0.0033
 * @example parseEngineering("42")    → 42
 */
export function parseEngineering(str: string): number {
  const trimmed = str.trim()
  if (trimmed === '') {
    throw new Error('Empty string')
  }

  // 尝试直接解析纯数字（含科学记数法）
  const directParse = Number(trimmed)
  if (!isNaN(directParse) && /^[+-]?\d*\.?\d+(e[+-]?\d+)?$/i.test(trimmed)) {
    return directParse
  }

  // 匹配: 可选符号 + 数字部分 + 可选前缀
  const match = trimmed.match(/^([+-]?\d*\.?\d+)\s*([a-zA-Zμ]?)$/)
  if (!match) {
    throw new Error(`Cannot parse engineering notation: "${str}"`)
  }

  const numPart = parseFloat(match[1]!)
  const prefix = match[2]!

  if (prefix === '') {
    return numPart
  }

  const multiplier = PREFIX_TO_EXPONENT[prefix]
  if (multiplier === undefined) {
    throw new Error(`Unknown SI prefix: "${prefix}"`)
  }

  return numPart * multiplier
}
