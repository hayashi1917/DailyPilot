import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import {
  PRIORITIES,
  STATUS_LABELS,
  STATUS_MARKS,
  buildActualExportText,
  buildTargetExportText,
  formatLogTime,
} from "../shared/exportText.js";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
// 予定や実績はすべて日本時間で扱うため、端末のタイムゾーンに関係なく日本時間の日付にします。
const TODAY = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
// claude.ai などから OAuth 連携で開かれたときの連携リクエストID（同意画面を表示します）。
const OAUTH_REQUEST_ID = new URLSearchParams(window.location.search).get("oauth_request");

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

function AuthScreen({ onAuthenticated, notice }) {
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
        {notice && <p className="authNotice">{notice}</p>}

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

// テキストエリアの高さを内容に合わせて伸縮させます。
function autosize(element) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

// タスク名は長くても全文が見えるよう折り返して表示し、フォーカスを外したとき（またはEnter）に保存します。
function TaskTitle({ task, onMutate }) {
  const [value, setValue] = useState(task.title);
  const ref = React.useRef(null);

  useEffect(() => setValue(task.title), [task.title]);
  useEffect(() => autosize(ref.current), [value]);
  useEffect(() => {
    const handleResize = () => autosize(ref.current);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  function commit() {
    const title = value.trim();
    if (!title) {
      setValue(task.title);
      return;
    }
    if (title !== task.title) {
      onMutate(api(`/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ title }) }));
    }
  }

  return (
    <textarea
      ref={ref}
      rows={1}
      className="taskTitle"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
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
                <TaskTitle task={task} onMutate={onMutate} />
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

// Googleカレンダーの接続状態・同期ボタンを、スケジュールカード内にコンパクトに表示します。
function GoogleSyncBar({ date, googleSync, setMessage, onMutate }) {
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
    <div className="googleBar">
      <div className="googleBarMain">
        <span className={`syncDot ${googleSync?.connected && !googleSync?.error ? "on" : "off"}`}>
          Googleカレンダー{!googleSync?.connected ? "未接続" : googleSync?.error ? "の同期エラー" : "と同期中"}
        </span>
        <div className="actions">
          {googleSync?.connected ? (
            <>
              <button
                className="ghost small"
                title="対象日を開くたびに一定間隔で自動同期します。今すぐ反映したい場合に押してください。"
                onClick={() => onMutate(
                  api("/google/sync", { method: "POST", body: JSON.stringify({ date, force: true }) }),
                  "Googleカレンダーを同期しました",
                )}
              >
                今すぐ同期
              </button>
              {/* 連携が取り消された・期限切れなどで同期できない場合に、OAuth をやり直せるようにします。 */}
              <button className="linkButton small" title="同期に失敗し続ける場合は、Googleとの連携をやり直してください。" onClick={connectGoogle}>再連携</button>
            </>
          ) : (
            <button className="ghost small" onClick={connectGoogle}>Google連携</button>
          )}
        </div>
      </div>
      {googleConfig?.redirectUri && (!googleSync?.connected || googleSync?.error) && (
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
    </div>
  );
}

function SchedulePanel({ date, schedule, overlaps, googleSync, setMessage, onMutate }) {
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

      <GoogleSyncBar date={date} googleSync={googleSync} setMessage={setMessage} onMutate={onMutate} />

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
              <strong className="timelineTitle">{block.title}</strong>
              <div className="timelineMeta">
                <span className="sourceTag">{block.source === "google_calendar" ? "Google" : "手動"}</span>
                <div className="rowActions">
                  {block.externalEventId ? (
                    <span className="linkedTag">連携済み</span>
                  ) : (
                    <button
                      className="linkButton small"
                      onClick={() => onMutate(api("/google/events", {
                        method: "POST",
                        body: JSON.stringify({ scheduleBlockId: block.id, date, title: block.title, startTime: block.startTime, endTime: block.endTime }),
                      }), "Googleカレンダーへ追加しました")}
                    >
                      Googleへ追加
                    </button>
                  )}
                  <button className="iconBtn danger" title="削除" onClick={() => onMutate(api(`/schedule/${block.id}`, { method: "DELETE" }))}>×</button>
                </div>
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

function formatUnixTime(value) {
  if (!value) return "未使用";
  return new Date(value * 1000).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" });
}

// ===== スマホ通知（Web Push） =====

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const IS_STANDALONE = window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
const PUSH_SUPPORTED = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64 + "===".slice((base64.length + 3) % 4)), (char) => char.charCodeAt(0));
}

// 端末一覧で見分けられるよう、端末の種類とブラウザから表示名を作ります。
function deviceLabel() {
  const ua = navigator.userAgent;
  const device = IS_IOS ? (/iPad/.test(ua) || navigator.maxTouchPoints > 1 && /Macintosh/.test(ua) ? "iPad" : "iPhone") : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "PC";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "ブラウザ";
  return `${device}・${IS_STANDALONE ? "ホーム画面アプリ" : browser}`;
}

function formatReminderTime(unix) {
  return new Date(unix * 1000).toLocaleString("ja-JP", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" });
}

function defaultReminderDraft() {
  const next = new Date(Date.now() + 60 * 60 * 1000);
  const hour = next.toLocaleString("en-US", { hour: "2-digit", hourCycle: "h23", timeZone: "Asia/Tokyo" });
  return { message: "", date: next.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }), time: `${hour}:00` };
}

function NotificationPanel({ setMessage }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [currentEndpoint, setCurrentEndpoint] = useState(null);
  const [permission, setPermission] = useState(PUSH_SUPPORTED ? Notification.permission : "unsupported");
  const [busy, setBusy] = useState(false);
  const [reminderDraft, setReminderDraft] = useState(defaultReminderDraft);

  async function load() {
    const result = await api("/notifications");
    setData(result);
    setSettings(result.settings);
    if (PUSH_SUPPORTED) {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      setCurrentEndpoint(subscription?.endpoint || null);
    }
  }

  useEffect(() => {
    if (open) load().catch((error) => setMessage(error.message));
  }, [open]);

  const thisDevice = data?.subscriptions.find((subscription) => subscription.endpoint === currentEndpoint);

  async function enableOnThisDevice() {
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") {
        setMessage("通知が許可されませんでした。ブラウザの設定から DailyPilot の通知を許可してください。");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(data.publicKey) });
      const saved = await api("/push/subscriptions", { method: "POST", body: JSON.stringify({ ...subscription.toJSON(), label: deviceLabel() }) });
      setData({ ...data, subscriptions: saved.subscriptions });
      setCurrentEndpoint(subscription.endpoint);
      setMessage("この端末で通知を受け取れるようになりました");
    } catch (error) {
      setMessage(`通知の登録に失敗しました: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function removeDevice(device) {
    try {
      if (device.endpoint === currentEndpoint) {
        const registration = await navigator.serviceWorker.getRegistration();
        await (await registration?.pushManager.getSubscription())?.unsubscribe();
        setCurrentEndpoint(null);
      }
      const result = await api(`/push/subscriptions/${device.id}`, { method: "DELETE" });
      setData({ ...data, subscriptions: result.subscriptions });
      setMessage("端末の登録を解除しました");
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function sendTest() {
    setBusy(true);
    try {
      const result = await api("/push/test", { method: "POST" });
      setData({ ...data, subscriptions: result.subscriptions });
      setMessage(result.sent ? `${result.sent}台の端末にテスト通知を送りました` : `送信できませんでした${result.errors?.length ? `（${result.errors[0]}）` : ""}`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    try {
      const result = await api("/notifications/settings", { method: "PUT", body: JSON.stringify(settings) });
      setSettings(result.settings);
      setMessage("通知の設定を保存しました");
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function addReminder(event) {
    event.preventDefault();
    if (!reminderDraft.message.trim()) return;
    try {
      const result = await api("/reminders", { method: "POST", body: JSON.stringify(reminderDraft) });
      setData({ ...data, reminders: result.reminders });
      setReminderDraft(defaultReminderDraft());
      setMessage("リマインダーを追加しました");
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function removeReminder(reminder) {
    try {
      const result = await api(`/reminders/${reminder.id}`, { method: "DELETE" });
      setData({ ...data, reminders: result.reminders });
    } catch (error) {
      setMessage(error.message);
    }
  }

  const update = (patch) => setSettings({ ...settings, ...patch });

  return (
    <details className="card collapsibleCard" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cardHead">
        <h2>スマホ通知</h2>
        <span className="cardHint">予定の開始前・計測し忘れ・朝夜のリマインド</span>
      </summary>

      {!data ? (
        <p className="muted">読み込み中...</p>
      ) : !data.configured ? (
        <p className="inlineWarning">サーバーに VAPID 鍵が設定されていないため、通知はまだ使えません（README の「スマホ通知」を参照）。</p>
      ) : (
        <div className="notifyGrid">
          <section className="notifySection">
            <h3>この端末</h3>
            {!PUSH_SUPPORTED ? (
              <p className="inlineWarning">
                {IS_IOS && !IS_STANDALONE
                  ? "iPhone / iPad では、Safari の共有ボタンから「ホーム画面に追加」し、ホーム画面の DailyPilot を開いてから通知をオンにしてください。"
                  : "このブラウザはプッシュ通知に対応していません。"}
              </p>
            ) : thisDevice ? (
              <div className="deviceStatus on">
                <span>通知オン（{thisDevice.label || "この端末"}）</span>
                <button className="ghost small" disabled={busy} onClick={sendTest}>テスト通知</button>
              </div>
            ) : (
              <div className="deviceStatus">
                <span>{permission === "denied" ? "通知がブロックされています。ブラウザの設定で許可してください。" : "この端末ではまだ通知を受け取っていません。"}</span>
                <button className="primary small" disabled={busy || permission === "denied"} onClick={enableOnThisDevice}>この端末で通知を受け取る</button>
              </div>
            )}

            <h3 className="mcpSubhead">通知する端末</h3>
            <div className="tokenList">
              {data.subscriptions.length === 0 && <p className="empty">登録済みの端末はありません</p>}
              {data.subscriptions.map((device) => (
                <div className="tokenRow" key={device.id}>
                  <div className="logText">
                    <strong>{device.label || "名前のない端末"}{device.endpoint === currentEndpoint ? "（この端末）" : ""}</strong>
                    <span>最終送信 {formatUnixTime(device.lastSuccessAt)}</span>
                  </div>
                  <button className="ghost small" onClick={() => removeDevice(device)}>解除</button>
                </div>
              ))}
            </div>
            {data.subscriptions.length > 0 && !thisDevice && (
              <button className="linkButton small" disabled={busy} onClick={sendTest}>登録済みの端末にテスト通知を送る</button>
            )}
          </section>

          <section className="notifySection">
            <h3>通知する内容</h3>
            {settings && (
              <form className="notifySettings" onSubmit={saveSettings}>
                <label className="toggleRow">
                  <input type="checkbox" checked={settings.scheduleReminderEnabled} onChange={(event) => update({ scheduleReminderEnabled: event.target.checked })} />
                  <span>予定の
                    <input type="number" min="1" max="120" className="inlineNumber" value={settings.scheduleLeadMinutes} onChange={(event) => update({ scheduleLeadMinutes: Number(event.target.value) })} />
                    分前に知らせる</span>
                </label>
                <label className="toggleRow">
                  <input type="checkbox" checked={settings.timerNudgeEnabled} onChange={(event) => update({ timerNudgeEnabled: event.target.checked })} />
                  <span>予定が始まって5分たっても実績タイマーが動いていなければ知らせる</span>
                </label>
                <label className="toggleRow">
                  <input type="checkbox" checked={settings.morningEnabled} onChange={(event) => update({ morningEnabled: event.target.checked })} />
                  <span>
                    <input type="time" value={settings.morningTime} onChange={(event) => update({ morningTime: event.target.value })} />
                    にタスクが未登録なら、今日の計画を促す</span>
                </label>
                <label className="toggleRow">
                  <input type="checkbox" checked={settings.eveningEnabled} onChange={(event) => update({ eveningEnabled: event.target.checked })} />
                  <span>
                    <input type="time" value={settings.eveningTime} onChange={(event) => update({ eveningTime: event.target.value })} />
                    に振り返りが未保存なら知らせる</span>
                </label>
                <div className="actions">
                  <button className="primary small">設定を保存</button>
                </div>
              </form>
            )}

            <h3 className="mcpSubhead">リマインダー</h3>
            <p className="muted">Claude に「15時にES提出をリマインドして」と頼んでも登録できます。</p>
            <form className="inlineForm reminderForm" onSubmit={addReminder}>
              <input type="date" value={reminderDraft.date} onChange={(event) => setReminderDraft({ ...reminderDraft, date: event.target.value })} />
              <input type="time" value={reminderDraft.time} onChange={(event) => setReminderDraft({ ...reminderDraft, time: event.target.value })} />
              <input className="grow" placeholder="通知する内容" value={reminderDraft.message} onChange={(event) => setReminderDraft({ ...reminderDraft, message: event.target.value })} />
              <button className="primary">追加</button>
            </form>
            <div className="tokenList">
              {data.reminders.length === 0 && <p className="empty">予定されたリマインダーはありません</p>}
              {data.reminders.map((reminder) => (
                <div className="tokenRow" key={reminder.id}>
                  <div className="logText">
                    <strong>{reminder.message}</strong>
                    <span>{formatReminderTime(reminder.remindAt)}</span>
                  </div>
                  <button className="iconBtn danger" title="取り消し" onClick={() => removeReminder(reminder)}>×</button>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </details>
  );
}

// Claude Code などの MCP クライアントから DailyPilot を操作するための個人アクセストークンを管理します。
function McpPanel({ setMessage }) {
  const [open, setOpen] = useState(false);
  const [tokens, setTokens] = useState([]);
  const [name, setName] = useState("Claude Code");
  const [issuedToken, setIssuedToken] = useState("");
  const [connections, setConnections] = useState([]);

  const endpoint = `${window.location.origin}/api/mcp`;
  const command = `claude mcp add --transport http daily-pilot ${endpoint} --header "Authorization: Bearer ${issuedToken || "<トークン>"}"`;

  useEffect(() => {
    if (!open) return;
    api("/mcp-tokens")
      .then((data) => setTokens(data.tokens))
      .catch((error) => setMessage(error.message));
    api("/oauth/connections")
      .then((data) => setConnections(data.connections))
      .catch((error) => setMessage(error.message));
  }, [open, setMessage]);

  async function revokeConnection(connection) {
    if (!window.confirm(`「${connection.clientName || connection.redirectHost}」との連携を解除しますか？`)) return;
    try {
      const data = await api(`/oauth/connections/${encodeURIComponent(connection.clientId)}`, { method: "DELETE" });
      setConnections(data.connections);
      setMessage("連携を解除しました");
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function issueToken(event) {
    event.preventDefault();
    try {
      const data = await api("/mcp-tokens", { method: "POST", body: JSON.stringify({ name }) });
      setTokens(data.tokens);
      setIssuedToken(data.token);
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function revokeToken(token) {
    if (!window.confirm(`「${token.name}」のトークンを失効させますか？このトークンを使っているクライアントは接続できなくなります。`)) return;
    try {
      const data = await api(`/mcp-tokens/${token.id}`, { method: "DELETE" });
      setTokens(data.tokens);
      setMessage("トークンを失効させました");
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function copy(label, text) {
    await navigator.clipboard.writeText(text);
    setMessage(`${label}をコピーしました`);
  }

  return (
    <details className="card collapsibleCard" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cardHead">
        <h2>MCP連携（Claude）</h2>
        <span className="cardHint">AIエージェントからタスク・予定・振り返りを操作</span>
      </summary>

      <p className="muted">
        Claude などの MCP クライアントから、DailyPilot のタスク追加・達成状況の更新・振り返りの保存などができるようになります。
      </p>

      <div className="mcpGrid">
        <section className="mcpSection">
          <h3>claude.ai / Claude Desktop / スマホの Claude アプリ</h3>
          <ol className="mcpSteps">
            <li>claude.ai の「設定 → コネクタ → カスタムコネクタを追加」を開く</li>
            <li>次の URL を貼り付けて追加し、「連携/接続」を押す</li>
            <li>DailyPilot の画面で「許可する」を押す</li>
          </ol>
          <div className="copyRow">
            <code>{endpoint}</code>
            <button className="ghost small" onClick={() => copy("URL", endpoint)}>コピー</button>
          </div>

          <h3 className="mcpSubhead">接続中のアプリ</h3>
          <div className="tokenList">
            {connections.length === 0 && <p className="empty">接続中のアプリはありません</p>}
            {connections.map((connection) => (
              <div className="tokenRow" key={connection.clientId}>
                <div className="logText">
                  <strong>{connection.clientName || "名前のないアプリ"}</strong>
                  <span>{connection.redirectHost}・最終利用 {formatUnixTime(connection.lastUsedAt)}</span>
                </div>
                <button className="ghost small" onClick={() => revokeConnection(connection)}>解除</button>
              </div>
            ))}
          </div>
        </section>

        <section className="mcpSection">
          <h3>Claude Code（個人用トークン）</h3>
          <p className="muted">トークンはアカウントのパスワードと同じように扱ってください。</p>

          <form className="inlineForm" onSubmit={issueToken}>
            <input placeholder="用途（例: Claude Code）" value={name} onChange={(event) => setName(event.target.value)} />
            <button className="primary">トークンを発行</button>
          </form>

          {issuedToken && (
            <div className="issuedToken">
              <p>トークンは<strong>この画面でしか表示されません</strong>。いまコピーして保管してください。</p>
              <div className="copyRow">
                <code>{issuedToken}</code>
                <button className="ghost small" onClick={() => copy("トークン", issuedToken)}>コピー</button>
              </div>
            </div>
          )}

          <div className="mcpSetup">
            <h3 className="mcpSubhead">登録コマンド</h3>
            <div className="copyRow">
              <code>{command}</code>
              <button className="ghost small" onClick={() => copy("コマンド", command)}>コピー</button>
            </div>
          </div>

          <div className="tokenList">
            {tokens.length === 0 && <p className="empty">発行済みのトークンはありません</p>}
            {tokens.map((token) => (
              <div className="tokenRow" key={token.id}>
                <div className="logText">
                  <strong>{token.name}</strong>
                  <span>{token.tokenPrefix}…・最終利用 {formatUnixTime(token.lastUsedAt)}</span>
                </div>
                <button className="ghost small" onClick={() => revokeToken(token)}>失効</button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </details>
  );
}

// OAuth の同意画面。claude.ai などの MCP クライアントに DailyPilot へのアクセスを許可するかを確認します。
function ConsentScreen({ requestId, user }) {
  const [request, setRequest] = useState(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api(`/oauth/requests/${encodeURIComponent(requestId)}`)
      .then(setRequest)
      .catch((loadError) => setError(loadError.message));
  }, [requestId]);

  async function decide(decision) {
    setSubmitting(true);
    try {
      const data = await api(`/oauth/requests/${encodeURIComponent(requestId)}/${decision}`, { method: "POST" });
      window.location.href = data.redirectUrl;
    } catch (decideError) {
      setError(decideError.message);
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

        {error ? (
          <>
            <h1>連携を続けられませんでした</h1>
            <p className="formError">{error}</p>
            <a className="consentBack" href="/">DailyPilot を開く</a>
          </>
        ) : !request ? (
          <p className="authLead">連携リクエストを確認しています...</p>
        ) : (
          <>
            <h1>「{request.clientName}」に DailyPilot へのアクセスを許可しますか？</h1>
            <p className="authLead">
              許可すると、このアプリが MCP 経由であなたの DailyPilot を操作できるようになります。
              連携はあとから「MCP連携」パネルで解除できます。
            </p>
            <dl className="consentDetails">
              <dt>戻り先</dt>
              <dd>{request.redirectHost}</dd>
              <dt>アカウント</dt>
              <dd>{user.email}</dd>
              <dt>できること</dt>
              <dd>タスク・予定・実績ログ・振り返りの閲覧、追加、更新、削除</dd>
            </dl>
            <div className="consentActions">
              <button className="ghost" disabled={submitting} onClick={() => decide("deny")}>拒否</button>
              <button className="primary" disabled={submitting} onClick={() => decide("approve")}>
                {submitting ? "処理中..." : "許可する"}
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [date, setDate] = useState(TODAY);
  const [summary, setSummary] = useState(null);
  const [message, setMessage] = useState("");
  const [currentTime, setCurrentTime] = useState(() => new Date());
  // 非同期の保存や読み込みが終わった時点で「いま表示している日付」を参照するための値です。
  const dateRef = useRef(date);
  dateRef.current = date;

  // 初回表示時にセッションCookieからログイン状態を復元します。
  useEffect(() => {
    api("/me")
      .then((result) => setUser(result.user))
      .finally(() => setCheckingAuth(false));
  }, []);

  // 対象日を開くたびに日次サマリーを取得します。API側でGoogle自動同期も実行されます。
  useEffect(() => {
    if (user && !OAUTH_REQUEST_ID) loadSummary();
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

  // 読み込み中に別の日付へ切り替えた場合は、古い日付のレスポンスを捨てて表示を上書きしないようにします。
  async function loadSummary() {
    const requestedDate = dateRef.current;
    const data = await api(`/days/${requestedDate}`);
    if (requestedDate !== dateRef.current) return;
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
      // 保存した日と表示中の日が違う場合（保存中に日付を切り替えた場合など）は、表示中の日を読み込み直します。
      if (data?.day && data.day.date === dateRef.current) setSummary(data);
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
  if (!user) {
    return (
      <AuthScreen
        onAuthenticated={setUser}
        notice={OAUTH_REQUEST_ID ? "Claude などのアプリと連携するには、DailyPilot にログインしてください。" : ""}
      />
    );
  }
  if (OAUTH_REQUEST_ID) return <ConsentScreen requestId={OAUTH_REQUEST_ID} user={user} />;
  if (!summary) return <main className="loading">DailyPilotを準備中...</main>;

  const doneCount = summary.tasks.filter((task) => task.status === "done").length;
  const loggedMinutes = summary.actualLogs.reduce((sum, log) => sum + (log.durationMinutes || 0), 0);

  return (
    <div className="appShell">
      <header className="topbar">
        <div className="topbarInner">
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
          <TaskPanel date={date} tasks={summary.tasks} onMutate={mutate} />
          <SchedulePanel date={date} schedule={summary.schedule} overlaps={overlaps} googleSync={summary.googleSync} setMessage={setMessage} onMutate={mutate} />
          <TimerPanel date={date} actualLogs={summary.actualLogs} currentTime={currentTime} onMutate={mutate} />
        </div>

        <div className="dashboard dashboardBottom">
          <ReflectionPanel date={date} reflection={summary.reflection} setMessage={setMessage} onMutate={mutate} />
          <ExportPanel targetExportText={targetExportText} actualExportText={actualExportText} setMessage={setMessage} />
        </div>

        <NotificationPanel setMessage={setMessage} />
        <McpPanel setMessage={setMessage} />
      </main>

      {message && <div className="toast">{message}</div>}
    </div>
  );
}

// 通知を受け取るための Service Worker を登録します（オフラインキャッシュは行いません）。
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

createRoot(document.getElementById("root")).render(<App />);
