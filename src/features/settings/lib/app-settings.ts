/**
 * The `AppSettings` schema and its defaults.
 *
 * Lives in the settings feature (not the project store) because that is the
 * domain that owns it: `atlas-config-api.ts` needs the type to describe its
 * own IPC surface, and importing it back out of the project store — which in
 * turn imports the api wrapper and runs listener registration at module scope
 * — made the two modules a cycle.
 */

import { DEFAULT_SCALE } from "./ui-scale";
import { DEFAULT_APP_ICON } from "./app-icons";
import type { ThemeMode } from "@/features/theme/lib/theme-api";
import type { ThemeOverride } from "@/features/theme/resolve-theme";

/**
 * App-wide preferences surfaced in Settings → General. Mirrors
 * `src-tauri/src/state/atlas_config.rs:AppSettings`. Defaults declared on
 * both sides; if you add a field, default it both places.
 */
export interface AppSettings {
  /** Auto-add `.atlas/` to each opened git project's `.gitignore`. */
  autoAddAtlasGitignore: boolean;
  /** Record Atlas-internal events (sign-in, agent lifecycle, etc.) into
   *  the Logs panel under the `atlas` source. */
  enableAtlasLogs: boolean;
  /** Show dotfiles / dot-directories in the explorer file tree. */
  showHiddenFiles: boolean;
  /** Global interface zoom (1 == 100%). Driven by the ⌘+/⌘-/⌘0 hotkeys;
   *  applied via the native WebView zoom. */
  uiScale: number;
  /** Selected on-device embedding model id (== dir name). Managed by the Local
   *  Model Manager; carried here so settings round-trips never clobber it. */
  embeddingModelId: string;
  /** One theme id for chrome, editor, terminal, diffs and syntax. */
  theme: string;
  /** Active variant preference. Light is persisted but hidden in Settings
   *  until the light-mode QA flag is enabled. */
  themeMode: ThemeMode;
  /** User-local patch applied after the active theme variant. */
  themeOverrides: ThemeOverride;
  /** File and folder icons, on their own track from the colour theme
   *  (decision 4). `"minimal"` keeps Atlas's own lucide icons; anything else
   *  names a VS Code icon theme — bundled, or installed from Open VSX. */
  iconTheme: string;
  /** macOS app icon, by id from `APP_ICONS` (`./app-icons`). The default is
   *  the icon the bundle ships with; any other replaces the Dock and Finder
   *  icon. Applied on the Rust side (`src-tauri/src/app_icon.rs`); ignored on
   *  other platforms. */
  appIcon: string;
  /** Adaptive next-step suggestion chips in the agent chat's per-turn card.
   *  "agent" (default) asks the coding agent to end each reply with a hidden
   *  `<next_steps>` block (uses the live session context, no BYOK); "off"
   *  disables it. (Legacy "parse"/"llm" values are treated as enabled.) */
  adaptiveSuggestions: "off" | "agent";
  /** What picking another agent does to a chat that has a conversation (see
   *  `switch-agent.ts`): "reset" (default) switches in place and starts over,
   *  "new-tab" keeps it and opens the new agent in a new tab, "handoff"
   *  switches in place and attaches it to the next message. */
  agentSwitchBehavior: "new-tab" | "handoff" | "reset";
  /** Before switching agents on a chat with a conversation, send the agent
   *  being left `/remember` (when it advertises it) and wait for it
   *  (`switch-agent.ts`). OFF by default — it costs a turn. */
  rememberBeforeSwitch: boolean;
  /** Inline Git blame in the code editor — dim author/age/summary annotation
   *  trailing the active line. Off = the CodeMirror extension isn't loaded. */
  gitBlameInline: boolean;
  /** Background `git fetch` of the open project (on open, on window focus,
   *  every few minutes) so the Pull badge reflects the remote. Never pulls. */
  gitAutoFetch: boolean;
  /** Keep the computer awake while an Atlas agent is actively running.
   *  Default OFF. Prevents idle system sleep; display can still turn off. */
  keepAwakeWhileRunning: boolean;
  /** Mirror the active project's convention files (`CLAUDE.md`,
   *  `.claude/rules/`) into a marked block of its `AGENTS.md`, kept current as
   *  they change, for any agent that reads `AGENTS.md`
   *  (`commands::instruction_sync`). OFF by default — it writes into the
   *  repository. Switching it off takes the block back out. */
  instructionSync: boolean;
  /** Chat composer send gesture. true (default) = Enter sends, Shift+Enter
   *  inserts a newline (Slack/Discord/ChatGPT convention). false = only
   *  Cmd/Ctrl+Enter sends, bare Enter always inserts a newline (the old
   *  default). Cmd/Ctrl+Enter always sends regardless of this setting. */
  enterToSend: boolean;
  /** "Command finished" — a successful command longer than
   *  `terminalNotifyMinDurationMs` raises a notification. (Once the terminal
   *  master switch; `notificationsEnabled` is the master now, and this is the
   *  per-kind switch the catalog names for `terminal-done`.) */
  terminalNotifications: boolean;
  /** A successful command shorter than this never notifies. */
  terminalNotifyMinDurationMs: number;
  /** Notify on a non-zero exit code regardless of duration. */
  terminalNotifyOnFailure: boolean;
  /** Notify when a command wants input (password prompt, bell, OSC 9/777). */
  terminalNotifyOnAttention: boolean;
  /** Legacy (pre-tier) terminal OS-banner switch. Read once by the migration
   *  into the `notify*Native` tier keys; nothing reads it afterwards. */
  terminalNotifyNative: boolean;
  /** Legacy (pre-tier) terminal sound switch — migrated like the one above. */
  terminalNotifySound: boolean;
  /** Notifications master switch: off silences every kind except the
   *  unknown and retired ones. */
  notificationsEnabled: boolean;
  /** Per urgency tier (`NotificationTier`): allow the OS banner (still only
   *  when away) and allow sound. Every catalog kind follows its tier. */
  notifyNeedsYouNative: boolean;
  notifyNeedsYouSound: boolean;
  notifyOutcomeNative: boolean;
  notifyOutcomeSound: boolean;
  notifyWarningNative: boolean;
  notifyWarningSound: boolean;
  /** An agent turn that finished faster than this stays quiet. 0 = off.
   *  Failures and requests for the user ignore it. */
  notifyAgentMinDurationMs: number;
  /** Allow once / Deny on permission banners (ATL-381 reads this). */
  notifyPermissionActions: boolean;
  /** The legacy terminal and agent choices have been folded into the keys
   *  above (`migrateNotificationSettings`). */
  notificationsMigrated: boolean;
  /** Notification kind ids switched off in Settings (one switch per kind that
   *  is not `locked`). Unknown ids are ignored. */
  notifyDisabledKinds: string[];
  /** The earlier per-kind switches have been folded into `notifyDisabledKinds`
   *  (`migrateNotificationSettings`). */
  notifyKindsMigrated: boolean;
}

