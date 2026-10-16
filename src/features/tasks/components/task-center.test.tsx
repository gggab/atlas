// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ScheduledTask } from "../lib/tasks-api";
import type { AppNotification } from "@/features/notifications/stores/notifications-store";

const backend = vi.hoisted(() => ({
  task: null as ScheduledTask | null,
  invoke: vi.fn(),
  sync: vi.fn(),
  notificationsChanged: null as
    | null
    | ((current: { items: AppNotification[] }, previous: { items: AppNotification[] }) => void),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: backend.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/native-notify", () => ({
  primeNativeNotificationPermission: vi.fn(async () => "granted"),
}));
vi.mock("@/features/settings/stores/settings-store", () => ({
  useSettingsStore: {
    use: {
      settings: () => ({
        notificationsEnabled: true,
        notifyDisabledKinds: [],
        agentTaskTools: false,
      }),
    },
    getState: () => ({ actions: { updateSettings: vi.fn() } }),
  },
}));
vi.mock("@/features/notifications/stores/notifications-store", () => ({
  useNotificationsStore: {
    getState: () => ({ actions: { syncTasks: backend.sync } }),
    subscribe: (
      handler: (
        current: { items: AppNotification[] },
        previous: { items: AppNotification[] },
      ) => void,
    ) => {
      backend.notificationsChanged = handler;
      return () => {
        backend.notificationsChanged = null;
      };
    },
  },
}));

import { TaskCenter } from "./task-center";
import { useTaskCenter } from "../stores/task-center-store";

beforeEach(() => {
  backend.task = {
    id: "task-1",
    revision: 4,
    input: {
      idempotencyKey: "bill",
      title: "还房租",
      prompt: "请确认房租已经支付",
      kind: "reminder",
      dueAt: Date.now() + 60_000,
      sourceThreadId: "archived-source",
      maxRuns: 20,
      timeoutSeconds: 300,
    },
    state: "active",
    nextCheckAt: Date.now() + 60_000,
    reason: null,
    runCount: 0,
    createdAt: 0,
    updatedAt: 0,
  };
  useTaskCenter.setState({ open: false, selectedId: null });
  backend.invoke.mockReset();
  backend.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "tasks_snapshot")
      return { tasks: backend.task ? [backend.task] : [], notifications: [] };
    if (command === "threads_history" || command === "tasks_runs") return [];
    if (command === "tasks_control")
      return { ...backend.task, state: args?.action === "pause" ? "paused" : "cancelled" };
    return backend.task;
  });
});
afterEach(cleanup);

describe("independent task center", () => {
  it("keeps portaled task content out of the titlebar's drag and double-click handlers", async () => {
    const mouseDown = vi.fn();
    const doubleClick = vi.fn();
    render(
      <div onMouseDown={mouseDown} onDoubleClick={doubleClick}>
        <TaskCenter />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
    const dialog = await screen.findByRole("dialog");
    mouseDown.mockClear();
    fireEvent.mouseDown(dialog);
    fireEvent.doubleClick(dialog);
    expect(mouseDown).not.toHaveBeenCalled();
    expect(doubleClick).not.toHaveBeenCalled();
  });
  it("persists read state when a notification first arrives while the notification panel is open", async () => {
    render(<TaskCenter />);
    const n: AppNotification = {
      id: "task-run:r",
      kind: "task-reminder",
      source: "app",
      title: "Reminder",
      body: "Due",
      timestamp: new Date().toISOString(),
      target: { type: "task", taskId: "task-1" },
      read: true,
    };
    backend.notificationsChanged?.({ items: [n] }, { items: [] });
    await waitFor(() =>
      expect(backend.invoke).toHaveBeenCalledWith("tasks_mark_read", {
        id: n.id,
        dismissed: false,
      }),
    );
  });
  it("registers a fixed reminder without requiring a project or Agent binding", async () => {
    render(<TaskCenter />);
    fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
    fireEvent.change(await screen.findByLabelText("标题"), { target: { value: "取快递" } });
    fireEvent.change(screen.getByLabelText("提醒内容或检查目标"), {
      target: { value: "记得取快递" },
    });
    fireEvent.change(screen.getByLabelText("首次执行时间（本机时区）"), {
      target: { value: "2030-10-25T18:00" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "登记任务" }).closest("form")!);
    await waitFor(() =>
      expect(backend.invoke).toHaveBeenCalledWith("tasks_upsert", {
        input: expect.objectContaining({
          title: "取快递",
          prompt: "记得取快递",
          kind: "reminder",
          executionThreadId: null,
        }),
      }),
    );
  });
  it("shows a reminder whose source conversation is archived, without opening that conversation", async () => {
    render(<TaskCenter />);
    fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
    await screen.findByRole("button", { name: "还房租" });
    expect(
      screen.getByText("任务独立于会话归档。应用运行且电脑唤醒时执行，提醒不会自动完成事项。"),
    ).toBeTruthy();
    expect(backend.invoke.mock.calls.some(([name]) => name === "threads_resume")).toBe(false);
  });
  it("pauses using the durable task revision", async () => {
    render(<TaskCenter />);
    fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
    fireEvent.click(await screen.findByRole("button", { name: "暂停" }));
    await waitFor(() =>
      expect(backend.invoke).toHaveBeenCalledWith("tasks_control", {
        id: "task-1",
        revision: 4,
        action: "pause",
        at: undefined,
      }),
    );
  });
});
