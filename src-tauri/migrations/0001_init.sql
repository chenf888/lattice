-- 0001_init：应用元数据库初始 schema（六表 + 查询索引）
-- 注意：连接级 PRAGMA（WAL / foreign_keys / busy_timeout）在 MetaStore::open 中设置

CREATE TABLE connections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  driver      TEXT NOT NULL,           -- postgres | mysql | sqlite
  host        TEXT,
  port        INTEGER,
  database    TEXT,
  username    TEXT,
  ssl_mode    TEXT,
  color       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE query_history (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  sql           TEXT NOT NULL,
  status        TEXT NOT NULL,         -- ok | error | cancelled
  rows          INTEGER,
  duration_ms   INTEGER,
  error         TEXT,
  executed_at   INTEGER NOT NULL
);
CREATE INDEX idx_query_history_conn_time ON query_history(connection_id, executed_at DESC);

CREATE TABLE saved_queries (
  id            TEXT PRIMARY KEY,
  connection_id TEXT,
  name          TEXT NOT NULL,
  sql           TEXT NOT NULL,
  folder        TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_saved_queries_conn ON saved_queries(connection_id, updated_at DESC);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE tabs_session (
  id            TEXT PRIMARY KEY,
  connection_id TEXT,
  title         TEXT,
  sql           TEXT,
  scroll_top    INTEGER,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE favorites (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  object_type   TEXT NOT NULL,
  object_name   TEXT NOT NULL
);
CREATE INDEX idx_favorites_conn ON favorites(connection_id);
