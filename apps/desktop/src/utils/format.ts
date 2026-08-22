export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return `${mins}m ${secs}s`
}

export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - date.getTime()

  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

export function truncateId(id: string, len = 8): string {
  return id.length > len ? id.substring(0, len) : id
}

export function formatNumber(n: number, decimals = 3): string {
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(decimals)}M`
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(decimals)}k`
  if (Math.abs(n) < 0.01 && n !== 0) return n.toExponential(decimals)
  return n.toFixed(decimals)
}
