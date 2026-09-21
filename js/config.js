// Runtime configuration. Edit this file (or set window.RANKOPS_CONFIG before the app loads) to switch backends.
//
//   backend: 'local'  — everything lives in this browser's localStorage. Zero setup. Default.
//   backend: 'api'    — reads/writes go to the Vercel serverless API in /api, backed by Postgres.
//                       Requires DATABASE_URL + RANKOPS_API_TOKEN set on the Vercel project and
//                       db/schema.sql applied. See README → "Turning on the backend".
const defaults = {
  backend: 'local',
  apiBase: '/api',
  apiToken: '',            // must match RANKOPS_API_TOKEN on the server when backend === 'api'
  storageKey: 'rankops_state_v2',
};

export const CONFIG = Object.assign({}, defaults, (globalThis.RANKOPS_CONFIG || {}));
