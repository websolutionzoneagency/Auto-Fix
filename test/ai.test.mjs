// The AI review layer without a real model: a scripted fake client drives the agent loop against the
// mock WordPress site, so the tests pin down what the model may and may not make the console do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startMockWp, defaultFixture } from './helpers/mock-wp.mjs';
import { WordPressConnector } from '../api/_lib/connectors/wordpress.js';
import { reviewItem, TOOLS, safeUrl, stripTags } from '../api/_lib/ai/agent.js';
import { validateOp, readField } from '../api/_lib/ai/edits.js';
import { planFix, applyPlan, revertOperations } from '../api/_lib/fixes.js';
import { toOpenAiMessages, createOpenAiClient } from '../api/_lib/ai/openai.js';
import { createAnthropicClient } from '../api/_lib/ai/anthropic.js';
import { resolveAiConfig, sealAiKey, pingAi } from '../api/_lib/ai/provider.js';

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || randomBytes(32).toString('base64');

let wp, connector;
const conn = () => ({ baseUrl: wp.baseUrl, seoPlugin: 'Rank Math', capabilities: { wooOk: true } });
const site = { id: 's1', name: 'Vape Wizard DXB', domain: 'vapewizarddxb.com', settingsSummary: '' };

test.before(async () => {
  wp = await startMockWp(defaultFixture());
  connector = new WordPressConnector({ baseUrl: wp.baseUrl, ...wp.creds });
});
test.after(async () => { await wp.close(); });

/** A fake model: each call returns the next scripted turn; tool calls it makes are executed for real. */
function scripted(turns) {
  const calls = [];
  let i = 0;
  return {
    calls, model: 'fake', provider: 'fake',
    async complete({ system, messages, tools }) {
      calls.push({ system, messages, tools });
      const t = turns[Math.min(i++, turns.length - 1)];
      const content = t.map((b, n) => b.tool ? { type: 'tool_use', id: `t${i}_${n}`, name: b.tool, input: b.input || {} } : { type: 'text', text: b.text });
      return { stopReason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', content, usage: { input: 10, output: 5 } };
    },
  };
}

test('a review inspects the site with tools, then submits a fail with validated edits', async () => {
  const ai = scripted([
    [{ text: 'Looking at the posts.' }, { tool: 'list_content', input: { type: 'posts' } }],
    [{ tool: 'get_content', input: { type: 'posts', id: 10 } }, { tool: 'fetch_page', input: { url: '/blog/best-disposables/' } }],
    [{ tool: 'submit_review', input: {
      verdict: 'fail', summary: 'The disposables guide has no meta description.', rationale: 'Checked post 10.', evidence_url: '/blog/best-disposables/',
      ops: [
        { target: { type: 'posts', id: 10 }, field: 'meta.description', after: 'Compare the best disposable vapes sold in Dubai, with UAE-legal 20mg strengths.', describe: 'Add a meta description' },
        { target: { type: 'posts', id: 10 }, field: 'title', after: 'Best disposables', describe: 'no-op title' },                         // same as current → dropped
        { target: { type: 'users', id: 1 }, field: 'name', after: 'Someone', describe: 'rename admin' },                                    // not editable → rejected
        { target: { type: 'posts', id: 11 }, field: 'content', after: '<script>alert(1)</script>', describe: 'inject' },                   // script → rejected
        { target: { type: 'media', id: 30 }, field: 'alt_text', after: 'Yuoto disposable vape box', describe: 'Alt text', low_confidence: true },
      ] } }],
  ]);
  const r = await reviewItem({ ai, connector, conn: conn(), site, itemId: 'x1' });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.evidenceUrl, wp.baseUrl + '/blog/best-disposables/');
  assert.equal(r.ops.length, 2);
  assert.deepEqual(r.ops.map(o => o.field), ['meta.description', 'alt_text']);
  assert.equal(r.ops[0].before, '');                                   // read from the site, not from the model
  assert.equal(r.ops[1].lowConfidence, true);
  assert.equal(r.rejected.length, 3);
  assert.match(r.rejected.map(x => x.reason).join('|'), /already the proposed value/);
  assert.match(r.rejected.map(x => x.reason).join('|'), /cannot be edited/);
  assert.match(r.rejected.map(x => x.reason).join('|'), /script/);
  assert.equal(r.turns, 3);
  assert.equal(wp.writes.length, 0);                                   // reviewing never writes
  // the system prompt carries the item and the site
  assert.match(ai.calls[0].system, /x1/);
  assert.match(ai.calls[0].system, /Vape Wizard DXB/);
  // tool results went back as tool_result blocks
  const toolResults = ai.calls[2].messages.filter(m => m.role === 'user').flatMap(m => (Array.isArray(m.content) ? m.content : [])).filter(b => b.type === 'tool_result');
  assert.equal(toolResults.length, 4);                                // 3 tool results + the submit_review acknowledgement (shared history)
  assert.match(toolResults[1].content, /Best disposables/);
  assert.equal(toolResults[3].content, 'recorded');
  assert.equal(ai.calls[0].tools, TOOLS);
});

