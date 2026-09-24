// End-to-end through the real API handler, a real Postgres with the Supabase schema, and the mock
// WordPress site: connect → scan → findings → plan → apply → verify on the site → revert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { TEST_URL, freshTestDatabase } from './helpers/test-db.mjs';
import { startMockWp, defaultFixture } from './helpers/mock-wp.mjs';
import { signSupabaseJwt } from '../api/_lib/auth.js';
import { demoState } from '../js/seed.js';

const skip = !TEST_URL;
let db, wp, handler, pool;
const TOKEN = 'static-test-token';
const JWT_SECRET = 'jwt-secret-for-tests';

test.before(async () => {
  if (skip) return;
  db = await freshTestDatabase();
  process.env.DATABASE_URL = db.url;
  process.env.PGSSL = 'disable';
  process.env.RANKOPS_API_TOKEN = TOKEN;
  process.env.RANKOPS_AGENCY_ID = 'a0000000-0000-0000-0000-00000000000a';
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
  process.env.CRON_SECRET = 'cron-secret';
  process.env.INLINE_SCAN_BUDGET_MS = '30000';
  ({ default: handler } = await import('../api/index.js'));
  ({ getPool: pool } = await import('../api/_lib/db.js'));
  wp = await startMockWp(defaultFixture());
});
test.after(async () => {
  if (skip) return;
  await wp.close();
  await (await pool()).end();
  await db.drop();
});

function call(method, path, { body, token = TOKEN, headers = {} } = {}) {
  const url = new URL('http://x' + path);
  const req = { method, query: { path: url.pathname.split('/').filter(Boolean), ...Object.fromEntries(url.searchParams) },
                headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body };
  return new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { resolve({ status: this.statusCode, body: b ? JSON.parse(b) : null }); } };
    handler(req, res);
  });
}

test('auth: health public, everything else needs a token; /me reports mode', { skip }, async () => {
  assert.equal((await call('GET', '/health', { token: null })).status, 200);
  assert.equal((await call('GET', '/state', { token: null })).status, 401);
  assert.equal((await call('GET', '/state', { token: 'nope' })).status, 401);
  const me = await call('GET', '/me');
  assert.equal(me.body.mode, 'token');
  assert.equal(me.body.role, 'owner');
});

test('auth: a Supabase JWT resolves the caller through agency_members, and roles are enforced', { skip }, async () => {
  const p = await pool();
  const agency = 'b0000000-0000-0000-0000-00000000000b';
  const owner = '10000000-0000-0000-0000-000000000001', viewer = '10000000-0000-0000-0000-000000000002', outsider = '10000000-0000-0000-0000-000000000003';
  await p.query(`insert into auth.users (id) values ($1),($2),($3)`, [owner, viewer, outsider]);
  await p.query(`insert into agencies (id, name) values ($1, 'JWT Agency')`, [agency]);
  await p.query(`insert into agency_members values ($1,$2,'owner'),($1,$3,'viewer')`, [agency, owner, viewer]);

  const ownerTok = signSupabaseJwt({ sub: owner, email: 'o@x', exp: Math.floor(Date.now() / 1000) + 600 }, JWT_SECRET);
  const me = await call('GET', '/me', { token: ownerTok });
  assert.equal(me.body.mode, 'supabase'); assert.equal(me.body.agencyId, agency); assert.equal(me.body.role, 'owner');

  const viewerTok = signSupabaseJwt({ sub: viewer, exp: Math.floor(Date.now() / 1000) + 600 }, JWT_SECRET);
  assert.equal((await call('GET', '/state', { token: viewerTok })).status, 200, 'viewer can read');
  const w = await call('POST', '/actions', { token: viewerTok, body: { action: { type: 'theme/set', payload: { theme: 'dark' } } } });
  assert.equal(w.status, 403, 'viewer cannot write');

  const outTok = signSupabaseJwt({ sub: outsider, exp: Math.floor(Date.now() / 1000) + 600 }, JWT_SECRET);
  assert.equal((await call('GET', '/me', { token: outTok })).status, 401, 'no membership → rejected');
  const expired = signSupabaseJwt({ sub: owner, exp: Math.floor(Date.now() / 1000) - 5 }, JWT_SECRET);
  assert.equal((await call('GET', '/me', { token: expired })).status, 401, 'expired token rejected');
  const forged = signSupabaseJwt({ sub: owner, exp: Math.floor(Date.now() / 1000) + 600 }, 'wrong-secret');
  assert.equal((await call('GET', '/me', { token: forged })).status, 401, 'bad signature rejected');
});

