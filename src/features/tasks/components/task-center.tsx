import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CalendarClock } from "lucide-react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/ui/dialog";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { useNotificationsStore } from "@/features/notifications/stores/notifications-store";
import { useTaskCenter } from "../stores/task-center-store";
import { CalendarFields, newCalendar } from "./calendar-fields";
import {
  controlTask,
  reopenTask,
  deleteTask,
  calendarPreview,
  controlOccurrence,
  taskOccurrences,
  executionThreads,
  localInputTime,
  markTaskNotificationRead,
  saveTask,
  taskRuns,
  tasksSnapshot,
  type ScheduledTask,
  type TaskAction,
  type TaskInput,
  type TaskRun,
  type TaskSnapshot,
  type TaskThread,
  type CalendarSpec,
  type CalendarPreview,
  type Occurrence,
} from "../lib/tasks-api";

const STATE_LABEL: Record<ScheduledTask["state"], string> = {
  needs_confirmation: "待确认，尚未启用",
  active: "运行中",
  waiting_input: "等待处理",
  paused: "已暂停",
  blocked: "执行受阻",
  completed: "已完成",
  cancelled: "已取消",
};

const RUN_LABEL: Record<string, string> = {
  claimed: "等待执行",
  dispatching: "执行中",
  succeeded: "执行成功",
  failed: "执行失败",
  cancelled: "已取消",
  unknown: "结果待核对",
  needs_attention: "需要处理",
};
const DELIVERY_LABEL: Record<string, string> = {
  pending: "待发送",
  submitting: "正在提交",
  accepted: "已提交给系统",
  failed: "发送失败，等待重试",
  unknown: "投递结果待核对",
  suppressed: "已停止发送",
  muted: "已按通知设置静音",
  exhausted: "重试失败，请检查通知权限",
};

