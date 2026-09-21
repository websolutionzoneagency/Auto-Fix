// API adapter — talks to the Vercel serverless functions in /api (see api/[...path].js).
// Same interface as adapters/local.js, plus:
//   call(method, path, body)  — any endpoint, used by the connection / scan / fix UI
//   sync()                    — pull other users' (and the scanner's) actions right now
//   watch(fn)                 — light poll so every open console converges on the same state
//
// Auth: `getToken()` returns either the signed-in user's Supabase JWT or the static apiToken.

export class ApiError extends Error {
  constructor(message, { status, body } = {}) { super(message); this.name = 'ApiError'; this.status = status; this.body = body; }
}

export function createApiAdapter({ apiBase = '/api', apiToken = '', pollMs = 15000, getToken } = {}) {
  const origin = 'o_' + Math.random().toString(36).slice(2, 10);   // identifies this tab so its own actions aren't replayed
  let seq = 0;
  let onRemote = null;
  let timer = null;
  let inflight = null;                                              // the current sync, so callers coalesce onto it
  const tokenOf = getToken || (() => apiToken);

  async function call(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    const token = await tokenOf();
    if (token) headers.authorization = 'Bearer ' + token;
    const res = await fetch(apiBase + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new ApiError((data && data.error) || `${method} ${path} → HTTP ${res.status}`, { status: res.status, body: data });
    return data;
  }

  /** Pull actions newer than what this tab has seen. Concurrent callers share one request and all
   *  resolve once it lands — an explicit sync() after a fix must never be skipped because the
   *  background poll happened to be in flight. */
  function sync() {
    if (inflight) return inflight.then(() => sync());              // one more pass after the current one, so nothing is missed
    inflight = (async () => {
      try {
        const data = await call('GET', `/actions?since=${seq}`);
        for (const row of data.actions || []) {
          if (row.seq > seq) seq = row.seq;
          if (row.origin !== origin && onRemote) onRemote(row.action);
        }
      } catch (e) {
        console.warn('[rankops] sync failed', e.message);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function schedule() {
    clearTimeout(timer);
    if (onRemote) timer = setTimeout(async () => { await sync(); schedule(); }, pollMs);
  }

  return {
    name: 'api',
    origin,
    call,
    sync,
    async load() {
      const data = await call('GET', '/state');
      seq = data.seq || 0;
      return data.state || null;
    },
    async persist(state, action) {
      if (action.type === 'state/replace') {
        const data = await call('PUT', '/state', { state, origin });
        seq = data.seq || seq;
        return;
      }
      const data = await call('POST', '/actions', { action, origin });
      if (data && data.seq > seq) seq = data.seq;
    },
    watch(fn) {
      onRemote = fn;
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { sync().then(schedule); } });
      }
      schedule();
    },
    async clear() { await call('DELETE', '/state'); seq = 0; },
  };
}
