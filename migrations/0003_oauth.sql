-- claude.ai などの MCP クライアントが OAuth 2.1 で接続するためのテーブルです。
-- シークレット・認可コード・トークンはすべて SHA-256 ハッシュだけを保存します。

-- 動的クライアント登録（RFC 7591）で登録された OAuth クライアント
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  client_secret_hash TEXT,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 認可リクエスト。同意前は user_id / code_hash が NULL で、同意すると認可コードが発行されます。
CREATE TABLE IF NOT EXISTS oauth_authorizations (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state TEXT,
  scope TEXT,
  resource TEXT,
  user_id INTEGER,
  code_hash TEXT UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 発行済みのアクセストークン / リフレッシュトークン（1つの接続につき1行。リフレッシュ時にローテーション）
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  access_token_hash TEXT NOT NULL UNIQUE,
  access_expires_at INTEGER NOT NULL,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  refresh_expires_at INTEGER NOT NULL,
  scope TEXT,
  resource TEXT,
  last_used_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS oauth_tokens_user_idx ON oauth_tokens(user_id);
CREATE INDEX IF NOT EXISTS oauth_authorizations_expires_idx ON oauth_authorizations(expires_at);
