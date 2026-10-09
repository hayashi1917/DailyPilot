import { drizzle } from "drizzle-orm/d1";
import { and, eq, gt, isNull, lt, max, min } from "drizzle-orm";
import { oauthAuthorizations, oauthClients, oauthTokens, users } from "../db/schema.js";
import { randomId, sha256Base64Url, sha256Hex } from "../lib/crypto.js";

// ===== OAuth 2.1 認可サーバー（MCP 認可仕様に準拠） =====
// claude.ai / Claude Desktop のカスタムコネクタは、次の流れで DailyPilot に接続します。
//   1. /api/mcp が 401 と WWW-Authenticate（resource_metadata）を返す
//   2. /.well-known/oauth-protected-resource → /.well-known/oauth-authorization-server でエンドポイントを発見
//   3. /api/oauth/register で動的クライアント登録（RFC 7591）
//   4. /api/oauth/authorize → 画面で同意（未ログインならログイン）→ 認可コードを redirect_uri へ返す
//   5. /api/oauth/token で認可コード（PKCE S256 必須）をアクセストークン / リフレッシュトークンに交換
// 状態はすべて D1 に保存し、シークレット・コード・トークンは SHA-256 ハッシュだけを持ちます。

const SCOPE = "dailypilot";
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90;
// ログイン画面を経由する場合もあるため、同意までの猶予は30分にしています。
const AUTHORIZATION_REQUEST_TTL_SECONDS = 60 * 30;
const AUTHORIZATION_CODE_TTL_SECONDS = 60 * 10;
const ACCESS_TOKEN_PREFIX = "dpa_";
const REFRESH_TOKEN_PREFIX = "dpr_";
const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"];

function db(env) {
  return drizzle(env.DB);
}

function now() {
  return Math.floor(Date.now() / 1000);
}

// メタデータ・登録・トークンの各エンドポイントはブラウザ型クライアントからも呼べるよう CORS を許可します（Cookie は使いません）。
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS_HEADERS, ...headers },
  });
}

function oauthError(error, description, status = 400, headers = {}) {
  return json({ error, error_description: description }, status, headers);
}

export function corsPreflight() {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS, "access-control-max-age": "86400" } });
}

// redirect_uri が登録できないなど、クライアントに安全に戻せないエラーはこのページで表示します。
function errorPage(message, status = 400) {
  const escaped = message.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>DailyPilot 連携エラー</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif;max-width:480px;margin:64px auto;padding:0 16px;color:#171c26">
<h1 style="font-size:20px">連携を開始できませんでした</h1><p>${escaped}</p><p><a href="/">DailyPilot に戻る</a></p></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY" } });
}

export function mcpResourceUrl(origin) {
  return `${origin}/api/mcp`;
}

function protectedResourceMetadataUrl(origin) {
  return `${origin}/.well-known/oauth-protected-resource/api/mcp`;
}

// ===== メタデータ（RFC 9728 / RFC 8414） =====

export function protectedResourceMetadata(origin) {
  return json({
    resource: mcpResourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "DailyPilot",
  });
}

export function authorizationServerMetadata(origin) {
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/api/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: AUTH_METHODS,
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/`,
  });
}

// /api/mcp の 401 応答に付けるヘッダー。クライアントはここから OAuth の設定を発見します。
export function mcpWwwAuthenticate(origin, invalidToken = false) {
  const error = invalidToken ? ', error="invalid_token", error_description="The access token is invalid or expired"' : "";
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(origin)}", scope="${SCOPE}"${error}`;
}

// ===== 動的クライアント登録（RFC 7591） =====

