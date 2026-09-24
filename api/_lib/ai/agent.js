// The AI reviewer. Given one checklist item and a connected site, it lets the model inspect the site
// through read-only tools, then requires a structured verdict: pass / fail / unknown, with evidence,
// and — for a fail — the concrete edits it proposes. Edits are validated against ai/edits.js, the
// current value of every field is read from the site (the model's idea of "before" is never trusted),
// and nothing is written here: the result becomes a finding whose plan a human approves (or, with
// auto-apply on, the API applies through the same fixer every other fix goes through).
import { validateOp, readField, sameValue, EDITABLE } from './edits.js';
import { seoKeys } from '../connectors/wordpress.js';
import { itemLabel, itemCat } from '../../../js/model.js';
import { HINTS } from '../../../js/checklist.js';
import { tierOf, FIX_BLOCKED_REASON } from '../../../js/automation.js';

const MAX_TURNS = 12;                 // total, across every request a review is continued in
const MIN_TURN_MS = 12_000;           // don't start a turn with less time than this left in the request
const MAX_TURN_MS = 45_000;           // one turn never waits longer than this
const MAX_TIMEOUTS = 3;               // a turn that keeps timing out is abandoned, not retried forever
const MAX_OPS = 15;
const TOOL_RESULT_CHARS = 14000;

const TOOLS = [
  { name: 'list_content', description: 'List published content of one type. Returns id, title, link and last-modified for up to `limit` entries (default 20, max 40). Use `search` to narrow by words in the title or body.',
    input_schema: { type: 'object', properties: { type: { type: 'string', enum: ['posts', 'pages', 'product'] }, search: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 40 } }, required: ['type'] } },
  { name: 'get_content', description: 'Fetch one post, page or product: title, excerpt, body text (HTML stripped, truncated), SEO title/description/canonical/robots, featured image alt, link.',
    input_schema: { type: 'object', properties: { type: { type: 'string', enum: ['posts', 'pages', 'product'] }, id: { type: 'integer' } }, required: ['type', 'id'] } },
  { name: 'list_media', description: 'List media library images: id, file name, alt text, title. `missing_alt: true` returns only images with no alt text.',
    input_schema: { type: 'object', properties: { missing_alt: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 60 } } } },
  { name: 'list_terms', description: 'List taxonomy terms (categories, tags, product_cat, product_tag): id, name, slug, count, description, link, SEO title/description.',
    input_schema: { type: 'object', properties: { taxonomy: { type: 'string', enum: ['categories', 'tags', 'product_cat', 'product_tag'] }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['taxonomy'] } },
  { name: 'get_settings', description: 'Site settings: title, tagline, URL, language, timezone, whether registration is open, and the detected SEO plugin.', input_schema: { type: 'object', properties: {} } },
  { name: 'fetch_page', description: 'Fetch a public URL on this site as a visitor would (no credentials): HTTP status, <title>, canonical, meta robots, meta description, JSON-LD types, headings, visible text (truncated). Use it to verify what is actually live.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'submit_review', description: 'Finish the review. Call exactly once, with the verdict and, for a fail, the edits you propose. Every edit names a target you inspected with the tools.',
    input_schema: { type: 'object', properties: {
      verdict: { type: 'string', enum: ['pass', 'fail', 'unknown'] },
      summary: { type: 'string', description: 'One sentence a client would understand.' },
      rationale: { type: 'string', description: 'What you checked and what you saw, 2-5 sentences.' },
      evidence_url: { type: 'string', description: 'A URL on the site that shows the current state.' },
      ops: { type: 'array', items: { type: 'object', properties: {
        target: { type: 'object', properties: { type: { type: 'string' }, id: { type: 'integer' }, url: { type: 'string' } }, required: ['type', 'id'] },
        field: { type: 'string' }, after: {}, describe: { type: 'string' }, low_confidence: { type: 'boolean' },
      }, required: ['target', 'field', 'after', 'describe'] } },
    }, required: ['verdict', 'summary', 'rationale'] } },
];

