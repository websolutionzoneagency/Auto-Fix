// Small request/response helpers for the Vercel Node runtime.
import { timingSafeEqual } from 'node:crypto';

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;         // Vercel already parsed JSON
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { const e = new Error('invalid JSON body'); e.status = 400; throw e; }
}

/** Bearer-token check against RANKOPS_API_TOKEN. Constant-time compare; no token configured = locked. */
export function authorized(req) {
  const expected = process.env.RANKOPS_API_TOKEN || '';
  if (!expected) return false;
  const header = String(req.headers.authorization || '');
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
