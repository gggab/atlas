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
    if (command === "tasks_occurrences")
      return [
        {
          id: "jan",
          taskId: "task-1",
          periodIndex: 24,
          revision: 2,
          localDate: "2026-01-31",
          dueAt: 0,
          state: "pending",
          trackCompletion: true,
          started: true,
          timezone: "Asia/Shanghai",
          updatedAt: 0,
        },
      ];
    if (command === "tasks_calendar_preview")
      return {
        issues: [{ field: "missingDayPolicy", question: "短月如何处理？" }],
        periods: [],
        frozenPeriods: [],
        timezoneVersion: "test",
        dstPolicy: "固定规则",
      };
    if (command === "tasks_control")
      return { ...backend.task, state: args?.action === "pause" ? "paused" : "cancelled" };
    return backend.task;
  });
});
afterEach(cleanup);

describe("independent task center", () => {
  it("registers every-five-minute reminders without a date or Agent binding", async () => {
    render(<TaskCenter />);
    fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
    fireEvent.change(await screen.findByLabelText("标题"), { target: { value: "喝水" } });
    fireEvent.change(screen.getByLabelText("提醒内容或检查目标"), {
      target: { value: "起来喝水" },
    });
    fireEvent.change(screen.getByLabelText("重复规则"), { target: { value: "interval" } });
    expect((screen.getByLabelText("每隔多少分钟") as HTMLInputElement).value).toBe("5");
    expect(screen.queryByLabelText("首次执行时间（本机时区）")).toBeNull();
    const before = Date.now();
    fireEvent.submit(screen.getByRole("button", { name: "登记任务" }).closest("form")!);
    await waitFor(() =>
      expect(backend.invoke).toHaveBeenCalledWith("tasks_upsert", {
        input: expect.objectContaining({
          kind: "reminder",
          intervalMinutes: 5,
          calendar: null,
          executionThreadId: null,
        }),
      }),
    );
    const input = backend.invoke.mock.calls.find(([command]) => command === "tasks_upsert")![1]
      .input;
    expect(input.dueAt).toBeGreaterThanOrEqual(before + 300_000);
    expect(input.dueAt).toBeLessThanOrEqual(Date.now() + 300_000);
  });
  it("restores an interval on edit and clears it when switched to once", async () => {
    backend.task!.input.intervalMinutes = 5;
    render(<TaskCenter />);
    fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
    fireEvent.click(await screen.findByRole("button", { name: "修改" }));
    expect((screen.getByLabelText("重复规则") as HTMLSelectElement).value).toBe("interval");
    expect((screen.getByLabelText("每隔多少分钟") as HTMLInputElement).value).toBe("5");
    fireEvent.change(screen.getByLabelText("重复规则"), { target: { value: "once" } });
    expect(screen.queryByLabelText("每隔多少分钟")).toBeNull();
    fireEvent.submit(screen.getByRole("button", { name: "保存修改" }).closest("form")!);
    await waitFor(() =>
      expect(backend.invoke).toHaveBeenCalledWith("tasks_upsert", {
        input: expect.objectContaining({ id: "task-1", intervalMinutes: null, calendar: null }),
      }),
    );
  });
  it("discards a preview that finishes after the calendar rule has changed", async () => {
    let finish: ((value: unknown) => void) | undefined;
    const previous = backend.invoke.getMockImplementation()!;
    backend.invoke.mockImplementation((command: string, args?: Record<string, unknown>) =>
      command === "tasks_calendar_preview"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : previous(command, args),
    );
    render(<TaskCenter />);
    fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
    fireEvent.change(await screen.findByLabelText("标题"), { target: { value: "生日" } });
    fireEvent.change(screen.getByLabelText("提醒内容或检查目标"), {
      target: { value: "生日将近" },
    });
    fireEvent.change(screen.getByLabelText("重复规则"), { target: { value: "yearly" } });
    fireEvent.submit(screen.getByRole("button", { name: "预览周期计划" }).closest("form")!);
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    fireEvent.change(screen.getByLabelText("提醒钟点"), { target: { value: "10:00" } });
    finish!({
      issues: [],
      periods: [],
      frozenPeriods: [],
      timezoneVersion: "test",
      dstPolicy: "fixed",
    });
    await screen.findByRole("button", { name: "预览周期计划" });
    expect(screen.queryByRole("button", { name: "登记周期计划" })).toBeNull();
  });
  it("previews unresolved calendars and saves them as drafts without claiming activation", async () => {
    render(<TaskCenter />);
    fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
    fireEvent.change(await screen.findByLabelText("标题"), { target: { value: "房租" } });
    fireEvent.change(screen.getByLabelText("提醒内容或检查目标"), {
      target: { value: "请交房租" },
    });
    fireEvent.change(screen.getByLabelText("重复规则"), { target: { value: "monthly" } });
    fireEvent.change(screen.getByLabelText("周期起始日期"), { target: { value: "2030-01-31" } });
    const form = screen.getByRole("button", { name: "预览周期计划" }).closest("form")!;
    fireEvent.submit(form);
    await screen.findByText("短月如何处理？");
    expect(backend.invoke.mock.calls.some(([name]) => name === "tasks_upsert")).toBe(false);
    fireEvent.submit(form);
    await waitFor(() =>
      expect(backend.invoke).toHaveBeenCalledWith("tasks_upsert", {
        input: expect.objectContaining({
          calendar: expect.objectContaining({ frequency: "monthly", missingDayPolicy: null }),
        }),
      }),
    );
  });
  it("completes a named calendar period without completing the series", async () => {
    backend.task!.input.calendar = {
      frequency: "monthly",
      startDate: "2024-01-31",
      localTime: "09:00",
      timezone: "Asia/Shanghai",
      missingDayPolicy: "last_day",
      reminderDays: [0],
      trackCompletion: true,
    };
    render(<TaskCenter />);
    fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
    fireEvent.click(await screen.findByRole("button", { name: "还房租" }));
    fireEvent.click(await screen.findByRole("button", { name: "完成 2026-01-31" }));
    await waitFor(() =>
      expect(backend.invoke).toHaveBeenCalledWith(
        "tasks_control_occurrence",
        expect.objectContaining({ id: "jan", revision: 2, taskRevision: 4, action: "complete" }),
      ),
    );
    expect(screen.queryByRole("button", { name: "标记完成" })).toBeNull();
  });
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
