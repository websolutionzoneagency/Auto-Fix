import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKLIST, TOTAL_ITEMS, CRITICAL } from '../js/checklist.js';
import { nextItemState, stateOf, pctFor, catStats, openCritCount, healthFor, flagCounts, sortFixReqs, columnOf, escapeHtml, relTime, clientSummary, fleetSummary } from '../js/model.js';
import { emptyState, reduce, makeClient, makeSite, makeFlag, makeFixReq, migrate, createStore } from '../js/store.js';
import { demoState } from '../js/seed.js';

test('checklist template is intact', () => {
  assert.equal(CHECKLIST.length, 20);
  assert.equal(TOTAL_ITEMS, 208);
  assert.equal(CRITICAL.size, 14);
  const ids = CHECKLIST.flatMap(c => c.items.map(i => i.id));
  assert.equal(new Set(ids).size, ids.length, 'item ids are unique');
});

test('item state cycles pending → done → na → pending', () => {
  assert.equal(nextItemState('pending'), 'done');
  assert.equal(nextItemState('done'), 'na');
  assert.equal(nextItemState('na'), 'pending');
  assert.equal(stateOf({}, 'f1'), 'pending');
  assert.equal(stateOf({ f1: 'garbage' }, 'f1'), 'pending');
});

test('completion ignores n/a items', () => {
  const items = { f1: 'done', f2: 'na' };
  const cat = CHECKLIST[0]; // found, 9 items
  const s = catStats(items, cat);
  assert.deepEqual({ done: s.done, applicable: s.applicable, na: s.na }, { done: 1, applicable: 8, na: 1 });
  assert.equal(s.pct, 13);
});

test('health = pct − 6·openCrit − 8·high − 3·medium, floored at 0', () => {
  const items = {};
  for (const c of CHECKLIST) for (const it of c.items) items[it.id] = 'done';   // 100%
  assert.equal(openCritCount(items), 0);
  const site = { items };
  assert.equal(healthFor(site, []), 100);
  delete items.f7; delete items.f4;                                             // two critical items reopened
  assert.equal(openCritCount(items), 2);
  const flags = [{ severity: 'high' }, { severity: 'medium' }, { severity: 'medium', resolved: true }];
  assert.equal(flagCounts(flags).open, 2);
  assert.equal(healthFor(site, flags), Math.round(pctFor(items)) - 12 - 8 - 3);
  const junk = { items: {} };
  assert.equal(healthFor(junk, Array(20).fill({ severity: 'high' })), 0);
});

test('fix requests sort: open before done, then P0 > P1 > P2, then newest', () => {
  const list = [
    { id: 'a', status: 'done', priority: 'p0', requestedAt: '2026-01-03' },
    { id: 'b', status: 'pending', priority: 'p2', requestedAt: '2026-01-01' },
    { id: 'c', status: 'pending', priority: 'p0', requestedAt: '2026-01-01' },
    { id: 'd', status: 'pending', priority: 'p0', requestedAt: '2026-01-02' },
  ];
  assert.deepEqual(sortFixReqs(list).map(r => r.id), ['d', 'c', 'b', 'a']);
  assert.equal(columnOf('blocked'), 'progress');
  assert.equal(columnOf('waiting'), 'progress');
  assert.equal(columnOf('nonsense'), 'pending');
});

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml('<img src=x onerror="a">&\''), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
});

test('relTime', () => {
  const now = Date.parse('2026-09-20T12:00:00Z');
  assert.equal(relTime('2026-09-20T11:59:50Z', now), 'just now');
  assert.equal(relTime('2026-09-20T09:00:00Z', now), '3h ago');
  assert.equal(relTime('2026-09-17T12:00:00Z', now), '3d ago');
});

