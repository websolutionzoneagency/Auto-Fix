import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WordPressConnector } from '../api/_lib/connectors/wordpress.js';
import { CHECKS } from '../api/_lib/checks.js';
import { planFix, applyPlan, revertOperations, FixBlocked } from '../api/_lib/fixes.js';
import { startMockWp, defaultFixture } from './helpers/mock-wp.mjs';

async function harness(mutate) {
  const fx = defaultFixture();
  if (mutate) mutate(fx);
  const wp = await startMockWp(fx);
  const connector = new WordPressConnector({ baseUrl: wp.baseUrl, ...wp.creds });
  const site = { id: 's1', name: 'Vape Wizard DXB', domain: 'vapewizarddxb.com', paused: false };
  const check = (id, ctx = {}) => CHECKS[id].run({ connector, site, ctx });
  return { wp, connector, site, check };
}

test('planning writes nothing to the site', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const found = await h.check('canonical');
  const plan = await planFix('set-canonical', { connector: h.connector, site: h.site, findings: found.findings });
  assert.ok(plan.ops.length > 0);
  assert.equal(plan.dryRun, true);
  assert.equal(h.wp.writes.length, 0, 'plan() must not issue a single write');
  assert.match(plan.ops[0].describe, /canonical/i);
  assert.ok('before' in plan.ops[0] && 'after' in plan.ops[0], 'every op carries a before/after diff');
});

test('canonical: apply fixes the site, re-check passes, revert restores', async (t) => {
  const h = await harness(fx => { fx.posts = fx.posts.filter(p => p.id === 10); fx.pages = []; });
  t.after(() => h.wp.close());
  const before = await h.check('canonical');
  assert.equal(before.verdict, 'fail');

  const plan = await planFix('set-canonical', { connector: h.connector, site: h.site, findings: before.findings });
  const result = await applyPlan({ connector: h.connector, site: h.site, plan });
  assert.equal(result.applied.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(h.wp.state.posts[0].meta.rank_math_canonical_url, plan.ops[0].after);

  // The fix is only real if the check now agrees.
  h.wp.state.pagesHtml['/blog/best-disposables/'].body =
    h.wp.state.pagesHtml['/blog/best-disposables/'].body.replace('</head>', `<link rel="canonical" href="${plan.ops[0].after}"></head>`);
  assert.equal((await h.check('canonical')).verdict, 'pass');

  const undo = await revertOperations({ connector: h.connector, site: h.site, operations: result.applied });
  assert.equal(undo.reverted.length, 1);
  assert.equal(h.wp.state.posts[0].meta.rank_math_canonical_url, '', 'rolled back to the snapshot');
});

test('the per-site kill switch blocks every write', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const found = await h.check('canonical');
  const plan = await planFix('set-canonical', { connector: h.connector, site: h.site, findings: found.findings });
  const paused = { ...h.site, paused: true };
  await assert.rejects(() => applyPlan({ connector: h.connector, site: paused, plan }), FixBlocked);
  await assert.rejects(() => revertOperations({ connector: h.connector, site: paused, operations: [] }), FixBlocked);
  assert.equal(h.wp.writes.length, 0);
});

test('image alt: derives text from the filename, skips what it cannot derive', async (t) => {
  const h = await harness(fx => {
    fx.media.push({ id: 33, source_url: 'https://vapewizarddxb.com/wp-content/uploads/IMG_9999.jpg', alt_text: '', title: { rendered: 'IMG_9999' }, media_type: 'image', mime_type: 'image/jpeg' });
    fx.media.push({ id: 34, source_url: 'https://vapewizarddxb.com/wp-content/uploads/vaporesso-xros-4-mint.jpg', alt_text: '', title: { rendered: 'x' }, media_type: 'image', mime_type: 'image/jpeg' });
  });
  t.after(() => h.wp.close());
  const found = await h.check('image-alt');
  const plan = await planFix('set-image-alt', { connector: h.connector, site: h.site, findings: found.findings });
  const byId = Object.fromEntries(plan.ops.map(o => [o.target.id, o.after]));
  assert.equal(byId[34], 'Vaporesso xros 4 mint');
  assert.equal(byId[33], undefined, 'IMG_9999 yields nothing meaningful, so no op is planned');
  assert.ok(plan.ops.every(o => o.lowConfidence), 'filename-derived alt text is marked for review');

  const res = await applyPlan({ connector: h.connector, site: h.site, plan });
  assert.equal(res.failed.length, 0);
  assert.equal(h.wp.state.media.find(m => m.id === 34).alt_text, 'Vaporesso xros 4 mint');
  await revertOperations({ connector: h.connector, site: h.site, operations: res.applied });
  assert.equal(h.wp.state.media.find(m => m.id === 34).alt_text, '');
});

test('legacy links: rewrites content, reverts exactly, and re-check passes', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const found = await h.check('legacy-links', { legacyPrefixes: ['/shop/old-prefix/'] });
  const original = h.wp.state.posts[0].content;
  const plan = await planFix('rewrite-legacy-links', {
    connector: h.connector, site: h.site, findings: found.findings,
    ctx: { prefixReplacements: { '/shop/old-prefix/': '/product/' } },
  });
  assert.equal(plan.ops.length, 1);
  assert.equal(plan.ops[0].diffHint.hits, 1);
  assert.ok(plan.ops[0].after.includes('/product/xyz/'));

  const res = await applyPlan({ connector: h.connector, site: h.site, plan });
  assert.equal(res.applied.length, 1);
  assert.ok(!h.wp.state.posts[0].content.includes('/shop/old-prefix/'));
  assert.equal((await h.check('legacy-links', { legacyPrefixes: ['/shop/old-prefix/'] })).verdict, 'pass');

  await revertOperations({ connector: h.connector, site: h.site, operations: res.applied });
  assert.equal(h.wp.state.posts[0].content, original, 'content restored byte for byte');
});

