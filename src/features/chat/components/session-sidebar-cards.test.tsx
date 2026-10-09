// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionSidebar } from "./session-sidebar";
import { useChatStore } from "../stores/chat-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import {
  archiveThread,
  deleteThread,
  threadProjects,
  type ThreadProject,
  type ThreadRow,
} from "../lib/history-api";
import { resumeThreadFast } from "../lib/resume-session";

const context = vi.hoisted(() => ({ cwd: "/repo/atlas" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@/features/app/stores/app-store", () => ({
  useAppStore: { use: { currentProject: () => (context.cwd ? { path: context.cwd } : null) } },
}));
vi.mock("@/features/projects/stores/project-store", () => ({
  useProjectStore: { use: { activeProjectId: () => null } },
}));
vi.mock("@/features/projects/lib/project-scope", () => ({ useLocalProjects: () => [] }));
vi.mock("@/features/keybindings/lib/use-action-shortcut", () => ({
  useActionShortcut: () => null,
}));
vi.mock("../lib/open-agent-session", () => ({ openNewAgentChat: vi.fn() }));
vi.mock("../lib/agents-api", () => ({ agents: {}, getAgentSync: () => undefined }));
vi.mock("../lib/history-api", () => ({
  syncProjectThreads: vi.fn(async () => 0),
  threadProjects: vi.fn(),
  archiveThread: vi.fn(async () => undefined),
  deleteThread: vi.fn(async () => undefined),
  onThreadsChanged: vi.fn(async () => () => {}),
}));
vi.mock("../lib/resume-session", () => ({
  resumeThreadFast: vi.fn(),
  ResumeError: class extends Error {},
}));
vi.mock("./thread-history-view", () => ({ ThreadHistoryView: () => null }));

function row(id: string, title: string, projectName = "atlas"): ThreadRow {
  return {
    threadId: id,
    sessionId: `session-${id}`,
    agentId: "codex-acp",
    title,
    projectName,
    folderPaths: [`/repo/${projectName}`],
    updatedAt: new Date().toISOString(),
    createdAt: null,
    archived: false,
  };
}
function project(name: string, threads: ThreadRow[], isCurrent = true): ThreadProject {
  return { name, paths: [`/repo/${name}`], isCurrent, threads };
}
const clients: QueryClient[] = [];
function mount(variant: "sidebar" | "dropdown" = "dropdown", onOpened = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <SessionSidebar tabId="current" variant={variant} onOpened={onOpened} />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  context.cwd = "/repo/atlas";
  localStorage.clear();
  useChatStore.setState({ sessions: {}, activeSessionId: null });
  useLayoutStore.setState({
    tabs: [],
    activeTabId: null,
    activeByGroup: { main: null },
    chatSidebar: { visible: true, width: 240 },
  });
  const { addTab } = useLayoutStore.getState().actions;
  addTab({ id: "current", type: "chat", title: "Current", closable: true, dirty: false, data: {} });
  useChatStore.getState().actions.createSession("current", "codex");
  vi.mocked(threadProjects).mockResolvedValue([
    project("atlas", [row("one", "Fix model selection")]),
  ]);
  vi.mocked(resumeThreadFast).mockImplementation(() => new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  useChatStore.setState({ sessions: {}, activeSessionId: null });
});

describe("history card integration", () => {
  it("uses the thread's recorded branch rather than the open project's state", async () => {
    vi.mocked(threadProjects).mockResolvedValue([
      project("atlas", [{ ...row("one", "Fix model selection"), branch: "recorded-branch" }]),
    ]);
    mount();
    expect(await screen.findByTitle("Last recorded branch: recorded-branch")).toBeTruthy();
  });

  it.each(["sidebar", "dropdown"] as const)(
    "shows cards, waiting status and title search in the %s",
    async (variant) => {
      const { setAcpBinding, updateSessionStatus } = useChatStore.getState().actions;
      setAcpBinding("current", "agent", "session-one", "/repo/atlas");
      updateSessionStatus("current", "waiting");
      mount(variant);
      expect(await screen.findByRole("button", { name: "Fix model selection" })).toBeTruthy();
      expect(screen.getByText("Needs input")).toBeTruthy();
      fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), {
        target: { value: "unmatched" },
      });
      expect(screen.getByText("No sessions match your search.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Fix model selection" })).toBeNull();
    },
  );

  it("reports a read failure instead of an empty history or retries", async () => {
    vi.mocked(threadProjects).mockRejectedValue(new Error("Database unavailable"));
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain("Database unavailable");
    expect(screen.queryByText("No chats in this project yet.")).toBeNull();
    expect(threadProjects).toHaveBeenCalledTimes(1);
  });

  it("shows the empty-project hint only after a successful empty read", async () => {
    vi.mocked(threadProjects).mockResolvedValue([]);
    mount();
    expect(await screen.findByText("No chats in this project yet.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a project's heading when search removes its first row", async () => {
    context.cwd = "";
    vi.mocked(threadProjects).mockResolvedValue([
      project("atlas", [row("one", "Keep atlas")], false),
      project("docs", [row("two", "Hidden", "docs"), row("three", "Keep docs", "docs")], false),
    ]);
    mount();
    await screen.findByRole("button", { name: "Keep docs" });
    fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), {
      target: { value: "Keep" },
    });
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "atlas",
      "docs",
    ]);
    expect(screen.queryByRole("button", { name: "Hidden" })).toBeNull();
  });

  it("focuses an existing live tab without resuming it again", async () => {
    useLayoutStore.getState().actions.addTab({
      id: "existing",
      type: "chat",
      title: "Existing",
      closable: true,
      dirty: false,
      data: {},
    });
    useChatStore.getState().actions.createSession("existing", "codex");
    useChatStore
      .getState()
      .actions.setAcpBinding("existing", "agent", "session-one", "/repo/atlas");
    const onOpened = vi.fn();
    mount("dropdown", onOpened);
    fireEvent.click(await screen.findByRole("button", { name: "Fix model selection" }));
    expect(useLayoutStore.getState().activeTabId).toBe("existing");
    expect(resumeThreadFast).not.toHaveBeenCalled();
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it("opens another tab when the current one is busy and uses the recorded directory", async () => {
    const { setAcpBinding, updateSessionStatus } = useChatStore.getState().actions;
    setAcpBinding("current", "agent", "in-flight", "/repo/atlas");
    updateSessionStatus("current", "running");
    vi.mocked(threadProjects).mockResolvedValue([
      project("docs", [row("one", "Fix model selection", "docs")], false),
    ]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Fix model selection" }));
    await waitFor(() => expect(resumeThreadFast).toHaveBeenCalled());
    expect(resumeThreadFast).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "one", cwd: "/repo/docs", sessionId: "session-one" }),
    );
    expect(useLayoutStore.getState().activeTabId).not.toBe("current");
    expect(useChatStore.getState().sessions.current.acpSessionId).toBe("in-flight");
    expect(useChatStore.getState().sessions.current.status).toBe("running");
  });

  it("routes archive and delete through existing APIs without opening the conversation", async () => {
    const onOpened = vi.fn();
    mount("dropdown", onOpened);
    await screen.findByRole("button", { name: "Fix model selection" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive session" }));
    });
    expect(archiveThread).toHaveBeenCalledWith("one");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete session" }));
    });
    expect(deleteThread).toHaveBeenCalledWith("one");
    expect(resumeThreadFast).not.toHaveBeenCalled();
    expect(onOpened).not.toHaveBeenCalled();
    expect(within(document.body).queryByRole("alert")).toBeNull();
  });
});
