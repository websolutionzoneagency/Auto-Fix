// Anthropic adapter over the official SDK. Returns the neutral shape the agent loop consumes:
//   { stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal', content: [{ type:'text' } | { type:'tool_use' }], usage }
//
// The model's own default (thinking on, effort high) is used. Server-side refusal fallbacks are on so a
// policy decline on the primary model re-runs on Anthropic's default fallback inside the same call; an
// account that rejects that beta gets one retry without it.
import Anthropic from '@anthropic-ai/sdk';

export function createAnthropicClient({ apiKey, model, sdk } = {}) {
  if (!apiKey && !sdk) throw new Error('Anthropic API key is not set');
  const client = sdk || new Anthropic({ apiKey, maxRetries: 1, timeout: 45_000 });
  let fallbacksOk = true;
  return {
    provider: 'anthropic', model,
    async complete({ system, messages, tools = [], maxTokens = 8000 }) {
      const base = { model, max_tokens: maxTokens, system, messages, ...(tools.length ? { tools, tool_choice: { type: 'auto' } } : {}) };
      let res;
      try {
        res = fallbacksOk
          ? await client.beta.messages.create({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
          : await client.messages.create(base);
      } catch (e) {
        if (fallbacksOk && e instanceof Anthropic.BadRequestError && /fallback|beta/i.test(e.message)) {
          fallbacksOk = false;
          res = await client.messages.create(base);
        } else throw e;
      }
      const content = res.content.filter(b => b.type === 'text' || b.type === 'tool_use').map(b => b.type === 'text' ? { type: 'text', text: b.text } : { type: 'tool_use', id: b.id, name: b.name, input: b.input });
      return { stopReason: res.stop_reason, content, usage: { input: res.usage?.input_tokens || 0, output: res.usage?.output_tokens || 0 }, servedBy: res.model };
    },
  };
}