export function TaskCenter() {
  const { open, selectedId, show, close } = useTaskCenter();
  const settings = useSettingsStore.use.settings();
  const [snapshot, setSnapshot] = useState<TaskSnapshot>({ tasks: [], notifications: [] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<{
    kind: "reopen" | "delete";
    task: ScheduledTask;
  } | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const refreshVersion = useRef(0);
  const [threads, setThreads] = useState<TaskThread[]>([]);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [calendar, setCalendar] = useState<CalendarSpec | null>(null);
  const [intervalMinutes, setIntervalMinutes] = useState<number | null>(null);
  const [preview, setPreview] = useState<CalendarPreview | null>(null);
  const [periods, setPeriods] = useState<Occurrence[]>([]);
  const [hasOlderPeriods, setHasOlderPeriods] = useState(false);
  const calendarVersion = useRef(0);
  const reviseCalendar = (value: CalendarSpec | null) => {
    calendarVersion.current += 1;
    setCalendar(value);
    setPreview(null);
  };
  const form = useRef<HTMLFormElement>(null);
  const receiptKey = useRef(crypto.randomUUID());
  const selected = snapshot.tasks.find((t) => t.id === selectedId);

  const prepareNativePermission = useCallback(async () => {
    if (settings.notificationsEnabled) {
      const { primeNativeNotificationPermission } = await import("@/lib/native-notify");
      await primeNativeNotificationPermission();
    }
  }, [settings.notificationsEnabled]);

  useEffect(() => {
    if (open && settings.agentTaskTools && isTauri()) {
      void prepareNativePermission().catch((e) => setError(String(e)));
    }
  }, [open, settings.agentTaskTools, prepareNativePermission]);

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const value = await tasksSnapshot();
      if (version !== refreshVersion.current) return;
      setSnapshot(value);
      setError(null);
    } catch (e) {
      if (version === refreshVersion.current) setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen("atlas:tasks-changed", () => {
      if (!disposed) void refresh();
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
        if (!disposed) void refresh();
      })
      .catch((e) => setError(String(e)));
    return () => {
      disposed = true;
      stop?.();
    };
  }, [refresh]);

  useEffect(() => {
    if (!settings.notificationsEnabled) return;
    const items = snapshot.notifications.filter(
      (n) =>
        !settings.notifyDisabledKinds.includes(n.attention ? "task-attention" : "task-reminder"),
    );
    useNotificationsStore.getState().actions.syncTasks(
      items.map((n) => ({
        id: n.id,
        kind: n.attention ? "task-attention" : "task-reminder",
        title: n.title,
        body: n.body,
        timestamp: new Date(n.createdAt).toISOString(),
        source: "app",
        target: { type: "task", taskId: n.taskId },
        read: n.read,
      })),
    );
  }, [snapshot.notifications, settings.notificationsEnabled, settings.notifyDisabledKinds]);

  useEffect(
    () =>
      useNotificationsStore.subscribe((current, previous) => {
        for (const n of current.items) {
          if (n.target?.type === "task" && n.read && !previous.items.some((p) => p.id === n.id)) {
            void markTaskNotificationRead(n.id).catch((e) => setError(String(e)));
          }
        }
        for (const n of previous.items) {
          if (n.target?.type !== "task") continue;
          const next = current.items.find((i) => i.id === n.id);
          if (!next || (!n.read && next.read))
            void markTaskNotificationRead(n.id, !next).catch((e) => setError(String(e)));
        }
      }),
    [],
  );

  useEffect(() => {
    if (!open) return;
    if (!isTauri()) {
      setError("任务调度需要桌面应用运行。浏览器预览不执行真实任务。");
      return;
    }
    void refresh();
    void executionThreads()
      .then(setThreads)
      .catch((e) => setError(String(e)));
  }, [open, refresh]);

  useEffect(() => {
    let disposed = false;
    setRuns([]);
    setPeriods([]);
    setHasOlderPeriods(false);
    if (open && selectedId)
      void taskRuns(selectedId)
        .then((value) => {
          if (!disposed) setRuns(value);
        })
        .catch((e) => {
          if (!disposed) setError(String(e));
        });
    return () => {
      disposed = true;
    };
  }, [open, selectedId, snapshot.tasks]);

  useEffect(() => {
    let disposed = false;
    if (open && selectedId && selected?.input.calendar)
      void taskOccurrences(selectedId)
        .then((value) => {
          if (!disposed) {
            setPeriods(value);
            setHasOlderPeriods(value.length === 50);
          }
        })
        .catch((e) => {
          if (!disposed) setError(String(e));
        });
    return () => {
      disposed = true;
    };
  }, [open, selectedId, snapshot.tasks, selected?.input.calendar]);

  const changePeriod = async (
    task: ScheduledTask,
    period: Occurrence,
    action: "complete" | "skip" | "snooze",
  ) => {
    setBusy(true);
    try {
      await controlOccurrence(
        task,
        period,
        action,
        action === "snooze" ? Date.now() + 3_600_000 : undefined,
      );
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const change = async (task: ScheduledTask, action: TaskAction) => {
    setBusy(true);
    try {
      await controlTask(task, action, action === "snooze" ? Date.now() + 60 * 60_000 : undefined);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const kind = data.get("kind") === "agent_check" ? "agent_check" : "reminder";
    const input: TaskInput = {
      id: editing?.id,
      expectedRevision: editing?.revision,
      idempotencyKey: editing?.input.idempotencyKey ?? receiptKey.current,
      title: String(data.get("title")),
      prompt: String(data.get("prompt")),
      kind,
      dueAt: calendar
        ? 0
        : intervalMinutes !== null
          ? Date.now() + intervalMinutes * 60_000
          : new Date(String(data.get("due"))).getTime(),
      calendar,
      intervalMinutes,
      sourceThreadId: editing?.input.sourceThreadId,
      executionThreadId: kind === "agent_check" ? String(data.get("thread")) : null,
      maxRuns: Number(data.get("maxRuns")),
      timeoutSeconds: Number(data.get("timeoutSeconds")),
      quietHours: data.get("quiet") ? { startMinute: 22 * 60, endMinute: 8 * 60 } : null,
    };
    setBusy(true);
    setError(null);
    try {
      if (calendar && !preview) {
        const version = calendarVersion.current;
        const result = await calendarPreview(calendar, editing?.id);
        if (version === calendarVersion.current) setPreview(result);
        return;
      }
      await prepareNativePermission();
      const task = await saveTask(input);
      receiptKey.current = crypto.randomUUID();
      setEditing(null);
      reviseCalendar(null);
      setIntervalMinutes(null);
      form.current?.reset();
      show(task.id);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const edit = (task: ScheduledTask) => {
    setEditing(task);
    reviseCalendar(task.input.calendar ?? null);
    setIntervalMinutes(task.input.intervalMinutes ?? null);
    receiptKey.current = crypto.randomUUID();
  };

  const confirmOperation = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!operation || busy) return;
    const data = new FormData(event.currentTarget);
    const { task, kind } = operation;
    setBusy(true);
    setOperationError(null);
    try {
      if (kind === "delete") {
        await deleteTask(task);
        useNotificationsStore.getState().actions.removeTask(task.id);
        if (selectedId === task.id) show();
        if (editing?.id === task.id) {
          setEditing(null);
          reviseCalendar(null);
          setIntervalMinutes(null);
          form.current?.reset();
        }
      } else {
        const calendar = task.input.calendar?.untilDate
          ? { ...task.input.calendar, untilDate: String(data.get("until") ?? "") || null }
          : null;
        const result = await reopenTask({
          id: task.id,
          revision: task.revision,
          at:
            task.input.calendar || task.input.intervalMinutes
              ? null
              : new Date(String(data.get("at"))).getTime(),
          calendar,
          maxRuns: task.input.kind === "agent_check" ? Number(data.get("maxRuns")) : null,
        });
        show(result.id);
        if (result.state === "needs_confirmation") edit(result);
      }
      setOperation(null);
      await refresh();
    } catch (e) {
      setOperationError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label="任务中心"
        title="任务中心"
        onClick={() => show()}
      >
        <CalendarClock size={16} />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <DialogContent
          className="max-w-[min(60rem,calc(100vw-2rem))] max-h-[85vh] overflow-y-auto"
          onMouseDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <DialogTitle>任务中心</DialogTitle>
          <DialogDescription>
            任务独立于会话归档。应用运行且电脑唤醒时执行，提醒不会自动完成事项。
          </DialogDescription>
          <p className="text-xs text-muted-foreground">
            支持单次、按分钟间隔与公历日、周、月、年重复提醒。周期规则有歧义时保存为待确认；农历和节假日顺延暂不支持。
          </p>
          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.agentTaskTools}
              onChange={(e) =>
                useSettingsStore
                  .getState()
                  .actions.updateSettings({ agentTaskTools: e.target.checked })
              }
            />
            允许 Agent 通过任务工具登记计划和后台检查
          </label>
          <p className="text-xs text-muted-foreground">
            开启后新建或重新打开执行会话，使 Agent 获得任务工具。固定提醒无需开启。后台操作沿用该
            CLI 的权限配置。
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <section aria-label="任务列表" className="min-w-0 space-y-2">
              {snapshot.tasks.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  暂无任务，可手动创建，或在启用工具后向 Agent 提出提醒请求。
                </p>
              )}
              {snapshot.tasks.map((task) => (
                <article key={task.id} className="rounded-md border border-border p-3 space-y-2">
                  <button
                    className="w-full text-left text-sm font-medium"
                    onClick={() => show(task.id)}
                  >
                    {task.input.title}
                  </button>
                  <p className="text-xs text-muted-foreground">
                    {STATE_LABEL[task.state]} ·{" "}
                    {task.nextCheckAt
                      ? new Date(task.nextCheckAt).toLocaleString()
                      : "未安排下一次检查"}
                  </p>
                  {task.reason && <p className="break-words text-xs">{task.reason}</p>}
                  {task.input.intervalMinutes && (
                    <p className="text-xs text-muted-foreground">
                      每隔 {task.input.intervalMinutes} 分钟提醒，直到暂停或结束。
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {(task.state === "completed" || task.state === "cancelled") && (
                      <>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            setOperationError(null);
                            setOperation({ kind: "reopen", task });
                          }}
                        >
                          重新启用
                        </Button>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            setOperationError(null);
                            setOperation({ kind: "delete", task });
                          }}
                        >
                          删除
                        </Button>
                      </>
                    )}
                    {(task.state === "active" ||
                      (task.input.calendar && task.state === "waiting_input")) && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void change(task, "pause")}
                      >
                        暂停
                      </Button>
                    )}
                    {task.state === "paused" && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void change(task, "resume")}
                      >
                        恢复
                      </Button>
                    )}
                    {task.state !== "completed" && task.state !== "cancelled" && (
                      <>
                        {!task.input.calendar && (
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => void change(task, "snooze")}
                          >
                            一小时后
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          disabled={busy || (!!task.input.calendar && task.state === "paused")}
                          title={
                            task.input.calendar && task.state === "paused"
                              ? "恢复后可修改周期规则"
                              : undefined
                          }
                          onClick={() => edit(task)}
                        >
                          修改
                        </Button>
                        {!task.input.calendar && (
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => void change(task, "complete")}
                          >
                            {task.input.intervalMinutes ? "结束提醒" : "标记完成"}
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => void change(task, "cancel")}
                        >
                          {task.input.calendar
                            ? "停止整个计划"
                            : task.input.intervalMinutes
                              ? "停止重复提醒"
                              : "取消任务"}
                        </Button>
                      </>
                    )}
                  </div>
                  {selectedId === task.id && (
                    <div className="space-y-2 border-t border-border pt-2">
                      <p className="whitespace-pre-wrap text-xs">{task.input.prompt}</p>
                      {task.input.calendar && (
                        <>
                          <p className="text-xs text-muted-foreground">
                            每期独立处理；固定时区：{task.input.calendar.timezone}
                            。暂停期间不发送提醒，恢复时保留待办并跳过暂停期间的提醒。
                          </p>
                          {task.state === "needs_confirmation" && (
                            <p className="text-xs">请修改计划补充规则，当前不会执行。</p>
                          )}
                          {periods.map((period) => (
                            <div
                              key={period.id}
                              className="rounded border border-border p-2 text-xs space-y-1"
                            >
                              <p>
                                {period.localDate} ·{" "}
                                {
                                  {
                                    pending: period.dueAt < Date.now() ? "逾期待处理" : "待处理",
                                    completed: "已完成本期",
                                    skipped: "已跳过本期",
                                    elapsed: "已过期，无需确认",
                                    superseded: "已替换",
                                  }[period.state]
                                }
                                {period.started ? " · 已开始，日期规则保留原值" : ""}
                              </p>
                              {period.state === "pending" && (
                                <div className="flex flex-wrap gap-1">
                                  <Button
                                    variant="outline"
                                    disabled={busy}
                                    aria-label={`完成 ${period.localDate}`}
                                    onClick={() => void changePeriod(task, period, "complete")}
                                  >
                                    完成本期
                                  </Button>
                                  <Button
                                    variant="outline"
                                    disabled={busy}
                                    aria-label={`跳过 ${period.localDate}`}
                                    onClick={() => void changePeriod(task, period, "skip")}
                                  >
                                    跳过本期
                                  </Button>
                                  <Button
                                    variant="outline"
                                    disabled={
                                      busy || task.state === "paused" || task.state === "cancelled"
                                    }
                                    aria-label={`稍后提醒 ${period.localDate}`}
                                    onClick={() => void changePeriod(task, period, "snooze")}
                                  >
                                    本期一小时后提醒
                                  </Button>
                                </div>
                              )}
                            </div>
                          ))}
                          {hasOlderPeriods && (
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() => {
                                const last = periods[periods.length - 1];
                                if (last)
                                  void taskOccurrences(task.id, last.periodIndex)
                                    .then((more) => {
                                      if (useTaskCenter.getState().selectedId === task.id) {
                                        setPeriods((current) => [...current, ...more]);
                                        setHasOlderPeriods(more.length === 50);
                                      }
                                    })
                                    .catch((e) => setError(String(e)));
                              }}
                            >
                              加载更早各期
                            </Button>
                          )}
                        </>
                      )}
                      {snapshot.notifications
                        .filter((n) => n.taskId === task.id)
                        .map((n) => (
                          <div key={n.id} className="text-xs">
                            <p className="whitespace-pre-wrap">{n.body}</p>
                            <p className="text-muted-foreground">
                              桌面通知：{DELIVERY_LABEL[n.nativeState] ?? n.nativeState}
                              {n.nativeError ? ` · ${n.nativeError}` : ""}
                            </p>
                          </div>
                        ))}
                      {runs.map((r) => (
                        <p key={r.id} className="break-words text-xs text-muted-foreground">
                          {new Date(r.startedAt).toLocaleString()} · {RUN_LABEL[r.state] ?? r.state}
                          {r.reason ? ` · ${r.reason}` : ""}
                        </p>
                      ))}
                    </div>
                  )}
                </article>
              ))}
              {selectedId && !selected && <p className="text-sm">未找到此任务，请刷新后重试。</p>}
            </section>
            <form
              ref={form}
              key={editing?.id ?? "new"}
              onSubmit={(e) => void submit(e)}
              className="space-y-3"
            >
              <h3 className="text-sm font-medium">{editing ? "修改任务" : "创建任务"}</h3>
              <label className="block text-xs">
                标题
                <Input name="title" required maxLength={256} defaultValue={editing?.input.title} />
              </label>
              <label className="block text-xs">
                提醒内容或检查目标
                <textarea
                  name="prompt"
                  required
                  maxLength={16000}
                  rows={4}
                  defaultValue={editing?.input.prompt}
                  className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm"
                />
              </label>
              <label className="block text-xs">
                重复规则
                <select
                  aria-label="重复规则"
                  className="mt-1 block w-full rounded border border-border bg-background p-1"
                  value={calendar?.frequency ?? (intervalMinutes !== null ? "interval" : "once")}
                  disabled={!!editing?.input.calendar && editing.state !== "needs_confirmation"}
                  onChange={(e) => {
                    reviseCalendar(
                      e.target.value === "once" || e.target.value === "interval"
                        ? null
                        : newCalendar(e.target.value as CalendarSpec["frequency"]),
                    );
                    setIntervalMinutes(e.target.value === "interval" ? 5 : null);
                    const kind = form.current?.elements.namedItem(
                      "kind",
                    ) as HTMLSelectElement | null;
                    if (kind && e.target.value !== "once") kind.value = "reminder";
                  }}
                >
                  <option value="once">仅一次</option>
                  <option value="interval">按分钟间隔</option>
                  <option value="daily">每天</option>
                  <option value="weekly">每周</option>
                  <option value="monthly">每月</option>
                  <option value="yearly">每年</option>
                </select>
              </label>
              <label className="block text-xs">
                类型
                <select
                  name="kind"
                  defaultValue={editing?.input.kind ?? "reminder"}
                  className="mt-1 block w-full rounded border border-border bg-background p-1"
                >
                  <option value="reminder">固定提醒（直接通知）</option>
                  <option
                    value="agent_check"
                    disabled={!settings.agentTaskTools || !!calendar || intervalMinutes !== null}
                  >
                    Agent 检查（需要判断）
                  </option>
                </select>
              </label>
              {calendar ? (
                <CalendarFields
                  value={calendar}
                  preview={preview}
                  anchorLocked={!!editing?.input.calendar && editing.state !== "needs_confirmation"}
                  onChange={reviseCalendar}
                />
              ) : intervalMinutes !== null ? (
                <div className="space-y-2">
                  <label className="block text-xs">
                    每隔多少分钟
                    <Input
                      type="number"
                      min={1}
                      max={1440}
                      step={1}
                      required
                      value={Number.isFinite(intervalMinutes) ? intervalMinutes : ""}
                      onChange={(e) =>
                        setIntervalMinutes(
                          e.target.value === "" ? Number.NaN : Number(e.target.value),
                        )
                      }
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    保存后 {Number.isFinite(intervalMinutes) ? intervalMinutes : "…"}{" "}
                    分钟首次提醒，之后重复，直到暂停或结束。休眠后恢复只补一次；编辑保存会重新计时。
                  </p>
                </div>
              ) : (
                <label className="block text-xs">
                  首次执行时间（本机时区）
                  <Input
                    name="due"
                    type="datetime-local"
                    required
                    defaultValue={localInputTime(editing?.nextCheckAt ?? Date.now() + 60 * 60_000)}
                  />
                </label>
              )}
              <label className="block text-xs">
                执行会话（仅 Agent 检查需要）
                <select
                  name="thread"
                  defaultValue={editing?.input.executionThreadId ?? ""}
                  className="mt-1 block w-full rounded border border-border bg-background p-1"
                >
                  <option value="">请选择</option>
                  {threads
                    .filter((t) => t.sessionId)
                    .map((t) => (
                      <option key={t.threadId} value={t.threadId}>
                        {t.title}
                        {t.archived ? "（已归档，仍可执行）" : ""}
                      </option>
                    ))}
                </select>
              </label>
              <div className="flex gap-2">
                <label className="min-w-0 text-xs">
                  Agent 执行次数上限
                  <Input
                    name="maxRuns"
                    type="number"
                    min={1}
                    max={100}
                    required
                    defaultValue={editing?.input.maxRuns ?? 20}
                  />
                </label>
                <label className="min-w-0 text-xs">
                  单次超时（秒）
                  <Input
                    name="timeoutSeconds"
                    type="number"
                    min={30}
                    max={3600}
                    required
                    defaultValue={editing?.input.timeoutSeconds ?? 300}
                  />
                </label>
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input name="quiet" type="checkbox" defaultChecked={!!editing?.input.quietHours} />
                22:00–08:00 延后桌面通知（本机时区）
              </label>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy || !isTauri()}>
                  {busy
                    ? "正在保存…"
                    : calendar && !preview
                      ? "预览周期计划"
                      : calendar && preview?.issues.length
                        ? "保存待确认计划"
                        : editing
                          ? "保存修改"
                          : calendar
                            ? "登记周期计划"
                            : "登记任务"}
                </Button>
                {editing && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setEditing(null);
                      reviseCalendar(null);
                      setIntervalMinutes(null);
                    }}
                  >
                    放弃修改
                  </Button>
                )}
              </div>
            </form>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={open && !!operation}
        onOpenChange={(value) => {
          if (!value && !busy) setOperation(null);
        }}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogTitle>{operation?.kind === "delete" ? "删除任务" : "重新启用任务"}</DialogTitle>
          <DialogDescription>
            {operation?.kind === "delete"
              ? `删除“${operation.task.input.title}”及其执行记录、周期记录和应用内通知，不可撤销。聊天与个人记忆保留；已经弹出的系统通知不保证撤回。`
              : `重新启用“${operation?.task.input.title}”，保留已有历史，过去的提醒不补发。`}
          </DialogDescription>
          {operation && (
            <form className="space-y-3" onSubmit={(event) => void confirmOperation(event)}>
              {operation.kind === "reopen" && (
                <>
                  {!operation.task.input.calendar && !operation.task.input.intervalMinutes && (
                    <label className="block text-xs">
                      新的执行时间（本机时区）
                      <Input
                        name="at"
                        type="datetime-local"
                        required
                        defaultValue={localInputTime(
                          Math.max(operation.task.input.dueAt, Date.now() + 3600000),
                        )}
                      />
                    </label>
                  )}
                  {!!operation.task.input.intervalMinutes && (
                    <p className="text-sm">
                      确认后 {operation.task.input.intervalMinutes} 分钟首次提醒，之后正常重复。
                    </p>
                  )}
                  {operation.task.input.calendar && (
                    <p className="text-sm">
                      沿用原周期与 {operation.task.input.calendar.timezone}{" "}
                      时区，保留已完成、跳过及待处理期次。规则不完整时仍需补充确认。
                    </p>
                  )}
                  {operation.task.input.calendar?.untilDate && (
                    <label className="block text-xs">
                      新的结束日期（可留空持续提醒）
                      <Input
                        name="until"
                        type="date"
                        min={operation.task.input.calendar.untilDate}
                        defaultValue={operation.task.input.calendar.untilDate}
                      />
                    </label>
                  )}
                  {operation.task.input.kind === "agent_check" && (
                    <>
                      <p className="text-sm">
                        累计已执行 {operation.task.runCount} 次，不会清零；提高上限会授权额外的
                        Agent 执行。
                      </p>
                      {operation.task.runCount >= 100 && (
                        <p className="text-sm text-destructive">
                          已达到累计100次的上限，请新建任务。
                        </p>
                      )}
                      <label className="block text-xs">
                        累计执行次数上限
                        <Input
                          name="maxRuns"
                          type="number"
                          min={operation.task.runCount + 1}
                          max={100}
                          required
                          defaultValue={operation.task.input.maxRuns}
                        />
                      </label>
                    </>
                  )}
                </>
              )}
              {operationError && (
                <p role="alert" className="text-sm text-destructive">
                  {operationError}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setOperation(null)}
                >
                  返回
                </Button>
                <Button
                  type="submit"
                  variant={operation.kind === "delete" ? "destructive" : "default"}
                  disabled={
                    busy ||
                    (operation.kind === "reopen" &&
                      operation.task.input.kind === "agent_check" &&
                      operation.task.runCount >= 100)
                  }
                >
                  {operation.kind === "delete" ? "确认删除" : "确认重新启用"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
