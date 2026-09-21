// Pure functions over the RankOps state. No DOM, no storage — safe to unit test in Node.
import { CHECKLIST, ITEM_INDEX } from './checklist.js';

/* ---------- checklist item states ---------- */
export const ITEM_STATES = ['pending', 'done', 'na'];

export function nextItemState(state) {
  const i = ITEM_STATES.indexOf(state);
  return ITEM_STATES[(i + 1) % ITEM_STATES.length];
}

/** Only 'done' and 'na' are stored; anything else is pending. */
export function stateOf(items, id) {
  const s = items && items[id];
  return s === 'done' || s === 'na' ? s : 'pending';
}

export function catStats(items, cat) {
  let done = 0, applicable = 0, na = 0;
  for (const it of cat.items) {
    const st = stateOf(items, it.id);
    if (st === 'na') { na++; continue; }
    applicable++;
    if (st === 'done') done++;
  }
  return { done, applicable, na, total: cat.items.length, pct: applicable ? Math.round((done / applicable) * 100) : 0 };
}

export function pctFor(items) {
  let done = 0, applicable = 0;
  for (const cat of CHECKLIST) {
    const s = catStats(items, cat);
    done += s.done; applicable += s.applicable;
  }
  return applicable ? Math.round((done / applicable) * 100) : 0;
}

export function countDone(items) {
  let done = 0;
  for (const cat of CHECKLIST) done += catStats(items, cat).done;
  return done;
}

export function openCritCount(items) {
  let n = 0;
  for (const cat of CHECKLIST) for (const it of cat.items) {
    if (it.crit && stateOf(items, it.id) === 'pending') n++;
  }
  return n;
}

/* ---------- flags ---------- */
export const SEVERITIES = ['high', 'medium', 'low'];

export function flagCounts(flags) {
  const c = { high: 0, medium: 0, low: 0, open: 0, resolved: 0 };
  for (const f of flags) {
    if (f.resolved) { c.resolved++; continue; }
    c.open++;
    if (f.severity in c) c[f.severity]++;
  }
  return c;
}

/**
 * Health = checklist completion %, minus 6 per open critical item, 8 per open high flag,
 * 3 per open medium flag. Same formula as the Fleet SEO Tracker.
 */
export function healthFor(site, siteFlags) {
  const pct = pctFor(site.items);
  const crit = openCritCount(site.items);
  const f = flagCounts(siteFlags);
  return Math.max(0, Math.round(pct - crit * 6 - f.high * 8 - f.medium * 3));
}

export function scoreBand(score) { return score >= 80 ? '' : (score >= 65 ? 'mid' : 'low'); }

/* ---------- fix requests ---------- */
export const REQ_STATUS = {
  pending:     { label: 'Queued',            col: 'pending',  cls: 'pending' },
  in_progress: { label: 'In progress',       col: 'progress', cls: 'progress' },
  blocked:     { label: 'Blocked',           col: 'progress', cls: 'gap' },
  waiting:     { label: 'Waiting on client', col: 'progress', cls: 'medium' },
  done:        { label: 'Done',              col: 'done',     cls: 'done' },
};
export const REQ_STATUS_ORDER = ['pending', 'in_progress', 'blocked', 'waiting', 'done'];
export const REQ_COLUMNS = [
  { id: 'pending',  label: 'Queued' },
  { id: 'progress', label: 'In progress' },
  { id: 'done',     label: 'Done' },
];
export const PRIORITIES = ['p0', 'p1', 'p2'];
export const PRIO_ORDER = { p0: 0, p1: 1, p2: 2 };

export function reqStatusMeta(status) { return REQ_STATUS[status] || REQ_STATUS.pending; }
export function columnOf(status) { return reqStatusMeta(status).col; }

