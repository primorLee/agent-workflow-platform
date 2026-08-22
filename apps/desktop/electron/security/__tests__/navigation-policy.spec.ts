import { describe, expect, it, vi } from 'vitest'
import {
  decideTopLevelNavigation,
  decideWindowOpen,
  enforceTopLevelNavigation,
  enforceWindowOpenPolicy,
  installNavigationGuards,
  normalizeTrustedDocumentUrl,
  type NavigationEventListener,
} from '../navigation-policy'

const DEV_DOCUMENT = 'http://localhost:5173/'
const PROD_DOCUMENT = 'file:///C:/AgentWorkflowPlatform/dist/index.html'

describe('normalizeTrustedDocumentUrl', () => {
  it.each([
    ['http://localhost:5173/app', 'http://localhost:5173/app'],
    ['https://LOCALHOST:8443/', 'https://localhost:8443/'],
    ['http://127.0.0.1:8787/app?mode=demo', 'http://127.0.0.1:8787/app?mode=demo'],
    ['http://[::1]:5173/', 'http://[::1]:5173/'],
    ['http://[0:0:0:0:0:0:0:1]:5173/', 'http://[::1]:5173/'],
  ])('accepts a strict loopback development document: %s', (candidate, expected) => {
    expect(normalizeTrustedDocumentUrl(candidate, 'development')).toBe(expected)
  })

  it.each([
    ' https://localhost:5173/',
    ['https://user', 'secret@localhost:5173/'].join(':'),
    'https://@localhost:5173/',
    'https://localhost:5173/%ZZ',
    'https://localhost.evil:5173/',
    'https://127.0.0.1.evil:5173/',
    'http://0.0.0.0:5173/',
    `http://${[10, 0, 0, 1].join('.')}:5173/`,
    `http://${[172, 16, 0, 1].join('.')}:5173/`,
    `http://${[192, 168, 1, 10].join('.')}:5173/`,
    'http://198.51.100.10:5173/',
    'https://app.example.test/',
    'http://2130706433:5173/',
    'http://0x7f000001:5173/',
    'http://127.1:5173/',
    'http://127.000.000.001:5173/',
    'http://127%2e0%2e0%2e1:5173/',
    'http://local%68ost:5173/',
    'http://localhost.:5173/',
    'http://[::ffff:127.0.0.1]:5173/',
    'http://[::]:5173/',
    'http://[fe80::1]:5173/',
    'file:///C:/app/index.html',
  ])('rejects a non-loopback, encoded, or malformed development document: %s', (candidate) => {
    expect(normalizeTrustedDocumentUrl(candidate, 'development')).toBeNull()
  })

  it('accepts only a local file URL as the production document', () => {
    expect(normalizeTrustedDocumentUrl(PROD_DOCUMENT, 'production')).toBe(PROD_DOCUMENT)
    expect(normalizeTrustedDocumentUrl('file://localhost/C:/app/index.html', 'production'))
      .toBe('file:///C:/app/index.html')
    expect(normalizeTrustedDocumentUrl('file://fileserver/share/index.html', 'production')).toBeNull()
    expect(normalizeTrustedDocumentUrl('https://app.example.test/', 'production')).toBeNull()
  })
})

