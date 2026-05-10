import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// 優先度・達成状況など、画面とテキスト出力で共通利用する定数です。
const PRIORITIES = ["S", "A", "B"];
const STATUS_MARKS = { planned: "", done: "◯", partial: "△", missed: "☓" };
const STATUS_LABELS = { planned: "未評価", done: "完了", partial: "一部", missed: "未達" };
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

function buildTaskLines(tasks) {
  return PRIORITIES.flatMap((priority) => {
    const priorityTasks = tasks.filter((task) => task.priority === priority);
    if (priorityTasks.length === 0) return [];

    const separator = priority === "A" ? "." : ",";
    const taskText = priorityTasks
      .map((task) => `${task.title}${STATUS_MARKS[task.status]}`)
      .join(separator);
    return [`${priority}：${taskText}`];
  });
}

function buildIdealScheduleLines(schedule) {
  if (schedule.length === 0) return ["予定なし"];
  return schedule.map((block) => `${block.startTime} - ${block.endTime} ${block.title}`);
}

function buildActualScheduleLines(actualLogs) {
  if (actualLogs.length === 0) return ["実績ログなし"];

  return actualLogs.map((log) => {
    const start = formatLogTime(log.startedAt);
    const end = log.endedAt ? formatLogTime(log.endedAt) : "実行中";
    const duration = log.durationMinutes ? `（${log.durationMinutes}分）` : "";
    return `${start} - ${end} ${log.title}${duration}`;
  });
}

function buildExportText(summary) {
  const lines = [`【${japaneseDate(summary.day.date)}タスクマネジメント】`];
  const taskLines = buildTaskLines(summary.tasks);

  if (taskLines.length) lines.push(...taskLines);

function buildTargetExportText(summary) {
  const targetTaskLines = buildTaskLines(summary.tasks, { includeStatusMarks: false });
  const lines = [
    `【${japaneseDate(summary.day.date)} 目標】`,
    "目標タスク",
    ...(targetTaskLines.length ? targetTaskLines : ["タスクなし"]),
    "",
    "目標スケジュール",
    ...buildTargetScheduleLines(summary.schedule),
  ];

  return lines.join("\n");
}

function buildActualExportText(summary, now = new Date()) {
  const actualTaskLines = buildTaskLines(summary.tasks);
  const lines = [
    `【${japaneseDate(summary.day.date)} 実際】`,
    "タスク完了状況",
    ...(actualTaskLines.length ? actualTaskLines : ["タスクなし"]),
    "",
    "実際のスケジュール（リアルタイム計測）",
    ...buildActualScheduleLines(summary.actualLogs, now),
    "",
    "理想の1日のスケジュール",
    ...buildIdealScheduleLines(summary.schedule),
    "",
    "実際に過ごした1日のスケジュール",
    ...buildActualScheduleLines(summary.actualLogs),
    "",
    "タスク完了状況",
    ...(taskLines.length ? taskLines : ["タスクなし"]),
    "",
    "振り返り",
    `・タスク達成率 ${summary.reflection.achievementRate}%`,
    "・理由",
    summary.reflection.reason || "未入力",
    "・改善点",
    summary.reflection.improvement || "未入力",
  ];

  if (summary.reflection.goodPoints) lines.push("・良かった点", summary.reflection.goodPoints);
  if (summary.reflection.tomorrowNotes) lines.push("・明日へのメモ", summary.reflection.tomorrowNotes);

  return lines.join("\n");
}

function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ email: "", password: "", name: "" });
  const [message, setMessage] = useState("");

  async function submit(event) {
    event.preventDefault();

    try {
      const endpoint = mode === "login" ? "/auth/login" : "/auth/register";
      const result = await api(endpoint, { method: "POST", body: JSON.stringify(form) });
      onAuthenticated(result.user);
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <main className="authShell">
      <section className="authCard">
        <p className="eyebrow">DailyPilot</p>
        <h1>{mode === "login" ? "ログイン" : "アカウント作成"}</h1>
        <p>複数ユーザーで運用できるよう、ユーザーごとにタスク、予定、Googleカレンダー連携を分離して保存します。</p>

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
          <button>{mode === "login" ? "ログイン" : "作成して開始"}</button>
        </form>

        {message && <p className="warning">{message}</p>}
        <button className="linkButton" onClick={() => setMode(mode === "login" ? "register" : "login")}>
          {mode === "login" ? "アカウントを作成する" : "ログインに戻る"}
        </button>
      </section>
    </main>
  );
}