test('no submit_review → unknown, and a refusal → unknown', async () => {
  const r = await reviewItem({ ai: scripted([[{ text: 'I cannot tell from here.' }]]), connector, conn: conn(), site, itemId: 'f2' });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.summary, /did not reach a verdict/);
  const refusing = { async complete() { return { stopReason: 'refusal', content: [], usage: {} }; } };
  const r2 = await reviewItem({ ai: refusing, connector, conn: conn(), site, itemId: 'f2' });
  assert.equal(r2.verdict, 'unknown');
  assert.match(r2.summary, /declined/);
});

test('the loop stops at the time budget', async () => {
  let t = 0;
  const looping = scripted([[{ tool: 'get_settings' }]]);
  const r = await reviewItem({ ai: looping, connector, conn: conn(), site, itemId: 'f2', budgetMs: 100, now: () => (t += 60) });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.summary, /ran out of time/);
  assert.ok(looping.calls.length <= 2);
});

test('AI edits go through the fixer: plan re-reads, apply verifies, revert restores', async () => {
  const detail = { target: { type: 'posts', id: 11 }, field: 'title', before: 'Coil guide', after: 'Coil guide for UAE vapers', describe: 'Sharpen the title', itemId: 'x1' };
  const plan = await planFix('ai-edit', { connector, site, findings: [detail], seoPlugin: 'Rank Math' });
  assert.equal(plan.itemId, 'x1');
  assert.equal(plan.ops.length, 1);
  assert.equal(plan.ops[0].before, 'Coil guide');
  assert.equal(plan.ops[0].changedSinceReview, false);
  const applied = await applyPlan({ connector, site, plan, seoPlugin: 'Rank Math' });
  assert.equal(applied.applied.length, 1);
  assert.equal((await readField(connector, { type: 'posts', id: 11 }, 'title', 'Rank Math')).value, 'Coil guide for UAE vapers');
  // a second plan for the same edit is empty: the site already has the value
  assert.equal((await planFix('ai-edit', { connector, site, findings: [detail], seoPlugin: 'Rank Math' })).ops.length, 0);
  const rev = await revertOperations({ connector, site, operations: applied.applied, seoPlugin: 'Rank Math' });
  assert.equal(rev.reverted.length, 1);
  assert.equal((await readField(connector, { type: 'posts', id: 11 }, 'title', 'Rank Math')).value, 'Coil guide');
  // meta fields map to the SEO plugin's keys; robots is normalised to a list
  const robots = validateOp({ target: { type: 'categories', id: 41 }, field: 'meta.robots', after: 'noindex, follow' });
  assert.deepEqual(robots.after, ['noindex', 'follow']);
  const p2 = await planFix('ai-edit', { connector, site, findings: [{ ...robots, describe: 'noindex empty category' }], seoPlugin: 'Rank Math' });
  const a2 = await applyPlan({ connector, site, plan: p2, seoPlugin: 'Rank Math' });
  assert.equal(a2.applied.length, 1);
  assert.deepEqual(wp.state.categories.find(c => c.id === 41).meta.rank_math_robots, ['noindex', 'follow']);
  assert.throws(() => validateOp({ target: { type: 'posts', id: 1 }, field: 'meta.robots', after: 'noindex, evil' }), /robots values/);
  assert.throws(() => validateOp({ target: { type: 'posts', id: 'x' }, field: 'title', after: 'a' }), /positive integer/);
});

test('helpers: safeUrl stays on the site; stripTags flattens HTML', () => {
  assert.equal(safeUrl('/shop/', 'https://x.com'), 'https://x.com/shop/');
  assert.equal(safeUrl('https://www.x.com/a', 'https://x.com'), 'https://www.x.com/a');
  assert.equal(safeUrl('https://evil.com/a', 'https://x.com'), null);
  assert.equal(safeUrl('javascript:alert(1)', 'https://x.com'), null);
  assert.equal(stripTags('<p>Hi&nbsp;<b>there</b></p>'), 'Hi there');
});

