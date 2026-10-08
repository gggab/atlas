import { invoke } from "@tauri-apps/api/core";
import { useQueryClient } from "@tanstack/react-query";
import { Popover } from "@base-ui/react/popover";
import { Globe, Square, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { isBrowserMock } from "@/lib/env";
import { browserUseQueryKey as queryKey, useBrowserUse } from "../lib/browser-use-state";
import { openSettingsSection } from "@/features/settings/lib/open-settings";

export function BrowserUseControls({ sessionId }: { sessionId?: string }) {
  const client = useQueryClient();
  const { data } = useBrowserUse();
  const session = data?.sessions.find((item) => item.sessionId === sessionId);
  if (!sessionId || isBrowserMock) return null;
  const act = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await client.invalidateQueries({ queryKey });
    } catch (error) {
      toast.error(String(error));
    }
  };
  return (
    <Popover.Root>
      <Popover.Trigger
        className="flex h-[26px] items-center gap-1 rounded-full border border-border bg-element-hover px-2 text-2xs text-muted-foreground"
        aria-label="Browser automation"
      >
        <Globe size={12} />
        <span>
          {data?.paused
            ? "Browser paused"
            : session
              ? `Browser · ${session.status}`
              : "Connect browser"}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} className="z-popover">
          <Popover.Popup className="w-72 rounded-lg border border-border bg-card p-3 shadow-md text-xs">
            <p className="font-medium text-foreground">Browser automation</p>
            <button
              type="button"
              className="mt-2 text-foreground"
              onClick={() => openSettingsSection("browser")}
            >
              Open browser settings
            </button>
            <p className="mt-2 text-muted-foreground" role="status">
              {data?.connection?.connected
                ? `${data.connection.browser ?? "Browser"} profile connected`
                : "Browser profile offline"}
              {data?.connection?.error && ` · ${data.connection.error}`}
            </p>
            {!session && !data?.paused && (
              <button
                type="button"
                className="mt-3 text-foreground"
                onClick={() => {
                  void act(() => invoke("browser_use_connect", { sessionId }));
                }}
              >
                Open Agent task tab
              </button>
            )}
            {session && (
              <>
                <p className="mt-1 text-muted-foreground">
                  Chrome / Edge extension · task and explicitly shared tabs
                </p>
                <p className="mt-2 text-foreground">{session.title}</p>
                <ul className="mt-2 space-y-1 text-muted-foreground">
                  {session.tabs.map((tab) => (
                    <li key={tab.id} className="truncate" title={tab.url}>
                      {tab.title || tab.url}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="mt-3 flex items-center gap-1 text-destructive"
                  onClick={() => {
                    void act(() => invoke("browser_use_stop", { sessionId }));
                  }}
                >
                  <Square size={12} />
                  Disconnect browser control
                </button>
              </>
            )}
            <button
              type="button"
              className="mt-3 flex items-center gap-1 text-foreground"
              onClick={() => {
                void act(() => invoke("browser_use_pause", { paused: !data?.paused }));
              }}
            >
              {data?.paused ? <Play size={12} /> : <Pause size={12} />}
              {data?.paused ? "Enable browser automation" : "Pause all browser automation"}
            </button>
            <p className="mt-2 text-2xs text-muted-foreground">
              Finished tasks close Agent-created tabs and remove their group. Only necessary handoff
              pages remain. Your existing tabs and login stay intact. Use the extension to take over
              for verification. An action already sent may have completed.
            </p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
