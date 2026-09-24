// Anthropic adapter over the official SDK. Returns the neutral shape the agent loop consumes:
//   { stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal', content: [{ type:'text' } | { type:'tool_use' }], usage }
//
// Thinking stays on (the model's default); `effort` (AI_EFFORT, default "medium") trades depth for turn
// speed, which matters because a review has to fit in serverless requests. Every returned block —
// thinking included — is also handed back as `raw` so the loop can replay it unchanged, as the API
// requires for multi-turn tool use. Server-side refusal fallbacks are on so a
// policy decline on the primary model re-runs on Anthropic's default fallback inside the same call; an
// account that rejects that beta gets one retry without it.
import Anthropic from '@anthropic-ai/sdk';

export function createAnthropicClient({ apiKey, model, sdk, effort = 'medium' } = {}) {
  if (!apiKey && !sdk) throw new Error('Anthropic API key is not set');
  // No SDK retries: a retry would silently double the time a turn takes, and the review loop already
  // re-issues a turn that runs out of time in the next request.
  const client = sdk || new Anthropic({ apiKey, maxRetries: 0, timeout: 45_000 });
  let fallbacksOk = true;
  return {
    provider: 'anthropic', model,
    async complete({ system, messages, tools = [], maxTokens = 8000, timeoutMs }) {
      const base = { model, max_tokens: maxTokens, system, messages,
        ...(effort ? { output_config: { effort } } : {}),
        ...(tools.length ? { tools, tool_choice: { type: 'auto' } } : {}) };
      const opts = timeoutMs ? { timeout: Math.max(1000, Math.round(timeoutMs)) } : undefined;
      let res;
      try {
        try {
          res = fallbacksOk
            ? await client.beta.messages.create({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, opts)
            : await client.messages.create(base, opts);
        } catch (e) {
          if (fallbacksOk && e instanceof Anthropic.BadRequestError && /fallback|beta/i.test(e.message)) {
            fallbacksOk = false;
            res = await client.messages.create(base, opts);
          } else throw e;
        }
      } catch (e) {
        if (e instanceof Anthropic.APIConnectionTimeoutError || e?.name === 'APIConnectionTimeoutError') {
          const t = new Error(`Anthropic: no response within ${Math.round((timeoutMs || 45_000) / 1000)}s`); t.timeout = true; throw t;
        }
        throw e;
      }
      const content = res.content.filter(b => b.type === 'text' || b.type === 'tool_use').map(b => b.type === 'text' ? { type: 'text', text: b.text } : { type: 'tool_use', id: b.id, name: b.name, input: b.input });
      const raw = JSON.parse(JSON.stringify(res.content));
      return { stopReason: res.stop_reason, content, raw, usage: { input: res.usage?.input_tokens || 0, output: res.usage?.output_tokens || 0 }, servedBy: res.model };
    },
  };
}