function TaskPanel({ date, tasks, onMutate }) {
  const [draft, setDraft] = useState({ title: "", priority: "A" });

  function addTask() {
    if (!draft.title.trim()) return;
    onMutate(
      api("/tasks", { method: "POST", body: JSON.stringify({ date, ...draft }) }),
    );
    setDraft({ ...draft, title: "" });
  }

  return (
    <article className="card">
      <h2>✅ タスク管理</h2>
      <div className="inlineForm">
        <select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value })}>
          {PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}
        </select>
        <input
          placeholder="例: デロイトWebテスト"
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
        <button onClick={addTask}>追加</button>
      </div>

      {PRIORITIES.map((priority) => {
        const priorityTasks = tasks.filter((task) => task.priority === priority);
        return (
          <div className="priority" key={priority}>
            <strong>{priority}</strong>
            <div className="taskList">
              {priorityTasks.length === 0 && <p className="muted">未登録</p>}
              {priorityTasks.map((task) => (
                <div className="task" key={task.id}>
                  <input
                    value={task.title}
                    onChange={(event) => onMutate(api(`/tasks/${task.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ title: event.target.value }),
                    }))}
                  />
                  <select
                    value={task.status}
                    onChange={(event) => onMutate(api(`/tasks/${task.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ status: event.target.value }),
                    }))}
                  >
                    {Object.entries(STATUS_LABELS).map(([value, label]) => (
                      <option value={value} key={value}>{label}</option>
                    ))}
                  </select>
                  <button className="ghost" onClick={() => onMutate(api(`/tasks/${task.id}`, { method: "DELETE" }))}>削除</button>
                </div>
              ))}
            </div>
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
      <h2>📅 Googleカレンダー</h2>
      <p className="muted">Google連携後は、対象日を開くたびに一定間隔で自動同期します。今すぐ反映したい場合は「今すぐ同期」を押してください。</p>
      {googleConfig?.redirectUri && (
        <div className="oauthHint">
          <strong>redirect_uri_mismatch が出る場合</strong>
          <p>Google Cloud Console の「承認済みのリダイレクト URI」に、以下を完全一致で登録してください。</p>
          <code>{googleConfig.redirectUri}</code>
          {googleConfig.ignoredConfiguredRedirectUri && (
            <p className="warning compact">古い GOOGLE_REDIRECT_URI（{googleConfig.ignoredConfiguredRedirectUri}）は現在のアクセス元と違うため無視しています。</p>
          )}
          <button className="ghost" onClick={copyRedirectUri}>URIをコピー</button>
        </div>
      )}
      <div className="actions">
        <button onClick={connectGoogle}>Google連携</button>
        <button onClick={() => onMutate(
          api("/google/sync", { method: "POST", body: JSON.stringify({ date, force: true }) }),
          "Googleカレンダーを同期しました",
        )}>
          今すぐ同期
        </button>
      </div>
      <p className="muted">同期状態: {googleSync?.connected ? "接続済み" : "未接続"}</p>
    </article>
  );
}

