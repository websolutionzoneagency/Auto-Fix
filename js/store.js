// The store: one state object, a pure reducer, and an adapter that persists each action.
// UI code only ever calls store.dispatch(type, payload) and reads store.state.
import { CHECKLIST } from './checklist.js';
import { stateOf, itemLabel, uid, nowIso, normalizeDomain } from './model.js';

export const SCHEMA_VERSION = 2;

export function emptyState() {
  return {
    version: SCHEMA_VERSION,
    theme: null,                                   // null = follow system
    agency: { name: 'Web Solution Zone', admin: 'Ismail', role: 'Agency Admin', initials: 'IH' },
    clients: {},                                   // id → { id, name, contact, plan, createdAt }
    sites: {},                                     // id → { id, clientId, name, domain, platform, connector, notes, createdAt, lastAuditAt, items{}, evidence{} }
    flags: {},                                     // id → { id, siteId, text, severity, tag, resolved, createdAt, resolvedAt }
    fixReqs: {},                                   // id → { id, siteId, itemId, priority, note, status, requestedAt, updatedAt }
    log: [],                                       // newest first: { id, siteId, at, kind, text }
  };
}

/* ---------- factories (used by the UI and by the demo seed) ---------- */
export function makeClient({ id, name, contact = '', plan = 'Growth', createdAt } = {}) {
  return { id: id || uid('c'), name: String(name || '').trim(), contact: String(contact || '').trim(), plan, createdAt: createdAt || nowIso() };
}
export function makeSite({ id, clientId, name, domain = '', platform = 'WordPress', connector = '', notes = '', createdAt, lastAuditAt = null } = {}) {
  return {
    id: id || uid('s'), clientId, name: String(name || '').trim(), domain: normalizeDomain(domain),
    platform, connector, notes, createdAt: createdAt || nowIso(), lastAuditAt, items: {}, evidence: {},
  };
}
export function makeFlag({ id, siteId, text, severity = 'medium', tag = '', createdAt } = {}) {
  return { id: id || uid('f'), siteId, text: String(text || '').trim(), severity, tag, resolved: false, createdAt: createdAt || nowIso(), resolvedAt: null };
}
export function makeFixReq({ id, siteId, itemId, priority = 'p1', note = '', status = 'pending', requestedAt } = {}) {
  const at = requestedAt || nowIso();
  return { id: id || uid('r'), siteId, itemId, priority, note: String(note || '').trim(), status, requestedAt: at, updatedAt: at };
}
export function makeLog({ siteId = null, kind = 'system', text, at }) {
  return { id: uid('l'), siteId, at: at || nowIso(), kind, text };
}

/* ---------- reducer ---------- */
const MAX_LOG = 2000;

function pushLog(s, entry) {
  s.log.unshift(makeLog(entry));
  if (s.log.length > MAX_LOG) s.log.length = MAX_LOG;
}

