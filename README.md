# DailyPilot

DailyPilot は、1日の目標タスク、予定、実績ログ、振り返りをまとめて管理し、最後に日本語のテキスト形式で出力するための Cloudflare Pages + D1 アプリケーションです。

## 主な機能

- `S / A / B` の優先度別タスク管理
- `◯ / △ / ☓` によるタスク達成状況の記録
- 1日の予定を時刻順に確認できるタイムライン表示
- 予定時間の重複警告
- 「いま行っている作業」を記録する開始/停止タイマー
- タスク達成率、理由、改善点、良かった点、明日へのメモを記録する振り返りフォーム
- 入力した内容を、「理想の1日のスケジュール」と「実際に過ごした1日のスケジュール」に分けてテキスト出力
- Googleカレンダー連携
  - Google OAuth による接続
  - 選択日の Googleカレンダー予定の自動同期
  - Googleカレンダー予定の DailyPilot スケジュールへの取り込み
  - DailyPilot の予定ブロックの Googleカレンダー追加
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
- `functions/db/schema.js`: Drizzle ORM の schema 定義。各テーブルの役割を日本語コメントで説明しています。
- `migrations/0001_initial.sql`: D1 に適用する初期テーブル定義です。

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

`TOKEN_ENCRYPTION_KEY` は未設定でも動作しますが、独自ドメイン変更後も既存トークンを復号し続けたい本番運用では、十分に長く推測されにくい値を設定して固定してください。

ローカル開発で同期間隔だけ変えたい場合は、`wrangler.toml` に次のように設定できます。

```toml
[vars]
CALENDAR_AUTO_SYNC_MINUTES = "15"
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

ここに登録する値は、DailyPilot が自動生成する `https://<your-domain>/api/google/callback` と完全に一致している必要があります。独自ドメインやローカルURLを使う場合は、それぞれのコールバックURLも Google Cloud Console に追加してください。

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
