# DailyPilot

DailyPilot は、1日の目標タスク、予定、実績ログ、振り返りをまとめて管理し、最後に日本語のテキスト形式で出力するための Cloudflare Pages + D1 アプリケーションです。

## 主な機能

- `S / A / B` の優先度別タスク管理
- `◯ / △ / ☓` によるタスク達成状況の記録
- 1日の予定を時刻順に確認できるタイムライン表示
- 予定時間の重複警告
- 「いま行っている作業」を記録する開始/停止タイマー
- タスク達成率、理由、改善点、良かった点、明日へのメモを記録する振り返りフォーム
- 当日のタスク・予定・実績をもとに振り返りドラフトを自動生成する生成AI機能（Cloudflare Workers AI）
- 入力した内容を、「理想の1日のスケジュール」と「実際に過ごした1日のスケジュール」に分けてテキスト出力
- Googleカレンダー連携
  - Google OAuth による接続
  - 選択日の Googleカレンダー予定の自動同期
  - Googleカレンダー予定の DailyPilot スケジュールへの取り込み
  - DailyPilot の予定ブロックの Googleカレンダー追加
- MCP サーバー（Claude Code などの AI エージェントからタスク・予定・実績・振り返りを操作）
- 複数ユーザー運用を想定したメールアドレス/パスワード認証
- ユーザー単位のデータ分離
- Google OAuth トークンの暗号化保存

## 技術構成

保守性を高めるため、フロントエンドは React、D1 アクセスは Drizzle ORM を使う構成にしています。

- フロントエンド: React / Vite
- API: Cloudflare Pages Functions
- ORM: Drizzle ORM
- データベース: Cloudflare D1
- 認証: メールアドレス + パスワード、HttpOnly セッションCookie
- パスワード保存: PBKDF2 + ソルト付きハッシュ（Cloudflare Web Crypto の上限に合わせて 100,000 回反復）
- Googleトークン保存: AES-GCM による暗号化
- デプロイ先: Cloudflare Pages
- 外部連携: Google Calendar API

## コード構成

処理内容を追いやすくするため、画面・API・DB定義を次のように分けています。主要な処理には日本語コメントを入れています。

- `src/main.jsx`: React の画面コンポーネント。認証画面、タスク管理、Googleカレンダー、予定、タイマー、振り返り、テキスト出力をコンポーネント単位で分割しています。
- `src/styles.css`: 画面全体のスタイル。カードUI、タイムライン、認証画面、レスポンシブ対応をまとめています。
- `functions/api/[[path]].js`: Cloudflare Pages Functions のAPI。認証、日次サマリー、タスク、予定、タイマー、振り返り、Google OAuth/同期を機能ごとのコメントで整理しています。
- `functions/mcp/server.js`: MCP サーバー（Streamable HTTP・ステートレス）のプロトコル処理とツール定義です。ツールの実処理は API 側と共通の関数を使います。
- `functions/db/schema.js`: Drizzle ORM の schema 定義。各テーブルの役割を日本語コメントで説明しています。
- `shared/exportText.js`: テキスト出力の組み立て処理。画面と MCP サーバーで共通利用します。
- `migrations/`: D1 に適用するテーブル定義です（`0001_initial.sql` 初期テーブル、`0002_api_tokens.sql` MCP用トークン）。

## Cloudflare セットアップ手順

### 1. Cloudflare にログインする

```bash
wrangler login
```

ブラウザが開くので、DailyPilot をデプロイしたい Cloudflare アカウントで認証します。

### 2. D1 データベースを作成する

```bash
wrangler d1 create daily-pilot
```

コマンド実行後に表示される `database_id` を `wrangler.toml` に設定します。

```toml
[[d1_databases]]
binding = "DB"
database_name = "daily-pilot"
database_id = "ここに作成された database_id を入れる"
```

`binding = "DB"` は Pages Functions から D1 に接続するための名前です。アプリ側でも `DB` という名前で参照しているため、基本的には変更しないでください。

