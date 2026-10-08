-- スマホへのプッシュ通知（Web Push）とリマインダーのテーブルです。

-- 通知を受け取る端末（ブラウザの PushSubscription）
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  label TEXT,
  last_success_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id);

-- 通知の種類ごとのオン/オフと時刻。行がないユーザーは既定値（すべてオン）で動きます。
CREATE TABLE IF NOT EXISTS notification_settings (
  user_id INTEGER PRIMARY KEY,
  schedule_reminder_enabled INTEGER NOT NULL DEFAULT 1,
  schedule_lead_minutes INTEGER NOT NULL DEFAULT 10,
  timer_nudge_enabled INTEGER NOT NULL DEFAULT 1,
  morning_enabled INTEGER NOT NULL DEFAULT 1,
  morning_time TEXT NOT NULL DEFAULT '08:00',
  evening_enabled INTEGER NOT NULL DEFAULT 1,
  evening_time TEXT NOT NULL DEFAULT '21:00',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 指定時刻に送るリマインダー（画面や MCP 経由で Claude から登録）
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  remind_at INTEGER NOT NULL,
  sent_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(sent_at, remind_at);

-- 同じ通知を二重に送らないための送信記録（種類 + 対象のキーで一意）
CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, kind, ref_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS notification_log_created_idx ON notification_log(created_at);
