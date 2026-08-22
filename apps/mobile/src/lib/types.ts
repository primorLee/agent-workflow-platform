/** Public wire shapes used by the local Agent Workflow Platform control plane. */
export type JsonRecord = Record<string, unknown>;

export type ControlPlaneHealth = {
  status: string;
  database?: string;
  broker?: unknown;
};

export type TaskRecord = {
  id: string;
  task_type: string;
  payload: JsonRecord;
  status: string;
  result?: unknown;
  error?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type SessionRecord = {
  session_id: string;
  session_type: string;
  status: string;
  metadata: JsonRecord;
  created_at?: string | null;
  last_heartbeat?: string | null;
};

export type DashboardData = {
  health: ControlPlaneHealth;
  tasks: TaskRecord[];
  sessions: SessionRecord[];
  fetchedAt: string;
};
