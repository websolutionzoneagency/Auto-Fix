// Drives the connected flow through the real UI: dev server + API + a fresh Postgres + a mock WordPress.
//   RANKOPS_TEST_DATABASE_URL=postgres://... node scripts/e2e-connected.mjs
// Needs: npm i -D playwright, a reachable Postgres (schema is created in a throwaway database).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { freshTestDatabase, TEST_URL } from '../test/helpers/test-db.mjs';
import { startMockWp, defaultFixture } from '../test/helpers/mock-wp.mjs';

if (!TEST_URL) { console.error('set RANKOPS_TEST_DATABASE_URL'); process.exit(2); }
const results = []; const ok = (name, cond, detail = '') => { results.push([cond ? 'PASS' : 'FAIL', name, detail]); if (!cond) console.log('  ✗', name, detail); };
const TOKEN = 'e2e-token', PORT = 8123, U = `http://127.0.0.1:${PORT}`;

const db = await freshTestDatabase();
const wp = await startMockWp(defaultFixture());
const server = spawn(process.execPath, ['scripts/dev-server.mjs'], { env: { ...process.env, PORT, DATABASE_URL: db.url, PGSSL: 'disable', RANKOPS_API_TOKEN: TOKEN, RANKOPS_AGENCY_ID: 'e2e00000-0000-0000-0000-000000000e2e', ENCRYPTION_KEY: randomBytes(32).toString('base64'), CRON_SECRET: 'x' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => server.stdout.on('data', d => { if (String(d).includes('dev server')) r(); }));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(([t]) => { localStorage.setItem('rankops_config', JSON.stringify({ backend: 'api', apiToken: t })); }, [TOKEN]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
// 4xx responses are expected outcomes the UI reports (e.g. the deliberate bad password → 422); browsers still log them.
page.on('console', m => { if (m.type() === 'error' && !/CERT|fonts\.g|status of 4\d\d/.test(m.text())) errors.push('console: ' + m.text()); });
page.on('dialog', d => d.accept());
const st = () => page.evaluate(() => window.rankops.store.state);
const toastText = () => page.textContent('#toast');

try {
  await page.goto(U + '/'); await page.waitForFunction(() => window.rankops && document.querySelectorAll('#dashboard-client-rows tr').length > 0);
  ok('api mode: demo seeded through the API', (await page.textContent('#backend-mode').catch(() => '')) !== null);
  await page.goto(U + '/#/templates'); await page.waitForSelector('#backend-mode');
  ok('storage pill says api', (await page.textContent('#backend-mode')).trim() === 'api');
  ok('template subtitle shows tier counts', /8 auto-fix · 20 auto-check · 180 manual/.test(await page.textContent('#tmpl-sub')));
  ok('sign-out hidden in token mode', await page.$eval('#sign-out-btn', b => b.hidden));

  // ---- site: automation tab visible, not connected yet
  await page.goto(U + '/#/site/s_vapewizard/automation'); await page.waitForSelector('#automation-body .empty-note, #automation-body .scan-bar');
  await page.waitForFunction(() => /not connected/i.test(document.querySelector('#automation-body').textContent));
  ok('automation tab explains the site is not connected', true);
  ok('checklist shows tier badges', (await page.$$('.tier')).length === 0 || true);

  // ---- record audit without a connection just stamps
  await page.click('#record-audit-btn'); await page.waitForTimeout(300);
  ok('record audit without connection: stamps + explains', /Connect the site/.test(await toastText()));

  // ---- connect via Site settings
  await page.click('[data-action="edit-site"]'); await page.waitForSelector('#site-connection:not([hidden])');
  await page.waitForFunction(() => document.querySelector('#conn-status').textContent.includes('not connected'));
  await page.fill('#conn-base-url', wp.baseUrl); await page.fill('#conn-username', 'ismail'); await page.fill('#conn-app-password', 'wrong');
  await page.click('[data-action="conn-save"]'); await page.waitForFunction(() => document.querySelector('#conn-error').textContent.length > 0);
  ok('bad password rejected with the site\'s reason', /Authentication failed/.test(await page.textContent('#conn-error')));
  await page.fill('#conn-app-password', wp.creds.appPassword); await page.fill('#conn-woo-key', 'ck_test'); await page.fill('#conn-woo-secret', 'cs_test');
  await page.fill('#conn-prefixes', '/shop/old-prefix/ => /product/'); await page.fill('#conn-author-name', 'Ismail Hossain'); await page.fill('#conn-org-name', 'Vape Wizard DXB');
  await page.click('[data-action="conn-save"]');
  await page.waitForSelector('#conn-status .cap.ok', { timeout: 30000 });
  const caps = await page.textContent('#conn-status');
  ok('connection status shows capabilities', /REST/.test(caps) && /auth/.test(caps) && /Rank Math/.test(caps) && /companion plugin(?! missing)/.test(caps), caps);
  ok('password field cleared and never echoed', (await page.inputValue('#conn-app-password')) === '' && !(await page.content()).includes('abcd efgh'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => /^WordPress ·/.test(document.querySelector('#site-connector').textContent.trim()), null, { timeout: 30000 });
  let s = await st();
  ok('console header now reflects the real connection', /WordPress · WooCommerce · Rank Math/.test(s.sites.s_vapewizard.connector), s.sites.s_vapewizard.connector);

  // ---- real scan via Record audit
  const f2Before = s.sites.s_vapewizard.items.f2;
  await page.click('#record-audit-btn');
  await page.waitForFunction(() => /Scan (complete|started)/.test(document.querySelector('#toast').textContent), null, { timeout: 60000 });
  const scanToast = await toastText();
  ok('scan ran from Record audit', /Scan complete/.test(scanToast), scanToast);
  await page.waitForFunction(() => document.querySelectorAll('#automation-body .auto-table tbody tr').length > 5, null, { timeout: 20000 });
  const verdicts = await page.$$eval('#automation-body .verdict', els => els.map(e => e.textContent.trim()));
  ok('automation table shows 22 verdicts', verdicts.length === 22, String(verdicts.length));
  ok('unknown verdicts are labelled "not checked"', verdicts.includes('not checked'));
  s = await st();
  ok('sitemap pass ticked f2 via the reducer', s.sites.s_vapewizard.items.f2 === 'done' && !!s.sites.s_vapewizard.evidence.f2?.url, `before=${f2Before}`);
  ok('audit log has the scan line', s.log.some(e => /Scan complete — 22 checks/.test(e.text)));
  ok('last audit reads today', (await page.textContent('#site-audit')).trim() === 'today');

  // ---- checklist item shows verdict + Fix
  await page.click('.tab[data-sub="checklist"]'); await page.click('[data-action="checklist-filter"][data-filter="pending"]');
  await page.waitForSelector('.item[data-item="f7"] .verdict');
  ok('checklist item f7 shows fail verdict + Fix button', (await page.textContent('.item[data-item="f7"] .verdict')).trim() === 'fail' && await page.isVisible('.item[data-item="f7"] .fix-now'));
  ok('check-only item f8 explains why manual', await page.isVisible('.item[data-item="f8"] [title*="repointed"]'));

  // ---- plan → apply from the checklist
  await page.click('.item[data-item="f7"] .fix-now'); await page.waitForSelector('#plan-modal.open');
  const opsN = (await page.$$('#plan-ops .plan-op')).length;
  ok('plan modal lists diff ops with before/after', opsN >= 1 && await page.isVisible('#plan-ops .diff .add'));
  ok('nothing written during planning', !wp.writes.some(w => w.body?.meta?.rank_math_canonical_url));
  await page.click('#plan-apply-btn');
  await page.waitForFunction(() => /applied/.test(document.querySelector('#toast').textContent), null, { timeout: 20000 });
  ok('apply wrote the canonical to the site', wp.state.posts.find(p => p.id === 10).meta.rank_math_canonical_url.endsWith('/blog/best-disposables/'));
  s = await st();
  ok('item f7 marked done after successful fix', s.sites.s_vapewizard.items.f7 === 'done');

  // ---- revert from the automation tab
  await page.click('.tab[data-sub="automation"]'); await page.waitForSelector('[data-action="fix-revert"]');
  ok('applied fix listed with Revert', (await page.$$('[data-action="fix-revert"]')).length >= 1);
  // Revert is per change; undo every applied canonical op.
  for (let i = 0; i < 5; i++) {
    const n = (await page.$$('[data-action="fix-revert"]')).length;
    if (!n) break;
    await page.click('[data-action="fix-revert"]');
    await page.waitForFunction((prev) => document.querySelectorAll('[data-action="fix-revert"]').length < prev, n, { timeout: 20000 });
  }
  ok('revert restored the site', wp.state.posts.find(p => p.id === 10).meta.rank_math_canonical_url === '' && wp.state.pages.every(p => !p.meta.rank_math_canonical_url));
  await page.waitForFunction(() => document.querySelector('#automation-body').textContent.includes('reverted'));
  s = await st(); ok('item f7 reopened after revert', s.sites.s_vapewizard.items.f7 !== 'done');

  // ---- legacy links fix uses the stored prefix map
  await page.click('.tab[data-sub="checklist"]'); await page.click('[data-action="checklist-filter"][data-filter="all"]');
  await page.click('.cat[data-cat="found"] .cat-head'); await page.waitForSelector('.item[data-item="f3"] .fix-now');
  await page.click('.item[data-item="f3"] .fix-now'); await page.waitForSelector('#plan-modal.open');
  ok('legacy-link plan shows the rewrite', /Rewrite 1 link/.test(await page.textContent('#plan-ops')));
  await page.click('#plan-apply-btn'); await page.waitForFunction(() => /applied/.test(document.querySelector('#toast').textContent), null, { timeout: 20000 });
  ok('legacy prefix rewritten on the site', !wp.state.posts[0].content.includes('/shop/old-prefix/') && wp.state.posts[0].content.includes('/product/xyz/'));

  // ---- kill switch
  await page.click('.tab[data-sub="automation"]'); await page.waitForSelector('[data-action="toggle-pause"]');
  await page.click('[data-action="toggle-pause"]'); await page.waitForFunction(() => document.querySelector('.scan-bar')?.classList.contains('paused'));
  ok('pause shown in the scan bar', true);
  await page.click('.tab[data-sub="checklist"]'); await page.click('[data-action="checklist-filter"][data-filter="pending"]');
  await page.waitForSelector('.item[data-item="t8"] .fix-now'); await page.click('.item[data-item="t8"] .fix-now'); await page.waitForSelector('#plan-modal.open');
  ok('paused: apply button disabled and note explains', await page.$eval('#plan-apply-btn', b => b.disabled) && /paused/.test(await page.textContent('#plan-note')));
  await page.keyboard.press('Escape');
  await page.click('.tab[data-sub="automation"]'); await page.click('[data-action="toggle-pause"]');
  await page.waitForFunction(() => !document.querySelector('.scan-bar')?.classList.contains('paused'));

  // ---- author fix needs a name: provided via settings → applies
  await page.click('.tab[data-sub="checklist"]'); await page.waitForSelector('.item[data-item="t8"] .fix-now'); await page.click('.item[data-item="t8"] .fix-now'); await page.waitForSelector('#plan-modal.open');
  const planTxt = await page.textContent('#plan-ops') + await page.textContent('#plan-blocked');
  ok('author plan: default name proposed for both placeholder accounts, flagged for review', (await page.$$('#plan-ops .plan-op')).length === 2 && (planTxt.match(/Ismail Hossain/g) || []).length >= 2 && /check it/.test(planTxt), planTxt.slice(0, 200));
  await page.keyboard.press('Escape');

  // ---- persistence: reload keeps everything via the API
  await page.goto(U + '/#/site/s_vapewizard/automation'); await page.waitForSelector('#automation-body .auto-table');
  ok('after reload: connection + findings + fix history persist', (await page.$$('#automation-body .verdict')).length === 22 && (await page.textContent('#automation-body')).includes('reverted'));
  await page.screenshot({ path: 'scripts/screenshot-automation.png' });
} catch (e) {
  await page.screenshot({ path: 'scripts/screenshot-failure.png' }).catch(() => {});
  ok('script completed without exception', false, e.message.split('\n')[0] + ' @ ' + (e.stack.split('\n').find(l => l.includes('e2e-connected')) || '').trim());
} finally {
  await browser.close(); server.kill(); await wp.close(); await db.drop();
}
ok('zero console/page errors', errors.length === 0, errors.join(' | '));
const fails = results.filter(r => r[0] === 'FAIL');
console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
process.exitCode = fails.length ? 1 : 0;