export function reduce(prev, action) {
  const s = structuredClone(prev);
  const p = action.payload || {};
  const at = p.at || nowIso();

  switch (action.type) {
    case 'theme/set':
      s.theme = p.theme ?? null;
      return s;

    case 'agency/update':
      Object.assign(s.agency, p.patch || {});
      return s;

    case 'client/add':
      s.clients[p.client.id] = p.client;
      pushLog(s, { kind: 'client', text: `Client account created — ${p.client.name}`, at });
      return s;

    case 'client/update':
      if (s.clients[p.id]) Object.assign(s.clients[p.id], p.patch || {});
      return s;

    case 'client/remove': {
      const client = s.clients[p.id];
      if (!client) return s;
      const siteIds = Object.values(s.sites).filter(x => x.clientId === p.id).map(x => x.id);
      for (const sid of siteIds) removeSite(s, sid);
      delete s.clients[p.id];
      pushLog(s, { kind: 'client', text: `Client account removed — ${client.name}`, at });
      return s;
    }

    case 'site/add':
      s.sites[p.site.id] = p.site;
      pushLog(s, { siteId: p.site.id, kind: 'site', text: `Site added — ${p.site.name} (${p.site.domain || 'no domain'}) on ${p.site.platform}${p.site.connector ? ' · ' + p.site.connector : ' · no connector yet'}`, at });
      return s;

    case 'site/update':
      if (s.sites[p.id]) Object.assign(s.sites[p.id], p.patch || {});
      return s;

    case 'site/remove':
      removeSite(s, p.id);
      return s;

    case 'item/set': {
      const site = s.sites[p.siteId];
      if (!site) return s;
      const wasState = stateOf(site.items, p.itemId);
      setItem(site, p.itemId, p.state, at);
      if (wasState !== p.state) {
        const verb = p.state === 'done' ? 'marked done' : (p.state === 'na' ? 'marked not applicable' : 'reopened');
        pushLog(s, { siteId: site.id, kind: 'item', text: `${p.itemId} ${verb} — ${itemLabel(p.itemId)}`, at });
        // A done item closes any open fix request for it.
        if (p.state === 'done') {
          for (const r of Object.values(s.fixReqs)) {
            if (r.siteId === site.id && r.itemId === p.itemId && r.status !== 'done') {
              r.status = 'done'; r.updatedAt = at;
              pushLog(s, { siteId: site.id, kind: 'fix', text: `Fix request ${r.id.slice(-4)} for ${p.itemId} closed — item verified done`, at });
            }
          }
        }
      }
      return s;
    }

    case 'evidence/set': {
      const site = s.sites[p.siteId];
      if (!site) return s;
      site.evidence = site.evidence || {};
      const ev = site.evidence[p.itemId] || { checkedAt: at, url: '' };
      ev.url = String(p.url || '').trim();
      site.evidence[p.itemId] = ev;
      pushLog(s, { siteId: site.id, kind: 'evidence', text: `Evidence ${ev.url ? 'attached to' : 'cleared from'} ${p.itemId}${ev.url ? ' — ' + ev.url : ''}`, at });
      return s;
    }

    case 'flag/add':
      s.flags[p.flag.id] = p.flag;
      pushLog(s, { siteId: p.flag.siteId, kind: 'flag', text: `Flag raised (${p.flag.severity}) — ${p.flag.text}`, at });
      return s;

    case 'flag/resolve': {
      const f = s.flags[p.id];
      if (!f) return s;
      f.resolved = !!p.resolved;
      f.resolvedAt = f.resolved ? at : null;
      pushLog(s, { siteId: f.siteId, kind: 'flag', text: `Flag ${f.resolved ? 'resolved' : 'reopened'} — ${f.text}`, at });
      return s;
    }

    case 'flag/update':
      if (s.flags[p.id]) Object.assign(s.flags[p.id], p.patch || {});
      return s;

    case 'flag/remove': {
      const f = s.flags[p.id];
      if (!f) return s;
      delete s.flags[p.id];
      pushLog(s, { siteId: f.siteId, kind: 'flag', text: `Flag deleted — ${f.text}`, at });
      return s;
    }

    case 'fix/add':
      s.fixReqs[p.req.id] = p.req;
      pushLog(s, { siteId: p.req.siteId, kind: 'fix', text: `Fix requested (${p.req.priority.toUpperCase()}) for ${p.req.itemId} — ${itemLabel(p.req.itemId)}${p.req.note ? ' · "' + p.req.note + '"' : ''}`, at });
      return s;

    case 'fix/status': {
      const r = s.fixReqs[p.id];
      if (!r || r.status === p.status) return s;
      r.status = p.status; r.updatedAt = at;
      pushLog(s, { siteId: r.siteId, kind: 'fix', text: `${r.itemId} fix → ${statusLabel(p.status)} — ${itemLabel(r.itemId)}`, at });
      // Closing a fix verifies the item.
      if (p.status === 'done') {
        const site = s.sites[r.siteId];
        if (site && stateOf(site.items, r.itemId) !== 'done') {
          setItem(site, r.itemId, 'done', at);
          pushLog(s, { siteId: r.siteId, kind: 'item', text: `${r.itemId} marked done — verified via fix request`, at });
        }
      }
      return s;
    }

    case 'fix/priority': {
      const r = s.fixReqs[p.id];
      if (r) { r.priority = p.priority; r.updatedAt = at; }
      return s;
    }

    case 'fix/remove': {
      const r = s.fixReqs[p.id];
      if (!r) return s;
      delete s.fixReqs[p.id];
      pushLog(s, { siteId: r.siteId, kind: 'fix', text: `Fix request for ${r.itemId} cancelled`, at });
      return s;
    }

    case 'audit/record': {
      const site = s.sites[p.siteId];
      if (!site) return s;
      site.lastAuditAt = at;
      pushLog(s, { siteId: site.id, kind: 'audit', text: p.text || `Audit recorded — checklist reviewed against all ${CHECKLIST.reduce((n, c) => n + c.items.length, 0)} items`, at });
      return s;
    }

    case 'log/add':
      pushLog(s, { siteId: p.siteId ?? null, kind: p.kind || 'system', text: p.text, at });
      return s;

    case 'state/replace':
      return migrate(p.state) || emptyState();

    default:
      return s;
  }
}