export function systemPrompt({ site, item, conn }) {
  const tier = tierOf(item.id);
  const blocked = FIX_BLOCKED_REASON[item.id];
  return [
    'You are the SEO reviewer inside RankOps, an agency console. You are auditing ONE checklist item on ONE live WordPress site, using read-only tools, and then submitting a verdict with `submit_review`.',
    '',
    `Site: ${site.name} — ${conn.baseUrl}${conn.seoPlugin ? ` — SEO plugin: ${conn.seoPlugin}` : ''}${conn.capabilities?.wooOk ? ' — WooCommerce store' : ''}.`,
    site.settingsSummary ? `Agency notes for this site: ${site.settingsSummary}` : '',
    '',
    `Checklist item ${item.id} (category "${item.category}"): ${item.label}`,
    item.hint ? `Definition of done: ${item.hint}` : '',
    tier !== 'manual' ? `A deterministic scanner also covers this item; your job is the judgement it cannot make.` : '',
    blocked ? `Why this item is not auto-fixed by the scanner: ${blocked} Respect that: propose an edit only where it is an ordinary content or SEO-field change, and say so plainly if a human decision is required.` : '',
    '',
    'How to work:',
    '- Inspect before you judge. Use the tools to look at the actual pages, settings and terms this item concerns. Sample sensibly (a handful of representative pages), do not try to read the whole site.',
    '- verdict "pass" only when what you saw satisfies the definition of done. "fail" when it does not. "unknown" when the tools cannot show you what the item asks about (Search Console data, hosting, plugin screens, a human decision) — say what would decide it.',
    '- Proposed edits must be concrete field values you are confident in. Never invent facts: legal/regulatory claims, prices, stock, nicotine strengths, certifications, addresses and phone numbers must come from the site itself. If the right value needs a fact you do not have, do not write it — explain in the rationale and leave ops empty or mark the op low_confidence.',
    `- Editable targets: ${EDITABLE.postTypes.join(', ')} (fields: ${EDITABLE.post.join(', ')}); media (fields: ${EDITABLE.media.join(', ')}); ${EDITABLE.termTypes.join(', ')} (fields: ${EDITABLE.term.join(', ')}). meta.* fields are the SEO plugin fields. "content" replaces the entire body, so only use it when you supply the whole corrected body; prefer title/excerpt/meta fields when they suffice.`,
    `- At most ${MAX_OPS} edits per review. Keep meta titles under 60 characters and meta descriptions under 155. Match the site's existing tone and language.`,
    '- Do not propose the same change twice, and do not propose an edit whose value equals what is already there.',
    '- Finish with submit_review. Everything you propose is shown to a person as a before/after diff before it is written, and can be reverted.',
  ].filter(l => l !== '').join('\n');
}

/**
 * Run the review. Returns { verdict, summary, rationale, evidenceUrl, ops, turns, usage, transcript }.
 * `ops` are validated and carry the live `before` value; ops that would not change anything are dropped.
 */
/**
 * Run the review, or one slice of it. A full review usually needs several model turns, which do not
 * fit in one serverless request (Vercel Hobby: 60 s). So the loop works against a deadline: when the
 * time left is too short for another turn — or a turn times out — it returns
 *   { pending: true, state }
 * and the caller hands `state` back on the next request to continue exactly where it stopped.
 * A finished review returns { verdict, summary, rationale, evidenceUrl, ops, rejected, turns, usage, transcript };
 * `ops` are validated and carry the live `before` value; ops that would not change anything are dropped.
 */
