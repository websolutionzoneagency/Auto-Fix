// API adapter — talks to the Vercel serverless functions in /api (see api/[...path].js).
// Same interface as adapters/local.js, plus watch(): a light poll that pulls actions other
// users made so every open console converges on the same state.
//
//   GET  /api/state                 → { seq, state }
//   POST /api/actions  { action, origin } → { seq }
//   GET  /api/actions?since=<seq>   → { seq, actions: [{ seq, origin, action }] }
//   DELETE /api/state               → 204 (wipes the agency's data)

export function createApiAdapter({ apiBase = '/api', apiToken = '', pollMs = 15000 } = {}) {
  const origin = 'o_' + Math.random().toString(36).slice(2, 10);   // identifies this tab so its own actions aren't replayed
  let seq = 0;
  let onRemote = null;
  let timer = null;

  const headers = { 'content-type': 'application/json' };
  if (apiToken) headers.authorization = 'Bearer ' + apiToken;

  async function call(method, path, body) {
    const res = await fetch(apiBase + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  async function poll() {
    try {
      const data = await call('GET', `/actions?since=${seq}`);
      for (const row of data.actions || []) {
        if (row.seq > seq) seq = row.seq;
        if (row.origin !== origin && onRemote) onRemote(row.action);
      }
    } catch (e) {
      console.warn('[rankops] sync poll failed', e.message);
    } finally {
      if (onRemote) timer = setTimeout(poll, pollMs);
    }
  }

  return {
    name: 'api',
    origin,
    async load() {
      const data = await call('GET', '/state');
      seq = data.seq || 0;
      return data.state || null;
    },
    async persist(state, action) {
      if (action.type === 'state/replace') {
        // Import / reset: send the whole snapshot rather than the action stream.
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
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { clearTimeout(timer); poll(); } });
      }
      timer = setTimeout(poll, pollMs);
    },
    async clear() { await call('DELETE', '/state'); seq = 0; },
  };
}
