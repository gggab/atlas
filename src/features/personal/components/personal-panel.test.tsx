// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PersonalSnapshot } from "../lib/personal-api";
import type { ImageAttachment } from "@/types/agents";

const backend = vi.hoisted(() => ({
  invoke: vi.fn(),
  data: null as PersonalSnapshot | null,
  events: new Map<string, () => void>(),
  attachments: undefined as ImageAttachment[] | undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: backend.invoke,
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: () => void) => {
    backend.events.set(name, handler);
    return () => {
      backend.events.delete(name);
    };
  }),
}));
vi.mock("@/features/chat/components/chat-panel", () => ({
  ChatPanel: ({
    tabId,
    personal,
  }: {
    tabId: string;
    personal: {
      messages: { id: string; role: string; content: string }[];
      busy: boolean;
      onRememberMessage: (id: string) => void;
      onSend: (text: string, mentions: [], attachments?: ImageAttachment[]) => Promise<void>;
      actions: import("react").ReactNode;
      notice: import("react").ReactNode;
    };
  }) => {
    const text = useChatStore((state) => state.drafts[tabId] ?? "");
    const ready = useChatStore((state) => !!state.sessions[tabId]);
    return (
      <div data-testid="shared-agent-chat">
        {personal.actions}
        {personal.notice}
        {personal.messages.map((message) => (
          <div key={message.id}>
            <p>{message.content}</p>
            {message.role === "user" && (
              <button onClick={() => personal.onRememberMessage(message.id)}>保存为个人记忆</button>
            )}
          </div>
        ))}
        <textarea
          aria-label="给个人助手的消息"
          value={text}
          onChange={(event) => useChatStore.getState().actions.setDraft(tabId, event.target.value)}
        />
        <button
          disabled={personal.busy || !ready}
          onClick={() => void personal.onSend(text, [], backend.attachments)}
        >
          发送
        </button>
      </div>
    );
  },
}));
vi.mock("@/features/agents/lib/agent-meta", async (original) => ({
  ...(await original<typeof import("@/features/agents/lib/agent-meta")>()),
  useSwitchableAgents: () => ["claude-code"],
}));
vi.mock("@/features/chat/lib/agents-api", async (original) => ({
  ...(await original<typeof import("@/features/chat/lib/agents-api")>()),
  ensureAgent: vi.fn(async () => ({ agent_id: "agent-a" })),
}));

import { PersonalPanel } from "./personal-panel";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useTaskCenter } from "@/features/tasks/stores/task-center-store";

function renderPanel() {
  const view = render(<PersonalPanel tabId="personal" />);
  fireEvent.click(screen.getByRole("button", { name: "记忆与计划" }));
  return view;
}

beforeEach(() => {
  localStorage.clear();
  backend.attachments = undefined;
  backend.events.clear();
  useChatStore.setState({
    sessions: {},
    queues: {},
    pendingPermissions: {},
    drafts: {},
  });
  useTaskCenter.setState({ open: false, selectedId: null });
  backend.data = {
    directory: "C:/personal",
    currentThreadId: null,
    conversations: [],
    history: [],
    memories: [],
    memoryCandidates: [],
    proposals: [],
  };
  backend.invoke.mockReset();
  backend.invoke.mockImplementation(async (command: string) => {
    if (command === "personal_snapshot") return backend.data;
    if (command === "tasks_snapshot") return { tasks: [], notifications: [] };
    if (command === "personal_session")
      return {
        key: { agent_id: "agent-a", session_id: "session-a" },
        directory: "C:/personal",
        contextRestarted: false,
        toolsAvailable: true,
        snapshot: {
          plugin_id: "claude-code-ts",
          status: "idle",
          messages: [],
          plan: [],
          current_mode: "default",
          available_modes: [],
        },
      };
    if (command === "agents_snapshot")
      return {
        plugin_id: "claude-code-ts",
        status: "idle",
        messages: [],
        plan: [],
      };
    if (command === "agents_replay_transcript") return [];
    if (command === "agents_send")
      return {
        sourceMessageId: "human-a",
        context: "Application data: rent reminder",
      };
    if (command === "personal_confirm_proposal") return { id: "registered", state: "active" };
    return null;
  });
});
afterEach(cleanup);

