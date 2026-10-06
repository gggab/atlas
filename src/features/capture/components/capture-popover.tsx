import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Binding, CaptureHealth, Detection, ImportPreview } from "../types";

export function CapturePopover({
  projectPath,
  health,
  onChanged,
  onClose,
}: {
  projectPath: string;
  health: CaptureHealth | null;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [binding, setBinding] = useState<Binding | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detection, setDetection] = useState<Detection | null>(null);
  const [gitAvailable, setGitAvailable] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  useEffect(() => {
    let active = true;
    setBusy(true);
    void Promise.all([
      invoke<Binding | null>("capture_binding", { projectPath }),
      invoke<Detection>("capture_detect", { projectPath }),
      invoke<boolean>("capture_git_available"),
      invoke<ImportPreview>("capture_import_preview", { projectPath }),
    ])
      .then(([value, detected, git, history]) => {
        if (active) {
          setBinding(value);
          setDetection(detected);
          setGitAvailable(git);
          setPreview(history);
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [projectPath]);
  async function change(command: "toggle" | "import" | "git" | "retry") {
    setBusy(true);
    setError(null);
    try {
      if (command === "toggle") {
        if (binding?.enabled) await invoke("capture_disable", { projectPath });
        else await invoke("capture_enable", { projectPath, mode: "local" });
      } else if (command === "import") await invoke("capture_import_confirm", { projectPath });
      else if (command === "git") await invoke("capture_git_init", { projectPath });
      else await invoke("capture_retry_watcher", { projectPath });
      setBinding(await invoke<Binding | null>("capture_binding", { projectPath }));
      setDetection(await invoke<Detection>("capture_detect", { projectPath }));
      setPreview(await invoke<ImportPreview>("capture_import_preview", { projectPath }));
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="w-[352px] p-3 space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <strong>Local session recording</strong>
        <button aria-label="Close recording settings" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="text-muted-foreground">
        Sessions and Git checkpoints stay in this project's .atlas directory.
      </p>
      <p>{health?.summary ?? (binding?.enabled ? "Recording enabled" : "Recording is off")}</p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <button
        disabled={busy}
        className="rounded border px-3 py-1 disabled:opacity-50"
        onClick={() => void change("toggle")}
      >
        {busy ? "Loading…" : binding?.enabled ? "Pause recording" : "Enable recording"}
      </button>
      {binding?.enabled && (
        <button
          disabled={busy}
          className="rounded border px-3 py-1 disabled:opacity-50"
          onClick={() => void change("import")}
        >
          Import CLI history{preview ? ` (${preview.newSessionCount} new)` : ""}
        </button>
      )}
      {!detection?.isGitRepository && gitAvailable && (
        <button
          disabled={busy}
          className="rounded border px-3 py-1"
          onClick={() => void change("git")}
        >
          Initialize Git checkpoints
        </button>
      )}
      {health?.issues.map((issue, index) => (
        <p key={index}>
          {issue.reason} {issue.nextStep}
        </p>
      ))}
      {health?.state === "stopped" && (
        <button
          disabled={busy}
          className="rounded border px-3 py-1"
          onClick={() => void change("retry")}
        >
          Retry recording
        </button>
      )}
    </div>
  );
}
