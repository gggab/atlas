import { invoke } from "@tauri-apps/api/core";

export type TaskKind = "reminder" | "agent_check";
export type TaskState =
  | "needs_confirmation"
  | "active"
  | "waiting_input"
  | "paused"
  | "blocked"
  | "completed"
  | "cancelled";
export interface TaskInput {
  id?: string | null;
  expectedRevision?: number | null;
  idempotencyKey: string;
  title: string;
  prompt: string;
  kind: TaskKind;
  dueAt: number;
  calendar?: CalendarSpec | null;
  intervalMinutes?: number | null;
  scopeKey?: string;
  sourceThreadId?: string | null;
  executionThreadId?: string | null;
  cwd?: string | null;
  agent?: string | null;
  maxRuns: number;
  timeoutSeconds: number;
  quietHours?: { startMinute: number; endMinute: number } | null;
}
export interface CalendarSpec {
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  startDate: string;
  localTime: string;
  timezone: string;
  missingDayPolicy?: "last_day" | "next_day" | "skip" | null;
  reminderDays: number[];
  untilDate?: string | null;
  trackCompletion: boolean;
}
export interface CalendarPreview {
  issues: { field: string; question: string }[];
  periods: {
    index: number;
    localDate: string;
    timezone: string;
    dueAt: number;
    reminders: { leadDays: number; nominalLocal: string; at: number }[];
  }[];
  frozenPeriods: string[];
  timezoneVersion: string;
  dstPolicy: string;
}
export interface Occurrence {
  id: string;
  taskId: string;
  periodIndex: number;
  revision: number;
  localDate: string;
  dueAt: number;
  state: "pending" | "completed" | "skipped" | "elapsed" | "superseded";
  trackCompletion: boolean;
  started: boolean;
  timezone: string;
  updatedAt: number;
}
export const calendarPreview = (calendar: CalendarSpec, id?: string) =>
  invoke<CalendarPreview>("tasks_calendar_preview", { calendar, id });
export const taskOccurrences = (id: string, before?: number) =>
  invoke<Occurrence[]>("tasks_occurrences", { id, before });
export const controlOccurrence = (
  task: ScheduledTask,
  period: Occurrence,
  action: "complete" | "skip" | "snooze",
  at?: number,
) =>
  invoke<Occurrence>("tasks_control_occurrence", {
    taskId: task.id,
    taskRevision: task.revision,
    id: period.id,
    revision: period.revision,
    action,
    at,
  });
export interface ScheduledTask {
  id: string;
  revision: number;
  input: TaskInput;
  state: TaskState;
  nextCheckAt: number | null;
  reason: string | null;
  runCount: number;
  createdAt: number;
  updatedAt: number;
}
export interface TaskRun {
  id: string;
  taskId: string;
  state: string;
  startedAt: number;
  endedAt: number | null;
  reason: string | null;
  sessionId: string | null;
  turnSeq: number | null;
  report: {
    done: boolean;
    waitingInput: boolean;
    notify: boolean;
    body: string | null;
    nextCheckAt: number | null;
  } | null;
}
export interface TaskNotification {
  id: string;
  taskId: string;
  runId: string;
  title: string;
  body: string;
  attention: boolean;
  createdAt: number;
  nativeState: string;
  nativeError: string | null;
  read: boolean;
}
export interface TaskSnapshot {
  tasks: ScheduledTask[];
  notifications: TaskNotification[];
}
export type TaskAction = "pause" | "resume" | "cancel" | "complete" | "snooze";

export const tasksSnapshot = () => invoke<TaskSnapshot>("tasks_snapshot");
export const saveTask = (input: TaskInput) => invoke<ScheduledTask>("tasks_upsert", { input });
export const controlTask = (task: ScheduledTask, action: TaskAction, at?: number) =>
  invoke<ScheduledTask>("tasks_control", { id: task.id, revision: task.revision, action, at });
export const reopenTask = (request: {
  id: string;
  revision: number;
  at: number | null;
  calendar: CalendarSpec | null;
  maxRuns: number | null;
}) => invoke<ScheduledTask>("tasks_reopen", { request });
export const deleteTask = (task: ScheduledTask) =>
  invoke<void>("tasks_delete", { id: task.id, revision: task.revision });
export const taskRuns = (id: string) => invoke<TaskRun[]>("tasks_runs", { id });
export const markTaskNotificationRead = (id: string, dismissed = false) =>
  invoke<void>("tasks_mark_read", { id, dismissed });

export interface TaskThread {
  threadId: string;
  sessionId: string | null;
  title: string;
  archived: boolean;
}
export const executionThreads = () =>
  invoke<TaskThread[]>("threads_history", { archivedOnly: false });

export function localInputTime(at: number): string {
  const date = new Date(at);
  return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
