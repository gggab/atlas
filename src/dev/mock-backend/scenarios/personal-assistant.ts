import type { Scenario } from "../types";
import { emit } from "@tauri-apps/api/event";
import type { PersonalSnapshot } from "@/features/personal/lib/personal-api";
import type { TaskSnapshot } from "@/features/tasks/lib/tasks-api";

const personal: PersonalSnapshot = {
  directory: "/mock/personal-assistant",
  currentThreadId: "personal-thread",
  conversations: [
    { threadId: "personal-thread", sessionId: "personal-session", agent: "claude-acp" },
  ],
  memories: [],
  memoryCandidates: [],
  proposals: [],
  history: [
    {
      sessionId: "personal-session",
      messages: [
        {
          id: "human",
          role: "user",
          content: "我每周四中午12点前需要写工作周报",
          timestamp: "2026-10-18T08:00:00Z",
          mode: "text",
          thinking: "",
          tool_calls: [],
          images: [],
          model: null,
          plan: [],
        },
        {
          id: "assistant",
          role: "assistant",
          content: "已登记每周四11:30的周报提醒，使用 Asia/Riyadh 时区。你可以随时在任务中心修改。",
          timestamp: "2026-10-18T08:00:02Z",
          mode: "text",
          thinking: "",
          tool_calls: [],
          images: [],
          model: null,
          plan: [],
        },
      ],
    },
  ],
};
const tasks: TaskSnapshot = {
  tasks: [
    {
      id: "weekly-report",
      revision: 1,
      state: "active",
      nextCheckAt: Date.UTC(2026, 9, 22, 8, 30),
      reason: null,
      runCount: 0,
      createdAt: Date.UTC(2026, 9, 18),
      updatedAt: Date.UTC(2026, 9, 18),
      input: {
        id: null,
        expectedRevision: null,
        idempotencyKey: "fixture-weekly-report",
        title: "写工作周报",
        prompt: "请在中午12点前完成工作周报。",
        kind: "reminder",
        scopeKey: "personal",
        cwd: "/mock/personal-assistant",
        agent: null,
        executionThreadId: null,
        sourceThreadId: "personal-thread",
        dueAt: Date.UTC(2026, 9, 22, 8, 30),
        calendar: {
          frequency: "weekly",
          startDate: "2026-10-22",
          localTime: "11:30",
          timezone: "Asia/Riyadh",
          reminderDays: [0],
          trackCompletion: true,
        },
        intervalMinutes: null,
        maxRuns: 1,
        timeoutSeconds: 300,
        quietHours: null,
      },
    },
  ],
  notifications: [],
};
tasks.tasks.push(
  {
    ...structuredClone(tasks.tasks[0]),
    id: "cancelled-example",
    state: "cancelled",
    nextCheckAt: null,
    input: { ...structuredClone(tasks.tasks[0].input), title: "已取消的周报提醒（示例）" },
  },
  {
    ...structuredClone(tasks.tasks[0]),
    id: "completed-example",
    state: "completed",
    nextCheckAt: null,
    input: {
      ...structuredClone(tasks.tasks[0].input),
      title: "已完成的取件提醒（示例）",
      calendar: null,
    },
  },
);

export const personalAssistant: Scenario = {
  name: "personal-assistant",
  description:
    "Shared Agents chat with a fictional personal reminder; no vendor connection or real task writes.",
  init: () => {
    // Desktop rendering only; all IPC remains isolated in the browser mock.
    Reflect.set(window, "isTauri", true);
  },
  rawCommands: {
    background_status: () => ({
      supported: true,
      enabled: false,
      role: "local",
      login: false,
      error: null,
      needsRestart: false,
      connected: false,
    }),
    background_attach: () => null,
    personal_snapshot: () => personal,
    tasks_snapshot: () => tasks,
    tasks_runs: () => [],
    tasks_occurrences: () => [],
    tasks_reopen: ({ request }) => {
      const r = request as { id: string; revision: number; at: number | null };
      const task = tasks.tasks.find((t) => t.id === r.id);
      if (!task || task.revision !== r.revision || !["completed", "cancelled"].includes(task.state))
        throw new Error("Invalid fictional task revision/state");
      task.state = "active";
      task.revision += 1;
      task.nextCheckAt = r.at ?? Date.now() + 3600000;
      void emit("atlas:tasks-changed");
      return task;
    },
    tasks_delete: ({ id, revision }) => {
      const task = tasks.tasks.find((t) => t.id === id);
      if (!task || task.revision !== revision || !["completed", "cancelled"].includes(task.state))
        throw new Error("Invalid fictional task revision/state");
      tasks.tasks = tasks.tasks.filter((t) => t.id !== id);
      tasks.notifications = tasks.notifications.filter((n) => n.taskId !== id);
      void emit("atlas:tasks-changed");
      return null;
    },
  },
  setup: async () => {
    const { useLayoutStore } = await import("@/features/layout/stores/layout-store");
    useLayoutStore.getState().actions.addTab({
      id: "personal-assistant",
      type: "personal",
      title: "个人助手",
      closable: true,
      dirty: false,
      data: {},
    });
  },
};
