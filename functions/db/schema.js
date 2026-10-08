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

// MCP クライアントから使う個人用アクセストークン。本体は保存せず SHA-256 ハッシュだけを持ちます。
export const apiTokens = sqliteTable("api_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  tokenPrefix: text("token_prefix").notNull(),
  lastUsedAt: integer("last_used_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// 動的クライアント登録（RFC 7591）で登録された OAuth クライアント。redirect_uris は JSON 配列の文字列です。
export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(),
  clientSecretHash: text("client_secret_hash"),
  clientName: text("client_name"),
  redirectUris: text("redirect_uris").notNull(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// 認可リクエスト。同意前は userId / codeHash が null で、同意すると認可コードが発行されます。
export const oauthAuthorizations = sqliteTable("oauth_authorizations", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  state: text("state"),
  scope: text("scope"),
  resource: text("resource"),
  userId: integer("user_id"),
  codeHash: text("code_hash").unique(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// OAuth で発行したアクセストークン / リフレッシュトークン。どちらもハッシュだけを保存します。
export const oauthTokens = sqliteTable("oauth_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  clientId: text("client_id").notNull(),
  accessTokenHash: text("access_token_hash").notNull().unique(),
  accessExpiresAt: integer("access_expires_at").notNull(),
  refreshTokenHash: text("refresh_token_hash").notNull().unique(),
  refreshExpiresAt: integer("refresh_expires_at").notNull(),
  scope: text("scope"),
  resource: text("resource"),
  lastUsedAt: integer("last_used_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// 通知を受け取る端末（ブラウザの PushSubscription）。p256dh / auth はペイロード暗号化に使う公開情報です。
export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  label: text("label"),
  lastSuccessAt: integer("last_success_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// 通知の種類ごとのオン/オフと時刻（日本時間の HH:MM）。
export const notificationSettings = sqliteTable("notification_settings", {
  userId: integer("user_id").primaryKey(),
  scheduleReminderEnabled: integer("schedule_reminder_enabled", { mode: "boolean" }).notNull().default(true),
  scheduleLeadMinutes: integer("schedule_lead_minutes").notNull().default(10),
  timerNudgeEnabled: integer("timer_nudge_enabled", { mode: "boolean" }).notNull().default(true),
  morningEnabled: integer("morning_enabled", { mode: "boolean" }).notNull().default(true),
  morningTime: text("morning_time").notNull().default("08:00"),
  eveningEnabled: integer("evening_enabled", { mode: "boolean" }).notNull().default(true),
  eveningTime: text("evening_time").notNull().default("21:00"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// 指定時刻に送るリマインダー。remind_at / sent_at は UNIX 秒です。
export const reminders = sqliteTable("reminders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  message: text("message").notNull(),
  remindAt: integer("remind_at").notNull(),
  sentAt: integer("sent_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// 同じ通知を二重に送らないための送信記録。
export const notificationLog = sqliteTable("notification_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  kind: text("kind").notNull(),
  refKey: text("ref_key").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => ({ userKindRef: uniqueIndex("notification_log_user_kind_ref_unique").on(table.userId, table.kind, table.refKey) }));