function isAllowedRedirectUri(value) {
  try {
    const url = new URL(value);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    // ネイティブアプリやローカル開発用のループバックだけは http を許可します。
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

export async function registerClient(env, request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return oauthError("invalid_client_metadata", "JSON の登録情報が必要です");

  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10) {
    return oauthError("invalid_redirect_uri", "redirect_uris を1〜10件指定してください");
  }
  if (!redirectUris.every((uri) => typeof uri === "string" && uri.length <= 2000 && isAllowedRedirectUri(uri))) {
    return oauthError("invalid_redirect_uri", "redirect_uris は https（ループバックのみ http）の絶対URLで指定してください");
  }

  const authMethod = body.token_endpoint_auth_method || "client_secret_basic";
  if (!AUTH_METHODS.includes(authMethod)) return oauthError("invalid_client_metadata", `token_endpoint_auth_method は ${AUTH_METHODS.join(" / ")} のいずれかです`);
  const grantTypes = body.grant_types || ["authorization_code", "refresh_token"];
  if (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code")) return oauthError("invalid_client_metadata", "grant_types に authorization_code が必要です");

  const clientId = `dpc_${randomId(16)}`;
  const clientSecret = authMethod === "none" ? null : `dps_${randomId(32)}`;
  const clientName = typeof body.client_name === "string" ? body.client_name.trim().slice(0, 100) : null;

  await db(env).insert(oauthClients).values({
    id: clientId,
    clientSecretHash: clientSecret ? await sha256Hex(clientSecret) : null,
    clientName,
    redirectUris: JSON.stringify(redirectUris),
    tokenEndpointAuthMethod: authMethod,
  }).run();

  return json({
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: now(),
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: authMethod,
    scope: SCOPE,
  }, 201);
}

// ===== 認可エンドポイント =====

function redirectWithParams(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url.toString();
}

function isValidResource(resource, origin) {
  if (!resource) return true;
  try {
    const url = new URL(resource);
    return url.origin === origin && ["", "/", "/api/mcp", "/api/mcp/"].includes(url.pathname);
  } catch {
    return false;
  }
}

async function findClient(env, clientId) {
  if (!clientId) return null;
  const client = await db(env).select().from(oauthClients).where(eq(oauthClients.id, clientId)).get();
  return client ? { ...client, redirectUris: JSON.parse(client.redirectUris) } : null;
}

// 認可リクエストを検証して保存し、同意画面（SPA）へ移動します。
export async function startAuthorization(env, request, origin) {
  const params = new URL(request.url).searchParams;
  const client = await findClient(env, params.get("client_id"));
  if (!client) return errorPage("この連携アプリは登録されていません（client_id が不正です）。連携元のアプリで接続をやり直してください。");

  const requestedRedirect = params.get("redirect_uri");
  const redirectUri = requestedRedirect || (client.redirectUris.length === 1 ? client.redirectUris[0] : null);
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) return errorPage("redirect_uri が登録内容と一致しません。");

  // ここから先のエラーは、検証済みの redirect_uri へ error パラメーター付きで戻します。
  const state = params.get("state");
  const fail = (error, description) => Response.redirect(redirectWithParams(redirectUri, { error, error_description: description, state, iss: origin }), 302);
  if (params.get("response_type") !== "code") return fail("unsupported_response_type", "response_type=code のみ対応しています");
  if (!params.get("code_challenge") || params.get("code_challenge_method") !== "S256") return fail("invalid_request", "PKCE（code_challenge_method=S256）が必要です");
  const resource = params.get("resource");
  if (!isValidResource(resource, origin)) return fail("invalid_target", "resource が DailyPilot の MCP サーバーではありません");

  const appDb = db(env);
  await appDb.delete(oauthAuthorizations).where(lt(oauthAuthorizations.expiresAt, now())).run();
  const id = randomId(24);
  await appDb.insert(oauthAuthorizations).values({
    id,
    clientId: client.id,
    redirectUri,
    codeChallenge: params.get("code_challenge"),
    state,
    scope: SCOPE,
    resource: resource || mcpResourceUrl(origin),
    expiresAt: now() + AUTHORIZATION_REQUEST_TTL_SECONDS,
  }).run();

  return Response.redirect(`${origin}/?oauth_request=${id}`, 302);
}

async function pendingAuthorization(env, id) {
  if (!id) return null;
  return db(env).select().from(oauthAuthorizations).where(and(eq(oauthAuthorizations.id, id), isNull(oauthAuthorizations.userId), gt(oauthAuthorizations.expiresAt, now()))).get();
}

// 同意画面に表示する情報。表示名は自己申告なので、戻り先のホストも合わせて見せます。
export async function describeAuthorization(env, id) {
  const pending = await pendingAuthorization(env, id);
  if (!pending) return json({ error: "この連携リクエストは期限切れか、すでに処理されています。連携元のアプリでもう一度接続してください。" }, 404);
  const client = await findClient(env, pending.clientId);
  return json({ clientName: client?.clientName || "名前のないアプリ", redirectHost: new URL(pending.redirectUri).host });
}

// 同意 / 拒否。ログイン中ユーザーに認可コードを紐づけ、戻り先URLを返します（SPA がそこへ移動します）。
export async function decideAuthorization(env, origin, id, user, approved) {
  const pending = await pendingAuthorization(env, id);
  if (!pending) return json({ error: "この連携リクエストは期限切れか、すでに処理されています。" }, 404);
  const appDb = db(env);

  if (!approved) {
    await appDb.delete(oauthAuthorizations).where(eq(oauthAuthorizations.id, id)).run();
    return json({ redirectUrl: redirectWithParams(pending.redirectUri, { error: "access_denied", error_description: "ユーザーが連携を拒否しました", state: pending.state, iss: origin }) });
  }

  const code = randomId(32);
  const updated = await appDb.update(oauthAuthorizations)
    .set({ userId: user.id, codeHash: await sha256Hex(code), expiresAt: now() + AUTHORIZATION_CODE_TTL_SECONDS })
    .where(and(eq(oauthAuthorizations.id, id), isNull(oauthAuthorizations.userId)))
    .returning()
    .get();
  if (!updated) return json({ error: "この連携リクエストはすでに処理されています。" }, 409);
  return json({ redirectUrl: redirectWithParams(pending.redirectUri, { code, state: pending.state, iss: origin }) });
}

// ===== トークンエンドポイント =====

async function readTokenRequest(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return new Map(Object.entries((await request.json().catch(() => ({}))) || {}).map(([key, value]) => [key, String(value)]));
  return new Map(new URLSearchParams(await request.text()).entries());
}

// client_secret_basic（Authorization ヘッダー）と client_secret_post / none（本文）の両方に対応します。
async function authenticateClient(env, request, params) {
  let clientId = params.get("client_id");
  let clientSecret = params.get("client_secret");
  const basic = (request.headers.get("authorization") || "").match(/^Basic\s+(.+)$/i);
  if (basic) {
    try {
      const [id, secret] = atob(basic[1]).split(":");
      clientId = decodeURIComponent(id);
      clientSecret = decodeURIComponent(secret || "");
    } catch {
      return null;
    }
  }
  const client = await findClient(env, clientId);
  if (!client) return null;
  if (client.clientSecretHash && (!clientSecret || (await sha256Hex(clientSecret)) !== client.clientSecretHash)) return null;
  return client;
}

// rotate を渡すとリフレッシュ時のローテーションとして、古いリフレッシュトークンのハッシュが一致する場合だけ上書きします。
async function issueTokens(env, { userId, clientId, scope, resource, rotate = null }) {
  const accessToken = `${ACCESS_TOKEN_PREFIX}${randomId(32)}`;
  const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomId(32)}`;
  const values = {
    accessTokenHash: await sha256Hex(accessToken),
    accessExpiresAt: now() + ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenHash: await sha256Hex(refreshToken),
    refreshExpiresAt: now() + REFRESH_TOKEN_TTL_SECONDS,
  };
  const appDb = db(env);
  if (rotate) {
    // 同じリフレッシュトークンで同時にリクエストされても、成功するのは最初の1件だけにします（compare-and-swap）。
    const rotated = await appDb.update(oauthTokens).set(values)
      .where(and(eq(oauthTokens.id, rotate.tokenId), eq(oauthTokens.refreshTokenHash, rotate.previousRefreshTokenHash)))
      .returning({ id: oauthTokens.id })
      .get();
    if (!rotated) return oauthError("invalid_grant", "リフレッシュトークンが無効か期限切れです");
  } else {
    await appDb.insert(oauthTokens).values({ userId, clientId, scope, resource, ...values }).run();
  }
  return json({ access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refreshToken, scope }, 200, { pragma: "no-cache" });
}

export async function exchangeToken(env, request) {
  const params = await readTokenRequest(request);
  const client = await authenticateClient(env, request, params);
  if (!client) return oauthError("invalid_client", "クライアント認証に失敗しました", 401, { "www-authenticate": 'Basic realm="DailyPilot"' });
  const appDb = db(env);
  const grantType = params.get("grant_type");

  if (grantType === "authorization_code") {
    const code = params.get("code");
    const verifier = params.get("code_verifier");
    if (!code || !verifier) return oauthError("invalid_request", "code と code_verifier が必要です");
    // 認可コードは一度しか使えないよう、検証前に「削除して取り出す」を1回の操作で行います。
    // 同じコードで同時にリクエストされても、行を取り出せるのは1件だけです。
    const authorization = await appDb.delete(oauthAuthorizations).where(eq(oauthAuthorizations.codeHash, await sha256Hex(code))).returning().get();
    if (!authorization || authorization.clientId !== client.id || !authorization.userId || authorization.expiresAt < now()) {
      return oauthError("invalid_grant", "認可コードが無効か期限切れです");
    }
    const redirectUri = params.get("redirect_uri");
    if (redirectUri && redirectUri !== authorization.redirectUri) return oauthError("invalid_grant", "redirect_uri が認可リクエストと一致しません");
    if ((await sha256Base64Url(verifier)) !== authorization.codeChallenge) return oauthError("invalid_grant", "code_verifier が一致しません（PKCE）");
    return issueTokens(env, { userId: authorization.userId, clientId: client.id, scope: authorization.scope, resource: authorization.resource });
  }

  if (grantType === "refresh_token") {
    const refreshToken = params.get("refresh_token");
    if (!refreshToken) return oauthError("invalid_request", "refresh_token が必要です");
    const previousRefreshTokenHash = await sha256Hex(refreshToken);
    const token = await appDb.select().from(oauthTokens).where(and(eq(oauthTokens.refreshTokenHash, previousRefreshTokenHash), eq(oauthTokens.clientId, client.id), gt(oauthTokens.refreshExpiresAt, now()))).get();
    if (!token) return oauthError("invalid_grant", "リフレッシュトークンが無効か期限切れです");
    // リフレッシュトークンはローテーションし、古いものは使えなくします。
    return issueTokens(env, { userId: token.userId, clientId: client.id, scope: token.scope, resource: token.resource, rotate: { tokenId: token.id, previousRefreshTokenHash } });
  }

  return oauthError("unsupported_grant_type", "authorization_code と refresh_token のみ対応しています");
}

// ===== アクセストークンの検証と接続管理 =====

export function isOAuthAccessToken(token) {
  return token.startsWith(ACCESS_TOKEN_PREFIX);
}

export async function userFromOAuthAccessToken(env, accessToken) {
  const appDb = db(env);
  const token = await appDb.select().from(oauthTokens).where(and(eq(oauthTokens.accessTokenHash, await sha256Hex(accessToken)), gt(oauthTokens.accessExpiresAt, now()))).get();
  if (!token) return null;
  // 最終利用時刻は5分に1回だけ更新し、D1 の書き込み回数を抑えます。
  if (!token.lastUsedAt || now() - token.lastUsedAt > 300) {
    await appDb.update(oauthTokens).set({ lastUsedAt: now() }).where(eq(oauthTokens.id, token.id)).run();
  }
  return appDb.select({ id: users.id, email: users.email, name: users.name }).from(users).where(eq(users.id, token.userId)).get();
}

// 画面の「接続中のアプリ」一覧。クライアントごとにまとめて返します。
export async function listConnections(env, userId) {
  return db(env)
    .select({ clientId: oauthTokens.clientId, clientName: oauthClients.clientName, redirectUris: oauthClients.redirectUris, connectedAt: min(oauthTokens.createdAt), lastUsedAt: max(oauthTokens.lastUsedAt) })
    .from(oauthTokens)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthTokens.clientId))
    .where(eq(oauthTokens.userId, userId))
    .groupBy(oauthTokens.clientId)
    .all()
    .then((rows) => rows.map(({ redirectUris, ...row }) => ({ ...row, redirectHost: new URL(JSON.parse(redirectUris)[0]).host })));
}

export async function revokeConnection(env, userId, clientId) {
  await db(env).delete(oauthTokens).where(and(eq(oauthTokens.userId, userId), eq(oauthTokens.clientId, clientId))).run();
}