function setItem(site, itemId, state, at) {
  site.items = site.items || {};
  site.evidence = site.evidence || {};
  if (state === 'done' || state === 'na') site.items[itemId] = state; else delete site.items[itemId];
  if (state === 'done') {
    const ev = site.evidence[itemId] || { url: '' };
    ev.checkedAt = ev.checkedAt || at;
    site.evidence[itemId] = ev;
  } else {
    delete site.evidence[itemId];
  }
}

function removeSite(s, siteId) {
  const site = s.sites[siteId];
  if (!site) return;
  for (const [id, f] of Object.entries(s.flags)) if (f.siteId === siteId) delete s.flags[id];
  for (const [id, r] of Object.entries(s.fixReqs)) if (r.siteId === siteId) delete s.fixReqs[id];
  s.log = s.log.filter(e => e.siteId !== siteId);
  delete s.sites[siteId];
  pushLog(s, { kind: 'site', text: `Site removed — ${site.name}` });
}

function statusLabel(st) {
  return { pending: 'queued', in_progress: 'in progress', blocked: 'blocked', waiting: 'waiting on client', done: 'done' }[st] || st;
}

/* ---------- migration / validation ---------- */
export function migrate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.version !== SCHEMA_VERSION) return null;      // unknown shape: caller falls back to seed
  const base = emptyState();
  const s = {
    ...base, ...raw,
    agency: { ...base.agency, ...(raw.agency || {}) },
    clients: raw.clients || {}, sites: raw.sites || {}, flags: raw.flags || {}, fixReqs: raw.fixReqs || {},
    log: Array.isArray(raw.log) ? raw.log : [],
  };
  for (const site of Object.values(s.sites)) { site.items = site.items || {}; site.evidence = site.evidence || {}; }
  return s;
}

/* ---------- store ---------- */
/**
 * `lazy: true` defers loading until `store.start()` — the app uses it so nothing is fetched before
 * sign-in has produced a token. A load that FAILS (network, 401, 500) is rethrown, never papered over
 * with the seed: seeding persists a full `state/replace`, which against the API backend would
 * overwrite the agency's real data with demo data. Only a load that succeeds and finds nothing seeds.
 */
export function createStore({ adapter, seed, lazy = false }) {
  let state = emptyState();
  const subs = new Set();
  let flushed = Promise.resolve();
  let ready = null;

  const load = async () => {
    const loaded = migrate(await adapter.load());       // throws on failure — the caller shows why
    if (loaded) { state = loaded; return; }
    state = seed ? seed() : emptyState();
    // Pull anything the old mock UI saved (theme + clients typed into it), then persist the new shape.
    const legacy = adapter.loadLegacy ? adapter.loadLegacy() : null;
    if (legacy) {
      if (legacy.theme === 'light' || legacy.theme === 'dark') state.theme = legacy.theme;
      for (const c of legacy.extraClients) {
        if (!c || !c.name) continue;
        const client = makeClient({ name: c.name, contact: c.contact, plan: c.plan });
        state = reduce(state, { type: 'client/add', payload: { client } });
        const site = makeSite({ clientId: client.id, name: c.name, platform: c.platform && !/no connector/i.test(c.platform) ? c.platform : 'Other' });
        state = reduce(state, { type: 'site/add', payload: { site } });
      }
    }
    await adapter.persist(state, { type: 'state/replace', payload: { state } });
  };
  function start() {
    if (!ready) {
      ready = load();
      ready.then(() => { if (typeof adapter.watch === 'function') adapter.watch(a => store.applyRemote(a)); }, () => {});
    }
    return ready;
  }

  function notify() { for (const fn of subs) { try { fn(state); } catch (e) { console.error(e); } } }

  const store = {
    get state() { return state; },
    get ready() { return start(); },
    start,
    adapter,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    dispatch(type, payload) {
      const action = { type, payload };
      state = reduce(state, action);
      flushed = flushed.then(() => adapter.persist(state, action)).catch(e => console.error('[rankops] persist failed', e));
      notify();
      return state;
    },
    /** Resolves once every dispatched action so far has been handed to the adapter. */
    flush() { return flushed; },
    /** Apply an action that already happened elsewhere (another user, via the API adapter). Not persisted. */
    applyRemote(action) { state = reduce(state, action); notify(); },
  };
  if (!lazy) start();
  return store;
}
