# DailyPilot

DailyPilot は、1日の目標タスク、予定、実績ログ、振り返りをまとめて管理し、最後に日本語のテキスト形式で出力するための Cloudflare Pages + D1 アプリケーションです。

## 主な機能

- `S / A / B` の優先度別タスク管理
- `◯ / △ / ☓` によるタスク達成状況の記録
- 1日の予定を時刻順に確認できるタイムライン表示
- 予定時間の重複警告
- 「いま行っている作業」を記録する開始/停止タイマー
- タスク達成率、理由、改善点、良かった点、明日へのメモを記録する振り返りフォーム
- 入力した内容を、これまで使っていた日次テキスト形式へワンクリックで出力
- Googleカレンダー連携のみ対応
  - Google OAuth による接続
  - 選択日の Googleカレンダー予定取得
  - Googleカレンダー予定の DailyPilot スケジュールへの取り込み
  - DailyPilot の予定ブロックの Googleカレンダー追加

## 技術構成

このアプリは Cloudflare の無料枠で個人利用しやすいよう、依存パッケージをできるだけ増やさない構成にしています。

- フロントエンド: Vanilla JavaScript / HTML / CSS
- API: Cloudflare Pages Functions
- データベース: Cloudflare D1
- デプロイ先: Cloudflare Pages
- 外部連携: Google Calendar API

## Cloudflare セットアップ手順

### 1. Cloudflare にログインする

`wrangler` を使う場合は、先に Cloudflare アカウントへログインしてください。

```bash
wrangler login
```

ブラウザが開くので、DailyPilot をデプロイしたい Cloudflare アカウントで認証します。

### 2. D1 データベースを作成する

DailyPilot 用の D1 データベースを作成します。

```bash
wrangler d1 create daily-pilot
```

コマンド実行後、Cloudflare から `database_id` が表示されます。表示された値を `wrangler.toml` の次の箇所に設定してください。

```toml
[[d1_databases]]
binding = "DB"
database_name = "daily-pilot"
database_id = "ここに作成された database_id を入れる"
```

`binding = "DB"` はアプリ側の API が D1 にアクセスするための名前です。変更すると API 側も修正が必要になるため、通常はそのままにしてください。

### 3. D1 マイグレーションを適用する

本番用の D1 にテーブルを作成する場合は、次のコマンドを実行します。

```bash
wrangler d1 migrations apply daily-pilot --remote
```

ローカル開発用の D1 にだけテーブルを作成したい場合は、次のコマンドを使います。

```bash
wrangler d1 migrations apply daily-pilot --local
```

作成される主なテーブルは次の通りです。

- `days`: 日付単位の管理レコード
- `tasks`: S/A/B 優先度付きタスク
- `schedule_blocks`: 予定ブロック
- `actual_logs`: タイマーで記録した実績ログ
- `reflections`: 日次振り返り
- `calendar_accounts`: Googleカレンダー連携用トークン情報

### 4. Cloudflare Pages プロジェクトを作成・デプロイする

初回デプロイは次のコマンドで実行できます。

```bash
wrangler pages deploy public --project-name daily-pilot
```

デプロイ後、Cloudflare Pages の URL が発行されます。例:

```text
https://daily-pilot.pages.dev
```

独自ドメインを使う場合は、Cloudflare Pages の管理画面からカスタムドメインを追加してください。

### 5. Cloudflare Pages の環境変数・シークレットを設定する

Googleカレンダー連携を使うには、Cloudflare Pages 側に Google OAuth の情報を設定する必要があります。

```bash
wrangler pages secret put GOOGLE_CLIENT_ID
wrangler pages secret put GOOGLE_CLIENT_SECRET
wrangler pages secret put GOOGLE_REDIRECT_URI
wrangler pages secret put APP_BASE_URL
```

それぞれの意味は次の通りです。

| 名前 | 内容 | 例 |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Google Cloud Console で作成した OAuth クライアントID | `xxxx.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console で作成した OAuth クライアントシークレット | `GOCSPX-...` |
| `GOOGLE_REDIRECT_URI` | Google OAuth 認証後に戻るURL | `https://daily-pilot.pages.dev/api/google/callback` |
| `APP_BASE_URL` | DailyPilot アプリ本体のURL | `https://daily-pilot.pages.dev` |

ローカル開発では、`wrangler.toml` に次の初期値を入れています。

```toml
[vars]
GOOGLE_REDIRECT_URI = "http://localhost:8788/api/google/callback"
APP_BASE_URL = "http://localhost:8788"
```

本番環境では、Cloudflare Pages のデプロイ先URLに合わせて設定してください。

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

ここに登録した値と、Cloudflare Pages の `GOOGLE_REDIRECT_URI` は完全に一致している必要があります。末尾のスラッシュ有無や `http` / `https` の違いでもエラーになります。

### 6. 必要なスコープ

DailyPilot が使用する Google OAuth スコープは次の2つです。

```text
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/calendar.events
```

それぞれの用途は次の通りです。

| スコープ | 用途 |
| --- | --- |
| `calendar.readonly` | 選択日の既存予定を読み取り、DailyPilot の予定一覧へ取り込むため |
| `calendar.events` | DailyPilot で作成した予定ブロックを Googleカレンダーに追加するため |

読み取りだけにしたい場合は `calendar.events` を外す設計も可能ですが、現在の実装では「Googleへ追加」機能を使うために `calendar.events` も要求しています。

## ローカル開発手順

### 1. 依存関係について

現在の実装は Vanilla JavaScript と Cloudflare Pages Functions を使っており、アプリ実行に必要な外部 npm パッケージはありません。

ただし、ローカル開発・デプロイには `wrangler` が必要です。グローバルにインストールしていない場合は、環境に合わせて導入してください。

```bash
npm install -g wrangler
```

### 2. ローカルD1にマイグレーションを適用する

```bash
npm run db:migrate:local
```

このコマンドは内部で次を実行します。

```bash
wrangler d1 migrations apply daily-pilot --local
```

### 3. 開発サーバーを起動する

```bash
npm run dev
```

このコマンドは内部で次を実行します。

```bash
wrangler pages dev public --d1 DB=daily-pilot
```

起動後、通常は次のURLで確認できます。

```text
http://localhost:8788
```

### 4. 構文チェックを実行する

```bash
npm run check
```

このコマンドは、フロントエンドと Pages Functions の JavaScript に構文エラーがないかを確認します。

## 運用時の注意点

- Google OAuth の `GOOGLE_REDIRECT_URI` は、Google Cloud Console に登録したリダイレクト URI と完全一致させてください。
- D1 の `database_id` を `replace-with-your-d1-database-id` のままにすると、本番デプロイ後にDBへ接続できません。
- 現在は個人利用を想定したシンプルなセッションCookie方式です。複数ユーザーで本格運用する場合は、ユーザー認証、トークン暗号化、アカウント分離を追加してください。
- Cloudflare の無料枠で使いやすいよう、Googleカレンダー同期は自動常時同期ではなく、画面上の「予定を取得」ボタンによる手動取得を前提にしています。
