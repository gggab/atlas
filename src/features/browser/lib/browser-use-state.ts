import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isBrowserMock } from "@/lib/env";
import { safeUnlistenPromise } from "@/lib/safe-unlisten";

export interface BrowserSnapshot {
  paused: boolean;
  sessions: {
    sessionId: string;
    title: string;
    status: string;
    tabs: { id: string; title: string; url: string }[];
  }[];
  extensionPath?: string;
  connection?: {
    connected: boolean;
    browser?: string;
    selectedBrowser?: string;
    version?: string;
    error?: string;
    browsers: { id: "chrome" | "edge"; available: boolean; storeInstall?: boolean }[];
  };
}
export const browserUseQueryKey = ["browser-use"];
export function useBrowserUse() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: browserUseQueryKey,
    queryFn: () => invoke<BrowserSnapshot>("browser_use_snapshot"),
    enabled: !isBrowserMock,
  });
  useEffect(() => {
    if (isBrowserMock) return;
    const subscription = listen("atlas:browser-use-changed", () => {
      void client.invalidateQueries({ queryKey: browserUseQueryKey });
    });
    return () => safeUnlistenPromise(subscription);
  }, [client]);
  return query;
}
