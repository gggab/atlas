# DeskMate keybindings (`keybindings.json`)

Every rebindable shortcut in DeskMate is an **action** with a stable id
(`panels.left`, `tabs.close`, `terminal.nextTab` …). The registry of actions,
their titles, default chords and the focus context they fire in lives in
`src/features/keybindings/lib/actions.ts`; Settings → Keybindings renders that
registry and lets you rebind each row.

Bindings are grouped into **profiles**. The built-in `Default` profile is
locked and always reflects DeskMate's shipped defaults; duplicate it (or create an
empty profile) to customise. Only one profile is active at a time.

The welcome screen's **Open Folder** hint follows the active `workspace.add`
binding and disappears when that action is unbound.

The `panels.right` action now toggles Remote execution. Git view shortcuts in
built-in presets are removed; explicit user overrides remain intact.

The Untitled Editor action (`tabs.newUntitled`, formerly Cmd/Ctrl+N) is removed.
Its saved overrides remain in the profile as unknown actions and cannot create
new documents. Existing file editing and save shortcuts are unchanged.

## Presets and the first-run question

A profile can be **based on** another editor's keys: `vscode`, `cursor`,
`zed` or `jetbrains` (`src/features/keybindings/lib/presets.ts`). A preset
names only the commands that editor has a well-known equivalent for; every
other command keeps DeskMate's chord. Each table follows that editor's macOS
default keymap, and none carries a multi-stroke chord (`⌘K ⌘S`), which DeskMate
cannot match.

On first launch — while there is no `keybindings.json` — DeskMate asks which
editor you're coming from. Picking one creates a profile based on it; "DeskMate"
and "Decide later" keep the Default profile. Every answer writes the file, so
the question is asked once, and deleting the file asks it again. Change a
profile's preset later with **Keys from** in Settings → Keybindings.

## Location

```
~/.config/atlas/keybindings.json      ($XDG_CONFIG_HOME/atlas/keybindings.json if set)
```

A sibling of `config.toml`, for the same reason: it is a document you may edit
by hand. DeskMate re-reads it whenever the window regains focus, so edits land
without a relaunch. "Open keybindings.json" in the editor's toolbar opens it.

## Format

```json
{
  "version": 1,
  "activeProfileId": "profile-abc",
  "profiles": [
    { "id": "default", "name": "Default", "builtIn": true, "bindings": {} },
    {
      "id": "profile-abc",
      "name": "My keybindings",
      "basedOn": "vscode",
      "bindings": {
        "panels.left": ["cmd+shift+l"],
        "panels.right": null,
        "view.zoomIn": ["cmd+=", "cmd+shift+="]
      }
    }
  ]
}
```

A profile stores **overrides only**:

- `"action.id": ["chord", …]` replaces the action's default chords;
- `"action.id": null` unbinds it;
- an absent key means "use the default" — the preset's chords if the
  profile's `basedOn` preset names the action, otherwise DeskMate's — so new
  actions shipped in a later DeskMate version work in every existing profile.

An unknown `basedOn` (a newer DeskMate wrote it, or a typo) is kept on disk and
ignored, with a warning in Settings.

### Chord syntax

Lowercase tokens joined by `+`: modifiers first (`cmd`, `ctrl`, `alt`,
`shift`; `mod`/`command`/`option`/`control`/`meta`/`super`/`win` are accepted
aliases), then exactly one key. Keys are letters, digits, `f1`–`f24`, punctuation (`; ' [ ] \ / , . = -`
and `` ` ``) or the named keys `space`, `enter`, `tab`, `escape`, `backspace`,
`delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`.
`cmd++` means ⌘⇧= (the "⌘+" zoom chord on a US layout).

Chords match on the **physical key**, so `alt+b` works even though macOS types
`∫` for it.

`cmd` is the **primary modifier**: ⌘ on macOS, Ctrl on Windows and Linux. On
macOS every modifier must match exactly, so `cmd+b` does not fire on ⌃B. Off
macOS `cmd+x` and `ctrl+x` are the same key; the editor treats two commands
bound that way as conflicting. `cmd+ctrl+x` means Ctrl+Super/Win there.

### When contexts

The model picker uses its own `modelPicker` context while it has focus. Its
`cmd+1` through `cmd+9` actions choose the corresponding visible model instead
of focusing a tab. `cmd+shift+m` opens the picker in the focused chat;
`cmd+shift+s` stars the highlighted model, and `cmd+shift+up` / `down` change
groups when no search is active. These actions can be rebound normally.
Arrow keys and Enter navigate and select models. With no search active,
Shift+Tab or Left (on an empty input) moves to the group rail, and Right returns
to search. Shift+Tab inside this picker does not cycle the session's permission
mode. IME composition keeps its keys. See [Model picker](model-picker.md).

Most actions are global. Some only fire while a surface has focus — for a
surface that lives in a tab, while that tab is the active tab of the focused
split — and are shown in the editor's When column: `terminalFocus`, `chatFocus`,
`knowledgeOpen`, `knowledgeFocus`, `pdfFocus`, `canvasFocus`. Scoped actions
may share a chord with a global one (the terminal's ⌘W shadows close-tab while
the terminal is focused); the editor marks that amber. Two actions in the
*same* context sharing a chord is a real conflict (red): the first in registry
order wins.

## Sharing a profile

**Copy as JSON** (the clipboard icon in Settings → Keybindings) copies the
active profile in a stable, versioned form:

```json
{
  "atlasKeybindings": 1,
  "name": "My keybindings",
  "basedOn": "vscode",
  "bindings": { "panels.left": ["cmd+shift+l"] }
}
```

It carries the preset and the overrides, never the resolved chords, so the
recipient stays on DeskMate's moving defaults for everything else. **Import a
profile…** takes that JSON and adds it as a new, active profile. A newer
`atlasKeybindings` version is rejected; commands and presets this DeskMate
doesn't know are kept.

## Reserved chords

The recorder warns when a chord belongs to the operating system (⌘Q, ⌘H, ⌘M,
⌘Space, ⌘Tab, ⌘\`, the screenshot chords, Mission Control's ⌃arrows …;
Alt+Tab and Alt+F4 elsewhere). It still lets you bind one: with the system
shortcut turned off, it works.

## The native Close Tab item

On macOS, Window ▸ Close Tab carries the first chord bound to `tabs.close`.
The native menu follows a rebind and closes the active tab. A chord it can't
express (punctuation) leaves the item without one.

## Validation

DeskMate checks the file's shape when loading and before every save: unique
profile ids, non-empty names, a present and empty `default` profile, an
`activeProfileId` that exists, and syntactically valid chords. A file that
fails to parse is **left untouched** — DeskMate runs on the Default profile and
shows the error at the top of Settings → Keybindings. Action ids DeskMate doesn't
recognise are preserved verbatim and listed under "Unknown commands".

## Not rebindable

The code editor's CodeMirror keymap, the note editor's formatting shortcuts,
the terminal's readline keys and copy/paste, the native macOS menu bar, arrow
keys inside palettes and lists, and Escape-to-close.