### 3. D1 マイグレーションを適用する

本番用 D1 にテーブルを作成する場合:

```bash
wrangler d1 migrations apply daily-pilot --remote
```

ローカル開発用 D1 にテーブルを作成する場合:

```bash
wrangler d1 migrations apply daily-pilot --local
```

作成される主なテーブルは次の通りです。

- `users`: ユーザーアカウント
- `sessions`: ログインセッション
- `days`: 日付単位の管理レコード
- `tasks`: S/A/B 優先度付きタスク
- `schedule_blocks`: 予定ブロック
- `actual_logs`: タイマーで記録した実績ログ
- `reflections`: 日次振り返り
- `calendar_accounts`: 暗号化された Google OAuth トークン
- `oauth_states`: Google OAuth の CSRF 対策用 state
- `calendar_syncs`: Googleカレンダー自動同期の最終同期時刻
- `api_tokens`: MCP クライアント用の個人アクセストークン（SHA-256 ハッシュのみ保存）

### 4. Cloudflare Pages プロジェクトを作成・デプロイする

初回デプロイ前にフロントエンドをビルドします。

```bash
npm run build
```

その後、Cloudflare Pages にデプロイします。

```bash
wrangler pages deploy dist --project-name daily-pilot
```

デプロイ後、Cloudflare Pages の URL が発行されます。例:

```text
https://daily-pilot.pages.dev
```

独自ドメインを使う場合は、Cloudflare Pages の管理画面からカスタムドメインを追加してください。

### 5. Cloudflare Pages の環境変数・シークレットを設定する

Googleカレンダー連携に必要な必須シークレットは、Google Cloud Console で作成した OAuth クライアントの2つだけです。認証後の戻り先URLとアプリ本体URLはリクエストURLから自動判定します。

```bash
wrangler pages secret put GOOGLE_CLIENT_ID
wrangler pages secret put GOOGLE_CLIENT_SECRET
```

必要に応じて、次の任意設定も利用できます。

| 名前 | 必須 | 内容 | 例 |
| --- | --- | --- | --- |
| `GOOGLE_CLIENT_ID` | 必須 | Google Cloud Console で作成した OAuth クライアントID | `xxxx.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | 必須 | Google Cloud Console で作成した OAuth クライアントシークレット | `GOCSPX-...` |
| `TOKEN_ENCRYPTION_KEY` | 任意 | Google OAuth トークン暗号化に使う長い秘密文字列。未設定時はデプロイ先オリジンから導出します | `openssl rand -base64 32` で生成した値など |
| `GOOGLE_REDIRECT_URI` | 任意 | Google OAuth 認証後に戻るURL。未設定時は `https://<your-domain>/api/google/callback` を自動利用します | `https://daily-pilot.pages.dev/api/google/callback` |
| `APP_BASE_URL` | 任意 | DailyPilot アプリ本体のURL。未設定時はアクセス元オリジンを自動利用します | `https://daily-pilot.pages.dev` |
| `CALENDAR_AUTO_SYNC_MINUTES` | 任意 | Googleカレンダー自動同期の最短間隔 | `15` |

`TOKEN_ENCRYPTION_KEY` は未設定でも動作しますが、独自ドメイン変更後も既存トークンを復号し続けたい本番運用では、十分に長く推測されにくい値を設定して固定してください。既存の `GOOGLE_REDIRECT_URI` / `APP_BASE_URL` が現在アクセスしているドメインと異なる場合は、`redirect_uri_mismatch` を避けるため現在のドメインから自動生成したURLを優先します。

ローカル開発で同期間隔だけ変えたい場合は、`wrangler.toml` に次のように設定できます。

```toml
[vars]
CALENDAR_AUTO_SYNC_MINUTES = "15"
```

## 生成AI（AI振り返りドラフト生成）について

