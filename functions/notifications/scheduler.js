import { drizzle } from "drizzle-orm/d1";
import { and, eq, isNull, lt, lte } from "drizzle-orm";
import { actualLogs, days, notificationLog, pushSubscriptions, reflections, reminders, scheduleBlocks, tasks } from "../db/schema.js";
import { getNotificationSettingsFor, sendToUser } from "./service.js";

// ===== 定期実行される通知判定 =====
// 通知用 Worker（workers/notifier）の Cron Trigger から1分ごとに呼ばれます。
// 通知を受け取る端末が登録されているユーザーごとに、送るべき通知を判定して Web Push で送信します。
// 同じ通知は notification_log の一意制約で1回だけ送るため、Cron が重なっても二重送信しません。

// 予定が始まってから何分たってもタイマーが動いていなければ促すか
const TIMER_NUDGE_DELAY_MINUTES = 5;
// 朝・夜のリマインドは、設定時刻からこの分数のあいだだけ送ります（Cron が止まっていた場合に深夜に届かないように）
const DAILY_REMINDER_WINDOW_MINUTES = 60;
// これより古い未送信リマインダーは送らずに破棄します
const STALE_REMINDER_SECONDS = 60 * 60;
const LOG_RETENTION_SECONDS = 60 * 60 * 24 * 14;

function db(env) {
  return drizzle(env.DB);
}

function toMinutes(time) {
  const [hour, minute] = String(time).split(":").map(Number);
  return hour * 60 + minute;
}

// アプリ全体が日本時間前提のため、判定も日本時間の日付と分で行います。
export function tokyoClock(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), unix: Math.floor(now.getTime() / 1000) };
}

