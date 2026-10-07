import type { Association, Connection, Snapshot } from "@/features/ssh/lib/api";
import type { TypedHandlers, Unit } from "../types";
import { emit } from "@tauri-apps/api/event";

export interface SshResponses {
  ssh_snapshot: Snapshot;
  ssh_save: Connection;
  ssh_delete: Unit;
  ssh_probe: string;
  ssh_trust: Unit;
  ssh_test: Unit;
  ssh_decide: Unit;
  ssh_revoke: Unit;
  ssh_disconnect: Unit;
  ssh_cancel: Unit;
  ssh_associations: Association[];
  ssh_associate: Unit;
}
let snapshot: Snapshot = {
  connections: [],
  approvals: [],
  authorizations: [],
  sessions: [],
  jobs: [],
};
let associations: Association[] = [];
export function seedSsh(next: Snapshot) {
  snapshot = next;
  associations = [];
}
const changed = () => {
  void emit("ssh-changed", null);
};
export const sshHandlers: TypedHandlers<SshResponses> = {
  ssh_snapshot: () => snapshot,
  ssh_save: ({ input, password, sudoPassword }) => {
    const old = snapshot.connections.find((c) => c.id === input.id);
    const connection: Connection = {
      ...input,
      id: input.id ?? crypto.randomUUID(),
      fingerprint: old?.fingerprint ?? null,
      revision: crypto.randomUUID(),
      has_password: !!password || !!old?.has_password,
      has_sudo_password: sudoPassword === "" ? false : !!sudoPassword || !!old?.has_sudo_password,
    };
    snapshot.connections = [
      ...snapshot.connections.filter((c) => c.id !== connection.id),
      connection,
    ];
    changed();
    return connection;
  },
  ssh_delete: ({ connectionId }) => {
    snapshot.connections = snapshot.connections.filter((c) => c.id !== connectionId);
    changed();
  },
  ssh_probe: () => "SHA256:PREVIEW-ONLY-COMPARE-WITH-SERVER",
  ssh_trust: ({ connectionId, fingerprint }) => {
    const c = snapshot.connections.find((c) => c.id === connectionId);
    if (c) c.fingerprint = fingerprint;
    changed();
  },
  ssh_test: () => undefined,
  ssh_decide: ({ approvalId, allow }) => {
    const a = snapshot.approvals.find((a) => a.id === approvalId);
    snapshot.approvals = snapshot.approvals.filter((a) => a.id !== approvalId);
    if (allow && a) snapshot.authorizations.push(a);
    changed();
  },
  ssh_revoke: ({ sessionId, connectionId }) => {
    snapshot.authorizations = snapshot.authorizations.filter(
      (a) => a.caller.session_id !== sessionId || a.connection.id !== connectionId,
    );
    snapshot.sessions = snapshot.sessions.filter(
      (a) => a.caller.session_id !== sessionId || a.connection.id !== connectionId,
    );
    changed();
  },
  ssh_disconnect: ({ connectionHandle }) => {
    snapshot.sessions = snapshot.sessions.filter((s) => s.id !== connectionHandle);
    changed();
  },
  ssh_cancel: ({ jobId }) => {
    const j = snapshot.jobs.find((j) => j.id === jobId);
    if (j) {
      j.status = "cancelled_unknown";
      j.finished_at = Math.floor(Date.now() / 1000);
    }
    changed();
  },
  ssh_associations: ({ project }) => associations.filter((a) => a.project === project),
  ssh_associate: ({ project, connectionId, excluded }) => {
    associations = [
      ...associations.filter((a) => a.project !== project || a.connection_id !== connectionId),
      { project, connection_id: connectionId, excluded, source: "manual", last_used_at: 0 },
    ];
    changed();
  },
};
