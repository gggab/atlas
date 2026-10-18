import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { agents, ensureAgent } from "@/features/chat/lib/agents-api";
import { snapshotMessageToWire } from "@/features/chat/lib/snapshot-message";
import { applyModeOnResume } from "@/features/chat/lib/resume-mode";
import { ChatPanel } from "@/features/chat/components/chat-panel";
import { composePrompt, type MentionData } from "@/features/chat/lib/mentions";
import type { ImageAttachment } from "@/types/agents";

import { useSwitchableAgents } from "@/features/agents/lib/agent-meta";
import { agentTypeFromPluginId, pluginIdForAgent, type ChatMessage } from "@/types/agent";
import { useTaskCenter } from "@/features/tasks/stores/task-center-store";
import { tasksSnapshot, type ScheduledTask } from "@/features/tasks/lib/tasks-api";
import {
  personalSnapshot,
  personalSession,
  savePersonalMemory,
  forgetPersonalMemory,
  confirmMemory,
  dismissMemory,
  confirmProposal,
  dismissProposal,
  sendPersonalMessage,
  type PersonalSnapshot,
  type PersonalMemory,
} from "../lib/personal-api";

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) return String(error.message);
  return String(error);
}

export function PersonalPanel({ tabId }: { tabId: string }) {
  const session = useChatStore((s) => s.sessions[tabId]);
  const installed = useSwitchableAgents();
  const [panelOpen, setPanelOpen] = useState(false);
  const [data, setData] = useState<PersonalSnapshot | null>(null);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const setText = (value: string) => useChatStore.getState().actions.setDraft(tabId, value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const [taskReceipt, setTaskReceipt] = useState<ScheduledTask | null>(null);
  const previousTasks = useRef<ScheduledTask[] | null>(null);
  const [context, setContext] = useState("");
  const [editing, setEditing] = useState<PersonalMemory | null>(null);
  const [memoryKey, setMemoryKey] = useState("");
  const [memoryContent, setMemoryContent] = useState("");
  const [kind, setKind] = useState<"fact" | "preference">("fact");
  const [confirmed, setConfirmed] = useState(true);
  const [core, setCore] = useState(false);
  const [relearn, setRelearn] = useState(false);
  const previousMemories = useRef<PersonalMemory[] | null>(null);
  const memoryEditor = useRef<HTMLFormElement>(null);
  const lastAgent = data?.conversations.find((c) => c.threadId === data.currentThreadId)?.agent;
  const preferredAgent = lastAgent && agentTypeFromPluginId(lastAgent);
  const selectedAgent =
    session?.agentType ||
    (preferredAgent && installed.includes(preferredAgent) ? preferredAgent : installed[0]) ||
    "";
  const messages = useMemo(() => {
    const history: ChatMessage[] = (data?.history ?? [])
      .filter((h) => h.sessionId !== session?.acpSessionId || !session?.messages.length)
      .flatMap((h) =>
        h.messages.map((m) => ({
          ...snapshotMessageToWire(m),
          toolCalls: snapshotMessageToWire(m).toolCalls.map((tool) => ({
            ...tool,
            duration: null,
          })),
          id: `${h.sessionId}:${m.id}`,
          model: m.model ?? undefined,
          fileChanges: [],
          plan: null,
        })),
      );
    return [...history, ...(session?.messages ?? [])].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );
  }, [data?.history, session?.acpSessionId, session?.messages]);

  const refresh = useCallback(async () => {
    const snapshot = await personalSnapshot();
    if (previousMemories.current) {
      const learned = snapshot.memories.filter(
        (m) =>
          m.origin === "automatic" &&
          !previousMemories.current!.some(
            (old) =>
              old.id === m.id &&
              old.revision === m.revision &&
              old.sourceMessageId === m.sourceMessageId,
          ),
      );
      if (learned.length)
        setReceipt(`已保存个人记忆：${learned.map((m) => m.key).join("、")}。现有提醒未自动修改。`);
    }
    previousMemories.current = snapshot.memories;
    setData(snapshot);
    try {
      const all = await tasksSnapshot();
      const sources = new Set(snapshot.conversations.map((c) => c.threadId));
      const personalTasks = all.tasks.filter(
        (t) =>
          t.input.kind === "reminder" &&
          !!t.input.sourceThreadId &&
          sources.has(t.input.sourceThreadId),
      );
      if (previousTasks.current) {
        const changed = personalTasks.find(
          (task) =>
            !previousTasks.current!.some(
              (old) => old.id === task.id && old.revision === task.revision,
            ),
        );
        if (changed) setTaskReceipt(changed);
      }
      previousTasks.current = personalTasks;
      setTasks(personalTasks);
      setTaskReceipt((previous) =>
        previous && !personalTasks.some((task) => task.id === previous.id) ? null : previous,
      );
      setError((previous) => (previous.startsWith("任务中心暂不可用：") ? "" : previous));
    } catch (e) {
      setError(`任务中心暂不可用：${errorText(e)}`);
    }
    return snapshot;
  }, []);

  useEffect(() => {
    if (data && !useChatStore.getState().sessions[tabId] && selectedAgent)
      useChatStore.getState().actions.createSession(tabId, selectedAgent);
  }, [data, selectedAgent, tabId]);

  const openConversation = useCallback(
    async (threadId?: string, agentType?: string) => {
      setContext("");
      const connected = threadId ? undefined : await ensureAgent(pluginIdForAgent(agentType));
      const result = await personalSession(connected?.agent_id, threadId);
      const snapshot = result.snapshot;
      const actions = useChatStore.getState().actions;
      actions.createSession(tabId, agentTypeFromPluginId(snapshot.plugin_id));
      const queued = [...(useChatStore.getState().queues[tabId] ?? [])];
      actions.clearSession(tabId);
      queued.forEach((text) => actions.enqueueMessage(tabId, text));
      actions.setSessionAgentType(tabId, agentTypeFromPluginId(snapshot.plugin_id));
      let messages = snapshot.messages;
      if (messages.length === 0)
        messages = await agents.replayTranscript(result.key.session_id, result.directory);
      actions.replaceMessages(tabId, messages.map(snapshotMessageToWire));
      actions.hydrateSessionSnapshot(tabId, snapshot.status, snapshot.plan);
      const boundAgentType = agentTypeFromPluginId(snapshot.plugin_id);
      const selectedModel = useChatStore.getState().sessions[tabId]?.acpCurrentModel;
      if (selectedModel && selectedModel !== snapshot.current_model)
        await agents.setModel(result.key, selectedModel);
      actions.setAcpModels(tabId, snapshot.current_model, snapshot.available_models ?? []);
      await applyModeOnResume(tabId, result.key, snapshot);
      actions.setAcpAvailableCommands(tabId, snapshot.available_commands ?? [], boundAgentType);
      actions.setAcpConfigOptions(tabId, snapshot.config_options ?? [], boundAgentType);
      actions.setAcpBinding(tabId, result.key.agent_id, result.key.session_id, result.directory);
      if (result.contextRestarted)
        setReceipt(
          "Agent 不支持恢复执行上下文，已在后台重新连接。聊天记录和个人资料仍保留；模型未读取此前聊天，引用旧内容时请补充说明。",
        );
      if (!result.toolsAvailable)
        setError(
          "此会话未获得个人记忆工具。已保存资料仍随消息提供；请用右侧面板保存记忆、用任务中心登记提醒，勿将模型口头回复当成保存回执。",
        );
      await refresh();
      return result.key;
    },
    [refresh, tabId],
  );

  useEffect(() => {
    let disposed = false;
    void refresh().catch((e) => {
      if (!disposed) setError(`个人空间不可用：${errorText(e)}`);
    });
    const onChange = () => {
      if (!disposed) void refresh().catch((e) => setError(errorText(e)));
    };
    const listeners = [
      listen("atlas:personal-changed", onChange),
      listen("atlas:tasks-changed", onChange),
    ];
    const prefill = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId: string; text: string }>).detail;
      if (detail?.tabId === tabId) useChatStore.getState().actions.setDraft(tabId, detail.text);
    };
    window.addEventListener("atlas:chat-prefill", prefill);
    return () => {
      disposed = true;
      listeners.forEach((p) => void p.then((stop) => stop()));
      window.removeEventListener("atlas:chat-prefill", prefill);
    };
  }, [refresh, tabId]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setReceipt("");
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const send = async (
    message: string,
    mentions: MentionData[] = [],
    attachments?: ImageAttachment[],
  ) => {
    if (!message.trim()) return;
    if (!data || !selectedAgent) {
      setText(message);
      setError("个人助手尚未准备好，消息已保留，请稍后重试或选择已接入的 Agent。");
      return;
    }
    setBusy(true);
    setError("");
    setReceipt("");
    const actions = useChatStore.getState().actions;
    setTaskReceipt(null);
    try {
      const current = useChatStore.getState().sessions[tabId];
      let key;
      if (
        current?.acpAgentId &&
        current.acpSessionId &&
        !current.disconnected &&
        current.agentType === selectedAgent &&
        (current.messages.length > 0 ||
          !data.history.some((h) => h.sessionId === current.acpSessionId && h.messages.length > 0))
      ) {
        key = {
          agent_id: current.acpAgentId,
          session_id: current.acpSessionId,
        };
      } else {
        const binding = [...data.conversations]
          .reverse()
          .find((c) => agentTypeFromPluginId(c.agent) === selectedAgent);
        const active = data.conversations.find(
          (c) =>
            c.threadId === data.currentThreadId && agentTypeFromPluginId(c.agent) === selectedAgent,
        );
        key = await openConversation((active ?? binding)?.threadId, selectedAgent);
      }
      if (useChatStore.getState().sessions[tabId]?.unrestoredModeId) {
        actions.setPendingSend(tabId, { content: message, mentions, attachments });
        return;
      }
      actions.addMessage(tabId, "user", message, attachments);
      actions.updateSessionStatus(tabId, "running");
      const composed = await composePrompt(message, mentions);
      const result = await sendPersonalMessage(
        key,
        composed.prose,
        attachments,
        composed.resourceLinks,
      );
      setContext(result.context);
      if (useChatStore.getState().drafts[tabId] === message) setText("");
    } catch (e) {
      const draft = useChatStore.getState().drafts[tabId] ?? "";
      const retained = draft && draft !== message ? `${message}\n${draft}` : message;
      setText(retained);
      window.dispatchEvent(
        new CustomEvent("atlas:chat-prefill", {
          detail: { tabId, text: retained },
        }),
      );
      actions.updateSessionStatus(tabId, "error");
      setError(`发送失败，草稿已保留：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const editMemory = (memory: PersonalMemory) => {
    setEditing(memory);
    setMemoryKey(memory.key);
    setMemoryContent(memory.content);
    setKind(memory.kind);
    setConfirmed(memory.confirmed);
    setCore(memory.core ?? false);
    setRelearn(false);
  };
  const rememberMessage = useCallback(
    (id: string) => {
      const message = messages.find((m) => m.id === id && m.role === "user");
      if (!message) return;
      setEditing(null);
      setMemoryKey("");
      setMemoryContent(message.content);
      setPanelOpen(true);
      setKind("fact");
      setConfirmed(true);
      setCore(false);
      setRelearn(false);
      setReceipt("原消息已放入记忆编辑器，请提炼要保存的内容并确认。尚未保存或创建提醒。");
      memoryEditor.current?.scrollIntoView({ block: "nearest" });
      memoryEditor.current?.querySelector<HTMLInputElement>("input")?.focus();
    },
    [messages],
  );
  const sourceIds = new Set(data?.conversations.map((c) => c.threadId));
  const reconnect = async () => {
    try {
      const binding = [...(data?.conversations ?? [])]
        .reverse()
        .find((c) => agentTypeFromPluginId(c.agent) === selectedAgent);
      return await openConversation(binding?.threadId, selectedAgent);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="flex h-full min-h-0" data-testid="personal-assistant">
      <section aria-label="个人聊天" className="min-w-0 flex-1">
        <ChatPanel
          tabId={tabId}
          personal={{
            messages,
            busy,
            onSend: send,
            onReconnect: reconnect,
            onRememberMessage: rememberMessage,
            actions: (
              <>
                <Button variant="ghost" onClick={() => useTaskCenter.getState().show()}>
                  任务中心{tasks.length ? ` · ${tasks.length}` : ""}
                </Button>
                <Button
                  variant="ghost"
                  aria-expanded={panelOpen}
                  onClick={() => setPanelOpen((open) => !open)}
                >
                  记忆与计划
                </Button>
              </>
            ),
            notice: (
              <>
                {error && (
                  <p role="alert" className="shrink-0 px-6 py-2 text-xs text-destructive">
                    {error}
                  </p>
                )}
                {receipt && (
                  <p role="status" className="shrink-0 px-6 py-2 text-xs text-muted-foreground">
                    {receipt}
                  </p>
                )}
                {taskReceipt && (
                  <div
                    role="status"
                    className="flex shrink-0 items-center gap-2 px-6 py-2 text-xs text-foreground"
                  >
                    <span>
                      {taskReceipt.state === "active" ? "提醒已登记" : "任务已保存"}：
                      {taskReceipt.input.title}
                      {taskReceipt.nextCheckAt
                        ? ` · ${new Date(taskReceipt.nextCheckAt).toLocaleString("zh-CN", { timeZone: taskReceipt.input.calendar?.timezone })} ${taskReceipt.input.calendar?.timezone ?? ""}`
                        : ""}
                    </span>
                    <Button
                      variant="link"
                      size="xs"
                      onClick={() => useTaskCenter.getState().show(taskReceipt.id)}
                    >
                      查看任务
                    </Button>
                  </div>
                )}
              </>
            ),
          }}
        />
      </section>
      {panelOpen && (
        <aside
          className="w-80 max-w-[45%] shrink-0 space-y-4 overflow-y-auto border-l border-border bg-card p-4 text-xs"
          aria-label="个人记忆和计划"
        >
          <p className="text-xs text-muted-foreground">
            日程默认在截止前30分钟提醒；只有日期时当天9点提醒。默认时间已过则跳过本次并告知，周期任务保留后续提醒。按电脑当前时区创建，可在任务中心修改。提醒需保持应用运行、电脑唤醒。
          </p>
          {context && (
            <details>
              <summary className="cursor-pointer text-xs">查看本轮提供的个人资料</summary>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{context}</pre>
            </details>
          )}
          <section className="space-y-2">
            <h2 className="font-medium">个人记忆</h2>
            <p className="text-xs text-muted-foreground">
              删除仅移除已保存记忆，不擦除聊天、模型已有上下文或厂商记录，也不停止独立计划。关联提醒可在下方或任务中心处理。
            </p>
            {data?.memories.map((memory) => (
              <article
                key={memory.id}
                className="space-y-1 rounded border border-border p-2 text-sm"
              >
                <div>
                  {memory.key} · {memory.confirmed ? "明确陈述" : "待核实"} · v{memory.revision}
                  {memory.core ? " · 每轮优先提供" : ""} ·{" "}
                  {memory.origin === "automatic" ? "自动提炼" : "手动保存或确认"}
                </div>
                <p className="whitespace-pre-wrap break-words">{memory.content}</p>
                <details>
                  <summary className="cursor-pointer text-xs">来源</summary>
                  <p className="break-all text-xs">
                    {memory.sourceThreadId === "ui"
                      ? "用户在记忆面板填写"
                      : `人类消息 ${memory.sourceMessageId}`}{" "}
                    · {new Date(memory.updatedAt).toLocaleString()}
                  </p>
                  {memory.evidenceQuote && (
                    <blockquote className="border-l border-border pl-2 text-xs text-muted-foreground">
                      原话：{memory.evidenceQuote}
                    </blockquote>
                  )}
                </details>
                <Button variant="ghost" disabled={busy} onClick={() => editMemory(memory)}>
                  编辑
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await forgetPersonalMemory(memory);
                      if (editing?.id === memory.id) {
                        setEditing(null);
                        setMemoryKey("");
                        setMemoryContent("");
                        setCore(false);
                        setRelearn(false);
                      }
                      setReceipt("已删除保存的记忆。聊天和独立提醒仍保留。");
                    })
                  }
                >
                  删除记忆
                </Button>
              </article>
            ))}
            <form
              className="space-y-2"
              ref={memoryEditor}
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await savePersonalMemory(
                    {
                      id: editing?.id,
                      expectedRevision: editing?.revision,
                      key: memoryKey,
                      kind,
                      content: memoryContent,
                      confirmed,
                      core,
                    },
                    relearn,
                  );
                  setEditing(null);
                  setMemoryKey("");
                  setMemoryContent("");
                  setCore(false);
                  setRelearn(false);
                  setReceipt("个人记忆已保存；此操作未创建或修改提醒。");
                });
              }}
            >
              <Input
                aria-label="记忆名称"
                placeholder="名称，如房租缴费日"
                value={memoryKey}
                maxLength={128}
                required
                onChange={(e) => setMemoryKey(e.target.value)}
              />
              <textarea
                aria-label="记忆内容"
                value={memoryContent}
                maxLength={4096}
                required
                onChange={(e) => setMemoryContent(e.target.value)}
                className="w-full rounded border border-border bg-background p-2 text-sm"
              />
              <select
                aria-label="记忆类型"
                value={kind}
                onChange={(e) => setKind(e.target.value as "fact" | "preference")}
                className="rounded border border-border bg-background p-1 text-sm"
              >
                <option value="fact">事实</option>
                <option value="preference">偏好</option>
              </select>
              <label className="ml-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />{" "}
                这是明确的信息
              </label>
              <label className="block text-xs">
                <input type="checkbox" checked={core} onChange={(e) => setCore(e.target.checked)} />{" "}
                每轮优先提供（最多5条，需为明确信息）
              </label>
              <label className="block text-xs">
                <input
                  type="checkbox"
                  checked={relearn}
                  onChange={(e) => setRelearn(e.target.checked)}
                />{" "}
                确认重新记住曾删除的信息
              </label>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy || !data}>
                  {editing ? "保存修改" : "保存记忆"}
                </Button>
                {editing && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setEditing(null);
                      setMemoryKey("");
                      setMemoryContent("");
                      setCore(false);
                      setRelearn(false);
                    }}
                  >
                    取消编辑
                  </Button>
                )}
              </div>
            </form>
          </section>
          <section className="space-y-2">
            <h2 className="font-medium">待确认的记忆（尚未生效）</h2>
            {data?.memoryCandidates.length === 0 && (
              <p className="text-xs text-muted-foreground">
                含糊信息会在这里等待你确认，不作为已确定事实使用。
              </p>
            )}
            {data?.memoryCandidates.map((candidate) => (
              <article
                key={candidate.id}
                className="space-y-2 rounded border border-border p-2 text-sm"
              >
                <strong>{candidate.input.key}</strong>
                <p>{candidate.input.content}</p>
                {candidate.input.question && <p>待确认：{candidate.input.question}</p>}
                {candidate.input.core && (
                  <p className="text-xs text-muted-foreground">
                    建议每轮优先提供这条信息，占用一个核心记忆位置。
                  </p>
                )}
                <blockquote className="border-l border-border pl-2 text-xs">
                  原话：{candidate.input.evidenceQuote}
                </blockquote>
                <p className="text-xs text-muted-foreground">
                  确认表示你认可上述具体对象和内容；存在待确认问题时，请先在聊天中澄清或编辑后保存。
                </p>
                <Button
                  disabled={busy || !!candidate.input.question?.trim()}
                  onClick={() =>
                    void act(async () => {
                      await confirmMemory(candidate);
                      setReceipt("这条个人记忆已确认保存，现有提醒未自动修改。");
                    })
                  }
                >
                  确认这条记忆
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    const current = candidate.input.id
                      ? data.memories.find((m) => m.id === candidate.input.id)
                      : undefined;
                    if (
                      candidate.input.id &&
                      (!current || current.revision !== candidate.input.expectedRevision)
                    ) {
                      setError("这份候选针对的记忆已变化，请检查当前条目后重新编辑。");
                      return;
                    }
                    setEditing(current ?? null);
                    setMemoryKey(candidate.input.key);
                    setMemoryContent(candidate.input.content);
                    setKind(candidate.input.kind);
                    setConfirmed(true);
                    setCore(candidate.input.core ?? current?.core ?? false);
                    setRelearn(false);
                    memoryEditor.current?.scrollIntoView({ block: "nearest" });
                    setReceipt("候选已放入编辑器，修改后保存；成功保存同一条目时会清除对应候选。");
                  }}
                >
                  编辑后保存
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await dismissMemory(candidate);
                      setReceipt("已放弃这条记忆候选。");
                    })
                  }
                >
                  放弃这条记忆
                </Button>
              </article>
            ))}
          </section>
          <section className="space-y-2">
            <h2 className="font-medium">计划草稿（尚未启用）</h2>
            {data?.proposals.length === 0 && (
              <p className="text-xs text-muted-foreground">助手提出的待确认计划会显示在这里。</p>
            )}
            {data?.proposals.map((proposal) => (
              <article
                key={proposal.id}
                className="space-y-2 rounded border border-border p-2 text-sm"
              >
                <strong>{proposal.input.title}</strong>
                <p>{proposal.input.prompt}</p>
                <p>
                  {proposal.input.calendar
                    ? `${proposal.input.calendar.frequency} · ${proposal.input.calendar.startDate} ${proposal.input.calendar.localTime} · ${proposal.input.calendar.timezone}`
                    : proposal.input.dueAt > 0
                      ? new Date(proposal.input.dueAt).toLocaleString()
                      : "首次提醒时间待补充"}
                  {proposal.input.intervalMinutes
                    ? `，每隔 ${proposal.input.intervalMinutes} 分钟`
                    : ""}
                </p>
                {proposal.input.calendar && (
                  <details>
                    <summary className="cursor-pointer">完整周期规则</summary>
                    <pre className="whitespace-pre-wrap text-xs">
                      {JSON.stringify(proposal.input.calendar, null, 2)}
                    </pre>
                  </details>
                )}
                {proposal.input.questions.map((question, i) => (
                  <p key={i}>待回答：{question}</p>
                ))}
                <p className="text-xs text-muted-foreground">
                  v{proposal.revision}；补充答案请在聊天中指明此计划名称。
                  {proposal.state === "registering" ? "登记结果待核对，可重试获取回执。" : ""}
                </p>
                <Button
                  disabled={busy || proposal.input.questions.length > 0}
                  onClick={() =>
                    void act(async () => {
                      const task = await confirmProposal(proposal);
                      setReceipt(
                        task.state === "needs_confirmation"
                          ? "计划已保存为待确认，尚未启用。请在任务中心补齐规则。"
                          : "提醒已登记。个人记忆是否保存以独立回执为准。",
                      );
                      useTaskCenter.getState().show(task.id);
                    })
                  }
                >
                  确认并登记
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy || proposal.state === "registering"}
                  onClick={() =>
                    void act(async () => {
                      await dismissProposal(proposal);
                      setReceipt("已放弃这份草稿。");
                    })
                  }
                >
                  放弃草稿
                </Button>
              </article>
            ))}
          </section>
          <section className="space-y-2">
            <h2 className="font-medium">个人提醒</h2>
            <p className="text-xs text-muted-foreground">
              完成本期与停止整个计划分别操作。更新个人记忆不会自动改动这些提醒。
            </p>
            {tasks
              .filter(
                (task) => !!task.input.sourceThreadId && sourceIds.has(task.input.sourceThreadId),
              )
              .map((task) => (
                <Button
                  key={task.id}
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => useTaskCenter.getState().show(task.id)}
                >
                  {task.input.title} · {task.state === "needs_confirmation" ? "待确认" : task.state}
                </Button>
              ))}
          </section>
        </aside>
      )}
    </div>
  );
}
