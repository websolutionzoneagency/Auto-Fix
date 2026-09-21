import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WordPressConnector, ConnectorError } from '../api/_lib/connectors/wordpress.js';
import { startMockWp, defaultFixture } from './helpers/mock-wp.mjs';

async function connect(fixture) {
  const wp = await startMockWp(fixture);
  return { wp, c: new WordPressConnector({ baseUrl: wp.baseUrl, ...wp.creds }) };
}

test('testConnection reports REST, auth, Woo, SEO plugin and companion plugin', async (t) => {
  const { wp, c } = await connect();
  t.after(() => wp.close());
  const r = await c.testConnection();
  assert.equal(r.ok, true);
  assert.equal(r.restOk, true);
  assert.equal(r.authOk, true);
  assert.equal(r.wooOk, true);
  assert.equal(r.seoPlugin, 'Rank Math');
  assert.equal(r.companionPlugin, true);
  assert.equal(r.user.name, 'Ismail Hossain');
  assert.deepEqual(r.errors, []);
});

test('bad credentials fail auth but still report REST reachable', async (t) => {
  const wp = await startMockWp();
  t.after(() => wp.close());
  const c = new WordPressConnector({ baseUrl: wp.baseUrl, username: 'ismail', appPassword: 'wrong' });
  const r = await c.testConnection();
  assert.equal(r.restOk, true);
  assert.equal(r.authOk, false);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /Authentication failed.*401/);
});

test('an unreachable REST API is reported, not thrown', async (t) => {
  const c = new WordPressConnector({ baseUrl: 'http://127.0.0.1:1', username: 'x', appPassword: 'y', timeoutMs: 800 });
  const r = await c.testConnection();
  assert.equal(r.restOk, false);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /REST API unreachable/);
});

test('pagination walks every page and respects limits', async (t) => {
  const fx = defaultFixture();
  fx.posts = Array.from({ length: 45 }, (_, i) => ({ id: 100 + i, type: 'posts', link: `/p/${i}/`, title: `P${i}`, meta: {}, content: '' }));
  const { wp, c } = await connect(fx);
  t.after(() => wp.close());
  const all = await c.collect('/wp-json/wp/v2/posts', { perPage: 10 });
  assert.equal(all.length, 45);
  const capped = await c.collect('/wp-json/wp/v2/posts', { perPage: 10, limit: 12 });
  assert.equal(capped.length, 12);
  const oneBatch = await c.collect('/wp-json/wp/v2/posts', { perPage: 10, maxPages: 2 });
  assert.equal(oneBatch.length, 20, 'maxPages bounds a runaway crawl');
});

test('app password spaces are stripped, and credentials never go to public URLs', async (t) => {
  const { wp, c } = await connect();
  t.after(() => wp.close());
  assert.ok(c.authHeader.startsWith('Basic '));
  const res = await c.fetchPublic('/privacy-policy/');
  assert.equal(res.status, 200);
  assert.match(res.text, /Privacy Policy/);
});

test('WooCommerce rejects a bad key and surfaces it', async (t) => {
  const wp = await startMockWp();
  t.after(() => wp.close());
  const c = new WordPressConnector({ baseUrl: wp.baseUrl, username: 'ismail', appPassword: 'abcd efgh ijkl mnop', wooKey: 'ck_bad', wooSecret: 'cs_bad' });
  const r = await c.testConnection();
  assert.equal(r.authOk, true);
  assert.equal(r.wooOk, false);
  assert.match(r.errors[0], /WooCommerce.*401/);
});

test('writes patch the row and are visible to the next read', async (t) => {
  const { wp, c } = await connect();
  t.after(() => wp.close());
  await c.updateUser(1, { name: 'Ismail Hossain' });
  assert.equal(wp.state.users[0].name, 'Ismail Hossain');
  await c.updatePost(10, { meta: { rank_math_canonical_url: 'https://vapewizarddxb.com/blog/best-disposables/' } });
  assert.equal(wp.state.posts[0].meta.rank_math_canonical_url, 'https://vapewizarddxb.com/blog/best-disposables/');
  assert.equal(wp.state.posts[0].title, 'Best disposables', 'unrelated fields are untouched');
});

test('a missing companion plugin degrades to null instead of failing the scan', async (t) => {
  const fx = defaultFixture();
  fx.namespaces = ['wp/v2', 'wc/v3'];
  const { wp, c } = await connect(fx);
  t.after(() => wp.close());
  assert.equal(await c.summary(), null);
  const r = await c.testConnection();
  assert.equal(r.companionPlugin, false);
  assert.equal(r.ok, true, 'the site still connects without it');
});

test('HTTP errors become ConnectorError with status', async (t) => {
  const { wp, c } = await connect();
  t.after(() => wp.close());
  await assert.rejects(() => c.updatePost(999, { title: 'x' }), (e) => e instanceof ConnectorError && e.status === 404);
});
