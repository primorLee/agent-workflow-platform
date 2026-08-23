import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertPathHasNoRedirectComponents } from '../canonical-path'

let root = ''

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

describe('canonical path component validation', () => {
  it('accepts an ordinary existing directory', () => {
    root = mkdtempSync(join(tmpdir(), 'awp-canonical-path-'))
    const target = join(root, 'ordinary')
    mkdirSync(target)
    expect(() => assertPathHasNoRedirectComponents(target, 'redirected')).not.toThrow()
  })

  it('rejects a symbolic-link or junction component', () => {
    root = mkdtempSync(join(tmpdir(), 'awp-canonical-path-'))
    const actual = join(root, 'actual')
    const alias = join(root, 'alias')
    mkdirSync(actual)
    symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => assertPathHasNoRedirectComponents(alias, 'redirected')).toThrow('redirected')
  })
})

