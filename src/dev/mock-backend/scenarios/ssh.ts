import type { Scenario } from "../types";
import type { Snapshot } from "@/features/ssh/lib/api";
import { seedSsh } from "../fixtures/ssh";
import { emit } from "@tauri-apps/api/event";
import { MOCK_PROJECT } from "../project";

const connection = {
  id: "demo-production",
  name: "FeishuChat production",
  purpose: "Alert delivery service · production",
  host: "192.0.2.10",
  port: 22,
  username: "deploy",
  fingerprint: "SHA256:PREVIEW-ONLY",
  revision: "demo-r1",
  has_password: true,
  has_sudo_password: false,
};
const caller = { session_id: "preview-session", agent: "Claude Code", project: MOCK_PROJECT.path };
const data: Snapshot = {
  connections: [
    connection,
    {
      ...connection,
      id: "demo-test",
      name: "Shared test server",
      host: "192.0.2.20",
      purpose: "Integration testing",
      fingerprint: null,
    },
  ],
  approvals: [],
  authorizations: [{ id: "demo-grant", caller, connection }],
  sessions: [{ id: "demo-ssh", caller, connection }],
  jobs: [
    {
      id: "demo-job",
      remote_session: "demo-ssh",
      caller,
      connection_name: connection.name,
      target: `${connection.username}@${connection.host}:${connection.port}`,
      command: "cd /opt/feishuchat && npm run build",
      sudo: false,
      started_at: 1791316800,
      finished_at: 1791316832,
      status: "succeeded",
      exit_code: 0,
      output:
        "> feishuchat build\n> tsc\n\nBuild completed successfully.\nAuthentication material: [REDACTED]\n",
      truncated: false,
    },
    {
      id: "demo-hostname",
      remote_session: "demo-ssh",
      caller,
      connection_name: connection.name,
      target: `${connection.username}@${connection.host}:${connection.port}`,
      command: "hostname",
      sudo: false,
      started_at: 1791316770,
      finished_at: 1791316771,
      status: "succeeded",
      exit_code: 0,
      output: "production-01\n",
      truncated: false,
    },
    {
      id: "demo-whoami",
      remote_session: "demo-ssh",
      caller,
      connection_name: connection.name,
      target: `${connection.username}@${connection.host}:${connection.port}`,
      command: "whoami",
      sudo: false,
      started_at: 1791316760,
      finished_at: 1791316761,
      status: "succeeded",
      exit_code: 0,
      output: "deploy\n",
      truncated: false,
    },
  ],
};
export const sshScenario: Scenario = {
  name: "ssh",
  description:
    "SSH connection management, approvals and remote command output (synthetic preview).",
  init: () => seedSsh(structuredClone(data)),
  setup: async () => {
    const { openSettingsSection } = await import("@/features/settings/lib/open-settings");
    openSettingsSection("remote");
  },
  actions: {
    execution: async () => {
      const { openRemoteExecution } = await import("@/features/ssh/components/ssh-host");
      openRemoteExecution();
    },
    requestAccess: () => {
      seedSsh({
        ...structuredClone(data),
        approvals: [{ id: "demo-request", caller, connection }],
      });
      void emit("ssh-changed", null);
    },
  },
};