export async function reviewItem({ ai, connector, conn, site, itemId, budgetMs = 50_000, resume = null, now = Date.now, log = () => {} }) {
  const item = { id: itemId, label: itemLabel(itemId), hint: HINTS[itemId] || '', category: itemCat(itemId)?.title || '' };
  const seoPlugin = conn.seoPlugin || 'Rank Math';
  const system = systemPrompt({ site, item, conn });
  const messages = resume?.messages?.length ? resume.messages
    : [{ role: 'user', content: `Review checklist item ${item.id} now. Start by inspecting the site with the tools (several in one turn where you can), then call submit_review.` }];
  const deadline = now() + budgetMs;
  const usage = { input: resume?.usage?.input || 0, output: resume?.usage?.output || 0 };
  const transcript = resume?.transcript || [];
  let turns = resume?.turns || 0;
  let timeouts = resume?.timeouts || 0;
  let review = null, lastText = resume?.lastText || '';
  const pause = () => ({ pending: true, state: { messages, usage, transcript, turns, timeouts, lastText } });

  while (turns < MAX_TURNS && !review) {
    const left = deadline - now();
    if (left < MIN_TURN_MS) return pause();                    // not enough time for a turn: continue next request
    let res;
    try {
      res = await ai.complete({ system, messages, tools: TOOLS, timeoutMs: Math.min(left - 1000, MAX_TURN_MS) });
    } catch (e) {
      if (!e.timeout) throw e;
      // The turn did not finish in the time this request had left. Re-issue it in a fresh request —
      // unless it has already timed out with a full budget behind it, which a retry would not change.
      if (++timeouts >= MAX_TIMEOUTS) { lastText = 'the model took too long on every attempt (try a faster model or lower effort in AI Settings)'; break; }
      log(`${itemId} turn ${turns + 1} timed out after ${Math.round((now() - (deadline - left)) / 1000)}s — continuing in the next request`);
      return pause();
    }
    turns++;
    usage.input += res.usage?.input || 0; usage.output += res.usage?.output || 0;
    // Replay what the provider returned verbatim (Anthropic thinking blocks must go back unchanged).
    messages.push({ role: 'assistant', content: res.raw?.length ? res.raw : (res.content.length ? res.content : [{ type: 'text', text: '(no content)' }]) });
    lastText = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || lastText;
    if (res.stopReason === 'refusal') { lastText = 'the model declined to review this item'; break; }
    const calls = res.content.filter(b => b.type === 'tool_use');
    if (!calls.length) break;                                   // end_turn without submit_review
    const results = await Promise.all(calls.map(async (call) => {
      if (call.name === 'submit_review') { review = call.input; return { type: 'tool_result', tool_use_id: call.id, content: 'recorded' }; }
      let content;
      try { content = clip(JSON.stringify(await runTool(call.name, call.input || {}, { connector, seoPlugin }))); }
      catch (e) { content = `error: ${e.message}`; }
      transcript.push({ tool: call.name, input: call.input, chars: content.length });
      log(`${itemId} ${call.name}(${JSON.stringify(call.input || {})}) → ${content.length} chars`);
      return { type: 'tool_result', tool_use_id: call.id, content };
    }));
    messages.push({ role: 'user', content: results });
  }
  if (!review && !lastText && turns >= MAX_TURNS) lastText = `no verdict after ${MAX_TURNS} turns`;

  if (!review) {
    return { verdict: 'unknown', summary: `AI review did not reach a verdict — ${lastText || 'no response'}`.slice(0, 500), rationale: lastText, evidenceUrl: null, ops: [], rejected: [], turns, usage, transcript };
  }
  const verdict = ['pass', 'fail', 'unknown'].includes(review.verdict) ? review.verdict : 'unknown';
  const ops = [], rejected = [];
  for (const raw of (Array.isArray(review.ops) ? review.ops : []).slice(0, MAX_OPS)) {
    try {
      const op = validateOp(raw);
      const cur = await readField(connector, op.target, op.field, seoPlugin);
      if (sameValue(cur.value, op.after)) { rejected.push({ op: raw, reason: 'already the proposed value' }); continue; }
      ops.push({ target: { ...op.target, url: cur.url || op.target.url || null }, field: op.field, before: cur.value, after: op.after,
                 describe: String(raw.describe || `${op.field} on ${op.target.type} #${op.target.id}`).slice(0, 300), lowConfidence: !!raw.low_confidence });
    } catch (e) { rejected.push({ op: raw, reason: e.message }); }
  }
  return {
    verdict, summary: String(review.summary || '').slice(0, 500), rationale: String(review.rationale || '').slice(0, 4000),
    evidenceUrl: safeUrl(review.evidence_url, conn.baseUrl), ops, rejected, turns, usage, transcript,
  };
}

