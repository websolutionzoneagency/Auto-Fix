// OpenAI adapter: the same neutral shape as anthropic.js, over the Chat Completions API (fetch, no SDK).
// Neutral messages use Anthropic-style blocks ({ text | tool_use | tool_result }); this converts both ways.
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export function createOpenAiClient({ apiKey, model, fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
  if (!apiKey) throw new Error('OpenAI API key is not set');
  return {
    provider: 'openai', model,
    async complete({ system, messages, tools = [], maxTokens = 8000 }) {
      const body = {
        model,
        max_completion_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, ...toOpenAiMessages(messages)],
        ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })), tool_choice: 'auto' } : {}),
      };
      // One turn must not eat the whole request budget — a hung upstream call would otherwise block
      // until Vercel kills the function with no response at all.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal: ctl.signal });
      } catch (e) {
        if (e.name === 'AbortError') { const err = new Error(`OpenAI: timed out after ${Math.round(timeoutMs / 1000)}s`); err.status = 504; throw err; }
        throw e;
      } finally {
        clearTimeout(timer);
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(`OpenAI: ${data?.error?.message || `HTTP ${res.status}`}`); e.status = res.status; throw e; }
      const choice = data.choices?.[0] || {};
      const msg = choice.message || {};
      const content = [];
      if (msg.content) content.push({ type: 'text', text: String(msg.content) });
      for (const call of msg.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(call.function?.arguments || '{}'); } catch { input = {}; }
        content.push({ type: 'tool_use', id: call.id, name: call.function?.name, input });
      }
      const stopReason = content.some(b => b.type === 'tool_use') ? 'tool_use' : (choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn');
      return { stopReason, content, usage: { input: data.usage?.prompt_tokens || 0, output: data.usage?.completion_tokens || 0 } };
    },
  };
}

/** Neutral (Anthropic-shaped) history → OpenAI messages. */
export function toOpenAiMessages(messages) {
  const out = [];
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
    if (m.role === 'assistant') {
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      const calls = blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of blocks) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
      }
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}
