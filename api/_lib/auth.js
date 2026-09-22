// Who is calling, and which agency they act for.
//
// Two modes, checked in order:
//   1. Supabase JWT  — `Authorization: Bearer <access_token>` issued by Supabase Auth. Two signing
//      schemes, both verified without a dependency:
//        - ES256 (P-256), the default for projects using Supabase "JWT Signing Keys": verified against
//          the project's public JWKS at <SUPABASE_URL>/auth/v1/.well-known/jwks.json. SUPABASE_URL comes
//          from the env or, failing that, js/config.js (the console and the API are one deploy).
//        - HS256 with the legacy "JWT secret" (SUPABASE_JWT_SECRET) for older projects.
//      The user's agency comes from agency_members.
//   2. Static token  — `RANKOPS_API_TOKEN`, single-agency mode for a deployment without Supabase Auth.
//      Maps to RANKOPS_AGENCY_ID. Kept so the console works before user accounts are set up.
import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import { CONFIG } from '../../js/config.js';

export class AuthError extends Error {
  constructor(msg) { super(msg); this.name = 'AuthError'; this.status = 401; }
}

const b64url = (s) => Buffer.from(s, 'base64url');

function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new AuthError('malformed token');
  const [h, p, sig] = parts;
  let header, payload;
  try { header = JSON.parse(b64url(h)); payload = JSON.parse(b64url(p)); } catch { throw new AuthError('malformed token'); }
  return { h, p, sig, header, payload };
}

function claimsOf(payload, now) {
  if (payload.exp && payload.exp * 1000 < now) throw new AuthError('token expired');
  if (!payload.sub) throw new AuthError('token has no subject');
  return { userId: payload.sub, email: payload.email || null, role: payload.role || 'authenticated' };
}

/** Legacy scheme: HS256 with the project's shared JWT secret. */
export function verifySupabaseJwt(token, secret, { now = Date.now() } = {}) {
  const { h, p, sig, header, payload } = decodeJwt(token);
  if (header.alg !== 'HS256') throw new AuthError(`unsupported alg ${header.alg}`);
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = b64url(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new AuthError('bad signature');
  return claimsOf(payload, now);
}

/** Current scheme: ES256, verified against a JWKS ({ keys: [{ kty:'EC', crv:'P-256', kid, x, y }] }). */
export function verifySupabaseJwtJwks(token, jwks, { now = Date.now() } = {}) {
  const { h, p, sig, header, payload } = decodeJwt(token);
  if (header.alg !== 'ES256') throw new AuthError(`unsupported alg ${header.alg}`);
  const keys = (jwks?.keys || []).filter(k => k.kty === 'EC' && k.crv === 'P-256' && (!header.kid || !k.kid || k.kid === header.kid));
  if (!keys.length) throw new AuthError('no signing key for this token');
  const ok = keys.some(jwk => {
    try {
      const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
      return cryptoVerify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, b64url(sig));
    } catch { return false; }
  });
  if (!ok) throw new AuthError('bad signature');
  return claimsOf(payload, now);
}

/** Which project the API trusts. Env wins; the console's config is the same deploy, so it is a safe fallback. */
export function supabaseUrl(env = process.env) {
  return String(env.SUPABASE_URL || CONFIG?.supabase?.url || '').replace(/\/+$/, '');
}

// JWKS cache: one fetch per warm function instance, refreshed after an hour or when an unknown kid shows up.
const JWKS_TTL_MS = 60 * 60 * 1000;
let jwksCache = { url: '', keys: null, at: 0 };
export async function fetchJwks(url, { force = false, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (!force && jwksCache.url === url && jwksCache.keys && now - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new AuthError(`could not load signing keys (HTTP ${res.status})`);
  const jwks = await res.json();
  jwksCache = { url, keys: jwks, at: now };
  return jwks;
}
export function _resetJwksCache() { jwksCache = { url: '', keys: null, at: 0 }; }

/** Verify a Supabase access token with whichever scheme the project uses. */
export async function verifySupabaseToken(token, { env = process.env, fetchImpl } = {}) {
  const { header } = decodeJwt(token);
  if (header.alg === 'HS256') {
    if (!env.SUPABASE_JWT_SECRET) throw new AuthError('SUPABASE_JWT_SECRET is not set (token uses HS256)');
    return verifySupabaseJwt(token, env.SUPABASE_JWT_SECRET);
  }
  if (header.alg === 'ES256') {
    const base = supabaseUrl(env);
    if (!base) throw new AuthError('SUPABASE_URL is not set (token uses ES256)');
    const url = `${base}/auth/v1/.well-known/jwks.json`;
    let jwks = await fetchJwks(url, { fetchImpl });
    const known = (jwks.keys || []).some(k => !header.kid || k.kid === header.kid);
    if (!known) jwks = await fetchJwks(url, { force: true, fetchImpl });   // key rotated since we cached
    return verifySupabaseJwtJwks(token, jwks);
  }
  throw new AuthError(`unsupported alg ${header.alg}`);
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
export async function authenticate(req, { env = process.env, lookupMembership, requestedAgency, fetchImpl } = {}) {
  const token = bearer(req);
  if (!token) throw new AuthError('missing bearer token');

  const supabaseConfigured = !!(env.SUPABASE_JWT_SECRET || supabaseUrl(env));
  if (supabaseConfigured && token.split('.').length === 3) {
    const user = await verifySupabaseToken(token, { env, fetchImpl });
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