/* ---------- tools ---------- */
async function runTool(name, input, { connector, seoPlugin }) {
  const keys = seoKeys(seoPlugin);
  const seo = (row) => ({ seoTitle: row?.meta?.[keys.title] ?? null, seoDescription: row?.meta?.[keys.description] ?? null, canonical: row?.meta?.[keys.canonical] ?? null, robots: row?.meta?.[keys.robots] ?? null });
  switch (name) {
    case 'list_content': {
      const type = pick(input.type, ['posts', 'pages', 'product']);
      const rows = await connector.collect(`/wp-json/wp/v2/${type}`, { limit: clampInt(input.limit, 20, 40), query: { status: 'publish', search: input.search || undefined, _fields: 'id,link,title,modified', context: 'edit' } });
      return rows.map(r => ({ id: r.id, title: rawText(r.title), link: r.link, modified: r.modified }));
    }
    case 'get_content': {
      const type = pick(input.type, ['posts', 'pages', 'product']);
      const { data } = await connector.request(`/wp-json/wp/v2/${type}/${Number(input.id)}`, { query: { context: 'edit' } });
      return { id: data.id, type, link: data.link, status: data.status, title: rawText(data.title), excerpt: stripTags(rawText(data.excerpt)).slice(0, 1500),
               body: stripTags(rawText(data.content)).slice(0, 6000), bodyChars: stripTags(rawText(data.content)).length, ...seo(data), featuredMedia: data.featured_media || null };
    }
    case 'list_media': {
      const rows = await connector.media({ limit: clampInt(input.limit, 30, 60) });
      const imgs = rows.filter(r => (r.media_type || '').includes('image') || /^image\//.test(r.mime_type || ''));
      return (input.missing_alt ? imgs.filter(r => !String(r.alt_text || '').trim()) : imgs).map(r => ({ id: r.id, file: String(r.source_url || '').split('/').pop(), url: r.source_url, alt: r.alt_text || '', title: rawText(r.title) }));
    }
    case 'list_terms': {
      const tax = pick(input.taxonomy, ['categories', 'tags', 'product_cat', 'product_tag']);
      const rows = await connector.collect(`/wp-json/wp/v2/${tax}`, { limit: clampInt(input.limit, 50, 100), query: { context: 'edit', _fields: 'id,name,slug,count,description,link,meta' } });
      return rows.map(r => ({ id: r.id, name: r.name, slug: r.slug, count: r.count, link: r.link, description: stripTags(r.description || '').slice(0, 800), ...seo(r) }));
    }
    case 'get_settings': {
      const s = await connector.settings();
      return { title: s.title, tagline: s.description, url: s.url, language: s.language, timezone: s.timezone, usersCanRegister: s.users_can_register, seoPlugin };
    }
    case 'fetch_page': {
      const url = safeUrl(input.url, connector.baseUrl);
      if (!url) throw new Error('url must be on this site');
      const res = await connector.fetchPublic(url);
      const html = res.text || '';
      return { status: res.status, finalUrl: res.url, title: match(html, /<title[^>]*>([\s\S]*?)<\/title>/i), canonical: match(html, /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)/i) || match(html, /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i),
               metaRobots: match(html, /<meta[^>]+name=["']robots["'][^>]*content=["']([^"']*)/i), metaDescription: match(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)/i),
               jsonLdTypes: [...html.matchAll(/"@type"\s*:\s*"([^"]+)"/g)].map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i).slice(0, 20),
               headings: [...html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)].map(m => `h${m[1]}: ${stripTags(m[2]).trim()}`).slice(0, 40),
               text: stripTags(html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')).slice(0, 8000) };
    }
    default: throw new Error(`unknown tool ${name}`);
  }
}

/* ---------- helpers ---------- */
const rawText = (v) => (v && typeof v === 'object' ? (v.raw ?? v.rendered ?? '') : (v ?? ''));
export function stripTags(html) { return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, '’').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim(); }
function pick(v, allowed) { if (!allowed.includes(v)) throw new Error(`must be one of ${allowed.join(', ')}`); return v; }
function clampInt(v, dflt, max) { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : dflt; }
function match(html, re) { const m = html.match(re); return m ? stripTags(m[1]).trim() : null; }
function clip(s) { return s.length > TOOL_RESULT_CHARS ? s.slice(0, TOOL_RESULT_CHARS) + `… (truncated, ${s.length} chars)` : s; }
export function safeUrl(url, baseUrl) {
  if (!url) return null;
  try {
    const u = new URL(String(url), baseUrl + '/');
    const b = new URL(baseUrl);
    return u.host.replace(/^www\./, '') === b.host.replace(/^www\./, '') && /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch { return null; }
}
export { TOOLS, MAX_TURNS };
