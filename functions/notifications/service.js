import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { notificationSettings, pushSubscriptions, reminders } from "../db/schema.js";
import { sendWebPush } from "./webpush.js";

// ===== 通知の設定・端末・リマインダー =====
// API（Pages Functions）と通知用 Worker（workers/notifier）の両方から使います。

export const DEFAULT_NOTIFICATION_SETTINGS = {
  scheduleReminderEnabled: true,
  scheduleLeadMinutes: 10,
  timerNudgeEnabled: true,
  morningEnabled: true,
  morningTime: "08:00",
  eveningEnabled: true,
  eveningTime: "21:00",
};

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function db(env) {
  return drizzle(env.DB);
}

// VAPID 鍵が未設定なら null を返し、通知機能を無効として扱います。
export function vapidConfig(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || "mailto:daily-pilot@example.com" };
}

// ===== 設定 =====

function pickSettings(row) {
  const settings = { ...DEFAULT_NOTIFICATION_SETTINGS };
  for (const key of Object.keys(settings)) {
    if (row && row[key] !== undefined && row[key] !== null) settings[key] = row[key];
  }
  return settings;
}

export async function getNotificationSettings(env, userId) {
  return pickSettings(await db(env).select().from(notificationSettings).where(eq(notificationSettings.userId, userId)).get());
}

export async function getNotificationSettingsFor(env, userIds) {
  if (!userIds.length) return new Map();
  const rows = await db(env).select().from(notificationSettings).where(inArray(notificationSettings.userId, userIds)).all();
  return new Map(userIds.map((userId) => [userId, pickSettings(rows.find((row) => row.userId === userId))]));
}

// 画面から送られた値を検証し、不正な値は既定値に戻さずエラーにします。
export function validateNotificationSettings(input) {
  const settings = pickSettings(null);
  for (const key of ["scheduleReminderEnabled", "timerNudgeEnabled", "morningEnabled", "eveningEnabled"]) {
    if (input[key] !== undefined) settings[key] = Boolean(input[key]);
  }
  const lead = Number(input.scheduleLeadMinutes ?? settings.scheduleLeadMinutes);
  if (!Number.isInteger(lead) || lead < 1 || lead > 120) return { error: "予定の通知は1〜120分前で指定してください" };
  settings.scheduleLeadMinutes = lead;
  for (const key of ["morningTime", "eveningTime"]) {
    const value = input[key] ?? settings[key];
    if (!TIME_PATTERN.test(value)) return { error: "時刻は HH:MM 形式で指定してください" };
    settings[key] = value;
  }
  return { settings };
}

export async function saveNotificationSettings(env, userId, settings) {
  await db(env).insert(notificationSettings).values({ userId, ...settings }).onConflictDoUpdate({ target: notificationSettings.userId, set: { ...settings, updatedAt: sql`CURRENT_TIMESTAMP` } }).run();
  return getNotificationSettings(env, userId);
}

// ===== 端末（PushSubscription） =====

export async function listSubscriptions(env, userId) {
  return db(env).select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint, label: pushSubscriptions.label, lastSuccessAt: pushSubscriptions.lastSuccessAt, createdAt: pushSubscriptions.createdAt }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).orderBy(asc(pushSubscriptions.id)).all();
}

function isAllowedEndpoint(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// 同じ端末（endpoint）が再登録された場合は、鍵と持ち主を上書きします。
export async function saveSubscription(env, userId, { endpoint, keys, label }) {
  if (!isAllowedEndpoint(endpoint) || !keys?.p256dh || !keys?.auth) return { error: "通知の購読情報が不正です" };
  const values = { userId, endpoint, p256dh: String(keys.p256dh), auth: String(keys.auth), label: String(label || "").slice(0, 60) || null };
  await db(env).insert(pushSubscriptions).values(values).onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values }).run();
  return { subscriptions: await listSubscriptions(env, userId) };
}

export async function deleteSubscription(env, userId, id) {
  await db(env).delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.id, id))).run();
}

// ユーザーの全端末に送信します。無効になった端末（404 / 410）は自動で削除します。
export async function sendToUser(env, userId, message, options) {
  const vapid = vapidConfig(env);
  if (!vapid) return { sent: 0, failed: 0, removed: 0, error: "VAPID 鍵が設定されていません" };
  const appDb = db(env);
  const subscriptions = await appDb.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).all();
  const result = { sent: 0, failed: 0, removed: 0, errors: [] };

  for (const subscription of subscriptions) {
    const outcome = await sendWebPush(subscription, message, vapid, options).catch((error) => ({ ok: false, gone: false, status: 0, error: error.message }));
    if (outcome.ok) {
      result.sent += 1;
      await appDb.update(pushSubscriptions).set({ lastSuccessAt: Math.floor(Date.now() / 1000) }).where(eq(pushSubscriptions.id, subscription.id)).run();
    } else if (outcome.gone) {
      result.removed += 1;
      await appDb.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id)).run();
    } else {
      result.failed += 1;
      result.errors.push(`${subscription.label || subscription.id}: ${outcome.status} ${outcome.error || ""}`.trim());
    }
  }
  return result;
}

// ===== リマインダー =====

export async function listUpcomingReminders(env, userId) {
  const now = Math.floor(Date.now() / 1000);
  return db(env).select({ id: reminders.id, message: reminders.message, remindAt: reminders.remindAt }).from(reminders).where(and(eq(reminders.userId, userId), isNull(reminders.sentAt), gte(reminders.remindAt, now - 60 * 60))).orderBy(asc(reminders.remindAt)).all();
}

// 日本時間の日付（YYYY-MM-DD）と時刻（HH:MM）から UNIX 秒を求めます。
export function tokyoDateTimeToUnix(date, time) {
  return Math.floor(new Date(`${date}T${time}:00+09:00`).getTime() / 1000);
}

export async function createReminder(env, userId, { message, remindAt }) {
  const text = String(message || "").trim().slice(0, 200);
  if (!text) return { error: "リマインダーの内容を入力してください" };
  if (!Number.isInteger(remindAt)) return { error: "通知する日時が不正です" };
  if (remindAt < Math.floor(Date.now() / 1000) - 60) return { error: "過去の日時にはリマインダーを設定できません" };
  const reminder = await db(env).insert(reminders).values({ userId, message: text, remindAt }).returning({ id: reminders.id, message: reminders.message, remindAt: reminders.remindAt }).get();
  return { reminder };
}

export async function cancelReminder(env, userId, id) {
  return db(env).delete(reminders).where(and(eq(reminders.userId, userId), eq(reminders.id, id), isNull(reminders.sentAt))).returning({ id: reminders.id, message: reminders.message }).get();
}
