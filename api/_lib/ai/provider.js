// Which model drives AI reviews for an agency, and a client for it.
//
// Settings come from the agency row (set in the console under AI Settings, key encrypted at rest) or,
// when that row has no key, from the server environment: AI_PROVIDER, ANTHROPIC_API_KEY / OPENAI_API_KEY,
// AI_MODEL. Nothing here talks to a model until `complete()` is called.
import { createAnthropicClient } from './anthropic.js';
import { createOpenAiClient } from './openai.js';
import { decryptSecret, encryptSecret } from '../crypto.js';

export const PROVIDERS = ['anthropic', 'openai'];
export const DEFAULT_MODEL = { anthropic: 'claude-opus-5', openai: 'gpt-5' };

export function aiKeyAad(agencyId) { return `ai:${agencyId}`; }
export function sealAiKey(apiKey, agencyId) { return encryptSecret(apiKey, { aad: aiKeyAad(agencyId) }); }

/** Merge the stored row with the environment. `row.apiKey` is ciphertext. */
export function resolveAiConfig({ agencyId, row = null, env = process.env }) {
  const provider = row?.provider || env.AI_PROVIDER || 'anthropic';
  if (!PROVIDERS.includes(provider)) throw new Error(`unknown AI provider "${provider}"`);
  let apiKey = '', source = 'none';
  if (row?.apiKey) { apiKey = decryptSecret(row.apiKey, { aad: aiKeyAad(agencyId) }); source = 'agency'; }
  else {
    apiKey = provider === 'anthropic' ? (env.ANTHROPIC_API_KEY || '') : (env.OPENAI_API_KEY || '');
    if (apiKey) source = 'env';
  }
  const model = row?.model || env.AI_MODEL || DEFAULT_MODEL[provider];
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(env.AI_EFFORT) ? env.AI_EFFORT : 'medium';
  return { provider, model, apiKey, source, effort, autoApply: !!row?.autoApply, configured: !!apiKey };
}

export function createAiClient(config, { fetchImpl, sdk } = {}) {
  if (!config.apiKey) { const e = new Error('No AI API key is configured. Add one under AI Settings.'); e.status = 409; throw e; }
  return config.provider === 'openai'
    ? createOpenAiClient({ apiKey: config.apiKey, model: config.model, fetchImpl })
    : createAnthropicClient({ apiKey: config.apiKey, model: config.model, sdk, effort: config.effort });
}

/** One short round-trip to prove a key works. Returns { ok, model, error? }. */
export async function pingAi(client) {
  try {
    const res = await client.complete({ system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'ping' }], maxTokens: 32 });
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    return { ok: true, model: res.servedBy || client.model, reply: text.slice(0, 40) };
  } catch (e) {
    return { ok: false, model: client.model, error: e.message };
  }
}
