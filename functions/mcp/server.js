import { PRIORITIES, buildActualExportText, buildTargetExportText } from "../../shared/exportText.js";

// ===== MCP（Model Context Protocol）サーバー =====
// Streamable HTTP トランスポートを「ステートレス・JSONレスポンスのみ」で実装しています。
// セッションIDやSSEストリームを持たないため、Pages Functions だけで動き、Durable Objects などは不要です。
// 各ツールの実処理は API 側（functions/api/[[path]].js）から ops として渡され、REST API と同じロジックを使います。

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "daily-pilot", title: "DailyPilot", version: "0.3.0" };
const SERVER_INSTRUCTIONS = [
  "DailyPilot は1日の目標タスク（S/A/B優先度）・予定・実績ログ・振り返りを管理するアプリです。",
  "日付は YYYY-MM-DD、時刻は HH:MM（日本時間）で指定します。date を省略すると日本時間の今日になります。",
  "まず get_day でその日の状態とIDを確認してから、タスクや予定を追加・更新してください。",
  "タスクの達成状況は done（◯）/ partial（△）/ missed（☓）/ planned（未評価）です。",
  "「〇時に教えて」のような依頼には create_reminder を使うと、ユーザーのスマホにプッシュ通知が届きます。",
].join("\n");

const JSON_RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
};

// ツールの入力値が不正なときに投げ、isError 付きの結果としてモデルに返します。
export class ToolInputError extends Error {}

const dateProperty = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "対象日（YYYY-MM-DD）。省略時は日本時間の今日" };
const timeProperty = (description) => ({ type: "string", pattern: "^\\d{2}:\\d{2}$", description });