function blockStartIso(date, time) {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

// 1ユーザー分の「いま送るべき通知」を集めます。
async function collectNotifications(env, userId, settings, clock) {
  const appDb = db(env);
  const notifications = [];
  const { date, minutes } = clock;
  const nowIso = new Date(clock.unix * 1000).toISOString();

  const day = await appDb.select().from(days).where(and(eq(days.userId, userId), eq(days.date, date))).get();
  const blocks = day ? await appDb.select().from(scheduleBlocks).where(and(eq(scheduleBlocks.userId, userId), eq(scheduleBlocks.dayId, day.id))).all() : [];
  const dayTasks = day ? await appDb.select().from(tasks).where(and(eq(tasks.userId, userId), eq(tasks.dayId, day.id))).all() : [];

  // 予定の開始前リマインド
  if (settings.scheduleReminderEnabled) {
    for (const block of blocks) {
      const start = toMinutes(block.startTime);
      if (minutes >= start - settings.scheduleLeadMinutes && minutes < start) {
        notifications.push({
          kind: "schedule",
          refKey: `${date}:${block.id}:${block.startTime}`,
          message: { title: `あと${start - minutes}分: ${block.title}`, body: `${block.startTime}〜${block.endTime}`, tag: `schedule-${block.id}`, url: "/" },
          options: { urgency: "high", ttl: (start - minutes) * 60 + 300 },
        });
      }
    }
  }

  // 予定が始まったのに実績タイマーが動いていないときの促し
  if (settings.timerNudgeEnabled && blocks.length) {
    const logs = await appDb.select().from(actualLogs).where(and(eq(actualLogs.userId, userId), eq(actualLogs.dayId, day.id))).all();
    const running = await appDb.select({ id: actualLogs.id }).from(actualLogs).where(and(eq(actualLogs.userId, userId), isNull(actualLogs.endedAt))).get();
    if (!running) {
      for (const block of blocks) {
        const start = toMinutes(block.startTime);
        if (minutes < start + TIMER_NUDGE_DELAY_MINUTES || minutes >= toMinutes(block.endTime)) continue;
        // 予定の少し前（10分前）から現在までに計測を始めていれば、すでに止めた場合も「計測済み」とみなして促しません。
        // 手入力で先の時間帯の実績を入れた場合もあるため、現在より後に始まるログは対象外にします。
        const threshold = new Date(new Date(blockStartIso(date, block.startTime)).getTime() - 10 * 60 * 1000).toISOString();
        if (logs.some((log) => log.startedAt >= threshold && log.startedAt <= nowIso)) continue;
        notifications.push({
          kind: "timer",
          refKey: `${date}:${block.id}:${block.startTime}`,
          message: { title: "実績タイマーが動いていません", body: `「${block.title}」が${block.startTime}から始まっています。いまの作業を計測しましょう。`, tag: `timer-${block.id}`, url: "/" },
          options: { ttl: 30 * 60 },
        });
      }
    }
  }

  // 朝の計画リマインド（タスクが1件もない日だけ）
  const morning = toMinutes(settings.morningTime);
  if (settings.morningEnabled && minutes >= morning && minutes < morning + DAILY_REMINDER_WINDOW_MINUTES && dayTasks.length === 0) {
    notifications.push({
      kind: "morning",
      refKey: date,
      message: { title: "今日のタスクを決めましょう", body: "S / A / B の目標タスクがまだ登録されていません。", tag: `morning-${date}`, url: "/" },
      options: { ttl: 60 * 60 },
    });
  }

  // 夜の振り返りリマインド（振り返りが未保存の日だけ）
  const evening = toMinutes(settings.eveningTime);
  if (settings.eveningEnabled && minutes >= evening && minutes < evening + DAILY_REMINDER_WINDOW_MINUTES) {
    const reflection = day ? await appDb.select({ id: reflections.id }).from(reflections).where(and(eq(reflections.userId, userId), eq(reflections.dayId, day.id))).get() : null;
    if (!reflection) {
      const done = dayTasks.filter((task) => task.status === "done").length;
      notifications.push({
        kind: "evening",
        refKey: date,
        message: { title: "今日の振り返りをしましょう", body: dayTasks.length ? `タスク完了 ${done} / ${dayTasks.length}。理由と改善点を記録しましょう。` : "今日の実績と改善点を記録しましょう。", tag: `evening-${date}`, url: "/" },
        options: { ttl: 2 * 60 * 60 },
      });
    }
  }

  // 画面や Claude（MCP）から登録されたリマインダー
  const dueReminders = await appDb.select().from(reminders).where(and(eq(reminders.userId, userId), isNull(reminders.sentAt), lte(reminders.remindAt, clock.unix))).all();
  for (const reminder of dueReminders) {
    // 送信済みにしてから送ることで、Cron が重なっても1回だけ送ります。
    const claimed = await appDb.update(reminders).set({ sentAt: clock.unix }).where(and(eq(reminders.id, reminder.id), isNull(reminders.sentAt))).returning({ id: reminders.id }).get();
    if (!claimed || reminder.remindAt < clock.unix - STALE_REMINDER_SECONDS) continue;
    notifications.push({
      kind: "reminder",
      refKey: String(reminder.id),
      message: { title: "リマインダー", body: reminder.message, tag: `reminder-${reminder.id}`, url: "/" },
      options: { urgency: "high", ttl: 60 * 60 },
    });
  }

  return notifications;
}

// 送信記録を先に書き込み、書き込めた（＝まだ送っていない）通知だけを送ります。
async function claim(env, userId, notification, unix) {
  const row = await db(env).insert(notificationLog).values({ userId, kind: notification.kind, refKey: notification.refKey, createdAt: unix }).onConflictDoNothing().returning({ id: notificationLog.id }).get();
  return Boolean(row);
}

export async function runNotificationCycle(env, now = new Date()) {
  const clock = tokyoClock(now);
  const appDb = db(env);
  const summary = { checkedUsers: 0, sent: 0, failed: 0, removed: 0, notifications: [] };

  const subscribers = await appDb.selectDistinct({ userId: pushSubscriptions.userId }).from(pushSubscriptions).all();
  const userIds = subscribers.map((row) => row.userId);
  const settingsByUser = await getNotificationSettingsFor(env, userIds);

  for (const userId of userIds) {
    summary.checkedUsers += 1;
    const notifications = await collectNotifications(env, userId, settingsByUser.get(userId), clock);
    for (const notification of notifications) {
      if (!(await claim(env, userId, notification, clock.unix))) continue;
      const result = await sendToUser(env, userId, notification.message, notification.options);
      summary.sent += result.sent;
      summary.failed += result.failed;
      summary.removed += result.removed;
      summary.notifications.push({ userId, kind: notification.kind, title: notification.message.title, ...result });
    }
  }

  // 古い送信記録と送信済みリマインダーを掃除します。
  await appDb.delete(notificationLog).where(lt(notificationLog.createdAt, clock.unix - LOG_RETENTION_SECONDS)).run();
  await appDb.delete(reminders).where(lt(reminders.sentAt, clock.unix - LOG_RETENTION_SECONDS)).run();
  return summary;
}
