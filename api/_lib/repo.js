// All SQL in one place. Every function takes the agency id explicitly — the API runs as the
// service role, which bypasses RLS, so scoping here is what keeps tenants apart on the server side.
import { withTx, getPool } from './db.js';
import { reduce, migrate, emptyState } from '../../js/store.js';

const q = async (sql, params) => (await getPool()).query(sql, params);

/* ---------- agencies / members ---------- */
export async function ensureAgency(agencyId, name = agencyId) {
  await q(`insert into agencies (id, name) values ($1, $2) on conflict (id) do nothing`, [agencyId, name]);
}
export async function membershipsOf(userId) {
  const { rows } = await q(`select agency_id, role from agency_members where user_id = $1 order by created_at`, [userId]);
  return rows.map(r => ({ agencyId: r.agency_id, role: r.role }));
}

/* ---------- console snapshot (event-sourced) ---------- */
export async function getSnapshot(agencyId) {
  const { rows } = await q(`select seq, state from snapshots where agency_id = $1`, [agencyId]);
  return rows.length ? { seq: Number(rows[0].seq), state: rows[0].state } : { seq: 0, state: null };
}
/** Fold one action into the snapshot under a row lock and append it to the log. */
export async function applyAction(agencyId, action, { origin = null, actor = null } = {}) {
  return withTx(async (c) => {
    const { rows } = await c.query(`select seq, state from snapshots where agency_id = $1 for update`, [agencyId]);
    const prev = rows.length ? migrate(rows[0].state) || emptyState() : emptyState();
    const seq = (rows.length ? Number(rows[0].seq) : 0) + 1;
    const next = reduce(prev, action);
    await c.query(`insert into actions (agency_id, seq, origin, actor, action) values ($1,$2,$3,$4,$5)`, [agencyId, seq, origin, actor, action]);
    await c.query(
      `insert into snapshots (agency_id, seq, state, updated_at) values ($1,$2,$3,now())
       on conflict (agency_id) do update set seq = excluded.seq, state = excluded.state, updated_at = now()`,
      [agencyId, seq, next]);
    return { seq, state: next };
  });
}
export async function actionsSince(agencyId, since, limit = 500) {
  const { rows } = await q(`select seq, origin, action from actions where agency_id = $1 and seq > $2 order by seq limit $3`, [agencyId, Math.max(0, since | 0), limit]);
  const head = await getSnapshot(agencyId);
  return { seq: head.seq, actions: rows.map(r => ({ seq: Number(r.seq), origin: r.origin, action: r.action })) };
}
export async function wipeAgency(agencyId) {
  await withTx(async (c) => {
    for (const t of ['fix_operations', 'findings', 'scan_jobs', 'site_connections', 'actions', 'snapshots']) {
      await c.query(`delete from ${t} where agency_id = $1`, [agencyId]);
    }
  });
}

