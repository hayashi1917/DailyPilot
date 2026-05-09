const json = (data, init = {}) => new Response(JSON.stringify(data), {
  ...init,
  headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) },
});
const badRequest = (message) => json({ error: message }, { status: 400 });

function getCookie(request, name) {
  const cookie = request.headers.get("cookie") || "";
  return cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function randomId() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ensureSession(request) {
  const existing = getCookie(request, "daily_pilot_session");
  const sessionId = existing || randomId();
  const headers = new Headers();
  if (!existing) headers.append("set-cookie", `daily_pilot_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  return { sessionId, headers };
}

async function ensureDay(db, date) {
  await db.prepare("INSERT OR IGNORE INTO days(date, title) VALUES (?, ?)").bind(date, `${date} タスクマネジメント`).run();
  const day = await db.prepare("SELECT id, date, title FROM days WHERE date = ?").bind(date).first();
  if (!day) throw new Error("Failed to create day");
  return day;
}

function calculateAchievement(tasks) {
  if (!tasks.length) return 0;
  const weights = { S: 3, A: 2, B: 1 };
  const score = { done: 1, partial: 0.5, planned: 0, missed: 0 };
  const totalWeight = tasks.reduce((sum, task) => sum + weights[task.priority], 0);
  const achieved = tasks.reduce((sum, task) => sum + weights[task.priority] * score[task.status], 0);
  return Math.round((achieved / totalWeight) * 100);
}

async function getDaySummary(db, date) {
  const day = await ensureDay(db, date);
  const tasks = await db.prepare("SELECT id, title, priority, status, sort_order FROM tasks WHERE day_id = ? ORDER BY priority, sort_order, id").bind(day.id).all();
  const schedule = await db.prepare("SELECT id, title, start_time, end_time, source, external_event_id, sort_order FROM schedule_blocks WHERE day_id = ? ORDER BY start_time, id").bind(day.id).all();
  const logs = await db.prepare("SELECT id, title, started_at, ended_at, duration_minutes FROM actual_logs WHERE day_id = ? ORDER BY started_at, id").bind(day.id).all();
  const reflection = await db.prepare("SELECT achievement_rate, reason, improvement, good_points, tomorrow_notes FROM reflections WHERE day_id = ?").bind(day.id).first();
  const taskRows = tasks.results || [];
  const achievementRate = reflection?.achievement_rate ?? calculateAchievement(taskRows);
  return {
    day,
    tasks: taskRows,
    schedule: schedule.results || [],
    actualLogs: logs.results || [],
    reflection: reflection || { achievement_rate: achievementRate, reason: "", improvement: "", good_points: "", tomorrow_notes: "" },
  };
}

async function exchangeGoogleCode(env, code) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) throw new Error("Google OAuth environment variables are not configured");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) throw new Error(`Google token exchange failed: ${await response.text()}`);
  return response.json();
}

async function getGoogleAccessToken(env, sessionId) {
  const account = await env.DB.prepare("SELECT access_token, refresh_token, expires_at FROM calendar_accounts WHERE session_id = ? AND provider = 'google'").bind(sessionId).first();
  if (!account) return null;
  if (account.expires_at > Math.floor(Date.now() / 1000) + 60) return account.access_token;
  if (!account.refresh_token || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return account.access_token;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: account.refresh_token, grant_type: "refresh_token" }),
  });
  if (!response.ok) return account.access_token;
  const refreshed = await response.json();
  const expiresAt = Math.floor(Date.now() / 1000) + refreshed.expires_in;
  await env.DB.prepare("UPDATE calendar_accounts SET access_token = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ? AND provider = 'google'").bind(refreshed.access_token, expiresAt, sessionId).run();
  return refreshed.access_token;
}

function localDateRange(date) {
  return { start: `${date}T00:00:00+09:00`, end: `${date}T23:59:59+09:00` };
}

async function handleApi({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const { sessionId, headers } = await ensureSession(request);

  try {
    if (request.method === "GET" && path === "/health") return json({ ok: true }, { headers });

    if (request.method === "GET" && path.startsWith("/days/")) {
      const date = decodeURIComponent(path.split("/")[2] || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest("Invalid date");
      return json(await getDaySummary(env.DB, date), { headers });
    }

    if (request.method === "POST" && path === "/tasks") {
      const body = await request.json();
      if (!body.title?.trim()) return badRequest("Task title is required");
      const day = await ensureDay(env.DB, body.date);
      const max = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM tasks WHERE day_id = ? AND priority = ?").bind(day.id, body.priority).first();
      await env.DB.prepare("INSERT INTO tasks(day_id, title, priority, sort_order) VALUES (?, ?, ?, ?)").bind(day.id, body.title.trim(), body.priority, max?.next || 1).run();
      return json(await getDaySummary(env.DB, body.date), { headers });
    }

    if (request.method === "PATCH" && path.startsWith("/tasks/")) {
      const id = Number(path.split("/")[2]);
      const body = await request.json();
      await env.DB.prepare("UPDATE tasks SET title = COALESCE(?, title), priority = COALESCE(?, priority), status = COALESCE(?, status), updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(body.title, body.priority, body.status, id).run();
      return json({ ok: true }, { headers });
    }

    if (request.method === "DELETE" && path.startsWith("/tasks/")) {
      await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(Number(path.split("/")[2])).run();
      return json({ ok: true }, { headers });
    }

    if (request.method === "POST" && path === "/schedule") {
      const body = await request.json();
      if (!body.title?.trim()) return badRequest("Schedule title is required");
      const day = await ensureDay(env.DB, body.date);
      await env.DB.prepare("INSERT INTO schedule_blocks(day_id, title, start_time, end_time, source, external_event_id) VALUES (?, ?, ?, ?, ?, ?)").bind(day.id, body.title.trim(), body.start_time, body.end_time, body.source || "manual", body.external_event_id || null).run();
      return json(await getDaySummary(env.DB, body.date), { headers });
    }

    if (request.method === "PATCH" && path.startsWith("/schedule/")) {
      const id = Number(path.split("/")[2]);
      const body = await request.json();
      await env.DB.prepare("UPDATE schedule_blocks SET title = COALESCE(?, title), start_time = COALESCE(?, start_time), end_time = COALESCE(?, end_time), updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(body.title, body.start_time, body.end_time, id).run();
      return json({ ok: true }, { headers });
    }

    if (request.method === "DELETE" && path.startsWith("/schedule/")) {
      await env.DB.prepare("DELETE FROM schedule_blocks WHERE id = ?").bind(Number(path.split("/")[2])).run();
      return json({ ok: true }, { headers });
    }

    if (request.method === "POST" && path === "/timer/start") {
      const body = await request.json();
      const day = await ensureDay(env.DB, body.date);
      await env.DB.prepare("INSERT INTO actual_logs(day_id, schedule_block_id, title, started_at) VALUES (?, ?, ?, ?)").bind(day.id, body.schedule_block_id || null, body.title, new Date().toISOString()).run();
      return json(await getDaySummary(env.DB, body.date), { headers });
    }

    if (request.method === "POST" && path === "/timer/stop") {
      const body = await request.json();
      const endedAt = new Date();
      const log = await env.DB.prepare("SELECT started_at FROM actual_logs WHERE id = ?").bind(body.log_id).first();
      const minutes = log ? Math.max(1, Math.round((endedAt.getTime() - new Date(log.started_at).getTime()) / 60000)) : null;
      await env.DB.prepare("UPDATE actual_logs SET ended_at = ?, duration_minutes = ? WHERE id = ?").bind(endedAt.toISOString(), minutes, body.log_id).run();
      return json({ ok: true }, { headers });
    }

    if (request.method === "PUT" && path.startsWith("/reflections/")) {
      const date = decodeURIComponent(path.split("/")[2] || "");
      const body = await request.json();
      const day = await ensureDay(env.DB, date);
      await env.DB.prepare(`INSERT INTO reflections(day_id, achievement_rate, reason, improvement, good_points, tomorrow_notes)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(day_id) DO UPDATE SET achievement_rate = excluded.achievement_rate, reason = excluded.reason, improvement = excluded.improvement, good_points = excluded.good_points, tomorrow_notes = excluded.tomorrow_notes, updated_at = CURRENT_TIMESTAMP`).bind(day.id, body.achievement_rate, body.reason, body.improvement, body.good_points, body.tomorrow_notes).run();
      return json(await getDaySummary(env.DB, date), { headers });
    }

    if (request.method === "GET" && path === "/google/auth-url") {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_REDIRECT_URI) return json({ configured: false, error: "Google OAuth is not configured" }, { status: 503, headers });
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.search = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: env.GOOGLE_REDIRECT_URI,
        response_type: "code",
        access_type: "offline",
        prompt: "consent",
        scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly",
        state: sessionId,
      }).toString();
      return json({ configured: true, authUrl: authUrl.toString() }, { headers });
    }

    if (request.method === "GET" && path === "/google/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") || sessionId;
      if (!code) return badRequest("Missing Google authorization code");
      const token = await exchangeGoogleCode(env, code);
      const expiresAt = Math.floor(Date.now() / 1000) + token.expires_in;
      await env.DB.prepare(`INSERT INTO calendar_accounts(session_id, provider, access_token, refresh_token, expires_at)
        VALUES (?, 'google', ?, ?, ?)
        ON CONFLICT(session_id, provider) DO UPDATE SET access_token = excluded.access_token, refresh_token = COALESCE(excluded.refresh_token, calendar_accounts.refresh_token), expires_at = excluded.expires_at, updated_at = CURRENT_TIMESTAMP`).bind(state, token.access_token, token.refresh_token || null, expiresAt).run();
      return Response.redirect(`${env.APP_BASE_URL || url.origin}/?google=connected`, 302);
    }

    if (request.method === "GET" && path === "/google/events") {
      const date = url.searchParams.get("date");
      if (!date) return badRequest("date is required");
      const accessToken = await getGoogleAccessToken(env, sessionId);
      if (!accessToken) return json({ connected: false, events: [] }, { headers });
      const range = localDateRange(date);
      const eventsUrl = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
      eventsUrl.search = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", timeMin: range.start, timeMax: range.end }).toString();
      const response = await fetch(eventsUrl, { headers: { authorization: `Bearer ${accessToken}` } });
      if (!response.ok) return json({ connected: true, error: await response.text(), events: [] }, { status: 502, headers });
      const data = await response.json();
      return json({ connected: true, events: data.items || [] }, { headers });
    }

    if (request.method === "POST" && path === "/google/events") {
      const body = await request.json();
      const accessToken = await getGoogleAccessToken(env, sessionId);
      if (!accessToken) return json({ error: "Google Calendar is not connected" }, { status: 401, headers });
      const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ summary: body.title, start: { dateTime: `${body.date}T${body.start_time}:00+09:00` }, end: { dateTime: `${body.date}T${body.end_time}:00+09:00` } }),
      });
      if (!response.ok) return json({ error: await response.text() }, { status: 502, headers });
      return json(await response.json(), { headers });
    }

    return json({ error: "Not found" }, { status: 404, headers });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unexpected error" }, { status: 500, headers });
  }
}

export const onRequest = (context) => handleApi(context);
