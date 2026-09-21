// Runs a scan job in time-boxed batches. A job's `pending` array is the work list; each batch pops
// checks off it until the budget runs out, then the next Cron tick (or the same request, for a small
// site) continues. Verdicts are written as findings AND folded into the console snapshot through the
// same reducer the UI uses, so checklist items, evidence and the audit log update like a human did it.
import { CHECKS } from './checks.js';
import { itemsForCheck, allCheckIds } from '../../js/automation.js';
import { itemLabel } from '../../js/model.js';
import * as repo from './repo.js';
import { buildConnector } from './connectors/index.js';

const ORIGIN = 'scanner';

export async function runScanBatch({ job, budgetMs = 40000, now = Date.now, log = () => {} }) {
  const started = now();
  const conn = await repo.getConnection(job.agencyId, job.siteId, { withCredentials: true });
  if (!conn) {
    return repo.updateScanJob(job.id, { status: 'failed', error: 'site is not connected', finished: true, releaseLease: true });
  }
  const connector = buildConnector(conn, { agencyId: job.agencyId });
  const ctx = { ...(conn.settings || {}), psiApiKey: process.env.PSI_API_KEY || conn.settings?.psiApiKey };
  let pending = job.pending.length ? [...job.pending] : (job.checks.length ? [...job.checks] : allCheckIds());
  const done = [];

  while (pending.length && now() - started < budgetMs) {
    const checkId = pending[0];
    const check = CHECKS[checkId];
    let result;
    try {
      result = check ? await check.run({ connector, site: { id: job.siteId, domain: conn.baseUrl }, ctx })
                     : { verdict: 'unknown', summary: `unknown check ${checkId}`, findings: [] };
    } catch (e) {
      result = { verdict: 'unknown', summary: `check crashed: ${e.message}`, findings: [] };
    }
    const itemIds = itemsForCheck(checkId);
    const finding = await repo.insertFinding(job.agencyId, job.siteId, {
      scanId: job.id, checkId, itemIds, verdict: result.verdict, summary: result.summary, note: result.note || null,
      evidenceUrl: result.evidenceUrl || null, details: result.findings || [],
    });
    await foldIntoSnapshot(job.agencyId, job.siteId, checkId, itemIds, result);
    done.push({ checkId, verdict: result.verdict, findingId: finding.id });
    pending = pending.slice(1);
    log(`${job.siteId} ${checkId} → ${result.verdict}`);
  }

  const finished = pending.length === 0;
  if (finished) {
    await repo.applyAction(job.agencyId, { type: 'audit/record', payload: {
      siteId: job.siteId, text: `Scan complete — ${done.length} checks run (${count(done, 'pass')} pass · ${count(done, 'fail')} fail · ${count(done, 'unknown')} could not run)`,
    } }, { origin: ORIGIN });
  }
  const updated = await repo.updateScanJob(job.id, {
    status: finished ? 'done' : 'queued', pending, finished, releaseLease: true,
  });
  return { ...updated, ran: done };
}

/** pass → item done (+evidence); fail → item pending (+log); unknown → leave it, log why. */
async function foldIntoSnapshot(agencyId, siteId, checkId, itemIds, result) {
  const label = CHECKS[checkId]?.label || checkId;
  for (const itemId of itemIds) {
    if (result.verdict === 'pass') {
      await repo.applyAction(agencyId, { type: 'item/set', payload: { siteId, itemId, state: 'done' } }, { origin: ORIGIN });
      if (result.evidenceUrl) await repo.applyAction(agencyId, { type: 'evidence/set', payload: { siteId, itemId, url: result.evidenceUrl } }, { origin: ORIGIN });
    } else if (result.verdict === 'fail') {
      await repo.applyAction(agencyId, { type: 'item/set', payload: { siteId, itemId, state: 'pending' } }, { origin: ORIGIN });
      await repo.applyAction(agencyId, { type: 'log/add', payload: { siteId, kind: 'audit', text: `${itemId} failed scan — ${result.summary}` } }, { origin: ORIGIN });
    } else {
      await repo.applyAction(agencyId, { type: 'log/add', payload: { siteId, kind: 'audit', text: `${itemId} not checked — ${result.summary} (${label})` } }, { origin: ORIGIN });
    }
  }
}

/** Cron entry point: claim jobs until the budget is spent. */
export async function drainQueue({ budgetMs = 50000, perJobMs = 40000, now = Date.now, log } = {}) {
  const started = now();
  const results = [];
  while (now() - started < budgetMs) {
    const job = await repo.claimScanJob(Math.ceil(perJobMs / 1000) + 30);
    if (!job) break;
    const remaining = budgetMs - (now() - started);
    results.push(await runScanBatch({ job, budgetMs: Math.min(perJobMs, remaining), now, log }));
  }
  return results;
}

function count(list, v) { return list.filter(x => x.verdict === v).length; }
export { itemLabel };