/* ---------- connections (credentials column is ciphertext) ---------- */
export async function getConnection(agencyId, siteId, { withCredentials = false } = {}) {
  const cols = `id, agency_id, site_id, platform, base_url, seo_plugin, capabilities, paused, settings, last_test_at, created_at, updated_at${withCredentials ? ', credentials' : ''}`;
  const { rows } = await q(`select ${cols} from site_connections where agency_id = $1 and site_id = $2`, [agencyId, siteId]);
  return rows[0] ? rowToConnection(rows[0]) : null;
}
export async function upsertConnection(agencyId, siteId, { platform, baseUrl, credentials, seoPlugin, capabilities, settings }) {
  const { rows } = await q(
    `insert into site_connections (agency_id, site_id, platform, base_url, credentials, seo_plugin, capabilities, settings, last_test_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now())
     on conflict (agency_id, site_id) do update set
       platform = excluded.platform, base_url = excluded.base_url, credentials = excluded.credentials,
       seo_plugin = excluded.seo_plugin, capabilities = excluded.capabilities,
       settings = site_connections.settings || excluded.settings, last_test_at = now(), updated_at = now()
     returning id, agency_id, site_id, platform, base_url, seo_plugin, capabilities, paused, settings, last_test_at, created_at, updated_at`,
    [agencyId, siteId, platform, baseUrl, credentials, seoPlugin || null, capabilities || {}, settings || {}]);
  return rowToConnection(rows[0]);
}
export async function updateConnection(agencyId, siteId, patch) {
  const sets = [], vals = [agencyId, siteId];
  for (const [k, col] of [['paused', 'paused'], ['settings', 'settings'], ['capabilities', 'capabilities'], ['seoPlugin', 'seo_plugin']]) {
    if (patch[k] !== undefined) { vals.push(patch[k]); sets.push(`${col} = $${vals.length}`); }
  }
  if (patch.lastTestAt) sets.push(`last_test_at = now()`);
  if (!sets.length) return getConnection(agencyId, siteId);
  const { rows } = await q(`update site_connections set ${sets.join(', ')}, updated_at = now() where agency_id = $1 and site_id = $2
                            returning id, agency_id, site_id, platform, base_url, seo_plugin, capabilities, paused, settings, last_test_at, created_at, updated_at`, vals);
  return rows[0] ? rowToConnection(rows[0]) : null;
}
export async function deleteConnection(agencyId, siteId) {
  await q(`delete from site_connections where agency_id = $1 and site_id = $2`, [agencyId, siteId]);
}
function rowToConnection(r) {
  return { id: r.id, agencyId: r.agency_id, siteId: r.site_id, platform: r.platform, baseUrl: r.base_url, seoPlugin: r.seo_plugin,
           capabilities: r.capabilities || {}, paused: r.paused, settings: r.settings || {}, lastTestAt: r.last_test_at,
           createdAt: r.created_at, updatedAt: r.updated_at, ...(r.credentials !== undefined ? { credentials: r.credentials } : {}) };
}

/* ---------- AI settings (api_key column is ciphertext) ---------- */
export async function getAiSettings(agencyId) {
  const { rows } = await q(`select agency_id, provider, model, api_key, auto_apply, updated_at from agency_ai_settings where agency_id = $1`, [agencyId]);
  const r = rows[0];
  return r ? { agencyId: r.agency_id, provider: r.provider, model: r.model, apiKey: r.api_key, autoApply: r.auto_apply, updatedAt: r.updated_at } : null;
}
/** `apiKey` undefined keeps the stored key; null clears it; a string (ciphertext) replaces it. */
export async function upsertAiSettings(agencyId, { provider, model, apiKey, autoApply }) {
  const { rows } = await q(
    `insert into agency_ai_settings (agency_id, provider, model, api_key, auto_apply)
     values ($1, $2, $3, $4, $5)
     on conflict (agency_id) do update set
       provider = excluded.provider, model = excluded.model,
       api_key = case when $6 then agency_ai_settings.api_key else excluded.api_key end,
       auto_apply = excluded.auto_apply, updated_at = now()
     returning agency_id, provider, model, api_key, auto_apply, updated_at`,
    [agencyId, provider, model || null, apiKey === undefined ? null : apiKey, !!autoApply, apiKey === undefined]);
  const r = rows[0];
  return { agencyId: r.agency_id, provider: r.provider, model: r.model, apiKey: r.api_key, autoApply: r.auto_apply, updatedAt: r.updated_at };
}

/* ---------- scan queue ---------- */
export async function enqueueScan(agencyId, siteId, { checks = [], requestedBy = null } = {}) {
  const { rows } = await q(
    `insert into scan_jobs (agency_id, site_id, checks, pending, requested_by) values ($1,$2,$3,$3,$4) returning *`,
    [agencyId, siteId, checks, requestedBy]);
  return rowToJob(rows[0]);
}
export async function claimScanJob(leaseSeconds = 60) {
  const { rows } = await q(`select * from claim_scan_job($1)`, [leaseSeconds]);
  return rows[0] ? rowToJob(rows[0]) : null;
}
export async function getScanJob(agencyId, id) {
  const { rows } = await q(`select * from scan_jobs where agency_id = $1 and id = $2`, [agencyId, id]);
  return rows[0] ? rowToJob(rows[0]) : null;
}
export async function latestScanJob(agencyId, siteId) {
  const { rows } = await q(`select * from scan_jobs where agency_id = $1 and site_id = $2 order by created_at desc limit 1`, [agencyId, siteId]);
  return rows[0] ? rowToJob(rows[0]) : null;
}
export async function updateScanJob(id, patch) {
  const sets = [], vals = [id];
  const map = { status: 'status', pending: 'pending', error: 'error' };
  for (const [k, col] of Object.entries(map)) if (patch[k] !== undefined) { vals.push(patch[k]); sets.push(`${col} = $${vals.length}`); }
  if (patch.finished) sets.push(`finished_at = now()`);
  if (patch.releaseLease) sets.push(`lease_until = null`);
  const { rows } = await q(`update scan_jobs set ${sets.join(', ')} where id = $1 returning *`, vals);
  return rows[0] ? rowToJob(rows[0]) : null;
}
function rowToJob(r) {
  return { id: r.id, agencyId: r.agency_id, siteId: r.site_id, status: r.status, checks: r.checks || [], pending: r.pending || [],
           attempts: r.attempts, leaseUntil: r.lease_until, error: r.error, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at };
}