test('console state round-trips through the same reducer', { skip }, async () => {
  let r = await call('GET', '/state');
  assert.deepEqual(r.body, { seq: 0, state: null });
  r = await call('PUT', '/state', { body: { state: demoState(), origin: 't' } });
  assert.equal(r.body.seq, 1);
  r = await call('POST', '/actions', { body: { action: { type: 'item/set', payload: { siteId: 's_vapewizard', itemId: 'f1', state: 'na' } }, origin: 't' } });
  assert.equal(r.body.seq, 2);
  r = await call('GET', '/state');
  assert.equal(r.body.state.sites.s_vapewizard.items.f1, 'na');
  // A full replace from a client that never loaded the data (no baseSeq) is refused once data exists.
  const blind = await call('PUT', '/state', { body: { state: demoState(), origin: 't' } });
  assert.equal(blind.status, 409);
  assert.equal((await call('GET', '/state')).body.state.sites.s_vapewizard.items.f1, 'na', 'nothing was overwritten');
  r = await call('GET', '/actions?since=1');
  assert.equal(r.body.actions.length, 1);
});

test('connection: validates, tests against the site, stores only ciphertext, never echoes the secret', { skip }, async () => {
  let r = await call('GET', '/sites/s_vapewizard/connection');
  assert.deepEqual(r.body, { connected: false });
  r = await call('GET', '/sites/nope/connection');
  assert.equal(r.status, 404);

  r = await call('PUT', '/sites/s_vapewizard/connection', { body: { platform: 'wordpress', baseUrl: wp.baseUrl, credentials: { username: 'ismail', appPassword: 'wrong' } } });
  assert.equal(r.status, 422, 'bad credentials are rejected at save time');
  assert.match(r.body.error, /Authentication failed/);

  r = await call('PUT', '/sites/s_vapewizard/connection', { body: {
    platform: 'wordpress', baseUrl: wp.baseUrl, credentials: wp.creds,
    settings: { legacyPrefixes: ['/shop/old-prefix/'], prefixReplacements: { '/shop/old-prefix/': '/product/' }, authorNames: { 1: 'Ismail Hossain' }, organizationName: 'Vape Wizard DXB', siteUrl: 'https://vapewizarddxb.com' },
  } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.connected, true);
  assert.equal(r.body.test.ok, true);
  assert.equal(r.body.seoPlugin, 'Rank Math');
  assert.equal(r.body.credentials, undefined, 'secret never returned');
  assert.ok(!JSON.stringify(r.body).includes('abcd efgh'), 'plaintext password never appears in a response');
  assert.match(r.body.credentialsMasked.appPassword, /^•+mnop$/);

  const { rows } = await (await pool()).query(`select credentials from site_connections`);
  assert.match(rows[0].credentials, /^v1\./);
  assert.ok(!rows[0].credentials.includes('abcd'), 'database holds ciphertext only');

  const state = (await call('GET', '/state')).body.state;
  assert.equal(state.sites.s_vapewizard.connector, 'WordPress · WooCommerce · Rank Math', 'the console label now reflects a real connection');
  assert.ok(state.log.some(e => /Connected to/.test(e.text)));
});

let failingCanonical, failingAlt, failingLegacy;
test('scan: runs inline, writes findings, and moves checklist items through the reducer', { skip }, async () => {
  const before = (await call('GET', '/state')).body.state.sites.s_vapewizard.items;
  const f9Before = before.f9, f2Before = before.f2;
  const r = await call('POST', '/sites/s_vapewizard/scan', { body: {} });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.job.status, 'done', 'a small site completes inside one request');
  assert.equal(r.body.job.ran.length, 25, 'every mapped check ran');

  const f = (await call('GET', '/sites/s_vapewizard/findings')).body.findings;
  const by = Object.fromEntries(f.map(x => [x.checkId, x]));
  assert.equal(by['author-identity'].verdict, 'fail');
  assert.equal(by['sitemap-submitted'].verdict, 'unknown', 'a live sitemap cannot prove Search Console submission');
  assert.equal(by['schema-organization'].verdict, 'fail');
  assert.equal(by['core-web-vitals'].verdict, 'unknown', 'no PSI key → unknown, not a false verdict');
  assert.equal(by['canonical'].tier, 'auto');
  assert.equal(by['broken-links'].tier, 'check');
  failingCanonical = by['canonical']; failingAlt = by['image-alt']; failingLegacy = by['legacy-links'];

  const state = (await call('GET', '/state')).body.state;
  const s = state.sites.s_vapewizard;
  assert.equal(s.items.f2, f2Before, 'f2 is left for a human: submission is only visible in Search Console');
  assert.notEqual(s.items.f7, 'done', 'canonical fail → f7 pending');
  assert.equal(s.items.f9, f9Before, 'unknown verdict leaves f9 exactly as a human left it');
  assert.ok(state.log.some(e => /Scan complete — 25 checks run/.test(e.text)));
  assert.ok(state.log.some(e => /f9 not checked — Needs a PageSpeed/.test(e.text)), 'unknown verdicts are explained in the log');
});