describe('will-navigate policy', () => {
  it('allows only the trusted development origin in the privileged window', () => {
    expect(decideTopLevelNavigation({
      targetUrl: 'http://localhost:5173/settings?tab=runtime#advanced',
      currentDocumentUrl: 'http://localhost:5173/#/chat',
      trustedDocumentUrl: DEV_DOCUMENT,
    })).toEqual({ action: 'allow-current-document' })

    expect(decideTopLevelNavigation({
      targetUrl: 'http://127.0.0.1:5173/settings',
      currentDocumentUrl: 'http://localhost:5173/#/chat',
      trustedDocumentUrl: DEV_DOCUMENT,
    })).toEqual({ action: 'open-external', url: 'http://127.0.0.1:5173/settings' })
  })

  it('allows the initial trusted document from the empty bootstrap page', () => {
    expect(decideTopLevelNavigation({
      targetUrl: DEV_DOCUMENT,
      currentDocumentUrl: '',
      trustedDocumentUrl: DEV_DOCUMENT,
    })).toEqual({ action: 'allow-current-document' })
  })

  it('will not trust a same-origin target after the current document became untrusted', () => {
    expect(decideTopLevelNavigation({
      targetUrl: 'http://localhost:5173/settings',
      currentDocumentUrl: 'https://untrusted.example.test/',
      trustedDocumentUrl: DEV_DOCUMENT,
    })).toEqual({ action: 'open-external', url: 'http://localhost:5173/settings' })
  })

  it('routes a strict external HTTP(S) URL outside Electron', () => {
    expect(decideTopLevelNavigation({
      targetUrl: 'https://docs.example.test/guide?q=public#start',
      currentDocumentUrl: 'http://localhost:5173/#/chat',
      trustedDocumentUrl: DEV_DOCUMENT,
    })).toEqual({
      action: 'open-external',
      url: 'https://docs.example.test/guide?q=public#start',
    })
  })

  it.each([
    ' https://docs.example.test/',
    ['https://user', 'secret@docs.example.test/'].join(':'),
    'https://@docs.example.test/',
    'https://docs.example.test/%ZZ',
    'https:\\docs.example.test/path',
  ])('denies malformed or credential-bearing HTTP(S): %s', (targetUrl) => {
    expect(decideTopLevelNavigation({
      targetUrl,
      currentDocumentUrl: 'http://localhost:5173/#/chat',
      trustedDocumentUrl: DEV_DOCUMENT,
    })).toEqual({ action: 'deny', reason: 'malformed_url' })
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'mailto:operator@example.test',
    'custom://action/run',
  ])('denies dangerous or unsupported schemes: %s', (targetUrl) => {
    expect(decideTopLevelNavigation({
      targetUrl,
      currentDocumentUrl: 'http://localhost:5173/#/chat',
      trustedDocumentUrl: DEV_DOCUMENT,
    })).toEqual({ action: 'deny', reason: 'dangerous_scheme' })
  })

  it('keeps a valid awp artifact navigation internal', () => {
    expect(decideTopLevelNavigation({
      targetUrl: 'awp://artifact/run-report.pdf',
      currentDocumentUrl: 'http://localhost:5173/#/chat',
      trustedDocumentUrl: DEV_DOCUMENT,
    })).toEqual({ action: 'open-artifact', artifactId: 'run-report.pdf' })
  })

  it.each([
    'awp://artifact/',
    'awp://other/report.pdf',
    'awp://artifact/../secret.txt',
    'awp://artifact/%2Fsecret.txt',
    'awp://artifact/report.pdf?token=secret',
    'awp://artifact/report.pdf#fragment',
  ])('denies malformed awp artifact navigation: %s', (targetUrl) => {
    expect(decideTopLevelNavigation({
      targetUrl,
      currentDocumentUrl: 'http://localhost:5173/#/chat',
      trustedDocumentUrl: DEV_DOCUMENT,
    })).toEqual({ action: 'deny', reason: 'invalid_artifact' })
  })

  it('allows only same-document hash navigation in production file mode', () => {
    expect(decideTopLevelNavigation({
      targetUrl: `${PROD_DOCUMENT}#/settings`,
      currentDocumentUrl: `${PROD_DOCUMENT}#/chat`,
      trustedDocumentUrl: PROD_DOCUMENT,
    })).toEqual({ action: 'allow-current-document' })

    expect(decideTopLevelNavigation({
      targetUrl: 'file:///C:/AgentWorkflowPlatform/dist/other.html',
      currentDocumentUrl: PROD_DOCUMENT,
      trustedDocumentUrl: PROD_DOCUMENT,
    })).toEqual({ action: 'deny', reason: 'untrusted_file' })

    expect(decideTopLevelNavigation({
      targetUrl: `${PROD_DOCUMENT}?redirect=other.html`,
      currentDocumentUrl: PROD_DOCUMENT,
      trustedDocumentUrl: PROD_DOCUMENT,
    })).toEqual({ action: 'deny', reason: 'untrusted_file' })
  })

  it('does not echo a rejected target or its secret query in the decision', () => {
    const targetUrl = 'javascript:location.href="https://example.test/?token=super-secret"'
    const decision = decideTopLevelNavigation({
      targetUrl,
      currentDocumentUrl: DEV_DOCUMENT,
      trustedDocumentUrl: DEV_DOCUMENT,
    })
    const serialized = JSON.stringify(decision)
    expect(serialized).toBe('{"action":"deny","reason":"dangerous_scheme"}')
    expect(serialized).not.toContain('super-secret')
  })
})