/* ---------- findings ---------- */
export async function insertFinding(agencyId, siteId, f) {
  const { rows } = await q(
    `insert into findings (agency_id, site_id, scan_id, check_id, item_ids, verdict, summary, note, evidence_url, details)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [agencyId, siteId, f.scanId || null, f.checkId, f.itemIds || [], f.verdict, f.summary || null, f.note || null, f.evidenceUrl || null, JSON.stringify(f.details || [])]);
  return rowToFinding(rows[0]);
}
/** Latest finding per check for a site — what the UI shows. */
export async function latestFindings(agencyId, siteId) {
  const { rows } = await q(
    `select distinct on (check_id) * from findings where agency_id = $1 and site_id = $2 order by check_id, created_at desc`,
    [agencyId, siteId]);
  return rows.map(rowToFinding);
}
export async function getFinding(agencyId, id) {
  const { rows } = await q(`select * from findings where agency_id = $1 and id = $2`, [agencyId, id]);
  return rows[0] ? rowToFinding(rows[0]) : null;
}
function rowToFinding(r) {
  return { id: r.id, agencyId: r.agency_id, siteId: r.site_id, scanId: r.scan_id, checkId: r.check_id, itemIds: r.item_ids || [], verdict: r.verdict,
           summary: r.summary, note: r.note, evidenceUrl: r.evidence_url, details: r.details || [], resolvedAt: r.resolved_at, createdAt: r.created_at };
}

/* ---------- fix operations ---------- */
export async function insertFixOps(agencyId, siteId, ops) {
  const out = [];
  for (const op of ops) {
    const { rows } = await q(
      `insert into fix_operations (agency_id, site_id, finding_id, fix_id, item_id, status, target, field, before_value, after_value, describe, irreversible, error, approved_by, applied_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
      [agencyId, siteId, op.findingId || null, op.fixId, op.itemId || null, op.status, JSON.stringify(op.target || {}), op.field || null,
       JSON.stringify(op.before ?? null), JSON.stringify(op.after ?? null), op.describe || null, !!op.irreversible, op.error || null, op.approvedBy || null,
       op.status === 'applied' ? new Date() : null]);
    out.push(rowToOp(rows[0]));
  }
  return out;
}
export async function listFixOps(agencyId, siteId, limit = 200) {
  const { rows } = await q(`select * from fix_operations where agency_id = $1 and site_id = $2 order by created_at desc limit $3`, [agencyId, siteId, limit]);
  return rows.map(rowToOp);
}
export async function getFixOps(agencyId, ids) {
  if (!ids.length) return [];
  const { rows } = await q(`select * from fix_operations where agency_id = $1 and id = any($2::uuid[])`, [agencyId, ids]);
  return rows.map(rowToOp);
}
export async function markFixOps(agencyId, ids, status, error = null) {
  if (!ids.length) return;
  await q(`update fix_operations set status = $3, error = $4, reverted_at = case when $3 = 'reverted' then now() else reverted_at end
           where agency_id = $1 and id = any($2::uuid[])`, [agencyId, ids, status, error]);
}
function rowToOp(r) {
  return { id: r.id, agencyId: r.agency_id, siteId: r.site_id, findingId: r.finding_id, fixId: r.fix_id, itemId: r.item_id, status: r.status,
           target: r.target || {}, field: r.field, before: r.before_value, after: r.after_value, describe: r.describe, irreversible: r.irreversible,
           error: r.error, approvedBy: r.approved_by, appliedAt: r.applied_at, revertedAt: r.reverted_at, createdAt: r.created_at };
}
