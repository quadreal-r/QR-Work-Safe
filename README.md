# QuadReal Work Safe

Field check-in app: notify supervisors when a worker arrives on site to climb a ladder, and again when they are safe on the ground. Each alert includes GPS, reverse-geocoded address, and a date/time stamp. Logs are kept separately per worker.

Same architecture as RTU QR Audit: vanilla SPA + Capacitor + Cloudflare Worker + Supabase (service role only).

## Day-to-day commands

| Command | What it does |
|---------|----------------|
| `npm run dev` | Live reload in a desktop browser |
| `npm run dev:android` | Live reload on Android |
| `npm run sync` | Build `www/`, sync version, `cap sync` |
| `npm run ship:web` | Deploy tracker site to Cloudflare |
| `npm run ship:api` | Deploy `work-safe-api` Worker |

## CI

GitHub Actions (`.github/workflows/ci.yml`) on every push/PR to `main`:

- Gitleaks secret scan
- `work-safe-api` Wrangler dry-run
- Web asset parity (root ↔ `www/` ↔ Android after `build:web` + `cap copy`)
- PR-only: require `APP_VER` / `BUILD` bump when `index.html` changes

Dependabot keeps Gradle, npm, and Actions weekly.

## First-time setup

```bash
npm install
cp .env.example .env
npm run build:web
npx cap add android   # optional
```

### Worker secrets

See [cloudflare/work-safe-api/README.md](cloudflare/work-safe-api/README.md):

- `AUTH_PASSWORD`, `AUTH_SECRET`
- `SUPABASE_SERVICE_KEY`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
- Cloudflare Email Sending enabled for `EMAIL_FROM`

### Database

Apply `supabase/migrations/20260727200000_work_safe.sql` to the QR-East_Industrial_Database project (`wyiymdtlncperqpwriuk`).

## Field flow

1. Sign in (shared staff password)
2. Enter worker name; pick who to notify
3. **On site / climbing** → GPS + address + timestamp → email + SMS → opens a session
4. **Safe on ground** → same → closes the session
5. **Logs** tab → filter by worker

Contacts are managed in Settings and shared across devices.

## Versioning

Bump only in `index.html`:

```js
const APP_VER='vX.Y.Z';
const BUILD=N;
```

`npm run sync` pushes that into native version fields when Android/iOS projects exist.
