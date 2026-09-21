// Envelope encryption for site credentials. Ciphertext is all that ever reaches Postgres;
// the key lives only in the Vercel environment (ENCRYPTION_KEY), never in the browser or the repo.
//
// AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather than yielding garbage.
// Stored form:  v1.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;          // 96-bit nonce, the GCM standard
const KEY_BYTES = 32;

export function getKey(env = process.env) {
  const raw = env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}); generate one with: openssl rand -base64 32`);
  }
  return key;
}

const b64 = (buf) => buf.toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url');

/** Encrypt a JSON-serialisable credential bundle. `aad` binds the ciphertext to a row so it cannot be moved between sites. */
export function encryptSecret(value, { key = getKey(), aad = '' } = {}) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [VERSION, b64(iv), b64(cipher.getAuthTag()), b64(ct)].join('.');
}

export function decryptSecret(packed, { key = getKey(), aad = '' } = {}) {
  const parts = String(packed || '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('malformed ciphertext');
  const [, ivB, tagB, ctB] = parts;
  const decipher = createDecipheriv('aes-256-gcm', key, unb64(ivB));
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(unb64(tagB));
  const out = Buffer.concat([decipher.update(unb64(ctB)), decipher.final()]);   // throws if tampered
  return JSON.parse(out.toString('utf8'));
}

/** Never echo a stored credential back to a client; show this instead. */
export function maskSecret(s, keep = 4) {
  const str = String(s || '');
  if (str.length <= keep) return '•'.repeat(str.length);
  return '•'.repeat(Math.max(4, str.length - keep)) + str.slice(-keep);
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
