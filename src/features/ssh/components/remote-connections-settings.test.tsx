// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RemoteConnectionsSettings } from "./remote-connections-settings";
import { useSshStore } from "../stores/ssh-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { ssh, type Connection, type Snapshot } from "../lib/api";

vi.mock("../lib/api", () => ({
  ssh: {
    snapshot: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    probe: vi.fn(),
    trust: vi.fn(),
    test: vi.fn(),
    associations: vi.fn(),
    associate: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("./ssh-host", () => ({ openRemoteExecution: vi.fn() }));
afterEach(cleanup);
const connection: Connection = {
  id: "prod",
  name: "Production",
  purpose: "Alerts",
  host: "192.0.2.10",
  port: 22,
  username: "deploy",
  fingerprint: "SHA256:test",
  revision: "r1",
  has_password: true,
  has_sudo_password: false,
};
const snapshot: Snapshot = {
  connections: [connection],
  approvals: [],
  authorizations: [],
  sessions: [],
  jobs: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  useSshStore.setState({ ...snapshot, selectedProject: "", loading: false, error: null });
  useProjectStore.setState({
    projects: [{ id: "project", name: "Alerts", path: "C:/project", groupId: null }],
  });
  vi.mocked(ssh.snapshot).mockResolvedValue(snapshot);
  vi.mocked(ssh.associations).mockResolvedValue([]);
  vi.mocked(ssh.save).mockResolvedValue(connection);
});
describe("SSH connection management", () => {
  it("requires an explicit confirmation before deleting saved credentials", async () => {
    render(<RemoteConnectionsSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(ssh.remove).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete connection" }));
    await waitFor(() => expect(ssh.remove).toHaveBeenCalledWith("prod"));
  });
  it("keeps credentials out of connection state and clears password fields after saving", async () => {
    render(<RemoteConnectionsSettings />);
    fireEvent.click(screen.getByText("Add SSH connection"));
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Test" } });
    fireEvent.change(screen.getByLabelText("host"), { target: { value: "192.0.2.20" } });
    fireEvent.change(screen.getByLabelText("username"), { target: { value: "deploy" } });
    fireEvent.change(screen.getByLabelText("SSH password"), {
      target: { value: "fixture-only-password" },
    });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(ssh.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Test", host: "192.0.2.20" }),
        "fixture-only-password",
        undefined,
      ),
    );
    await waitFor(() => expect(screen.queryByLabelText("SSH password")).toBeNull());
    expect(JSON.stringify(useSshStore.getState())).not.toContain("fixture-only-password");
  });
  it("removing a project association writes an exclusion without deleting the connection", async () => {
    const association = {
      project: "C:/project",
      connection_id: "prod",
      excluded: false,
      source: "auto",
      last_used_at: 1,
    };
    useSshStore.setState({ selectedProject: "C:/project" });
    vi.mocked(ssh.associations).mockResolvedValue([association]);
    vi.mocked(ssh.associate).mockImplementation(async () => {
      vi.mocked(ssh.associations).mockResolvedValue([
        { ...association, excluded: true, source: "manual" },
      ]);
    });
    render(<RemoteConnectionsSettings />);
    fireEvent.click(await screen.findByText("Remove association"));
    await waitFor(() => expect(ssh.associate).toHaveBeenCalledWith("C:/project", "prod", true));
    await screen.findByText("Excluded from automatic association");
    expect(ssh.remove).not.toHaveBeenCalled();
    expect(useSshStore.getState().connections).toHaveLength(1);
  });
  it("requires an explicit fingerprint acceptance and never trusts a fetched key automatically", async () => {
    vi.mocked(ssh.probe).mockResolvedValue("SHA256:observed");
    render(<RemoteConnectionsSettings />);
    fireEvent.click(screen.getByText("Fetch fingerprint"));
    await screen.findByText("SHA256:observed");
    expect(ssh.trust).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("I verified this fingerprint · Trust"));
    await waitFor(() => expect(ssh.trust).toHaveBeenCalledWith("prod", "SHA256:observed"));
  });
});
