import { invoke } from "@tauri-apps/api/core";

export interface Connection {
  id: string;
  name: string;
  purpose: string;
  host: string;
  port: number;
  username: string;
  fingerprint: string | null;
  revision: string;
  has_password: boolean;
  has_sudo_password: boolean;
}
export interface Identity {
  session_id: string;
  agent: string;
  project: string;
}
export interface Approval {
  id: string;
  caller: Identity;
  connection: Connection;
}
export interface RemoteSession {
  id: string;
  caller: Identity;
  connection: Connection;
}
export interface Job {
  id: string;
  remote_session: string;
  caller: Identity;
  connection_name: string;
  target: string;
  command: string;
  sudo: boolean;
  started_at: number;
  finished_at: number | null;
  status: string;
  exit_code: number | null;
  output: string;
  truncated: boolean;
}
export interface Snapshot {
  connections: Connection[];
  approvals: Approval[];
  authorizations: Approval[];
  sessions: RemoteSession[];
  jobs: Job[];
}
export interface Association {
  project: string;
  connection_id: string;
  excluded: boolean;
  source: string;
  last_used_at: number;
}
export const ssh = {
  snapshot: () => invoke<Snapshot>("ssh_snapshot"),
  clearHistory: (connectionHandle: string | null) =>
    invoke<void>("ssh_clear_history", { connectionHandle }),
  save: (
    input: Pick<Connection, "name" | "purpose" | "host" | "port" | "username"> & {
      id: string | null;
    },
    password?: string,
    sudoPassword?: string,
  ) =>
    invoke<Connection>("ssh_save", {
      input,
      password: password ?? null,
      sudoPassword: sudoPassword ?? null,
    }),
  remove: (connectionId: string) => invoke<void>("ssh_delete", { connectionId }),
  probe: (connectionId: string) => invoke<string>("ssh_probe", { connectionId }),
  trust: (connectionId: string, fingerprint: string) =>
    invoke<void>("ssh_trust", { connectionId, fingerprint }),
  test: (connectionId: string) => invoke<void>("ssh_test", { connectionId }),
  decide: (approvalId: string, allow: boolean) => invoke<void>("ssh_decide", { approvalId, allow }),
  revoke: (sessionId: string, connectionId: string) =>
    invoke<void>("ssh_revoke", { sessionId, connectionId }),
  disconnect: (connectionHandle: string) => invoke<void>("ssh_disconnect", { connectionHandle }),
  cancel: (jobId: string) => invoke<void>("ssh_cancel", { jobId }),
  associations: (project: string) => invoke<Association[]>("ssh_associations", { project }),
  associate: (project: string, connectionId: string, excluded: boolean) =>
    invoke<void>("ssh_associate", { project, connectionId, excluded }),
};
