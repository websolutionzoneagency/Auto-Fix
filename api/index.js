// RankOps API — one Vercel serverless function serving everything under /api.
// vercel.json rewrites /api/* here; the route is read from the request (see requestPath).
//
//   GET    /health                                  liveness (public)
//   GET    /me                                      who am I, which agency, what role
//
//   console state (event-sourced; the browser and this server run the same reducer)
//   GET    /state                                   → { seq, state }
//   PUT    /state         { state, origin }         replace snapshot (import / reset)
//   DELETE /state                                   wipe the agency
//   GET    /actions?since=N                         replay for other open consoles
//   POST   /actions       { action, origin }        apply one action
//
//   connections (admin role; credentials are encrypted before they touch Postgres)
//   GET    /sites/:id/connection                    status, capabilities, masked — never the secret
//   PUT    /sites/:id/connection  { platform, baseUrl, credentials{...}, settings{} }   test + save
//   DELETE /sites/:id/connection
//   POST   /sites/:id/connection/test
//   POST   /sites/:id/pause       { paused }        kill switch
//   PATCH  /sites/:id/settings    { ...settings }   fix inputs (author names, prefix map, org schema…)
//
//   scanning
//   POST   /sites/:id/scan        { checks?: [] }   enqueue, run the first batch inline, return the job
//   GET    /sites/:id/scan                          latest job
//   GET    /sites/:id/findings                      latest verdict per check
//
//   fixing (member role)
//   POST   /sites/:id/fixes/plan  { findingId }     dry run → ops with before/after; writes nothing
//   POST   /sites/:id/fixes/apply { findingId, opIndexes? }   plan again, write, store snapshots
//   POST   /sites/:id/fixes/revert { opIds }        restore snapshots
//   GET    /sites/:id/fixes                         history
//
//   AI review (any checklist item; the model inspects the site read-only and proposes edits)
//   GET    /ai/settings                             provider, model, whether a key is set (never the key)
//   PUT    /ai/settings   { provider, model, apiKey?, autoApply }   save (key encrypted) + test the key
//   POST   /sites/:id/ai/review  { itemId, apply? } run one review → finding (check "ai:<itemId>"); apply=true also applies its edits
//
//   GET    /cron/scan                               Vercel Cron: drain the queue (CRON_SECRET)
import * as repo from './_lib/repo.js';
import { json, readBody } from './_lib/http.js';
import { authenticate, AuthError, canWrite, canManage } from './_lib/auth.js';
import { migrate } from '../js/store.js';
import { ITEM_FIXES, ITEM_CHECKS, tierOf } from '../js/automation.js';
import { CHECKS } from './_lib/checks.js';
import { planFix, applyPlan, revertOperations, FixBlocked, FIXES } from './_lib/fixes.js';
import { buildConnector, buildConnectorFromPlain, sealCredentials, PLATFORMS } from './_lib/connectors/index.js';
import { runScanBatch, drainQueue } from './_lib/scanner.js';
import { maskSecret, encryptSecret, decryptSecret } from './_lib/crypto.js';
import { resolveAiConfig, createAiClient, pingAi, sealAiKey, PROVIDERS, DEFAULT_MODEL } from './_lib/ai/provider.js';
import { reviewItem } from './_lib/ai/agent.js';
import { itemLabel } from '../js/model.js';
import { ITEM_INDEX } from '../js/checklist.js';
import { timingSafeEqual } from 'node:crypto';

const inlineScanBudgetMs = () => Number(process.env.INLINE_SCAN_BUDGET_MS || 20000);
// Total wall-clock budget for one AI review request — auth, DB reads, the model loop, and the writes
// after it, all inside Vercel's own function limit (60s on Hobby; vercel.json's maxDuration must be
// raised too on Pro/Enterprise before this can usefully go higher). Vercel kills the function with no
// response at all if the limit is hit, so this stays comfortably under it and reserves time for the
// finding + log writes that happen after the model loop returns.
const aiReviewBudgetMs = () => Number(process.env.AI_REVIEW_BUDGET_MS || 45000);
const AI_REVIEW_MAX_ROUNDS = 8;   // requests one review may be continued across (≈ 6 min at the default budget)
const AI_REVIEW_WRITE_RESERVE_MS = 6000;
const AI_REVIEW_MIN_LOOP_MS = 5000;
/** What's left of the total budget for the model loop once the setup already spent and the reserve
 *  held back for the writes after it are both subtracted. Exported so the accounting is unit-tested
 *  without needing a live database. */
