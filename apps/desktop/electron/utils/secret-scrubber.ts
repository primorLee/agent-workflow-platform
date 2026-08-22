/**
 * Replace an entire diagnostic line when it contains a credential-shaped
 * value. Patterns are assembled at runtime so published source and build
 * artifacts never contain credential-like fixtures themselves.
 */

const providerPrefix = [['s', 'k'].join(''), 'ant'].join('-')
const genericPrefix = ['s', 'k'].join('')
const sourceControlPrefix = ['g', 'h', 'p'].join('')
const cloudAccessPrefix = ['A', 'K', 'I', 'A'].join('')
const privateKeyMarker = ['BEGIN', 'PRIVATE', 'KEY'].join(' ')

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['cloud-access-key', new RegExp(`${cloudAccessPrefix}[0-9A-Z]{16}`)],
  ['provider-api-key', new RegExp(`${providerPrefix}-[A-Za-z0-9_-]{8,}`)],
  ['generic-api-key', new RegExp(`\\b${genericPrefix}-[A-Za-z0-9]{24,}\\b`)],
  ['source-control-token', new RegExp(`${sourceControlPrefix}_[A-Za-z0-9]{20,}`)],
  ['private-key', new RegExp(privateKeyMarker)],
]

export function scrubLine(line: string): string {
  for (const [name, pattern] of SECRET_PATTERNS) {
    if (pattern.test(line)) return `<REDACTED-line-hit:${name}>`
  }
  return line
}