test('fix: plan is a dry run, apply writes + verifies, item flips, revert restores', { skip }, async () => {
  const before = wp.writes.length;
  let r = await call('POST', '/sites/s_vapewizard/fixes/plan', { body: { findingId: failingCanonical.id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.plan.ops.length >= 1);
  assert.equal(r.body.plan.dryRun, true);
  assert.equal(wp.writes.length, before, 'planning wrote nothing to the site');

  r = await call('POST', '/sites/s_vapewizard/fixes/apply', { body: { findingId: failingCanonical.id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.applied.length >= 1);
  assert.equal(r.body.failed.length, 0);
  assert.ok(wp.writes.length > before, 'apply wrote to the site');
  const post = wp.state.posts.find(p => p.id === 10);
  assert.match(post.meta.rank_math_canonical_url, /\/blog\/best-disposables\/$/);

  let state = (await call('GET', '/state')).body.state;
  assert.equal(state.sites.s_vapewizard.items.f7, 'done', 'successful fix marks the item done');

  const ops = (await call('GET', '/sites/s_vapewizard/fixes')).body.operations;
  assert.ok(ops.every(o => o.status === 'applied'));
  assert.ok(ops[0].before !== undefined, 'snapshot stored for rollback');

  r = await call('POST', '/sites/s_vapewizard/fixes/revert', { body: { opIds: ops.map(o => o.id) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.reverted.length, ops.length);
  assert.equal(wp.state.posts.find(p => p.id === 10).meta.rank_math_canonical_url, '', 'site restored');
  state = (await call('GET', '/state')).body.state;
  assert.notEqual(state.sites.s_vapewizard.items.f7, 'done', 'revert reopens the item');
  assert.equal((await call('GET', '/sites/s_vapewizard/fixes')).body.operations[0].status, 'reverted');
});

test('fix: legacy links use the stored prefix map; a check-only finding refuses to plan', { skip }, async () => {
  let r = await call('POST', '/sites/s_vapewizard/fixes/apply', { body: { findingId: failingLegacy.id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!wp.state.posts[0].content.includes('/shop/old-prefix/'));
  const findings = (await call('GET', '/sites/s_vapewizard/findings')).body.findings;
  const broken = findings.find(f => f.checkId === 'broken-links');
  r = await call('POST', '/sites/s_vapewizard/fixes/plan', { body: { findingId: broken.id } });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /no automatic fix/);
});

test('kill switch: paused site refuses apply and revert with 423', { skip }, async () => {
  let r = await call('POST', '/sites/s_vapewizard/pause', { body: { paused: true } });
  assert.equal(r.body.paused, true);
  r = await call('POST', '/sites/s_vapewizard/fixes/apply', { body: { findingId: failingAlt.id } });
  assert.equal(r.status, 423);
  assert.match(r.body.error, /paused/);
  r = await call('POST', '/sites/s_vapewizard/pause', { body: { paused: false } });
  assert.equal(r.body.paused, false);
  const state = (await call('GET', '/state')).body.state;
  assert.ok(state.log.some(e => /Writes PAUSED/.test(e.text)));
});

test('cron: drains queued work with the secret, rejects without it', { skip }, async () => {
  assert.equal((await call('GET', '/cron/scan', { token: null })).status, 401);
  assert.equal((await call('GET', '/cron/scan', { token: 'wrong' })).status, 401);
  // Queue a job but make the inline run do nothing so Cron has work.
  process.env.INLINE_SCAN_BUDGET_MS = '0';
  const r = await call('POST', '/sites/s_vapewizard/scan', { body: { checks: ['sitemap', 'author-identity'] } });
  assert.equal(r.body.job.status, 'queued');
  assert.equal(r.body.job.pending.length, 2, 'nothing ran inline');
  // Polling the job from the console continues it without Cron.
  process.env.INLINE_SCAN_BUDGET_MS = '30000';
  const polled = await call('GET', '/sites/s_vapewizard/scan');
  assert.equal(polled.body.job.status, 'done', 'GET /scan drained the queued job');
  assert.equal(polled.body.job.ran.length, 2);
  // Queue another and leave it for Cron.
  process.env.INLINE_SCAN_BUDGET_MS = '0';
  await call('POST', '/sites/s_vapewizard/scan', { body: { checks: ['sitemap', 'author-identity'] } });
  process.env.INLINE_SCAN_BUDGET_MS = '30000';
  const c = await call('GET', '/cron/scan', { token: 'cron-secret' });
  assert.equal(c.status, 200);
  assert.equal(c.body.jobs.length, 1);
  assert.equal(c.body.jobs[0].status, 'done');
  assert.equal(c.body.jobs[0].ran, 2);
  const again = await call('GET', '/cron/scan', { token: 'cron-secret' });
  assert.equal(again.body.jobs.length, 0, 'queue is empty');
});

test('a viewer cannot connect, pause, or scan', { skip }, async () => {
  const p = await pool();
  const agency = process.env.RANKOPS_AGENCY_ID, viewer = '10000000-0000-0000-0000-000000000009';
  await p.query(`insert into auth.users (id) values ($1)`, [viewer]);
  await p.query(`insert into agency_members values ($1,$2,'viewer')`, [agency, viewer]);
  const tok = signSupabaseJwt({ sub: viewer, exp: Math.floor(Date.now() / 1000) + 600 }, JWT_SECRET);
  assert.equal((await call('GET', '/sites/s_vapewizard/findings', { token: tok })).status, 200);
  assert.equal((await call('POST', '/sites/s_vapewizard/scan', { token: tok, body: {} })).status, 403);
  assert.equal((await call('POST', '/sites/s_vapewizard/pause', { token: tok, body: { paused: true } })).status, 403);
  assert.equal((await call('DELETE', '/sites/s_vapewizard/connection', { token: tok })).status, 403);
});