/** Settings keys holding a plain on/off — the tier banner and sound switches name these. */
export type BooleanSettingKey = {
  [K in keyof AppSettings]: AppSettings[K] extends boolean ? K : never;
}[keyof AppSettings];

export const DEFAULT_SETTINGS: AppSettings = {
  autoAddAtlasGitignore: true,
  enableAtlasLogs: true,
  showHiddenFiles: true,
  uiScale: DEFAULT_SCALE,
  embeddingModelId: "all-MiniLM-L6-v2",
  theme: "atlas",
  themeMode: "system",
  themeOverrides: {},
  iconTheme: "material-icon-theme",
  appIcon: DEFAULT_APP_ICON,
  adaptiveSuggestions: "agent",
  agentSwitchBehavior: "reset",
  rememberBeforeSwitch: false,
  gitBlameInline: true,
  gitAutoFetch: true,
  keepAwakeWhileRunning: false,
  instructionSync: false,
  enterToSend: true,
  terminalNotifications: true,
  terminalNotifyMinDurationMs: 10_000,
  terminalNotifyOnFailure: true,
  terminalNotifyOnAttention: true,
  terminalNotifyNative: true,
  terminalNotifySound: false,
  notificationsEnabled: true,
  notifyNeedsYouNative: true,
  notifyNeedsYouSound: true,
  notifyOutcomeNative: true,
  notifyOutcomeSound: true,
  notifyWarningNative: false,
  notifyWarningSound: false,
  notifyAgentMinDurationMs: 0,
  notifyPermissionActions: true,
  notificationsMigrated: false,
  notifyDisabledKinds: [],
  notifyKindsMigrated: false,
};
