//! Local session stores require SQLite 3.51.3 or newer for the WAL-reset
//! corruption fix. The workspace shares a single bundled SQLite library.

/// `3.51.3` in SQLite's `SQLITE_VERSION_NUMBER` encoding: `major*1_000_000 +
/// minor*1_000 + patch`.
const SQLITE_FLOOR: i32 = 3_051_003;

#[test]
fn bundled_sqlite_meets_the_wal_fix_floor() {
    let linked = rusqlite::version_number();
    assert!(
        linked >= SQLITE_FLOOR,
        "bundled SQLite is {} ({}), below the ≥ 3.51.3 WAL-fix floor \
         ({SQLITE_FLOOR}). Bump the workspace `rusqlite` requirement.",
        rusqlite::version(),
        linked,
    );
}
