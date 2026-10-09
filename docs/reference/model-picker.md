# External Agent model picker

Open the model pill beside the chat composer, or use `cmd+shift+m` while the
chat has focus. `cmd` is Command on macOS and Ctrl on Windows/Linux. The picker
uses the current external ACP Agent's model list and existing `set_model` path;
it changes neither the Agent nor its vendor login or subscription.

## Search and groups

Search runs locally across every model the current Agent offers. Every
whitespace-separated word must match a model's display name, id, description
or stated provider. Name prefixes rank first, followed by name words, name
substrings, ids, descriptions and provider matches. Favorites break equal
scores; otherwise the Agent's ordering is retained.

The left rail groups models by the names their Agent stated in ACP. Models
without that information appear under the Agent's own label. Known spelling
aliases share one group; unknown providers keep their stated names and a neutral
icon. Search temporarily hides the rail and covers all groups.

## Favorites

Click a row's star, or use `cmd+shift+s` on the highlighted model. Starring does
not select a model. Favorites appear first within a group, and opening a picker
with available favorites shows the Favorites view first.

Preferences persist in `config.toml` as `[settings].favoriteModels`, an array
of `agentType:modelId` keys. Chats using the same Agent share favorites;
different Agents keep separate lists. Unavailable entries stay stored but are
not shown. Configuration write errors use the existing settings error handling.

## Keyboard

| Action | Default |
|---|---|
| Open or close the focused chat's picker | `cmd+shift+m` |
| Move the highlighted model, wrapping at either end | Up / Down |
| Select the highlighted model | Enter |
| Select visible model 1 through 9 | `cmd+1` through `cmd+9` |
| Star or unstar the highlighted model | `cmd+shift+s` |
| Previous / next group, outside search | `cmd+shift+up` / `cmd+shift+down` |
| Focus the rail, outside search | Shift+Tab, or Left on an empty input |
| Move along the rail | Up / Down, Home / End |
| Show the focused group | Enter / Space |
| Return from the rail to search | Right |
| Close the menu | Escape |

Registered shortcuts can be rebound in Settings > Keybindings. A picker's
actions only answer while it has focus. Composition keys are left to the IME.
The original chat permission-mode Shift+Tab action is suspended inside the
picker, so focus navigation cannot change permissions.

## Development checks

The component tests cover search ranking, grouping, stars, focus and keyboard
behavior. The composer integration test checks targeted opening and the existing
model-switch action. Settings tests cover the configuration API, and a Rust
temporary-file test reopens persisted favorites while preserving other settings
and unknown keys.

```sh
bun run test -- src/features/chat/components/model-picker.test.tsx src/features/chat/components/message-input-model-picker.test.tsx src/features/chat/lib/model-provider.test.ts src/features/chat/lib/model-picker-events.test.ts src/features/chat/lib/acp-config-options.test.ts src/features/keybindings/lib/resolve.test.ts src/features/settings/stores/settings-store.test.ts
cargo test --locked -p atlas-agent-servers --lib model_select_tests
cargo test --locked -p atlas --lib model_picker_favorites
```

DOM tests and Rust compile checks do not establish real desktop keyboard
behavior or a vendor-authenticated CLI model switch.
