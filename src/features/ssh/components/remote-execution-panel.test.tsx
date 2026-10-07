// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RemoteExecutionPanel } from "./remote-execution-panel";
import { useSshStore } from "../stores/ssh-store";
import { ssh, type Approval, type Job, type Snapshot } from "../lib/api";

vi.mock("../lib/api", () => ({
  ssh: { snapshot: vi.fn(), disconnect: vi.fn(), revoke: vi.fn(), cancel: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const grant: Approval = {
  id: "grant",
  caller: { session_id: "session-one", agent: "Claude Code", project: "C:/project" },
  connection: {
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
  },
};
let snapshot: Snapshot;
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  snapshot = {
    connections: [grant.connection],
    approvals: [],
    authorizations: [grant],
    sessions: [{ id: "ssh-one", caller: grant.caller, connection: grant.connection }],
    jobs: [],
  };
  useSshStore.setState({ ...snapshot, loading: false, error: null });
  vi.mocked(ssh.snapshot).mockImplementation(async () => snapshot);
});

it("shows one card and keeps authorization visible after disconnecting", async () => {
  vi.mocked(ssh.disconnect).mockImplementation(async () => {
    snapshot = { ...snapshot, sessions: [] };
  });
  vi.mocked(ssh.revoke).mockImplementation(async () => {
    snapshot = { ...snapshot, authorizations: [] };
  });
  render(<RemoteExecutionPanel />);
  expect(screen.getAllByRole("group")).toHaveLength(1);
  expect(screen.getByText("Authorized · Connected")).toBeTruthy();
  expect(screen.getByText("deploy@192.0.2.10:22")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect Production" }));
  await waitFor(() => expect(screen.getByText("Authorized · Not connected")).toBeTruthy());
  expect(ssh.disconnect).toHaveBeenCalledWith("ssh-one");
  expect(ssh.revoke).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Disconnect Production" })).toBeNull();
  expect(screen.queryByText(/No authorized SSH connections/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Revoke authorization for Production" }));
  await waitFor(() => expect(screen.queryByRole("group")).toBeNull());
  expect(ssh.revoke).toHaveBeenCalledWith("session-one", "prod");
  expect(screen.getByText(/No authorized SSH connections/)).toBeTruthy();
});

it("keeps separate agent sessions on the same server distinct", () => {
  const second = {
    ...grant,
    id: "grant-two",
    caller: { ...grant.caller, session_id: "session-two", agent: "Codex" },
  };
  useSshStore.setState({ authorizations: [grant, second] });
  render(<RemoteExecutionPanel />);
  const firstCard = screen.getByRole("group", { name: "Production · Claude Code · session-" });
  const secondCard = screen.getByRole("group", { name: "Production · Codex · session-" });
  expect(within(firstCard).getByText("Authorized · Connected")).toBeTruthy();
  expect(within(secondCard).getByText("Authorized · Not connected")).toBeTruthy();
  expect(within(secondCard).queryByRole("button", { name: "Disconnect Production" })).toBeNull();
});

const command = (id: string, started_at: number, output: string): Job => ({
  id,
  remote_session: "ssh-one",
  caller: grant.caller,
  connection_name: "Production",
  target: "deploy@192.0.2.10:22",
  command: `echo ${id}`,
  sudo: false,
  started_at,
  finished_at: started_at + 1,
  status: "succeeded",
  exit_code: 0,
  output,
  truncated: false,
});

it("displays every command chronologically and updates output without hiding history", () => {
  const first = command("first", 10, "first output");
  const second = command("second", 20, "second output");
  useSshStore.setState({ jobs: [second, first] });
  render(<RemoteExecutionPanel />);
  expect(screen.getAllByRole("article").map((e) => e.getAttribute("aria-label"))).toEqual([
    "Command: echo first",
    "Command: echo second",
  ]);
  expect(screen.getAllByLabelText("Remote command output").map((e) => e.textContent)).toEqual([
    "first output",
    "second output",
  ]);
  const third = {
    ...command("third", 30, "streaming…"),
    status: "running",
    finished_at: null,
    exit_code: null,
  };
  act(() => useSshStore.setState({ jobs: [third, second, first] }));
  act(() =>
    useSshStore.setState({
      jobs: [{ ...third, output: "streaming…\nmore output" }, second, first],
    }),
  );
  expect(screen.getAllByRole("article")).toHaveLength(3);
  expect(screen.getByText("first output")).toBeTruthy();
  expect(
    screen.getByText("streaming…\nmore output", { exact: true, normalizer: (v) => v }),
  ).toBeTruthy();
  expect(
    screen.getByRole("article", { name: "Command: echo third" }).querySelector("pre")?.textContent,
  ).toBe("deploy@192.0.2.10:22 $ echo third");
});

it("retains per-command stop controls, output limits and unknown-outcome warnings", async () => {
  const running = {
    ...command("running", 10, "working"),
    status: "running",
    finished_at: null,
    exit_code: null,
  };
  const unknown = {
    ...command("unknown", 20, "partial output"),
    status: "timeout_unknown",
    truncated: true,
    exit_code: null,
  };
  useSshStore.setState({ jobs: [unknown, running] });
  render(<RemoteExecutionPanel />);
  fireEvent.click(screen.getByRole("button", { name: "Stop command: echo running" }));
  expect(ssh.cancel).toHaveBeenCalledWith("running");
  expect(screen.getByText(/Output capped at 1 MiB/)).toBeTruthy();
  expect(screen.getByText(/Remote side effects may have occurred/)).toBeTruthy();
  await waitFor(() => expect(ssh.snapshot).toHaveBeenCalled());
});

it("follows output unless the reader scrolls up, and can resume following", () => {
  const job = command("first", 10, "output");
  useSshStore.setState({ jobs: [job] });
  render(<RemoteExecutionPanel />);
  const history = screen.getByRole("region", { name: "Remote command history" });
  let height = 1000;
  Object.defineProperties(history, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, value: 200 },
  });
  act(() => useSshStore.setState({ jobs: [{ ...job, output: "new output" }] }));
  expect(history.scrollTop).toBe(1000);
  history.scrollTop = 100;
  fireEvent.scroll(history);
  height = 1400;
  act(() => useSshStore.setState({ jobs: [{ ...job, output: "more output" }] }));
  expect(history.scrollTop).toBe(100);
  fireEvent.click(screen.getByRole("button", { name: "Latest output ↓" }));
  expect(history.scrollTop).toBe(1400);
  expect(screen.queryByRole("button", { name: "Latest output ↓" })).toBeNull();
});
