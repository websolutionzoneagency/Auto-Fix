// RankOps API — Vercel serverless function (catch-all under /api).
//
//   GET    /api/health                 liveness, no auth
//   GET    /api/state                  → { seq, state }
//   PUT    /api/state  { state, origin }  replace the whole snapshot (import / reset)   → { seq }
//   DELETE /api/state                  wipe the agency's data                          → 204
//   POST   /api/actions { action, origin }  apply one reducer action server-side       → { seq }
//   GET    /api/actions?since=<seq>    actions after <seq>, for other tabs to replay   → { seq, actions }
//
// All routes except /health require  Authorization: Bearer <RANKOPS_API_TOKEN>.
// The reducer is the same module the browser runs (js/store.js), so server and client can never
// disagree about what an action means.
import * as db from './_lib/db.js';
import { json, readBody, authorized } from './_lib/http.js';
import { reduce, migrate, emptyState } from '../js/store.js';

const AGENCY = process.env.RANKOPS_AGENCY_ID || 'default';
const MAX_REPLAY = 500;

/** `deps` lets tests inject an in-memory database; Vercel calls handler(req, res) and gets the real one. */
export default async function handler(req, res, deps = db) {
  const { getSnapshot, applyAction, actionsSince, wipe } = makeApi(deps);
  const path = '/' + [].concat(req.query?.path || []).join('/');
  if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true, agency: AGENCY });
  if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });

  try {
    if (path === '/state') {
      if (req.method === 'GET') return json(res, 200, await getSnapshot());
      if (req.method === 'PUT') {
        const { state, origin } = await readBody(req);
        const clean = migrate(state);
        if (!clean) return json(res, 400, { error: 'invalid state (expected RankOps schema version 2)' });
        return json(res, 200, { seq: await applyAction({ type: 'state/replace', payload: { state: clean } }, origin) });
      }
      if (req.method === 'DELETE') { await wipe(); res.statusCode = 204; return res.end(); }
    }
    if (path === '/actions') {
      if (req.method === 'GET') return json(res, 200, await actionsSince(Number(req.query?.since || 0)));
      if (req.method === 'POST') {
        const { action, origin } = await readBody(req);
        if (!action || typeof action.type !== 'string') return json(res, 400, { error: 'expected { action: { type, payload } }' });
        return json(res, 200, { seq: await applyAction(action, origin) });
      }
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[rankops api]', e);
    return json(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
  }
}

export function makeApi({ getPool, withTx }) {
  const query = async (sql, params) => (await getPool()).query(sql, params);

  async function getSnapshot() {
    const { rows } = await query('SELECT seq, state FROM snapshots WHERE agency_id = $1', [AGENCY]);
    if (!rows.length) return { seq: 0, state: null };          // null → the browser seeds demo data and PUTs it back
    return { seq: Number(rows[0].seq), state: rows[0].state };
  }

  /** Fold one action into the snapshot under a row lock; append it to the log. Returns the new seq. */
  async function applyAction(action, origin) {
    return withTx(async (c) => {
      await c.query('INSERT INTO agencies (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [AGENCY]);
      const { rows } = await c.query('SELECT seq, state FROM snapshots WHERE agency_id = $1 FOR UPDATE', [AGENCY]);
      const prev = rows.length ? migrate(rows[0].state) || emptyState() : emptyState();
      const seq = (rows.length ? Number(rows[0].seq) : 0) + 1;
      const next = reduce(prev, action);
      await c.query('INSERT INTO actions (agency_id, seq, origin, action) VALUES ($1, $2, $3, $4)', [AGENCY, seq, origin || null, action]);
      await c.query(
        `INSERT INTO snapshots (agency_id, seq, state, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (agency_id) DO UPDATE SET seq = EXCLUDED.seq, state = EXCLUDED.state, updated_at = now()`,
        [AGENCY, seq, next],
      );
      return seq;
    });
  }

  async function actionsSince(since) {
    const { rows } = await query(
      'SELECT seq, origin, action FROM actions WHERE agency_id = $1 AND seq > $2 ORDER BY seq LIMIT $3',
      [AGENCY, Math.max(0, since | 0), MAX_REPLAY],
    );
    const { rows: head } = await query('SELECT seq FROM snapshots WHERE agency_id = $1', [AGENCY]);
    return { seq: head.length ? Number(head[0].seq) : 0, actions: rows.map(r => ({ seq: Number(r.seq), origin: r.origin, action: r.action })) };
  }

  async function wipe() {
    await withTx(async (c) => {
      await c.query('DELETE FROM actions WHERE agency_id = $1', [AGENCY]);
      await c.query('DELETE FROM snapshots WHERE agency_id = $1', [AGENCY]);
    });
  }

  return { getSnapshot, applyAction, actionsSince, wipe };
}
