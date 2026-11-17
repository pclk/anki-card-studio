# Anki Card Studio

Review, revise and export AI-made Anki cards — on your computer or your phone.

- **Online (this repo, on Vercel):** sign in with GitHub, and your projects, images and source PDFs live in your
  account (Neon Postgres). Open the same address on any device; install it to your phone's home screen.
- **Offline / local:** `studio/studio.html` still works on its own (saves in the browser), or with the local
  companion server `local/acs.py` (saves to a folder on your computer).
- **The `anki` Claude skill** (`skill/anki/`) makes the cards: upload `skill/anki` as a zip in Claude's skill settings.

How to use the Studio itself: [docs/USER-GUIDE.md](docs/USER-GUIDE.md).

---

## Deploy to Vercel (about 10 minutes)

1. **Import the repo.** vercel.com → *Add New… → Project* → import `pclk/anki-card-studio`. The framework is detected
   as Next.js; keep the defaults. The first deploy will work but nobody can sign in yet — that's expected.

2. **Database.** In the Vercel project → *Storage* → connect your Neon database. That adds `DATABASE_URL` (and the
   `POSTGRES_*` variables). If you'd rather paste it yourself, add `DATABASE_URL` = the **pooled** connection string
   under *Settings → Environment Variables*. The tables are created automatically on first use (or run
   `DATABASE_URL=… npm run db:migrate`).

3. **GitHub sign-in.** github.com → *Settings → Developer settings → OAuth Apps → New OAuth App*:
   - Homepage URL: `https://<your-project>.vercel.app`
   - Authorization callback URL: `https://<your-project>.vercel.app/api/auth/callback/github`

   Create it, then *Generate a new client secret*.

4. **Environment variables** (Vercel → *Settings → Environment Variables*, for Production):

   | Name | Value |
   | --- | --- |
   | `AUTH_SECRET` | a random string: `openssl rand -base64 32` |
   | `AUTH_GITHUB_ID` | the OAuth app's Client ID |
   | `AUTH_GITHUB_SECRET` | the OAuth app's client secret |
   | `ACS_ALLOWED_GITHUB` | optional: extra GitHub usernames allowed in, comma separated |
   | `ACS_ADMIN_GITHUB` | optional: who manages the list in the app (default `pclk`) |

5. **Redeploy** (*Deployments → … → Redeploy*) so the variables take effect. Open the site, sign in with GitHub.

6. **Your phone:** open the same address, sign in, then install it — iPhone: *Share → Add to Home Screen*;
   Android: *⋮ → Install app*.

**Custom domain (optional), e.g. `anki.siew.dev`:** Vercel → *Settings → Domains* → add it and create the DNS
record Vercel shows. Then change both URLs in the GitHub OAuth app to the new domain (you can create a second OAuth
app instead if you want both addresses to work).

### Letting other people in

The admin (`pclk`) gets *Settings → Users → **Open user management***: add a GitHub username, and that person can sign
in straight away. Each person has their own projects — nothing is shared between accounts. For every account the admin
can change the role (user / admin), make it **read-only** or **disabled**, set a **storage limit**, **sign it out
everywhere**, remove its access, and see and change its data: edit a project's JSON, rename, download, delete or restore
projects, put an older saved version back, list or delete images and source files, edit or reset its settings, or delete
everything it stored. Admins set in `ACS_ADMIN_GITHUB` and usernames set in `ACS_ALLOWED_GITHUB` can only be changed on
Vercel. See `lib/users.ts` and the admin routes at the end of `lib/api.ts`.

### Bring over your existing projects

Projects from the local version live in your computer's data folder or browser, which the website can't see:

1. In the **old** Studio (the `.html` file or `http://127.0.0.1:8765`): sidebar (☰) → *App data* → **⬇ Export all** → a `.zip`.
2. In the **online** Studio: *Settings* → **⬆ Import…** (or sidebar → *App data* → **⬆ Import…**) → pick that zip.
   Each project appears in the sidebar as soon as it has finished uploading; an empty starter project is replaced.
   Importing a project you deleted before brings it back. Projects, images and source files are
   copied into your account. (If the old Studio saved in the browser, the online one also offers
   *⇪ Copy browser projects* — but only for projects in the same browser *and* the same address, so the zip is the
   reliable way.)

---

## How it works

```
app/route.ts                  GET /  -> studio/studio.html (signed-in users only, else -> GitHub sign-in)
app/api/auth/[...nextauth]    Auth.js (GitHub), allow-list in ACS_ALLOWED_GITHUB, JWT session cookie
app/api/[...path]/route.ts    the storage API -> lib/api.ts
lib/api.ts                    same routes as local/acs.py, so the page works unchanged against either
lib/store.ts                  Postgres storage, per user (GitHub account id)
lib/fetch-readable.ts         "add a web page" as a source, with private-network (SSRF) protection
lib/bridge.ts                 the Mac bridge's device tokens and jobs ("▶ Run on Mac")
bridge/acs-bridge.mjs         the bridge itself: runs on your Mac, runs Claude Code or Codex on the jobs
public/sw.js                  service worker: the app opens offline, libraries cached; /api is never cached
public/manifest.webmanifest   installable app
studio/studio.html            the whole Studio (single file)
skill/anki/                   the Claude skill that makes the cards
local/acs.py                  the local companion server (still supported)
```

