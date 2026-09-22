// JWT verification without a database: the ES256 (JWKS) path Supabase projects use by default now,
// the legacy HS256 path, and the dispatcher that picks between them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  verifySupabaseJwt, verifySupabaseJwtJwks, verifySupabaseToken, signSupabaseJwt, authenticate, _resetJwksCache,
} from '../api/_lib/auth.js';

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'ES256', use: 'sig' };
const jwks = { keys: [jwk] };
const exp = Math.floor(Date.now() / 1000) + 600;

function signEs256(payload, key = privateKey, kid = 'key-1') {
  const h = enc({ alg: 'ES256', typ: 'JWT', kid }), p = enc({ role: 'authenticated', ...payload });
  const sig = sign('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${h}.${p}.${sig}`;
}

test('ES256 token verifies against the JWKS', () => {
  const u = verifySupabaseJwtJwks(signEs256({ sub: 'u1', email: 'a@x', exp }), jwks);
  assert.deepEqual(u, { userId: 'u1', email: 'a@x', role: 'authenticated' });
});

test('ES256 token from another key is rejected', () => {
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  assert.throws(() => verifySupabaseJwtJwks(signEs256({ sub: 'u1', exp }, other), jwks), /bad signature/);
  assert.throws(() => verifySupabaseJwtJwks(signEs256({ sub: 'u1', exp }, privateKey, 'unknown-kid'), jwks), /no signing key/);
  assert.throws(() => verifySupabaseJwtJwks(signEs256({ sub: 'u1', exp: exp - 1200 }), jwks), /expired/);
});

test('HS256 path still works and rejects ES256', () => {
  assert.equal(verifySupabaseJwt(signSupabaseJwt({ sub: 'u2', exp }, 's'), 's').userId, 'u2');
  assert.throws(() => verifySupabaseJwt(signEs256({ sub: 'u1', exp }), 's'), /unsupported alg ES256/);
});

test('verifySupabaseToken fetches the JWKS once and refetches on an unknown kid', async () => {
  _resetJwksCache();
  const env = { SUPABASE_URL: 'https://proj.supabase.co/' };
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    assert.equal(url, 'https://proj.supabase.co/auth/v1/.well-known/jwks.json');
    return { ok: true, json: async () => jwks };
  };
  assert.equal((await verifySupabaseToken(signEs256({ sub: 'u1', exp }), { env, fetchImpl })).userId, 'u1');
  assert.equal((await verifySupabaseToken(signEs256({ sub: 'u1', exp }), { env, fetchImpl })).userId, 'u1');
  assert.equal(calls, 1);
  await assert.rejects(verifySupabaseToken(signEs256({ sub: 'u1', exp }, privateKey, 'rotated'), { env, fetchImpl }), /no signing key/);
  assert.equal(calls, 2);
  // Without SUPABASE_URL the API falls back to the project the console is pointed at (js/config.js).
  calls = 0;
  const seen = [];
  const fetchSeen = async (url) => { seen.push(url); return { ok: true, json: async () => jwks }; };
  _resetJwksCache();
  await verifySupabaseToken(signEs256({ sub: 'u1', exp }), { env: {}, fetchImpl: fetchSeen });
  assert.match(seen[0], /^https:\/\/[a-z]+\.supabase\.co\/auth\/v1\/\.well-known\/jwks\.json$/);
  await assert.rejects(verifySupabaseToken(signSupabaseJwt({ sub: 'u1', exp }, 's'), { env, fetchImpl }), /SUPABASE_JWT_SECRET/);
});

test('authenticate accepts an ES256 user with a membership', async () => {
  _resetJwksCache();
  const env = { SUPABASE_URL: 'https://proj.supabase.co' };
  const fetchImpl = async () => ({ ok: true, json: async () => jwks });
  const req = { headers: { authorization: 'Bearer ' + signEs256({ sub: 'u1', exp }) } };
  const auth = await authenticate(req, { env, fetchImpl, lookupMembership: async () => [{ agencyId: 'ag', role: 'owner' }] });
  assert.deepEqual(auth, { userId: 'u1', email: null, agencyId: 'ag', role: 'owner', mode: 'supabase' });
  await assert.rejects(authenticate(req, { env, fetchImpl, lookupMembership: async () => [] }), /belongs to no agency/);
});

test('server errors are explained when they are a setup problem', async () => {
  const { explainServerError } = await import('../api/[...path].js');
  assert.match(explainServerError(new Error('DATABASE_URL is not set')), /DATABASE_URL is not set/);
  assert.match(explainServerError(Object.assign(new Error('relation "snapshots" does not exist'), { code: '42P01' })), /db\/supabase\.sql/);
  assert.match(explainServerError(Object.assign(new Error('password authentication failed'), { code: '28P01' })), /credentials/);
  assert.match(explainServerError(Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' })), /cannot reach/);
  assert.equal(explainServerError(new Error('postgres://user:secret@host/db exploded')), 'internal error');
});
