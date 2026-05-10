const $ = (id) => document.getElementById(id);
const priorities = ["S", "A", "B"];
const statusMarks = { planned: "", done: "◯", partial: "△", missed: "☓" };
const statusLabels = { planned: "未評価", done: "完了", partial: "一部", missed: "未達" };
let summary = null;
let date = new Date().toISOString().slice(0, 10);

$("date").value = date;

async function api(path, init = {}) {
  const response = await fetch(`/api${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.classList.remove("hidden");
  window.setTimeout(() => element.classList.add("hidden"), 3500);
}

function minutes(time) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function formatJapaneseDate(value) {
  const parsed = new Date(`${value}T00:00:00+09:00`);
  return `${parsed.getMonth() + 1}月${parsed.getDate()}日`;
}

function field(value, camelName, snakeName) {
  return value?.[camelName] ?? value?.[snakeName];
}

function buildTaskLines(tasks, { includeStatusMarks = true } = {}) {
  return priorities.flatMap((priority) => {
    const priorityTasks = tasks.filter((task) => task.priority === priority);
    if (priorityTasks.length === 0) return [];
    return [`${priority}：${priorityTasks.map((task) => `${task.title}${includeStatusMarks ? statusMarks[task.status] : ""}`).join(priority === "A" ? "." : ",")}`];
  });
}

function buildTargetScheduleLines(schedule) {
  if (schedule.length === 0) return ["（目標スケジュール未登録）"];
  return schedule.map((block) => `${field(block, "startTime", "start_time")} - ${field(block, "endTime", "end_time")} ${block.title}`);
}

function formatLogTime(value) {
  return new Date(value).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" });
}

function buildActualScheduleLines(actualLogs, now = new Date()) {
  if (actualLogs.length === 0) return ["（実際のスケジュール未記録）"];
  return actualLogs.map((log) => {
    const startedAt = field(log, "startedAt", "started_at");
    const start = formatLogTime(startedAt);
    const endedAt = field(log, "endedAt", "ended_at");
    const isRunning = !endedAt;
    const end = isRunning ? "実行中" : formatLogTime(endedAt);
    const durationMinutes = isRunning
      ? Math.max(1, Math.round((now.getTime() - new Date(startedAt).getTime()) / 60000))
      : field(log, "durationMinutes", "duration_minutes");
    const duration = durationMinutes ? `（${isRunning ? "経過" : ""}${durationMinutes}分）` : "";
    return `${start} - ${end} ${log.title}${duration}`;
  });
}

function buildTargetExportText(data) {
  const targetTaskLines = buildTaskLines(data.tasks, { includeStatusMarks: false });
  const lines = [
    `【${formatJapaneseDate(data.day.date)} 目標】`,
    "目標タスク",
    ...(targetTaskLines.length ? targetTaskLines : ["タスクなし"]),
    "",
    "目標スケジュール",
    ...buildTargetScheduleLines(data.schedule),
  ];
  return lines.join("\n");
}

function buildActualExportText(data, now = new Date()) {
  const actualTaskLines = buildTaskLines(data.tasks);
  const lines = [
    `【${formatJapaneseDate(data.day.date)} 実際】`,
    "タスク完了状況",
    ...(actualTaskLines.length ? actualTaskLines : ["タスクなし"]),
    "",
    "実際のスケジュール（リアルタイム計測）",
    ...buildActualScheduleLines(data.actualLogs, now),
    "",
    "振り返り",
    `・タスク達成率 ${field(data.reflection, "achievementRate", "achievement_rate")}%`,
    "・理由",
    data.reflection.reason || "未入力",
    "・改善点",
    data.reflection.improvement || "未入力",
  ];
  const goodPoints = field(data.reflection, "goodPoints", "good_points");
  const tomorrowNotes = field(data.reflection, "tomorrowNotes", "tomorrow_notes");
  if (goodPoints) lines.push("・良かった点", goodPoints);
  if (tomorrowNotes) lines.push("・明日へのメモ", tomorrowNotes);
  return lines.join("\n");
}

async function load() {
  summary = await api(`/days/${date}`);
  render();
}

function render() {
  renderTasks();
  renderSchedule();
  renderLogs();
  renderReflection();
  $("targetExportText").value = buildTargetExportText(summary);
  $("actualExportText").value = buildActualExportText(summary);
}

function renderTasks() {
  $("tasks").innerHTML = priorities.map((priority) => {
    const tasks = summary.tasks.filter((task) => task.priority === priority).map((task) => `
      <div class="task" data-id="${task.id}">
        <input class="taskTitle" value="${escapeHtml(task.title)}" />
        <select class="taskStatus">${Object.entries(statusLabels).map(([value, label]) => `<option value="${value}" ${task.status === value ? "selected" : ""}>${label}</option>`).join("")}</select>
        <button class="ghost deleteTask">🗑️</button>
      </div>`).join("");
    return `<div class="priority"><strong>${priority}</strong><div class="taskList">${tasks || "<p class='muted'>未登録</p>"}</div></div>`;
  }).join("");

  document.querySelectorAll(".task").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector(".taskTitle").addEventListener("change", async (event) => updateTask(id, { title: event.target.value }));
    row.querySelector(".taskStatus").addEventListener("change", async (event) => updateTask(id, { status: event.target.value }));
    row.querySelector(".deleteTask").addEventListener("click", async () => deleteTask(id));
  });
}

function renderSchedule() {
  const overlaps = summary.schedule.some((block, index, blocks) => blocks.some((other, otherIndex) => index < otherIndex && minutes(block.start_time) < minutes(other.end_time) && minutes(other.start_time) < minutes(block.end_time)));
  $("overlapWarning").classList.toggle("hidden", !overlaps);
  $("timeline").innerHTML = summary.schedule.map((block) => `
    <div class="block ${block.source}" style="margin-top:${Math.max(0, (minutes(block.start_time) - 360) / 8)}px;min-height:${Math.max(46, (minutes(block.end_time) - minutes(block.start_time)) / 2)}px" data-id="${block.id}">
      <span>${block.start_time} - ${block.end_time}</span>
      <strong>${escapeHtml(block.title)}</strong>
      <em>${block.source === "google_calendar" ? "Google" : "Manual"}</em>
      <div><button class="pushGoogle">Googleへ追加</button><button class="ghost deleteSchedule">🗑️</button></div>
    </div>`).join("");
  document.querySelectorAll(".block").forEach((row) => {
    const block = summary.schedule.find((item) => String(item.id) === row.dataset.id);
    row.querySelector(".deleteSchedule").addEventListener("click", async () => deleteSchedule(block.id));
    row.querySelector(".pushGoogle").addEventListener("click", async () => pushToGoogle(block));
  });
}

function renderLogs() {
  $("logs").innerHTML = summary.actualLogs.map((log) => `
    <div data-id="${log.id}">
      <strong>${escapeHtml(log.title)}</strong>
      <span>${new Date(log.started_at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} ${log.ended_at ? `- ${new Date(log.ended_at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} (${log.duration_minutes}分)` : "実行中"}</span>
      ${log.ended_at ? "" : "<button class='stopTimer'>停止</button>"}
    </div>`).join("");
  document.querySelectorAll(".stopTimer").forEach((button) => button.addEventListener("click", async (event) => stopTimer(event.target.closest("div").dataset.id)));
}

function renderReflection() {
  $("achievementRate").value = summary.reflection.achievement_rate;
  $("reason").value = summary.reflection.reason;
  $("improvement").value = summary.reflection.improvement;
  $("goodPoints").value = summary.reflection.good_points;
  $("tomorrowNotes").value = summary.reflection.tomorrow_notes;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

async function addTask() {
  const title = $("taskTitle").value.trim();
  if (!title) return;
  summary = await api("/tasks", { method: "POST", body: JSON.stringify({ date, title, priority: $("taskPriority").value }) });
  $("taskTitle").value = "";
  render();
}

async function updateTask(id, patch) {
  await api(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  await load();
}

async function deleteTask(id) {
  await api(`/tasks/${id}`, { method: "DELETE" });
  await load();
}

async function addSchedule() {
  const title = $("scheduleTitle").value.trim();
  if (!title) return;
  summary = await api("/schedule", { method: "POST", body: JSON.stringify({ date, title, start_time: $("scheduleStart").value, end_time: $("scheduleEnd").value }) });
  $("scheduleTitle").value = "";
  $("scheduleStart").value = $("scheduleEnd").value;
  render();
}

async function deleteSchedule(id) {
  await api(`/schedule/${id}`, { method: "DELETE" });
  await load();
}

async function startTimer() {
  const title = $("timerTitle").value.trim();
  if (!title) return;
  summary = await api("/timer/start", { method: "POST", body: JSON.stringify({ date, title }) });
  $("timerTitle").value = "";
  render();
}

async function stopTimer(id) {
  await api("/timer/stop", { method: "POST", body: JSON.stringify({ log_id: Number(id) }) });
  await load();
}

async function saveReflection() {
  summary = await api(`/reflections/${date}`, {
    method: "PUT",
    body: JSON.stringify({
      achievement_rate: Number($("achievementRate").value),
      reason: $("reason").value,
      improvement: $("improvement").value,
      good_points: $("goodPoints").value,
      tomorrow_notes: $("tomorrowNotes").value,
    }),
  });
  render();
  toast("振り返りを保存しました");
}

async function connectGoogle() {
  const data = await api("/google/auth-url");
  if (data.authUrl) window.location.href = data.authUrl;
  else toast(data.error || "Google連携の設定が必要です");
}

async function fetchGoogleEvents() {
  const data = await api(`/google/events?date=${date}`);
  const container = $("googleEvents");
  container.innerHTML = (data.events || []).map((event) => `<button data-event='${escapeHtml(JSON.stringify(event))}'>${escapeHtml(event.summary || "無題")}<span>${(event.start.dateTime || event.start.date || "").slice(11, 16)} - ${(event.end.dateTime || event.end.date || "").slice(11, 16)}</span></button>`).join("") || "<p class='muted'>予定はありません。</p>";
  container.querySelectorAll("button").forEach((button) => button.addEventListener("click", async () => importGoogleEvent(JSON.parse(button.dataset.event))));
  toast(data.connected ? "Googleカレンダーを取得しました" : "Googleカレンダー未連携です");
}

async function importGoogleEvent(event) {
  const start = (event.start.dateTime || `${event.start.date}T00:00:00`).slice(11, 16);
  const end = (event.end.dateTime || `${event.end.date}T23:59:00`).slice(11, 16);
  summary = await api("/schedule", { method: "POST", body: JSON.stringify({ date, title: event.summary || "Google予定", start_time: start, end_time: end, source: "google_calendar", external_event_id: event.id }) });
  render();
}

async function pushToGoogle(block) {
  await api("/google/events", { method: "POST", body: JSON.stringify({ date, title: block.title, start_time: block.start_time, end_time: block.end_time }) });
  toast("Googleカレンダーに追加しました");
}

$("date").addEventListener("change", async (event) => { date = event.target.value; await load(); });
$("addTask").addEventListener("click", () => addTask().catch((error) => toast(error.message)));
$("taskTitle").addEventListener("keydown", (event) => { if (event.key === "Enter") addTask().catch((error) => toast(error.message)); });
$("addSchedule").addEventListener("click", () => addSchedule().catch((error) => toast(error.message)));
$("startTimer").addEventListener("click", () => startTimer().catch((error) => toast(error.message)));
$("saveReflection").addEventListener("click", () => saveReflection().catch((error) => toast(error.message)));
$("connectGoogle").addEventListener("click", () => connectGoogle().catch((error) => toast(error.message)));
$("fetchGoogle").addEventListener("click", () => fetchGoogleEvents().catch((error) => toast(error.message)));
$("copyTargetText").addEventListener("click", async () => { await navigator.clipboard.writeText($("targetExportText").value); toast("目標をコピーしました"); });
$("copyActualText").addEventListener("click", async () => { await navigator.clipboard.writeText($("actualExportText").value); toast("実際をコピーしました"); });

window.setInterval(() => {
  if (summary) $("actualExportText").value = buildActualExportText(summary);
}, 30000);

load().catch((error) => toast(error.message));
