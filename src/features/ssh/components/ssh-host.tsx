import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Dialog } from "@base-ui/react/dialog";
import { toast } from "sonner";
import { useSshStore } from "../stores/ssh-store";
import { ssh } from "../lib/api";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";

export function openRemoteExecution() {
  useLayoutStore.getState().actions.addTab({
    id: "terminal-ssh",
    type: "terminal",
    title: "Remote execution",
    closable: true,
    dirty: false,
    data: { remote: true },
  });
}

export function SshHost() {
  const approval = useSshStore((s) => s.approvals[0]);
  const refresh = useSshStore((s) => s.refresh);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (scheduled || disposed) return;
      scheduled = setTimeout(() => {
        scheduled = undefined;
        if (!disposed) void refresh();
      }, 150);
    };
    const unlisten = listen("ssh-changed", schedule).catch(() => () => {});
    void refresh();
    const timer = setInterval(schedule, 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
      clearTimeout(scheduled);
      void unlisten.then((off) => off());
    };
  }, [refresh]);
  const decide = async (allow: boolean) => {
    if (!approval || busy) return;
    setBusy(true);
    try {
      await ssh.decide(approval.id, allow);
      await refresh();
      if (allow) openRemoteExecution();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };
  if (!approval) return null;
  const project = useProjectStore
    .getState()
    .projects.find((p) => p.path === approval.caller.project);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) void decide(false);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-overlay scrim backdrop-blur-xl" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-modal w-[460px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-5 shadow-xl">
          <Dialog.Title className="text-base font-semibold">Allow SSH connection?</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">
            Allow this agent session to execute commands with the remote account’s existing
            permissions. Credentials stay in Atlas.
          </Dialog.Description>
          <dl className="my-4 grid grid-cols-[90px_1fr] gap-2 text-xs break-all">
            <dt>Agent</dt>
            <dd>{approval.caller.agent}</dd>
            <dt>Session</dt>
            <dd className="font-mono">{approval.caller.session_id}</dd>
            <dt>Project</dt>
            <dd>{project?.name ?? (approval.caller.project || "No project")}</dd>
            <dt>Server</dt>
            <dd>{approval.connection.name}</dd>
            <dt>Account</dt>
            <dd>
              {approval.connection.username}@{approval.connection.host}:{approval.connection.port}
            </dd>
            <dt>Fingerprint</dt>
            <dd>{approval.connection.fingerprint}</dd>
            <dt>Duration</dt>
            <dd>Current agent session; revoke at any time</dd>
          </dl>
          <div className="flex justify-end gap-2">
            <button
              autoFocus
              disabled={busy}
              className="rounded border border-border px-3 py-2 text-xs"
              onClick={() => void decide(false)}
            >
              Deny
            </button>
            <button
              disabled={busy}
              className="rounded bg-primary px-3 py-2 text-xs text-primary-foreground"
              onClick={() => void decide(true)}
            >
              Allow this session
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