describe("personal assistant", () => {
  it("uses the shared Agents chat and keeps personal details collapsed by default", async () => {
    render(<PersonalPanel tabId="personal" />);
    await screen.findByTestId("shared-agent-chat");
    expect(screen.queryByLabelText("个人记忆和计划")).toBeNull();
    expect(screen.getByRole("button", { name: "记忆与计划" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "记忆与计划" }));
    expect(screen.getByLabelText("个人记忆和计划")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "记忆与计划" }));
    expect(screen.queryByLabelText("个人记忆和计划")).toBeNull();
  });

  it("shows a persisted reminder receipt and opens the exact task in task center", async () => {
    const original = backend.invoke.getMockImplementation()!;
    let saved = false;
    backend.invoke.mockImplementation(async (...args) => {
      if (args[0] === "agents_send") saved = true;
      if (args[0] === "tasks_snapshot")
        return {
          tasks: saved
            ? [
                {
                  id: "weekly-report",
                  revision: 1,
                  state: "active",
                  nextCheckAt: Date.UTC(2026, 9, 22, 8, 30),
                  input: {
                    kind: "reminder",
                    title: "周报",
                    sourceThreadId: "new-thread",
                  },
                },
              ]
            : [],
          notifications: [],
        };
      if (args[0] === "personal_snapshot" && saved)
        return {
          ...backend.data!,
          conversations: [
            {
              threadId: "new-thread",
              sessionId: "session-a",
              agent: "claude-code-ts",
            },
          ],
        };
      return original(...args);
    });
    renderPanel();
    await waitFor(() => expect(useChatStore.getState().sessions.personal).toBeTruthy());
    fireEvent.change(screen.getByLabelText("给个人助手的消息"), {
      target: { value: "每周四12点前写周报" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(saved).toBe(true));
    backend.events.get("atlas:tasks-changed")?.();
    await screen.findByText(/提醒已登记：周报/);
    fireEvent.click(screen.getByRole("button", { name: "查看任务" }));
    expect(useTaskCenter.getState().selectedId).toBe("weekly-report");
    saved = false;
    backend.events.get("atlas:tasks-changed")?.();
    await waitFor(() => expect(screen.queryByRole("button", { name: "查看任务" })).toBeNull());
  });

  it("preserves the current core setting when editing a candidate and clears relearn consent on cancel", async () => {
    backend.data!.memories = [
      {
        id: "rent",
        revision: 2,
        key: "rent",
        kind: "fact",
        content: "每月15日",
        confirmed: true,
        sourceMessageId: "h",
        sourceThreadId: "old",
        updatedAt: 1,
        core: true,
      },
    ];
    backend.data!.memoryCandidates = [
      {
        id: "change",
        revision: 1,
        sourceThreadId: "old",
        createdAt: 1,
        input: {
          id: "rent",
          expectedRevision: 2,
          key: "rent",
          kind: "fact",
          content: "每月20日",
          evidenceQuote: "改为20日",
          question: "确认日期？",
          sourceMessageId: "h",
        },
      },
    ];
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "编辑后保存" }));
    expect(
      (screen.getByLabelText("每轮优先提供（最多5条，需为明确信息）") as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(screen.getByLabelText("确认重新记住曾删除的信息"));
    fireEvent.click(screen.getByRole("button", { name: "取消编辑" }));
    expect((screen.getByLabelText("确认重新记住曾删除的信息") as HTMLInputElement).checked).toBe(
      false,
    );
  });
  it("does not edit a stale candidate against a newer active revision", async () => {
    backend.data!.memories = [
      {
        id: "rent",
        revision: 3,
        key: "rent",
        kind: "fact",
        content: "每月25日",
        confirmed: true,
        sourceMessageId: "h",
        sourceThreadId: "old",
        updatedAt: 1,
      },
    ];
    backend.data!.memoryCandidates = [
      {
        id: "old-change",
        revision: 1,
        sourceThreadId: "old",
        createdAt: 1,
        input: {
          id: "rent",
          expectedRevision: 1,
          key: "rent",
          kind: "fact",
          content: "每月20日",
          evidenceQuote: "改为20日",
          sourceMessageId: "h",
        },
      },
    ];
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "编辑后保存" }));
    expect((await screen.findByRole("alert")).textContent).toContain("记忆已变化");
    expect((screen.getByLabelText("记忆内容") as HTMLTextAreaElement).value).toBe("");
  });
  it("requires resolving a candidate question before a generic confirmation", async () => {
    backend.data!.memoryCandidates = [
      {
        id: "alex",
        revision: 1,
        sourceThreadId: "old",
        createdAt: 1,
        input: {
          key: "alex/birthday",
          kind: "fact",
          content: "生日5月20日",
          evidenceQuote: "小王生日5月20日",
          question: "哪位小王？",
          sourceMessageId: "human",
        },
      },
    ];
    renderPanel();
    await screen.findByText("待确认：哪位小王？");
    expect(screen.getByRole("button", { name: "确认这条记忆" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "编辑后保存" }).hasAttribute("disabled")).toBe(false);
  });
  it("keeps uncertain memory inert until confirming its exact candidate version", async () => {
    backend.data!.memoryCandidates = [
      {
        id: "alex",
        revision: 3,
        sourceThreadId: "old",
        createdAt: 1,
        input: {
          key: "alex/birthday",
          kind: "fact",
          content: "生日5月20日",
          evidenceQuote: "小王生日5月20日",
          question: null,
          sourceMessageId: "human",
        },
      },
    ];
    renderPanel();
    await screen.findByText("生日5月20日");
    expect(backend.invoke.mock.calls.some(([c]) => c === "personal_confirm_memory")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "确认这条记忆" }));
    await waitFor(() =>
      expect(backend.invoke).toHaveBeenCalledWith("personal_confirm_memory", {
        id: "alex",
        revision: 3,
      }),
    );
    expect(backend.invoke.mock.calls.some(([c]) => c === "tasks_upsert")).toBe(false);
  });
  it("does not silently opt into relearning a forgotten key", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存记忆" }).hasAttribute("disabled")).toBe(false),
    );
    expect((screen.getByLabelText("确认重新记住曾删除的信息") as HTMLInputElement).checked).toBe(
      false,
    );
    fireEvent.change(screen.getByLabelText("记忆名称"), {
      target: { value: "rent" },
    });
    fireEvent.change(screen.getByLabelText("记忆内容"), {
      target: { value: "每月15日" },
    });
    fireEvent.click(screen.getByLabelText("确认重新记住曾删除的信息"));
    fireEvent.click(screen.getByRole("button", { name: "保存记忆" }));
    await waitFor(() =>
      expect(
        backend.invoke.mock.calls.find(([c]) => c === "personal_save_memory")?.[1].relearn,
      ).toBe(true),
    );
  });
  it("prefills from a human message without saving it or creating a reminder", async () => {
    backend.data!.history = [
      {
        sessionId: "old",
        messages: [
          {
            id: "human",
            role: "user",
            content: "我的房租每月15日交",
            timestamp: "2026-10-17T12:00:00Z",
            mode: "text",
            thinking: "",
            tool_calls: [],
            images: [],
            model: null,
            plan: [],
          },
        ],
      },
    ];
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "保存为个人记忆" }));
    expect((screen.getByLabelText("记忆内容") as HTMLTextAreaElement).value).toBe(
      "我的房租每月15日交",
    );
    expect(
      backend.invoke.mock.calls.some(([c]) => c === "personal_save_memory" || c === "tasks_upsert"),
    ).toBe(false);
    expect(await screen.findByText(/原消息已放入记忆编辑器/)).toBeTruthy();
  });
  it("reports memory write failure without claiming success or creating a reminder", async () => {
    const ordinary = backend.invoke.getMockImplementation()!;
    backend.invoke.mockImplementation(async (...args) => {
      if (args[0] === "personal_save_memory") throw new Error("Personal database unavailable");
      return ordinary(...args);
    });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存记忆" }).hasAttribute("disabled")).toBe(false),
    );
    fireEvent.change(screen.getByLabelText("记忆名称"), {
      target: { value: "rent" },
    });
    fireEvent.change(screen.getByLabelText("记忆内容"), {
      target: { value: "每月10日" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存记忆" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Personal database unavailable",
    );
    expect(screen.queryByText("个人记忆已保存；此操作未创建或修改提醒。")).toBeNull();
    expect(backend.invoke.mock.calls.some(([command]) => command === "tasks_upsert")).toBe(false);
  });
  it("opens without a project and saves explicit memory without scheduling a reminder", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存记忆" }).hasAttribute("disabled")).toBe(false),
    );
    fireEvent.change(screen.getByLabelText("记忆名称"), {
      target: { value: "rent" },
    });
    fireEvent.change(screen.getByLabelText("记忆内容"), {
      target: { value: "每月10日交房租" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存记忆" }));
    await waitFor(() =>
      expect(backend.invoke).toHaveBeenCalledWith("personal_save_memory", {
        input: {
          key: "rent",
          kind: "fact",
          content: "每月10日交房租",
          confirmed: true,
          sourceMessageId: "",
          core: false,
          id: undefined,
          expectedRevision: undefined,
        },
        relearn: false,
      }),
    );
    expect(backend.invoke.mock.calls.some(([command]) => command === "tasks_upsert")).toBe(false);
    expect(await screen.findByText("个人记忆已保存；此操作未创建或修改提醒。")).toBeTruthy();
  });

  it("retains multiple inert drafts and confirms only the selected id and version", async () => {
    backend.data!.proposals = [
      {
        id: "rent",
        revision: 2,
        state: "pending",
        sourceThreadId: "old",
        input: {
          title: "房租",
          prompt: "交房租",
          dueAt: 1900000000000,
          questions: [],
        },
      },
      {
        id: "birthday",
        revision: 5,
        state: "pending",
        sourceThreadId: "old",
        input: {
          title: "生日",
          prompt: "生日将近",
          dueAt: 0,
          questions: ["公历还是农历？"],
        },
      },
    ];
    renderPanel();
    await screen.findByText("房租");
    const confirm = screen.getAllByRole("button", { name: "确认并登记" });
    expect(confirm[0].hasAttribute("disabled")).toBe(false);
    expect(confirm[1].hasAttribute("disabled")).toBe(true);
    expect(
      backend.invoke.mock.calls.some(([command]) => command === "personal_confirm_proposal"),
    ).toBe(false);
    fireEvent.click(confirm[0]);
    await waitFor(() =>
      expect(backend.invoke).toHaveBeenCalledWith("personal_confirm_proposal", {
        id: "rent",
        revision: 2,
      }),
    );
    expect(useTaskCenter.getState().selectedId).toBe("registered");
    expect(screen.getByText("生日")).toBeTruthy();
  });

  it("keeps one visible history even when the Agent cannot connect", async () => {
    backend.data!.currentThreadId = "old";
    backend.data!.conversations = [
      { threadId: "old", sessionId: "old-session", agent: "claude-code-ts" },
    ];
    backend.data!.history = [
      {
        sessionId: "old-session",
        messages: [
          {
            id: "old-message",
            role: "user",
            content: "以前的房租消息",
            timestamp: "2026-10-16T12:00:00Z",
            mode: "text",
            thinking: "",
            tool_calls: [],
            images: [],
            model: null,
            plan: [],
          },
        ],
      },
    ];
    const ordinary = backend.invoke.getMockImplementation()!;
    backend.invoke.mockImplementation(async (...args) => {
      if (args[0] === "personal_session") throw new Error("Agent authentication required");
      return ordinary(...args);
    });
    renderPanel();
    await screen.findByText("以前的房租消息");
    expect(backend.invoke.mock.calls.some(([c]) => c === "personal_session")).toBe(false);
    expect(screen.queryByRole("button", { name: "新建个人会话" })).toBeNull();
    expect(screen.queryByLabelText("个人会话历史")).toBeNull();
    fireEvent.change(screen.getByLabelText("给个人助手的消息"), {
      target: { value: "继续聊房租" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Agent authentication required",
    );
    expect(screen.getByText("以前的房租消息")).toBeTruthy();
    expect((screen.getByLabelText("给个人助手的消息") as HTMLTextAreaElement).value).toBe(
      "继续聊房租",
    );
    const calls = backend.invoke.mock.calls.filter(([command]) => command === "personal_session");
    expect(calls).toEqual([["personal_session", { agentId: undefined, threadId: "old" }]]);
  });

  it("sends the human text unchanged and exposes the application context receipt", async () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText("给个人助手的消息"), {
      target: { value: "记住房租日期" },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "发送" }).hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(backend.invoke).toHaveBeenCalledWith("agents_send", {
        key: { agent_id: "agent-a", session_id: "session-a" },
        text: "记住房租日期",
        attachments: null,
        resourceLinks: null,
        personalTimezone: expect.any(String),
      }),
    );
    expect(await screen.findByText("Application data: rent reminder")).toBeTruthy();
  });

  it("applies the selected model and permission mode before binding and sending", async () => {
    renderPanel();
    await waitFor(() => expect(useChatStore.getState().sessions.personal).toBeTruthy());
    useChatStore.getState().actions.setClaudePermissionMode("personal", "plan");
    useChatStore.getState().actions.setAcpModel("personal", "selected-model");
    const original = backend.invoke.getMockImplementation()!;
    backend.invoke.mockImplementation(async (...args) => {
      if (args[0] === "agents_set_mode") {
        expect(useChatStore.getState().sessions.personal?.acpSessionId).toBeUndefined();
        expect(args[1]).toMatchObject({ modeId: "plan" });
      }
      if (args[0] === "agents_set_model") {
        expect(useChatStore.getState().sessions.personal?.acpSessionId).toBeUndefined();
        expect(args[1]).toMatchObject({ modelId: "selected-model" });
      }
      return original(...args);
    });
    fireEvent.change(screen.getByLabelText("给个人助手的消息"), {
      target: { value: "先制定计划" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(backend.invoke.mock.calls.some(([c]) => c === "agents_send")).toBe(true),
    );
    const calls = backend.invoke.mock.calls.map(([c]) => c);
    expect(calls.indexOf("agents_set_mode")).toBeLessThan(calls.indexOf("agents_send"));
    expect(calls.indexOf("agents_set_model")).toBeLessThan(calls.indexOf("agents_send"));
    expect(useChatStore.getState().sessions.personal?.claudePermissionMode).toBe("plan");
  });

  it("holds the first message when the selected permission mode cannot be restored", async () => {
    backend.attachments = [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }];
    renderPanel();
    await waitFor(() => expect(useChatStore.getState().sessions.personal).toBeTruthy());
    useChatStore.getState().actions.setClaudePermissionMode("personal", "plan");
    const original = backend.invoke.getMockImplementation()!;
    backend.invoke.mockImplementation(async (...args) => {
      if (args[0] === "agents_set_mode") throw new Error("mode refused");
      return original(...args);
    });
    fireEvent.change(screen.getByLabelText("给个人助手的消息"), {
      target: { value: "等待权限确认" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(useChatStore.getState().sessions.personal?.pendingSend?.content).toBe("等待权限确认"),
    );
    expect(useChatStore.getState().sessions.personal?.unrestoredModeId).toBe("plan");
    expect(useChatStore.getState().sessions.personal?.pendingSend?.attachments).toEqual(
      backend.attachments,
    );
    expect(backend.invoke.mock.calls.some(([c]) => c === "agents_send")).toBe(false);
  });

  it("retains messages queued while the personal connection is opening", async () => {
    const original = backend.invoke.getMockImplementation()!;
    backend.invoke.mockImplementation(async (...args) => {
      if (args[0] === "personal_session")
        useChatStore.getState().actions.enqueueMessage("personal", "稍后发这条");
      return original(...args);
    });
    renderPanel();
    await waitFor(() => expect(useChatStore.getState().sessions.personal).toBeTruthy());
    fireEvent.change(screen.getByLabelText("给个人助手的消息"), {
      target: { value: "第一条消息" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(backend.invoke.mock.calls.some(([c]) => c === "agents_send")).toBe(true),
    );
    expect(useChatStore.getState().queues.personal).toEqual(["稍后发这条"]);
  });

  it("preserves the failed text, newer draft and queued messages after a send error", async () => {
    renderPanel();
    await waitFor(() => expect(useChatStore.getState().sessions.personal).toBeTruthy());
    useChatStore
      .getState()
      .actions.setAcpBinding("personal", "agent-a", "session-a", "C:/personal");
    useChatStore.getState().actions.enqueueMessage("personal", "第二条");
    useChatStore.getState().actions.enqueueMessage("personal", "第三条");
    const original = backend.invoke.getMockImplementation()!;
    backend.invoke.mockImplementation(async (...args) => {
      if (args[0] === "agents_send") {
        useChatStore.getState().actions.setDraft("personal", "正在输入的新内容");
        throw new Error("network unavailable");
      }
      return original(...args);
    });
    fireEvent.change(screen.getByLabelText("给个人助手的消息"), { target: { value: "第一条" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText(/network unavailable/);
    expect(useChatStore.getState().sessions.personal?.status).toBe("error");
    expect(useChatStore.getState().drafts.personal).toBe("第一条\n正在输入的新内容");
    expect(useChatStore.getState().queues.personal).toEqual(["第二条", "第三条"]);
    expect(backend.invoke.mock.calls.filter(([c]) => c === "agents_send")).toHaveLength(1);
  });

  it("keeps old messages in the fixed window when the backend replaces an unsupported context", async () => {
    backend.data!.currentThreadId = "old";
    backend.data!.conversations = [
      { threadId: "old", sessionId: "old-session", agent: "claude-code-ts" },
    ];
    backend.data!.history = [
      {
        sessionId: "old-session",
        messages: [
          {
            id: "old",
            role: "assistant",
            content: "这是以前的聊天",
            timestamp: "2026-10-16T12:00:00Z",
            mode: "text",
            thinking: "",
            tool_calls: [],
            images: [],
            model: null,
            plan: [],
          },
        ],
      },
    ];
    const ordinary = backend.invoke.getMockImplementation()!;
    backend.invoke.mockImplementation(async (...args) => {
      const result = await ordinary(...args);
      return args[0] === "personal_session" ? { ...result, contextRestarted: true } : result;
    });
    renderPanel();
    await screen.findByText("这是以前的聊天");
    fireEvent.change(screen.getByLabelText("给个人助手的消息"), {
      target: { value: "今天的事情" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText(/Agent 不支持恢复执行上下文/);
    expect(screen.getByText("这是以前的聊天")).toBeTruthy();
    expect(screen.getByText("今天的事情")).toBeTruthy();
    await waitFor(() =>
      expect(backend.invoke.mock.calls.some(([c]) => c === "agents_send")).toBe(true),
    );
  });

  it("keeps an unsent draft when the fixed window is hidden and reopened", async () => {
    const view = renderPanel();
    fireEvent.change(screen.getByLabelText("给个人助手的消息"), {
      target: { value: "生日还没写完" },
    });
    view.unmount();
    renderPanel();
    expect((screen.getByLabelText("给个人助手的消息") as HTMLTextAreaElement).value).toBe(
      "生日还没写完",
    );
    expect(backend.invoke.mock.calls.some(([c]) => c === "personal_session")).toBe(false);
  });
});
