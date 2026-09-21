import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WordPressConnector } from '../api/_lib/connectors/wordpress.js';
import { CHECKS } from '../api/_lib/checks.js';
import { startMockWp, defaultFixture } from './helpers/mock-wp.mjs';

async function harness(mutate) {
  const fx = defaultFixture();
  if (mutate) mutate(fx);
  const wp = await startMockWp(fx);
  const connector = new WordPressConnector({ baseUrl: wp.baseUrl, ...wp.creds });
  const run = (id, ctx = {}) => CHECKS[id].run({ connector, site: { domain: 'vapewizarddxb.com' }, ctx });
  return { wp, connector, run };
}

test('canonical: flags missing and mismatched canonicals, passes when correct', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const r = await h.run('canonical');
  assert.equal(r.verdict, 'fail');
  const urls = r.findings.map(f => f.url);
  assert.ok(urls.some(u => u.includes('best-disposables')), 'page with no canonical is flagged');
  assert.ok(!urls.some(u => u.includes('coil-guide')), 'correctly canonicalised page is not flagged');
  assert.ok(r.findings[0].expected, 'finding carries the expected value for the fixer');

  const h2 = await harness(fx => {
    for (const p of fx.pagesHtml && Object.values(fx.pagesHtml)) { /* noop */ }
    fx.pagesHtml['/blog/best-disposables/'].body = fx.pagesHtml['/blog/best-disposables/'].body
      .replace('</head>', '<link rel="canonical" href="https://vapewizarddxb.com/blog/best-disposables/"></head>');
    fx.posts = fx.posts.filter(p => p.id !== 12);
    fx.pages = fx.pages.filter(p => p.id === 20);
  });
  t.after(() => h2.wp.close());
  const r2 = await h2.run('canonical');
  assert.equal(r2.verdict, 'pass', r2.summary);
});

test('broken-links: finds the 404 targets and reports where they are linked from', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const r = await h.run('broken-links');
  assert.equal(r.verdict, 'fail');
  const urls = r.findings.map(f => f.url);
  assert.ok(urls.some(u => u.endsWith('/blog/gone/')), '404 link found');
  assert.ok(urls.some(u => u.includes('/shop/old-prefix/')), 'legacy 404 found');
  assert.equal(r.findings[0].status, 404);
  assert.ok(Array.isArray(r.findings[0].from), 'reports the linking pages');
});

test('author-identity: catches "admin" and a bare email, ignores real names', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const r = await h.run('author-identity');
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(r.findings.map(f => f.id).sort(), [1, 3]);
  const h2 = await harness(fx => { fx.users = [{ id: 2, name: 'Ismail Hossain', slug: 'ismail', roles: ['editor'] }]; });
  t.after(() => h2.wp.close());
  assert.equal((await h2.run('author-identity')).verdict, 'pass');
});

test('dead-nav-links: finds href="#" in nav and footer', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const r = await h.run('dead-nav-links');
  assert.equal(r.verdict, 'fail');
  assert.equal(r.findings.length, 2);
  assert.deepEqual([...new Set(r.findings.map(f => f.region))].sort(), ['footer', 'nav']);
  assert.ok(r.evidenceUrl);
});

test('image-alt and image-filenames', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const alt = await h.run('image-alt');
  assert.equal(alt.verdict, 'fail');
  assert.deepEqual(alt.findings.map(f => f.id).sort(), [30, 32]);
  const names = await h.run('image-filenames');
  assert.equal(names.verdict, 'fail');
  assert.deepEqual(names.findings.map(f => f.id).sort(), [30, 32], 'IMG_1234 and DSC_0099 flagged, the descriptive one is not');
});

test('thin-archives: flags low-count indexable terms, respects noindex', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const r = await h.run('thin-archives');
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(r.findings.map(f => f.id).sort(), [41, 42]);
  const h2 = await harness(fx => { fx.categories.forEach(c => { if (c.count < 3) c.meta.rank_math_robots = ['noindex']; }); });
  t.after(() => h2.wp.close());
  assert.equal((await h2.run('thin-archives')).verdict, 'pass');
});

test('duplicate-categories: spots the empty near-duplicate', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const r = await h.run('duplicate-categories');
  assert.equal(r.verdict, 'fail');
  assert.ok(r.findings.some(f => /Disposable/.test(f.detail)), r.findings.map(f => f.detail).join(' | '));
});

test('trust-pages: lists exactly what is missing', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const r = await h.run('trust-pages');
  assert.equal(r.verdict, 'fail');
  const missing = r.findings.map(f => f.name).sort();
  assert.deepEqual(missing, ['Age Verification', 'Responsible Vaping', 'Returns', 'Terms']);
});