function SchedulePanel({ date, schedule, overlaps, onMutate }) {
  const [draft, setDraft] = useState({ title: "", startTime: "09:00", endTime: "10:00" });

  function addSchedule() {
    if (!draft.title.trim()) return;
    onMutate(api("/schedule", { method: "POST", body: JSON.stringify({ date, ...draft }) }));
    setDraft({ title: "", startTime: draft.endTime, endTime: draft.endTime });
  }

  return (
    <article className="card scheduleCard">
      <h2>🗓️ 1日のスケジュール</h2>
      <div className="inlineForm scheduleForm">
        <input type="time" value={draft.startTime} onChange={(event) => setDraft({ ...draft, startTime: event.target.value })} />
        <input type="time" value={draft.endTime} onChange={(event) => setDraft({ ...draft, endTime: event.target.value })} />
        <input placeholder="例: 長期インターン①" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        <button onClick={addSchedule}>追加</button>
      </div>

      {overlaps && <p className="warning">時間が重複している予定があります。</p>}
      <div className="timeline">
        {schedule.map((block) => (
          <div
            className={`block ${block.source}`}
            key={block.id}
            style={{ minHeight: Math.max(46, (minutes(block.endTime) - minutes(block.startTime)) / 2) }}
          >
            <span>{block.startTime} - {block.endTime}</span>
            <strong>{block.title}</strong>
            <em>{block.source === "google_calendar" ? "Google" : "Manual"}</em>
            <div>
              <button onClick={() => onMutate(api("/google/events", {
                method: "POST",
                body: JSON.stringify({ date, title: block.title, startTime: block.startTime, endTime: block.endTime }),
              }), "Googleカレンダーへ追加しました")}>
                Googleへ追加
              </button>
              <button className="ghost" onClick={() => onMutate(api(`/schedule/${block.id}`, { method: "DELETE" }))}>削除</button>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function TimerAndReflectionPanel({ date, actualLogs, reflection, onMutate }) {
  const [timerTitle, setTimerTitle] = useState("");

  function startTimer() {
    if (!timerTitle.trim()) return;
    onMutate(api("/timer/start", { method: "POST", body: JSON.stringify({ date, title: timerTitle }) }));
    setTimerTitle("");
  }

  return (
    <article className="card">
      <h2>▶️ 実績タイマー</h2>
      <div className="inlineForm">
        <input placeholder="いま行うこと" value={timerTitle} onChange={(event) => setTimerTitle(event.target.value)} />
        <button onClick={startTimer}>開始</button>
      </div>

      <div className="logs">
        {actualLogs.map((log) => (
          <div key={log.id}>
            <strong>{log.title}</strong>
            <span>
              {new Date(log.startedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}
              {log.endedAt
                ? ` - ${new Date(log.endedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} (${log.durationMinutes}分)`
                : " 実行中"}
            </span>
            {!log.endedAt && (
              <button onClick={() => onMutate(api("/timer/stop", {
                method: "POST",
                body: JSON.stringify({ logId: log.id }),
              }))}>
                停止
              </button>
            )}
          </div>
        ))}
      </div>

      <ReflectionForm
        reflection={reflection}
        onSave={(nextReflection) => onMutate(api(`/reflections/${date}`, {
          method: "PUT",
          body: JSON.stringify(nextReflection),
        }), "振り返りを保存しました")}
      />
    </article>
  );
}

function ReflectionForm({ reflection, onSave }) {
  const [draft, setDraft] = useState(reflection);

  useEffect(() => setDraft(reflection), [reflection]);

  return (
    <div className="reflection">
      <h2>振り返り</h2>
      <label>タスク達成率<input type="number" min="0" max="100" value={draft.achievementRate} onChange={(event) => setDraft({ ...draft, achievementRate: Number(event.target.value) })} /></label>
      <label>理由<textarea value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} /></label>
      <label>改善点<textarea value={draft.improvement} onChange={(event) => setDraft({ ...draft, improvement: event.target.value })} /></label>
      <label>良かった点<textarea value={draft.goodPoints} onChange={(event) => setDraft({ ...draft, goodPoints: event.target.value })} /></label>
      <label>明日へのメモ<textarea value={draft.tomorrowNotes} onChange={(event) => setDraft({ ...draft, tomorrowNotes: event.target.value })} /></label>
      <button onClick={() => onSave(draft)}>振り返りを保存</button>
    </div>
  );
}

function ExportPanel({ targetExportText, actualExportText, setMessage }) {
  async function copyText(label, text) {
    await navigator.clipboard.writeText(text);
    setMessage(`${label}をコピーしました`);
  }

  return (
    <section className="card exportCard">
      <h2>📋 テキスト出力</h2>
      <p className="muted">目標（予定）と実際（タスク完了状況・リアルタイム計測・振り返り）を別々に出力します。</p>
      <div className="exportSplit">
        <div className="exportPane">
          <h3>🎯 目標</h3>
          <textarea value={targetExportText} readOnly aria-label="目標テキスト出力" />
          <button onClick={() => copyText("目標", targetExportText)}>目標をコピー</button>
        </div>
        <div className="exportPane">
          <h3>📈 実際</h3>
          <textarea value={actualExportText} readOnly aria-label="実際テキスト出力" />
          <button onClick={() => copyText("実際", actualExportText)}>実際をコピー</button>
        </div>
      </div>
    </section>
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

  return (
    <main>
      <header className="hero">
        <div>
          <p className="eyebrow">DailyPilot</p>
          <h1>目標スケジュール・実績・振り返りを1画面で作成</h1>
          <p>ログイン中: {user.email} / Googleカレンダーは日次画面の読み込み時に自動同期されます。</p>
        </div>
        <div className="headerActions">
          <label>対象日<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <button className="secondary" onClick={logout}>ログアウト</button>
        </div>
      </header>

      {message && <div className="toast">{message}</div>}

      <section className="grid two">
        <TaskPanel date={date} tasks={summary.tasks} onMutate={mutate} />
        <GoogleCalendarPanel date={date} googleSync={summary.googleSync} setMessage={setMessage} onMutate={mutate} />
      </section>

      <section className="grid two">
        <SchedulePanel date={date} schedule={summary.schedule} overlaps={overlaps} onMutate={mutate} />
        <TimerAndReflectionPanel date={date} actualLogs={summary.actualLogs} reflection={summary.reflection} onMutate={mutate} />
      </section>

      <ExportPanel targetExportText={targetExportText} actualExportText={actualExportText} setMessage={setMessage} />
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
