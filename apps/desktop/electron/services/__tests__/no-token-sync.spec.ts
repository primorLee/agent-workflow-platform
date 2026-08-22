/** Public-boundary regression: the desktop never discovers or mirrors provider credentials. */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

describe('provider credential discovery remains removed', () => {
  const servicesDir = path.resolve(__dirname, '..')

  it('has no token-sync service implementation', () => {
    expect(existsSync(path.join(servicesDir, 'token-sync.ts'))).toBe(false)
  })

  it('does not wire token discovery into service startup or shutdown', () => {
    const orchestrator = readFileSync(path.join(servicesDir, 'index.ts'), 'utf8')
    expect(orchestrator).not.toMatch(/token-sync|startTokenSync|stopTokenSync/)
  })
})
