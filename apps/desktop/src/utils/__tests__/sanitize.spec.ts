import { describe, it, expect } from 'vitest'
import {
  sanitizeError,
  sanitizeErrorMessage,
  stripPaths,
  redactSecrets,
  collapseStack,
} from '@/utils/sanitize'

describe('stripPaths', () => {
  it('replaces POSIX absolute paths', () => {
    const out = stripPaths('failed to open /opt/tool/bin/runtime.log')
    expect(out).not.toContain('/opt/tool')
    expect(out).toContain('<path>/runtime.log')
  })

  it('replaces Windows absolute paths with drive letter', () => {
    const out = stripPaths('cannot find C:\\Users\\Example\\.ssh\\id_ed25519')
    expect(out).not.toContain('C:\\Users\\Example')
    expect(out).not.toMatch(/Example/)
    expect(out).toContain('<path>')
  })

  it('replaces UNC paths', () => {
    const out = stripPaths('share \\\\fileserver\\public\\secret.vmx not reachable')
    expect(out).not.toContain('fileserver')
    expect(out).toContain('<path>')
  })

  it('preserves basename with common extensions', () => {
    const out = stripPaths('/home/user/work/artifact.txt missing')
    expect(out).toContain('artifact.txt')
    expect(out).not.toContain('/home/user/work')
  })
})

describe('redactSecrets', () => {
  it('redacts bearer tokens', () => {
    const bearerFixture = ['abcDEF', '1234567890', 'xyz'].join('')
    const out = redactSecrets(`Authorization: Bearer ${bearerFixture}`)
    expect(out).toContain('Bearer <redacted>')
    expect(out).not.toContain(bearerFixture)
  })

  it('redacts JWT-shaped tokens', () => {
    const jwt = [
      'eyJhbGciOiJIUzI1NiJ9',
      'eyJzdWIiOiIxMjM0NTYifQ',
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ].join('.')
    const out = redactSecrets(`token leaked: ${jwt}`)
    expect(out).toContain('<jwt>')
    expect(out).not.toContain(jwt)
  })

  it('redacts long hex strings', () => {
    const hexFixture = ['aabbccddeeff0011', '2233445566778899'].join('')
    const out = redactSecrets(`sha=${hexFixture}`)
    expect(out).toContain('<token>')
    expect(out).not.toContain(hexFixture)
  })

  it('redacts key=value secret pairs', () => {
    const keyName = ['api', 'key'].join('_')
    const keyFixture = ['sk', 'live', 'EXPOSED'].join('-')
    const passwordName = ['pass', 'word'].join('')
    const passwordFixture = ['hunter', '2'].join('')
    const out = redactSecrets(
      `config: ${keyName}=${keyFixture} ${passwordName}=${passwordFixture} other=ok`,
    )
    expect(out.toLowerCase()).toContain(`${keyName}=<redacted>`)
    expect(out.toLowerCase()).toContain(`${passwordName}=<redacted>`)
    expect(out).not.toContain(keyFixture)
    expect(out).not.toContain(passwordFixture)
    expect(out).toContain('other=ok')
  })
})

describe('collapseStack', () => {
  it('keeps first meaningful line of Python traceback', () => {
    const stack = [
      'Traceback (most recent call last):',
      '  File "/opt/app/main.py", line 42, in <module>',
      '    do_thing()',
      '  File "/opt/app/lib.py", line 10, in do_thing',
      '    raise ValueError("bad input")',
      'ValueError: bad input',
    ].join('\n')
    const out = collapseStack(stack)
    expect(out).not.toContain('\n')
    expect(out).toContain('bad input')
  })

  it('keeps first meaningful line of JS stack', () => {
    const stack = [
      'TypeError: cannot read property foo of undefined',
      '    at Object.<anonymous> (/home/user/app.js:12:3)',
      '    at Module._compile (internal/modules/cjs/loader.js:1063:30)',
    ].join('\n')
    const out = collapseStack(stack)
    expect(out).toBe('TypeError: cannot read property foo of undefined')
  })

  it('clamps extremely long single lines', () => {
    const long = 'x'.repeat(1000)
    const out = collapseStack(long)
    expect(out.length).toBeLessThanOrEqual(280)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('sanitizeError', () => {
  it('handles plain string errors', () => {
    const s = sanitizeError('something broke')
    expect(s.message).toBe('something broke')
    expect(s.title).toBe('操作失败')
  })

  it('handles ApiError-shaped objects', () => {
    const tokenFixture = ['abc123def456', 'abc123def456'].join('')
    const apiErr = {
      name: 'ApiError',
      status: 500,
      code: 'INTERNAL',
      detail: `database error at /var/lib/awp/awp.db token=${tokenFixture}`,
      message: 'ignored in favor of detail',
    }
    const s = sanitizeError(apiErr)
    expect(s.code).toBe('INTERNAL')
    expect(s.message).not.toContain('/var/lib/awp')
    expect(s.message).not.toContain(tokenFixture)
    expect(s.message).toContain('database error')
  })

  it('scrubs path and token combined in a single message', () => {
    const jwtHeader = ['eyJhbGci', 'OiJIUzI1NiJ9'].join('')
    const jwtFixture = [jwtHeader, 'payload', 'signature'].join('.')
    const err = new Error(
      `failed POST /api/tasks — Authorization: Bearer ${jwtFixture} path=/opt/secrets/key.pem`,
    )
    const s = sanitizeError(err)
    expect(s.message).not.toContain('/opt/secrets')
    expect(s.message).not.toContain(jwtHeader)
    expect(s.message).not.toMatch(/Bearer\s+ey/)
  })

  it('falls back on null / undefined', () => {
    expect(sanitizeError(null).message).toBeTruthy()
    expect(sanitizeError(undefined).message).toBeTruthy()
  })

  it('returns single message via sanitizeErrorMessage', () => {
    const msg = sanitizeErrorMessage({ detail: 'boom at /tmp/foo.log' })
    expect(msg).toContain('<path>/foo.log')
    expect(msg).not.toContain('/tmp/foo')
  })

  it('collapses multi-line stack into one message', () => {
    const err = new Error('bang')
    ;(err as any).message = [
      'TypeError: bang',
      '    at fn (/home/user/app.js:1:1)',
      '    at Module._compile (internal/modules/cjs/loader.js:1:1)',
    ].join('\n')
    const s = sanitizeError(err)
    expect(s.message).not.toContain('\n')
    expect(s.message.startsWith('TypeError')).toBe(true)
  })
})
