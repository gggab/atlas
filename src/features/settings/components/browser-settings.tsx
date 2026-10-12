import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RefreshCw, Check } from "lucide-react";
import { toast } from "sonner";
import { isBrowserMock } from "@/lib/env";
import { browserUseQueryKey, useBrowserUse } from "@/features/browser/lib/browser-use-state";
import { SectionTitle, SettingRow, Toggle } from "./settings-controls";
import chromeIcon from "@/assets/browser-logos/chrome.svg";
import edgeIcon from "@/assets/browser-logos/edge.svg";

export function BrowserSettings() {
  const { data, error, refetch } = useBrowserUse();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
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
            {data.connection?.browsers.map(({ id, available }) => {
              const name = id === "chrome" ? "Google Chrome" : "Microsoft Edge";
              const connected = data.connection?.connected && data.connection.browser === id;
              return (
                <div key={id} className="rounded-lg border border-border bg-card p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <img
                      src={id === "chrome" ? chromeIcon : edgeIcon}
                      alt=""
                      width={20}
                      height={20}
                      className="mt-0.5 shrink-0"
                    />
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
                          : id === "edge"
                            ? "Install from Microsoft Edge Add-ons"
                            : `Install from ${name} Web Store`
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
                        : id === "edge"
                          ? "Install from Edge Add-ons"
                          : "Install from Chrome Web Store"}
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
            Each chat reuses its Atlas tab group and previously retained pages. New task pages close
            by default when finished. Kept pages release control between turns. Your existing tabs
            and login are preserved. Use the extension popup to share a tab or take over.
          </p>
        </>
      )}
    </div>
  );
}
