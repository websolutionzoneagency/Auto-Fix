// Runtime configuration. Three ways to set it, merged in this order:
//   1. the defaults below
//   2. window.RANKOPS_CONFIG   — set by an inline <script> before the app loads (production)
//   3. localStorage 'rankops_config' (JSON) — per-browser override for local development / testing
//
//   backend: 'local'  — everything lives in this browser's localStorage. Zero setup. Default.
//   backend: 'api'    — the Vercel serverless API in /api, backed by Supabase Postgres. Enables site
//                       connections, scanning and fixes. Needs the env vars in .env.example on Vercel.
//   supabase: { url, anonKey } — when set, the console asks users to sign in with Supabase Auth and
//                       sends their JWT. When absent, `apiToken` (single-agency mode) is sent instead.
const defaults = {
  backend: 'local',
  apiBase: '/api',
  apiToken: '',
  supabase: null,
  storageKey: 'rankops_state_v2',
};

let override = {};
try { override = JSON.parse(globalThis.localStorage?.getItem('rankops_config') || '{}') || {}; } catch { override = {}; }

export const CONFIG = Object.assign({}, defaults, (globalThis.RANKOPS_CONFIG || {}), override);