振り返りカードの「✦ AIでドラフト生成」ボタンを押すと、当日のタスク・予定・実績ログをもとに、理由・改善点・良かった点・明日へのメモのドラフトを Cloudflare Workers AI が生成します。生成結果はフォームに反映されるだけなので、内容を確認・編集してから「振り返りを保存」を押してください。

- 使用モデル: 既定は `@cf/meta/llama-3.3-70b-instruct-fp8-fast`（環境変数 `AI_MODEL` で変更可能）
- 必要な設定: `wrangler.toml` の `[ai] binding = "AI"`（本リポジトリでは設定済み）。OpenAI等の外部APIキーは不要です
- 課金: Workers AI の無料枠（Neurons）内で利用できます。超過分は Cloudflare の従量課金です
- ローカル開発: `wrangler pages dev` 実行時は Cloudflare アカウント経由でリモート推論するため、`wrangler login` 済みである必要があります

## MCP連携（Claude Code など）

DailyPilot は `/api/mcp` で MCP（Model Context Protocol）サーバーを提供します。Claude Code などの MCP クライアントから、会話の中でタスクの追加や達成状況の更新、振り返りの保存などができます。

### 使い方

1. DailyPilot にログインし、画面下部の「MCP連携」を開いて「トークンを発行」を押します。トークンはこのときしか表示されないので、すぐにコピーしてください。
2. 画面に表示される登録コマンドを Claude Code で実行します。

```bash
claude mcp add --transport http daily-pilot https://<your-domain>/api/mcp --header "Authorization: Bearer <トークン>"
```

3. Claude Code で「今日のタスクを見せて」「Sで『ES提出』を追加して」「ES提出を完了にして」「今週の振り返りをまとめて」のように頼むと、MCP ツール経由で DailyPilot を操作します。

不要になったトークンは「MCP連携」の一覧から失効できます。

### 提供ツール

| ツール | 内容 |
| --- | --- |
| `get_day` | 指定日（省略時は今日）のタスク・予定・実績・振り返り・達成率を取得 |
| `list_days` | 期間（最大31日）の各日の達成状況・実績時間・振り返りを一覧取得 |
| `get_export_text` | 「テキスト出力」と同じ形式の目標/実際テキストを生成 |
| `add_task` / `update_task` / `delete_task` | タスクの追加・更新（名前・優先度・◯△☓）・削除 |
| `add_schedule` / `delete_schedule` | 予定ブロックの追加・削除 |
| `start_timer` / `stop_timer` | 実績タイマーの開始・停止 |
| `add_actual_log` | 実績ログの手入力 |
| `save_reflection` | 振り返りの保存（指定した項目だけ更新） |

### 仕組みと料金

- Streamable HTTP トランスポートを、セッションを持たないステートレス構成（JSON レスポンスのみ）で実装しています。Pages Functions だけで動作し、Durable Objects や追加サービスは不要です。
- 認証は個人アクセストークン（`Authorization: Bearer`）です。DB にはトークンの SHA-256 ハッシュのみを保存します。
- MCP サーバー自体は LLM を呼び出さないため、Workers / D1 の無料枠内で利用できます（推論は MCP クライアント側で行われます）。
- claude.ai / Claude Desktop のカスタムコネクタは OAuth 認証が必要なため、現時点では未対応です。

### 本番環境への反映

MCP 用のテーブルを追加しているため、デプロイ前に本番 D1 へマイグレーションを適用してください。

```bash
npm run db:migrate:prod
```

## Google OAuth / Googleカレンダー設定手順

### 1. Google Cloud Console でプロジェクトを作成する

Google Cloud Console にアクセスし、DailyPilot 用のプロジェクトを作成します。既存のプロジェクトを使っても構いません。

### 2. Google Calendar API を有効化する

Google Cloud Console の「API とサービス」から Google Calendar API を検索し、有効化してください。

### 3. OAuth 同意画面を設定する

「API とサービス」→「OAuth 同意画面」から、アプリ名、サポートメール、デベロッパー連絡先などを設定します。

