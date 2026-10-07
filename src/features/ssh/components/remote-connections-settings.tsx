import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Server, Terminal } from "lucide-react";
import { Dialog } from "@base-ui/react/dialog";
import { ssh, type Association, type Connection } from "../lib/api";
import { useSshStore } from "../stores/ssh-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { openRemoteExecution } from "./ssh-host";

const blank = {
  id: null as string | null,
  name: "",
  purpose: "",
  host: "",
  port: 22,
  username: "",
};
const field =
  "w-full rounded border border-border bg-background px-3 py-2 text-xs outline-none focus:border-primary";
const button =
  "rounded border border-border px-3 py-1.5 text-xs hover:bg-element-hover disabled:opacity-50";

export function RemoteConnectionsSettings() {
  const connections = useSshStore((s) => s.connections);
  const error = useSshStore((s) => s.error);
  const refresh = useSshStore((s) => s.refresh);
  const project = useSshStore((s) => s.selectedProject);
  const selectProject = useSshStore((s) => s.selectProject);
  const projects = useProjectStore((s) => s.projects);
  const [draft, setDraft] = useState<typeof blank | null>(null);
  const [password, setPassword] = useState("");
  const [sudoPassword, setSudoPassword] = useState("");
  const [removeSudo, setRemoveSudo] = useState(false);
  const [associations, setAssociations] = useState<Association[]>([]);
  const [observed, setObserved] = useState<{ id: string; fingerprint: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Connection | null>(null);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    let active = true;
    if (project)
      void ssh
        .associations(project)
        .then((rows) => {
          if (active) setAssociations(rows);
        })
        .catch((e) => toast.error(String(e)));
    else setAssociations([]);
    return () => {
      active = false;
    };
  }, [project, connections]);
  const act = async (operation: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await operation();
      await refresh();
      if (success) toast.success(success);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };
  const edit = (c?: Connection) => {
    setDraft(
      c
        ? {
            id: c.id,
            name: c.name,
            purpose: c.purpose,
            host: c.host,
            port: c.port,
            username: c.username,
          }
        : { ...blank },
    );
    setPassword("");
    setSudoPassword("");
    setRemoveSudo(false);
    setObserved(null);
  };
  const save = async () => {
    if (!draft) return;
    await act(async () => {
      await ssh.save(draft, password || undefined, removeSudo ? "" : sudoPassword || undefined);
      setPassword("");
      setSudoPassword("");
      setDraft(null);
    }, "Connection saved. Verify its fingerprint before first use.");
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-4">
        <Server size={16} />
        <h2 className="text-sm font-semibold">Remote connections</h2>
        <select
          aria-label="Connection scope"
          className={`${field} ml-auto max-w-[240px]`}
          value={project}
          onChange={(e) => selectProject(e.target.value)}
        >
          <option value="">All connections</option>
          {projects.map((p) => (
            <option key={p.id} value={p.path}>
              {p.name} · project associations
            </option>
          ))}
        </select>
        <button
          className={button}
          onClick={() => {
            selectProject("");
            edit();
          }}
        >
          <Plus size={12} className="inline mr-1" />
          Add SSH connection
        </button>
        <button className={button} onClick={openRemoteExecution}>
          <Terminal size={12} className="inline mr-1" />
          Execution view
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-4">
        <p className="text-xs text-muted-foreground">
          Passwords stay in Windows Credential Manager or macOS Keychain. Agent access requires your
          approval for each agent session.
        </p>
        {error && (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        )}
        {project && (
          <p className="text-xs text-muted-foreground">
            Successful authorized agent connections associate automatically. Removing an association
            prevents automatic re-addition; it does not revoke access.
          </p>
        )}
        {draft && (
          <form
            className="grid max-w-[640px] grid-cols-2 gap-3 rounded-lg border border-border p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <h3 className="col-span-2 text-sm font-medium">
              {draft.id ? "Edit SSH connection" : "New SSH connection"}
            </h3>
            {(["name", "host", "username", "purpose"] as const).map((key) => (
              <label key={key} className="text-xs capitalize">
                {key}
                <input
                  required={key !== "purpose"}
                  className={`${field} mt-1`}
                  value={draft[key]}
                  onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                />
              </label>
            ))}
            <label className="text-xs">
              Port
              <input
                type="number"
                min={1}
                max={65535}
                required
                className={`${field} mt-1`}
                value={draft.port}
                onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })}
              />
            </label>
            <label className="text-xs">
              SSH password
              <input
                type="password"
                autoComplete="new-password"
                required={!draft.id}
                placeholder={draft.id ? "Leave empty to keep saved password" : "Required"}
                className={`${field} mt-1`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="text-xs">
              Optional sudo password
              <input
                type="password"
                autoComplete="new-password"
                disabled={removeSudo}
                placeholder="Defaults to SSH password"
                className={`${field} mt-1`}
                value={sudoPassword}
                onChange={(e) => setSudoPassword(e.target.value)}
              />
            </label>
            {draft.id && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={removeSudo}
                  onChange={(e) => setRemoveSudo(e.target.checked)}
                />
                Remove saved sudo password
              </label>
            )}
            <div className="col-span-2 flex justify-end gap-2">
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setPassword("");
                  setSudoPassword("");
                }}
              >
                Cancel
              </button>
              <button className={button} disabled={busy} type="submit">
                Save
              </button>
            </div>
          </form>
        )}
        {!connections.length && !draft && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Add your first SSH connection.
          </p>
        )}
        {connections.map((c) => {
          const association = associations.find((a) => a.connection_id === c.id);
          return (
            <div key={c.id} className="rounded-lg border border-border p-4 text-xs">
              <div className="flex flex-wrap items-start gap-3">
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold">{c.name}</h3>
                  <p className="mt-1 break-all font-mono">
                    {c.username}@{c.host}:{c.port}
                  </p>
                  <p className="mt-1 text-muted-foreground">{c.purpose}</p>
                </div>
                {project ? (
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await ssh.associate(project, c.id, !!association && !association.excluded);
                        setAssociations(await ssh.associations(project));
                      })
                    }
                  >
                    {association && !association.excluded ? "Remove association" : "Associate"}
                  </button>
                ) : (
                  <>
                    <button className={button} disabled={busy} onClick={() => edit(c)}>
                      Edit
                    </button>
                    <button className={button} disabled={busy} onClick={() => setDeleting(c)}>
                      Delete
                    </button>
                  </>
                )}
              </div>
              {project && (
                <p className="mt-2 text-muted-foreground">
                  {association?.excluded
                    ? "Excluded from automatic association"
                    : association
                      ? `${association.source === "auto" ? "Automatic" : "Manual"} association${association.last_used_at ? ` · last used ${new Date(association.last_used_at * 1000).toLocaleString()}` : ""}`
                      : "Not associated"}
                </p>
              )}
              <p className="mt-3 break-all font-mono text-muted-foreground">
                {c.fingerprint ?? "Host fingerprint not verified"}
              </p>
              {!project && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void act(async () =>
                        setObserved({ id: c.id, fingerprint: await ssh.probe(c.id) }),
                      )
                    }
                  >
                    Fetch fingerprint
                  </button>
                  <button
                    className={button}
                    disabled={busy || !c.fingerprint}
                    onClick={() => void act(() => ssh.test(c.id), "SSH login successful")}
                  >
                    Test connection
                  </button>
                  <span className="self-center text-muted-foreground">
                    Password {c.has_password ? "saved" : "missing"}
                    {c.has_sudo_password ? " · sudo password saved" : ""}
                  </span>
                </div>
              )}
              {observed?.id === c.id && (
                <div className="mt-3 rounded border border-warning/40 p-3">
                  <p className="break-all font-mono">{observed.fingerprint}</p>
                  <p className="mt-2 text-muted-foreground">
                    Compare this fingerprint with a trusted server-side source before accepting.
                  </p>
                  <button
                    className={`${button} mt-2`}
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await ssh.trust(c.id, observed.fingerprint);
                        setObserved(null);
                      }, "Fingerprint verified")
                    }
                  >
                    I verified this fingerprint · Trust
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Dialog.Root
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-overlay scrim backdrop-blur-xl" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-modal w-[420px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-5 shadow-xl">
            <Dialog.Title className="text-sm font-semibold">Delete SSH connection?</Dialog.Title>
            <Dialog.Description className="mt-2 text-xs text-muted-foreground">
              Delete {deleting?.name} and its saved credentials? Access will be revoked and project
              associations removed.
            </Dialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <button
                autoFocus
                disabled={busy}
                className={button}
                onClick={() => setDeleting(null)}
              >
                Cancel
              </button>
              <button
                disabled={busy}
                className={button}
                onClick={() => {
                  if (deleting)
                    void act(async () => {
                      await ssh.remove(deleting.id);
                      setDeleting(null);
                    });
                }}
              >
                Delete connection
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
