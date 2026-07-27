# Work Safe API

Cloudflare Worker for QuadReal Work Safe: shared-password auth, contact list, GPS check-in with email + SMS, per-worker logs.

Public URL (after deploy): `https://work-safe-api.quadreal-rpiwin.workers.dev`

## Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/health` | no | Health + channel readiness |
| POST | `/api/login` | no | Shared password → Bearer token |
| GET | `/api/me` | yes | Session check |
| GET | `/api/contacts` | yes | List watchers |
| PUT | `/api/contacts` | yes | Replace watcher list |
| POST | `/api/checkin` | yes | GPS event → reverse-geocode → email + SMS → log |
| GET | `/api/logs?worker=` | yes | Per-worker (or all) event history |

## Secrets

From `cloudflare/work-safe-api`:

```bash
npx wrangler secret put AUTH_PASSWORD
npx wrangler secret put AUTH_SECRET
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_FROM_NUMBER
```

## Vars (`wrangler.jsonc`)

- `TOKEN_EPOCH` — bump to revoke all sessions
- `SUPABASE_URL` — `https://wyiymdtlncperqpwriuk.supabase.co`
- `EMAIL_FROM` / `EMAIL_FROM_NAME` — must match an onboarded Cloudflare Email Sending domain

## Email

Binding `EMAIL` via Cloudflare Email Sending. Enable the from-domain:

```bash
npx wrangler email sending enable yourdomain.com
```

Then set `EMAIL_FROM` to an address on that domain.

## SMS

Twilio REST from the Worker. `TWILIO_FROM_NUMBER` must be E.164 (e.g. `+14155551234`).

## Deploy

```bash
npm run deploy
# or from repo root:
npm run ship:api
```
