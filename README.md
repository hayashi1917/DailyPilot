# DailyPilot

DailyPilot is a Cloudflare Pages + D1 application for building a daily task plan, schedule, actual activity log, reflection, and exportable Japanese text summary.

## Features

- S/A/B priority task management with `◯ / △ / ☓` status marks.
- Daily schedule timeline with overlap warnings.
- Actual activity logging with a start/stop timer.
- Daily reflection fields for achievement rate, reason, improvements, good points, and notes for tomorrow.
- One-click text export in the same format as the original text-based workflow.
- Google Calendar integration only:
  - OAuth connection.
  - Fetch primary-calendar events for the selected day.
  - Import Google events into the DailyPilot schedule.
  - Add DailyPilot schedule blocks to Google Calendar.

## Cloudflare setup

1. Create a D1 database.
2. Replace `database_id` in `wrangler.toml`.
3. Apply migrations:

```bash
wrangler d1 migrations apply daily-pilot --remote
```

4. Configure these Cloudflare secrets / variables:

```bash
wrangler pages secret put GOOGLE_CLIENT_ID
wrangler pages secret put GOOGLE_CLIENT_SECRET
wrangler pages secret put GOOGLE_REDIRECT_URI
wrangler pages secret put APP_BASE_URL
```

For local development, `wrangler.toml` includes localhost defaults for `GOOGLE_REDIRECT_URI` and `APP_BASE_URL`.

## Google OAuth configuration

Create an OAuth client in Google Cloud Console and add the callback URL used by your deployment:

```text
https://<your-domain>/api/google/callback
```

Required scopes:

- `https://www.googleapis.com/auth/calendar.readonly`
- `https://www.googleapis.com/auth/calendar.events`

## Development

```bash
npm run dev
```

The app intentionally uses vanilla JavaScript, CSS, Cloudflare Pages Functions, and D1 so it can stay lightweight for Cloudflare free-plan usage.
