import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { TIER_ORDER, TIER_SETTINGS, kindsInTier } from "@/features/notifications/lib/prefs";
import type { NotificationTier } from "@/features/notifications/lib/catalog";
import { SectionTitle, SettingRow, Toggle } from "./settings-controls";

const SELECT_CLASS =
  "h-7 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 text-xs text-[var(--foreground)] outline-none disabled:opacity-40";

const DURATION_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Always" },
  { value: 5_000, label: "5 seconds" },
  { value: 10_000, label: "10 seconds" },
  { value: 30_000, label: "30 seconds" },
  { value: 60_000, label: "1 minute" },
  { value: 300_000, label: "5 minutes" },
];

/** A minimum-duration picker; a value set by hand in `config.toml` that is not
 *  one of the presets still shows (rather than a blank select). */
function DurationSelect({
  value,
  disabled,
  allowAlways,
  onChange,
}: {
  value: number;
  disabled: boolean;
  allowAlways: boolean;
  onChange: (ms: number) => void;
}) {
  const options = DURATION_OPTIONS.filter((o) => allowAlways || o.value > 0);
  if (!options.some((o) => o.value === value)) {
    options.push({ value, label: `${Math.round(value / 1000)} seconds` });
    options.sort((a, b) => a.value - b.value);
  }
  return (
    <select
      value={String(value)}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className={SELECT_CLASS}
    >
      {options.map((o) => (
        <option key={o.value} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** One urgency tier: its banner + sound switches, and the catalog's kinds in
 *  it, each with its own switch (`notifyDisabledKinds`). Everything here is derived from the catalog — a new kind appears with
 *  no change to this file. */
function TierGroup({ tier, masterOn }: { tier: NotificationTier; masterOn: boolean }) {
  const settings = useSettingsStore.use.settings();
  const { updateSettings } = useSettingsStore.use.actions();
  const group = TIER_SETTINGS[tier];
  const kinds = kindsInTier(tier);
  const disabled = new Set(settings.notifyDisabledKinds);
  /** The disabled list with `kind` switched on or off. Ids this catalog does
   *  not know are kept as they are. */
  const withKind = (kind: string, on: boolean) =>
    on
      ? settings.notifyDisabledKinds.filter((k) => k !== kind)
      : [...settings.notifyDisabledKinds.filter((k) => k !== kind), kind];
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-xs font-semibold text-foreground">{group.title}</h3>
        <p className="text-2xs text-muted-foreground mt-0.5">{group.description}</p>
      </div>
      <SettingRow
        label="System notification"
        description="A banner from the operating system, only while you are away."
      >
        <Toggle
          checked={settings[group.native]}
          disabled={!masterOn}
          onChange={(next) => updateSettings({ [group.native]: next })}
        />
      </SettingRow>
      <SettingRow label="Sound" description="A short sound with the banner.">
        <Toggle
          checked={settings[group.sound]}
          disabled={!masterOn}
          onChange={(next) => updateSettings({ [group.sound]: next })}
        />
      </SettingRow>
      {tier === "needs-you" && (
        <SettingRow
          label="Banner actions on permission requests"
          description="Show Allow once and Deny on a permission banner, so you can answer without opening DeskMate. Off: the banner only opens the session."
        >
          <Toggle
            checked={settings.notifyPermissionActions}
            disabled={!masterOn}
            onChange={(next) => updateSettings({ notifyPermissionActions: next })}
          />
        </SettingRow>
      )}
      <ul className="flex flex-col gap-1.5 border-l border-[var(--border)] pl-3">
        {kinds.map(({ kind, entry }) => (
          <li key={kind} className="flex items-center justify-between gap-4">
            <span className="text-2xs text-muted-foreground">{entry.label}</span>
            {entry.locked ? (
              <span className="text-2xs text-muted-foreground">Always on</span>
            ) : (
              <Toggle
                checked={!disabled.has(kind)}
                disabled={!masterOn}
                onChange={(next) => updateSettings({ notifyDisabledKinds: withKind(kind, next) })}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function NotificationsSettings() {
  const settings = useSettingsStore.use.settings();
  const { updateSettings } = useSettingsStore.use.actions();
  const masterOn = settings.notificationsEnabled;
  return (
    <>
      <SectionTitle
        title="Notifications"
        subtitle="What DeskMate tells you, and how loudly. Nothing fires while you are looking at the thing it is about."
      />
      <SettingRow
        label="Notifications"
        description="Everything below. Sign-in problems always show, so you are never left with a silently stopped agent."
      >
        <Toggle
          checked={masterOn}
          onChange={(next) => updateSettings({ notificationsEnabled: next })}
        />
      </SettingRow>
      <SettingRow
        label="Notify on agent finish after"
        description="An agent turn that finishes faster than this stays quiet. Failures and requests for you always notify."
      >
        <DurationSelect
          value={settings.notifyAgentMinDurationMs}
          disabled={!masterOn}
          allowAlways
          onChange={(ms) => updateSettings({ notifyAgentMinDurationMs: ms })}
        />
      </SettingRow>
      <SettingRow
        label="Notify on command success after"
        description="A terminal command that succeeds faster than this stays quiet. Failures always notify."
      >
        <DurationSelect
          value={settings.terminalNotifyMinDurationMs}
          disabled={!masterOn}
          allowAlways={false}
          onChange={(ms) => updateSettings({ terminalNotifyMinDurationMs: ms })}
        />
      </SettingRow>
      {TIER_ORDER.map((tier) => (
        <TierGroup key={tier} tier={tier} masterOn={masterOn} />
      ))}
    </>
  );
}
