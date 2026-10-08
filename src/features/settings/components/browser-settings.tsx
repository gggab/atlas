import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQueryClient } from "@tanstack/react-query";
import { Globe, ExternalLink, RefreshCw, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { isBrowserMock } from "@/lib/env";
import { browserUseQueryKey, useBrowserUse } from "@/features/browser/lib/browser-use-state";
import { SectionTitle, SettingRow, Toggle } from "./settings-controls";

export function BrowserSettings() {
  const { data, error, refetch } = useBrowserUse();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await client.invalidateQueries({ queryKey: browserUseQueryKey });
    } catch (cause) {
      toast.error(String(cause));
    } finally {
      setBusy(false);
    }
  }
  const button =
    "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-element-hover disabled:opacity-40 disabled:cursor-not-allowed";
  return (
    <div className="space-y-6">
      <SectionTitle
        title="Browser control"
        subtitle="Let Agents work in your everyday Chrome or Edge profile"
      />
      {isBrowserMock ? (
        <p className="text-xs text-muted-foreground">
          Browser control requires the Atlas desktop app.
        </p>
      ) : error ? (
        <div role="alert" className="space-y-2 text-xs text-destructive">
          <p>{String(error)}</p>
          <button className={button} onClick={() => void refetch()}>
            Retry
          </button>
        </div>
      ) : !data ? (
        <p className="text-xs text-muted-foreground">Checking browser connection…</p>
      ) : (
        <>
          <SettingRow
            label="Allow browser control"
            description="Pausing releases active task pages. This preference is kept when Atlas restarts."
          >
            <Toggle
              checked={!data.paused}
              disabled={busy}
              onChange={(enabled) =>
                void act(() => invoke("browser_use_pause", { paused: !enabled }))
              }
            />
          </SettingRow>
          <div className="space-y-3">
            {data.connection?.browsers.map(({ id, available, storeInstall }) => {
              const name = id === "chrome" ? "Google Chrome" : "Microsoft Edge";
              const connected = data.connection?.connected && data.connection.browser === id;
              return (
                <div key={id} className="rounded-lg border border-border bg-card p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <Globe size={20} className="mt-0.5 text-muted-foreground" />
                    <div className="flex-1">
                      <p className="text-sm font-medium">{name}</p>
                      <p
                        role="status"
                        className={`mt-1 text-xs ${connected ? "text-success" : "text-muted-foreground"}`}
                      >
                        {connected
                          ? `Connected${data.connection?.version ? ` · v${data.connection.version}` : ""}`
                          : available
                            ? "Extension not connected"
                            : "Browser not found"}
                      </p>
                    </div>
                    {connected && <Check size={16} className="text-success" />}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      disabled={busy || !available}
                      className={button}
                      aria-label={
                        connected
                          ? `Manage ${name} extension`
                          : storeInstall
                            ? id === "edge"
                              ? "Install from Microsoft Edge Add-ons"
                              : `Install from ${name} Web Store`
                            : `Install in ${name}`
                      }
                      onClick={() =>
                        void act(() =>
                          invoke("browser_use_manage", {
                            browser: id,
                            action: connected ? "manage" : "install",
                          }),
                        )
                      }
                    >
                      <ExternalLink size={12} />
                      {connected
                        ? "Manage extension"
                        : storeInstall
                          ? id === "edge"
                            ? "Install from Edge Add-ons"
                            : "Install from Chrome Web Store"
                          : "Install extension"}
                    </button>
                    <button
                      disabled={busy || !available}
                      className={button}
                      aria-label={`Reconnect ${name}`}
                      onClick={() =>
                        void act(() =>
                          invoke("browser_use_manage", { browser: id, action: "reconnect" }),
                        )
                      }
                    >
                      <RefreshCw size={12} />
                      Use this browser
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {data.connection?.error && (
            <p role="alert" className="text-xs text-destructive">
              {data.connection.error}
            </p>
          )}
          <div className="rounded-lg border border-border p-4 space-y-3">
            <p className="text-sm font-medium">Install the development extension</p>
            <ol className="list-decimal pl-4 space-y-1 text-xs text-muted-foreground">
              <li>Open chrome://extensions or edge://extensions to load a local build.</li>
              <li>Enable Developer mode, choose Load unpacked, and select the folder below.</li>
              <li>Atlas connects automatically. No address or connection switch is needed.</li>
            </ol>
            <div className="flex gap-2">
              <input
                aria-label="Extension folder"
                readOnly
                value={data.extensionPath ?? ""}
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                onFocus={(event) => event.currentTarget.select()}
              />
              <button
                className={button}
                aria-label="Copy extension folder"
                onClick={() => {
                  void navigator.clipboard.writeText(data.extensionPath ?? "").then(
                    () => setCopied(true),
                    (cause) => toast.error(String(cause)),
                  );
                }}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <p className="text-2xs text-muted-foreground">
              Browser approval is required to install or remove an extension. Store listings become
              available after publication. When switching from the old extension ID, remove the old
              extension and forget its selected browser profile in Atlas before loading this folder.
              Only one Atlas app profile can own the extension in a browser profile.
            </p>
          </div>
          {data.connection?.browser && (
            <button
              disabled={busy}
              className={button}
              onClick={() => void act(() => invoke("browser_use_forget"))}
            >
              Forget selected browser profile
            </button>
          )}
          <p className="text-xs text-muted-foreground">
            Tasks open their own Atlas tab group and close temporary pages when finished. Necessary
            handoff pages remain for you to complete login or verification. Your existing tabs and
            login are preserved. Use the extension popup to share a tab or take over.
          </p>
        </>
      )}
    </div>
  );
}