test('OpenAI adapter: history conversion and response shape', async () => {
  const history = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'c1', name: 'get_settings', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"title":"X"}' }] },
  ];
  const conv = toOpenAiMessages(history);
  assert.deepEqual(conv.map(m => m.role), ['user', 'assistant', 'tool']);
  assert.equal(conv[1].tool_calls[0].function.name, 'get_settings');
  assert.equal(conv[2].tool_call_id, 'c1');
  let sent;
  const fetchImpl = async (url, init) => { sent = JSON.parse(init.body); assert.match(init.headers.authorization, /Bearer k/); return { ok: true, json: async () => ({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'x', function: { name: 'submit_review', arguments: '{"verdict":"pass"}' } }] } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }) }; };
  const client = createOpenAiClient({ apiKey: 'k', model: 'gpt-5', fetchImpl });
  const res = await client.complete({ system: 'S', messages: history, tools: TOOLS });
  assert.equal(sent.messages[0].role, 'system');
  assert.equal(sent.tools.length, TOOLS.length);
  assert.equal(res.stopReason, 'tool_use');
  assert.deepEqual(res.content[0], { type: 'tool_use', id: 'x', name: 'submit_review', input: { verdict: 'pass' } });
  const failing = createOpenAiClient({ apiKey: 'k', model: 'gpt-5', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) }) });
  await assert.rejects(failing.complete({ system: 'S', messages: history }), /bad key/);
});

test('Anthropic adapter: uses fallbacks, retries without them once if the account rejects the beta', async () => {
  const seen = [];
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const rejectBeta = new Anthropic.BadRequestError(400, { error: { message: 'fallbacks is not supported' } }, 'fallbacks is not supported', new Headers());
  const sdk = {
    beta: { messages: { async create(p) { seen.push(['beta', p]); throw rejectBeta; } } },
    messages: { async create(p) { seen.push(['plain', p]); return { stop_reason: 'end_turn', model: 'claude-opus-5', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'OK' }], usage: { input_tokens: 1, output_tokens: 1 } }; } },
  };
  const client = createAnthropicClient({ model: 'claude-opus-5', sdk });
  const r1 = await client.complete({ system: 'S', messages: [{ role: 'user', content: 'ping' }] });
  assert.deepEqual(r1.content, [{ type: 'text', text: 'OK' }]);
  assert.equal(seen[0][0], 'beta'); assert.equal(seen[0][1].fallbacks, 'default'); assert.deepEqual(seen[0][1].betas, ['server-side-fallback-2026-07-01']);
  assert.equal(seen[1][0], 'plain');
  await client.complete({ system: 'S', messages: [{ role: 'user', content: 'ping' }], tools: TOOLS });
  assert.equal(seen[2][0], 'plain');                                   // remembered
  assert.deepEqual(seen[2][1].tool_choice, { type: 'auto' });
  assert.equal((await pingAi(client)).ok, true);
});

test('provider config: stored key wins over env, env is the fallback, defaults per provider', () => {
  const env = { ANTHROPIC_API_KEY: 'env-ant', OPENAI_API_KEY: 'env-oai' };
  const a = resolveAiConfig({ agencyId: 'ag', row: null, env });
  assert.deepEqual([a.provider, a.model, a.apiKey, a.source], ['anthropic', 'claude-opus-5', 'env-ant', 'env']);
  const b = resolveAiConfig({ agencyId: 'ag', row: { provider: 'openai', model: null, apiKey: null }, env });
  assert.deepEqual([b.provider, b.model, b.apiKey, b.source], ['openai', 'gpt-5', 'env-oai', 'env']);
  const c = resolveAiConfig({ agencyId: 'ag', row: { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: sealAiKey('sk-ant-stored', 'ag'), autoApply: true }, env });
  assert.deepEqual([c.model, c.apiKey, c.source, c.autoApply], ['claude-sonnet-5', 'sk-ant-stored', 'agency', true]);
  assert.throws(() => resolveAiConfig({ agencyId: 'other', row: { provider: 'anthropic', apiKey: sealAiKey('k', 'ag') }, env }));   // AAD-bound to the agency
  const none = resolveAiConfig({ agencyId: 'ag', row: null, env: {} });
  assert.equal(none.configured, false);
});
