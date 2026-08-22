/**
 * Thin, defensive client for the public local control plane.
 *
 * The mobile shell intentionally uses only documented generic endpoints:
 * readiness, tasks, and sessions. It does not depend on a hosted account.
 */
import type {
  ControlPlaneHealth,
  DashboardData,
  JsonRecord,
  SessionRecord,
  TaskRecord,
} from './types';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const TIMEOUT_MS = 15_000;
export const FALLBACK_BASE_URL = 'http://127.0.0.1:8100';

export function normalizeBaseUrl(baseUrl: string): string {
  const raw = baseUrl || FALLBACK_BASE_URL;
  if (
    raw.length > 2_048 ||
    raw !== raw.trim() ||
    /[\s\u0000-\u001f\u007f\\%]/u.test(raw)
  ) {
    throw new ApiError(0, 'control-plane 地址无效');
  }

  const authorityMatch = /^(https?):\/\/([^/]+)\/?$/iu.exec(raw);
  if (!authorityMatch) {
    throw new ApiError(0, 'control-plane 地址必须是独立的 HTTP(S) origin');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ApiError(0, 'control-plane 地址无效');
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/' ||
    (parsed.port && (!/^\d{1,5}$/u.test(parsed.port) || Number(parsed.port) < 1))
  ) {
    throw new ApiError(0, 'control-plane 地址必须是独立的 HTTP(S) origin');
  }

  if (parsed.protocol === 'http:') {
    const authority = authorityMatch[2];
    const explicitLoopback = /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/iu.test(authority)
      || /^\[::1\](?::\d{1,5})?$/u.test(authority);
    if (!explicitLoopback) {
      throw new ApiError(0, '非本机 control-plane 必须使用 HTTPS');
    }
  }

  return parsed.origin;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function optionalText(value: unknown): string | null | undefined {
  if (value == null) return value as null | undefined;
  return typeof value === 'string' ? value : String(value);
}

function normalizeTask(value: unknown, index: number): TaskRecord {
  const row = asRecord(value);
  return {
    id: text(row.id ?? row.task_id, `task-${index + 1}`),
    task_type: text(row.task_type ?? row.type, 'task'),
    payload: asRecord(row.payload),
    status: text(row.status, 'unknown'),
    result: row.result,
    error: optionalText(row.error),
    created_at: optionalText(row.created_at),
    updated_at: optionalText(row.updated_at),
  };
}

function normalizeSession(value: unknown, index: number): SessionRecord {
  const row = asRecord(value);
  return {
    session_id: text(row.session_id ?? row.id, `session-${index + 1}`),
    session_type: text(row.session_type ?? row.type, 'interactive'),
    status: text(row.status, 'unknown'),
    metadata: asRecord(row.metadata),
    created_at: optionalText(row.created_at),
    last_heartbeat: optionalText(row.last_heartbeat),
  };
}

function messageForStatus(status: number, body: string): string {
  if (status === 401) return '开发密钥无效，请检查设置';
  if (status === 403) return '当前密钥没有访问权限';
  if (status === 404) return '接口不存在，请确认 control-plane 版本';
  if (status === 503) return 'control-plane 尚未就绪';
  if (status >= 500) return `control-plane 错误（${status}）`;
  return `请求失败（${status}）${body ? `：${body.slice(0, 120)}` : ''}`;
}

async function requestJson(
  baseUrl: string,
  path: string,
  token: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token.trim()) headers.Authorization = `Bearer ${token.trim()}`;
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch {
        // Error bodies are optional.
      }
      throw new ApiError(response.status, messageForStatus(response.status, body));
    }
    try {
      return await response.json();
    } catch {
      throw new ApiError(response.status, 'control-plane 返回了无效 JSON');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new ApiError(
      0,
      aborted ? '请求超时，请检查地址与网络' : '无法连接 control-plane，请检查地址与网络',
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchHealth(baseUrl: string): Promise<ControlPlaneHealth> {
  const raw = asRecord(await requestJson(baseUrl, '/v1/health/ready', ''));
  return {
    status: text(raw.status, 'unknown'),
    database: optionalText(raw.database) ?? undefined,
    broker: raw.broker,
  };
}

export async function fetchTasks(baseUrl: string, token: string): Promise<TaskRecord[]> {
  const raw = await requestJson(baseUrl, '/v1/tasks', token);
  const rows = Array.isArray(raw) ? raw : asRecord(raw).tasks;
  if (!Array.isArray(rows)) throw new ApiError(200, '任务列表响应格式不正确');
  return rows.map(normalizeTask);
}

export async function fetchSessions(baseUrl: string, token: string): Promise<SessionRecord[]> {
  const raw = await requestJson(baseUrl, '/v1/sessions', token);
  const rows = Array.isArray(raw) ? raw : asRecord(raw).sessions;
  if (!Array.isArray(rows)) throw new ApiError(200, '会话列表响应格式不正确');
  return rows.map(normalizeSession);
}

export async function fetchDashboard(
  baseUrl: string,
  token: string,
): Promise<DashboardData> {
  const [health, tasks, sessions] = await Promise.all([
    fetchHealth(baseUrl),
    fetchTasks(baseUrl, token),
    fetchSessions(baseUrl, token),
  ]);
  return {
    health,
    tasks,
    sessions,
    fetchedAt: new Date().toISOString(),
  };
}