test('a fix missing required input is blocked with a reason, not guessed', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const found = await h.check('author-identity');
  const plan = await planFix('set-author-name', { connector: h.connector, site: h.site, findings: found.findings });
  assert.equal(plan.ops.length, 0);
  assert.equal(plan.blocked.length, 2);
  assert.match(plan.blocked[0].reason, /No real name supplied/);
  assert.equal(h.wp.writes.length, 0, 'nothing was written while blocked');

  const plan2 = await planFix('set-author-name', {
    connector: h.connector, site: h.site, findings: found.findings,
    ctx: { authorNames: { 1: 'Ismail Hossain' }, defaultAuthorName: null },
  });
  assert.equal(plan2.ops.length, 1);
  assert.equal(plan2.blocked.length, 1, 'the account with no name supplied stays blocked');
  const res = await applyPlan({ connector: h.connector, site: h.site, plan: plan2 });
  assert.equal(h.wp.state.users[0].name, 'Ismail Hossain');
  assert.equal((await h.check('author-identity')).findings.length, 1, 'only the remaining placeholder is flagged');
});

test('thin archives and open registration round-trip', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const thin = await h.check('thin-archives');
  const plan = await planFix('noindex-thin-archive', { connector: h.connector, site: h.site, findings: thin.findings });
  assert.equal(plan.ops.length, 2);
  await applyPlan({ connector: h.connector, site: h.site, plan });
  assert.deepEqual(h.wp.state.categories.find(c => c.id === 41).meta.rank_math_robots, ['noindex', 'follow']);
  assert.equal((await h.check('thin-archives')).verdict, 'pass');

  const reg = await h.check('open-registration');
  const regPlan = await planFix('close-registration', { connector: h.connector, site: h.site, findings: reg.findings });
  const regRes = await applyPlan({ connector: h.connector, site: h.site, plan: regPlan });
  assert.equal(h.wp.state.settings.users_can_register, false);
  assert.equal((await h.check('open-registration')).verdict, 'pass');
  await revertOperations({ connector: h.connector, site: h.site, operations: regRes.applied });
  assert.equal(h.wp.state.settings.users_can_register, true);
});

test('an irreversible fix is labelled and refuses to revert', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const found = await h.check('revisions', { revisionCap: 10 });
  const plan = await planFix('purge-revisions', { connector: h.connector, site: h.site, findings: found.findings, ctx: { revisionKeep: 5 } });
  assert.equal(plan.ops[0].irreversible, true);
  assert.match(plan.ops[0].describe, /Delete 19 of 24 revisions/);
  const res = await applyPlan({ connector: h.connector, site: h.site, plan, ctx: { revisionKeep: 5 } });
  assert.equal(res.applied.length, 1);
  assert.equal(h.wp.state.posts[0].revisions, 5);
  const undo = await revertOperations({ connector: h.connector, site: h.site, operations: res.applied });
  assert.equal(undo.reverted.length, 0);
  assert.match(undo.failed[0].error, /irreversible/i);
});

test('a write that does not verify is reported as failed, not as applied', async (t) => {
  const h = await harness(); t.after(() => h.wp.close());
  const found = await h.check('canonical');
  const plan = await planFix('set-canonical', { connector: h.connector, site: h.site, findings: found.findings.slice(0, 1) });
  const liar = Object.create(h.connector);
  liar.updatePost = async () => ({ meta: { rank_math_canonical_url: 'something-else' } });
  const res = await applyPlan({ connector: liar, site: h.site, plan });
  assert.equal(res.applied.length, 0);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].error, /did not verify/);
});

test('one failing op does not abort the rest of the plan', async (t) => {
  // The default fixture's alt-less images are both camera filenames, which correctly plan nothing;
  // give the fixer two it can actually derive alt text from.
  const h = await harness(fx => {
    fx.media.push({ id: 35, source_url: 'https://vapewizarddxb.com/wp-content/uploads/yuoto-xxl-grape.jpg', alt_text: '', title: { rendered: 'a' }, media_type: 'image', mime_type: 'image/jpeg' });
    fx.media.push({ id: 36, source_url: 'https://vapewizarddxb.com/wp-content/uploads/vaporesso-luxe-x-pro.jpg', alt_text: '', title: { rendered: 'b' }, media_type: 'image', mime_type: 'image/jpeg' });
  });
  t.after(() => h.wp.close());
  const found = await h.check('image-alt');
  const plan = await planFix('set-image-alt', { connector: h.connector, site: h.site, findings: found.findings });
  assert.ok(plan.ops.length >= 2);
  const flaky = Object.create(h.connector);
  let n = 0;
  flaky.updateMedia = async (id, patch) => { if (n++ === 0) throw new Error('503 from origin'); return h.connector.updateMedia(id, patch); };
  const res = await applyPlan({ connector: flaky, site: h.site, plan });
  assert.equal(res.failed.length, 1);
  assert.equal(res.applied.length, plan.ops.length - 1);
  assert.match(res.failed[0].error, /503/);
});
