# Releases for Atlas改

The fork develops on `develop`. Release a tested commit from that branch using
an annotated `vX.Y.Z` tag in `gggab/atlas`. Build and publication are separate:
an uploaded Actions artifact is not a public GitHub Release.

## Windows x64

Run **Build Windows Release** in GitHub Actions, selecting `develop`. The
workflow installs the repository-pinned Bun, Node and Rust versions, checks
types, lint and focused release/browser contracts, and builds the production
MSI with `bun run build:app:win`. It verifies MSI branding, version, architecture
and required resources before uploading `atlas-windows-x64`.

The MSI uses `zh-CN` in `src-tauri/tauri.windows.conf.json`: WiX's default English code page cannot represent the
Chinese product name and fails with `LGHT0311`. Keep this setting while the
product name contains Chinese characters. Tauri automatically merges this
platform file over the base config, so the language must be set in the overlay.
The overlay's initial window title must match the product name too.
Verbose bundler logs and a failure
artifact preserve the compiled executable and WiX sources for diagnosis.

Download that artifact. Verify its MSI against `SHA256SUMS.txt` and check that
`build-info.json` names the exact commit to tag. Test installation and relevant
desktop features before marking a version stable. The focused packaging checks
do not replace the full CI suite, a clean installation or vendor-authenticated
Agent/browser testing. Record remaining failures and untested behavior in the
release notes. Unsigned packages may produce Windows security prompts.

Push the annotated tag to `fork`, then create a GitHub Release in `gggab/atlas`
with `--verify-tag`. Upload the MSI, checksums and build information. Use
`--prerelease` for an initial test build; use `--notes-file` for release notes.
The Windows build workflow has read-only repository permissions and never
publishes a release itself. The existing Linux workflow has its own `alpha-*`
tag trigger; a `vX.Y.Z` tag does not build Linux or macOS packages.

For a local Windows build, install MSVC C++ Build Tools, Windows SDK, WebView2
and the VBScript optional feature. Run `bun install --frozen-lockfile` and
`bun run build:app:win`. MSI output is under
`target/x86_64-pc-windows-msvc/release/bundle/msi/`. Browser resources include
the Node executable used by the build, so use the Node version in `mise.toml`
and an official distribution with its LICENSE file.

## Version changes

Keep `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, the
`atlas` entry in `Cargo.lock`, and the About label in sync. `scripts/bump.sh`
currently uses macOS-specific `sed` and matches the historical About wording;
do not use it unchanged on Windows. Refresh the workspace lock entries with
`cargo update --workspace --offline` after changing the Cargo package version.

The desktop release keeps the existing application identifiers and data
profiles. The companion **Atlas Browser** extension has an independent
version and store-review process; releasing the MSI does not publish the
extension or enable application auto-updates.
