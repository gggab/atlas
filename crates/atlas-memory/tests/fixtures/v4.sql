-- Synthetic v4 schema from b2b7015b; no user data.
BEGIN;
         CREATE TABLE IF NOT EXISTS events (
             seq      INTEGER PRIMARY KEY,
             ts       INTEGER NOT NULL,
             kind     TEXT NOT NULL,
             key      TEXT NOT NULL DEFAULT '',
             agent    TEXT NOT NULL DEFAULT '',
             session  TEXT NOT NULL DEFAULT '',
             payload  TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS entries (
             id            INTEGER PRIMARY KEY AUTOINCREMENT,
             kind          TEXT NOT NULL,
             key           TEXT NOT NULL DEFAULT '',
             content       TEXT NOT NULL,
             status        TEXT NOT NULL DEFAULT '',
             source        TEXT NOT NULL DEFAULT '',
             agent         TEXT NOT NULL DEFAULT '',
             session       TEXT NOT NULL DEFAULT '',
             confidence    REAL NOT NULL DEFAULT 1.0,
             created_at    INTEGER NOT NULL,
             updated_at    INTEGER NOT NULL,
             last_used_at  INTEGER,
             uses          INTEGER NOT NULL DEFAULT 0,
             content_hash  TEXT NOT NULL,
             seq           INTEGER
         );
         CREATE INDEX IF NOT EXISTS entries_kind_seq  ON entries(kind, seq);
         CREATE INDEX IF NOT EXISTS entries_kind_key  ON entries(kind, key);
         CREATE INDEX IF NOT EXISTS entries_kind_hash ON entries(kind, content_hash);
         CREATE TABLE IF NOT EXISTS sessions (
             session_id  TEXT PRIMARY KEY,
             agent       TEXT NOT NULL DEFAULT '',
             started_at  INTEGER,
             ended_at    INTEGER
         );
         CREATE TABLE IF NOT EXISTS legacy_imports (
             source  TEXT PRIMARY KEY,
             at      INTEGER NOT NULL
         );
         PRAGMA user_version = 1;
         COMMIT;
CREATE TABLE entry_vectors (id INTEGER PRIMARY KEY, model TEXT NOT NULL, vec BLOB NOT NULL);
CREATE TABLE retracted_events (seq INTEGER PRIMARY KEY);
CREATE TABLE forgotten (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, session TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
INSERT INTO entries (id,kind,key,content,source,agent,session,confidence,created_at,updated_at,content_hash) VALUES (41,'fact','auth','Legacy fact survives','codex','codex','old',1,1000,1000,'legacy');
INSERT INTO sessions VALUES ('old','codex',1,1000);
INSERT INTO forgotten VALUES (99,'fact','old',900);
PRAGMA user_version=4;
