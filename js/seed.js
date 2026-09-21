// Demo dataset for first run. Deterministic (no Math.random) so the demo looks the same everywhere,
// and built through the same reducer the UI uses so every number on screen derives from real state.
import { CHECKLIST } from './checklist.js';
import { emptyState, reduce, makeClient, makeSite, makeFlag, makeFixReq } from './store.js';

const H = 3600000, D = 86400000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// Small stable hash so "done" items are a fixed pseudo-random subset per site.
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % 100; }

function seedItems(state, site, { donePct, naCats = [], critPending = [], forceDone = [] }) {
  for (const cat of CHECKLIST) for (const it of cat.items) {
    let st = 'pending';
    if (naCats.includes(cat.id)) st = 'na';
    else if (forceDone.includes(it.id) || hash(site.id + it.id) < donePct) st = 'done';
    if (critPending.includes(it.id)) st = 'pending';
    if (st !== 'pending') state = reduce(state, { type: 'item/set', payload: { siteId: site.id, itemId: it.id, state: st, at: ago(2 * D + hash(it.id) * H) } });
  }
  return state;
}

export function demoState() {
  let s = emptyState();
  const add = (type, payload) => { s = reduce(s, { type, payload }); };

  /* ---- Vape Wizard DXB (the live example) ---- */
  const c1 = makeClient({ id: 'c_vapewizard', name: 'Vape Wizard DXB', contact: 'Ismail Hossain', plan: 'Growth', createdAt: ago(40 * D) });
  add('client/add', { client: c1, at: c1.createdAt });
  const s1 = makeSite({ id: 's_vapewizard', clientId: c1.id, name: 'Vape Wizard DXB', domain: 'vapewizarddxb.com', platform: 'WordPress', connector: 'WooCommerce · Rank Math', createdAt: ago(40 * D), lastAuditAt: ago(2 * H) });
  add('site/add', { site: s1, at: s1.createdAt });
  s = seedItems(s, s1, { donePct: 68, naCats: ['brandpage', 'catpage'], critPending: ['f4', 'cp1'], forceDone: ['f7', 't1', 't8', 'n1', 'n4', 'c7', 's7', 'm5', 'uc1', 'x1', 'a2', 'a7', 's9', 'a8'] });
  add('flag/add', { flag: makeFlag({ id: 'f_nic', siteId: s1.id, severity: 'high', tag: 'compliance', text: '73 products state a nicotine strength above the UAE 20mg/ml cap with no compliance disclosure — needs a read on whether the cap applies to sealed disposables before any listing changes.', createdAt: ago(5 * H) }), at: ago(5 * H) });
  add('flag/add', { flag: makeFlag({ id: 'f_brand', siteId: s1.id, severity: 'medium', tag: 'data-integrity', text: '"YOUTOTECH" is a fully-built brand page assigned to 0 real products — a stale duplicate of "Yuoto" (4 products). Needs a merge/redirect decision.', createdAt: ago(4 * H) }), at: ago(4 * H) });
  add('flag/add', { flag: makeFlag({ id: 'f_schema', siteId: s1.id, severity: 'medium', tag: 'schema-integrity', text: '34 products carry a manually-authored schema entry independent of page content; at least one is confirmed stale. Reconcile or remove?', createdAt: ago(1 * D) }), at: ago(1 * D) });
  add('flag/add', { flag: makeFlag({ id: 'f_authors', siteId: s1.id, severity: 'low', tag: 'E-E-A-T', text: 'Two admin accounts use non-professional display names in public author bylines.', createdAt: ago(3 * D) }), at: ago(3 * D) });
  add('fix/add', { req: makeFixReq({ id: 'r_t9', siteId: s1.id, itemId: 't9', priority: 'p1', requestedAt: ago(3 * H) }), at: ago(3 * H) });
  add('fix/add', { req: makeFixReq({ id: 'r_a5', siteId: s1.id, itemId: 'a5', priority: 'p1', requestedAt: ago(3 * H) }), at: ago(3 * H) });
  add('fix/add', { req: makeFixReq({ id: 'r_l5', siteId: s1.id, itemId: 'l5', priority: 'p2', note: 'Start with the disposables cluster', requestedAt: ago(2 * H) }), at: ago(2 * H) });
  add('fix/add', { req: makeFixReq({ id: 'r_f4', siteId: s1.id, itemId: 'f4', priority: 'p0', note: 'Blocked on the YOUTOTECH merge decision', requestedAt: ago(1 * D) }), at: ago(1 * D) });
  add('fix/status', { id: 'r_f4', status: 'blocked', at: ago(20 * H) });
  add('fix/add', { req: makeFixReq({ id: 'r_a8', siteId: s1.id, itemId: 'a8', priority: 'p1', requestedAt: ago(6 * H) }), at: ago(6 * H) });
  add('fix/status', { id: 'r_a8', status: 'in_progress', at: ago(1 * H) });
  for (const [id, item, when] of [['r_a2', 'a2', 2 * H], ['r_a7', 'a7', 3 * H], ['r_s9', 's9', 1 * D]]) {
    add('fix/add', { req: makeFixReq({ id, siteId: s1.id, itemId: item, priority: 'p1', requestedAt: ago(when + 2 * D) }), at: ago(when + 2 * D) });
    add('fix/status', { id, status: 'done', at: ago(when) });
  }
  add('evidence/set', { siteId: s1.id, itemId: 'a7', url: 'https://vapewizarddxb.com/?preferred-sources=1', at: ago(3 * H) });
  add('audit/record', { siteId: s1.id, at: ago(2 * H), text: 'Audit recorded — 41 footer/nav links HEAD-checked (all 200); FAQ block verified live on 4 sample brand pages' });

  /* ---- Loomcraft Studio (Shopify, no connector) ---- */
  const c2 = makeClient({ id: 'c_loomcraft', name: 'Loomcraft Studio', contact: 'R. Okafor', plan: 'Starter', createdAt: ago(21 * D) });
  add('client/add', { client: c2, at: c2.createdAt });
  const s2 = makeSite({ id: 's_loomcraft', clientId: c2.id, name: 'Loomcraft Studio', domain: 'loomcraft.studio', platform: 'Shopify', connector: '', createdAt: ago(21 * D), lastAuditAt: ago(1 * D) });
  add('site/add', { site: s2, at: s2.createdAt });
  s = seedItems(s, s2, { donePct: 52, naCats: ['comp', 'brandpage', 'catpage', 'topicalmap', 'xstore'], critPending: ['f4', 'l1'] });
  add('flag/add', { flag: makeFlag({ id: 'f_shopify', siteId: s2.id, severity: 'medium', tag: 'platform-gap', text: 'No Shopify connector authorised — 14 on-page recommendations are queued as written suggestions rather than live fixes.', createdAt: ago(1 * D) }), at: ago(1 * D) });
  add('fix/add', { req: makeFixReq({ id: 'r_loom_i1', siteId: s2.id, itemId: 'i1', priority: 'p1', requestedAt: ago(1 * D) }), at: ago(1 * D) });
  add('fix/status', { id: 'r_loom_i1', status: 'waiting', at: ago(20 * H) });
  add('audit/record', { siteId: s2.id, at: ago(1 * D) });

  /* ---- Northgate Dental Group ---- */
  const c3 = makeClient({ id: 'c_northgate', name: 'Northgate Dental Group', contact: 'Dr. S. Byrne', plan: 'Growth', createdAt: ago(90 * D) });
  add('client/add', { client: c3, at: c3.createdAt });
  const s3 = makeSite({ id: 's_northgate', clientId: c3.id, name: 'Northgate Dental Group', domain: 'northgatedental.co.uk', platform: 'WordPress', connector: 'Rank Math', createdAt: ago(90 * D), lastAuditAt: ago(6 * H) });
  add('site/add', { site: s3, at: s3.createdAt });
  s = seedItems(s, s3, { donePct: 93, naCats: ['comp', 'brandpage', 'catpage', 'newprod', 'rewrite', 'xstore'], forceDone: ['f7', 'f4', 't1', 't8', 'c7', 'l1', 's7', 'm5'] });
  add('flag/add', { flag: makeFlag({ id: 'f_sameas', siteId: s3.id, severity: 'low', tag: 'schema', text: 'Person schema has no sameAs — no real profile URLs exist yet. Add once they exist; not invented in the meantime.', createdAt: ago(6 * H) }), at: ago(6 * H) });
  add('audit/record', { siteId: s3.id, at: ago(6 * H) });

  /* ---- Bramfield & Cole Legal ---- */
  const c4 = makeClient({ id: 'c_bramfield', name: 'Bramfield & Cole Legal', contact: 'M. Bramfield', plan: 'Growth', createdAt: ago(60 * D) });
  add('client/add', { client: c4, at: c4.createdAt });
  const s4 = makeSite({ id: 's_bramfield', clientId: c4.id, name: 'Bramfield & Cole Legal', domain: 'bramfieldcole.com', platform: 'WordPress', connector: 'Rank Math', createdAt: ago(60 * D), lastAuditAt: ago(3 * D) });
  add('site/add', { site: s4, at: s4.createdAt });
  s = seedItems(s, s4, { donePct: 90, naCats: ['comp', 'brandpage', 'catpage', 'newprod', 'rewrite', 'xstore'], forceDone: ['f7', 'f4', 't1', 't8', 'c7', 'l1', 's7', 'm5'] });
  add('flag/add', { flag: makeFlag({ id: 'f_rating', siteId: s4.id, severity: 'medium', tag: 'unfabricatable-gap', text: 'aggregateRating schema absent — zero approved reviews exist. Cannot be added without fabricating reviews; revisit once real reviews accumulate.', createdAt: ago(3 * D) }), at: ago(3 * D) });
  add('audit/record', { siteId: s4.id, at: ago(3 * D) });

  s.log.sort((a, b) => b.at.localeCompare(a.at));
  return s;
}
