import { useEffect, useRef, useState } from "react";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
import {
  Check,
  ChevronDown,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  FileJson,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { openKeybindingsFile } from "../lib/keybindings-api";
import { PRESET_BY_ID, PRESETS } from "../lib/presets";
import { exportProfile } from "../lib/profile-transfer";
import { useKeybindingsStore } from "../stores/keybindings-store";
import { ImportProfileDialog } from "./import-profile-dialog";
import { PresetIcon } from "./preset-icon";

// Same recipe as the account menu so every Atlas dropdown reads alike.
const CONTENT_CLASS =
  "min-w-[200px] max-w-[280px] rounded-md border border-[var(--border)] " +
  "bg-[var(--card)] shadow-md py-1";
const ITEM_CLASS =
  "flex items-center gap-2 px-3 h-[26px] text-xs cursor-pointer outline-none " +
  "text-[var(--secondary-foreground)] data-[highlighted]:bg-[var(--atlas-element-hover)] " +
  "data-[highlighted]:text-[var(--foreground)]";

/** The three ways the inline name field is used. */
type NamingMode = "create" | "duplicate" | "rename";

const NAMING_PLACEHOLDER: Record<NamingMode, string> = {
  create: "Name this profile…",
  duplicate: "Name the copy…",
  rename: "Profile name",
};

/** What an unnamed new profile falls back to when Enter is pressed on an
 *  empty field — the placeholder promises a profile, so make one. */
const DEFAULT_NEW_NAME = "New profile";

/**
 * The 29px header of the keybindings editor: which profile is live, and the
 * profile-level operations. The built-in Default profile is locked — its
 * edit buttons are disabled with a "Duplicate to edit" hint rather than
 * hidden, so the affordance is discoverable.
 */
export function ProfileBar() {
  const file = useKeybindingsStore.use.file();
  const {
    setActiveProfile,
    createProfile,
    duplicateProfile,
    renameProfile,
    deleteProfile,
    resetProfile,
    createProfileFromPreset,
    setProfilePreset,
  } = useKeybindingsStore.use.actions();
  const [importing, setImporting] = useState(false);
  const active = file.profiles.find((p) => p.id === file.activeProfileId) ?? file.profiles[0]!;
  const locked = !!active.builtIn;
  const overrideCount = Object.keys(active.bindings).length;

  // One inline input serves all three ways a profile gets a name: renaming an
  // existing one, and naming a new/duplicated one BEFORE it exists. Creating
  // first and renaming after would litter the list with "New profile 3".
  const [naming, setNaming] = useState<{ mode: NamingMode; sourceId: string } | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Set while a dropdown item is opening the input: Radix restores focus to
  // its trigger on close, which would pull it straight back out of the field.
  const openingInput = useRef(false);

  const startNaming = (mode: NamingMode, sourceId = active.id) => {
    const source = file.profiles.find((p) => p.id === sourceId) ?? active;
    setDraft(mode === "rename" ? source.name : mode === "duplicate" ? `${source.name} copy` : "");
    setNaming({ mode, sourceId });
  };

  useEffect(() => {
    if (!naming) return;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
      openingInput.current = false;
    });
    return () => cancelAnimationFrame(id);
  }, [naming]);

  const commitName = () => {
    if (!naming) return;
    const name = draft.trim();
    if (naming.mode === "rename") renameProfile(naming.sourceId, name);
    else if (naming.mode === "duplicate") duplicateProfile(naming.sourceId, name || undefined);
    else createProfile(name || DEFAULT_NEW_NAME);
    setNaming(null);
  };

  return (
    <div className="flex h-[29px] shrink-0 items-center gap-1 border-b border-border px-2">
      {naming ? (
        <div className="flex items-center gap-1.5 px-2">
          <span className="text-xs font-normal text-muted-foreground">Profile</span>
          <input
            ref={inputRef}
            value={draft}
            placeholder={NAMING_PLACEHOLDER[naming.mode]}
            onChange={(e) => setDraft(e.target.value)}
            // Empty means "never mind" — blurring an untouched field must not
            // conjure a profile the user never named.
            onBlur={() => (draft.trim() ? commitName() : setNaming(null))}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") setNaming(null);
              e.stopPropagation();
            }}
            className={cn(
              "h-6 w-[200px] rounded-md border border-border-strong bg-card px-2 text-xs",
              "text-foreground outline-none placeholder:text-muted-foreground",
            )}
          />
        </div>
      ) : (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            render={
              <button
                type="button"
                className={cn(
                  "flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-medium",
                  "text-foreground hover:bg-element-hover transition-colors cursor-pointer",
                )}
              >
                <span className="text-muted-foreground font-normal">Profile</span>
                <span className="max-w-[180px] truncate">{active.name}</span>
                {locked && <Lock size={10} className="text-muted-foreground" />}
                <ChevronDown size={11} className="text-muted-foreground" />
              </button>
            }
          />
          <DropdownMenu.Portal>
            <DropdownMenu.Positioner className="z-popover" align="start" sideOffset={4}>
              <DropdownMenu.Popup
                className={CONTENT_CLASS}
                // Base UI replaces Radix's onCloseAutoFocus with finalFocus:
                // `false` means "leave focus alone", `true` means "do the
                // default thing" (return it to the trigger).
                finalFocus={() => !openingInput.current}
              >
                {file.profiles.map((p) => (
                  <DropdownMenu.Item
                    key={p.id}
                    onClick={() => setActiveProfile(p.id)}
                    className={ITEM_CLASS}
                  >
                    <span className="flex w-3 justify-center">
                      {p.id === active.id && <Check size={11} />}
                    </span>
                    <span className="flex-1 truncate">{p.name}</span>
                    {p.builtIn ? (
                      <Lock size={10} className="text-muted-foreground" />
                    ) : (
                      <span className="text-2xs tabular-nums text-muted-foreground">
                        {Object.keys(p.bindings).length || ""}
                      </span>
                    )}
                  </DropdownMenu.Item>
                ))}
                <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />
                <DropdownMenu.Item
                  onClick={() => {
                    openingInput.current = true;
                    startNaming("create");
                  }}
                  className={ITEM_CLASS}
                >
                  <span className="flex w-3 justify-center">
                    <Plus size={11} />
                  </span>
                  <span className="flex-1">New profile…</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onClick={() => {
                    openingInput.current = true;
                    startNaming("duplicate");
                  }}
                  className={ITEM_CLASS}
                >
                  <span className="flex w-3 justify-center">
                    <Copy size={10} />
                  </span>
                  <span className="flex-1 truncate">Duplicate “{active.name}”…</span>
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />
                <div className="px-3 pb-0.5 pt-1 text-2xs text-muted-foreground">
                  New from an editor's keys
                </div>
                {PRESETS.map((preset) => (
                  <DropdownMenu.Item
                    key={preset.id}
                    onClick={() => createProfileFromPreset(preset.id)}
                    className={ITEM_CLASS}
                  >
                    <PresetIcon id={preset.id} className="size-3 shrink-0" />
                    <span className="flex-1 truncate">{preset.label}</span>
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Popup>
            </DropdownMenu.Positioner>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}

      {!locked && (
        <PresetPicker
          value={active.basedOn ?? null}
          onChange={(presetId) => setProfilePreset(active.id, presetId)}
        />
      )}

      {!locked && overrideCount > 0 && (
        <span className="text-2xs tabular-nums text-muted-foreground">
          {overrideCount} {overrideCount === 1 ? "override" : "overrides"}
        </span>
      )}

      <div className="ml-auto flex items-center gap-0.5">
        <IconButton label="New profile…" onClick={() => startNaming("create")}>
          <Plus size={13} />
        </IconButton>
        <IconButton label={`Duplicate “${active.name}”…`} onClick={() => startNaming("duplicate")}>
          <Copy size={12} />
        </IconButton>
        <IconButton
          label={locked ? "Default can't be renamed — duplicate to edit" : "Rename profile"}
          disabled={locked}
          onClick={() => startNaming("rename")}
        >
          <Pencil size={12} />
        </IconButton>
        <IconButton
          label={
            locked
              ? "Default can't be reset — it has no overrides"
              : "Reset all bindings in this profile"
          }
          disabled={locked || overrideCount === 0}
          onClick={() => resetProfile(active.id)}
        >
          <RotateCcw size={12} />
        </IconButton>
        <IconButton
          label={locked ? "Default can't be deleted" : "Delete profile"}
          disabled={locked}
          onClick={() => deleteProfile(active.id)}
        >
          <Trash2 size={12} />
        </IconButton>
        <span className="mx-1 h-3.5 w-px bg-border" />
        <IconButton
          label={`Copy “${active.name}” as JSON`}
          onClick={() =>
            void copyText(exportProfile(active)).then((ok) =>
              ok ? toast.success("Profile copied") : toast.error("Could not copy the profile"),
            )
          }
        >
          <ClipboardCopy size={12} />
        </IconButton>
        <IconButton label="Import a profile…" onClick={() => setImporting(true)}>
          <ClipboardPaste size={12} />
        </IconButton>
        <IconButton label="Open keybindings.json" onClick={() => void openKeybindingsFile()}>
          <FileJson size={12} />
        </IconButton>
      </div>
      <ImportProfileDialog open={importing} onOpenChange={setImporting} />
    </div>
  );
}

/** "Keys from: VS Code ▾" — the preset layered under the active profile. */
function PresetPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (presetId: (typeof PRESETS)[number]["id"] | null) => void;
}) {
  const current = value ? (PRESET_BY_ID.get(value)?.label ?? value) : "DeskMate";
  return (
    <DropdownMenu.Root>
      <Hint label="Which editor's keys this profile starts from">
        <DropdownMenu.Trigger
          render={
            <button
              type="button"
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-md px-2 text-xs",
                "text-secondary-foreground hover:bg-element-hover hover:text-foreground",
                "transition-colors cursor-pointer",
              )}
            >
              <span className="text-muted-foreground">Keys from</span>
              <span className="max-w-[120px] truncate">{current}</span>
              <ChevronDown size={11} className="text-muted-foreground" />
            </button>
          }
        />
      </Hint>
      <DropdownMenu.Portal>
        <DropdownMenu.Positioner className="z-popover" align="start" sideOffset={4}>
          <DropdownMenu.Popup className={CONTENT_CLASS}>
            {[{ id: null, label: "DeskMate" } as const, ...PRESETS].map((p) => (
              <DropdownMenu.Item
                key={p.id ?? "atlas"}
                onClick={() => onChange(p.id)}
                className={ITEM_CLASS}
              >
                <span className="flex w-3 justify-center">
                  {p.id === value && <Check size={11} />}
                </span>
                <span className="flex-1 truncate">{p.label}</span>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Popup>
        </DropdownMenu.Positioner>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function IconButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Hint label={label}>
      <button
        type="button"
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
          active
            ? "bg-element-selected text-foreground"
            : "text-secondary-foreground hover:bg-element-hover hover:text-foreground",
          disabled ? "opacity-35 cursor-not-allowed" : "cursor-pointer",
        )}
      >
        {children}
      </button>
    </Hint>
  );
}
