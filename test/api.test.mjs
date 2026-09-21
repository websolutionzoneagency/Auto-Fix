// Exercises the serverless API handler against an in-memory stand-in for Postgres:
// auth, routing, server-side reducer folding, replay for other tabs, import/replace and wipe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/[...path].js';
import { demoState } from '../js/seed.js';
import { makeClient, makeSite } from '../js/store.js';

process.env.RANKOPS_API_TOKEN = 'secret-token';

function fakeDb() {
  const mem = { snapshot: null, actions: [] };
  const client = {
    async query(sql, params = []) {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
      if (sql.startsWith('INSERT INTO agencies')) return { rows: [] };
      if (sql.startsWith('SELECT seq, state FROM snapshots')) return { rows: mem.snapshot ? [mem.snapshot] : [] };
      if (sql.startsWith('INSERT INTO actions')) { mem.actions.push({ seq: params[1], origin: params[2], action: params[3] }); return { rows: [] }; }
      if (sql.startsWith('INSERT INTO snapshots')) { mem.snapshot = { seq: params[1], state: JSON.parse(JSON.stringify(params[2])) }; return { rows: [] }; }
      if (sql.startsWith('SELECT seq, origin, action FROM actions')) return { rows: mem.actions.filter(a => a.seq > params[1]).slice(0, params[2]) };
      if (sql.startsWith('SELECT seq FROM snapshots')) return { rows: mem.snapshot ? [{ seq: mem.snapshot.seq }] : [] };
      if (sql.startsWith('DELETE FROM actions')) { mem.actions = []; return { rows: [] }; }
      if (sql.startsWith('DELETE FROM snapshots')) { mem.snapshot = null; return { rows: [] }; }
      throw new Error('unexpected SQL in test: ' + sql.slice(0, 60));
    },
    release() {},
  };
  return { mem, deps: { getPool: async () => client, withTx: async (fn) => fn(client) } };
}

function call(deps, method, path, { body, token = 'secret-token', query = {} } = {}) {
  const req = { method, query: { path: path.split('/').filter(Boolean), ...query }, headers: token ? { authorization: 'Bearer ' + token } : {}, body };
  return new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { resolve({ status: this.statusCode, body: b ? JSON.parse(b) : null }); } };
    handler(req, res, deps);
  });
}

test('health is public; everything else needs the bearer token', async () => {
  const { deps } = fakeDb();
  assert.equal((await call(deps, 'GET', '/health', { token: null })).status, 200);
  assert.equal((await call(deps, 'GET', '/state', { token: null })).status, 401);
  assert.equal((await call(deps, 'GET', '/state', { token: 'wrong' })).status, 401);
  assert.equal((await call(deps, 'GET', '/nope')).status, 404);
});

test('actions fold through the shared reducer and replay to other tabs', async () => {
  const { deps, mem } = fakeDb();
  let r = await call(deps, 'GET', '/state');
  assert.deepEqual(r.body, { seq: 0, state: null });

  const client = makeClient({ id: 'c1', name: 'Acme' });
  const site = makeSite({ id: 's1', clientId: 'c1', name: 'Acme', domain: 'acme.com' });
  r = await call(deps, 'POST', '/actions', { body: { action: { type: 'client/add', payload: { client } }, origin: 'tabA' } });
  assert.deepEqual(r.body, { seq: 1 });
  r = await call(deps, 'POST', '/actions', { body: { action: { type: 'site/add', payload: { site } }, origin: 'tabA' } });
  r = await call(deps, 'POST', '/actions', { body: { action: { type: 'item/set', payload: { siteId: 's1', itemId: 'f7', state: 'done' } }, origin: 'tabB' } });
  assert.equal(r.body.seq, 3);

  r = await call(deps, 'GET', '/state');
  assert.equal(r.body.seq, 3);
  assert.equal(r.body.state.sites.s1.items.f7, 'done', 'server applied the same reducer the browser runs');
  assert.ok(r.body.state.log.some(e => e.text.startsWith('f7 marked done')), 'audit log written server-side');

  r = await call(deps, 'GET', '/actions', { query: { since: '1' } });
  assert.deepEqual(r.body.actions.map(a => [a.seq, a.origin, a.action.type]), [[2, 'tabA', 'site/add'], [3, 'tabB', 'item/set']]);
  assert.equal(mem.actions.length, 3);

  r = await call(deps, 'POST', '/actions', { body: { nope: true } });
  assert.equal(r.status, 400);
});

test('PUT /state validates and replaces; DELETE wipes', async () => {
  const { deps } = fakeDb();
  let r = await call(deps, 'PUT', '/state', { body: { state: { extraClients: [] } } });
  assert.equal(r.status, 400);
  r = await call(deps, 'PUT', '/state', { body: { state: demoState(), origin: 'tabA' } });
  assert.equal(r.body.seq, 1);
  r = await call(deps, 'GET', '/state');
  assert.equal(Object.keys(r.body.state.clients).length, 4);
  r = await call(deps, 'DELETE', '/state');
  assert.equal(r.status, 204);
  r = await call(deps, 'GET', '/state');
  assert.deepEqual(r.body, { seq: 0, state: null });
});