describe('window.open policy', () => {
  it.each([
    'http://localhost:5173/settings',
    'https://docs.example.test/guide',
  ])('returns an external-only side effect for safe web URLs: %s', (targetUrl) => {
    expect(decideWindowOpen(targetUrl)).toEqual({
      action: 'open-external',
      url: targetUrl,
    })
  })

  it('keeps a valid awp artifact action internal', () => {
    expect(decideWindowOpen('awp://artifact/run-report.json'))
      .toEqual({ action: 'open-artifact', artifactId: 'run-report.json' })
  })

  it.each([
    'file:///C:/AgentWorkflowPlatform/dist/index.html',
    'javascript:alert(1)',
    'data:text/html,blocked',
    'custom://action/run',
  ])('denies window creation for non-web schemes: %s', (targetUrl) => {
    expect(decideWindowOpen(targetUrl).action).toBe('deny')
  })

  it.each([
    ['https://user', 'secret@docs.example.test/'].join(':'),
    'https://@docs.example.test/',
    'https://docs.example.test/%ZZ',
  ])('denies malformed or credential-bearing web URLs: %s', (targetUrl) => {
    expect(decideWindowOpen(targetUrl)).toEqual({ action: 'deny', reason: 'malformed_url' })
  })
})
describe('Electron navigation guard orchestration', () => {
  it('leaves a trusted top-level navigation untouched', () => {
    const preventDefault = vi.fn()
    const openExternal = vi.fn()
    const openArtifact = vi.fn()

    const decision = enforceTopLevelNavigation({
      targetUrl: 'http://localhost:5173/settings',
      currentDocumentUrl: DEV_DOCUMENT,
      trustedDocumentUrl: DEV_DOCUMENT,
    }, { preventDefault }, { openExternal, openArtifact })

    expect(decision).toEqual({ action: 'allow-current-document' })
    expect(preventDefault).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
    expect(openArtifact).not.toHaveBeenCalled()
  })

  it('prevents top-level external navigation before opening it outside Electron', () => {
    const order: string[] = []
    const decision = enforceTopLevelNavigation({
      targetUrl: 'https://docs.example.test/guide?topic=public',
      currentDocumentUrl: DEV_DOCUMENT,
      trustedDocumentUrl: DEV_DOCUMENT,
    }, {
      preventDefault: () => order.push('prevent'),
    }, {
      openExternal: () => order.push('external'),
      openArtifact: () => order.push('artifact'),
    })

    expect(decision.action).toBe('open-external')
    expect(order).toEqual(['prevent', 'external'])
  })

  it('prevents an internal artifact navigation before dispatching it', () => {
    const order: string[] = []
    enforceTopLevelNavigation({
      targetUrl: 'awp://artifact/run-report.pdf',
      currentDocumentUrl: DEV_DOCUMENT,
      trustedDocumentUrl: DEV_DOCUMENT,
    }, {
      preventDefault: () => order.push('prevent'),
    }, {
      openExternal: () => order.push('external'),
      openArtifact: (artifactId) => order.push(`artifact:${artifactId}`),
    })

    expect(order).toEqual(['prevent', 'artifact:run-report.pdf'])
  })

  it('prevents a dangerous navigation without performing any side effect', () => {
    const preventDefault = vi.fn()
    const openExternal = vi.fn()
    const openArtifact = vi.fn()

    enforceTopLevelNavigation({
      targetUrl: 'javascript:alert(1)',
      currentDocumentUrl: DEV_DOCUMENT,
      trustedDocumentUrl: DEV_DOCUMENT,
    }, { preventDefault }, { openExternal, openArtifact })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(openExternal).not.toHaveBeenCalled()
    expect(openArtifact).not.toHaveBeenCalled()
  })

  it('always denies window.open while externally opening only a strict web URL', () => {
    const openExternal = vi.fn()
    const openArtifact = vi.fn()
    const result = enforceWindowOpenPolicy(
      'https://docs.example.test/guide',
      { openExternal, openArtifact },
    )

    expect(result).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith('https://docs.example.test/guide')
    expect(openArtifact).not.toHaveBeenCalled()
  })

  it('always denies window.open while preserving the internal artifact action', () => {
    const openExternal = vi.fn()
    const openArtifact = vi.fn()
    const result = enforceWindowOpenPolicy(
      'awp://artifact/run-report.json',
      { openExternal, openArtifact },
    )

    expect(result).toEqual({ action: 'deny' })
    expect(openExternal).not.toHaveBeenCalled()
    expect(openArtifact).toHaveBeenCalledWith('run-report.json')
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,blocked',
    'file:///C:/AgentWorkflowPlatform/dist/index.html',
    ['https://user', 'secret@docs.example.test/'].join(':'),
  ])('always denies window.open with no side effect for unsafe target: %s', (targetUrl) => {
    const openExternal = vi.fn()
    const openArtifact = vi.fn()
    expect(enforceWindowOpenPolicy(targetUrl, { openExternal, openArtifact }))
      .toEqual({ action: 'deny' })
    expect(openExternal).not.toHaveBeenCalled()
    expect(openArtifact).not.toHaveBeenCalled()
  })
})
describe('installNavigationGuards', () => {
  it('registers will-navigate, will-redirect, and an always-deny window handler', () => {
    const listeners = new Map<string, NavigationEventListener>()
    const on = vi.fn((event: 'will-navigate' | 'will-redirect', listener: NavigationEventListener) => {
      listeners.set(event, listener)
    })
    let windowOpenHandler: ((details: { url: string }) => { action: 'deny' }) | undefined
    const setWindowOpenHandler = vi.fn((handler: typeof windowOpenHandler) => {
      windowOpenHandler = handler
    })
    const openExternal = vi.fn()
    const openArtifact = vi.fn()

    installNavigationGuards({
      getURL: () => DEV_DOCUMENT,
      on,
      setWindowOpenHandler,
    }, DEV_DOCUMENT, { openExternal, openArtifact })

    expect(on.mock.calls.map(([event]) => event)).toEqual(['will-navigate', 'will-redirect'])
    expect(setWindowOpenHandler).toHaveBeenCalledOnce()

    const trustedEvent = { preventDefault: vi.fn() }
    listeners.get('will-navigate')?.(trustedEvent, 'http://localhost:5173/settings')
    expect(trustedEvent.preventDefault).not.toHaveBeenCalled()

    const externalEvent = { preventDefault: vi.fn() }
    listeners.get('will-navigate')?.(externalEvent, 'https://docs.example.test/guide')
    expect(externalEvent.preventDefault).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith('https://docs.example.test/guide')

    const blockedRedirect = { preventDefault: vi.fn() }
    listeners.get('will-redirect')?.(blockedRedirect, 'javascript:alert(1)')
    expect(blockedRedirect.preventDefault).toHaveBeenCalledOnce()
    expect(openArtifact).not.toHaveBeenCalled()

    expect(windowOpenHandler?.({ url: 'http://localhost:5173/child' }))
      .toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith('http://localhost:5173/child')
    expect(windowOpenHandler?.({ url: 'data:text/html,blocked' }))
      .toEqual({ action: 'deny' })
  })
})
