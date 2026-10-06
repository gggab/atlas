export const TAB_TYPES = [
  "chat",
  "canvas",
  "browser",
  "tasks",
  "editor",
  "knowledge",
  "knowledge-graph",
  "memory",
  "terminal",
  "diff",
  "settings",
  "log",
  "media",
  "svg",
  "pdf",
  "notebook",
  "unsupported",
  "usage",
  "artifacts",
] as const;

export type TabType = (typeof TAB_TYPES)[number];

/** Tab types available with no project open. */
export const PROJECTLESS_TYPES: ReadonlySet<TabType> = new Set<TabType>(["settings", "usage"]);

/** Global views excluded from per-project editor state. */
export const GLOBAL_TAB_TYPES: ReadonlySet<TabType> = new Set<TabType>(["usage"]);

/**
 * Tab types that were renamed. Persisted layout / editor state written by an
 * older build still carries the old name; `migrateTabType` maps it forward so
 * the tab comes back instead of being dropped as unknown.
 */
export const LEGACY_TAB_TYPES: Record<string, TabType> = { "mission-control": "usage" };

/** The current name for a stored tab type: the mapped type for a legacy name,
 *  the type itself when it is still valid, `null` when it is neither. */
export function migrateTabType(type: string): TabType | null {
  const legacy = LEGACY_TAB_TYPES[type];
  if (legacy) return legacy;
  return (TAB_TYPES as readonly string[]).includes(type) ? (type as TabType) : null;
}
