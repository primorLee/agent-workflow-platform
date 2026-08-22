import { describe, expect, it } from 'vitest'
import { formatAwpIdeStartedLog } from '../awp-ide-server/start-log'

describe('awp-ide startup log', () => {
  it('records only structural state for IPv4 and IPv6 endpoints', () => {
    expect(formatAwpIdeStartedLog({
      url: 'http://127.0.0.1:43123/mcp',
      port: 43123,
    })).toBe('[awp-ide] started=true host_family=ipv4 port=43123')
    expect(formatAwpIdeStartedLog({
      url: 'http://[::1]:43124/mcp',
      port: 43124,
    })).toBe('[awp-ide] started=true host_family=ipv6 port=43124')
  })

  it('does not echo endpoint, lock, profile, query, or fragment values', () => {
    const privateFixture = 'private-profile-fixture'
    const rendered = formatAwpIdeStartedLog({
      url: `http://127.0.0.1:43123/mcp?value=${privateFixture}#${privateFixture}`,
      port: 43123,
      lockPath: privateFixture,
      profilePath: privateFixture,
    } as never)
    expect(rendered).toBe('[awp-ide] started=true host_family=ipv4 port=43123')
    expect(rendered).not.toContain(privateFixture)
    expect(rendered).not.toContain('http://')
  })
})
