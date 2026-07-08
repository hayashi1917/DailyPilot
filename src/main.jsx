import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// 優先度・達成状況など、画面とテキスト出力で共通利用する定数です。
const PRIORITIES = ["S", "A", "B"];
const STATUS_MARKS = { planned: "", done: "◯", partial: "△", missed: "☓" };
const STATUS_LABELS = { planned: "未評価", done: "完了", partial: "一部", missed: "未達" };
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const TODAY = new Date().toISOString().slice(0, 10);

async function api(path, init = {}) {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new Error(errorBody?.error || response.statusText);
  }

  return response.json();
}

function japaneseDate(value) {
  const parsed = new Date(`${value}T00:00:00+09:00`);
  return `${parsed.getMonth() + 1}月${parsed.getDate()}日`;
}

function japaneseDateWithWeekday(value) {
  const parsed = new Date(`${value}T00:00:00Z`);
  return `${parsed.getUTCMonth() + 1}月${parsed.getUTCDate()}日（${WEEKDAYS[parsed.getUTCDay()]}）`;
}

function shiftDate(value, delta) {
  const parsed = new Date(`${value}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + delta);
  return parsed.toISOString().slice(0, 10);
}

function minutes(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function hasScheduleOverlap(schedule) {
  return schedule.some((block, index, blocks) =>
    blocks.some((other, otherIndex) =>
      index < otherIndex &&
      minutes(block.startTime) < minutes(other.endTime) &&
      minutes(other.startTime) < minutes(block.endTime),
    ),
  );
}

function formatLogTime(value) {
  return new Date(value).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tokyo",
  });
}

function buildTaskLines(tasks, { includeStatusMarks = true } = {}) {
  return PRIORITIES.flatMap((priority) => {
    const priorityTasks = tasks.filter((task) => task.priority === priority);
    if (priorityTasks.length === 0) return [];

    const separator = priority === "A" ? "." : ",";
    const taskText = priorityTasks
      .map((task) => `${task.title}${includeStatusMarks ? STATUS_MARKS[task.status] : ""}`)
      .join(separator);
    return [`${priority}：${taskText}`];
  });
}

function buildTargetScheduleLines(schedule) {
  if (schedule.length === 0) return ["（目標スケジュール未登録）"];
  return schedule.map((block) => `${block.startTime} - ${block.endTime} ${block.title}`);
}

function buildActualScheduleLines(actualLogs, now = new Date()) {
  if (actualLogs.length === 0) return ["（実際のスケジュール未記録）"];

  return actualLogs.map((log) => {
    const start = formatLogTime(log.startedAt);
    const isRunning = !log.endedAt;
    const end = isRunning ? "実行中" : formatLogTime(log.endedAt);
    const durationMinutes = isRunning
      ? Math.max(1, Math.round((now.getTime() - new Date(log.startedAt).getTime()) / 60000))
      : log.durationMinutes;
    const duration = durationMinutes ? `（${isRunning ? "経過" : ""}${durationMinutes}分）` : "";
    return `${start} - ${end} ${log.title}${duration}`;
  });
}

function buildTargetExportText(summary) {
  const targetTaskLines = buildTaskLines(summary.tasks, { includeStatusMarks: false });

  return [
    `【${japaneseDate(summary.day.date)} 目標】`,
    "目標タスク",
    ...(targetTaskLines.length ? targetTaskLines : ["タスクなし"]),
    "",
    "目標スケジュール",
    ...buildTargetScheduleLines(summary.schedule),
  ].join("\n");
}

function buildActualExportText(summary, now = new Date()) {
  const actualTaskLines = buildTaskLines(summary.tasks);
  const reflectionLines = [
    "振り返り",
    `・タスク達成率 ${summary.reflection.achievementRate}%`,
    "・理由",
    summary.reflection.reason || "未入力",
    "・改善点",
    summary.reflection.improvement || "未入力",
  ];

  if (summary.reflection.goodPoints) reflectionLines.push("・良かった点", summary.reflection.goodPoints);
  if (summary.reflection.tomorrowNotes) reflectionLines.push("・明日へのメモ", summary.reflection.tomorrowNotes);

  return [
    `【${japaneseDate(summary.day.date)} 実際】`,
    "タスク完了状況",
    ...(actualTaskLines.length ? actualTaskLines : ["タスクなし"]),
    "",
    "実際のスケジュール（リアルタイム計測）",
    ...buildActualScheduleLines(summary.actualLogs, now),
    "",
    ...reflectionLines,
  ].join("\n");
}

function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ email: "", password: "", name: "" });
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setMessage("");

    try {
      const endpoint = mode === "login" ? "/auth/login" : "/auth/register";
      const result = await api(endpoint, { method: "POST", body: JSON.stringify(form) });
      onAuthenticated(result.user);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="authShell">
      <section className="authCard">
        <div className="authBrand">
          <span className="brandMark">DP</span>
          <span className="brandName">DailyPilot</span>
        </div>
        <h1>一日の設計と振り返りを、ひとつの画面で。</h1>
        <p className="authLead">目標タスク・スケジュール・実績・振り返りをまとめて管理し、Googleカレンダーとも同期できます。</p>

        <div className="authTabs" role="tablist">
          <button
            type="button"
            className={mode === "login" ? "active" : ""}
            onClick={() => setMode("login")}
          >
            ログイン
          </button>
          <button
            type="button"
            className={mode === "register" ? "active" : ""}
            onClick={() => setMode("register")}
          >
            アカウント作成
          </button>
        </div>

        <form onSubmit={submit} className="stack">
          {mode === "register" && (
            <input
              placeholder="名前（任意）"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          )}
          <input
            type="email"
            placeholder="メールアドレス"
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
            required
          />
          <input
            type="password"
            placeholder="パスワード（8文字以上）"
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
            required
            minLength={8}
          />
          <button className="primary" disabled={submitting}>
            {submitting ? "送信中..." : mode === "login" ? "ログイン" : "作成して開始"}
          </button>
        </form>

        {message && <p className="formError">{message}</p>}
      </section>
    </main>
  );
}

// タスクの達成状況を ◯ / △ / ☓ のチップで切り替えます。同じチップをもう一度押すと未評価に戻ります。
function TaskStatusChips({ task, onMutate }) {
  return (
    <div className="statusChips">
      {["done", "partial", "missed"].map((status) => (
        <button
          key={status}
          type="button"
          title={STATUS_LABELS[status]}
          className={`statusChip ${status} ${task.status === status ? "active" : ""}`}
          onClick={() => onMutate(api(`/tasks/${task.id}`, {
            method: "PATCH",
            body: JSON.stringify({ status: task.status === status ? "planned" : status }),
          }))}
        >
          {STATUS_MARKS[status]}
        </button>
      ))}
    </div>
  );
}

function TaskPanel({ date, tasks, onMutate }) {
  const [draft, setDraft] = useState({ title: "", priority: "A" });

  function addTask(event) {
    event.preventDefault();
    if (!draft.title.trim()) return;
    onMutate(
      api("/tasks", { method: "POST", body: JSON.stringify({ date, ...draft }) }),
    );
    setDraft({ ...draft, title: "" });
  }

  return (
    <article className="card">
      <header className="cardHead">
        <h2>タスク</h2>
        <span className="cardHint">S / A / B 優先度</span>
      </header>

      <form className="inlineForm" onSubmit={addTask}>
        <select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value })}>
          {PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}
        </select>
        <input
          placeholder="タスクを追加"
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
        <button className="primary">追加</button>
      </form>

      {PRIORITIES.map((priority) => {
        const priorityTasks = tasks.filter((task) => task.priority === priority);
        return (
          <div className="prioritySection" key={priority}>
            <div className="priorityHead">
              <span className={`priorityBadge p${priority}`}>{priority}</span>
              <span className="priorityCount">{priorityTasks.length}件</span>
            </div>
            {priorityTasks.length === 0 && <p className="empty">未登録</p>}
            {priorityTasks.map((task) => (
              <div className={`taskRow ${task.status}`} key={task.id}>
                <input
                  className="taskTitle"
                  value={task.title}
                  onChange={(event) => onMutate(api(`/tasks/${task.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ title: event.target.value }),
                  }))}
                />
                <TaskStatusChips task={task} onMutate={onMutate} />
                <button
                  className="iconBtn danger"
                  title="削除"
                  onClick={() => onMutate(api(`/tasks/${task.id}`, { method: "DELETE" }))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        );
      })}
    </article>
  );
}

