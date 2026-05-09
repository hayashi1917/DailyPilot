CREATE TABLE IF NOT EXISTS days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  title TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('S', 'A', 'B')),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'done', 'partial', 'missed')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (day_id) REFERENCES days(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS schedule_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'google_calendar', 'timer')),
  external_event_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (day_id) REFERENCES days(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS actual_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_id INTEGER NOT NULL,
  schedule_block_id INTEGER,
  title TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_minutes INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (day_id) REFERENCES days(id) ON DELETE CASCADE,
  FOREIGN KEY (schedule_block_id) REFERENCES schedule_blocks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS reflections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_id INTEGER NOT NULL UNIQUE,
  achievement_rate INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  improvement TEXT NOT NULL DEFAULT '',
  good_points TEXT NOT NULL DEFAULT '',
  tomorrow_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (day_id) REFERENCES days(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS calendar_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google')),
  email TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_tasks_day_priority ON tasks(day_id, priority, sort_order);
CREATE INDEX IF NOT EXISTS idx_schedule_blocks_day_start ON schedule_blocks(day_id, start_time);
CREATE INDEX IF NOT EXISTS idx_actual_logs_day_started ON actual_logs(day_id, started_at);
CREATE INDEX IF NOT EXISTS idx_calendar_accounts_session_provider ON calendar_accounts(session_id, provider);
