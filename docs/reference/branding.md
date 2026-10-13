# DeskMate branding and compatibility

The Chinese product name is **同桌** and the English name is **DeskMate**.
Desktop titles, About and installers use **同桌 DeskMate**; the isolated
source-build profile adds **Dev**. English UI copy uses DeskMate.
The browser companion is **DeskMate Browser**. Store listing changes require
their own reviewed extension update; local source changes do not publish it.

## Compatibility identifiers

Branding does not change storage ownership or protocol identities. Keep:

- `dev.atlas.ide` / `dev.atlas.ide.dev` application identifiers and their data profiles;
- `.atlas` / `.atlas-dev` project and home directories, `atlas` / `atlas-dev` configuration directories;
- Cargo crate names, the `atlas` executable and CLI helpers;
- persisted configuration keys, event names, theme IDs, MCP server names and browser native-host identifiers;
- browser extension public key, Chrome/Edge IDs, and existing browser authorization records;
- historical transcript/context markers and shell-profile block headers used to recognize existing records.

The npm workspace is private and is named `deskmate`. Public Windows artifacts
use `DeskMate-<version>-windows-x64.msi`; browser ZIPs use
`deskmate-browser-<version>-<browser>.zip`. These filenames are not storage keys.

Upstream Atlas attribution, license text and historical ADR/research documents
retain their original names. Historical native-agent records still identify
the removed Atlas Agent; DeskMate does not provide a replacement native engine.
Existing component/module names may retain `atlas` as internal implementation
names, without appearing as the current product brand.

## Icon assets

The DeskMate symbol is two side-by-side conversation windows above a shared
desk. Mint and blue distinguish the collaborators, and broad shapes remain
readable at small sizes. The source SVGs are `src/assets/deskmate-icon.svg`
and `src/assets/deskmate-icon-light.svg`; `dark` / `light` setting IDs stay
compatible with existing preferences.

Run `bun run icons:render` with the repository-pinned Node and Tauri CLI to
generate desktop PNG/ICO/ICNS assets, the light macOS variant, browser icons,
the landing favicon and the DMG background. `bun run icons:check` verifies
source freshness and shared SVG copies. Refresh the landing share card from
`scripts/og/og.html` when the logo changes.

The macOS default now uses the flat `Icon.icns`, so changing the brand does
not require Xcode Icon Composer or retain the old Atlas `Assets.car` at
runtime. The alternate ICNS is still bundled only on macOS and applied through
the existing `appIcon` preference. Native Dock/Finder appearance requires a
macOS installation check.

## Development checks

Update both `atlas-profile::Profile::product_name()` and the Tauri product/window
configs, including Windows and Linux overlays. The frontend default profile,
welcome screen and About must match. Keep the Chinese Windows MSI locale.

Run profile/release and affected UI tests, browser extension/package tests,
typecheck, lint, the frontend build and `cargo test --locked -p atlas-profile`.
These checks do not replace launching the desktop, installing an MSI, or
testing a store-installed extension.