export function sortFixReqs(list) {
  return [...list].sort((a, b) =>
    ((a.status === 'done') - (b.status === 'done')) ||
    ((PRIO_ORDER[a.priority] ?? 1) - (PRIO_ORDER[b.priority] ?? 1)) ||
    String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')));
}

/* ---------- selectors (read-only views over state) ---------- */
export function sitesOfClient(state, clientId) {
  return Object.values(state.sites).filter(s => s.clientId === clientId);
}
export function flagsOfSite(state, siteId) {
  return Object.values(state.flags).filter(f => f.siteId === siteId);
}
export function fixReqsOfSite(state, siteId) {
  return Object.values(state.fixReqs).filter(r => r.siteId === siteId);
}
export function logOfSite(state, siteId) {
  return state.log.filter(e => e.siteId === siteId);
}
export function openFlags(state) {
  return Object.values(state.flags).filter(f => !f.resolved);
}
export function siteHealth(state, siteId) {
  const site = state.sites[siteId];
  return site ? healthFor(site, flagsOfSite(state, siteId)) : 0;
}
export function lastActivity(state, siteIds) {
  let latest = '';
  for (const e of state.log) if (siteIds.includes(e.siteId) && e.at > latest) latest = e.at;
  return latest || null;
}

/** Everything the client tables need, computed from the site rows. */
export function clientSummary(state, clientId) {
  const client = state.clients[clientId];
  const sites = sitesOfClient(state, clientId);
  const ids = sites.map(s => s.id);
  const flags = Object.values(state.flags).filter(f => ids.includes(f.siteId));
  const fc = flagCounts(flags);
  const healths = sites.map(s => healthFor(s, flags.filter(f => f.siteId === s.id)));
  const health = healths.length ? Math.round(healths.reduce((a, b) => a + b, 0) / healths.length) : 0;
  const platforms = [...new Set(sites.map(s => s.platform))];
  return {
    client, sites, health, flags: fc, platforms,
    lastActivity: lastActivity(state, ids) || client.createdAt,
    attention: fc.high * 100 + fc.medium * 10 + (100 - health),   // higher = needs attention sooner
  };
}

export function fleetSummary(state) {
  const sites = Object.values(state.sites);
  const healths = sites.map(s => siteHealth(state, s.id));
  const reqs = Object.values(state.fixReqs);
  const cutoff = Date.now() - 30 * 86400000;
  const open = openFlags(state);
  return {
    clients: Object.keys(state.clients).length,
    sites: sites.length,
    avgHealth: healths.length ? Math.round(healths.reduce((a, b) => a + b, 0) / healths.length) : 0,
    noConnector: sites.filter(s => !s.connector).length,
    flags: flagCounts(open),
    reqActive: reqs.filter(r => r.status !== 'done').length,
    reqPending: reqs.filter(r => r.status === 'pending').length,
    reqWorking: reqs.filter(r => r.status === 'in_progress').length,
    reqAttention: reqs.filter(r => r.status === 'blocked' || r.status === 'waiting').length,
    reqDone30d: reqs.filter(r => r.status === 'done' && r.updatedAt && new Date(r.updatedAt).getTime() >= cutoff).length,
  };
}

/* ---------- small utilities ---------- */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

export function uid(prefix = 'id') {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rnd}`;
}

export function nowIso() { return new Date().toISOString(); }

export function daysSince(iso, now = Date.now()) {
  if (!iso) return null;
  const d = (now - new Date(iso).getTime()) / 86400000;
  return Number.isNaN(d) ? null : Math.floor(d);
}

export function relTime(iso, now = Date.now()) {
  if (!iso) return '—';
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24); if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30); if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

export function fmtClock(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function fmtDate(iso) { return iso ? String(iso).slice(0, 10) : '—'; }

export function itemLabel(id) { const hit = ITEM_INDEX.get(id); return hit ? hit.item.label : id; }
export function itemCat(id) { const hit = ITEM_INDEX.get(id); return hit ? hit.cat : null; }

export function normalizeDomain(input) {
  return String(input || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
}