// ツール定義。inputSchema は JSON Schema で、MCP クライアントにそのまま渡されます。
const TOOLS = [
  {
    name: "get_day",
    title: "1日の状態を取得",
    description: "指定日のタスク・予定・実績ログ・振り返り・達成率をまとめて取得します。更新系ツールで使うIDもここで確認できます。",
    inputSchema: { type: "object", properties: { date: dateProperty } },
    annotations: { readOnlyHint: true },
    run: async (ops, args) => ops.getDay(args.date),
  },
  {
    name: "list_days",
    title: "期間の一覧を取得",
    description: "期間内（最大31日）の各日について、タスクと達成状況・達成率・実績時間・振り返りを一覧で取得します。週次の振り返りなどに使います。",
    inputSchema: {
      type: "object",
      properties: {
        from: { ...dateProperty, description: "開始日（YYYY-MM-DD）" },
        to: { ...dateProperty, description: "終了日（YYYY-MM-DD、開始日を含めて31日以内）" },
      },
      required: ["from", "to"],
    },
    annotations: { readOnlyHint: true },
    run: async (ops, args) => ops.listDays(args.from, args.to),
  },
  {
    name: "get_export_text",
    title: "テキスト出力を取得",
    description: "アプリの「テキスト出力」と同じ形式で、指定日の「目標」と「実際」のテキストを生成します。",
    inputSchema: { type: "object", properties: { date: dateProperty } },
    annotations: { readOnlyHint: true },
    run: async (ops, args) => ops.getExportText(args.date),
  },
  {
    name: "add_task",
    title: "タスクを追加",
    description: "指定日に目標タスクを追加します。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "タスク名" },
        priority: { type: "string", enum: ["S", "A", "B"], description: "優先度。S が最重要。省略時は A" },
        date: dateProperty,
      },
      required: ["title"],
    },
    run: async (ops, args) => ops.addTask(args),
  },
  {
    name: "update_task",
    title: "タスクを更新",
    description: "タスクの名前・優先度・達成状況を更新します。指定した項目だけが変わります。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "integer", description: "get_day で確認したタスクID" },
        title: { type: "string" },
        priority: { type: "string", enum: ["S", "A", "B"] },
        status: { type: "string", enum: ["planned", "done", "partial", "missed"], description: "planned=未評価, done=◯, partial=△, missed=☓" },
      },
      required: ["task_id"],
    },
    annotations: { idempotentHint: true },
    run: async (ops, args) => ops.updateTask(args),
  },
  {
    name: "delete_task",
    title: "タスクを削除",
    description: "タスクを削除します。",
    inputSchema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] },
    annotations: { destructiveHint: true },
    run: async (ops, args) => ops.deleteTask(args.task_id),
  },
  {
    name: "add_schedule",
    title: "予定を追加",
    description: "指定日の目標スケジュールに予定ブロックを追加します（Googleカレンダーには追加しません）。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "予定名" },
        start_time: timeProperty("開始時刻（HH:MM）"),
        end_time: timeProperty("終了時刻（HH:MM）"),
        date: dateProperty,
      },
      required: ["title", "start_time", "end_time"],
    },
    run: async (ops, args) => ops.addSchedule(args),
  },
  {
    name: "delete_schedule",
    title: "予定を削除",
    description: "予定ブロックを削除します。",
    inputSchema: { type: "object", properties: { schedule_id: { type: "integer" } }, required: ["schedule_id"] },
    annotations: { destructiveHint: true },
    run: async (ops, args) => ops.deleteSchedule(args.schedule_id),
  },
  {
    name: "start_timer",
    title: "実績タイマーを開始",
    description: "「いま行っている作業」の計測を開始します。",
    inputSchema: { type: "object", properties: { title: { type: "string", description: "作業内容" }, date: dateProperty }, required: ["title"] },
    run: async (ops, args) => ops.startTimer(args),
  },
  {
    name: "stop_timer",
    title: "実績タイマーを停止",
    description: "計測中の実績タイマーを停止します。log_id を省略すると、計測中のうち最新のものを停止します。",
    inputSchema: { type: "object", properties: { log_id: { type: "integer" } } },
    run: async (ops, args) => ops.stopTimer(args.log_id),
  },
  {
    name: "add_actual_log",
    title: "実績を手入力",
    description: "タイマーを使わなかった作業を、実績ログとして後から追加します。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "作業内容" },
        start_time: timeProperty("開始時刻（HH:MM）"),
        end_time: timeProperty("終了時刻（HH:MM）"),
        date: dateProperty,
      },
      required: ["title", "start_time", "end_time"],
    },
    run: async (ops, args) => ops.addActualLog(args),
  },
  {
    name: "create_reminder",
    title: "リマインダーを作成",
    description: "指定した日時に、ユーザーのスマホ（DailyPilot で通知を許可した端末）へプッシュ通知を送るリマインダーを作成します。",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "通知に表示する内容（200文字以内）" },
        time: timeProperty("通知する時刻（HH:MM、日本時間）"),
        date: dateProperty,
      },
      required: ["message", "time"],
    },
    run: async (ops, args) => ops.createReminder(args),
  },
  {
    name: "list_reminders",
    title: "リマインダーの一覧",
    description: "まだ送信されていないリマインダーを日時順に取得します。",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    run: async (ops) => ops.listReminders(),
  },
  {
    name: "cancel_reminder",
    title: "リマインダーを取り消し",
    description: "未送信のリマインダーを取り消します。",
    inputSchema: { type: "object", properties: { reminder_id: { type: "integer" } }, required: ["reminder_id"] },
    annotations: { destructiveHint: true },
    run: async (ops, args) => ops.cancelReminder(args.reminder_id),
  },
  {
    name: "save_reflection",
    title: "振り返りを保存",
    description: "指定日の振り返りを保存します。指定しなかった項目は既存の内容を残します。",
    inputSchema: {
      type: "object",
      properties: {
        date: dateProperty,
        achievement_rate: { type: "integer", minimum: 0, maximum: 100, description: "タスク達成率（%）。省略時は既存値または自動計算値" },
        reason: { type: "string", description: "達成率の理由" },
        improvement: { type: "string", description: "改善点" },
        good_points: { type: "string", description: "良かった点" },
        tomorrow_notes: { type: "string", description: "明日へのメモ" },
      },
    },
    annotations: { idempotentHint: true },
    run: async (ops, args) => ops.saveReflection(args),
  },
];

// ===== ツール結果の整形 =====

function tokyoTime(value) {
  return new Date(value).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tokyo" });
}

