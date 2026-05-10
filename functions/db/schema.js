import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ユーザーアカウント。メールアドレスでログインし、パスワードはハッシュだけ保存します。
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// HttpOnly Cookie に入れる session id とユーザーを紐づけます。
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// 日付ごとの親レコード。タスク・予定・振り返りはこのレコードに紐づきます。
export const days = sqliteTable("days", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  date: text("date").notNull(),
  title: text("title"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({ userDate: uniqueIndex("days_user_date_unique").on(table.userId, table.date) }));

// S/A/B優先度と達成状況を持つ日次タスクです。
export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dayId: integer("day_id").notNull(),
  userId: integer("user_id").notNull(),
  title: text("title").notNull(),
  priority: text("priority").notNull(),
  status: text("status").notNull(),
  sortOrder: integer("sort_order").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// 予定ブロック。手入力、Googleカレンダー、タイマー由来の予定を同じ形で扱います。
export const scheduleBlocks = sqliteTable("schedule_blocks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dayId: integer("day_id").notNull(),
  userId: integer("user_id").notNull(),
  title: text("title").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  source: text("source").notNull(),
  externalEventId: text("external_event_id"),
  sortOrder: integer("sort_order").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({ userExternalEvent: uniqueIndex("schedule_user_external_event_unique").on(table.userId, table.externalEventId) }));

// 実績ログ。タイマー開始/停止で実際に使った時間を記録します。
export const actualLogs = sqliteTable("actual_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dayId: integer("day_id").notNull(),
  userId: integer("user_id").notNull(),
  scheduleBlockId: integer("schedule_block_id"),
  title: text("title").notNull(),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  durationMinutes: integer("duration_minutes"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// 日次振り返り。達成率、理由、改善点などを1日1件保存します。
export const reflections = sqliteTable("reflections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dayId: integer("day_id").notNull(),
  userId: integer("user_id").notNull(),
  achievementRate: integer("achievement_rate").notNull(),
  reason: text("reason").notNull(),
  improvement: text("improvement").notNull(),
  goodPoints: text("good_points").notNull(),
  tomorrowNotes: text("tomorrow_notes").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Google OAuthトークン保存先。トークンはAPI側で暗号化してから保存します。
export const calendarAccounts = sqliteTable("calendar_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  provider: text("provider").notNull(),
  email: text("email"),
  encryptedAccessToken: text("encrypted_access_token").notNull(),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  expiresAt: integer("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({ userProvider: uniqueIndex("calendar_user_provider_unique").on(table.userId, table.provider) }));

// OAuth callback のCSRF対策用 state を一時保存します。
export const oauthStates = sqliteTable("oauth_states", {
  state: text("state").primaryKey(),
  userId: integer("user_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Googleカレンダー自動同期の最終同期時刻を保存し、過剰なAPI呼び出しを抑えます。
export const calendarSyncs = sqliteTable("calendar_syncs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  provider: text("provider").notNull(),
  date: text("date").notNull(),
  syncedAt: integer("synced_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({ userProviderDate: uniqueIndex("calendar_sync_user_provider_date_unique").on(table.userId, table.provider, table.date) }));