test('reducer: item done closes its open fix request; fix done marks item done', () => {
  let s = emptyState();
  const client = makeClient({ id: 'c1', name: 'Acme' });
  s = reduce(s, { type: 'client/add', payload: { client } });
  const site = makeSite({ id: 's1', clientId: 'c1', name: 'Acme', domain: 'https://www.acme.com/shop' });
  assert.equal(site.domain, 'acme.com');
  s = reduce(s, { type: 'site/add', payload: { site } });
  s = reduce(s, { type: 'fix/add', payload: { req: makeFixReq({ id: 'r1', siteId: 's1', itemId: 'f1', priority: 'p2' }) } });
  s = reduce(s, { type: 'item/set', payload: { siteId: 's1', itemId: 'f1', state: 'done' } });
  assert.equal(s.fixReqs.r1.status, 'done');
  assert.equal(s.fixReqs.r1.priority, 'p2', 'priority is preserved');
  s = reduce(s, { type: 'fix/add', payload: { req: makeFixReq({ id: 'r2', siteId: 's1', itemId: 'f2' }) } });
  s = reduce(s, { type: 'fix/status', payload: { id: 'r2', status: 'done' } });
  assert.equal(stateOf(s.sites.s1.items, 'f2'), 'done');
  assert.ok(s.sites.s1.evidence.f2.checkedAt);
  s = reduce(s, { type: 'item/set', payload: { siteId: 's1', itemId: 'f2', state: 'pending' } });
  assert.equal(s.sites.s1.evidence.f2, undefined, 'evidence cleared when reopened');
  assert.ok(s.log.length >= 6, 'every mutation wrote to the audit log');
  s = reduce(s, { type: 'client/remove', payload: { id: 'c1' } });
  assert.deepEqual(Object.keys(s.sites), []);
  assert.deepEqual(Object.keys(s.fixReqs), []);
});

test('reducer does not mutate previous state', () => {
  const s0 = demoState();
  const json = JSON.stringify(s0);
  reduce(s0, { type: 'item/set', payload: { siteId: 's_vapewizard', itemId: 'f1', state: 'na' } });
  assert.equal(JSON.stringify(s0), json);
});

test('demo seed is coherent and deterministic', () => {
  const a = demoState(), b = demoState();
  assert.equal(Object.keys(a.clients).length, 4);
  assert.equal(Object.keys(a.sites).length, 4);
  // Timestamps are relative to "now" and log ids are random; everything else must match exactly.
  const strip = s => JSON.stringify(s).replace(/"\d{4}-\d{2}-\d{2}T[^"]+"/g, '"<t>"').replace(/"l_[a-z0-9]+"/g, '"<l>"');
  assert.equal(strip(a), strip(b));
  const vw = clientSummary(a, 'c_vapewizard');
  assert.equal(vw.flags.high, 1);
  assert.equal(vw.flags.open, 4);
  assert.ok(vw.health > 0 && vw.health < 100);
  const fleet = fleetSummary(a);
  assert.equal(fleet.sites, 4);
  assert.equal(fleet.reqDone30d, 3);
  assert.equal(fleet.reqAttention, 2);
});

test('migrate rejects foreign shapes, accepts its own', () => {
  assert.equal(migrate(null), null);
  assert.equal(migrate({ extraClients: [] }), null);
  const s = demoState();
  assert.equal(migrate(JSON.parse(JSON.stringify(s))).version, 2);
});

test('store: a lazy store loads nothing until start(), and a failed load is never replaced by the seed', async () => {
  let loads = 0;
  const written = [];
  const failing = { async load() { loads++; throw new Error('missing bearer token'); }, async persist(_s, a) { written.push(a.type); } };
  const store = createStore({ adapter: failing, seed: emptyState, lazy: true });
  assert.equal(loads, 0);                                   // nothing fetched before sign-in
  await assert.rejects(store.start(), /missing bearer token/);
  assert.equal(loads, 1);
  assert.deepEqual(written, []);                            // the demo seed was NOT saved over the real data
});

test('store: legacy v1 clients are imported once, persist is called', async () => {
  const written = [];
  const adapter = {
    async load() { return null; },
    async persist(state, action) { written.push(action.type); },
    loadLegacy() { return { theme: 'dark', extraClients: [{ name: 'Old Co', contact: 'x', platform: 'Shopify', plan: 'Starter' }] }; },
  };
  const store = createStore({ adapter, seed: emptyState });
  await store.ready;
  assert.equal(store.state.theme, 'dark');
  assert.equal(Object.values(store.state.clients)[0].name, 'Old Co');
  assert.equal(Object.values(store.state.sites)[0].platform, 'Shopify');
  store.dispatch('theme/set', { theme: 'light' });
  await store.flush();
  assert.deepEqual(written, ['state/replace', 'theme/set']);
});
