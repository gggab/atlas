import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Terminal, Square, Server } from "lucide-react";
import { ssh } from "../lib/api";
import { useSshStore } from "../stores/ssh-store";

export function RemoteExecutionPanel() {
  const sessions = useSshStore((s) => s.sessions);
  const authorizations = useSshStore((s) => s.authorizations);
  const jobs = useSshStore((s) => s.jobs);
  const refresh = useSshStore((s) => s.refresh);
  const timeline = useMemo(
    () => [...jobs].reverse().sort((a, b) => a.started_at - b.started_at),
    [jobs],
  );
  const transcript = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  useLayoutEffect(() => {
    const el = transcript.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [timeline, following]);
  const act = async (operation: Promise<unknown>) => {
    try {
      await operation;
      await refresh();
    } catch (error) {
      toast.error(String(error));
    }
  };
  return (
    <div className="atlas-ssh-terminal flex h-full min-h-0 flex-col bg-[var(--atlas-terminal-background)] text-[var(--atlas-terminal-foreground)] [color-scheme:dark]">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 bg-card px-3 py-1.5 text-xs">
        <Terminal size={14} />
        <span>Remote execution</span>
        <span
          className="ml-auto text-muted-foreground"
          title="Commands run by Atlas; interactive input is not available"
        >
          Read-only
        </span>
        {!following && (
          <button
            className="rounded border border-border px-2 py-0.5 hover:bg-element-hover"
            onClick={() => setFollowing(true)}
          >
            Latest output ↓
          </button>
        )}
      </div>
      <div className="shrink-0 border-b border-border/60 bg-card">
        {authorizations.map((grant) => {
          const session = sessions.find(
            (s) =>
              s.caller.session_id === grant.caller.session_id &&
              s.caller.agent === grant.caller.agent &&
              s.caller.project === grant.caller.project &&
              s.connection.id === grant.connection.id &&
              s.connection.revision === grant.connection.revision,
          );
          return (
            <div
              key={`${grant.caller.session_id}-${grant.id}`}
              role="group"
              aria-label={`${grant.connection.name} · ${grant.caller.agent} · ${grant.caller.session_id.slice(0, 8)}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-xs"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <Server size={12} />
                <span className="font-medium">{grant.connection.name}</span>
                <span className="break-all font-mono text-muted-foreground">
                  {grant.connection.username}@{grant.connection.host}:{grant.connection.port}
                </span>
                <span
                  className={
                    session ? "text-[var(--atlas-terminal-ansi-green)]" : "text-muted-foreground"
                  }
                >
                  Authorized · {session ? "Connected" : "Not connected"}
                </span>
                <span
                  className="text-muted-foreground"
                  title={`${grant.caller.project} · ${grant.caller.session_id}`}
                >
                  Agent session: {grant.caller.agent} · {grant.caller.session_id.slice(0, 8)}
                </span>
              </div>
              <div className="ml-auto flex flex-wrap gap-2">
                {session && (
                  <button
                    className="rounded border border-border px-2 py-0.5 hover:bg-element-hover"
                    title="Close SSH; this agent session remains authorized to reconnect"
                    aria-label={`Disconnect ${grant.connection.name}`}
                    onClick={() => void act(ssh.disconnect(session.id))}
                  >
                    Disconnect
                  </button>
                )}
                <button
                  className="rounded border border-border px-2 py-0.5 hover:bg-element-hover"
                  title="Remove this agent session’s access and disconnect SSH"
                  aria-label={`Revoke authorization for ${grant.connection.name}`}
                  onClick={() => void act(ssh.revoke(grant.caller.session_id, grant.connection.id))}
                >
                  Revoke access
                </button>
              </div>
            </div>
          );
        })}
        {!authorizations.length && (
          <p className="px-3 py-1.5 text-xs text-muted-foreground">
            No authorized SSH connections. Ask an agent to request access when needed.
          </p>
        )}
      </div>
      <div
        ref={transcript}
        role="region"
        aria-label="Remote command history"
        className="flex-1 min-h-0 overflow-auto px-2 py-2 text-md leading-[20px] select-text selection:bg-[var(--atlas-selection-background)]"
        style={{
          fontFamily:
            '"Cascadia Mono", Consolas, "SFMono-Regular", Menlo, "Liberation Mono", monospace',
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
        }}
      >
        {timeline.map((job) => (
          <article key={job.id} aria-label={`Command: ${job.command}`} className="mb-2 last:mb-0">
            <pre className="whitespace-pre-wrap break-all font-[inherit]">
              <span className="font-bold text-[var(--atlas-terminal-ansi-green)]">
                {job.target || job.connection_name}
              </span>
              {" $ "}
              {job.sudo ? "sudo " : ""}
              {job.command}
            </pre>
            <pre
              aria-label="Remote command output"
              className="whitespace-pre-wrap break-words font-[inherit]"
            >
              {job.output || (job.status === "running" ? "Waiting for output…" : "No output")}
              {job.truncated && "\n[Output capped at 1 MiB]"}
            </pre>
            <div className="flex flex-wrap items-center justify-between gap-x-2 text-xs leading-[18px] text-muted-foreground">
              <span title={`${job.caller.project} · ${job.caller.session_id}`}>
                {job.status} · exit {job.exit_code ?? "—"} ·{" "}
                {Math.max(0, (job.finished_at ?? Math.floor(Date.now() / 1000)) - job.started_at)}s
                {" · "}
                {job.caller.agent} · {job.caller.session_id.slice(0, 8)}
              </span>
              {job.status === "running" && (
                <button
                  className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-0.5 hover:bg-element-hover"
                  aria-label={`Stop command: ${job.command}`}
                  onClick={() => void act(ssh.cancel(job.id))}
                >
                  <Square size={11} /> Request stop
                </button>
              )}
            </div>
            {job.status.endsWith("unknown") && (
              <p className="text-[var(--atlas-terminal-ansi-yellow)]">
                Remote side effects may have occurred. Check the server before retrying.
              </p>
            )}
          </article>
        ))}
        {!timeline.length && (
          <div className="text-muted-foreground">Agent command output will appear here.</div>
        )}
      </div>
    </div>
  );
}
