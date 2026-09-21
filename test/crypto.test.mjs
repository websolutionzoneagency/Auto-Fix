import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret, getKey, maskSecret } from '../api/_lib/crypto.js';

const key = randomBytes(32);

test('round-trips a credential bundle', () => {
  const creds = { username: 'ismail', appPassword: 'abcd efgh ijkl mnop', wooKey: 'ck_123', wooSecret: 'cs_456' };
  const packed = encryptSecret(creds, { key, aad: 'site:s_vapewizard' });
  assert.match(packed, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.ok(!packed.includes('abcd'), 'plaintext never appears in the stored form');
  assert.deepEqual(decryptSecret(packed, { key, aad: 'site:s_vapewizard' }), creds);
});

test('ciphertext is bound to its row and rejects tampering', () => {
  const packed = encryptSecret({ appPassword: 'secret' }, { key, aad: 'site:A' });
  assert.throws(() => decryptSecret(packed, { key, aad: 'site:B' }), /unable to authenticate|unsupported state/i);
  assert.throws(() => decryptSecret(packed, { key: randomBytes(32), aad: 'site:A' }), /unable to authenticate|unsupported state/i);
  const parts = packed.split('.');
  const ct = Buffer.from(parts[3], 'base64url'); ct[0] ^= 0xff;
  const flipped = [parts[0], parts[1], parts[2], ct.toString('base64url')].join('.');
  assert.throws(() => decryptSecret(flipped, { key, aad: 'site:A' }), /unable to authenticate|unsupported state/i);
  assert.throws(() => decryptSecret('garbage', { key }), /malformed ciphertext/);
});

test('each encryption uses a fresh nonce', () => {
  const a = encryptSecret({ x: 1 }, { key }), b = encryptSecret({ x: 1 }, { key });
  assert.notEqual(a, b, 'identical plaintext must not produce identical ciphertext');
});

test('getKey validates the env var', () => {
  assert.throws(() => getKey({}), /ENCRYPTION_KEY is not set/);
  assert.throws(() => getKey({ ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }), /must decode to 32 bytes/);
  assert.equal(getKey({ ENCRYPTION_KEY: key.toString('base64') }).length, 32);
});

test('maskSecret keeps only a tail', () => {
  assert.equal(maskSecret('ck_1234567890abcd'), '•••••••••••••abcd');
  assert.ok(!maskSecret('supersecretvalue').includes('supersecret'));
});