// getDaySummary の結果から、モデルが読みやすい項目だけを取り出します。
export function compactDaySummary(summary) {
  return {
    date: summary.day.date,
    achievementRate: summary.reflection.achievementRate,
    tasks: [...summary.tasks]
      .sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority))
      .map((task) => ({ id: task.id, priority: task.priority, title: task.title, status: task.status })),
    schedule: summary.schedule.map((block) => ({ id: block.id, startTime: block.startTime, endTime: block.endTime, title: block.title, source: block.source })),
    actualLogs: summary.actualLogs.map((log) => ({
      id: log.id,
      title: log.title,
      startTime: tokyoTime(log.startedAt),
      endTime: log.endedAt ? tokyoTime(log.endedAt) : null,
      durationMinutes: log.durationMinutes,
      running: !log.endedAt,
    })),
    reflection: {
      reason: summary.reflection.reason,
      improvement: summary.reflection.improvement,
      goodPoints: summary.reflection.goodPoints,
      tomorrowNotes: summary.reflection.tomorrowNotes,
    },
    googleCalendarConnected: Boolean(summary.googleSync?.connected),
  };
}

export function exportTexts(summary) {
  return { target: buildTargetExportText(summary), actual: buildActualExportText(summary) };
}

// ===== JSON-RPC / HTTP 処理 =====

// Cookie を使わない Bearer 認証なので、ブラウザ型の MCP クライアント（MCP Inspector など）向けに CORS を許可します。
const CORS_HEADERS = { "access-control-allow-origin": "*", "access-control-expose-headers": "www-authenticate" };

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS, ...headers } });
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolResult(data) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

async function callTool(ops, params) {
  const tool = TOOLS.find((candidate) => candidate.name === params?.name);
  if (!tool) return { error: { code: JSON_RPC_ERRORS.invalidParams, message: `Unknown tool: ${params?.name}` } };
  try {
    return { result: toolResult(await tool.run(ops, params.arguments || {})) };
  } catch (error) {
    // 入力ミスやDBエラーは、モデルが読んで修正できるよう isError 付きのツール結果として返します。
    const message = error instanceof Error ? error.message : "ツールの実行に失敗しました";
    return { result: { content: [{ type: "text", text: message }], isError: true } };
  }
}

async function handleMessage(message, ops) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
      return rpcResult(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: SERVER_INSTRUCTIONS });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS.map(({ run, ...definition }) => definition) });
    case "tools/call": {
      const { result, error } = await callTool(ops, params);
      return error ? rpcError(id, error.code, error.message) : rpcResult(id, result);
    }
    default:
      return rpcError(id, JSON_RPC_ERRORS.methodNotFound, `Method not found: ${method}`);
  }
}

// /api/mcp へのリクエストを処理します。ops が null の場合は認証失敗として 401 を返し、
// WWW-Authenticate で OAuth の設定場所（Protected Resource Metadata）をクライアントに伝えます。
export async function handleMcpRequest(request, ops, { wwwAuthenticate }) {
  if (request.method !== "POST") {
    // サーバーからの通知ストリーム（GET）やセッション削除（DELETE）は提供しません。
    return new Response(null, { status: 405, headers: { allow: "POST", ...CORS_HEADERS } });
  }
  if (!ops) {
    return jsonResponse(rpcError(null, JSON_RPC_ERRORS.invalidRequest, "認証が必要です（OAuth、または Authorization: Bearer <DailyPilotのMCPトークン>）"), 401, { "www-authenticate": wwwAuthenticate });
  }

  let message;
  try {
    message = await request.json();
  } catch {
    return jsonResponse(rpcError(null, JSON_RPC_ERRORS.parse, "Parse error"), 400);
  }
  if (!message || Array.isArray(message) || message.jsonrpc !== "2.0") {
    return jsonResponse(rpcError(message?.id, JSON_RPC_ERRORS.invalidRequest, "Invalid JSON-RPC request"), 400);
  }

  // 通知（id なし）やクライアントからのレスポンスには本文なしの 202 を返します。
  if (message.id === undefined || !message.method) return new Response(null, { status: 202 });

  try {
    return jsonResponse(await handleMessage(message, ops));
  } catch (error) {
    return jsonResponse(rpcError(message.id, JSON_RPC_ERRORS.internal, error instanceof Error ? error.message : "Internal error"));
  }
}
