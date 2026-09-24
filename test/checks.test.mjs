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
  assert.equal(facet.verdict, 'fail', 'a filtered category page with no noindex and no clean canonical is indexable');
  const h2 = await harness(fx => {
    fx.pagesHtml['/product-category/disposables/'].body = fx.pagesHtml['/product-category/disposables/'].body
      .replace('</head>', '<link rel="canonical" href="https://vapewizarddxb.com/product-category/disposables/"></head>');
  });
  t.after(() => h2.wp.close());
  assert.equal((await h2.run('faceted-urls')).verdict, 'pass', 'canonicalising facets to the clean URL passes');
});

test('per-item schema checks: Organization on the homepage, breadcrumbs on deep pages, product schema on products', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const org = await h.run('schema-organization');
  assert.equal(org.verdict, 'fail');
  assert.deepEqual(org.findings.map(f => f.type), ['Organization'], 'the finding still feeds the Organization fixer');
  const crumbs = await h.run('schema-breadcrumb');
  assert.equal(crumbs.verdict, 'fail');
  assert.ok(crumbs.findings.every(f => !/\/$/.test(new URL(f.url).pathname) || new URL(f.url).pathname !== '/'), 'the homepage is not a deep page');
  // No /wp/v2/product route on this mock → undecided, never a guess.
  assert.equal((await h.run('schema-product')).verdict, 'unknown');

  const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
  const h2 = await harness(fx => {
    fx.pagesHtml['/'].body = fx.pagesHtml['/'].body.replace('</head>', ld({ '@type': 'OnlineStore', name: 'VW' }) + '</head>');
    for (const [path, page] of Object.entries(fx.pagesHtml)) {
      if (path !== '/' && page.status === 200 && !path.endsWith('.xml')) page.body = page.body.replace('</head>', ld({ '@type': 'BreadcrumbList', itemListElement: [] }) + '</head>');
    }
  });
  t.after(() => h2.wp.close());
  assert.equal((await h2.run('schema-organization')).verdict, 'pass', 'an Organization subtype counts');
  const c2 = await h2.run('schema-breadcrumb');
  assert.equal(c2.verdict, 'pass', c2.summary);
});

test('f2 is never ticked by a live sitemap; im5 needs image entries', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const f2 = await h.run('sitemap-submitted');
  assert.equal(f2.verdict, 'unknown');
  assert.match(f2.summary, /Search Console/);
  assert.ok(f2.evidenceUrl);
  // The mock index points its children at the real domain, which can't be fetched here → undecided, not a guess.
  assert.equal((await h.run('image-sitemap')).verdict, 'unknown');

  const urlset = (inner) => ({ status: 200, contentType: 'application/xml', body: `<?xml version="1.0"?><urlset xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"><url><loc>https://x/p/</loc>${inner}</url></urlset>` });
  const h2 = await harness(fx => { fx.pagesHtml['/wp-sitemap.xml'] = urlset('<image:image><image:loc>https://x/a.jpg</image:loc></image:image>'); });
  t.after(() => h2.wp.close());
  const im5 = await h2.run('image-sitemap');
  assert.equal(im5.verdict, 'pass', im5.summary);
  const h4 = await harness(fx => { fx.pagesHtml['/wp-sitemap.xml'] = urlset(''); });
  t.after(() => h4.wp.close());
  assert.equal((await h4.run('image-sitemap')).verdict, 'fail', 'a sitemap without image entries fails im5');

  const h3 = await harness(fx => { delete fx.pagesHtml['/wp-sitemap.xml']; });
  t.after(() => h3.wp.close());
  assert.equal((await h3.run('sitemap-submitted')).verdict, 'fail', 'no sitemap at all is a real failure');
});

test('SEO-field fixes need the companion plugin, and an ignored write is never reported as applied', async (t) => {
  const { planFix, applyPlan } = await import('../api/_lib/fixes.js');
  const h = await harness(); t.after(() => h.wp.close());
  const thin = await h.run('thin-archives');
  const blocked = await planFix('noindex-thin-archive', { connector: h.connector, site: { companionPlugin: false }, findings: thin.findings });
  assert.equal(blocked.ops.length, 0);
  assert.match(blocked.blocked[0].reason, /companion plugin/);
  // A site that accepts the request but drops the unregistered field: the write must fail verification.
  const dropping = await harness(); t.after(() => dropping.wp.close());
  dropping.wp.state.categories.forEach(c => { delete c.meta; });
  const plan = await planFix('noindex-thin-archive', { connector: dropping.connector, site: {}, findings: thin.findings });
  const origUpdate = dropping.connector.updateTerm.bind(dropping.connector);
  dropping.connector.updateTerm = async (id, patch, tax) => { const row = await origUpdate(id, {}, tax); delete row.meta; return row; };
  const res = await applyPlan({ connector: dropping.connector, site: {}, plan });
  assert.equal(res.applied.length, 0);
  assert.match(res.failed[0].error, /did not return .*companion plugin/);
});
