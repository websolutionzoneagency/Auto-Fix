# RankOps Console

An agency console for tracking SEO / AI-visibility health across every client site: a 208-item checklist per site, health scores, fix-request queue, risk flags and an audit log — the same workflow as the Fleet SEO Tracker, rebuilt as a multi-client SaaS front end.

No build step. Plain HTML + ES modules, deploys to Vercel as a static site, with an optional serverless API + Postgres backend for shared, multi-device data.

## What works

Everything on screen is computed from one state object — there is no hardcoded mock markup left.

- **Dashboard** — live tiles (average health, sites, open flags, active fix requests, fixes closed in 30 days), client table sorted by attention needed, searchable across client / site / domain / platform, "Needs your decision" panel of high-severity flags.
- **Clients** — add a client (with its first site) in a modal; every row opens the client's site; add more sites per client; remove a client (cascades to its sites, flags, fix requests and log).
- **Site detail**
  - **Checklist** — all 208 items in 20 collapsible categories. Click an item to cycle *pending → done → n/a*. Critical items are badged. Done items get a checked date and an optional evidence URL. Filter by pending / critical / done. Per-category progress bars.
  - **Fix requests** — "Request fix" on any pending item queues it with a priority (P0–P2) and a note. Kanban: *Queued → In progress (incl. Blocked / Waiting on client) → Done*. Marking a fix done marks its checklist item done; marking an item done closes its open fix request.
  - **Flags** — raise a risk flag with severity and tag; resolve / reopen / delete.
  - **Audit log** — every mutation writes a timestamped entry (item state changes, evidence, flags, fix requests, audits, site/client changes).
  - **Record audit** stamps the last-audit date; the header turns red when it's older than 14 days.
  - **Site settings** — domain, platform, connector, notes; delete site.
- **Flags Inbox** — every open flag across the portfolio, filter by severity, show resolved.
- **Checklist Template** — browse / search the 208-item master template with hints and critical markers.
- **Data** — export JSON, import JSON, reset to demo data, delete everything. Light / dark / system theme.
- Deep links: `#/site/<id>/<tab>`, `#/flags`, etc. survive reload.

**Health score** (per site, same formula as the Fleet Tracker): checklist completion % − 6 per open critical item − 8 per open high flag − 3 per open medium flag, floored at 0. N/a items are excluded from the completion %.

## Connecting a site, scanning, fixing

With the API backend on (below), the console stops being a checklist you fill in and starts checking and repairing the site itself.

1. **Connect** — Site settings → Connection: the site URL, a WordPress user and an *Application Password* (Users → Profile → Application Passwords on the site), optionally WooCommerce keys. Credentials are tested against the site before they are saved, encrypted (AES-256-GCM) before they reach Postgres, and never shown again.
2. **Install the companion plugin** — copy `wordpress-plugin/rankops-connector.php` to `wp-content/mu-plugins/`. Without it the checks still run, but revision counts and the debug flag report *not checked*, and SEO-meta fixes (canonical, noindex) cannot write. See `wordpress-plugin/README.md`.
3. **Scan** — *Record audit* (or *Scan now* on the Automation tab) runs the 22 read-only checks. A small site finishes inside the request; anything left is continued each time the open console polls the job (every 15 s), and a daily Vercel Cron picks up anything abandoned. Each verdict moves its checklist items **through the same reducer a human click uses**: pass → done with an evidence URL, fail → pending with a log line, *unknown* → untouched and explained in the audit log. A check that could not run never ticks a box.
4. **Fix** — on a failing item with the `auto-fix` badge, *Fix →* opens a plan: every proposed change with its before/after, derived values flagged for review, irreversible ones labelled. Nothing is written until you apply. Every applied change stores what it replaced.
5. **Revert** — Automation tab → Applied fixes → *Revert* restores the stored value on the live site and reopens the item.
6. **Kill switch** — *Pause writes* (Automation tab or Site settings) blocks every apply and revert for that site until resumed.

### What a machine may touch

`js/automation.js` is the single source of truth, shared by the API and the UI:

| Tier | Items | Meaning |
|---|---|---|
| `auto-fix` | 8 | scanner decides it **and** a fixer repairs it: canonical tags, thin-archive noindex, image alt text, author display names, legacy link prefixes, revision purge, Organization schema, open registration |
| `auto-check` | 20 | scanner decides it; fixing needs you — each carries the reason (destructive, needs a destination, would fabricate content…) |
| `manual` | 180 | content, strategy and every regulatory item. Silence in the map means "a machine must not touch this" |

### Guardrails (all covered by tests)

Planning writes nothing · a write that does not read back correctly is reported *failed*, not applied · one failure never aborts a batch · irreversible operations refuse to revert · the kill switch is checked before any planning · `unknown` verdicts never move an item.

## What it does not do (yet)

- **Only WordPress** has a connector. Shopify sites can be tracked manually; `api/_lib/connectors/index.js` is where the next platform plugs in.
- **Only WordPress REST is used** — no crawling behind logins, no JavaScript rendering. Checks sample up to 25 pages per run.
- **No Search Console data** yet (query coverage, cannibalisation). `PSI_API_KEY` enables the Core Web Vitals check; nothing else calls Google.
- **Single-agency token mode** has no user accounts. Supabase Auth mode has accounts and roles (owner/admin/member/viewer) but no invitation UI — add members with SQL for now (`agency_members`).

## Project structure

