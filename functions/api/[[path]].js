import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import {
  actualLogs,
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

function randomId(bytes = 24) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (byte) => byte.toString(16).padStart(2, "0")).join("");
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

// Google OAuthトークンはD1保存前にAES-GCMで暗号化します。
async function encryptionKey(env) {
  if (!env.TOKEN_ENCRYPTION_KEY) throw new Error("TOKEN_ENCRYPTION_KEY is required for Google token encryption");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.TOKEN_ENCRYPTION_KEY));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptToken(env, token) {
  if (!token) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), new TextEncoder().encode(token));
  return `${bytesToBase64(iv)}:${bytesToBase64(encrypted)}`;
}

async function decryptToken(env, encryptedToken) {
  if (!encryptedToken) return null;
  const [ivValue, tokenValue] = encryptedToken.split(":");
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(ivValue) }, await encryptionKey(env), base64ToBytes(tokenValue));
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

function localDateRange(date) {
  return { start: `${date}T00:00:00+09:00`, end: `${date}T23:59:59+09:00` };
}

function timeFromGoogle(value, fallback) {
  return (value || fallback).slice(11, 16);
}

// 暗号化済みトークンを復号し、期限切れの場合はrefresh tokenで更新します。
async function getGoogleAccessToken(env, userId) {
  const appDb = db(env);
  const account = await appDb.select().from(calendarAccounts).where(and(eq(calendarAccounts.userId, userId), eq(calendarAccounts.provider, GOOGLE_PROVIDER))).get();
  if (!account) return null;
  const currentAccessToken = await decryptToken(env, account.encryptedAccessToken);
  if (account.expiresAt > Math.floor(Date.now() / 1000) + 60) return currentAccessToken;
  const refreshToken = await decryptToken(env, account.encryptedRefreshToken);
  if (!refreshToken || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return currentAccessToken;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!response.ok) return currentAccessToken;
  const refreshed = await response.json();
  const expiresAt = Math.floor(Date.now() / 1000) + refreshed.expires_in;
  await appDb.update(calendarAccounts).set({ encryptedAccessToken: await encryptToken(env, refreshed.access_token), expiresAt, updatedAt: sql`CURRENT_TIMESTAMP` }).where(and(eq(calendarAccounts.userId, userId), eq(calendarAccounts.provider, GOOGLE_PROVIDER))).run();
  return refreshed.access_token;
}

