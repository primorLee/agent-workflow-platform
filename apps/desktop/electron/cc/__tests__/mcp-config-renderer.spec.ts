import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildMcpConfig, renderMcpConfig } from '../mcp-config-renderer'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'awp-mcp-config-'))
  delete process.env.AWP_AGENT_REMOTE_MCP_OPT_IN
})

afterEach(() => {
  delete process.env.AWP_AGENT_REMOTE_MCP_OPT_IN
  rmSync(dir, { recursive: true, force: true })
})

describe('mcp-config-renderer public boundary', () => {
  it('has no network MCP entry by default', () => {
    expect(buildMcpConfig()).toEqual({ mcpServers: {} })
  })

  it('renders only the explicitly supplied loopback awp-ide endpoint', () => {
    const doc = buildMcpConfig({
      awpIde: {
        url: 'http://127.0.0.1:43125/mcp',
        token: 'local-test-token',
        conversationId: 'conv-1',
      },
    })

    expect(Object.keys(doc.mcpServers)).toEqual(['awp-ide'])
    expect(doc.mcpServers['awp-ide']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:43125/mcp',
      headers: {
        authorization: 'Bearer local-test-token',
        'x-awp-conv': 'conv-1',
      },
    })
  })

  it.each([
    'https://remote.example.test/mcp',
    'http://192.0.2.10/mcp',
  ])('rejects a non-loopback awp-ide endpoint: %s', (url) => {
    expect(() => buildMcpConfig({ awpIde: { url } })).toThrow(
      'awp_ide_must_be_loopback',
    )
  })

  it('rejects a remote MCP when the operator opt-in is absent', () => {
    expect(() =>
      buildMcpConfig({
        allowRemoteMcp: true,
        remoteMcp: {
          name: 'explicit-remote',
          url: 'https://mcp.example.test/rpc',
        },
      }),
    ).toThrow('remote_mcp_requires_explicit_opt_in')
  })

  it('requires caller and operator opt-in for a remote MCP', () => {
    process.env.AWP_AGENT_REMOTE_MCP_OPT_IN = '1'

    expect(() =>
      buildMcpConfig({
        remoteMcp: {
          name: 'explicit-remote',
          url: 'https://mcp.example.test/rpc',
        },
      }),
    ).toThrow('remote_mcp_requires_explicit_opt_in')

    const doc = buildMcpConfig({
      allowRemoteMcp: true,
      remoteMcp: {
        name: 'explicit-remote',
        url: 'https://mcp.example.test/rpc',
        token: 'explicit-test-token',
      },
    })
    expect(Object.keys(doc.mcpServers)).toEqual(['explicit-remote'])
    expect(doc.mcpServers['explicit-remote'].headers.authorization).toBe(
      'Bearer explicit-test-token',
    )
  })

  it('requires HTTPS for a non-loopback remote MCP endpoint', () => {
    process.env.AWP_AGENT_REMOTE_MCP_OPT_IN = '1'
    expect(() =>
      buildMcpConfig({
        allowRemoteMcp: true,
        remoteMcp: {
          name: 'remote',
          url: 'http://mcp.example.test/rpc',
        },
      }),
    ).toThrow('remote_mcp_requires_https')
  })

  it('rejects URL credentials and a remote name that shadows awp-ide', () => {
    process.env.AWP_AGENT_REMOTE_MCP_OPT_IN = '1'
    expect(() =>
      buildMcpConfig({
        allowRemoteMcp: true,
        remoteMcp: {
          name: 'awp-ide',
          url: 'https://mcp.example.test/rpc',
        },
      }),
    ).toThrow('invalid_remote_mcp_name')

    expect(() =>
      buildMcpConfig({
        allowRemoteMcp: true,
        remoteMcp: {
          name: 'remote',
          url: ['https://', 'user', ':', 'pass', '@mcp.example.test/rpc'].join(''),
        },
      }),
    ).toThrow('mcp_url_credentials_forbidden')
  })

  it('atomically writes a complete owner-only config', () => {
    const outputPath = path.join(dir, 'nested', 'agent-mcp.json')
    const result = renderMcpConfig({
      outputPath,
      awpIde: {
        url: 'http://[::1]:43125/mcp',
        token: 'local-test-token',
      },
    })

    expect(result.path).toBe(outputPath)
    expect(JSON.parse(readFileSync(outputPath, 'utf-8'))).toEqual(
      buildMcpConfig({
        awpIde: {
          url: 'http://[::1]:43125/mcp',
          token: 'local-test-token',
        },
      }),
    )

    renderMcpConfig({
      outputPath,
      awpIde: {
        url: 'http://127.0.0.1:43126/mcp',
        token: 'rotated-local-token',
      },
    })
    expect(JSON.parse(readFileSync(outputPath, 'utf-8'))).toEqual(
      buildMcpConfig({
        awpIde: {
          url: 'http://127.0.0.1:43126/mcp',
          token: 'rotated-local-token',
        },
      }),
    )
    expect(readdirSync(path.dirname(outputPath)).some((name) => name.endsWith('.tmp'))).toBe(false)
  })
})