```
index.html            app shell + CSS (no inline JS, no inline handlers)
js/
  app.js              UI: rendering + event delegation → store.dispatch()
  store.js            state shape, pure reducer, createStore(adapter), migrations
  model.js            pure logic: health, progress, sorting, selectors, escaping
  checklist.js        the 208-item / 20-category template (ported from the Fleet SEO Tracker)
  seed.js             deterministic demo dataset (built through the reducer)
  config.js           backend switch: 'local' | 'api'
  adapters/local.js   localStorage persistence (default)
  adapters/api.js     talks to /api, polls for other users' actions
js/
  automation.js       tier map: which items are auto-fix / auto-check / manual, and why
  auth.js             Supabase sign-in (or static token)
api/
  [...path].js        the API: console state, connections, scans, findings, fix plan/apply/revert, cron
  _lib/auth.js        Supabase JWT verification (ES256 via JWKS, or legacy HS256; no dependency) + static token; roles
  _lib/repo.js        all SQL, every query scoped by agency
  _lib/scanner.js     time-boxed scan batches; folds verdicts into the console snapshot
  _lib/checks.js      22 read-only checks → pass | fail | unknown
  _lib/fixes.js       8 fixers: plan → apply (with snapshot) → revert; kill switch
  _lib/crypto.js      AES-256-GCM for credentials, bound to their row
  _lib/connectors/    wordpress.js (REST + WooCommerce), index.js (registry, decrypt)
  _lib/db.js, http.js pg pool; JSON helpers
db/
  supabase.sql        schema: agencies, members (auth.users), connections, scan queue, findings, fix ops; RLS
  rls-test.sql        proves tenant isolation — every line must print OK
wordpress-plugin/     mu-plugin: registers SEO meta for REST, revision + debug reporting, Organization schema
scripts/
  dev-server.mjs      local Vercel stand-in: static files + /api
  e2e.mjs             browser test, local mode (65 checks)
  e2e-connected.mjs   browser test, API mode against a throwaway Postgres + mock WordPress (33 checks)
test/                 node --test: model, store, seed, crypto, connector, checks, fixes, API (real Postgres)
```

### How data flows

`app.js` never touches storage. It calls `store.dispatch(type, payload)`; the store runs the pure `reduce()` in `store.js`, notifies the UI, and hands the action to the active adapter. The local adapter writes the whole state to `localStorage`; the API adapter POSTs the action, and the server runs **the same `reduce()`** against the stored snapshot, so browser and server can never disagree about what an action means. Other open consoles poll `GET /api/actions?since=<seq>` and replay what they missed.

## Deploy to Vercel (local mode — zero setup)

1. Push this repo to GitHub and import it at [vercel.com/new](https://vercel.com/new).
2. Framework preset **Other**. Leave Build Command and Output Directory blank.
3. Deploy. Every push to `main` redeploys.

`package.json` lists `pg` for the API; Vercel installs it, but in local mode the API is never called.

## Turning on the backend (Supabase + Vercel)

1. **Supabase** — create a project. SQL editor → paste `db/supabase.sql` → run. Copy the *connection string* (Project Settings → Database, pooler URI).
2. **Vercel** → Settings → Environment Variables: `DATABASE_URL`, `ENCRYPTION_KEY` (`openssl rand -base64 32`), `CRON_SECRET`, and — only if you want single-shared-token mode instead of user accounts — `RANKOPS_API_TOKEN`. With user accounts, sign-in tokens are verified against the project's public signing keys (ES256), so nothing else is needed; a project still on the legacy HS256 *JWT secret* sets `SUPABASE_JWT_SECRET` instead. `.env.example` lists them all with notes. Redeploy after changing variables.
3. **`js/config.js`** — set `backend: 'api'`, and either `supabase: { url, anonKey }` (sign-in screen appears) or `apiToken`. Push; Vercel redeploys. `vercel.json` gives the function 60 s and schedules `/api/cron/scan` daily (the Hobby plan allows only daily crons; scans are driven to completion by the open console anyway).
4. **First user** (Supabase Auth mode) — Authentication → add a user, then in SQL: `insert into agencies (id,name) values (gen_random_uuid(),'Web Solution Zone'); insert into agency_members values ('<agency uuid>','<user uuid>','owner');`
5. Open the console. *Storage: api* on the Checklist Template page confirms it. Connect a site (above).

Never commit `ENCRYPTION_KEY`: it is the only thing standing between the database and every stored site password. Rotating it means re-entering every connection.

`db/supabase.sql` also adds `site_health_v` and `fix_activity_v` for SQL reporting.

## Development

```
npm install                   # pg (API) + playwright (browser tests)
npm test                      # unit tests always; API tests when RANKOPS_TEST_DATABASE_URL points at a Postgres
npm run dev                   # http://localhost:8080 with /api mounted (needs the env vars, e.g. a local Postgres)
npm run dev:static            # front end only, local mode
npm run e2e                   # browser test, local mode
RANKOPS_TEST_DATABASE_URL=postgres://... npm run e2e:connected   # connect → scan → fix → revert through the UI
```

The API tests and `e2e:connected` create a throwaway database each run and drop it afterwards; they need a Postgres you can create databases on (Postgres 16 locally is fine — never point them at the production project).

## Roadmap

1. Search Console OAuth → query coverage, cannibalisation and the topical-map checks (a large slice of the `manual` tier becomes `auto-check`).
2. Shopify connector.
3. Member invitations and agency switching in the UI (the schema and API already support several agencies per user).
4. Editable checklist templates per vertical.