function GoogleCalendarPanel({ date, googleSync, setMessage, onMutate }) {
  const [googleConfig, setGoogleConfig] = useState(null);

  useEffect(() => {
    api("/google/config")
      .then(setGoogleConfig)
      .catch((error) => setMessage(error.message));
  }, [setMessage]);

  async function connectGoogle() {
    try {
      const data = await api("/google/auth-url");
      if (data.authUrl) {
        window.location.href = data.authUrl;
        return;
      }
      setMessage(data.error || "Google連携の設定が必要です");
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function copyRedirectUri() {
    if (!googleConfig?.redirectUri) return;
    await navigator.clipboard.writeText(googleConfig.redirectUri);
    setMessage("Google OAuth のリダイレクトURIをコピーしました");
  }

  return (
    <article className="card">
      <header className="cardHead">
        <h2>Googleカレンダー</h2>
        <span className={`syncDot ${googleSync?.connected ? "on" : "off"}`}>
          {googleSync?.connected ? "接続済み" : "未接続"}
        </span>
      </header>
      <p className="muted">対象日を開くたびに一定間隔で自動同期します。今すぐ反映したい場合は「今すぐ同期」を押してください。</p>
      <div className="actions">
        <button className="primary" onClick={connectGoogle}>Google連携</button>
        <button className="ghost" onClick={() => onMutate(
          api("/google/sync", { method: "POST", body: JSON.stringify({ date, force: true }) }),
          "Googleカレンダーを同期しました",
        )}>
          今すぐ同期
        </button>
      </div>
      {googleConfig?.redirectUri && (
        <details className="oauthHint">
          <summary>redirect_uri_mismatch が出る場合</summary>
          <p>Google Cloud Console の「承認済みのリダイレクト URI」に、以下を完全一致で登録してください。</p>
          <code>{googleConfig.redirectUri}</code>
          {googleConfig.ignoredConfiguredRedirectUri && (
            <p className="formError">古い GOOGLE_REDIRECT_URI（{googleConfig.ignoredConfiguredRedirectUri}）は現在のアクセス元と違うため無視しています。</p>
          )}
          <button className="ghost small" onClick={copyRedirectUri}>URIをコピー</button>
        </details>
      )}
    </article>
  );
}

function SchedulePanel({ date, schedule, overlaps, onMutate }) {
  const [draft, setDraft] = useState({ title: "", startTime: "09:00", endTime: "10:00" });

  function addSchedule(event) {
    event.preventDefault();
    if (!draft.title.trim()) return;
    onMutate(api("/schedule", { method: "POST", body: JSON.stringify({ date, ...draft }) }));
    setDraft({ title: "", startTime: draft.endTime, endTime: draft.endTime });
  }

  return (
    <article className="card">
      <header className="cardHead">
        <h2>スケジュール</h2>
        <span className="cardHint">{schedule.length}件の予定</span>
      </header>

      <form className="inlineForm scheduleForm" onSubmit={addSchedule}>
        <input type="time" value={draft.startTime} onChange={(event) => setDraft({ ...draft, startTime: event.target.value })} />
        <span className="timeSep">→</span>
        <input type="time" value={draft.endTime} onChange={(event) => setDraft({ ...draft, endTime: event.target.value })} />
        <input className="grow" placeholder="予定を追加" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        <button className="primary">追加</button>
      </form>

      {overlaps && <p className="inlineWarning">時間が重複している予定があります。</p>}

      <div className="timeline">
        {schedule.length === 0 && <p className="empty">予定はまだありません</p>}
        {schedule.map((block) => (
          <div
            className={`timelineRow ${block.source === "google_calendar" ? "google" : "manual"}`}
            key={block.id}
          >
            <div className="timelineTime">
              <span>{block.startTime}</span>
              <span className="timelineTimeEnd">{block.endTime}</span>
            </div>
            <div
              className="timelineBody"
              style={{ minHeight: Math.max(56, (minutes(block.endTime) - minutes(block.startTime)) / 2) }}
            >
              <div className="timelineText">
                <strong>{block.title}</strong>
                <span className="sourceTag">{block.source === "google_calendar" ? "Google" : "手動"}</span>
              </div>
              <div className="rowActions">
                <button
                  className="ghost small"
                  disabled={Boolean(block.externalEventId)}
                  onClick={() => onMutate(api("/google/events", {
                    method: "POST",
                    body: JSON.stringify({ scheduleBlockId: block.id, date, title: block.title, startTime: block.startTime, endTime: block.endTime }),
                  }), "Googleカレンダーへ追加しました")}
                >
                  {block.externalEventId ? "連携済み" : "Googleへ追加"}
                </button>
                <button className="iconBtn danger" title="削除" onClick={() => onMutate(api(`/schedule/${block.id}`, { method: "DELETE" }))}>×</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function timeInputValue(value) {
  return new Date(value).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tokyo" });
}

function TimerPanel({ date, actualLogs, currentTime, onMutate }) {
  const [timerTitle, setTimerTitle] = useState("");
  const [manualLog, setManualLog] = useState({ title: "", startTime: "09:00", endTime: "10:00" });
  const [editingLogId, setEditingLogId] = useState(null);
  const [editingLog, setEditingLog] = useState(null);

  const runningLog = actualLogs.find((log) => !log.endedAt);

  function startTimer(event) {
    event.preventDefault();
    if (!timerTitle.trim()) return;
    onMutate(api("/timer/start", { method: "POST", body: JSON.stringify({ date, title: timerTitle }) }));
    setTimerTitle("");
  }

  function addManualLog(event) {
    event.preventDefault();
    if (!manualLog.title.trim()) return;
    onMutate(api("/actual-logs", { method: "POST", body: JSON.stringify({ date, ...manualLog }) }));
    setManualLog({ title: "", startTime: manualLog.endTime, endTime: manualLog.endTime });
  }

  function beginEditLog(log) {
    setEditingLogId(log.id);
    setEditingLog({ title: log.title, startTime: timeInputValue(log.startedAt), endTime: log.endedAt ? timeInputValue(log.endedAt) : timeInputValue(new Date()) });
  }

  function saveEditingLog(id) {
    if (!editingLog?.title.trim()) return;
    onMutate(api(`/actual-logs/${id}`, { method: "PATCH", body: JSON.stringify({ date, ...editingLog }) }));
    setEditingLogId(null);
    setEditingLog(null);
  }

  function elapsedMinutes(log) {
    return Math.max(1, Math.round((currentTime.getTime() - new Date(log.startedAt).getTime()) / 60000));
  }

  return (
    <article className="card">
      <header className="cardHead">
        <h2>実績タイマー</h2>
        {runningLog && <span className="runningPill">計測中</span>}
      </header>

      <form className="inlineForm" onSubmit={startTimer}>
        <input placeholder="いま行うこと" value={timerTitle} onChange={(event) => setTimerTitle(event.target.value)} />
        <button className="primary">開始</button>
      </form>

      <div className="logs">
        {actualLogs.length === 0 && <p className="empty">実績はまだありません</p>}
        {actualLogs.map((log) => (
          <div className={`logRow ${!log.endedAt ? "running" : ""}`} key={log.id}>
            {editingLogId === log.id ? (
              <div className="logEdit">
                <input value={editingLog.title} onChange={(event) => setEditingLog({ ...editingLog, title: event.target.value })} />
                <div className="logEditTimes">
                  <input type="time" value={editingLog.startTime} onChange={(event) => setEditingLog({ ...editingLog, startTime: event.target.value })} />
                  <span className="timeSep">→</span>
                  <input type="time" value={editingLog.endTime} onChange={(event) => setEditingLog({ ...editingLog, endTime: event.target.value })} />
                  <div className="rowActions">
                    <button className="primary small" onClick={() => saveEditingLog(log.id)}>保存</button>
                    <button className="ghost small" onClick={() => { setEditingLogId(null); setEditingLog(null); }}>取消</button>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className="logText">
                  <strong>{log.title}</strong>
                  <span>
                    {formatLogTime(log.startedAt)}
                    {log.endedAt
                      ? ` - ${formatLogTime(log.endedAt)}・${log.durationMinutes}分`
                      : `から計測中・${elapsedMinutes(log)}分経過`}
                  </span>
                </div>
                <div className="rowActions">
                  {!log.endedAt ? (
                    <button className="primary small" onClick={() => onMutate(api("/timer/stop", { method: "POST", body: JSON.stringify({ logId: log.id }) }))}>停止</button>
                  ) : (
                    <button className="ghost small" onClick={() => beginEditLog(log)}>編集</button>
                  )}
                  <button className="iconBtn danger" title="削除" onClick={() => onMutate(api(`/actual-logs/${log.id}`, { method: "DELETE" }))}>×</button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      <details className="manualLogBox">
        <summary>実績を手入力する</summary>
        <p className="muted">タイマーを押し忘れた作業も、実績として後から追加できます。</p>
        <form className="inlineForm scheduleForm" onSubmit={addManualLog}>
          <input type="time" value={manualLog.startTime} onChange={(event) => setManualLog({ ...manualLog, startTime: event.target.value })} />
          <span className="timeSep">→</span>
          <input type="time" value={manualLog.endTime} onChange={(event) => setManualLog({ ...manualLog, endTime: event.target.value })} />
          <input className="grow" placeholder="例: 会議・移動・家事" value={manualLog.title} onChange={(event) => setManualLog({ ...manualLog, title: event.target.value })} />
          <button className="primary">追加</button>
        </form>
      </details>
    </article>
  );
}

function ReflectionPanel({ date, reflection, setMessage, onMutate }) {
  const [draft, setDraft] = useState(reflection);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiComment, setAiComment] = useState("");

  useEffect(() => setDraft(reflection), [reflection]);

  // 当日のタスク・予定・実績をもとに、AIが振り返りのドラフトを生成します。
  async function generateWithAi() {
    setAiLoading(true);
    try {
      const data = await api("/ai/reflection", { method: "POST", body: JSON.stringify({ date }) });
      setDraft((current) => ({
        ...current,
        reason: data.reason || current.reason,
        improvement: data.improvement || current.improvement,
        goodPoints: data.goodPoints || current.goodPoints,
        tomorrowNotes: data.tomorrowNotes || current.tomorrowNotes,
      }));
      setAiComment(data.comment || "");
      setMessage("AIが振り返りドラフトを生成しました。内容を確認して保存してください。");
    } catch (error) {
      setMessage(`AI生成に失敗しました: ${error.message}`);
    } finally {
      setAiLoading(false);
    }
  }

  return (
    <article className="card">
      <header className="cardHead">
        <h2>振り返り</h2>
        <button className="aiButton" onClick={generateWithAi} disabled={aiLoading}>
          {aiLoading ? "生成中..." : "✦ AIでドラフト生成"}
        </button>
      </header>

      {aiComment && (
        <div className="aiComment">
          <span className="aiCommentLabel">AIからのコメント</span>
          <p>{aiComment}</p>
        </div>
      )}

      <div className="reflection">
        <label className="rateLabel">
          <span>タスク達成率 <strong>{draft.achievementRate}%</strong></span>
          <input
            type="range"
            min="0"
            max="100"
            value={draft.achievementRate}
            onChange={(event) => setDraft({ ...draft, achievementRate: Number(event.target.value) })}
          />
        </label>
        <div className="reflectionGrid">
          <label>理由<textarea value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} /></label>
          <label>改善点<textarea value={draft.improvement} onChange={(event) => setDraft({ ...draft, improvement: event.target.value })} /></label>
          <label>良かった点<textarea value={draft.goodPoints} onChange={(event) => setDraft({ ...draft, goodPoints: event.target.value })} /></label>
          <label>明日へのメモ<textarea value={draft.tomorrowNotes} onChange={(event) => setDraft({ ...draft, tomorrowNotes: event.target.value })} /></label>
        </div>
        <div className="actions">
          <button
            className="primary"
            onClick={() => onMutate(api(`/reflections/${date}`, {
              method: "PUT",
              body: JSON.stringify(draft),
            }), "振り返りを保存しました")}
          >
            振り返りを保存
          </button>
        </div>
      </div>
    </article>
  );
}

function ExportPanel({ targetExportText, actualExportText, setMessage }) {
  const [editableActualText, setEditableActualText] = useState(actualExportText);
  const [actualTextEdited, setActualTextEdited] = useState(false);

  useEffect(() => {
    if (!actualTextEdited) setEditableActualText(actualExportText);
  }, [actualExportText, actualTextEdited]);

  function restoreActualText() {
    setEditableActualText(actualExportText);
    setActualTextEdited(false);
  }

  async function copyText(label, text) {
    await navigator.clipboard.writeText(text);
    setMessage(`${label}をコピーしました`);
  }

  return (
    <article className="card">
      <header className="cardHead">
        <h2>テキスト出力</h2>
        <span className="cardHint">目標と実際を別々にコピーできます</span>
      </header>
      <div className="exportSplit">
        <div className="exportPane">
          <h3>目標</h3>
          <textarea value={targetExportText} readOnly aria-label="目標テキスト出力" />
          <button className="ghost" onClick={() => copyText("目標", targetExportText)}>目標をコピー</button>
        </div>
        <div className="exportPane">
          <h3>実際</h3>
          <textarea value={editableActualText} onChange={(event) => { setEditableActualText(event.target.value); setActualTextEdited(true); }} aria-label="実際テキスト出力" />
          <div className="actions">
            <button className="ghost" onClick={() => copyText("実際", editableActualText)}>実際をコピー</button>
            <button className="linkButton" onClick={restoreActualText}>自動生成に戻す</button>
          </div>
        </div>
      </div>
    </article>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [date, setDate] = useState(TODAY);
  const [summary, setSummary] = useState(null);
  const [message, setMessage] = useState("");
  const [currentTime, setCurrentTime] = useState(() => new Date());

  // 初回表示時にセッションCookieからログイン状態を復元します。
  useEffect(() => {
    api("/me")
      .then((result) => setUser(result.user))
      .finally(() => setCheckingAuth(false));
  }, []);

  // 対象日を開くたびに日次サマリーを取得します。API側でGoogle自動同期も実行されます。
  useEffect(() => {
    if (user) loadSummary();
  }, [user, date]);

  // 実行中タイマーの経過分数をテキスト出力へ反映するため、定期的に現在時刻を更新します。
  useEffect(() => {
    const timerId = window.setInterval(() => setCurrentTime(new Date()), 30000);
    return () => window.clearInterval(timerId);
  }, []);

  // 通知トーストは数秒後に自動で閉じます。
  useEffect(() => {
    if (!message) return;
    const timerId = window.setTimeout(() => setMessage(""), 4500);
    return () => window.clearTimeout(timerId);
  }, [message]);

  async function loadSummary() {
    const data = await api(`/days/${date}`);
    setSummary(data);

    if (data.googleSync?.synced) setMessage("Googleカレンダーを自動同期しました");
    if (data.googleSync?.error) setMessage(`Google自動同期に失敗しました: ${data.googleSync.error}`);
  }

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    setUser(null);
    setSummary(null);
  }

  async function mutate(promise, successMessage) {
    try {
      const data = await promise;
      if (data?.day) setSummary(data);
      else await loadSummary();
      if (successMessage) setMessage(successMessage);
    } catch (error) {
      setMessage(error.message);
    }
  }

  const targetExportText = useMemo(() => (summary ? buildTargetExportText(summary) : ""), [summary]);
  const actualExportText = useMemo(() => (summary ? buildActualExportText(summary, currentTime) : ""), [summary, currentTime]);
  const overlaps = summary ? hasScheduleOverlap(summary.schedule) : false;

  if (checkingAuth) return <main className="loading">読み込み中...</main>;
  if (!user) return <AuthScreen onAuthenticated={setUser} />;
  if (!summary) return <main className="loading">DailyPilotを準備中...</main>;

  const doneCount = summary.tasks.filter((task) => task.status === "done").length;
  const loggedMinutes = summary.actualLogs.reduce((sum, log) => sum + (log.durationMinutes || 0), 0);

  return (
    <div className="appShell">
      <header className="topbar">
        <div className="brand">
          <span className="brandMark">DP</span>
          <span className="brandName">DailyPilot</span>
        </div>

        <div className="dateNav">
          <button className="iconBtn" title="前日" onClick={() => setDate(shiftDate(date, -1))}>‹</button>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          <button className="iconBtn" title="翌日" onClick={() => setDate(shiftDate(date, 1))}>›</button>
          {date !== TODAY && <button className="ghost small" onClick={() => setDate(TODAY)}>今日へ</button>}
        </div>

        <div className="topbarRight">
          <span className="userEmail">{user.email}</span>
          <button className="ghost small" onClick={logout}>ログアウト</button>
        </div>
      </header>

      <main className="page">
        <div className="pageHead">
          <h1>{japaneseDateWithWeekday(date)}</h1>
          <div className="stats">
            <div className="stat">
              <span className="statValue">{doneCount} / {summary.tasks.length}</span>
              <span className="statLabel">タスク完了</span>
            </div>
            <div className="stat">
              <span className="statValue">{summary.schedule.length}</span>
              <span className="statLabel">予定</span>
            </div>
            <div className="stat">
              <span className="statValue">{Math.floor(loggedMinutes / 60)}h {loggedMinutes % 60}m</span>
              <span className="statLabel">実績時間</span>
            </div>
            <div className="stat">
              <span className="statValue">{summary.reflection.achievementRate}%</span>
              <span className="statLabel">達成率</span>
            </div>
          </div>
        </div>

        <div className="dashboard">
          <div className="col colLeft">
            <TaskPanel date={date} tasks={summary.tasks} onMutate={mutate} />
            <GoogleCalendarPanel date={date} googleSync={summary.googleSync} setMessage={setMessage} onMutate={mutate} />
          </div>
          <div className="col colCenter">
            <SchedulePanel date={date} schedule={summary.schedule} overlaps={overlaps} onMutate={mutate} />
          </div>
          <div className="col colRight">
            <TimerPanel date={date} actualLogs={summary.actualLogs} currentTime={currentTime} onMutate={mutate} />
          </div>
        </div>

        <ReflectionPanel date={date} reflection={summary.reflection} setMessage={setMessage} onMutate={mutate} />
        <ExportPanel targetExportText={targetExportText} actualExportText={actualExportText} setMessage={setMessage} />
      </main>

      {message && <div className="toast">{message}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
