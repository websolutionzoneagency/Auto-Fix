// The scanner's read-only checks.
//
// Each check gets { connector, site, ctx } and returns:
//   { verdict: 'pass' | 'fail' | 'unknown', summary, findings[], evidenceUrl?, note? }
//
// 'unknown' matters as much as pass/fail: a check that could not run (no Woo credentials, no companion
// plugin, an API that timed out) must never silently tick a checklist item. Only 'pass' and 'fail'
// move an item; 'unknown' leaves whatever a human set and says why.
import { canonicalOf, metaRobots, links, images, jsonLdTypes, sitemapLocs, internalUrl, isDeadHref, attr, tags } from './html.js';

const pass = (summary, extra = {}) => ({ verdict: 'pass', summary, findings: [], ...extra });
const fail = (summary, findings = [], extra = {}) => ({ verdict: 'fail', summary, findings, ...extra });
const unknown = (summary, extra = {}) => ({ verdict: 'unknown', summary, findings: [], ...extra });

/** Public pages the checks sample. Kept small so one scan fits in a serverless invocation. */
const SAMPLE = 25;

export const CHECKS = {
  /* ---------- f1 ---------- */
  'plugin-config': {
    label: 'SEO plugin present and configured',
    async run({ connector }) {
      const conn = await connector.testConnection();
      if (!conn.restOk) return unknown('WordPress REST API not reachable');
      if (!conn.seoPlugin) return fail('No SEO plugin REST namespace detected (Rank Math / Yoast)', [{ detail: 'Neither rankmath/v1 nor yoast/v1 is exposed.' }]);
      return pass(`${conn.seoPlugin} detected`, { note: conn.companionPlugin ? null : 'RankOps companion plugin not installed — revision and debug checks will be unavailable.' });
    },
  },

  /* ---------- f2, im5 ---------- */
  sitemap: {
    label: 'XML sitemap live',
    async run({ connector, site }) {
      const candidates = ['/sitemap_index.xml', '/wp-sitemap.xml', '/sitemap.xml'];
      for (const path of candidates) {
        const res = await connector.fetchPublic(path).catch(() => null);
        if (res && res.status === 200 && /<(sitemapindex|urlset)/i.test(res.text)) {
          const locs = sitemapLocs(res.text);
          return pass(`${path} live with ${locs.length} entr${locs.length === 1 ? 'y' : 'ies'}`, {
            evidenceUrl: connector.baseUrl + path,
            note: 'Submission to Search Console is a Google-account action and is not checked here.',
          });
        }
      }
      return fail('No XML sitemap found', candidates.map(p => ({ url: connector.baseUrl + p, detail: 'not a sitemap' })));
    },
  },

  /* ---------- f3 ---------- */
  'legacy-links': {
    label: 'No legacy permalink prefixes in content',
    async run({ connector, ctx }) {
      const prefixes = ctx?.legacyPrefixes?.length ? ctx.legacyPrefixes : ['/shop/old-prefix/', '/index.php/'];
      const posts = await connector.posts({ limit: 200 });
      const pages = await connector.pages({ limit: 200 });
      const findings = [];
      for (const row of [...posts, ...pages]) {
        const content = contentOf(row);
        for (const pfx of prefixes) {
          if (content.includes(pfx)) findings.push({ id: row.id, type: row.type || 'post', url: row.link, detail: `contains ${pfx}`, prefix: pfx });
        }
      }
      return findings.length
        ? fail(`${findings.length} page(s) link through a legacy prefix`, findings)
        : pass(`No legacy prefixes in ${posts.length + pages.length} posts/pages`);
    },
  },

  /* ---------- f4 ---------- */
  'duplicate-categories': {
    label: 'No duplicate or overlapping categories',
    async run({ connector }) {
      const cats = await connector.categories({ limit: 300 }).catch(() => []);
      if (!cats.length) return unknown('No categories returned');
      const byKey = new Map();
      for (const c of cats) {
        const key = normalise(c.name);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(c);
      }
      const findings = [];
      for (const [key, group] of byKey) {
        if (group.length > 1) findings.push({ detail: `${group.length} categories normalise to "${key}"`, terms: group.map(c => ({ id: c.id, name: c.name, slug: c.slug, count: c.count })) });
      }
      // Near-duplicates: one is a singular/plural or prefix of another AND one of them is empty.
      for (const a of cats) for (const b of cats) {
        if (a.id >= b.id) continue;
        const na = normalise(a.name), nb = normalise(b.name);
        if (na === nb) continue;
        if ((na.startsWith(nb) || nb.startsWith(na)) && (a.count === 0 || b.count === 0)) {
          findings.push({ detail: `"${a.name}" (${a.count} products) overlaps "${b.name}" (${b.count} products); one is empty`, terms: [pick(a), pick(b)] });
        }
      }
      return findings.length ? fail(`${findings.length} overlapping category pair(s)`, findings) : pass(`${cats.length} categories, no overlaps detected`);
    },
  },

  /* ---------- f5 ---------- */
  'thin-archives': {
    label: 'Thin archives pruned or noindexed',
    async run({ connector, ctx }) {
      const min = ctx?.thinThreshold ?? 3;
      const cats = await connector.categories({ limit: 300 }).catch(() => []);
      if (!cats.length) return unknown('No categories returned');
      const findings = cats
        .filter(c => (c.count ?? 0) < min && !hasNoindex(c))
        .map(c => ({ id: c.id, name: c.name, url: c.link, count: c.count, detail: `${c.count} product(s), indexable` }));
      return findings.length
        ? fail(`${findings.length} thin archive(s) still indexable (under ${min} products)`, findings)
        : pass(`All archives either have ≥${min} products or are noindexed`);
    },
  },

  /* ---------- f6 ---------- */
  revisions: {
    label: 'Post-revision bloat capped',
    async run({ connector, ctx }) {
      const summary = await connector.summary();
      if (!summary) return unknown('Needs the RankOps companion plugin to count revisions');
      const cap = ctx?.revisionCap ?? 10;
      const worst = (summary.revisions?.worst || []).filter(r => r.count > cap);
      return worst.length
        ? fail(`${worst.length} post(s) over ${cap} revisions (${summary.revisions.total} total)`, worst.map(r => ({ id: r.id, count: r.count, detail: `${r.count} revisions` })))
        : pass(`No post exceeds ${cap} revisions (${summary.revisions?.total ?? 0} total)`);
    },
  },

  /* ---------- f7 ---------- */
  canonical: {
    label: 'Canonical tags correct',
    async run({ connector }) {
      const rows = [...(await connector.posts({ limit: SAMPLE })), ...(await connector.pages({ limit: SAMPLE }))];
      if (!rows.length) return unknown('No published posts or pages found');
      const findings = [];
      let checked = 0;
      for (const row of rows.slice(0, SAMPLE)) {
        const url = absolute(row.link, connector.baseUrl);
        const res = await connector.fetchPublic(url).catch(() => null);
        if (!res || res.status !== 200) continue;
        checked++;
        const found = canonicalOf(res.text);
        if (!found) findings.push({ id: row.id, type: row.type || 'post', url, detail: 'no canonical tag', expected: url });
        else if (!sameUrl(found, url)) findings.push({ id: row.id, type: row.type || 'post', url, detail: `canonical points to ${found}`, expected: url, actual: found });
      }
      if (!checked) return unknown('No page returned HTTP 200');
      return findings.length ? fail(`${findings.length}/${checked} sampled pages have a wrong or missing canonical`, findings) : pass(`All ${checked} sampled pages self-canonicalise`);
    },
  },

  /* ---------- f8, t7 ---------- */
  'broken-links': {
    label: 'No broken internal links',
    async run({ connector, ctx }) {
      const budget = ctx?.linkBudget ?? 120;
      const rows = [...(await connector.posts({ limit: SAMPLE })), ...(await connector.pages({ limit: SAMPLE }))];
      const seen = new Map();                       // url → pages that link to it
      for (const row of rows) {
        for (const href of links(contentOf(row))) {
          const u = internalUrl(href, connector.baseUrl);
          if (!u) continue;
          if (!seen.has(u)) seen.set(u, []);
          seen.get(u).push(row.link);
        }
      }
      const home = await connector.fetchPublic('/').catch(() => null);
      if (home?.status === 200) {
        for (const href of links(home.text)) {
          const u = internalUrl(href, connector.baseUrl);
          if (u && !seen.has(u)) seen.set(u, ['/']);
        }
      }
      const targets = [...seen.keys()].slice(0, budget);
      if (!targets.length) return unknown('No internal links found to check');
      const findings = [];
      for (const url of targets) {
        const res = await connector.fetchPublic(url).catch(() => null);
        if (!res) { findings.push({ url, detail: 'request failed', from: seen.get(url) }); continue; }
        if (res.status >= 400) findings.push({ url, status: res.status, detail: `HTTP ${res.status}`, from: seen.get(url) });
      }
      return findings.length
        ? fail(`${findings.length} broken internal link target(s) of ${targets.length} checked`, findings)
        : pass(`${targets.length} internal link targets all resolve`);
    },
  },

  /* ---------- f9 ---------- */
  'core-web-vitals': {
    label: 'Core Web Vitals',
    async run({ connector, ctx }) {
      const key = ctx?.psiApiKey;
      if (!key) return unknown('Needs a PageSpeed Insights API key (PSI_API_KEY)');
      const target = connector.baseUrl + '/';
      const url = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(target)}&strategy=mobile&key=${key}`;
      let data;
      try {
        const res = await (ctx.fetchImpl || globalThis.fetch)(url);
        if (!res.ok) return unknown(`PageSpeed Insights returned HTTP ${res.status}`);
        data = await res.json();
      } catch (e) { return unknown(`PageSpeed Insights unreachable: ${e.message}`); }
      const score = Math.round((data?.lighthouseResult?.categories?.performance?.score ?? 0) * 100);
      const assessment = data?.loadingExperience?.overall_category;
      if (assessment === 'FAST' || score >= 90) return pass(`Mobile performance ${score}/100${assessment ? ` (field data: ${assessment})` : ''}`, { evidenceUrl: `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(target)}` });
      return fail(`Mobile performance ${score}/100${assessment ? ` (field data: ${assessment})` : ''}`, [{ url: target, detail: `Lighthouse performance ${score}` }], { evidenceUrl: `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(target)}` });
    },
  },

  /* ---------- t1 ---------- */
  'trust-pages': {
    label: 'Tier 1 policy pages live',
    async run({ connector, ctx }) {
      const required = ctx?.trustPages?.length ? ctx.trustPages
        : [{ name: 'Privacy', match: /privacy/i }, { name: 'Terms', match: /terms|conditions/i }, { name: 'Shipping', match: /shipping|delivery/i },
           { name: 'Returns', match: /returns?|refund/i }, { name: 'Age Verification', match: /age.?verif|18\+/i }, { name: 'Responsible Vaping', match: /responsible/i }];
      const pages = await connector.pages({ limit: 200 });
      const findings = [];
      for (const req of required) {
        const hit = pages.find(p => req.match.test(titleOf(p)) || req.match.test(p.link || ''));
        if (!hit) findings.push({ detail: `${req.name} page missing`, name: req.name });
      }
      return findings.length ? fail(`${findings.length} of ${required.length} policy pages missing`, findings) : pass(`All ${required.length} policy pages found`);
    },
  },

  /* ---------- t8 ---------- */
  'author-identity': {
    label: 'CMS author identity is a real name',
    async run({ connector }) {
      const users = await connector.users({ limit: 100 }).catch(() => []);
      if (!users.length) return unknown('Could not list users (needs an administrator application password)');
      const findings = users
        .filter(u => isPlaceholderName(u.name))
        .map(u => ({ id: u.id, name: u.name, detail: `display name "${u.name}" is a placeholder`, roles: u.roles }));
      return findings.length ? fail(`${findings.length} account(s) use a placeholder display name`, findings) : pass(`All ${users.length} accounts use real names`);
    },
  },

  /* ---------- t9 ---------- */
  'dead-nav-links': {
    label: 'No dead # placeholders in nav/footer',
    async run({ connector }) {
      const res = await connector.fetchPublic('/').catch(() => null);
      if (!res || res.status !== 200) return unknown('Homepage did not return HTTP 200');
      const findings = [];
      for (const region of ['nav', 'footer', 'header']) {
        for (const block of blocks(res.text, region)) {
          for (const t of tags(block, 'a')) {
            const href = attr(t, 'href');
            if (isDeadHref(href)) findings.push({ region, detail: `dead link "${textOf(t, block)}" (href="${href ?? ''}")`, href: href ?? '' });
          }
        }
      }
      return findings.length ? fail(`${findings.length} dead placeholder link(s) in nav/footer`, findings, { evidenceUrl: connector.baseUrl + '/' }) : pass('No dead placeholder links in nav/footer');
    },
  },

  /* ---------- n8, n9, s3, s6 ---------- */
  'schema-presence': {
    label: 'Required schema types present',
    async run({ connector, ctx }) {
      const wanted = ctx?.schemaTypes?.length ? ctx.schemaTypes : ['Organization', 'BreadcrumbList'];
      const res = await connector.fetchPublic('/').catch(() => null);
      if (!res || res.status !== 200) return unknown('Homepage did not return HTTP 200');
      const found = jsonLdTypes(res.text);
      const missing = wanted.filter(w => !found.includes(w));
      return missing.length
        ? fail(`Missing schema: ${missing.join(', ')}`, missing.map(m => ({ detail: `${m} not found in JSON-LD`, type: m })), { evidenceUrl: connector.baseUrl + '/', note: `Found: ${found.join(', ') || 'none'}` })
        : pass(`Found ${wanted.join(', ')}`, { evidenceUrl: connector.baseUrl + '/' });
    },
  },

  /* ---------- r4 ---------- */
  'outbound-links': {
    label: 'No stray competitor / off-site links',
    async run({ connector, ctx }) {
      const allow = (ctx?.allowedDomains || []).map(d => d.toLowerCase());
      const rows = [...(await connector.posts({ limit: SAMPLE })), ...(await connector.pages({ limit: SAMPLE }))];
      const host = new URL(connector.baseUrl).host;
      const findings = [];
      for (const row of rows) {
        for (const href of links(contentOf(row))) {
          let u; try { u = new URL(href, connector.baseUrl); } catch { continue; }
          if (!/^https?:$/.test(u.protocol) || u.host === host) continue;
          if (allow.some(d => u.host.toLowerCase().endsWith(d))) continue;
          findings.push({ id: row.id, type: row.type || 'post', url: row.link, href: u.toString(), detail: `links out to ${u.host}` });
        }
      }
      return findings.length ? fail(`${findings.length} off-site link(s) to review`, findings) : pass('No unexpected off-site links in sampled content');
    },
  },

  /* ---------- im1 ---------- */
  'image-filenames': {
    label: 'Descriptive image file names',
    async run({ connector }) {
      const media = await connector.media({ limit: 300 }).catch(() => []);
      const imgs = media.filter(m => m.media_type === 'image');
      if (!imgs.length) return unknown('No images in the media library');
      const findings = imgs
        .filter(m => isCameraFilename(fileName(m.source_url)))
        .map(m => ({ id: m.id, url: m.source_url, detail: `camera filename ${fileName(m.source_url)}` }));
      return findings.length ? fail(`${findings.length}/${imgs.length} images use camera filenames`, findings) : pass(`All ${imgs.length} images have descriptive filenames`);
    },
  },

  /* ---------- im2 ---------- */
  'image-alt': {
    label: 'Alt text on every image',
    async run({ connector }) {
      const media = await connector.media({ limit: 300 }).catch(() => []);
      const imgs = media.filter(m => m.media_type === 'image');
      if (!imgs.length) return unknown('No images in the media library');
      const findings = imgs
        .filter(m => !String(m.alt_text || '').trim())
        .map(m => ({ id: m.id, url: m.source_url, detail: 'alt text empty', filename: fileName(m.source_url) }));
      return findings.length ? fail(`${findings.length}/${imgs.length} images have no alt text`, findings) : pass(`All ${imgs.length} images have alt text`);
    },
  },

  /* ---------- l1 ---------- */
  'orphan-pages': {
    label: 'No orphan pages',
    async run({ connector }) {
      const rows = [...(await connector.posts({ limit: 200 })), ...(await connector.pages({ limit: 200 }))];
      if (!rows.length) return unknown('No published content found');
      const linked = new Set();
      const home = await connector.fetchPublic('/').catch(() => null);
      const sources = rows.map(r => contentOf(r));
      if (home?.status === 200) sources.push(home.text);
      for (const src of sources) {
        for (const href of links(src)) {
          const u = internalUrl(href, connector.baseUrl);
          if (u) linked.add(normalisePath(u));
        }
      }
      const findings = rows
        .filter(r => !linked.has(normalisePath(absolute(r.link, connector.baseUrl))))
        .map(r => ({ id: r.id, type: r.type || 'posts', url: r.link, detail: 'no inbound internal link found' }));
      return findings.length ? fail(`${findings.length} orphan page(s)`, findings) : pass(`All ${rows.length} pages have an inbound link`);
    },
  },

  /* ---------- sc1 ---------- */
  'open-registration': {
    label: 'User registration closed',
    async run({ connector }) {
      const settings = await connector.settings().catch(() => null);
      if (!settings || settings.users_can_register === undefined) return unknown('Could not read site settings');
      return settings.users_can_register
        ? fail('Open user registration is enabled', [{ detail: 'users_can_register = true', setting: 'users_can_register' }])
        : pass('User registration is closed');
    },
  },

  /* ---------- sc3 ---------- */
  'debug-mode': {
    label: 'Debug display off in production',
    async run({ connector }) {
      const summary = await connector.summary();
      if (!summary) return unknown('Needs the RankOps companion plugin to read WP_DEBUG_DISPLAY');
      return summary.debug_display
        ? fail('WP_DEBUG_DISPLAY is on — PHP errors can render to visitors', [{ detail: 'WP_DEBUG_DISPLAY = true', note: 'Fix in wp-config.php; not changeable over REST.' }])
        : pass('Debug display is off');
    },
  },

  /* ---------- ga1 ---------- */
  'analytics-tags': {
    label: 'Analytics tag present',
    async run({ connector }) {
      const res = await connector.fetchPublic('/').catch(() => null);
      if (!res || res.status !== 200) return unknown('Homepage did not return HTTP 200');
      const html = res.text;
      const ga4 = /gtag\/js\?id=G-|googletagmanager\.com\/gtm\.js|G-[A-Z0-9]{6,}/.test(html);
      return ga4 ? pass('GA4 / Google Tag Manager tag found on the homepage', { evidenceUrl: connector.baseUrl + '/' })
                 : fail('No GA4 or GTM tag found on the homepage', [{ url: connector.baseUrl + '/', detail: 'no gtag.js or gtm.js' }]);
    },
  },

  /* ---------- cp2, bp4 ---------- */
  'click-depth': {
    label: 'Key pages reachable within 2 clicks',
    async run({ connector, ctx }) {
      const maxDepth = ctx?.maxClickDepth ?? 2;
      const home = await connector.fetchPublic('/').catch(() => null);
      if (!home || home.status !== 200) return unknown('Homepage did not return HTTP 200');
      const depth = new Map([[normalisePath(connector.baseUrl + '/'), 0]]);
      let frontier = [connector.baseUrl + '/'];
      for (let d = 1; d <= maxDepth; d++) {
        const next = [];
        for (const url of frontier.slice(0, 15)) {
          const res = url === connector.baseUrl + '/' ? home : await connector.fetchPublic(url).catch(() => null);
          if (!res || res.status !== 200) continue;
          for (const href of links(res.text)) {
            const u = internalUrl(href, connector.baseUrl);
            if (!u) continue;
            const key = normalisePath(u);
            if (depth.has(key)) continue;
            depth.set(key, d);
            next.push(u);
          }
        }
        frontier = next;
        if (!frontier.length) break;
      }
      const cats = await connector.categories({ limit: 100 }).catch(() => []);
      const targets = cats.filter(c => (c.count ?? 0) > 0);
      if (!targets.length) return unknown('No populated categories to measure');
      const findings = targets
        .filter(c => !depth.has(normalisePath(absolute(c.link, connector.baseUrl))))
        .map(c => ({ id: c.id, name: c.name, url: c.link, detail: `not reachable within ${maxDepth} clicks of the homepage` }));
      return findings.length ? fail(`${findings.length}/${targets.length} categories buried deeper than ${maxDepth} clicks`, findings) : pass(`All ${targets.length} populated categories are within ${maxDepth} clicks`);
    },
  },

  /* ---------- cp5 ---------- */
  'faceted-urls': {
    label: 'Faceted URLs not indexable',
    async run({ connector }) {
      const cats = await connector.categories({ limit: 20 }).catch(() => []);
      const withProducts = cats.find(c => (c.count ?? 0) > 0);
      if (!withProducts) return unknown('No populated category to test a facet against');
      const target = absolute(withProducts.link, connector.baseUrl) + '?filter_brand=test&orderby=price';
      const res = await connector.fetchPublic(target).catch(() => null);
      if (!res || res.status !== 200) return unknown('Faceted URL did not return HTTP 200');
      const robots = metaRobots(res.text) || '';
      const canon = canonicalOf(res.text);
      if (robots.includes('noindex')) return pass('Faceted URLs are noindexed', { evidenceUrl: target });
      if (canon && !canon.includes('?')) return pass('Faceted URLs canonicalise to the clean category URL', { evidenceUrl: target });
      return fail('Faceted URL is indexable and self-canonical — risks index bloat', [{ url: target, detail: `robots="${robots || 'none'}", canonical="${canon || 'none'}"` }], { evidenceUrl: target });
    },
  },
};

/* ---------- helpers ---------- */
function contentOf(row) {
  const c = row?.content;
  return typeof c === 'string' ? c : (c?.rendered || '');
}
function titleOf(row) {
  const t = row?.title;
  return typeof t === 'string' ? t : (t?.rendered || '');
}
function absolute(link, baseUrl) { try { return new URL(link, baseUrl).toString(); } catch { return baseUrl; } }
function normalisePath(u) { try { const x = new URL(u); return x.host + x.pathname.replace(/\/+$/, '/'); } catch { return String(u); } }
function sameUrl(a, b) { try { return normalisePath(a) === normalisePath(b); } catch { return a === b; } }
function normalise(s) { return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').replace(/\b(vapes?|s)\b/g, '').replace(/\s+/g, ' ').trim(); }
function pick(c) { return { id: c.id, name: c.name, slug: c.slug, count: c.count }; }
function hasNoindex(term) {
  const r = term?.meta?.rank_math_robots;
  if (Array.isArray(r)) return r.includes('noindex');
  if (typeof r === 'string') return r.includes('noindex');
  return false;
}
function isPlaceholderName(name) {
  const n = String(name || '').trim();
  if (!n) return true;
  if (/^(admin|administrator|user|test|editor|webmaster|wp[-_]?admin)$/i.test(n)) return true;
  if (/^\S+@\S+\.\S+$/.test(n)) return true;                 // a bare email as a byline
  return false;
}
function fileName(url) { try { return new URL(url).pathname.split('/').pop() || ''; } catch { return String(url).split('/').pop() || ''; } }
function isCameraFilename(f) { return /^(img|dsc|dscn|p|pxl|photo|image|screenshot|untitled)[-_ ]?\d{3,}\.\w+$/i.test(f); }
function blocks(html, tag) {
  return [...String(html).matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map(m => m[1]);
}
function textOf(anchorTag, block) {
  const i = block.indexOf(anchorTag);
  if (i === -1) return '';
  const rest = block.slice(i + anchorTag.length);
  return (rest.split('</a>')[0] || '').replace(/<[^>]*>/g, '').trim().slice(0, 40);
}

export function getCheck(id) { return CHECKS[id] || null; }
export function checkIds() { return Object.keys(CHECKS); }