async function fetchGoogleEvents(accessToken, date) {
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
async function autoSyncGoogle(env, userId, date, dayId, force = false) {
  const accessToken = await getGoogleAccessToken(env, userId);
  if (!accessToken) return { connected: false, synced: false };
  const appDb = db(env);
  const minutes = Number(env.CALENDAR_AUTO_SYNC_MINUTES || 15);
  const now = Math.floor(Date.now() / 1000);
  const syncRow = await appDb.select().from(calendarSyncs).where(and(eq(calendarSyncs.userId, userId), eq(calendarSyncs.provider, GOOGLE_PROVIDER), eq(calendarSyncs.date, date))).get();
  if (!force && syncRow && now - syncRow.syncedAt < minutes * 60) return { connected: true, synced: false, lastSyncedAt: syncRow.syncedAt };

  const events = await fetchGoogleEvents(accessToken, date);
  for (const event of events) {
    if (!event.id) continue;
    await appDb.insert(scheduleBlocks).values({
      dayId,
      userId,
      title: event.summary || "Google予定",
      startTime: timeFromGoogle(event.start?.dateTime, `${event.start?.date}T00:00:00`),
      endTime: timeFromGoogle(event.end?.dateTime, `${event.end?.date}T23:59:00`),
      source: "google_calendar",
      externalEventId: event.id,
      sortOrder: 0,
    }).onConflictDoUpdate({ target: [scheduleBlocks.userId, scheduleBlocks.externalEventId], set: { title: event.summary || "Google予定", startTime: timeFromGoogle(event.start?.dateTime, `${event.start?.date}T00:00:00`), endTime: timeFromGoogle(event.end?.dateTime, `${event.end?.date}T23:59:00`), updatedAt: sql`CURRENT_TIMESTAMP` } }).run();
  }
  await appDb.insert(calendarSyncs).values({ userId, provider: GOOGLE_PROVIDER, date, syncedAt: now }).onConflictDoUpdate({ target: [calendarSyncs.userId, calendarSyncs.provider, calendarSyncs.date], set: { syncedAt: now, updatedAt: sql`CURRENT_TIMESTAMP` } }).run();
  return { connected: true, synced: true, lastSyncedAt: now };
}

// フロントエンドが1回のAPI呼び出しで描画できるよう、日次画面に必要な情報をまとめて返します。
async function getDaySummary(env, userId, date) {
  const appDb = db(env);
  const day = await ensureDay(appDb, userId, date);
  const sync = await autoSyncGoogle(env, userId, date, day.id).catch((error) => ({ connected: true, synced: false, error: error.message }));
  const taskRows = await appDb.select().from(tasks).where(and(eq(tasks.userId, userId), eq(tasks.dayId, day.id))).orderBy(tasks.priority, tasks.sortOrder, tasks.id).all();
  const scheduleRows = await appDb.select().from(scheduleBlocks).where(and(eq(scheduleBlocks.userId, userId), eq(scheduleBlocks.dayId, day.id))).orderBy(scheduleBlocks.startTime, scheduleBlocks.id).all();
  const logRows = await appDb.select().from(actualLogs).where(and(eq(actualLogs.userId, userId), eq(actualLogs.dayId, day.id))).orderBy(actualLogs.startedAt, actualLogs.id).all();
  const reflection = await appDb.select().from(reflections).where(and(eq(reflections.userId, userId), eq(reflections.dayId, day.id))).get();
  const achievementRate = reflection?.achievementRate ?? calculateAchievement(taskRows);
  return { day, tasks: taskRows, schedule: scheduleRows, actualLogs: logRows, reflection: reflection || { achievementRate, reason: "", improvement: "", goodPoints: "", tomorrowNotes: "" }, googleSync: sync };
}

async function exchangeGoogleCode(env, code) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) throw new Error("Google OAuth environment variables are not configured");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: env.GOOGLE_REDIRECT_URI, grant_type: "authorization_code" }),
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

    const user = await requireUser(env, request).catch((response) => response);
    if (user instanceof Response) return user;

    // 日次サマリー取得。ここでGoogleカレンダー自動同期も実行します。
    if (request.method === "GET" && path.startsWith("/days/")) {
      const date = decodeURIComponent(path.split("/")[2] || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest("Invalid date");
      return json(await getDaySummary(env, user.id, date));
    }

    // タスク作成
    if (request.method === "POST" && path === "/tasks") {
      const body = await request.json();
      if (!body.title?.trim()) return badRequest("Task title is required");
      const day = await ensureDay(appDb, user.id, body.date);
      const [max] = await appDb.select({ next: sql`COALESCE(MAX(${tasks.sortOrder}), 0) + 1` }).from(tasks).where(and(eq(tasks.userId, user.id), eq(tasks.dayId, day.id), eq(tasks.priority, body.priority))).all();
      await appDb.insert(tasks).values({ dayId: day.id, userId: user.id, title: body.title.trim(), priority: body.priority, status: "planned", sortOrder: Number(max?.next || 1) }).run();
      return json(await getDaySummary(env, user.id, body.date));
    }

    if (request.method === "PATCH" && path.startsWith("/tasks/")) {
      const id = Number(path.split("/")[2]);
      const body = await request.json();
      await appDb.update(tasks).set({ title: body.title, priority: body.priority, status: body.status, updatedAt: sql`CURRENT_TIMESTAMP` }).where(and(eq(tasks.userId, user.id), eq(tasks.id, id))).run();
      return json({ ok: true });
    }

    if (request.method === "DELETE" && path.startsWith("/tasks/")) {
      await appDb.delete(tasks).where(and(eq(tasks.userId, user.id), eq(tasks.id, Number(path.split("/")[2])))).run();
      return json({ ok: true });
    }

    // 予定ブロック作成
    if (request.method === "POST" && path === "/schedule") {
      const body = await request.json();
      if (!body.title?.trim()) return badRequest("Schedule title is required");
      const day = await ensureDay(appDb, user.id, body.date);
      await appDb.insert(scheduleBlocks).values({ dayId: day.id, userId: user.id, title: body.title.trim(), startTime: body.startTime, endTime: body.endTime, source: body.source || "manual", externalEventId: body.externalEventId || null, sortOrder: 0 }).run();
      return json(await getDaySummary(env, user.id, body.date));
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

    // 実績タイマー開始
    if (request.method === "POST" && path === "/timer/start") {
      const body = await request.json();
      const day = await ensureDay(appDb, user.id, body.date);
      await appDb.insert(actualLogs).values({ dayId: day.id, userId: user.id, scheduleBlockId: body.scheduleBlockId || null, title: body.title, startedAt: new Date().toISOString() }).run();
      return json(await getDaySummary(env, user.id, body.date));
    }

    if (request.method === "POST" && path === "/timer/stop") {
      const body = await request.json();
      const endedAt = new Date();
      const log = await appDb.select().from(actualLogs).where(and(eq(actualLogs.userId, user.id), eq(actualLogs.id, body.logId))).get();
      const durationMinutes = log ? Math.max(1, Math.round((endedAt.getTime() - new Date(log.startedAt).getTime()) / 60000)) : null;
      await appDb.update(actualLogs).set({ endedAt: endedAt.toISOString(), durationMinutes }).where(and(eq(actualLogs.userId, user.id), eq(actualLogs.id, body.logId))).run();
      return json({ ok: true });
    }

    // 振り返り保存
    if (request.method === "PUT" && path.startsWith("/reflections/")) {
      const date = decodeURIComponent(path.split("/")[2] || "");
      const body = await request.json();
      const day = await ensureDay(appDb, user.id, date);
      await appDb.insert(reflections).values({ dayId: day.id, userId: user.id, achievementRate: body.achievementRate, reason: body.reason, improvement: body.improvement, goodPoints: body.goodPoints, tomorrowNotes: body.tomorrowNotes }).onConflictDoUpdate({ target: [reflections.userId, reflections.dayId], set: { achievementRate: body.achievementRate, reason: body.reason, improvement: body.improvement, goodPoints: body.goodPoints, tomorrowNotes: body.tomorrowNotes, updatedAt: sql`CURRENT_TIMESTAMP` } }).run();
      return json(await getDaySummary(env, user.id, date));
    }

    // Google OAuth開始URLを生成します。CSRF対策としてstateをD1に保存します。
    if (request.method === "GET" && path === "/google/auth-url") {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_REDIRECT_URI) return json({ configured: false, error: "Google OAuth is not configured" }, { status: 503 });
      const state = randomId(24);
      await appDb.insert(oauthStates).values({ state, userId: user.id, expiresAt: Math.floor(Date.now() / 1000) + 600 }).run();
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: env.GOOGLE_REDIRECT_URI, response_type: "code", access_type: "offline", prompt: "consent", scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly", state }).toString();
      return json({ configured: true, authUrl: authUrl.toString() });
    }

    // Google OAuth callback。state検証後にトークンを暗号化保存します。
    if (request.method === "GET" && path === "/google/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return badRequest("Missing Google authorization code or state");
      const oauthState = await appDb.select().from(oauthStates).where(and(eq(oauthStates.state, state), sql`${oauthStates.expiresAt} > ${Math.floor(Date.now() / 1000)}`)).get();
      if (!oauthState) return badRequest("Invalid or expired OAuth state");
      const token = await exchangeGoogleCode(env, code);
      const expiresAt = Math.floor(Date.now() / 1000) + token.expires_in;
      await appDb.insert(calendarAccounts).values({ userId: oauthState.userId, provider: GOOGLE_PROVIDER, encryptedAccessToken: await encryptToken(env, token.access_token), encryptedRefreshToken: await encryptToken(env, token.refresh_token), expiresAt }).onConflictDoUpdate({ target: [calendarAccounts.userId, calendarAccounts.provider], set: { encryptedAccessToken: await encryptToken(env, token.access_token), encryptedRefreshToken: token.refresh_token ? await encryptToken(env, token.refresh_token) : sql`${calendarAccounts.encryptedRefreshToken}`, expiresAt, updatedAt: sql`CURRENT_TIMESTAMP` } }).run();
      await appDb.delete(oauthStates).where(eq(oauthStates.state, state)).run();
      return Response.redirect(`${env.APP_BASE_URL || url.origin}/?google=connected`, 302);
    }

    if (request.method === "POST" && path === "/google/sync") {
      const body = await request.json();
      const day = await ensureDay(appDb, user.id, body.date);
      return json(await autoSyncGoogle(env, user.id, body.date, day.id, Boolean(body.force)));
    }

    // DailyPilotの予定をGoogleカレンダーへ追加します。
    if (request.method === "POST" && path === "/google/events") {
      const body = await request.json();
      const accessToken = await getGoogleAccessToken(env, user.id);
      if (!accessToken) return json({ error: "Google Calendar is not connected" }, { status: 401 });
      const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ summary: body.title, start: { dateTime: `${body.date}T${body.startTime}:00+09:00` }, end: { dateTime: `${body.date}T${body.endTime}:00+09:00` } }),
      });
      if (!response.ok) return json({ error: await response.text() }, { status: 502 });
      return json(await response.json());
    }

    return json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unexpected error" }, { status: 500 });
  }
}

export const onRequest = (context) => handleApi(context);
