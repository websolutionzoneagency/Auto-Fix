# RankOps Console

An agency dashboard for RankOps — a CRM-style console for tracking SEO/AI-visibility health, fix requests, and flags across every client site. This is a static, zero-backend front end: no build step, no server, no database. It's a real working UI you can click through, deployed as a plain static site.

## What's actually functional right now

This is a front-end shell with mock data wired to real client-side behavior — not just a picture of a dashboard:

- Sidebar navigation between Dashboard, Clients, Flags Inbox, Site detail, and Checklist Templates
- Site detail tabs (Checklist / Fix Requests / Flags / Audit Log)
- **Search** on the Dashboard client table filters rows live
- **+ Add client** opens a real form; the new client appears in both the Dashboard and Clients tables and persists in your browser (localStorage) across reloads
- **Fix Request kanban cards are clickable** — click a card to advance it Pending → In Progress → Done, which updates column counts and appends a row to the Audit Log
- **Light/dark theme toggle** in the sidebar, persisted per-browser
- "Run full audit" gives simulated scan feedback

What it does **not** do yet: there is no backend, no real connector to WordPress/Shopify/etc., no multi-user accounts, and no shared data between browsers/devices — everything lives in your own browser's `localStorage`. That's the natural next step (see below) once you're ready to wire this up to something real.

## Deploy this to Vercel

**Option A — no GitHub, fastest:**
```
npm i -g vercel
cd rankops-dashboard
vercel
```
Follow the prompts (first deploy asks a couple of setup questions; accept the defaults — it's a static site, no build command needed).

**Option B — via GitHub (recommended if you'll keep editing this):**

1. Create a new empty repository on GitHub (no README/license, so it stays empty).
2. From this folder:
   ```
   git init
   git add .
   git commit -m "Initial commit: RankOps console"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
3. Go to [vercel.com/new](https://vercel.com/new), import that GitHub repo.
4. Framework preset: **Other** (or "Static"). Leave Build Command and Output Directory blank — this project has no build step; Vercel will serve `index.html` directly.
5. Click Deploy. You'll get a `*.vercel.app` URL, and every future push to `main` auto-deploys.

## Project structure

```
rankops-dashboard/
├── index.html      # the entire app — markup, styles, and behavior in one file
├── vercel.json     # clean URLs, no trailing slashes (optional, safe defaults)
├── .gitignore
└── README.md
```

## Turning this into a real product

The mock data (four sample clients, one detailed site, six flags) mirrors the data model described in the RankOps knowledge base: Agency → Client Account → Site → {Connector, Checklist Instance, Fix Request, Flag, Audit Log}. To make this "real":

1. Add a backend (a small API — Vercel Serverless Functions/Edge Functions work well here since you're already on Vercel) and a database (Postgres, or Vercel's own storage add-ons) to replace `localStorage` with shared, multi-user data.
2. Add authentication so "Ismail · Agency Admin" becomes a real logged-in account, and client data is scoped per agency.
3. Replace the hardcoded client/site/flag markup with data fetched from that API.
4. Wire the CMS connector layer (WordPress/WooCommerce/Rank Math, Shopify, etc.) described in the knowledge base to actually run checklist scans and push fixes, instead of the current static, pre-baked example.

None of that is required for this to be live and clickable on Vercel today — it already is. It's required only when you want it to hold real, shared client data instead of a demo.
