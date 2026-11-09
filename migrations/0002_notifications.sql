CREATE TABLE IF NOT EXISTS push_config (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_preferences (torn_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS push_devices (
 id TEXT PRIMARY KEY, torn_id TEXT NOT NULL, session_hash TEXT NOT NULL,
 subscription TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, lease TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS push_devices_user ON push_devices(torn_id);
CREATE INDEX IF NOT EXISTS push_devices_session ON push_devices(session_hash);