個人利用・テスト運用の場合は、公開ステータスを本番公開にする前に、テストユーザーとして自分の Google アカウントを追加してください。テストユーザーに入っていないアカウントでは、OAuth 認証が失敗する場合があります。

### 4. OAuth クライアントIDを作成する

「API とサービス」→「認証情報」→「認証情報を作成」→「OAuth クライアント ID」を選択します。

アプリケーションの種類は「ウェブ アプリケーション」を選択してください。

### 5. 承認済みのリダイレクト URI を登録する

本番環境では、Cloudflare Pages のURLに合わせて次の形式のリダイレクト URI を登録します。

```text
https://<your-domain>/api/google/callback
```

例:

```text
https://daily-pilot.pages.dev/api/google/callback
```

ローカルで Google OAuth を試す場合は、次のURIも追加してください。

```text
http://localhost:8788/api/google/callback
```

ここに登録する値は、DailyPilot が自動生成する `https://<your-domain>/api/google/callback` と完全に一致している必要があります。アプリ画面の Googleカレンダーカードにも、現在アクセスしているドメインから生成した登録用 URI を表示しています。独自ドメイン、Cloudflare Pages のプレビューURL、ローカルURLなど複数のURLで使う場合は、それぞれのコールバックURLを Google Cloud Console に追加してください。

### 6. 必要なスコープ

DailyPilot が使用する Google OAuth スコープは次の2つです。

```text
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/calendar.events
```

| スコープ | 用途 |
| --- | --- |
| `calendar.readonly` | 選択日の既存予定を読み取り、DailyPilot の予定一覧へ取り込むため |
| `calendar.events` | DailyPilot で作成した予定ブロックを Googleカレンダーに追加するため |

## Googleカレンダー自動同期について

Googleカレンダー連携後、DailyPilot は対象日の画面を開いたタイミングで Googleカレンダーを自動同期します。

無料枠で過剰な外部API呼び出しが発生しないよう、`CALENDAR_AUTO_SYNC_MINUTES` で指定した分数以内に同じ日の同期が完了している場合は、D1 に保存済みの予定を表示します。初期値は `15` 分です。

「今すぐ同期」ボタンを押すと、選択日の同期を手動で要求できます。

## ローカル開発手順

### 1. 依存関係をインストールする

```bash
npm install
```

### 2. ローカルD1にマイグレーションを適用する

```bash
npm run db:migrate:local
```

### 3. 開発サーバーを起動する

```bash
npm run dev
```

通常は次のURLで確認できます。

```text
http://localhost:5173
```

Pages Functions と D1 を含めて Cloudflare に近い形で確認したい場合は、ビルド後に `wrangler pages dev dist --d1 DB=daily-pilot` を使ってください。

### 4. 構文チェックを実行する

```bash
npm run check
```

このコマンドは Pages Functions と Drizzle schema の JavaScript 構文エラーを確認します。

## 運用時の注意点

- Google OAuth のリダイレクトURIは自動判定されます。Google Cloud Console には `https://<your-domain>/api/google/callback` を登録してください。
- D1 の `database_id` を `replace-with-your-d1-database-id` のままにすると、本番デプロイ後にDBへ接続できません。
- 複数ユーザー運用を前提に、ユーザーごとに `user_id` でデータを分離しています。
- Google OAuth トークンは AES-GCM 暗号化して保存します。`TOKEN_ENCRYPTION_KEY` を設定した場合、この値を失うと既存トークンを復号できなくなるため、安全に保管してください。
- パスワードは平文保存せず、PBKDF2 とランダムソルトでハッシュ化して保存します。Cloudflare Workers / Pages Functions の Web Crypto では PBKDF2 の反復回数が 100,000 回までに制限されるため、実装では 100,000 回を使用しています。
- 本格的な公開サービスとして運用する場合は、メール確認、パスワードリセット、監査ログ、レート制限、利用規約/プライバシーポリシーも追加してください。
