#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# apple-sys needs the active macOS SDK while compiling native dependencies.
# Respect an explicitly selected SDK, otherwise use Xcode's current default.
if [[ "$(uname -s)" == "Darwin" && -z "${SDKROOT:-}" ]]; then
  export SDKROOT="$(xcrun --show-sdk-path)"
fi

# A SUBSET of CI, not a replica. CI (.github/workflows/ci.yml) is the
# authority; this is the quick local pass over the same test suites. For the
# replica — each crate from its own directory, clippy included — run
# `bun run ci:local`. What this leaves out:
#   - clippy. CI runs one pass per crate: `cargo clippy --locked --all-targets`,
#     plus `-- -D warnings` for the crates flagged `clippy: true` in the
#     matrix, and plain for the app. Run those by hand for a crate you touched.
#   - atlas-kb-server, which is workspace-excluded and compiled at runtime by
#     `knowledge_export`; CI tests it and builds its release profile.
#   - the frontend (`bun run test` and friends).
#
# One real difference in what it DOES run: the atlas-* crates are tested in
# one cargo invocation, where CI gives each crate its own job. Cargo unifies
# features across every package in an invocation, so a crate that only
# compiles because a sibling happens to enable a feature on a shared
# dependency passes here and fails in its CI job. When they disagree, the
# per-crate CI job is right.
#
# `--locked` everywhere, as in CI: a Cargo.lock that needs rewriting fails here
# instead of being silently updated.

# Test the retained workspace crates, then the desktop app.
echo "==> crates/atlas-* (unit + integration + doctests)"
cargo test --locked --workspace \
  --exclude atlas

# `--lib` only for the app crate, as in CI: every src-tauri test is a unit
# test in the lib, and `-p atlas` alone would also link the `atlas` binary's
# own test harness, a second full-size link to run nothing.
echo "==> src-tauri --lib"
cargo test --locked -p atlas --lib
