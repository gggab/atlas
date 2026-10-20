import { startTransition, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, setAppStateWritable, type AppStateWire } from "../stores/app-store";
import { logEvent } from "@/features/log/lib/log";
import { primeMarkdownRenderer } from "@/lib/markdown-cache";
import { primeMarkdown } from "@/lib/markdown";
import { toast } from "sonner";

export function useAppBootstrap() {
  const hydrated = useAppStore.use.hydrated();
  const activeAttempt = useRef<{ cancelled: boolean } | null>(null);
  useEffect(
    () => () => {
      if (activeAttempt.current) activeAttempt.current.cancelled = true;
      activeAttempt.current = null;
    },
    [],
  );
  // Hydrate again if development hot updates reset the stores after the shell
  // is ready. The shell-ready flag only controls the boot skeleton; it cannot
  // prove that the current store instance has received its saved projects.
  // Bootstrap the Rust-owned `AppState` (currentProject + recentProjects). The Tauri invoke is async but fast
  // (~5–20 ms warm); until it resolves the WelcomeScreen and project-aware
  // panels render their empty/loading states.
  //
  // `startTransition` marks the welcome → project layout swap as non-urgent
  // so React can pause reconciliation between component subtrees and keep
  // the welcome UI interactive while the project layout mounts.
  //
  // Once hydration is done (success or failure) we dispatch `atlas:app-ready`
  // — the inline script in `index.html` listens for it and removes the
  // boot skeleton.
  useEffect(() => {
    if (hydrated || activeAttempt.current) return;
    const attempt = { cancelled: false };
    activeAttempt.current = attempt;
    setAppStateWritable(false);
    const signalReady = () => {
      const flag = window as unknown as { __atlasAppReady?: boolean };
      if (flag.__atlasAppReady) return;
      flag.__atlasAppReady = true;
      window.dispatchEvent(new CustomEvent("atlas:app-ready"));
    };

    (async () => {
      // A terminal `atlas <path>` launch stashes the path in Rust (single-shot,
      // so a window reload won't re-trigger). Consume it BEFORE hydrating: the
      // CLI project must be ADDED to the project list and switched to, but
      // hydrate replaces that list and fires its own `switchTo` — which would
      // both clobber the CLI project and swallow the CLI switch (`switching`
      // guard). So we suppress hydrate's auto-switch when a CLI path is present
      // and perform the CLI open as the sole, final switch.
      const cliPath = await invoke<string | null>("cli_take_initial_project_path").catch(
        () => null,
      );
      // `bootstrap_app_state` is the only read of `state.json` Atlas ever
      // performs, so a failure here is NOT "start empty and carry on": the
      // stores keep their empty defaults, `AppState::apply_patch` replaces the
      // persisted lists wholesale, and the unconditional quit flush would then
      // write that emptiness over the user's real projects and orgs. Retry
      // first — a transient IPC hiccup shouldn't cost a session.
      let snapshot: AppStateWire | null = null;
      for (let attempt = 1; attempt <= 3 && !snapshot; attempt++) {
        try {
          snapshot = await invoke<AppStateWire>("bootstrap_app_state");
        } catch (e) {
          console.warn(`bootstrap_app_state attempt ${attempt} failed:`, e);
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
          }
        }
      }
      if (attempt.cancelled) return;
      try {
        if (snapshot) {
          const payload = snapshot;
          startTransition(() => {
            // The stores are about to hold the user's real state, so writing
            // them back is safe from here on. Before this line they hold empty
            // defaults and persistence is denied — see `appStateWritable`.
            setAppStateWritable(true);
            useAppStore.getState().actions.hydrate(payload, { skipActiveSwitch: !!cliPath });
          });
        } else {
          // Every attempt failed. Come up in an explicitly READ-ONLY session
          // rather than letting the empty stores overwrite `state.json`: the
          // user's projects and orgs are still on disk, and a restart is what
          // brings them back. Without this the app looks merely "empty" and
          // then makes that permanent on quit.
          setAppStateWritable(false);
          logEvent({
            source: "atlas",
            kind: "bootstrap-failed",
            summary: "bootstrap_app_state failed after 3 attempts; app-state writes suspended",
            status: "failure",
          });
          toast.error(
            "DeskMate couldn't load your projects. Your saved data is safe on disk — restart DeskMate to get it back.",
            { duration: Infinity },
          );
          startTransition(() => {
            useAppStore.getState().actions.hydrate(
              {
                currentProject: null,
                recentProjects: [],
                version: 1,
              },
              { skipActiveSwitch: !!cliPath },
            );
          });
        }
      } finally {
        if (!attempt.cancelled) {
          // Only open the CLI path when we actually have a snapshot. Without
          // one there is no org to own the project, so `addProject` would
          // refuse anyway — and its "no organisation" toast would bury the
          // boot-failure one that actually tells the user what to do.
          if (cliPath && snapshot) {
            logEvent({
              source: "atlas",
              kind: "cli-launch-open-project",
              summary: `Adding project from CLI argv: ${cliPath}`,
              status: "success",
              payload: { path: cliPath },
            });
            await useAppStore
              .getState()
              .actions.openProject(cliPath)
              .catch((err) => {
                logEvent({
                  source: "atlas",
                  kind: "cli-launch-open-project-failed",
                  summary: `openProject failed: ${String(err)}`,
                  status: "failure",
                  payload: { error: String(err) },
                });
              });
          }
          signalReady();
          // First paint is done — pull in the main-thread markdown renderer
          // now so the first small chat block still parses synchronously. It
          // is deliberately NOT a static import (it would land in the eager
          // entry chunk); see `primeMarkdownRenderer`.
          primeMarkdownRenderer();
          primeMarkdown();
        }
      }
    })().finally(() => {
      if (activeAttempt.current === attempt) activeAttempt.current = null;
    });
  }, [hydrated]);
}