export function aiReviewLoopBudget(totalMs, elapsedMs, reserveMs = AI_REVIEW_WRITE_RESERVE_MS) {
  return Math.max(AI_REVIEW_MIN_LOOP_MS, totalMs - elapsedMs - reserveMs);
}
const AI_ORIGIN = 'ai';

/** A setup problem the operator can act on is named in the response; the full error is always in the
 *  function log too. Never echoes a connection string or its credentials, even in the fallback. */
export function explainServerError(e) {
  const msg = String(e?.message || '');
  const code = String(e?.code || '');
  if (/DATABASE_URL is not set/.test(msg)) return 'DATABASE_URL is not set on the server (Vercel → Settings → Environment Variables; redeploy after adding it)';
  if (/ENCRYPTION_KEY/.test(msg)) return msg;
  if (code === '42P01') return `database schema is not installed (${msg.replace(/^relation /, '')}): run db/supabase.sql in the Supabase SQL editor`;
  if (code === '42703') return `database schema is out of date (${msg}): re-run db/supabase.sql (and any files in db/migrations/) in the Supabase SQL editor`;
  if (code === '42501') return `the database role in DATABASE_URL lacks a needed privilege (${msg}) — use the Supabase pooler connection string for the "postgres" role, not a restricted one`;
  if (code === '23502' || code === '23514' || code === '22P02' || code === '23503') return `the database rejected the write (${msg})`;
  if (code === '28P01' || code === '28000') return 'the database rejected the credentials in DATABASE_URL (check the password; URL-encode special characters)';
  if (code === '3D000') return 'DATABASE_URL names a database that does not exist';
  if (['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(code) || /getaddrinfo|connect ETIMEDOUT|timeout expired/i.test(msg)) {
    return 'cannot reach the database host in DATABASE_URL (use the Supabase pooler connection string)';
  }
  if (/SSL|TLS|certificate/i.test(msg)) return 'TLS handshake with the database failed (DATABASE_URL should use the Supabase pooler, no sslmode override)';
  // Nothing named above matched — show a redacted version of the real message instead of hiding it,
  // so a setup problem this list doesn't yet know about is still actionable from the banner alone.
  return `internal error${msg ? ': ' + redact(msg).slice(0, 300) : ''}`;
}

/** Strip anything that looks like a credential (connection-string userinfo, bearer tokens, long
 *  base64/hex-ish runs) before a message is ever sent to the browser. */
function redact(s) {
  return String(s)
    .replace(/\/\/[^/\s@]+@/g, '//***@')                 // postgres://user:pass@host → postgres://***@host
    .replace(/\b[A-Za-z0-9+/_-]{24,}={0,2}\b/g, (m) => (/^[0-9a-f]{24,}$/i.test(m) || /[+/_=-]/.test(m) ? '***' : m));
}

/** The route under /api. Vercel hands the catch-all segments to the function under a query key that has
 *  varied between runtimes ("path", "...path", array or string), so fall back to the request URL itself. */
export function requestPath(req) {
  const q = req.query || {};
  const raw = q.path ?? q['...path'];
  if (raw !== undefined && raw !== null && String(raw) !== '') return '/' + [].concat(raw).join('/').replace(/^\/+/, '');
  let pathname = '/';
  try { pathname = new URL(req.url || '/', 'http://x').pathname; } catch { /* keep '/' */ }
  if (pathname.includes('[') || /^\/api\/index$/.test(pathname)) return '/';   // the rewrite target, not the request
  return pathname.replace(/^\/api(?=\/|$)/, '').replace(/\/+$/, '') || '/';
}

export default async function handler(req, res) {
  const handlerStartedAt = Date.now();
  const path = requestPath(req);
  const segs = path.split('/').filter(Boolean);
  const method = req.method;

  try {
    if (method === 'GET' && path === '/health') return json(res, 200, { ok: true });
    if (method === 'GET' && path === '/cron/scan') return cronScan(req, res);

    const auth = await authenticate(req, { lookupMembership: repo.membershipsOf, requestedAgency: req.headers['x-agency-id'] });
    const A = auth.agencyId;
    if (auth.mode === 'token') await repo.ensureAgency(A, process.env.RANKOPS_AGENCY_NAME || 'Web Solution Zone');

    if (method === 'GET' && path === '/me') return json(res, 200, { userId: auth.userId, email: auth.email, agencyId: A, role: auth.role, mode: auth.mode });

    /* ---------- console state ---------- */
    if (path === '/state') {
      if (method === 'GET') return json(res, 200, await repo.getSnapshot(A));
      if (method === 'PUT') {
        requireWrite(auth);
        const { state, origin } = await readBody(req);
        const clean = migrate(state);
        if (!clean) return json(res, 400, { error: 'invalid state (expected RankOps schema version 2)' });
        const { seq } = await repo.applyAction(A, { type: 'state/replace', payload: { state: clean } }, { origin, actor: auth.userId });
        return json(res, 200, { seq });
      }
      if (method === 'DELETE') { requireManage(auth); await repo.wipeAgency(A); res.statusCode = 204; return res.end(); }
    }
    if (path === '/actions') {
      if (method === 'GET') return json(res, 200, await repo.actionsSince(A, Number(req.query?.since || 0)));
      if (method === 'POST') {
        requireWrite(auth);
        const { action, origin } = await readBody(req);
        if (!action || typeof action.type !== 'string') return json(res, 400, { error: 'expected { action: { type, payload } }' });
        const { seq } = await repo.applyAction(A, action, { origin, actor: auth.userId });
        return json(res, 200, { seq });
      }
    }

    /* ---------- AI settings (agency-wide) ---------- */
    if (path === '/ai/settings') {
      if (method === 'GET') return json(res, 200, await aiSettingsView(A));
      if (method === 'PUT') {
        requireManage(auth);
        const body = await readBody(req);
        const provider = String(body.provider || 'anthropic');
        if (!PROVIDERS.includes(provider)) return json(res, 400, { error: `provider must be one of ${PROVIDERS.join(', ')}` });
        const model = String(body.model || '').trim() || DEFAULT_MODEL[provider];
        const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : undefined;
        const existing = await repo.getAiSettings(A);
        // '' clears the stored key (falls back to the server env); undefined keeps it; a value replaces it.
        const apiKey = key === undefined ? (existing?.provider === provider ? undefined : null) : (key ? sealAiKey(key, A) : null);
        const row = await repo.upsertAiSettings(A, { provider, model, apiKey, autoApply: !!body.autoApply });
        const view = await aiSettingsView(A, row);
        let test = null;
        if (view.configured) {
          const cfg = resolveAiConfig({ agencyId: A, row });
          test = await pingAi(createAiClient(cfg));
        }
        await repo.applyAction(A, { type: 'log/add', payload: { siteId: null, kind: 'system', text: `AI settings updated — ${provider} / ${model}${test ? (test.ok ? ' (key verified)' : ` (key test failed: ${test.error})`) : ' (no key)'}` } }, { origin: 'api', actor: auth.userId }).catch(() => {});
        return json(res, 200, { ...view, test });
      }
    }

    /* ---------- /sites/:id/... ---------- */
    if (segs[0] === 'sites' && segs[1]) {
      const siteId = segs[1];
      const sub = '/' + segs.slice(2).join('/');
      const snap = await repo.getSnapshot(A);
      const site = snap.state?.sites?.[siteId];
      if (!site) return json(res, 404, { error: `site ${siteId} not found in this agency` });

      if (sub === '/connection') {
        if (method === 'GET') return json(res, 200, await connectionView(A, siteId));
        if (method === 'PUT') { requireManage(auth); return json(res, 200, await saveConnection(A, siteId, await readBody(req))); }
        if (method === 'DELETE') { requireManage(auth); await repo.deleteConnection(A, siteId); res.statusCode = 204; return res.end(); }
      }
      if (sub === '/connection/test' && method === 'POST') {
        requireManage(auth);
        const conn = await repo.getConnection(A, siteId, { withCredentials: true });
        if (!conn) return json(res, 404, { error: 'not connected' });
        const result = await buildConnector(conn, { agencyId: A }).testConnection();
        await repo.updateConnection(A, siteId, { capabilities: result, seoPlugin: result.seoPlugin || conn.seoPlugin, lastTestAt: true });
        return json(res, 200, { ...(await connectionView(A, siteId)), test: result });
      }
      if (sub === '/pause' && method === 'POST') {
        requireManage(auth);
        const { paused } = await readBody(req);
        const conn = await repo.updateConnection(A, siteId, { paused: !!paused });
        if (!conn) return json(res, 404, { error: 'not connected' });
        await repo.applyAction(A, { type: 'log/add', payload: { siteId, kind: 'system', text: `Writes ${paused ? 'PAUSED' : 'resumed'} for this site` } }, { origin: 'api', actor: auth.userId });
        return json(res, 200, await connectionView(A, siteId));
      }
      if (sub === '/settings' && method === 'PATCH') {
        requireManage(auth);
        const conn = await repo.getConnection(A, siteId);
        if (!conn) return json(res, 404, { error: 'not connected' });
        const patch = await readBody(req);
        delete patch.psiApiKey;                                  // server env only
        const updated = await repo.updateConnection(A, siteId, { settings: { ...conn.settings, ...patch } });
        return json(res, 200, await connectionView(A, siteId, updated));
      }

      if (sub === '/scan') {
        if (method === 'GET') {
          // Polling a queued job continues it: the open console drives the scan to completion, so
          // finishing does not depend on Cron (Vercel Hobby allows only daily crons; that one is the safety net).
          let job = await repo.latestScanJob(A, siteId);
          if (job && job.status === 'queued' && canWrite(auth)) {
            const claimed = await repo.claimScanJob(90);
            if (claimed && claimed.id === job.id) job = await runScanBatch({ job: claimed, budgetMs: inlineScanBudgetMs() });
          }
          return json(res, 200, { job });
        }
        if (method === 'POST') {
          requireWrite(auth);
          const conn = await repo.getConnection(A, siteId);
          if (!conn) return json(res, 409, { error: 'Connect the site first (Site settings → Connection).' });
          const { checks = [] } = await readBody(req).catch(() => ({}));
          const bad = checks.filter(c => !CHECKS[c]);
          if (bad.length) return json(res, 400, { error: `unknown checks: ${bad.join(', ')}` });
          const job = await repo.enqueueScan(A, siteId, { checks, requestedBy: auth.userId });
          await repo.applyAction(A, { type: 'log/add', payload: { siteId, kind: 'audit', text: `Scan started — ${checks.length || 'all'} checks queued` } }, { origin: 'api', actor: auth.userId });
          // Run what fits in this request so a small site finishes immediately; Cron picks up the rest.
          const claimed = await repo.claimScanJob(90);
          const result = claimed && claimed.id === job.id ? await runScanBatch({ job: claimed, budgetMs: inlineScanBudgetMs() }) : job;
          return json(res, 202, { job: result, findings: await repo.latestFindings(A, siteId) });
        }
      }
      if (sub === '/findings' && method === 'GET') {
        const findings = await repo.latestFindings(A, siteId);
        return json(res, 200, { findings: findings.map(decorateFinding) });
      }

      if (sub === '/ai/review' && method === 'POST') {
        requireWrite(auth);
        const { itemId, apply = false, checkpoint = null } = await readBody(req);
        if (!ITEM_INDEX.has(itemId)) return json(res, 400, { error: `unknown checklist item "${itemId}"` });
        // A review too long for one request comes back as an encrypted checkpoint; the browser sends
        // it back to continue. Encryption binds it to this agency, site and item, and stops it being edited.
        const ckAad = `review:${A}:${siteId}:${itemId}`;
        let resume = null;
        if (checkpoint) {
          try { resume = decryptSecret(checkpoint, { aad: ckAad }); }
          catch { return json(res, 400, { error: 'this review can no longer be continued — start it again' }); }
          if ((resume.round || 0) >= AI_REVIEW_MAX_ROUNDS) return json(res, 400, { error: 'this review has been continued too many times — start it again' });
        }
        const conn = await repo.getConnection(A, siteId, { withCredentials: true });
        if (!conn) return json(res, 409, { error: 'Connect the site first (Site settings → Connection).' });
        const cfg = resolveAiConfig({ agencyId: A, row: await repo.getAiSettings(A) });
        if (!cfg.configured) return json(res, 409, { error: 'No AI API key is configured. Add one under AI Settings.' });
        const ai = createAiClient(cfg);
        const connector = buildConnector(conn, { agencyId: A });
        const siteCtx = { id: siteId, name: site.name, domain: site.domain, settingsSummary: settingsSummary(conn.settings) };
        // Charge everything already spent this request (auth, the connection/settings reads above)
        // against the total budget, and hold back a slice for the writes that follow the loop — so the
        // loop itself never runs long enough to make the whole request trip Vercel's own hard limit.
        const loopBudgetMs = aiReviewLoopBudget(aiReviewBudgetMs(), Date.now() - handlerStartedAt);
        let review;
        try {
          review = await reviewItem({ ai, connector, conn, site: siteCtx, itemId, budgetMs: loopBudgetMs, resume, log: (m) => console.log('[rankops ai]', m) });
        } catch (e) {
          if (e.status && e.status < 500 && !(e instanceof AuthError)) return json(res, 502, { error: `${cfg.provider} rejected the request: ${e.message}` });
          throw e;
        }
        if (review.pending) {
          const round = (resume?.round || 0) + 1;
          const lastTool = review.state.transcript[review.state.transcript.length - 1]?.tool || null;
          return json(res, 200, { pending: true, checkpoint: encryptSecret({ ...review.state, round }, { aad: ckAad }),
                                  progress: { round, turns: review.state.turns, toolCalls: review.state.transcript.length, lastTool } });
        }
        const finding = await repo.insertFinding(A, siteId, {
          checkId: `ai:${itemId}`, itemIds: [itemId], verdict: review.verdict, summary: review.summary,
          note: [review.rationale, review.rejected.length ? `Not proposed: ${review.rejected.map(r => r.reason).filter((v, i, a) => a.indexOf(v) === i).join('; ')}` : ''].filter(Boolean).join('\n'),
          evidenceUrl: review.evidenceUrl, details: review.ops.map(op => ({ ...op, itemId })),
        });
        await foldAiVerdict(A, siteId, itemId, review, auth.userId);
        let applied = null;
        const wantApply = !!apply || cfg.autoApply;
        if (wantApply && review.verdict === 'fail' && review.ops.length && !conn.paused) {
          applied = await applyFinding(A, siteId, finding.id, { auth, opIndexes: null });
        }
        return json(res, 200, { finding: decorateFinding(finding), review: { turns: review.turns, usage: review.usage, model: cfg.model, provider: cfg.provider, rejected: review.rejected }, applied });
      }

      if (sub === '/fixes' && method === 'GET') return json(res, 200, { operations: await repo.listFixOps(A, siteId) });
      if (sub === '/fixes/plan' && method === 'POST') {
        requireWrite(auth);
        const { findingId } = await readBody(req);
        const { plan } = await planFromFinding(A, siteId, findingId);
        return json(res, 200, { plan });
      }
      if (sub === '/fixes/apply' && method === 'POST') {
        requireWrite(auth);
        const { findingId, opIndexes } = await readBody(req);
        if ((await repo.getConnection(A, siteId))?.paused) return json(res, 423, { error: 'Writes are paused for this site (kill switch is on).' });
        const out = await applyFinding(A, siteId, findingId, { auth, opIndexes });
        if (out.error) return json(res, out.status, out);
        return json(res, 200, out);
      }
      if (sub === '/fixes/revert' && method === 'POST') {
        requireWrite(auth);
        const { opIds = [] } = await readBody(req);
        if ((await repo.getConnection(A, siteId))?.paused) return json(res, 423, { error: 'Writes are paused for this site (kill switch is on).' });
        const ops = (await repo.getFixOps(A, opIds)).filter(o => o.siteId === siteId && o.status === 'applied');
        if (!ops.length) return json(res, 400, { error: 'no applied operations with those ids' });
        const conn = await repo.getConnection(A, siteId, { withCredentials: true });
        if (!conn) return json(res, 409, { error: 'site is no longer connected' });
        const connector = buildConnector(conn, { agencyId: A });
        let result;
        try {
          result = await revertOperations({ connector, site: conn, seoPlugin: conn.seoPlugin || 'Rank Math',
            operations: ops.map(o => ({ ...o, snapshot: { field: o.field, value: o.before, irreversible: o.irreversible }, target: o.target })) });
        } catch (e) {
          if (e instanceof FixBlocked) return json(res, 423, { error: e.message });
          throw e;
        }
        await repo.markFixOps(A, result.reverted.map(o => o.id), 'reverted');
        for (const f of result.failed) await repo.markFixOps(A, [f.id], 'applied', f.error);
        await repo.applyAction(A, { type: 'log/add', payload: { siteId, kind: 'fix', text: `Rolled back ${result.reverted.length} change(s)${result.failed.length ? `; ${result.failed.length} could not be reverted` : ''}` } }, { origin: 'api', actor: auth.userId });
        for (const o of result.reverted) if (o.itemId) await repo.applyAction(A, { type: 'item/set', payload: { siteId, itemId: o.itemId, state: 'pending' } }, { origin: 'api', actor: auth.userId });
        return json(res, 200, { reverted: result.reverted.map(o => o.id), failed: result.failed.map(o => ({ id: o.id, error: o.error })) });
      }
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    if (e instanceof AuthError) { console.warn('[rankops api] 401', method, path, '-', e.message); return json(res, e.status, { error: e.message }); }
    if (e.status) { console.warn('[rankops api]', e.status, method, path, '-', e.message); return json(res, e.status, { error: e.message }); }
    console.error('[rankops api]', e);
    return json(res, 500, { error: explainServerError(e) });
  }
}

/* ---------- helpers ---------- */
function requireWrite(auth) { if (!canWrite(auth)) { const e = new Error('read-only role'); e.status = 403; throw e; } }
function requireManage(auth) { if (!canManage(auth)) { const e = new Error('admin role required'); e.status = 403; throw e; } }

async function connectionView(A, siteId, conn) {
  conn = conn || await repo.getConnection(A, siteId);
  if (!conn) return { connected: false };
  const { credentials, ...safe } = conn;
  return { connected: true, ...safe, platforms: PLATFORMS };
}

async function saveConnection(A, siteId, body) {
  const platform = body.platform || 'wordpress';
  if (!PLATFORMS.includes(platform)) { const e = new Error(`platform must be one of ${PLATFORMS.join(', ')}`); e.status = 400; throw e; }
  const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+$/i.test(baseUrl)) { const e = new Error('baseUrl must be like https://example.com'); e.status = 400; throw e; }
  const creds = body.credentials || {};
  if (platform === 'wordpress' && (!creds.username || !creds.appPassword)) { const e = new Error('username and appPassword are required'); e.status = 400; throw e; }
  const test = await buildConnectorFromPlain({ platform, baseUrl, credentials: creds }).testConnection();
  if (!test.ok) { const e = new Error(`connection test failed: ${test.errors.join('; ')}`); e.status = 422; e.test = test; throw e; }
  const sealed = sealCredentials(creds, A, siteId);
  const conn = await repo.upsertConnection(A, siteId, { platform, baseUrl, credentials: sealed, seoPlugin: test.seoPlugin, capabilities: test, settings: body.settings || {} });
  await repo.applyAction(A, { type: 'site/update', payload: { id: siteId, patch: { connector: [platform === 'wordpress' ? 'WordPress' : platform, test.wooOk ? 'WooCommerce' : null, test.seoPlugin].filter(Boolean).join(' · ') } } }, { origin: 'api' });
  await repo.applyAction(A, { type: 'log/add', payload: { siteId, kind: 'site', text: `Connected to ${baseUrl} as ${test.user?.name || creds.username}${test.companionPlugin ? ' (companion plugin present)' : ' — companion plugin not installed'}` } }, { origin: 'api' });
  return { ...(await connectionView(A, siteId, conn)), test, credentialsMasked: { username: creds.username, appPassword: maskSecret(creds.appPassword), wooKey: creds.wooKey ? maskSecret(creds.wooKey) : null } };
}

async function planFromFinding(A, siteId, findingId) {
  const finding = await repo.getFinding(A, findingId);
  if (!finding || finding.siteId !== siteId) { const e = new Error('finding not found'); e.status = 404; throw e; }
  const isAi = finding.checkId.startsWith('ai:');
  const itemId = finding.itemIds.find(i => ITEM_FIXES[i]);
  const fixId = isAi ? 'ai-edit' : (itemId ? ITEM_FIXES[itemId] : null);
  if (!fixId) { const e = new Error(`no automatic fix for ${finding.checkId} (tier: ${finding.itemIds.map(tierOf).join(',')})`); e.status = 422; throw e; }
  if (isAi && !finding.details.length) { const e = new Error('the AI review proposed no edits for this item'); e.status = 422; throw e; }
  const conn = await repo.getConnection(A, siteId, { withCredentials: true });
  if (!conn) { const e = new Error('site is not connected'); e.status = 409; throw e; }
  const connector = buildConnector(conn, { agencyId: A });
  const plan = await planFix(fixId, { connector, site: { id: siteId, name: conn.settings?.organizationName, domain: new URL(conn.baseUrl).host, paused: conn.paused },
    findings: finding.details, ctx: conn.settings, seoPlugin: conn.seoPlugin || 'Rank Math' });
  return { plan: { ...plan, findingId, paused: conn.paused }, conn, connector, finding };
}

/** Plan + apply every (or the chosen) op of a finding; the shared path for the review modal and auto-apply. */
async function applyFinding(A, siteId, findingId, { auth, opIndexes }) {
  const { plan, conn, connector, finding } = await planFromFinding(A, siteId, findingId);
  const chosen = Array.isArray(opIndexes) && opIndexes.length ? plan.ops.filter((_, i) => opIndexes.includes(i)) : plan.ops;
  if (!chosen.length) return { error: 'nothing to apply', status: 400, plan };
  let result;
  try {
    result = await applyPlan({ connector, site: { ...conn, paused: conn.paused }, plan: { ...plan, ops: chosen }, ctx: conn.settings, seoPlugin: conn.seoPlugin || 'Rank Math' });
  } catch (e) {
    if (e instanceof FixBlocked) return { error: e.message, status: 423 };
    throw e;
  }
  const stored = await repo.insertFixOps(A, siteId, [
    ...result.applied.map(op => ({ ...opRow(op, finding), status: 'applied', before: op.snapshot?.value ?? op.before, approvedBy: auth.userId })),
    ...result.failed.map(op => ({ ...opRow(op, finding), status: 'failed', error: op.error, approvedBy: auth.userId })),
  ]);
  const label = plan.fixId === 'ai-edit' ? `AI edits for ${plan.itemId}` : (FIXES[plan.fixId]?.label || plan.fixId);
  await repo.applyAction(A, { type: 'log/add', payload: { siteId, kind: 'fix', text: `${label} — ${result.applied.length} applied${result.failed.length ? `, ${result.failed.length} failed` : ''}` } }, { origin: 'api', actor: auth.userId });
  // A fully successful fix verifies the item; a re-scan will confirm from the outside.
  if (result.applied.length && !result.failed.length && plan.itemId) {
    await repo.applyAction(A, { type: 'item/set', payload: { siteId, itemId: plan.itemId, state: 'done' } }, { origin: 'api', actor: auth.userId });
  }
  return { applied: stored.filter(o => o.status === 'applied'), failed: stored.filter(o => o.status === 'failed'), plan };
}

/** AI verdicts move items the way the scanner's do: pass → done (+evidence), fail → pending (+log), unknown → log only. */
async function foldAiVerdict(A, siteId, itemId, review, actor) {
  const meta = { origin: AI_ORIGIN, actor };
  if (review.verdict === 'pass') {
    await repo.applyAction(A, { type: 'item/set', payload: { siteId, itemId, state: 'done' } }, meta);
    if (review.evidenceUrl) await repo.applyAction(A, { type: 'evidence/set', payload: { siteId, itemId, url: review.evidenceUrl } }, meta);
    await repo.applyAction(A, { type: 'log/add', payload: { siteId, kind: 'audit', text: `${itemId} passed AI review — ${review.summary}` } }, meta);
  } else if (review.verdict === 'fail') {
    await repo.applyAction(A, { type: 'item/set', payload: { siteId, itemId, state: 'pending' } }, meta);
    await repo.applyAction(A, { type: 'log/add', payload: { siteId, kind: 'audit', text: `${itemId} failed AI review — ${review.summary}${review.ops.length ? ` (${review.ops.length} edit${review.ops.length === 1 ? '' : 's'} proposed)` : ''}` } }, meta);
  } else {
    await repo.applyAction(A, { type: 'log/add', payload: { siteId, kind: 'audit', text: `${itemId} not decided by AI review — ${review.summary}` } }, meta);
  }
}

async function aiSettingsView(A, row) {
  row = row || await repo.getAiSettings(A);
  const cfg = resolveAiConfig({ agencyId: A, row });
  return { provider: cfg.provider, model: cfg.model, configured: cfg.configured, keySource: cfg.source, keyMasked: cfg.apiKey ? maskSecret(cfg.apiKey) : null,
           autoApply: cfg.autoApply, providers: PROVIDERS, defaultModels: DEFAULT_MODEL, updatedAt: row?.updatedAt || null };
}

function settingsSummary(settings = {}) {
  const parts = [];
  if (settings.organizationName) parts.push(`business name "${settings.organizationName}"`);
  if (settings.defaultAuthorName) parts.push(`default author "${settings.defaultAuthorName}"`);
  if (settings.allowedDomains?.length) parts.push(`allowed outbound domains ${settings.allowedDomains.join(', ')}`);
  if (settings.notes) parts.push(String(settings.notes).slice(0, 500));
  return parts.join('; ');
}

function opRow(op, finding) {
  return { findingId: finding.id, fixId: op.fixId, itemId: op.itemId, target: op.target, field: op.field, before: op.before, after: op.after, describe: op.describe, irreversible: !!op.irreversible };
}

function decorateFinding(f) {
  if (f.checkId.startsWith('ai:')) {
    const itemId = f.checkId.slice(3);
    return { ...f, label: `AI review: ${itemLabel(itemId)}`, fixId: f.verdict === 'fail' && f.details.length ? 'ai-edit' : null, tier: 'ai', ai: true };
  }
  const fixable = f.itemIds.some(i => ITEM_FIXES[i]);
  return { ...f, label: CHECKS[f.checkId]?.label || f.checkId, fixId: fixable ? ITEM_FIXES[f.itemIds.find(i => ITEM_FIXES[i])] : null, tier: fixable ? 'auto' : 'check' };
}

async function cronScan(req, res) {
  const secret = process.env.CRON_SECRET || '';
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) return json(res, 401, { error: 'unauthorized' });
  const results = await drainQueue({ budgetMs: Number(process.env.CRON_BUDGET_MS || 50000) });
  return json(res, 200, { jobs: results.map(r => ({ id: r.id, siteId: r.siteId, status: r.status, ran: r.ran?.length || 0, pending: r.pending?.length || 0 })) });
}
