// Who is calling, and which agency they act for.
//
// Two modes, checked in order:
//   1. Supabase JWT  — `Authorization: Bearer <access_token>` issued by Supabase Auth. Verified with
//      SUPABASE_JWT_SECRET (HS256, no dependency). The user's agency comes from agency_members.
//   2. Static token  — `RANKOPS_API_TOKEN`, single-agency mode for a deployment without Supabase Auth.
//      Maps to RANKOPS_AGENCY_ID. Kept so the console works before user accounts are set up.
import { createHmac, timingSafeEqual } from 'node:crypto';

export class AuthError extends Error {
  constructor(msg) { super(msg); this.name = 'AuthError'; this.status = 401; }
}

const b64url = (s) => Buffer.from(s, 'base64url');

export function verifySupabaseJwt(token, secret, { now = Date.now() } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new AuthError('malformed token');
  const [h, p, sig] = parts;
  let header, payload;
  try { header = JSON.parse(b64url(h)); payload = JSON.parse(b64url(p)); } catch { throw new AuthError('malformed token'); }
  if (header.alg !== 'HS256') throw new AuthError(`unsupported alg ${header.alg}`);
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = b64url(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new AuthError('bad signature');
  if (payload.exp && payload.exp * 1000 < now) throw new AuthError('token expired');
  if (!payload.sub) throw new AuthError('token has no subject');
  return { userId: payload.sub, email: payload.email || null, role: payload.role || 'authenticated' };
}

/** Test helper / local dev: mint a token the way Supabase would. */
export function signSupabaseJwt(payload, secret) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const h = enc({ alg: 'HS256', typ: 'JWT' }), p = enc({ role: 'authenticated', ...payload });
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

function bearer(req) {
  const h = String(req.headers?.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/**
 * Resolve the caller. Returns { userId|null, agencyId, role, mode }.
 * `lookupMembership(userId)` → [{ agencyId, role }] is injected so this stays DB-agnostic.
 */
export async function authenticate(req, { env = process.env, lookupMembership, requestedAgency } = {}) {
  const token = bearer(req);
  if (!token) throw new AuthError('missing bearer token');

  if (env.SUPABASE_JWT_SECRET && token.split('.').length === 3) {
    const user = verifySupabaseJwt(token, env.SUPABASE_JWT_SECRET);
    const memberships = lookupMembership ? await lookupMembership(user.userId) : [];
    if (!memberships.length) throw new AuthError('user belongs to no agency');
    const chosen = requestedAgency ? memberships.find(m => m.agencyId === requestedAgency) : memberships[0];
    if (!chosen) throw new AuthError('not a member of that agency');
    return { userId: user.userId, email: user.email, agencyId: chosen.agencyId, role: chosen.role, mode: 'supabase' };
  }

  const staticToken = env.RANKOPS_API_TOKEN || '';
  if (staticToken) {
    const a = Buffer.from(token), b = Buffer.from(staticToken);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { userId: null, email: null, agencyId: env.RANKOPS_AGENCY_ID || 'default', role: 'owner', mode: 'token' };
    }
  }
  throw new AuthError('unauthorized');
}

export function canWrite(auth) { return ['owner', 'admin', 'member'].includes(auth.role); }
export function canManage(auth) { return ['owner', 'admin'].includes(auth.role); }   // connections, kill switch
