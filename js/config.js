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
  backend: 'api',
  apiBase: '/api',
  apiToken: '',
  // Public by design: the anon key only identifies the project and is bound by row-level security.
  supabase: {
    url: 'https://elxyggsnztsmkpviznqu.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVseHlnZ3NuenRzbWtwdml6bnF1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5ODM2NzIsImV4cCI6MjEwNTU1OTY3Mn0.bF_XfFjYEaxEwHhjUjJ1-nBGcTYq6N9nGQeHULoj2Wk',
  },
  storageKey: 'rankops_state_v2',
};

let override = {};
try { override = JSON.parse(globalThis.localStorage?.getItem('rankops_config') || '{}') || {}; } catch { override = {}; }

export const CONFIG = Object.assign({}, defaults, (globalThis.RANKOPS_CONFIG || {}), override);
