/**
 * Small in-memory hand-off for detail routes.
 *
 * Route parameters stay short and opaque; the last successful dashboard
 * snapshot remains available while the app session is alive.
 */
import type { DashboardData, SessionRecord, TaskRecord } from './types';

let lastDashboard: DashboardData | null = null;

export function setLastDashboard(data: DashboardData | null): void {
  lastDashboard = data;
}

export function getTaskById(id: string): TaskRecord | undefined {
  return lastDashboard?.tasks.find((task) => task.id === id);
}

export function getSessionById(id: string): SessionRecord | undefined {
  return lastDashboard?.sessions.find((session) => session.session_id === id);
}
