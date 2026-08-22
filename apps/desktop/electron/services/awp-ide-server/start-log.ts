export interface AwpIdeStartLogInput {
  url: string
  port: number
}

/** Format startup telemetry without exposing endpoint, lock, or profile paths. */
export function formatAwpIdeStartedLog(input: AwpIdeStartLogInput): string {
  const hostFamily = input.url.startsWith('http://[') ? 'ipv6' : 'ipv4'
  const port = Number.isInteger(input.port) && input.port >= 1 && input.port <= 65_535
    ? input.port
    : 'unknown'
  return `[awp-ide] started=true host_family=${hostFamily} port=${port}`
}