test('sitemap: finds wp-sitemap.xml and notes what it cannot verify', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const r = await h.run('sitemap');
  assert.equal(r.verdict, 'pass');
  assert.match(r.summary, /wp-sitemap\.xml live with 1 entry/);
  assert.match(r.note, /Search Console/);
  const h2 = await harness(fx => { delete fx.pagesHtml['/wp-sitemap.xml']; });
  t.after(() => h2.wp.close());
  assert.equal((await h2.run('sitemap')).verdict, 'fail');
});

test('legacy-links: finds the stale prefix in post content', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const r = await h.run('legacy-links', { legacyPrefixes: ['/shop/old-prefix/'] });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.findings[0].id, 10);
  assert.equal(r.findings[0].prefix, '/shop/old-prefix/');
});

test('orphan-pages: finds the page nothing links to', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const r = await h.run('orphan-pages');
  assert.equal(r.verdict, 'fail');
  assert.ok(r.findings.some(f => f.id === 12), 'the orphan post is flagged');
  assert.ok(!r.findings.some(f => f.id === 10), 'post 10 is linked from post 11, so it is not an orphan');
});

test('open-registration and schema-presence', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  assert.equal((await h.run('open-registration')).verdict, 'fail');
  const schema = await h.run('schema-presence');
  assert.equal(schema.verdict, 'fail');
  assert.deepEqual(schema.findings.map(f => f.type).sort(), ['BreadcrumbList', 'Organization']);
  assert.match(schema.note, /Found: WebPage/);
});

test('analytics-tags: absent then present', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  assert.equal((await h.run('analytics-tags')).verdict, 'fail');
  const h2 = await harness(fx => {
    fx.pagesHtml['/'].body = fx.pagesHtml['/'].body.replace('</head>', '<script src="https://www.googletagmanager.com/gtag/js?id=G-ABC1234"></script></head>');
  });
  t.after(() => h2.wp.close());
  assert.equal((await h2.run('analytics-tags')).verdict, 'pass');
});

test('checks that cannot run return "unknown", never a false pass or fail', async (t) => {
  const h = await harness(fx => { fx.namespaces = ['wp/v2']; });   // no companion plugin
  t.after(() => h.wp.close());
  const rev = await h.run('revisions');
  assert.equal(rev.verdict, 'unknown');
  assert.match(rev.summary, /companion plugin/);
  const dbg = await h.run('debug-mode');
  assert.equal(dbg.verdict, 'unknown');
  const cwv = await h.run('core-web-vitals', {});
  assert.equal(cwv.verdict, 'unknown');
  assert.match(cwv.summary, /PageSpeed Insights API key/);
});

test('revisions and debug-mode read the companion plugin when present', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const rev = await h.run('revisions', { revisionCap: 10 });
  assert.equal(rev.verdict, 'fail');
  assert.equal(rev.findings[0].id, 10);
  assert.equal(rev.findings[0].count, 24);
  assert.equal((await h.run('revisions', { revisionCap: 50 })).verdict, 'pass');
  assert.equal((await h.run('debug-mode')).verdict, 'pass');
  const h2 = await harness(fx => { fx.debugDisplay = true; });
  t.after(() => h2.wp.close());
  assert.equal((await h2.run('debug-mode')).verdict, 'fail');
});

test('core-web-vitals uses an injected fetch and grades the score', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const fetchImpl = async () => ({ ok: true, json: async () => ({ lighthouseResult: { categories: { performance: { score: 0.42 } } }, loadingExperience: { overall_category: 'SLOW' } }) });
  const r = await h.run('core-web-vitals', { psiApiKey: 'k', fetchImpl });
  assert.equal(r.verdict, 'fail');
  assert.match(r.summary, /42\/100.*SLOW/);
  assert.match(r.evidenceUrl, /pagespeed\.web\.dev/);
  const good = async () => ({ ok: true, json: async () => ({ lighthouseResult: { categories: { performance: { score: 0.95 } } }, loadingExperience: { overall_category: 'FAST' } }) });
  assert.equal((await h.run('core-web-vitals', { psiApiKey: 'k', fetchImpl: good })).verdict, 'pass');
});

test('outbound-links honours the allowlist', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const r = await h.run('outbound-links');
  assert.equal(r.verdict, 'fail');
  assert.match(r.findings[0].detail, /competitor\.example/);
  assert.equal((await h.run('outbound-links', { allowedDomains: ['competitor.example'] })).verdict, 'pass');
});

test('click-depth and faceted-urls', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const depth = await h.run('click-depth');
  assert.equal(depth.verdict, 'fail', 'populated category is not linked from the homepage');
  assert.ok(depth.findings.some(f => f.id === 40));
  const facet = await h.run('faceted-urls');
  assert.equal(facet.verdict, 'unknown');   // the mock 404s the faceted URL
});
