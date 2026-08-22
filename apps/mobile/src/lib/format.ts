/** Defensive formatting helpers for control-plane wire data. */
import type { TaskRecord } from './types';

export function truncate(value: string | null | undefined, length: number): string {
  const text = (value ?? '').trim();
  if (text.length <= length) return text;
  return `${text.slice(0, length).trimEnd()}…`;
}

export function shortId(value: string | null | undefined, length = 8): string {
  const text = String(value ?? '');
  return text ? text.slice(0, length) : '—';
}

export function fmtTime(value: string | null | undefined): string {
  const text = (value ?? '').trim();
  if (!text) return '';
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toLocaleString();
}

export function prettyJson(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function taskStatusCounts(tasks: TaskRecord[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const status = task.status || 'unknown';
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const order = ['running', 'pending', 'success', 'failed', 'cancelled', 'unknown'];
  return [...counts.entries()].sort(([a], [b]) => {
    const left = order.indexOf(a.toLowerCase());
    const right = order.indexOf(b.toLowerCase());
    if (left === -1 && right === -1) return a.localeCompare(b);
    if (left === -1) return 1;
    if (right === -1) return -1;
    return left - right;
  });
}

export function taskSummary(task: TaskRecord): string {
  const payload = task.payload;
  const label =
    typeof payload.description === 'string'
      ? payload.description
      : typeof payload.prompt === 'string'
        ? payload.prompt
        : typeof payload.command === 'string'
          ? payload.command
          : prettyJson(payload);
  return truncate(label, 180) || '无负载摘要';
}
