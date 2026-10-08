// テキスト出力の組み立て処理です。画面（src/main.jsx）と MCP サーバー（functions/mcp/server.js）で共通利用します。

// 優先度・達成状況など、画面とテキスト出力で共通利用する定数です。
export const PRIORITIES = ["S", "A", "B"];
export const STATUS_MARKS = { planned: "", done: "◯", partial: "△", missed: "☓" };
export const STATUS_LABELS = { planned: "未評価", done: "完了", partial: "一部", missed: "未達" };

// Workers（UTC）でもブラウザでも同じ結果になるよう、日付文字列をUTCとして解釈して月日を取り出します。
export function japaneseDate(value) {
  const parsed = new Date(`${value}T00:00:00Z`);
  return `${parsed.getUTCMonth() + 1}月${parsed.getUTCDate()}日`;
}

export function formatLogTime(value) {
  return new Date(value).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tokyo",
  });
}

export function buildTaskLines(tasks, { includeStatusMarks = true } = {}) {
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

export function buildTargetScheduleLines(schedule) {
  if (schedule.length === 0) return ["（目標スケジュール未登録）"];
  return schedule.map((block) => `${block.startTime} - ${block.endTime} ${block.title}`);
}

export function buildActualScheduleLines(actualLogs, now = new Date()) {
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

export function buildTargetExportText(summary) {
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

export function buildActualExportText(summary, now = new Date()) {
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
