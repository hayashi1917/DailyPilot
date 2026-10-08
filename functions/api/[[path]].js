import { drizzle } from "drizzle-orm/d1";
import { and, between, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { randomId, sha256Hex } from "../lib/crypto.js";
import {
  corsPreflight,
  decideAuthorization,
  describeAuthorization,
  exchangeToken,
  isOAuthAccessToken,
  listConnections,
  mcpWwwAuthenticate,
  registerClient,
  revokeConnection,
  startAuthorization,
  userFromOAuthAccessToken,
} from "../oauth/provider.js";
import {
  cancelReminder,
  createReminder,
  deleteSubscription,
  getNotificationSettings,
  listSubscriptions,
  listUpcomingReminders,
  saveNotificationSettings,
  saveSubscription,
  sendToUser,
  tokyoDateTimeToUnix,
  validateNotificationSettings,
  vapidConfig,
} from "../notifications/service.js";
import { ToolInputError, compactDaySummary, exportTexts, handleMcpRequest } from "../mcp/server.js";
import {
  actualLogs,
  apiTokens,
  calendarAccounts,
  calendarSyncs,
  days,
  oauthStates,
  reflections,
  scheduleBlocks,
  sessions,
  tasks,
  users,
} from "../db/schema.js";

// セッションCookie名と有効期限をAPI全体で統一します。
const SESSION_COOKIE = "daily_pilot_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const GOOGLE_PROVIDER = "google";
// Cloudflare Workers の Web Crypto は PBKDF2 の反復回数が 100,000 回までに制限されています。
// そのため上限値の 100,000 回を明示的に使い、作成済みハッシュにも回数を保存します。
const PASSWORD_HASH_ITERATIONS = 100000;

// Cloudflare Pages Functions から返すJSONレスポンスを標準化します。
function json(data, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}
const badRequest = (message) => json({ error: message }, { status: 400 });
// Drizzle ORM のD1アダプタを生成します。SQL文字列を直接組み立てず、schema定義を経由してDBにアクセスします。
function db(env) {
  return drizzle(env.DB);
}

function getCookie(request, name) {
  return (request.headers.get("cookie") || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function sessionCookie(value, request, maxAge = SESSION_TTL_SECONDS) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

// パスワードは平文保存せず、PBKDF2 + ランダムソルトでハッシュ化します。
async function derivePasswordHash(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return bytesToBase64(bits);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePasswordHash(password, salt, PASSWORD_HASH_ITERATIONS);
  return `pbkdf2:${PASSWORD_HASH_ITERATIONS}:${bytesToBase64(salt)}:${hash}`;
}

async function verifyPassword(password, stored) {
  const parts = stored.split(":");
  const [_algorithm, iterationsValue, saltValue, hashValue] = parts.length === 4
    ? parts
    : ["pbkdf2", String(PASSWORD_HASH_ITERATIONS), parts[0], parts[1]];
  const iterations = Math.min(Number(iterationsValue), PASSWORD_HASH_ITERATIONS);
  const salt = base64ToBytes(saltValue);
  const hash = await derivePasswordHash(password, salt, iterations);
  return hash === hashValue;
}

// Google OAuthトークンはD1保存前にAES-GCMで暗号化します。TOKEN_ENCRYPTION_KEY 未設定時はアクセス元オリジンから鍵を導出します。
async function encryptionKey(env, request) {
  const secret = env.TOKEN_ENCRYPTION_KEY || `daily-pilot:${new URL(request.url).origin}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptToken(env, request, token) {
  if (!token) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env, request), new TextEncoder().encode(token));
  return `${bytesToBase64(iv)}:${bytesToBase64(encrypted)}`;
}

async function decryptToken(env, request, encryptedToken) {
  if (!encryptedToken) return null;
  const [ivValue, tokenValue] = encryptedToken.split(":");
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(ivValue) }, await encryptionKey(env, request), base64ToBytes(tokenValue));
  return new TextDecoder().decode(decrypted);
}

// HttpOnly Cookie の session id から現在のユーザーを復元します。
async function currentUser(env, request) {
  const sessionId = getCookie(request, SESSION_COOKIE);
  if (!sessionId) return null;
  const appDb = db(env);
  const now = Math.floor(Date.now() / 1000);
  const session = await appDb.select().from(sessions).where(and(eq(sessions.id, sessionId), sql`${sessions.expiresAt} > ${now}`)).get();
  if (!session) return null;
  return appDb.select({ id: users.id, email: users.email, name: users.name }).from(users).where(eq(users.id, session.userId)).get();
}

// ===== MCP 用の個人アクセストークン =====
// トークンは発行時に一度だけ表示し、DBには SHA-256 ハッシュだけを保存します。
const API_TOKEN_PREFIX = "dpk_";

function bearerToken(request) {
  return (request.headers.get("authorization") || "").match(/^Bearer\s+(\S+)$/i)?.[1] || null;
}

// MCP の認証。画面で発行した個人アクセストークン（dpk_）と、OAuth のアクセストークン（dpa_）の両方を受け付けます。
async function userFromBearerToken(env, request) {
  const bearer = bearerToken(request);
  if (!bearer) return null;
  if (isOAuthAccessToken(bearer)) return userFromOAuthAccessToken(env, bearer);
  if (!bearer.startsWith(API_TOKEN_PREFIX)) return null;
  const appDb = db(env);
  const token = await appDb.select().from(apiTokens).where(eq(apiTokens.tokenHash, await sha256Hex(bearer))).get();
  if (!token) return null;
  // 最終利用時刻は5分に1回だけ更新し、D1 の書き込み回数を抑えます。
  const now = Math.floor(Date.now() / 1000);
  if (!token.lastUsedAt || now - token.lastUsedAt > 300) {
    await appDb.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, token.id)).run();
  }
  return appDb.select({ id: users.id, email: users.email, name: users.name }).from(users).where(eq(users.id, token.userId)).get();
}

async function listApiTokens(appDb, userId) {
  return appDb.select({ id: apiTokens.id, name: apiTokens.name, tokenPrefix: apiTokens.tokenPrefix, lastUsedAt: apiTokens.lastUsedAt, createdAt: apiTokens.createdAt }).from(apiTokens).where(eq(apiTokens.userId, userId)).orderBy(desc(apiTokens.id)).all();
}

async function requireUser(env, request) {
  const user = await currentUser(env, request);
  if (!user) throw new Response(JSON.stringify({ error: "ログインが必要です" }), { status: 401, headers: { "content-type": "application/json; charset=utf-8" } });
  return user;
}

async function createSession(env, request, userId) {
  const appDb = db(env);
  const id = randomId(32);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  await appDb.insert(sessions).values({ id, userId, expiresAt }).run();
  const headers = new Headers();
  headers.append("set-cookie", sessionCookie(id, request));
  return headers;
}

// 日次データは各機能の親になるため、存在しなければ先に作成します。
async function ensureDay(appDb, userId, date) {
  await appDb.insert(days).values({ userId, date, title: `${date} タスクマネジメント` }).onConflictDoNothing().run();
  const day = await appDb.select().from(days).where(and(eq(days.userId, userId), eq(days.date, date))).get();
  if (!day) throw new Error("Failed to create day");
  return day;
}

// S/A/B の重要度を加味して達成率を自動計算します。
function calculateAchievement(taskRows) {
  if (!taskRows.length) return 0;
  const weights = { S: 3, A: 2, B: 1 };
  const score = { done: 1, partial: 0.5, planned: 0, missed: 0 };
  const totalWeight = taskRows.reduce((sum, task) => sum + weights[task.priority], 0);
  const achieved = taskRows.reduce((sum, task) => sum + weights[task.priority] * score[task.status], 0);
  return Math.round((achieved / totalWeight) * 100);
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function isValidTime(value) {
  return /^\d{2}:\d{2}$/.test(String(value || ""));
}

function timeToMinutes(value) {
  const [hour, minute] = String(value || "").split(":").map(Number);
  return hour * 60 + minute;
}


function dateTimeToIso(date, time) {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

function minutesBetween(startedAt, endedAt) {
  return Math.max(1, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60000));
}

function normalizeActualLogBody(body) {
  return {
    date: body.date,
    title: String(body.title || "").trim(),
    startTime: body.startTime || body.start_time,
    endTime: body.endTime || body.end_time,
  };
}

function validateActualLogInput({ date, title, startTime, endTime }) {
  if (!isValidDate(date)) return "Invalid date";
  if (!title) return "Actual log title is required";
  if (!isValidTime(startTime) || !isValidTime(endTime)) return "Invalid time";
  if (timeToMinutes(startTime) >= timeToMinutes(endTime)) return "End time must be after start time";
  return null;
}

function normalizeScheduleBody(body) {
  return {
    date: body.date,
    title: String(body.title || "").trim(),
    startTime: body.startTime || body.start_time,
    endTime: body.endTime || body.end_time,
    source: body.source || "manual",
    externalEventId: body.externalEventId || body.external_event_id || null,
    scheduleBlockId: body.scheduleBlockId || body.schedule_block_id || null,
  };
}

function validateScheduleInput({ date, title, startTime, endTime }) {
  if (!isValidDate(date)) return "Invalid date";
  if (!title) return "Schedule title is required";
  if (!isValidTime(startTime) || !isValidTime(endTime)) return "開始時刻と終了時刻をHH:MM形式で指定してください";
  if (timeToMinutes(startTime) >= timeToMinutes(endTime)) return "終了時刻は開始時刻より後にしてください";
  return null;
}

function addDays(date, daysToAdd) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + daysToAdd);
  return parsed.toISOString().slice(0, 10);
}

function localDateRange(date) {
  return { start: `${date}T00:00:00+09:00`, end: `${addDays(date, 1)}T00:00:00+09:00` };
}

function timeFromGoogle(value, fallback) {
  return (value || fallback).slice(11, 16);
}

function requestOrigin(request) {
  return new URL(request.url).origin;
}

function googleRedirectConfig(env, request) {
  const origin = requestOrigin(request);
  const autoRedirectUri = `${origin}/api/google/callback`;
  const configuredRedirectUri = env.GOOGLE_REDIRECT_URI?.trim();

  if (!configuredRedirectUri) {
    return { redirectUri: autoRedirectUri, autoRedirectUri, configuredRedirectUri: null, ignoredConfiguredRedirectUri: null };
  }

  try {
    const configuredOrigin = new URL(configuredRedirectUri).origin;
    if (configuredOrigin !== origin) {
      return { redirectUri: autoRedirectUri, autoRedirectUri, configuredRedirectUri, ignoredConfiguredRedirectUri: configuredRedirectUri };
    }

    return { redirectUri: configuredRedirectUri, autoRedirectUri, configuredRedirectUri, ignoredConfiguredRedirectUri: null };
  } catch {
    return { redirectUri: autoRedirectUri, autoRedirectUri, configuredRedirectUri, ignoredConfiguredRedirectUri: configuredRedirectUri };
  }
}

function googleRedirectUri(env, request) {
  return googleRedirectConfig(env, request).redirectUri;
}

function appBaseUrl(env, request) {
  const origin = requestOrigin(request);
  const configuredBaseUrl = env.APP_BASE_URL?.trim();
  if (!configuredBaseUrl) return origin;
  try {
    return new URL(configuredBaseUrl).origin === origin ? configuredBaseUrl : origin;
  } catch {
    return origin;
  }
}

function googleConfig(env, request) {
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: googleRedirectUri(env, request),
  };
}

function missingGoogleConfig(env) {
  const missing = [];
  if (!env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!env.GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  return missing;
}

function googleConfigStatus(env, request) {
  const missing = missingGoogleConfig(env);
  const redirect = googleRedirectConfig(env, request);
  return {
    configured: missing.length === 0,
    missing,
    redirectUri: redirect.redirectUri,
    autoRedirectUri: redirect.autoRedirectUri,
    ignoredConfiguredRedirectUri: redirect.ignoredConfiguredRedirectUri,
  };
}

// 暗号化済みトークンを復号し、期限切れの場合はrefresh tokenで更新します。
async function getGoogleAccessToken(env, request, userId) {
  const appDb = db(env);
  const account = await appDb.select().from(calendarAccounts).where(and(eq(calendarAccounts.userId, userId), eq(calendarAccounts.provider, GOOGLE_PROVIDER))).get();
  if (!account) return null;
  const currentAccessToken = await decryptToken(env, request, account.encryptedAccessToken);
  if (account.expiresAt > Math.floor(Date.now() / 1000) + 60) return currentAccessToken;
  const refreshToken = await decryptToken(env, request, account.encryptedRefreshToken);
  const config = googleConfig(env, request);
  if (!refreshToken || !config.clientId || !config.clientSecret) return currentAccessToken;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!response.ok) return currentAccessToken;
  const refreshed = await response.json();
  const expiresAt = Math.floor(Date.now() / 1000) + refreshed.expires_in;
  await appDb.update(calendarAccounts).set({ encryptedAccessToken: await encryptToken(env, request, refreshed.access_token), expiresAt, updatedAt: sql`CURRENT_TIMESTAMP` }).where(and(eq(calendarAccounts.userId, userId), eq(calendarAccounts.provider, GOOGLE_PROVIDER))).run();
  return refreshed.access_token;
}

async function fetchGoogleEvents(accessToken, date) {
  if (!isValidDate(date)) throw new Error("Invalid date");
  const range = localDateRange(date);
  const eventsUrl = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  eventsUrl.search = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", timeMin: range.start, timeMax: range.end }).toString();
  const response = await fetch(eventsUrl, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  return data.items || [];
}

// 日次画面を開いたときにGoogleカレンダーを自動同期します。
// force=true の場合は最短同期間隔を無視して即時同期します。
async function autoSyncGoogle(env, request, userId, date, dayId, force = false) {
  const accessToken = await getGoogleAccessToken(env, request, userId);
  if (!accessToken) return { connected: false, synced: false };
  const appDb = db(env);
  const minutes = Number(env.CALENDAR_AUTO_SYNC_MINUTES || 15);
  const now = Math.floor(Date.now() / 1000);
  const syncRow = await appDb.select().from(calendarSyncs).where(and(eq(calendarSyncs.userId, userId), eq(calendarSyncs.provider, GOOGLE_PROVIDER), eq(calendarSyncs.date, date))).get();
  if (!force && syncRow && now - syncRow.syncedAt < minutes * 60) return { connected: true, synced: false, lastSyncedAt: syncRow.syncedAt };

  const events = await fetchGoogleEvents(accessToken, date);
  for (const event of events) {
    if (!event.id) continue;
    const title = event.summary || "Google予定";
    const startTime = timeFromGoogle(event.start?.dateTime, `${event.start?.date}T00:00:00`);
    const endTime = timeFromGoogle(event.end?.dateTime, `${event.end?.date}T23:59:00`);
    const existing = await appDb.select().from(scheduleBlocks).where(and(eq(scheduleBlocks.userId, userId), eq(scheduleBlocks.externalEventId, event.id))).get();
    if (!existing) {
      const matchingLocal = await appDb.select().from(scheduleBlocks).where(and(
        eq(scheduleBlocks.userId, userId),
        eq(scheduleBlocks.dayId, dayId),
        eq(scheduleBlocks.title, title),
        eq(scheduleBlocks.startTime, startTime),
        eq(scheduleBlocks.endTime, endTime),
        isNull(scheduleBlocks.externalEventId),
      )).get();
      if (matchingLocal) {
        await appDb.update(scheduleBlocks).set({ source: "google_calendar", externalEventId: event.id, updatedAt: sql`CURRENT_TIMESTAMP` }).where(and(eq(scheduleBlocks.userId, userId), eq(scheduleBlocks.id, matchingLocal.id))).run();
        continue;
      }
    }
    await appDb.insert(scheduleBlocks).values({
      dayId,
      userId,
      title,
      startTime,
      endTime,
      source: "google_calendar",
      externalEventId: event.id,
      sortOrder: 0,
    }).onConflictDoUpdate({ target: [scheduleBlocks.userId, scheduleBlocks.externalEventId], set: { dayId, title, startTime, endTime, source: "google_calendar", updatedAt: sql`CURRENT_TIMESTAMP` } }).run();
  }
  await appDb.insert(calendarSyncs).values({ userId, provider: GOOGLE_PROVIDER, date, syncedAt: now }).onConflictDoUpdate({ target: [calendarSyncs.userId, calendarSyncs.provider, calendarSyncs.date], set: { syncedAt: now, updatedAt: sql`CURRENT_TIMESTAMP` } }).run();
  return { connected: true, synced: true, lastSyncedAt: now };
}

// フロントエンドが1回のAPI呼び出しで描画できるよう、日次画面に必要な情報をまとめて返します。
async function getDaySummary(env, request, userId, date) {
  const appDb = db(env);
  const day = await ensureDay(appDb, userId, date);
  const sync = await autoSyncGoogle(env, request, userId, date, day.id).catch((error) => ({ connected: true, synced: false, error: error.message }));
  const taskRows = await appDb.select().from(tasks).where(and(eq(tasks.userId, userId), eq(tasks.dayId, day.id))).orderBy(tasks.priority, tasks.sortOrder, tasks.id).all();
  const scheduleRows = await appDb.select().from(scheduleBlocks).where(and(eq(scheduleBlocks.userId, userId), eq(scheduleBlocks.dayId, day.id))).orderBy(scheduleBlocks.startTime, scheduleBlocks.id).all();
  const logRows = await appDb.select().from(actualLogs).where(and(eq(actualLogs.userId, userId), eq(actualLogs.dayId, day.id))).orderBy(actualLogs.startedAt, actualLogs.id).all();
  const reflection = await appDb.select().from(reflections).where(and(eq(reflections.userId, userId), eq(reflections.dayId, day.id))).get();
  const achievementRate = reflection?.achievementRate ?? calculateAchievement(taskRows);
  return { day, tasks: taskRows, schedule: scheduleRows, actualLogs: logRows, reflection: reflection || { achievementRate, reason: "", improvement: "", goodPoints: "", tomorrowNotes: "" }, googleSync: sync };
}

// ===== 日次データの更新処理（REST API と MCP で共通利用） =====

function normalizeTaskPriority(priority) {
  return ["S", "A", "B"].includes(priority) ? priority : null;
}

async function createTask(appDb, userId, { date, title, priority }) {
  const day = await ensureDay(appDb, userId, date);
  const [max] = await appDb.select({ next: sql`COALESCE(MAX(${tasks.sortOrder}), 0) + 1` }).from(tasks).where(and(eq(tasks.userId, userId), eq(tasks.dayId, day.id), eq(tasks.priority, priority))).all();
  return appDb.insert(tasks).values({ dayId: day.id, userId, title, priority, status: "planned", sortOrder: Number(max?.next || 1) }).returning().get();
}

async function updateTask(appDb, userId, id, { title, priority, status }) {
  return appDb.update(tasks).set({ title, priority, status, updatedAt: sql`CURRENT_TIMESTAMP` }).where(and(eq(tasks.userId, userId), eq(tasks.id, id))).returning().get();
}

async function createScheduleBlock(appDb, userId, schedule) {
  const day = await ensureDay(appDb, userId, schedule.date);
  return appDb.insert(scheduleBlocks).values({ dayId: day.id, userId, title: schedule.title, startTime: schedule.startTime, endTime: schedule.endTime, source: schedule.source, externalEventId: schedule.externalEventId, sortOrder: 0 }).returning().get();
}

async function createActualLog(appDb, userId, log) {
  const day = await ensureDay(appDb, userId, log.date);
  const startedAt = dateTimeToIso(log.date, log.startTime);
  const endedAt = dateTimeToIso(log.date, log.endTime);
  return appDb.insert(actualLogs).values({ dayId: day.id, userId, title: log.title, startedAt, endedAt, durationMinutes: minutesBetween(startedAt, endedAt) }).returning().get();
}

async function startTimer(appDb, userId, { date, title, scheduleBlockId }) {
  const day = await ensureDay(appDb, userId, date);
  return appDb.insert(actualLogs).values({ dayId: day.id, userId, scheduleBlockId: scheduleBlockId || null, title, startedAt: new Date().toISOString() }).returning().get();
}

async function stopTimer(appDb, userId, logId) {
  const endedAt = new Date();
  const log = await appDb.select().from(actualLogs).where(and(eq(actualLogs.userId, userId), eq(actualLogs.id, logId))).get();
  if (!log) return null;
  const durationMinutes = Math.max(1, Math.round((endedAt.getTime() - new Date(log.startedAt).getTime()) / 60000));
  return appDb.update(actualLogs).set({ endedAt: endedAt.toISOString(), durationMinutes }).where(and(eq(actualLogs.userId, userId), eq(actualLogs.id, logId))).returning().get();
}

async function saveReflection(appDb, userId, date, values) {
  const day = await ensureDay(appDb, userId, date);
  const fields = { achievementRate: values.achievementRate, reason: values.reason, improvement: values.improvement, goodPoints: values.goodPoints, tomorrowNotes: values.tomorrowNotes };
  await appDb.insert(reflections).values({ dayId: day.id, userId, ...fields }).onConflictDoUpdate({ target: [reflections.userId, reflections.dayId], set: { ...fields, updatedAt: sql`CURRENT_TIMESTAMP` } }).run();
}

// ===== MCP ツールの実処理 =====
// ログイン中ユーザーに紐づけた操作を返します。入力ミスは ToolInputError としてモデルに伝えます。

function todayInTokyo() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

function resolveDate(date) {
  if (date === undefined || date === null || date === "") return todayInTokyo();
  if (!isValidDate(date)) throw new ToolInputError("date は YYYY-MM-DD 形式で指定してください");
  return date;
}

function requireId(value, name) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new ToolInputError(`${name} を正の整数で指定してください`);
  return id;
}

function requireText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new ToolInputError(`${name} を指定してください`);
  return text;
}

function mcpOps(env, request, user) {
  const appDb = db(env);
  const userId = user.id;
  const summaryOf = (date) => getDaySummary(env, request, userId, date);
  const dayResult = async (date, extra) => ({ ...extra, day: compactDaySummary(await summaryOf(date)) });

  return {
    async getDay(date) {
      return compactDaySummary(await summaryOf(resolveDate(date)));
    },

    async listDays(from, to) {
      if (!isValidDate(from) || !isValidDate(to)) throw new ToolInputError("from / to は YYYY-MM-DD 形式で指定してください");
      if (from > to) throw new ToolInputError("from は to 以前の日付にしてください");
      if (addDays(from, 30) < to) throw new ToolInputError("期間は31日以内にしてください");
      const dayRows = await appDb.select().from(days).where(and(eq(days.userId, userId), between(days.date, from, to))).orderBy(days.date).all();
      if (!dayRows.length) return { from, to, days: [] };
      const dayIds = dayRows.map((day) => day.id);
      const taskRows = await appDb.select().from(tasks).where(and(eq(tasks.userId, userId), inArray(tasks.dayId, dayIds))).orderBy(tasks.priority, tasks.sortOrder, tasks.id).all();
      const logRows = await appDb.select().from(actualLogs).where(and(eq(actualLogs.userId, userId), inArray(actualLogs.dayId, dayIds))).all();
      const reflectionRows = await appDb.select().from(reflections).where(and(eq(reflections.userId, userId), inArray(reflections.dayId, dayIds))).all();
      return {
        from,
        to,
        days: dayRows.map((day) => {
          const dayTasks = taskRows.filter((task) => task.dayId === day.id);
          const reflection = reflectionRows.find((row) => row.dayId === day.id);
          return {
            date: day.date,
            achievementRate: reflection?.achievementRate ?? calculateAchievement(dayTasks),
            tasks: dayTasks.map((task) => ({ priority: task.priority, title: task.title, status: task.status })),
            loggedMinutes: logRows.filter((log) => log.dayId === day.id).reduce((sum, log) => sum + (log.durationMinutes || 0), 0),
            reflection: reflection ? { reason: reflection.reason, improvement: reflection.improvement, goodPoints: reflection.goodPoints, tomorrowNotes: reflection.tomorrowNotes } : null,
          };
        }),
      };
    },

    async getExportText(date) {
      return exportTexts(await summaryOf(resolveDate(date)));
    },

    async addTask(args) {
      const date = resolveDate(args.date);
      const priority = args.priority === undefined ? "A" : normalizeTaskPriority(args.priority);
      if (!priority) throw new ToolInputError("priority は S / A / B のいずれかです");
      const task = await createTask(appDb, userId, { date, title: requireText(args.title, "title"), priority });
      return dayResult(date, { created: { id: task.id, priority: task.priority, title: task.title } });
    },

    async updateTask(args) {
      const id = requireId(args.task_id, "task_id");
      if (args.priority !== undefined && !normalizeTaskPriority(args.priority)) throw new ToolInputError("priority は S / A / B のいずれかです");
      if (args.status !== undefined && !["planned", "done", "partial", "missed"].includes(args.status)) throw new ToolInputError("status は planned / done / partial / missed のいずれかです");
      const title = args.title === undefined ? undefined : requireText(args.title, "title");
      if (title === undefined && args.priority === undefined && args.status === undefined) throw new ToolInputError("title / priority / status のいずれかを指定してください");
      const task = await updateTask(appDb, userId, id, { title, priority: args.priority, status: args.status });
      if (!task) throw new ToolInputError(`タスク ${id} が見つかりません`);
      return { updated: { id: task.id, priority: task.priority, title: task.title, status: task.status } };
    },

    async deleteTask(taskId) {
      const id = requireId(taskId, "task_id");
      const task = await appDb.delete(tasks).where(and(eq(tasks.userId, userId), eq(tasks.id, id))).returning().get();
      if (!task) throw new ToolInputError(`タスク ${id} が見つかりません`);
      return { deleted: { id: task.id, title: task.title } };
    },

    async addSchedule(args) {
      const schedule = normalizeScheduleBody({ date: resolveDate(args.date), title: args.title, startTime: args.start_time, endTime: args.end_time });
      const validationError = validateScheduleInput(schedule);
      if (validationError) throw new ToolInputError(validationError);
      const block = await createScheduleBlock(appDb, userId, schedule);
      return dayResult(schedule.date, { created: { id: block.id, startTime: block.startTime, endTime: block.endTime, title: block.title } });
    },

    async deleteSchedule(scheduleId) {
      const id = requireId(scheduleId, "schedule_id");
      const block = await appDb.delete(scheduleBlocks).where(and(eq(scheduleBlocks.userId, userId), eq(scheduleBlocks.id, id))).returning().get();
      if (!block) throw new ToolInputError(`予定 ${id} が見つかりません`);
      return { deleted: { id: block.id, title: block.title } };
    },

    async startTimer(args) {
      const date = resolveDate(args.date);
      const log = await startTimer(appDb, userId, { date, title: requireText(args.title, "title") });
      return { started: { id: log.id, title: log.title, startedAt: log.startedAt } };
    },

    async stopTimer(logId) {
      let id = logId === undefined || logId === null ? null : requireId(logId, "log_id");
      if (!id) {
        const running = await appDb.select().from(actualLogs).where(and(eq(actualLogs.userId, userId), isNull(actualLogs.endedAt))).orderBy(desc(actualLogs.startedAt)).get();
        if (!running) throw new ToolInputError("計測中の実績タイマーはありません");
        id = running.id;
      }
      const log = await stopTimer(appDb, userId, id);
      if (!log) throw new ToolInputError(`実績ログ ${id} が見つかりません`);
      return { stopped: { id: log.id, title: log.title, durationMinutes: log.durationMinutes } };
    },

    async addActualLog(args) {
      const log = normalizeActualLogBody({ date: resolveDate(args.date), title: args.title, startTime: args.start_time, endTime: args.end_time });
      const validationError = validateActualLogInput(log);
      if (validationError) throw new ToolInputError(validationError);
      const created = await createActualLog(appDb, userId, log);
      return dayResult(log.date, { created: { id: created.id, title: created.title, durationMinutes: created.durationMinutes } });
    },

    async createReminder(args) {
      const date = resolveDate(args.date);
      if (!isValidTime(args.time)) throw new ToolInputError("time は HH:MM 形式で指定してください");
      const { reminder, error } = await createReminder(env, userId, { message: args.message, remindAt: tokyoDateTimeToUnix(date, args.time) });
      if (error) throw new ToolInputError(error);
      const devices = (await listSubscriptions(env, userId)).length;
      return {
        created: { id: reminder.id, message: reminder.message, remindAt: `${date} ${args.time}` },
        ...(devices ? { devices } : { warning: "通知を受け取る端末が登録されていません。DailyPilot の「スマホ通知」で端末を登録すると届きます。" }),
      };
    },

    async listReminders() {
      const upcoming = await listUpcomingReminders(env, userId);
      return {
        reminders: upcoming.map((reminder) => ({ id: reminder.id, message: reminder.message, remindAt: new Date(reminder.remindAt * 1000).toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 16) })),
      };
    },

    async cancelReminder(reminderId) {
      const id = requireId(reminderId, "reminder_id");
      const reminder = await cancelReminder(env, userId, id);
      if (!reminder) throw new ToolInputError(`未送信のリマインダー ${id} が見つかりません`);
      return { cancelled: reminder };
    },

    async saveReflection(args) {
      const date = resolveDate(args.date);
      const current = (await summaryOf(date)).reflection;
      const rate = args.achievement_rate === undefined ? current.achievementRate : Number(args.achievement_rate);
      if (!Number.isInteger(rate) || rate < 0 || rate > 100) throw new ToolInputError("achievement_rate は 0〜100 の整数で指定してください");
      const pick = (value, fallback) => (value === undefined ? fallback : String(value));
      await saveReflection(appDb, userId, date, {
        achievementRate: rate,
        reason: pick(args.reason, current.reason),
        improvement: pick(args.improvement, current.improvement),
        goodPoints: pick(args.good_points, current.goodPoints),
        tomorrowNotes: pick(args.tomorrow_notes, current.tomorrowNotes),
      });
      return dayResult(date, { saved: true });
    },
  };
}

// ===== 生成AI（Cloudflare Workers AI） =====
// wrangler.toml の [ai] binding = "AI" を通じて呼び出します。APIキーは不要です。
const DEFAULT_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// 当日のタスク・予定・実績・振り返りをプロンプトに変換します。
function buildReflectionPrompt(summary) {
  const taskLines = summary.tasks.length
    ? summary.tasks.map((task) => `- [優先度${task.priority}] ${task.title}（${{ planned: "未評価", done: "完了", partial: "一部達成", missed: "未達" }[task.status]}）`)
    : ["（タスク未登録）"];
  const scheduleLines = summary.schedule.length
    ? summary.schedule.map((block) => `- ${block.startTime}〜${block.endTime} ${block.title}`)
    : ["（予定未登録）"];
  const logLines = summary.actualLogs.length
    ? summary.actualLogs.map((log) => `- ${log.title}（${log.durationMinutes ? `${log.durationMinutes}分` : "計測中"}）`)
    : ["（実績未記録）"];
  const existing = summary.reflection;

  return [
    `対象日: ${summary.day.date}`,
    `タスク達成率（自動計算）: ${existing.achievementRate}%`,
    "",
    "■ 目標タスク",
    ...taskLines,
    "",
    "■ 目標スケジュール",
    ...scheduleLines,
    "",
    "■ 実際の作業実績",
    ...logLines,
    "",
    "■ ユーザーがすでに書いたメモ（あれば尊重して膨らませる）",
    `理由: ${existing.reason || "未入力"}`,
    `改善点: ${existing.improvement || "未入力"}`,
    `良かった点: ${existing.goodPoints || "未入力"}`,
    `明日へのメモ: ${existing.tomorrowNotes || "未入力"}`,
  ].join("\n");
}

// AI応答からJSON部分だけを取り出します。前後に余計な文章が付いても解析できるようにします。
function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function generateAiReflection(env, summary) {
  const messages = [
    {
      role: "system",
      content: [
        "あなたは日本語で答える、1日の振り返りを支援するコーチです。",
        "ユーザーの1日の目標タスク・予定・実績をもとに、振り返りのドラフトを作成してください。",
        "事実に基づき、具体的で簡潔に書いてください。実績が少ない場合も責めずに前向きな改善案を出してください。",
        "必ず次のキーを持つJSONオブジェクトだけを出力してください（他の文章は一切不要）:",
        '{"comment": "1日への短い総評（1〜2文）", "reason": "達成率の理由の分析", "improvement": "明日から実行できる具体的な改善点", "goodPoints": "良かった点", "tomorrowNotes": "明日へのメモ・申し送り"}',
        "各値は日本語のプレーンテキストで、それぞれ200文字以内にしてください。",
      ].join("\n"),
    },
    { role: "user", content: buildReflectionPrompt(summary) },
  ];

  const result = await env.AI.run(env.AI_MODEL || DEFAULT_AI_MODEL, {
    messages,
    max_tokens: 1024,
    temperature: 0.4,
  });

  // モデルにより response が文字列・オブジェクトの両方で返るため、どちらにも対応します。
  const raw = typeof result === "string" ? result : result?.response;
  const parsed = raw && typeof raw === "object" ? raw : extractJsonObject(String(raw ?? ""));
  if (!parsed) throw new Error("AI応答の解析に失敗しました。もう一度お試しください。");

  return {
    comment: String(parsed.comment || ""),
    reason: String(parsed.reason || ""),
    improvement: String(parsed.improvement || ""),
    goodPoints: String(parsed.goodPoints || ""),
    tomorrowNotes: String(parsed.tomorrowNotes || ""),
  };
}

async function exchangeGoogleCode(env, request, code) {
  const config = googleConfig(env, request);
  if (!config.clientId || !config.clientSecret) throw new Error("Google OAuth client id/secret are not configured");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: "authorization_code" }),
  });
  if (!response.ok) throw new Error(`Google token exchange failed: ${await response.text()}`);
  return response.json();
}

// 単一のcatch-all Pages FunctionでAPIルーティングします。
// 機能ごとに大きなコメントを置き、処理のまとまりを追いやすくしています。
async function handleApi({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const appDb = db(env);

  try {
    if (request.method === "GET" && path === "/health") return json({ ok: true });

    // 認証状態確認
    if (request.method === "GET" && path === "/me") {
      const user = await currentUser(env, request);
      return json({ user });
    }

    // ユーザー登録
    if (request.method === "POST" && path === "/auth/register") {
      const body = await request.json();
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!email || password.length < 8) return badRequest("メールアドレスと8文字以上のパスワードが必要です");
      const created = await appDb.insert(users).values({ email, name: body.name || null, passwordHash: await hashPassword(password) }).returning({ id: users.id, email: users.email, name: users.name }).get();
      const headers = await createSession(env, request, created.id);
      return json({ user: created }, { headers });
    }

    // ログイン
    if (request.method === "POST" && path === "/auth/login") {
      const body = await request.json();
      const email = String(body.email || "").trim().toLowerCase();
      const user = await appDb.select().from(users).where(eq(users.email, email)).get();
      if (!user || !(await verifyPassword(String(body.password || ""), user.passwordHash))) return json({ error: "メールアドレスまたはパスワードが違います" }, { status: 401 });
      const headers = await createSession(env, request, user.id);
      return json({ user: { id: user.id, email: user.email, name: user.name } }, { headers });
    }

    // ログアウト
    if (request.method === "POST" && path === "/auth/logout") {
      const sessionId = getCookie(request, SESSION_COOKIE);
      if (sessionId) await appDb.delete(sessions).where(eq(sessions.id, sessionId)).run();
      const headers = new Headers();
      headers.append("set-cookie", sessionCookie("", request, 0));
      return json({ ok: true }, { headers });
    }

    // MCP エンドポイント。Cookie ではなく Authorization: Bearer（個人アクセストークン / OAuth）で認証します。
    if (path === "/mcp") {
      if (request.method === "OPTIONS") return corsPreflight();
      const mcpUser = await userFromBearerToken(env, request);
      return handleMcpRequest(request, mcpUser ? mcpOps(env, request, mcpUser) : null, {
        wwwAuthenticate: mcpWwwAuthenticate(requestOrigin(request), Boolean(bearerToken(request))),
      });
    }

    // OAuth 2.1（claude.ai などのカスタムコネクタ用）。詳細は functions/oauth/provider.js を参照してください。
    if (request.method === "OPTIONS" && path.startsWith("/oauth/")) return corsPreflight();
    if (request.method === "POST" && path === "/oauth/register") return registerClient(env, request);
    if (request.method === "GET" && path === "/oauth/authorize") return startAuthorization(env, request, requestOrigin(request));
    if (request.method === "POST" && path === "/oauth/token") return exchangeToken(env, request);

    const user = await requireUser(env, request).catch((response) => response);
    if (user instanceof Response) return user;

    // OAuth 同意画面に表示する連携リクエストの内容
    if (request.method === "GET" && path.startsWith("/oauth/requests/")) {
      return describeAuthorization(env, decodeURIComponent(path.split("/")[3] || ""));
    }

    // OAuth 同意 / 拒否。他サイトから送信させられないよう、Origin が自サイトであることも確認します。
    const decision = path.match(/^\/oauth\/requests\/([^/]+)\/(approve|deny)$/);
    if (request.method === "POST" && decision) {
      const origin = request.headers.get("origin");
      if (origin && origin !== requestOrigin(request)) return json({ error: "Invalid origin" }, { status: 403 });
      return decideAuthorization(env, requestOrigin(request), decodeURIComponent(decision[1]), user, decision[2] === "approve");
    }

    // OAuth で接続中のアプリ一覧と連携解除
    if (request.method === "GET" && path === "/oauth/connections") {
      return json({ connections: await listConnections(env, user.id) });
    }

    if (request.method === "DELETE" && path.startsWith("/oauth/connections/")) {
      await revokeConnection(env, user.id, decodeURIComponent(path.split("/")[3] || ""));
      return json({ connections: await listConnections(env, user.id) });
    }

    // ===== スマホ通知（Web Push）とリマインダー =====
    if (request.method === "GET" && path === "/notifications") {
      const vapid = vapidConfig(env);
      return json({
        configured: Boolean(vapid),
        publicKey: vapid?.publicKey || null,
        settings: await getNotificationSettings(env, user.id),
        subscriptions: await listSubscriptions(env, user.id),
        reminders: await listUpcomingReminders(env, user.id),
      });
    }

    if (request.method === "PUT" && path === "/notifications/settings") {
      const { settings, error } = validateNotificationSettings(await request.json());
      if (error) return badRequest(error);
      return json({ settings: await saveNotificationSettings(env, user.id, settings) });
    }

    if (request.method === "POST" && path === "/push/subscriptions") {
      const result = await saveSubscription(env, user.id, await request.json());
      return result.error ? badRequest(result.error) : json(result);
    }

    if (request.method === "DELETE" && path.startsWith("/push/subscriptions/")) {
      await deleteSubscription(env, user.id, Number(path.split("/")[3]));
      return json({ subscriptions: await listSubscriptions(env, user.id) });
    }

    // 登録済みの全端末にテスト通知を送ります。
    if (request.method === "POST" && path === "/push/test") {
      if (!vapidConfig(env)) return json({ error: "VAPID 鍵が設定されていないため通知を送れません（README の「スマホ通知」を参照）" }, { status: 503 });
      const result = await sendToUser(env, user.id, { title: "DailyPilot", body: "テスト通知です。この端末に通知が届きます。", tag: "test", url: "/" }, { urgency: "high", ttl: 600 });
      return json({ ...result, subscriptions: await listSubscriptions(env, user.id) });
    }

    if (request.method === "POST" && path === "/reminders") {
      const body = await request.json();
      if (!isValidDate(body.date) || !isValidTime(body.time)) return badRequest("日付と時刻を指定してください");
      const { error } = await createReminder(env, user.id, { message: body.message, remindAt: tokyoDateTimeToUnix(body.date, body.time) });
      if (error) return badRequest(error);
      return json({ reminders: await listUpcomingReminders(env, user.id) });
    }

    if (request.method === "DELETE" && path.startsWith("/reminders/")) {
      await cancelReminder(env, user.id, Number(path.split("/")[2]));
      return json({ reminders: await listUpcomingReminders(env, user.id) });
    }

    // MCP トークン一覧
    if (request.method === "GET" && path === "/mcp-tokens") {
      return json({ tokens: await listApiTokens(appDb, user.id) });
    }

    // MCP トークン発行。トークン本体はこのレスポンスでしか返しません。
    if (request.method === "POST" && path === "/mcp-tokens") {
      const body = await request.json();
      const name = String(body.name || "").trim().slice(0, 60) || "MCP";
      const token = `${API_TOKEN_PREFIX}${randomId(32)}`;
      await appDb.insert(apiTokens).values({ userId: user.id, name, tokenHash: await sha256Hex(token), tokenPrefix: token.slice(0, API_TOKEN_PREFIX.length + 6) }).run();
      return json({ token, tokens: await listApiTokens(appDb, user.id) });
    }

    // MCP トークン失効
    if (request.method === "DELETE" && path.startsWith("/mcp-tokens/")) {
      await appDb.delete(apiTokens).where(and(eq(apiTokens.userId, user.id), eq(apiTokens.id, Number(path.split("/")[2])))).run();
      return json({ tokens: await listApiTokens(appDb, user.id) });
    }

    // 日次サマリー取得。ここでGoogleカレンダー自動同期も実行します。
    if (request.method === "GET" && path.startsWith("/days/")) {
      const date = decodeURIComponent(path.split("/")[2] || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest("Invalid date");
      return json(await getDaySummary(env, request, user.id, date));
    }

    // タスク作成
    if (request.method === "POST" && path === "/tasks") {
      const body = await request.json();
      if (!body.title?.trim()) return badRequest("Task title is required");
      await createTask(appDb, user.id, { date: body.date, title: body.title.trim(), priority: body.priority });
      return json(await getDaySummary(env, request, user.id, body.date));
    }

    if (request.method === "PATCH" && path.startsWith("/tasks/")) {
      const id = Number(path.split("/")[2]);
      const body = await request.json();
      await updateTask(appDb, user.id, id, body);
      return json({ ok: true });
    }

    if (request.method === "DELETE" && path.startsWith("/tasks/")) {
      await appDb.delete(tasks).where(and(eq(tasks.userId, user.id), eq(tasks.id, Number(path.split("/")[2])))).run();
      return json({ ok: true });
    }

    // 予定ブロック作成
    if (request.method === "POST" && path === "/schedule") {
      const schedule = normalizeScheduleBody(await request.json());
      const validationError = validateScheduleInput(schedule);
      if (validationError) return badRequest(validationError);
      await createScheduleBlock(appDb, user.id, schedule);
      return json(await getDaySummary(env, request, user.id, schedule.date));
    }

    if (request.method === "PATCH" && path.startsWith("/schedule/")) {
      const id = Number(path.split("/")[2]);
      const body = await request.json();
      await appDb.update(scheduleBlocks).set({ title: body.title, startTime: body.startTime, endTime: body.endTime, updatedAt: sql`CURRENT_TIMESTAMP` }).where(and(eq(scheduleBlocks.userId, user.id), eq(scheduleBlocks.id, id))).run();
      return json({ ok: true });
    }

    if (request.method === "DELETE" && path.startsWith("/schedule/")) {
      await appDb.delete(scheduleBlocks).where(and(eq(scheduleBlocks.userId, user.id), eq(scheduleBlocks.id, Number(path.split("/")[2])))).run();
      return json({ ok: true });
    }

    // 実績ログ手入力。タイマーを使わなかった作業も後から実績に追加できます。
    if (request.method === "POST" && path === "/actual-logs") {
      const log = normalizeActualLogBody(await request.json());
      const validationError = validateActualLogInput(log);
      if (validationError) return badRequest(validationError);
      await createActualLog(appDb, user.id, log);
      return json(await getDaySummary(env, request, user.id, log.date));
    }

    if (request.method === "PATCH" && path.startsWith("/actual-logs/")) {
      const id = Number(path.split("/")[2]);
      const log = normalizeActualLogBody(await request.json());
      const validationError = validateActualLogInput(log);
      if (validationError) return badRequest(validationError);
      const startedAt = dateTimeToIso(log.date, log.startTime);
      const endedAt = dateTimeToIso(log.date, log.endTime);
      await appDb.update(actualLogs).set({ title: log.title, startedAt, endedAt, durationMinutes: minutesBetween(startedAt, endedAt) }).where(and(eq(actualLogs.userId, user.id), eq(actualLogs.id, id))).run();
      return json(await getDaySummary(env, request, user.id, log.date));
    }

    if (request.method === "DELETE" && path.startsWith("/actual-logs/")) {
      await appDb.delete(actualLogs).where(and(eq(actualLogs.userId, user.id), eq(actualLogs.id, Number(path.split("/")[2])))).run();
      return json({ ok: true });
    }

    // 実績タイマー開始
    if (request.method === "POST" && path === "/timer/start") {
      const body = await request.json();
      await startTimer(appDb, user.id, body);
      return json(await getDaySummary(env, request, user.id, body.date));
    }

    if (request.method === "POST" && path === "/timer/stop") {
      const body = await request.json();
      await stopTimer(appDb, user.id, body.logId);
      return json({ ok: true });
    }

    // 振り返り保存
    if (request.method === "PUT" && path.startsWith("/reflections/")) {
      const date = decodeURIComponent(path.split("/")[2] || "");
      const body = await request.json();
      await saveReflection(appDb, user.id, date, body);
      return json(await getDaySummary(env, request, user.id, date));
    }

    // AI振り返りドラフト生成。当日のデータを集めてWorkers AIに渡します。
    if (request.method === "POST" && path === "/ai/reflection") {
      const body = await request.json();
      if (!isValidDate(body.date)) return badRequest("Invalid date");
      if (!env.AI) {
        return json({ error: "AI機能が有効化されていません。wrangler.toml の [ai] binding を設定して再デプロイしてください。" }, { status: 503 });
      }
      const summary = await getDaySummary(env, request, user.id, body.date);
      const reflection = await generateAiReflection(env, summary);
      return json(reflection);
    }

    if (request.method === "GET" && path === "/google/config") {
      return json(googleConfigStatus(env, request));
    }

    // Google OAuth開始URLを生成します。CSRF対策としてstateをD1に保存します。
    if (request.method === "GET" && path === "/google/auth-url") {
      const status = googleConfigStatus(env, request);
      if (!status.configured) {
        return json({
          ...status,
          error: `Google OAuth の ${status.missing.join(", ")} が未設定です。リダイレクトURIは ${status.redirectUri} を Google Cloud Console に登録してください。`,
        }, { status: 503 });
      }
      const config = googleConfig(env, request);
      const state = randomId(24);
      await appDb.insert(oauthStates).values({ state, userId: user.id, expiresAt: Math.floor(Date.now() / 1000) + 600 }).run();
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", access_type: "offline", prompt: "consent", scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly", state }).toString();
      return json({ ...status, authUrl: authUrl.toString(), redirectUri: config.redirectUri });
    }

    // Google OAuth callback。state検証後にトークンを暗号化保存します。
    if (request.method === "GET" && path === "/google/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return badRequest("Missing Google authorization code or state");
      const oauthState = await appDb.select().from(oauthStates).where(and(eq(oauthStates.state, state), sql`${oauthStates.expiresAt} > ${Math.floor(Date.now() / 1000)}`)).get();
      if (!oauthState) return badRequest("Invalid or expired OAuth state");
      const token = await exchangeGoogleCode(env, request, code);
      const expiresAt = Math.floor(Date.now() / 1000) + token.expires_in;
      await appDb.insert(calendarAccounts).values({ userId: oauthState.userId, provider: GOOGLE_PROVIDER, encryptedAccessToken: await encryptToken(env, request, token.access_token), encryptedRefreshToken: await encryptToken(env, request, token.refresh_token), expiresAt }).onConflictDoUpdate({ target: [calendarAccounts.userId, calendarAccounts.provider], set: { encryptedAccessToken: await encryptToken(env, request, token.access_token), encryptedRefreshToken: token.refresh_token ? await encryptToken(env, request, token.refresh_token) : sql`${calendarAccounts.encryptedRefreshToken}`, expiresAt, updatedAt: sql`CURRENT_TIMESTAMP` } }).run();
      await appDb.delete(oauthStates).where(eq(oauthStates.state, state)).run();
      return Response.redirect(`${appBaseUrl(env, request)}/?google=connected`, 302);
    }

    if (request.method === "POST" && path === "/google/sync") {
      const body = await request.json();
      if (!isValidDate(body.date)) return badRequest("Invalid date");
      const day = await ensureDay(appDb, user.id, body.date);
      return json(await autoSyncGoogle(env, request, user.id, body.date, day.id, Boolean(body.force)));
    }

    // DailyPilotの予定をGoogleカレンダーへ追加します。
    if (request.method === "POST" && path === "/google/events") {
      const schedule = normalizeScheduleBody(await request.json());
      const validationError = validateScheduleInput(schedule);
      if (validationError) return badRequest(validationError);
      const accessToken = await getGoogleAccessToken(env, request, user.id);
      if (!accessToken) return json({ error: "Google Calendar is not connected" }, { status: 401 });
      const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ summary: schedule.title, start: { dateTime: `${schedule.date}T${schedule.startTime}:00+09:00` }, end: { dateTime: `${schedule.date}T${schedule.endTime}:00+09:00` } }),
      });
      if (!response.ok) return json({ error: await response.text() }, { status: 502 });
      const googleEvent = await response.json();
      if (schedule.scheduleBlockId && googleEvent.id) {
        await appDb.update(scheduleBlocks).set({ source: "google_calendar", externalEventId: googleEvent.id, updatedAt: sql`CURRENT_TIMESTAMP` }).where(and(eq(scheduleBlocks.userId, user.id), eq(scheduleBlocks.id, Number(schedule.scheduleBlockId)))).run();
      }
      return json(googleEvent);
    }

    return json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unexpected error" }, { status: 500 });
  }
}

export const onRequest = (context) => handleApi(context);