**Storage** (tables are prefixed `acs_`):
- `acs_projects` — a project's cards and settings, with its revision number. A save that wasn't based on the
  latest revision is refused (HTTP 409) and the Studio merges the two versions. That's how two devices editing the
  same project at once stay consistent.
- `acs_history` — the previous version of each project, at most one per 10 minutes, the last 30, plus the final
  version of deleted projects.
- `acs_files` / `acs_chunks` — images and source files. Vercel limits a request to 4.5 MB, so the Studio sends
  larger files (lecture PDFs) in 3 MB pieces and reads them back the same way.
- `acs_index`, `acs_deleted`, `acs_settings` — the project list, deleted ids (so a stale device can't bring a
  deleted project back; an explicit import can), and your keys and settings.
- `acs_allowed` — people the admin let in from the app.
- `acs_devices`, `acs_jobs`, `acs_job_events` — the Mac bridge: paired devices (only a hash of each token), the
  jobs sent to them and their progress log. A job's files are stored like source files and removed with the job;
  finished jobs are forgotten after 14 days, a run whose bridge goes quiet for 5 minutes fails, and so does a job
  whose files never all arrived within an hour.
- `acs_users` — everyone who has signed in (username ↔ account id), last activity, and the admin's controls: role,
  status (active / read-only / disabled), storage limit, and "signed out everywhere" time.

**Security**
- Every page and API request needs a signed-in, allowed user: the admin, `ACS_ALLOWED_GITHUB`, or someone the admin
  added in the app (table `acs_allowed`). The list is checked on every request (cached for 20 s), so removing someone
  takes effect within seconds.
- Data is keyed by GitHub account id. One user can never read another's data.
- Writes must come from the site itself: SameSite cookies, plus an Origin check.
- The web-page import only fetches public http(s) addresses on ports 80/443. Every resolved IP is checked when the
  connection is made, and again on each redirect, so it can't be pointed at internal services.
- **The Mac bridge** signs in with a device token (Settings → Mac bridge), which reaches only the bridge endpoints:
  picking up this account's jobs, reading their files, posting progress and uploading the result. It can't read
  projects or settings. Removing the device, disabling the account or "sign out everywhere" cuts it off at once. On
  the Mac each job runs in its own folder with a fixed instruction and fixed agent flags; nothing from the server is
  put on a command line. See the top of `bridge/acs-bridge.mjs`.
- Never commit `.env*` files. Keep the database URL and secrets in Vercel's environment variables.

**Offline:** the Studio keeps working without a connection. Edits that can't reach the account are kept in the
browser (IndexedDB, per account), so a closed tab or a reload loses nothing, and the installed app opens from those
copies with no connection: every project opened on that device before, with the pictures that were shown (the service
worker keeps them). When the connection is back the edits go up by themselves, merged 3-way with whatever other devices
saved meanwhile (real clashes open the usual resolver). Sources, the Mac bridge, deleting projects and the admin pages
need a connection. Signing out deletes the offline copies (and asks first if some edits haven't reached the account).

## Develop

```bash
npm install
cp .env.example .env.local      # fill in DATABASE_URL; for local work without GitHub set ACS_INSECURE_DEV_USER=dev
npm run dev                     # http://localhost:3000
npm test                        # API tests on PGlite (Postgres in WASM) - no database needed
npm run typecheck
```

`ACS_INSECURE_DEV_USER` skips GitHub sign-in for local development and tests only; it is ignored whenever the app
runs on Vercel.

## Limits

- **Neon free tier:** storage covers a lot of cards, but source PDFs are the big item. Delete sources you no longer
  need, or upgrade if you import many large lectures.
- **Web import:** a linked PDF over 4 MB can't come through the server. Download it and add the file instead.
- **Vercel Hobby** is for personal, non-commercial use.

### Source generation and regression checks

Edit browser code in `studio/src/` (ordered by `manifest.json`) and the skill in `skill/anki/`.
Run `npm run build:studio` to regenerate the standalone `studio/studio.html`, including the bundled sanitizer.
Generated assets are checked against their canonical sources in CI.

- `npm test`: API, storage, input validation, sanitizer and generated-asset regressions.
- `npm run test:local`: isolated Python companion HTTP tests.
- `npm run test:e2e`: Chromium desktop and phone-emulation tests; installs via `npx playwright install chromium`.
- `ACS_TEST_POSTGRES_URL=… npm run test:postgres`: real PostgreSQL concurrent saves, quotas, upload sessions, locks and rollback. Use a disposable database; tests create and remove dedicated schemas.

Large uploads use a unique upload-session ID; staging preserves the previous completed file until promotion.
Re-sending identical pieces is safe; changing bytes within a session is rejected. Superseded sessions cannot append pieces.
Active storage quotas include settings, project indexes and incomplete uploads. Recovery history has a separate bounded
allowance (the account quota, or 64 MB when unlimited), with at most 30 revisions per project. Old recovery copies are
pruned automatically so saving or deleting a project does not consume its active quota twice.

Browser tests use local development authentication. Live GitHub OAuth, Neon/Vercel networking, physical phones and
importing exported files into the Anki desktop application require integration checks in those environments.
