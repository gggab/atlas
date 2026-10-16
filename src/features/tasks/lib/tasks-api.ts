import { invoke } from "@tauri-apps/api/core";

export type TaskKind = "reminder" | "agent_check";
export type TaskState =
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
  scopeKey?: string;
  sourceThreadId?: string | null;
  executionThreadId?: string | null;
  cwd?: string | null;
  agent?: string | null;
  maxRuns: number;
  timeoutSeconds: number;
  quietHours?: { startMinute: number; endMinute: number } | null;
}
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
