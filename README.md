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

## What it does not do (yet)

- **No CMS connectors / scanning.** Nothing talks to WordPress, Shopify, Search Console or Rank Math. Item states are set by people. "Record audit" only stamps a date.
- **No per-user accounts.** The API backend uses one shared bearer token per deployment (one agency). Multi-user auth (and per-agency tenancy — the schema already has an `agency_id` column) is the next step.
- **Local mode is per-browser.** With the default `backend: 'local'`, data lives in that browser's `localStorage`. Use *Export JSON* for backups, or turn on the API backend below.

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
api/
  [...path].js        Vercel serverless function: GET/PUT/DELETE /state, GET/POST /actions
  _lib/db.js          pg pool + transactions (lazy-loaded)
  _lib/http.js        JSON helpers, bearer-token auth
db/schema.sql         Postgres schema + reporting views
test/                 node --test: model, store, seed, API handler (in-memory DB)
```

### How data flows

`app.js` never touches storage. It calls `store.dispatch(type, payload)`; the store runs the pure `reduce()` in `store.js`, notifies the UI, and hands the action to the active adapter. The local adapter writes the whole state to `localStorage`; the API adapter POSTs the action, and the server runs **the same `reduce()`** against the stored snapshot, so browser and server can never disagree about what an action means. Other open consoles poll `GET /api/actions?since=<seq>` and replay what they missed.

## Deploy to Vercel (local mode — zero setup)

1. Push this repo to GitHub and import it at [vercel.com/new](https://vercel.com/new).
2. Framework preset **Other**. Leave Build Command and Output Directory blank.
3. Deploy. Every push to `main` redeploys.

`package.json` lists `pg` for the API; Vercel installs it, but in local mode the API is never called.

## Turning on the backend (shared data across devices / teammates)

1. Create a Postgres database (Vercel Postgres / Neon / Supabase / any host) and apply the schema:
   ```
   psql "$DATABASE_URL" -f db/schema.sql
   ```
2. In the Vercel project → Settings → Environment Variables, set `DATABASE_URL` and `RANKOPS_API_TOKEN` (a long random string). See `.env.example`.
3. In `js/config.js` set `backend: 'api'` and `apiToken` to the same token, then push.
4. Open the app: it fetches `/api/state`, seeds the demo data on first run, and from then on every change is written to Postgres. The Checklist Template page shows `Storage: api` when it's live.

The token is shipped in the front-end config, so it protects the API from the public internet, not from people who can open the console. Real per-user auth is the next milestone.

`db/schema.sql` also creates read-only views (`clients_v`, `sites_v`, `site_items_v`, `flags_v`, `fix_requests_v`, `audit_log_v`) so you can report with plain SQL.

## Development

```
npm test                      # unit + API tests (node --test)
npm run dev                   # static server on http://localhost:8080
```

No dependencies are needed for the front end or the tests; `pg` is only loaded by the API at runtime.

## Roadmap

1. Per-user accounts and per-agency tenancy on the API.
2. CMS connectors (WordPress / WooCommerce / Rank Math, Shopify) so checklist items can be machine-checked and "Record audit" runs a real scan.
3. Editable checklist templates per vertical.
