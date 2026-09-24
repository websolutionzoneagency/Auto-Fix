// RankOps Console — UI layer. Reads store.state, renders, and turns clicks into store.dispatch() calls.
// No business logic lives here: health, sorting and status rules are in model.js; mutations in store.js.
import { CONFIG } from './config.js';
import { CHECKLIST, TOTAL_ITEMS, CRITICAL } from './checklist.js';
import * as M from './model.js';
import { createStore, makeClient, makeSite, makeFlag, makeFixReq, emptyState } from './store.js';
import { createLocalAdapter } from './adapters/local.js';
import { createApiAdapter, ApiError } from './adapters/api.js';
import { createAuth } from './auth.js';
import { tierOf, TIER_LABEL, ITEM_CHECKS, ITEM_FIXES, FIX_BLOCKED_REASON, tierCounts } from './automation.js';
import { demoState } from './seed.js';

const auth = createAuth(CONFIG);
const adapter = CONFIG.backend === 'api'
  ? createApiAdapter({ ...CONFIG, getToken: () => auth.getToken() })
  : createLocalAdapter({ key: CONFIG.storageKey });
const API = adapter.name === 'api';                 // connections, scans and fixes exist only with the backend
const store = createStore({ adapter, seed: demoState });

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = M.escapeHtml;
const VIEWS = ['dashboard', 'clients', 'flags', 'site', 'templates', 'ai'];
const SUBS = ['checklist', 'fixreq', 'siteflags', 'log'];
const SEV_RANK = { high: 0, medium: 1, low: 2 };

/* ---------- UI-only state (what's open, filters, search) — never persisted ---------- */
const ui = {
  view: 'dashboard', siteId: null, sub: 'checklist',
  search: '', flagFilter: 'all', showResolved: false,
  checklistFilter: 'all', openCats: new Set(), editingEvidence: null,
  tmplSearch: '',
  // per-site automation data from the API (never persisted in the console state)
  connection: {}, findings: {}, fixOps: {}, scanJob: {}, loaded: {}, busy: {},
  ai: null, aiRun: null,                       // agency AI settings; the in-progress "AI audit" run on a site
};
const SUBS_ALL = ['checklist', 'fixreq', 'siteflags', 'log', 'automation'];

/* ---------- routing (#/dashboard, #/site/<id>/<tab>) ---------- */
function routeFromHash() {
  const [view, a, b] = location.hash.replace(/^#\/?/, '').split('/');
  if (view === 'site' && a && store.state.sites[a]) { ui.view = 'site'; ui.siteId = a; if (SUBS_ALL.includes(b)) ui.sub = b; }
  else if (VIEWS.includes(view) && view !== 'site') ui.view = view;
  else ui.view = 'dashboard';
}
function syncHash() {
  const target = ui.view === 'site' ? `#/site/${ui.siteId}/${ui.sub}` : `#/${ui.view}`;
  if (location.hash !== target) history.replaceState(null, '', target);
}
window.addEventListener('hashchange', () => { routeFromHash(); render(); });

function go(view, { siteId, sub } = {}) {
  ui.view = view;
  if (siteId) ui.siteId = siteId;
  if (sub) ui.sub = sub;
  if (view === 'site' && !store.state.sites[ui.siteId]) ui.view = 'clients';
  render();
  window.scrollTo({ top: 0 });
}

/* ---------- toast + theme ---------- */
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}
function applyTheme(theme) {
  const root = document.documentElement, btn = $('#theme-toggle');
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme); else root.removeAttribute('data-theme');
  btn.textContent = theme === 'light' ? '☀' : theme === 'dark' ? '☾' : '◐';
  btn.title = `Theme: ${theme || 'system'} — click to change`;
}

/* ---------- shared fragments ---------- */
function healthCell(h) {
  return `<div class="score ${M.scoreBand(h)}"><div class="bar"><span style="width:${h}%"></span></div><b>${h}</b></div>`;
}
function flagPill(fc) {
  if (!fc.open) return '<span class="pill low"><span class="dot"></span>0 open</span>';
  if (fc.high) return `<span class="pill high"><span class="dot"></span>${fc.high} high${fc.open > fc.high ? ` · ${fc.open} open` : ''}</span>`;
  if (fc.medium) return `<span class="pill medium"><span class="dot"></span>${fc.medium} medium${fc.open > fc.medium ? ` · ${fc.open} open` : ''}</span>`;
  return `<span class="pill low"><span class="dot"></span>${fc.open} low</span>`;
}
function platformBadge(sum) {
  const noConn = sum.sites.length > 0 && sum.sites.some(x => !x.connector);
  return `<span class="platform-badge${noConn ? ' nogap' : ''}">${esc(sum.platforms.join(' · ') || '—')}${noConn ? ' · no connector' : ''}</span>`;
}
function siteTag(site, sub) {
  return `<button class="tag" data-action="open-site" data-site="${esc(site.id)}"${sub ? ` data-sub="${sub}"` : ''} style="cursor:pointer;border:none;font-family:var(--font-mono)">${esc(site.name)}</button>`;
}
function flagRow(s, f, { compact = false } = {}) {
  const site = s.sites[f.siteId];
  return `<div class="flag-row${f.resolved ? ' resolved' : ''}" data-flag-row="${esc(f.id)}">
    <div class="flag-stripe ${esc(f.severity)}"></div>
    <div class="flag-body">
      <div class="flag-title">${esc(f.text)}</div>
      <div class="flag-tags">
        ${site ? siteTag(site, 'siteflags') : '<span class="tag">site removed</span>'}
        ${f.tag ? `<span class="tag">${esc(f.tag)}</span>` : ''}<span class="tag">${esc(f.severity)}</span>
        <span class="tag">${f.resolved ? 'resolved ' + M.relTime(f.resolvedAt) : 'raised ' + M.relTime(f.createdAt)}</span>
      </div>
    </div>
    <div class="flag-actions">
      ${f.resolved
        ? `<button class="btn-mini" data-action="flag-reopen" data-flag="${esc(f.id)}">Reopen</button>`
        : `<button class="btn-mini" data-action="flag-resolve" data-flag="${esc(f.id)}">Resolve</button>`}
      ${compact ? '' : `<button class="btn-mini danger" data-action="flag-delete" data-flag="${esc(f.id)}" aria-label="Delete flag" title="Delete flag">×</button>`}
    </div>
  </div>`;
}
function logText(text) {
  const i = text.indexOf(' — ');
  return i > 0 ? `<b>${esc(text.slice(0, i))}</b> — ${esc(text.slice(i + 3))}` : esc(text);
}
function initialsOf(name) { return String(name || '').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '—'; }

/* ---------- render ---------- */
function render() {
  const s = store.state;
  applyTheme(s.theme);
  if (ui.view === 'site' && !s.sites[ui.siteId]) ui.view = 'clients';
  syncHash();
  renderSidebar(s);
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + ui.view));
  $$('.nav-item[data-view]').forEach(n => n.classList.toggle('active', n.dataset.view === ui.view));
  if (ui.view === 'dashboard') renderDashboard(s);
  else if (ui.view === 'clients') renderClients(s);
  else if (ui.view === 'flags') renderFlags(s);
  else if (ui.view === 'site') renderSite(s);
  else if (ui.view === 'templates') renderTemplates(s);
  else if (ui.view === 'ai') renderAiSettings();
  ensureAiTicker();
}

/** How long ago an AI review started, as a short live label. */
function elapsedLabel(startedAt) {
  if (!startedAt) return '';
  const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
/** While any AI review is in flight (single-item or an audit run), re-render once a second so the
 *  "reviewing… Ns" labels visibly move — the only sign of life during a call that can take up to a
 *  minute, so it never looks like the button silently did nothing. */
let aiTicker = null;
function ensureAiTicker() {
  const running = !!ui.aiRun || Object.keys(ui.busy).some(k => k.startsWith('ai:'));
  if (running && !aiTicker) aiTicker = setInterval(render, 1000);
  else if (!running && aiTicker) { clearInterval(aiTicker); aiTicker = null; }
}

function renderSidebar(s) {
  $('#brand-agency').textContent = s.agency.name;
  $('#agency-avatar').textContent = s.agency.initials || initialsOf(s.agency.admin);
  $('#agency-user').textContent = `${s.agency.admin} · ${s.agency.role}`;
  $('#count-clients').textContent = Object.keys(s.clients).length;
  const fc = M.flagCounts(M.openFlags(s));
  const cf = $('#count-flags'); cf.textContent = fc.open; cf.classList.toggle('warn', fc.high > 0);
  const sites = Object.values(s.sites).sort((a, b) => a.name.localeCompare(b.name));
  $('#nav-sites').innerHTML = sites.length ? sites.map(site => {
    const n = M.flagsOfSite(s, site.id).filter(f => !f.resolved).length;
    const active = ui.view === 'site' && ui.siteId === site.id;
    return `<button class="nav-item site-link${active ? ' active' : ''}" data-action="open-site" data-site="${esc(site.id)}" title="${esc(site.domain || site.name)}"><span class="ic" aria-hidden="true">▤</span><span class="trunc">${esc(site.name)}</span>${n ? `<span class="count">${n}</span>` : ''}</button>`;
  }).join('') : '<div class="nav-label" style="margin-top:2px">no sites yet</div>';
}

function clientMatches(sum, q) {
  if (!q) return true;
  const hay = [sum.client.name, sum.client.contact, sum.client.plan, ...sum.sites.flatMap(x => [x.name, x.domain, x.platform, x.connector])].join(' ').toLowerCase();
  return hay.includes(q);
}

function renderDashboard(s) {
  const fleet = M.fleetSummary(s);
  const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  $('#dash-sub').textContent = `${s.agency.name} · ${pl(fleet.clients, 'client account')} · ${pl(fleet.sites, 'site')} monitored`;

  const th = $('#tile-health');
  th.textContent = fleet.sites ? fleet.avgHealth : '–';
  th.className = 'tval ' + (fleet.sites ? M.scoreBand(fleet.avgHealth) : '');
  $('#tile-health-sub').textContent = fleet.sites ? `across ${pl(fleet.sites, 'site')}` : 'add a site to start';
  $('#tile-sites').textContent = fleet.sites;
  $('#tile-sites-sub').textContent = fleet.noConnector ? `${fleet.noConnector} in recommend-only mode (no connector)` : (fleet.sites ? 'all connected' : '');
  $('#tile-flags').textContent = fleet.flags.open;
  const fs = $('#tile-flags-sub');
  fs.textContent = fleet.flags.high ? `${fleet.flags.high} high severity` : (fleet.flags.open ? `${fleet.flags.medium} medium · ${fleet.flags.low} low` : 'nothing waiting on a decision');
  fs.className = 'tdelta' + (fleet.flags.high ? ' warn' : '');
  $('#tile-fixreq').textContent = fleet.reqActive;
  $('#tile-fixreq-sub').textContent = `${fleet.reqPending} queued · ${fleet.reqWorking} in progress${fleet.reqAttention ? ` · ${fleet.reqAttention} need attention` : ''}`;
  $('#tile-done').textContent = fleet.reqDone30d;
  const ds = $('#tile-done-sub');
  ds.textContent = fleet.reqDone30d ? 'each one marked its checklist item done' : 'none closed in the last 30 days';
  ds.className = 'tdelta' + (fleet.reqDone30d ? ' up' : '');

  const q = ui.search.trim().toLowerCase();
  const sums = Object.keys(s.clients).map(id => M.clientSummary(s, id))
    .sort((a, b) => b.attention - a.attention || a.client.name.localeCompare(b.client.name));
  const shown = sums.filter(sum => clientMatches(sum, q));
  $('#dashboard-client-rows').innerHTML = shown.map(sum => `
    <tr class="clickable" data-action="open-client-primary" data-client="${esc(sum.client.id)}">
      <td>${esc(sum.client.name)}</td><td class="mono">${sum.sites.length}</td><td>${platformBadge(sum)}</td>
      <td>${sum.sites.length ? healthCell(sum.health) : '<span class="pill low">no site yet</span>'}</td>
      <td>${flagPill(sum.flags)}</td><td>${esc(sum.client.plan)}</td><td class="mono">${M.relTime(sum.lastActivity)}</td>
    </tr>`).join('');
  const empty = $('#dashboard-empty');
  empty.hidden = shown.length > 0;
  empty.textContent = sums.length ? `No clients match “${ui.search.trim()}”.` : 'No clients yet — add one from the Clients page.';

  const high = M.openFlags(s).filter(f => f.severity === 'high').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $('#dash-decisions-hint').textContent = high.length ? `${pl(high.length, 'high-severity flag')} across the portfolio` : 'no high-severity flags open';
  $('#dash-decisions').innerHTML = high.length
    ? high.map(f => flagRow(s, f, { compact: true })).join('')
    : '<div class="empty-note">Nothing high-severity is waiting on a decision. Medium and low flags are in the <button class="back-link" data-action="nav" data-view="flags">Flags Inbox</button>.</div>';
}

function renderClients(s) {
  $('#clients-agency').textContent = s.agency.name;
  const sums = Object.keys(s.clients).map(id => M.clientSummary(s, id)).sort((a, b) => a.client.name.localeCompare(b.client.name));
  $('#clients-count').textContent = sums.length;
  $('#clients-rows').innerHTML = sums.map(sum => `
    <tr class="clickable" data-action="open-client-primary" data-client="${esc(sum.client.id)}">
      <td>${esc(sum.client.name)}</td><td>${esc(sum.client.contact) || '—'}</td>
      <td>${sum.sites.length ? sum.sites.map(x => siteTag(x)).join(' ') : '<span class="pill low">none</span>'}</td>
      <td>${sum.sites.length ? healthCell(sum.health) : '—'}</td><td>${flagPill(sum.flags)}</td><td>${esc(sum.client.plan)}</td>
      <td><div class="row-actions">
        <button class="btn-mini" data-action="add-site" data-client="${esc(sum.client.id)}">+ site</button>
        <button class="btn-mini danger" data-action="remove-client" data-client="${esc(sum.client.id)}">remove</button>
      </div></td>
    </tr>`).join('');
  $('#clients-empty').hidden = sums.length > 0;
}

function renderFlags(s) {
  $$('#flags-filter button').forEach(b => b.classList.toggle('active', b.dataset.filter === ui.flagFilter));
  $('#flags-show-resolved').checked = ui.showResolved;
  let flags = Object.values(s.flags).filter(f => ui.showResolved || !f.resolved);
  if (ui.flagFilter !== 'all') flags = flags.filter(f => f.severity === ui.flagFilter);
  flags.sort((a, b) => (a.resolved - b.resolved) || (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || b.createdAt.localeCompare(a.createdAt));
  const open = flags.filter(f => !f.resolved).length;
  const siteCount = new Set(flags.filter(f => !f.resolved).map(f => f.siteId)).size;
  $('#flags-hint').textContent = `${open} open across ${siteCount} site${siteCount === 1 ? '' : 's'}`;
  $('#flags-list').innerHTML = flags.length
    ? flags.map(f => flagRow(s, f)).join('')
    : `<div class="empty-note big">No ${ui.showResolved ? '' : 'open '}flags${ui.flagFilter !== 'all' ? ` at ${ui.flagFilter} severity` : ''}. Raise one from any site's Flags tab.</div>`;
}

function renderSite(s) {
  const site = s.sites[ui.siteId];
  if (!site) return;
  const client = s.clients[site.clientId];
  const flags = M.flagsOfSite(s, site.id);
  const reqs = M.fixReqsOfSite(s, site.id);
  const health = M.healthFor(site, flags);

  const link = $('#site-client-link'); link.textContent = client ? client.name : '—';
  $('#site-breadcrumb-name').textContent = site.name;
  $('#site-name').textContent = site.name;
  $('#site-domain').textContent = site.domain || '—';
  $('#site-connector').textContent = site.connector || `${site.platform} · none yet`;
  $('#site-health').textContent = `${health} / 100`;
  const done = M.countDone(site.items), na = Object.values(site.items).filter(v => v === 'na').length;
  $('#site-progress').textContent = `${done} / ${TOTAL_ITEMS - na} items${na ? ` · ${na} n/a` : ''}`;
  const days = M.daysSince(site.lastAuditAt);
  $('#site-audit').textContent = site.lastAuditAt ? (days === 0 ? 'today' : `${days}d ago`) : 'never';
  $('#site-audit-item').classList.toggle('stale', days === null || days > 14);

  const openReqs = reqs.filter(r => r.status !== 'done').length, openFlags = flags.filter(f => !f.resolved).length;
  $('#tab-count-fixreq').textContent = openReqs ? `(${openReqs})` : '';
  $('#tab-count-flags').textContent = openFlags ? `(${openFlags})` : '';
  $$('.tab[data-sub]').forEach(t => { const on = t.dataset.sub === ui.sub; t.classList.toggle('active', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); });
  $$('.subview').forEach(v => v.classList.toggle('active', v.id === 'sub-' + ui.sub));

  const fails = (ui.findings[site.id] || []).filter(f => f.verdict === 'fail').length;
  $('#tab-count-auto').textContent = fails ? `(${fails})` : '';
  $('#tab-automation').hidden = !API;
  if (API) ensureAutomationData(site.id);

  if (ui.sub === 'checklist') renderChecklist(site, reqs);
  else if (ui.sub === 'fixreq') renderKanban(reqs);
  else if (ui.sub === 'siteflags') renderSiteFlags(s, flags);
  else if (ui.sub === 'automation') renderAutomation(s, site);
  else renderLog(s, site);
}

function renderChecklist(site, reqs) {
  $$('#sub-checklist .seg button').forEach(b => b.classList.toggle('active', b.dataset.filter === ui.checklistFilter));
  const openReqByItem = {};
  for (const r of reqs) if (r.status !== 'done') openReqByItem[r.itemId] = r;
  const pct = M.pctFor(site.items), crit = M.openCritCount(site.items);
  $('#checklist-summary').textContent = `${pct}% complete · ${crit} critical item${crit === 1 ? '' : 's'} open`;

  const keep = (it) => {
    const st = M.stateOf(site.items, it.id);
    if (ui.checklistFilter === 'pending') return st === 'pending';
    if (ui.checklistFilter === 'crit') return it.crit && st === 'pending';
    if (ui.checklistFilter === 'done') return st === 'done';
    return true;
  };
  const filtered = ui.checklistFilter !== 'all';
  $('#checklist-cats').innerHTML = CHECKLIST.map((cat, i) => {
    const st = M.catStats(site.items, cat);
    const items = cat.items.filter(keep);
    if (filtered && !items.length) return '';
    const open = filtered || ui.openCats.has(cat.id);
    const critOpen = cat.items.filter(it => it.crit && M.stateOf(site.items, it.id) === 'pending').length;
    return `<div class="cat${open ? ' open' : ''}" data-cat="${cat.id}">
      <button class="cat-head" data-action="cat-toggle" data-cat="${cat.id}" aria-expanded="${open}">
        <div class="cat-title"><span class="idx">${String(i + 1).padStart(2, '0')}</span><h3>${esc(cat.title)}</h3></div>
        <div class="cat-right">
          ${critOpen ? `<span class="chip crit">${critOpen} critical</span>` : ''}
          <span class="chip${st.applicable && st.done === st.applicable ? ' done' : ''}">${st.done}/${st.applicable}${st.na ? ` · ${st.na} n/a` : ''}</span>
          <span class="caret" aria-hidden="true">▸</span>
        </div>
      </button>
      <div class="cat-track"><span style="width:${st.pct}%"></span></div>
      <div class="cat-body">${items.map(it => itemRow(site, it, openReqByItem[it.id])).join('')}</div>
    </div>`;
  }).join('') || '<div class="empty-note big">Nothing matches this filter.</div>';
}

function itemRow(site, it, openReq) {
  const st = M.stateOf(site.items, it.id);
  const ev = (site.evidence && site.evidence[it.id]) || null;
  let sub = '';
  if (st === 'done') {
    sub += `<span class="ev-date">checked ${M.fmtDate(ev && ev.checkedAt)}</span>`;
    if (ui.editingEvidence === it.id) {
      sub += `<input type="url" data-evidence-input data-item="${it.id}" value="${esc(ev && ev.url || '')}" placeholder="https://… evidence URL (Enter to save, Esc to cancel)" aria-label="Evidence URL">`;
    } else if (ev && ev.url) {
      sub += `<a href="${esc(ev.url)}" target="_blank" rel="noopener">evidence ↗</a><button class="ev-btn" data-action="evidence-edit" data-item="${it.id}">edit</button>`;
    } else {
      sub += `<button class="ev-btn" data-action="evidence-edit" data-item="${it.id}">+ evidence link</button>`;
    }
  }
  const tier = tierOf(it.id);
  const finding = API ? findingForItem(it.id) : null;
  if (finding) {
    sub += `<span class="verdict ${esc(finding.verdict)}${finding.ai ? ' ai' : ''}" title="${finding.ai ? 'AI review' : 'scanner'}">${finding.ai ? 'AI: ' : ''}${finding.verdict === 'unknown' ? 'not decided' : finding.verdict}</span><span class="scan-summary" title="${esc(finding.note || '')}">${esc(finding.summary || '')}</span>`;
    if (finding.verdict === 'fail' && finding.fixId) sub += `<button type="button" class="fix-now" data-action="fix-plan" data-finding="${esc(finding.id)}">${finding.ai ? 'Review AI edits →' : 'Fix →'}</button>`;
    else if (finding.verdict === 'fail' && !finding.ai && FIX_BLOCKED_REASON[it.id]) sub += `<span title="${esc(FIX_BLOCKED_REASON[it.id])}" style="cursor:help">why manual?</span>`;
    if (finding.evidenceUrl && st !== 'done') sub += `<a href="${esc(finding.evidenceUrl)}" target="_blank" rel="noopener">evidence ↗</a>`;
  }
  if (API && st !== 'na' && siteConnected(site.id)) {
    const startedAt = ui.busy['ai:' + site.id + ':' + it.id]?.startedAt
      ?? (ui.aiRun && ui.aiRun.siteId === site.id && ui.aiRun.current === it.id ? ui.aiRun.currentStartedAt : null);
    const busy = startedAt != null;
    const label = busy ? `reviewing… ${elapsedLabel(startedAt)}` : (finding?.ai ? 'AI review again' : 'AI review');
    sub += `<button type="button" class="ai-btn" data-action="ai-review" data-item="${it.id}" ${busy ? 'disabled' : ''} title="Have the AI inspect the live site for this item and propose edits">${esc(label)}</button>`;
  }
  if (st === 'pending' && !finding) {
    if (openReq) {
      const m = M.reqStatusMeta(openReq.status);
      sub += `<span class="pill ${m.cls}">${esc(m.label)}</span><span class="prio ${openReq.priority}">${openReq.priority.toUpperCase()}</span><button class="ev-btn" data-action="tab" data-sub="fixreq">view in queue</button>`;
    } else {
      sub += `<button class="fix-btn" data-action="request-fix" data-item="${it.id}">Request fix</button>`;
    }
  }
  return `<div class="item state-${st}${it.crit ? ' crit' : ''}${openReq ? ' has-fix' : ''}" data-item="${it.id}">
    <button class="state-btn" data-action="item-cycle" data-item="${it.id}" data-state="${st}" aria-label="${esc(it.id)}: ${st}. Click to mark ${M.nextItemState(st)}" title="${st} → ${M.nextItemState(st)}"></button>
    <div class="item-body">
      <div class="item-row1">
        <span class="item-code">${esc(it.id)}</span>
        <span class="item-label${it.hint ? ' hinted' : ''}" data-action="item-cycle" data-item="${it.id}"${it.hint ? ` title="${esc(it.hint)}"` : ''}>${esc(it.label)}</span>
        ${it.crit ? '<span class="crit-badge">Critical</span>' : ''}
        ${tier !== 'manual' ? `<span class="tier ${tier}" title="${tier === 'auto' ? 'The scanner decides this and can fix it' : 'The scanner decides this; fixing it needs you'}">${TIER_LABEL[tier]}</span>` : ''}
      </div>
      ${sub ? `<div class="item-sub">${sub}</div>` : ''}
    </div>
  </div>`;
}

function renderKanban(reqs) {
  const cols = { pending: [], progress: [], done: [] };
  for (const r of M.sortFixReqs(reqs)) cols[M.columnOf(r.status)].push(r);
  const open = reqs.length - cols.done.length;
  $('#fixreq-summary').textContent = `${open} open · ${cols.done.length} done`;
  for (const col of M.REQ_COLUMNS) {
    $('#kcount-' + col.id).textContent = cols[col.id].length;          // from data, never from the DOM
    $('#kcol-' + col.id).innerHTML = cols[col.id].length ? cols[col.id].map(kcard).join('') : '<div class="kcol-empty">Nothing here</div>';
  }
}

function kcard(r) {
  const cat = M.itemCat(r.itemId);
  const statusSel = `<select data-fix-status="${esc(r.id)}" aria-label="Status">${M.REQ_STATUS_ORDER.map(st => `<option value="${st}"${st === r.status ? ' selected' : ''}>${M.REQ_STATUS[st].label}</option>`).join('')}</select>`;
  const prio = r.status === 'done'
    ? `<span class="prio ${r.priority}">${r.priority.toUpperCase()}</span>`
    : `<select data-fix-priority="${esc(r.id)}" aria-label="Priority">${M.PRIORITIES.map(p => `<option value="${p}"${p === r.priority ? ' selected' : ''}>${p.toUpperCase()}</option>`).join('')}</select>`;
  const right = r.status === 'done'
    ? `<span class="pill done">verified live</span><span>${M.relTime(r.updatedAt)}</span>`
    : `${statusSel}<span title="requested ${esc(r.requestedAt)}">${M.relTime(r.requestedAt)}</span><button class="x" data-action="fix-cancel" data-fix="${esc(r.id)}" aria-label="Cancel fix request" title="Cancel">×</button>`;
  return `<div class="kcard st-${esc(r.status)}" data-req="${esc(r.id)}">
    <div class="kitem">${esc(r.itemId)}${cat ? ` · ${esc(cat.short)}` : ''}</div>
    <div class="ktitle">${esc(M.itemLabel(r.itemId))}</div>
    ${r.note ? `<div class="knote">“${esc(r.note)}”</div>` : ''}
    <div class="kmeta">${prio}${right}</div>
  </div>`;
}

function renderSiteFlags(s, flags) {
  const sorted = [...flags].sort((a, b) => (a.resolved - b.resolved) || (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || b.createdAt.localeCompare(a.createdAt));
  $('#site-flags-list').innerHTML = sorted.length ? sorted.map(f => flagRow(s, f)).join('') : '<div class="empty-note">No flags raised for this site.</div>';
}

function renderLog(s, site) {
  const entries = M.logOfSite(s, site.id);
  let lastDay = '';
  $('#audit-log-body').innerHTML = entries.length ? entries.map(e => {
    const day = M.fmtDate(e.at);
    const sep = day !== lastDay ? `<div class="log-item"><div class="log-date">${day}</div></div>` : '';
    lastDay = day;
    return sep + `<div class="log-item"><div class="log-dot ${esc(e.kind)}"></div><div class="log-time num">${M.fmtClock(e.at)}</div><div class="log-text">${logText(e.text)}</div></div>`;
  }).join('') : '<div class="empty-note">No activity yet.</div>';
}

function renderTemplates() {
  const q = ui.tmplSearch.trim().toLowerCase();
  const tc = tierCounts(CHECKLIST);
  $('#tmpl-sub').textContent = `${TOTAL_ITEMS} items in ${CHECKLIST.length} categories · ${CRITICAL.size} critical · ${tc.auto} auto-fix · ${tc.check} auto-check · ${tc.manual} manual`;
  $('#templates-body').innerHTML = CHECKLIST.map((cat, i) => {
    const items = cat.items.filter(it => !q || it.id.toLowerCase().includes(q) || it.label.toLowerCase().includes(q) || (it.hint || '').toLowerCase().includes(q));
    if (q && !items.length) return '';
    const crit = cat.items.filter(x => x.crit).length;
    return `<div class="card">
      <div class="card-head"><h3>${String(i + 1).padStart(2, '0')} · ${esc(cat.title)}</h3><span class="hint">${items.length} item${items.length === 1 ? '' : 's'}${crit ? ` · ${crit} critical` : ''}</span></div>
      <div class="card-body">${items.map(it => `<div class="tmpl-item"><span class="tmpl-code">${esc(it.id)}</span><span class="tmpl-label">${esc(it.label)}${it.hint ? `<span class="tmpl-hint">${esc(it.hint)}</span>` : ''}</span>${it.crit ? '<span class="crit-badge">Critical</span>' : ''}${tierOf(it.id) !== 'manual' ? `<span class="tier ${tierOf(it.id)}">${TIER_LABEL[tierOf(it.id)]}</span>` : ''}</div>`).join('')}</div>
    </div>`;
  }).join('') || '<div class="empty-note big">No items match.</div>';
  const mode = $('#backend-mode'); mode.textContent = adapter.name; mode.classList.toggle('api', adapter.name === 'api');
  $('#backend-note').textContent = adapter.name === 'api'
    ? `Synced through ${CONFIG.apiBase} — every change is written to the shared database and other open consoles pick it up within seconds.`
    : 'Local mode: data lives in this browser only. Export a JSON backup before clearing site data, or turn on the API backend (README → "Turning on the backend") to share across devices and teammates.';
}

/* ---------- modals ---------- */
function openModal(id) {
  const m = $('#' + id); m.classList.add('open');
  const first = m.querySelector('input:not([type=hidden]),select,textarea');
  if (first) first.focus();
}
function closeModals() {
  $$('.modal-backdrop.open').forEach(m => { m.classList.remove('open'); const f = m.querySelector('form'); if (f) f.reset(); });
}
function openSiteModal({ siteId, clientId }) {
  const s = store.state; const site = siteId ? s.sites[siteId] : null; const client = s.clients[site ? site.clientId : clientId];
  $('#site-modal-title').textContent = site ? 'Site settings' : `Add a site${client ? ' for ' + client.name : ''}`;
  $('#site-form-id').value = site ? site.id : '';
  $('#site-form-client').value = site ? site.clientId : (clientId || '');
  $('#site-form-name').value = site ? site.name : (client ? client.name : '');
  $('#site-form-domain').value = site ? site.domain : '';
  $('#site-form-platform').value = site ? site.platform : 'WordPress';
  $('#site-form-connector').value = site ? site.connector : '';
  $('#site-form-notes').value = site ? site.notes : '';
  $('#site-delete-btn').hidden = !site;
  $('#site-form-submit').textContent = site ? 'Save' : 'Add site';
  $('#site-connection').hidden = !(API && site);
  if (API && site) fillConnectionForm(site.id);
  openModal('site-modal');
}
$$('.modal-backdrop').forEach(m => m.addEventListener('mousedown', e => { if (e.target === m) closeModals(); }));

/* ---------- forms ---------- */
$('#client-form').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('#client-name').value.trim(); if (!name) return;
  const client = makeClient({ name, contact: $('#client-contact').value, plan: $('#client-plan').value });
  store.dispatch('client/add', { client });
  const site = makeSite({ clientId: client.id, name, domain: $('#client-site-domain').value, platform: $('#client-site-platform').value, connector: $('#client-site-connector').value.trim() });
  store.dispatch('site/add', { site });
  closeModals();
  toast(`Added ${name} — its checklist starts at 0 / ${TOTAL_ITEMS}.`);
  go('site', { siteId: site.id, sub: 'checklist' });
});

$('#site-form').addEventListener('submit', e => {
  e.preventDefault();
  const id = $('#site-form-id').value, clientId = $('#site-form-client').value;
  const patch = {
    name: $('#site-form-name').value.trim(), domain: M.normalizeDomain($('#site-form-domain').value),
    platform: $('#site-form-platform').value, connector: $('#site-form-connector').value.trim(), notes: $('#site-form-notes').value.trim(),
  };
  if (!patch.name) return;
  if (id) { store.dispatch('site/update', { id, patch }); closeModals(); toast('Site settings saved.'); return; }
  if (!store.state.clients[clientId]) return;
  const site = makeSite({ clientId, ...patch });
  store.dispatch('site/add', { site }); closeModals(); toast(`${site.name} added.`);
  go('site', { siteId: site.id, sub: 'checklist' });
});

$('#fix-form').addEventListener('submit', e => {
  e.preventDefault();
  const itemId = $('#fix-item-id').value; if (!itemId || !store.state.sites[ui.siteId]) return;
  const req = makeFixReq({ siteId: ui.siteId, itemId, priority: $('#fix-priority').value, note: $('#fix-note').value });
  store.dispatch('fix/add', { req }); closeModals(); toast(`${itemId} queued as ${req.priority.toUpperCase()}.`);
});

$('#flag-form').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('#flag-text').value.trim(); if (!text || !store.state.sites[ui.siteId]) return;
  const flag = makeFlag({ siteId: ui.siteId, text, severity: $('#flag-sev').value, tag: $('#flag-tag').value.trim() });
  store.dispatch('flag/add', { flag }); e.target.reset(); toast('Flag raised.');
});

/* ---------- inputs ---------- */
$('#client-search').addEventListener('input', e => { ui.search = e.target.value; renderDashboard(store.state); });
$('#tmpl-search').addEventListener('input', e => { ui.tmplSearch = e.target.value; renderTemplates(); });
$('#flags-show-resolved').addEventListener('change', e => { ui.showResolved = e.target.checked; render(); });
$('#import-input').addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.version !== 2 || !data.sites) throw new Error('not a RankOps export');
    if (!confirm(`Replace all current data with "${file.name}"?`)) return;
    store.dispatch('state/replace', { state: data }); toast('Data imported.'); go('dashboard');
  } catch (err) { alert('Import failed: ' + err.message); }
  finally { e.target.value = ''; }
});

function commitEvidence(inp) {
  const itemId = inp.dataset.item, url = inp.value.trim();
  ui.editingEvidence = null;
  const site = store.state.sites[ui.siteId];
  const current = (site && site.evidence && site.evidence[itemId] && site.evidence[itemId].url) || '';
  if (site && url !== current) store.dispatch('evidence/set', { siteId: site.id, itemId, url }); else render();
}
document.addEventListener('keydown', e => {
  const inp = e.target && e.target.closest ? e.target.closest('[data-evidence-input]') : null;
  if (inp) {
    if (e.key === 'Enter') { e.preventDefault(); commitEvidence(inp); }
    else if (e.key === 'Escape') { e.preventDefault(); ui.editingEvidence = null; render(); }
    return;
  }
  if (e.key === 'Escape' && $('.modal-backdrop.open')) closeModals();
  // Ctrl/⌘+Enter submits from a modal textarea (plain Enter inserts a newline there).
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.tagName === 'TEXTAREA') {
    const form = e.target.closest('form'); if (form) { e.preventDefault(); form.requestSubmit(); }
  }
});
document.addEventListener('focusout', e => {
  const inp = e.target && e.target.closest ? e.target.closest('[data-evidence-input]') : null;
  if (inp && ui.editingEvidence === inp.dataset.item) commitEvidence(inp);
});
document.addEventListener('change', e => {
  const st = e.target.closest('[data-fix-status]');
  if (st) { store.dispatch('fix/status', { id: st.dataset.fixStatus, status: st.value }); toast(`Moved to ${M.reqStatusMeta(st.value).label}.`); return; }
  const pr = e.target.closest('[data-fix-priority]');
  if (pr) store.dispatch('fix/priority', { id: pr.dataset.fixPriority, priority: pr.value });
});

/* ---------- click delegation ---------- */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]'); if (!el) return;
  const s = store.state; const d = el.dataset;
  switch (d.action) {
    case 'nav': go(d.view); break;
    case 'open-site': go('site', { siteId: d.site, sub: d.sub || 'checklist' }); break;
    case 'open-client': go('clients'); break;
    case 'open-client-primary': {
      const sites = M.sitesOfClient(s, d.client);
      if (sites.length) go('site', { siteId: sites[0].id, sub: 'checklist' }); else openSiteModal({ clientId: d.client });
      break;
    }
    case 'add-client': openModal('client-modal'); break;
    case 'add-site': openSiteModal({ clientId: d.client }); break;
    case 'edit-site': openSiteModal({ siteId: ui.siteId }); break;
    case 'delete-site': {
      const site = s.sites[$('#site-form-id').value];
      if (site && confirm(`Delete ${site.name} with all of its checklist progress, flags and fix requests?`)) {
        store.dispatch('site/remove', { id: site.id }); closeModals(); toast('Site deleted.'); go('clients');
      }
      break;
    }
    case 'remove-client': {
      const c = s.clients[d.client]; if (!c) break;
      const n = M.sitesOfClient(s, c.id).length;
      if (confirm(`Remove ${c.name}${n ? ` and its ${n} site${n === 1 ? '' : 's'}` : ''}? This cannot be undone.`)) { store.dispatch('client/remove', { id: c.id }); toast('Client removed.'); }
      break;
    }
    case 'tab': ui.sub = d.sub; render(); break;
    case 'cat-toggle': {
      const wrap = el.closest('.cat');
      const open = !wrap.classList.contains('open');
      wrap.classList.toggle('open', open); el.setAttribute('aria-expanded', String(open));
      if (open) ui.openCats.add(d.cat); else ui.openCats.delete(d.cat);
      break;
    }
    case 'expand-all': CHECKLIST.forEach(c => ui.openCats.add(c.id)); render(); break;
    case 'collapse-all': ui.openCats.clear(); render(); break;
    case 'checklist-filter': ui.checklistFilter = d.filter; render(); break;
    case 'flags-filter': ui.flagFilter = d.filter; render(); break;
    case 'item-cycle': {
      const site = s.sites[ui.siteId]; if (!site) break;
      const next = M.nextItemState(M.stateOf(site.items, d.item));
      ui.openCats.add((M.itemCat(d.item) || {}).id);
      store.dispatch('item/set', { siteId: site.id, itemId: d.item, state: next });
      break;
    }
    case 'evidence-edit': {
      ui.editingEvidence = d.item; render();
      const inp = $(`[data-evidence-input][data-item="${d.item}"]`); if (inp) inp.focus();
      break;
    }
    case 'request-fix':
      $('#fix-item-id').value = d.item;
      $('#fix-item-label').innerHTML = `<b>${esc(d.item)}</b> ${esc(M.itemLabel(d.item))}`;
      openModal('fix-modal');
      break;
    case 'fix-cancel': if (confirm('Cancel this fix request?')) store.dispatch('fix/remove', { id: d.fix }); break;
    case 'flag-resolve': store.dispatch('flag/resolve', { id: d.flag, resolved: true }); toast('Flag resolved.'); break;
    case 'flag-reopen': store.dispatch('flag/resolve', { id: d.flag, resolved: false }); break;
    case 'flag-delete': if (confirm('Delete this flag?')) store.dispatch('flag/remove', { id: d.flag }); break;
    case 'record-audit':
      if (!s.sites[ui.siteId]) break;
      if (API && ui.connection[ui.siteId]?.connected) { runScan(ui.siteId); break; }
      store.dispatch('audit/record', { siteId: ui.siteId });
      toast(API ? 'Audit date recorded. Connect the site (Site settings) to scan it for real.' : 'Audit date recorded. Nothing was scanned — the local build has no site connection.');
      break;
    case 'scan-now': if (s.sites[ui.siteId]) runScan(ui.siteId, d.checks ? d.checks.split(',') : []); break;
    case 'conn-save': saveConnection(); break;
    case 'conn-test': testConnection(); break;
    case 'conn-disconnect': disconnectSite(); break;
    case 'fix-plan': openPlan(d.finding); break;
    case 'ai-review': if (s.sites[ui.siteId]) aiReview(ui.siteId, d.item); break;
    case 'ai-audit': if (s.sites[ui.siteId]) startAiAudit(ui.siteId, d.scope || 'pending'); break;
    case 'ai-audit-stop': if (ui.aiRun) { ui.aiRun.stop = true; render(); } break;
    case 'ai-clear-key': clearAiKey(); break;
    case 'fix-revert': revertOps([d.op]); break;
    case 'toggle-pause': togglePause(!ui.connection[ui.siteId]?.paused); break;
    case 'sign-out': auth.signOut().then(() => location.reload()); break;
    case 'theme': store.dispatch('theme/set', { theme: s.theme === null ? 'dark' : (s.theme === 'dark' ? 'light' : null) }); break;
    case 'export': exportJson(s); break;
    case 'import': $('#import-input').click(); break;
    case 'reset-demo':
      if (confirm('Replace all data with the demo dataset?')) { store.dispatch('state/replace', { state: demoState() }); toast('Demo data restored.'); go('dashboard'); }
      break;
    case 'clear-all':
      if (confirm('Delete every client, site, flag and fix request? Export first if you need a backup.')) { store.dispatch('state/replace', { state: emptyState() }); toast('All data deleted.'); go('clients'); }
      break;
    case 'modal-close': closeModals(); break;
  }
});

function exportJson(s) {
  const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rankops-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Export downloaded.');
}

/* ================= automation (API backend only) ================= */
/** The most recent verdict for an item: the deterministic scanner's or an AI review's, whichever is newer. */
function findingForItem(itemId) {
  const all = ui.findings[ui.siteId] || [];
  const check = ITEM_CHECKS[itemId];
  const scan = check ? all.find(f => f.checkId === check) : null;
  const ai = all.find(f => f.checkId === 'ai:' + itemId) || null;
  if (scan && ai) return new Date(ai.createdAt) > new Date(scan.createdAt) ? ai : scan;
  return ai || scan || null;
}
const siteConnected = (siteId) => !!ui.connection[siteId]?.connected;
async function api(method, path, body, opts) {
  try { return await adapter.call(method, path, body, opts); }
  catch (e) { toast(e instanceof ApiError ? e.message : 'Request failed: ' + e.message); throw e; }
}
// Comfortably above the server's own AI-review budget (api/index.js AI_REVIEW_BUDGET_MS, 40s by default)
// plus network + queueing slack, so a genuinely dropped connection is reported as a clear timeout rather
// than the tab waiting indefinitely with no feedback.
const AI_REVIEW_TIMEOUT_MS = 55000;
/** Load connection + findings + fix history for a site once; re-render when they land. */
function ensureAutomationData(siteId, force = false) {
  if (!API) return;
  if (!force && ui.loaded[siteId]) return;
  ui.loaded[siteId] = true;
  Promise.all([
    adapter.call('GET', `/sites/${siteId}/connection`).catch(() => ({ connected: false })),
    adapter.call('GET', `/sites/${siteId}/findings`).catch(() => ({ findings: [] })),
    adapter.call('GET', `/sites/${siteId}/fixes`).catch(() => ({ operations: [] })),
    adapter.call('GET', `/sites/${siteId}/scan`).catch(() => ({ job: null })),
  ]).then(([conn, f, ops, job]) => {
    ui.connection[siteId] = conn; ui.findings[siteId] = f.findings; ui.fixOps[siteId] = ops.operations; ui.scanJob[siteId] = job.job;
    if (ui.view === 'site' && ui.siteId === siteId) render();
  });
}
function refreshAutomation(siteId) { ensureAutomationData(siteId, true); }

function renderAutomation(s, site) {
  const conn = ui.connection[site.id];
  const findings = ui.findings[site.id] || [];
  const ops = ui.fixOps[site.id] || [];
  const job = ui.scanJob[site.id];
  if (!conn) { $('#automation-body').innerHTML = '<div class="empty-note">Loading…</div>'; return; }
  if (!conn.connected) {
    $('#automation-body').innerHTML = `<div class="empty-note big">This site is not connected yet.<br><br><button class="link-btn" data-action="edit-site">Connect it in Site settings</button></div>`;
    return;
  }
  const busy = ui.busy['scan:' + site.id];
  const running = job && (job.status === 'queued' || job.status === 'running');
  const bar = `<div class="scan-bar${conn.paused ? ' paused' : ''}">
      ${conn.paused ? '<b>⏸ Writes are paused for this site.</b>' : `Connected to <b>${esc(conn.baseUrl)}</b>${conn.seoPlugin ? ' · ' + esc(conn.seoPlugin) : ''}${conn.capabilities?.companionPlugin ? ' · companion plugin' : ' · <span title="Install wordpress-plugin/ for revision and debug checks">no companion plugin</span>'}`}
      ${job ? ` · last scan ${esc(job.status)} ${M.relTime(job.finishedAt || job.createdAt)}${running ? ` (${job.pending.length} checks pending — Cron continues them)` : ''}` : ' · never scanned'}
      <span class="spacer"></span>
      <button class="btn-mini" data-action="toggle-pause">${conn.paused ? 'Resume writes' : 'Pause writes'}</button>
      <button class="link-btn" data-action="scan-now" ${busy ? 'disabled' : ''}>${busy ? 'Scanning…' : (running ? 'Re-check now' : 'Scan now')}</button>
    </div>`;
  const rows = findings.length ? findings.map(f => {
    const canFix = f.verdict === 'fail' && f.fixId;
    const reason = f.verdict === 'fail' && !f.fixId ? (FIX_BLOCKED_REASON[f.itemIds[0]] || '') : '';
    return `<tr>
      <td class="mono">${esc(f.ai ? 'AI review' : f.checkId)}<div class="details">${f.itemIds.map(esc).join(', ')}</div></td>
      <td><span class="verdict ${esc(f.verdict)}${f.ai ? ' ai' : ''}">${f.verdict === 'unknown' ? (f.ai ? 'not decided' : 'not checked') : f.verdict}</span></td>
      <td><div class="summary">${esc(f.summary || '')}</div>${f.note ? `<div class="details">${esc(f.note)}</div>` : ''}
        ${f.details && f.details.length ? `<details><summary class="details">${f.details.length} detail${f.details.length === 1 ? '' : 's'}</summary><div class="details">${f.details.slice(0, 25).map(d => `<div>${esc(d.url || d.name || d.detail || '')}${d.url && d.detail ? ' — ' + esc(d.detail) : ''}</div>`).join('')}${f.details.length > 25 ? `<div>… ${f.details.length - 25} more</div>` : ''}</div></details>` : ''}
      </td>
      <td class="mono">${M.relTime(f.createdAt)}</td>
      <td>${f.evidenceUrl ? `<a href="${esc(f.evidenceUrl)}" target="_blank" rel="noopener" class="btn-mini">evidence ↗</a> ` : ''}
          ${canFix ? `<button class="fix-now" data-action="fix-plan" data-finding="${esc(f.id)}">${f.ai ? 'Review AI edits →' : 'Fix →'}</button>` : (reason ? `<span class="tier check" title="${esc(reason)}" style="cursor:help">manual</span>` : '')}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="5" class="empty-note">No scan results yet. ${running ? 'A scan is in progress.' : 'Click <b>Scan now</b>.'}</td></tr>`;
  const opRows = ops.length ? ops.slice(0, 100).map(o => `<tr class="op-row">
      <td class="mono">${esc(o.fixId)}${o.itemId ? `<div class="details">${esc(o.itemId)}</div>` : ''}</td>
      <td class="status-${esc(o.status)}">${esc(o.status)}${o.error ? `<div class="details" style="color:var(--coral)">${esc(o.error)}</div>` : ''}</td>
      <td>${esc(o.describe || '')}${o.target?.url ? `<div class="details">${esc(o.target.url)}</div>` : ''}</td>
      <td class="mono">${M.relTime(o.appliedAt || o.createdAt)}</td>
      <td>${o.status === 'applied' && !o.irreversible ? `<button class="btn-mini danger" data-action="fix-revert" data-op="${esc(o.id)}">Revert</button>` : (o.irreversible && o.status === 'applied' ? '<span class="tier" title="This change cannot be undone">irreversible</span>' : '')}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty-note">No fixes applied yet.</td></tr>';
  const run = ui.aiRun && ui.aiRun.siteId === site.id ? ui.aiRun : null;
  const aiConfigured = ui.ai ? ui.ai.configured : null;
  const aiBar = `<div class="scan-bar">
      <b>✦ AI audit</b> ${aiConfigured === false ? '— <button class="link-btn" data-action="nav" data-view="ai" style="padding:2px 8px">add an API key first</button>' : 'lets the model inspect the live site for every pending item and draft the fixes'}${ui.ai?.autoApply ? ' · <b>auto-apply is ON</b>' : ' · edits wait for your approval'}
      <span class="spacer"></span>
      ${run ? `<span class="ai-progress" style="margin:0">${run.done}/${run.total} reviewed · ${run.pass} pass · ${run.fail} fail · ${run.unknown} undecided${run.current ? ` · now: ${esc(run.current)} (${elapsedLabel(run.currentStartedAt)})` : ''}${run.stop ? ' · stopping…' : ''}</span><button class="btn-mini danger" data-action="ai-audit-stop" ${run.stop ? 'disabled' : ''}>Stop</button>`
          : `<button class="btn-mini" data-action="ai-audit" data-scope="critical" ${aiConfigured === false ? 'disabled' : ''}>Review critical items</button><button class="link-btn" data-action="ai-audit" data-scope="pending" ${aiConfigured === false ? 'disabled' : ''}>Review all pending items</button>`}
    </div>`;
  $('#automation-body').innerHTML = bar + aiBar + `
    <div class="card"><div class="card-head"><h3>Scan results</h3><span class="hint">${findings.filter(f => f.verdict === 'fail').length} failing · ${findings.filter(f => f.verdict === 'pass').length} passing · ${findings.filter(f => f.verdict === 'unknown').length} could not run</span></div>
      <div class="card-body"><table class="auto-table"><thead><tr><th>Check</th><th>Verdict</th><th>Result</th><th>When</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>
    <div class="card"><div class="card-head"><h3>Applied fixes</h3><span class="hint">every change stores what it replaced — revert restores it</span></div>
      <div class="card-body"><table class="auto-table"><thead><tr><th>Fix</th><th>Status</th><th>Change</th><th>When</th><th></th></tr></thead><tbody>${opRows}</tbody></table></div></div>`;
}

async function runScan(siteId, checks = []) {
  const key = 'scan:' + siteId;
  if (ui.busy[key]) return;
  ui.busy[key] = true; render();
  try {
    const r = await api('POST', `/sites/${siteId}/scan`, { checks });
    ui.scanJob[siteId] = r.job; ui.findings[siteId] = r.findings;
    await adapter.sync();                                       // pull the scanner's item/log actions immediately
    const ran = r.job.ran || [];
    const pending = r.job.pending?.length || 0;
    toast(`Scan ${pending ? 'started' : 'complete'} — ${ran.filter(x => x.verdict === 'pass').length} pass · ${ran.filter(x => x.verdict === 'fail').length} fail · ${ran.filter(x => x.verdict === 'unknown').length} could not run${pending ? ` · ${pending} pending` : ''}`);
    if (pending) pollScan(siteId);
  } catch { /* toasted */ }
  finally { ui.busy[key] = false; refreshAutomation(siteId); render(); }
}
function pollScan(siteId, tries = 0) {
  if (tries > 40) return;
  setTimeout(async () => {
    try {
      const { job } = await adapter.call('GET', `/sites/${siteId}/scan`);
      ui.scanJob[siteId] = job;
      if (job && (job.status === 'queued' || job.status === 'running')) return pollScan(siteId, tries + 1);
      await adapter.sync(); refreshAutomation(siteId); toast('Scan finished.');
    } catch { /* ignore */ }
  }, 15000);
}

function fillConnectionForm(siteId) {
  const conn = ui.connection[siteId];
  const status = $('#conn-status'), fields = $('#conn-fields');
  $('#conn-error').textContent = '';
  $('#conn-mode-note').textContent = auth.mode === 'supabase' ? '' : 'Single-agency mode (static API token).';
  if (!conn) { status.innerHTML = '<span class="cap">loading…</span>'; ensureAutomationData(siteId, true); return; }
  const cap = conn.capabilities || {};
  status.innerHTML = conn.connected
    ? `<span class="cap ok">connected</span><span class="cap ${cap.restOk ? 'ok' : 'bad'}">REST</span><span class="cap ${cap.authOk ? 'ok' : 'bad'}">auth</span><span class="cap ${cap.wooOk ? 'ok' : ''}">WooCommerce${cap.wooOk ? '' : ' —'}</span><span class="cap ${cap.seoPlugin ? 'ok' : 'bad'}">${esc(cap.seoPlugin || 'no SEO plugin')}</span><span class="cap ${cap.companionPlugin ? 'ok' : ''}">companion plugin${cap.companionPlugin ? '' : ' missing'}</span>${cap.user ? `<span class="cap">as ${esc(cap.user.name)}</span>` : ''}${conn.paused ? '<span class="cap bad">writes paused</span>' : ''}`
    : '<span class="cap">not connected</span>';
  fields.hidden = false;
  $('#conn-base-url').value = conn.baseUrl || '';
  $('#conn-username').value = conn.capabilities?.user?.slug || '';
  $('#conn-app-password').value = ''; $('#conn-app-password').placeholder = conn.connected ? '•••• (stored, encrypted) — leave blank to keep' : 'xxxx xxxx xxxx xxxx';
  $('#conn-woo-key').value = ''; $('#conn-woo-secret').value = '';
  const st = conn.settings || {};
  $('#conn-org-name').value = st.organizationName || '';
  $('#conn-author-name').value = st.defaultAuthorName || '';
  $('#conn-prefixes').value = Object.entries(st.prefixReplacements || {}).map(([a, b]) => `${a} => ${b}`).join('\n');
  $('#conn-allowed').value = (st.allowedDomains || []).join(', ');
  $('#conn-paused').checked = !!conn.paused;
  $('#conn-test-btn').hidden = !conn.connected;
  $('#conn-disconnect-btn').hidden = !conn.connected;
}
function readFixInputs() {
  const prefixReplacements = {};
  for (const line of $('#conn-prefixes').value.split('\n')) {
    const m = line.split('=>').map(x => x.trim()); if (m.length === 2 && m[0] && m[1]) prefixReplacements[m[0]] = m[1];
  }
  return {
    organizationName: $('#conn-org-name').value.trim() || undefined,
    siteUrl: $('#conn-base-url').value.trim() || undefined,
    defaultAuthorName: $('#conn-author-name').value.trim() || undefined,
    prefixReplacements, legacyPrefixes: Object.keys(prefixReplacements),
    allowedDomains: $('#conn-allowed').value.split(',').map(x => x.trim()).filter(Boolean),
  };
}
async function saveConnection() {
  const siteId = $('#site-form-id').value; if (!siteId) return;
  const err = $('#conn-error'); err.textContent = '';
  const conn = ui.connection[siteId] || {};
  const baseUrl = $('#conn-base-url').value.trim();
  const username = $('#conn-username').value.trim(), appPassword = $('#conn-app-password').value.trim();
  const settings = readFixInputs();
  try {
    if (appPassword || !conn.connected) {
      if (!baseUrl || !username || !appPassword) { err.textContent = 'Site URL, username and application password are all required to connect.'; return; }
      const credentials = { username, appPassword };
      if ($('#conn-woo-key').value.trim()) { credentials.wooKey = $('#conn-woo-key').value.trim(); credentials.wooSecret = $('#conn-woo-secret').value.trim(); }
      ui.connection[siteId] = await adapter.call('PUT', `/sites/${siteId}/connection`, { platform: 'wordpress', baseUrl, credentials, settings });
      toast('Connected. Credentials encrypted and stored.');
    } else {
      ui.connection[siteId] = await adapter.call('PATCH', `/sites/${siteId}/settings`, settings);
      toast('Fix inputs saved.');
    }
    const wantPaused = $('#conn-paused').checked;
    if (wantPaused !== !!ui.connection[siteId].paused) ui.connection[siteId] = await adapter.call('POST', `/sites/${siteId}/pause`, { paused: wantPaused });
    await adapter.sync(); fillConnectionForm(siteId); render();
  } catch (e) { err.textContent = e.message; }
}
async function testConnection() {
  const siteId = $('#site-form-id').value; const err = $('#conn-error'); err.textContent = 'Testing…';
  try { const r = await adapter.call('POST', `/sites/${siteId}/connection/test`); ui.connection[siteId] = r; err.textContent = r.test.ok ? '' : r.test.errors.join('\n'); fillConnectionForm(siteId); }
  catch (e) { err.textContent = e.message; }
}
async function disconnectSite() {
  const siteId = $('#site-form-id').value;
  if (!confirm('Disconnect this site? Stored credentials are deleted. Scan history is kept.')) return;
  try { await api('DELETE', `/sites/${siteId}/connection`); ui.connection[siteId] = { connected: false }; fillConnectionForm(siteId); render(); toast('Disconnected.'); } catch { /* toasted */ }
}
async function togglePause(paused) {
  const siteId = ui.siteId;
  try { ui.connection[siteId] = await api('POST', `/sites/${siteId}/pause`, { paused }); await adapter.sync(); render(); toast(paused ? 'Writes paused.' : 'Writes resumed.'); } catch { /* toasted */ }
}

let currentPlan = null;
async function openPlan(findingId) {
  const siteId = ui.siteId;
  try {
    const { plan } = await api('POST', `/sites/${siteId}/fixes/plan`, { findingId });
    currentPlan = { ...plan, siteId };
    const f = (ui.findings[siteId] || []).find(x => x.id === findingId);
    $('#plan-modal-title').textContent = plan.label;
    $('#plan-head').innerHTML = `<b>${esc(plan.itemId)}</b> ${esc(M.itemLabel(plan.itemId))}${f ? ` — <span style="color:var(--muted)">${esc(f.summary)}</span>` : ''}`;
    $('#plan-ops').innerHTML = plan.ops.length ? plan.ops.map((op, i) => `<label class="plan-op"><input type="checkbox" name="op" value="${i}" checked>
        <div style="flex:1"><div>${esc(op.describe)}${op.lowConfidence ? '<span class="flag">AI is unsure — check it</span>' : ''}${op.changedSinceReview ? '<span class="flag">changed on the site since the review</span>' : ''}${op.irreversible ? '<span class="flag">irreversible</span>' : ''}</div>
        ${op.target?.url ? `<div class="details" style="font-size:11px;color:var(--muted)">${esc(op.target.url)}</div>` : ''}
        <div class="diff"><span class="del">− ${esc(short(op.before))}</span><span class="add">+ ${esc(short(op.after))}</span></div></div></label>`).join('')
      : '<div class="empty-note">Nothing to change — the fixer could not derive a safe edit for these findings.</div>';
    $('#plan-blocked').innerHTML = plan.blocked.length ? `<div class="plan-blocked"><b>${plan.blocked.length} skipped:</b> ${plan.blocked.map(b => esc(b.reason)).filter((v, i, a) => a.indexOf(v) === i).join(' · ')}</div>` : '';
    $('#plan-note').textContent = plan.paused ? 'Writes are paused for this site — resume them to apply.' : 'Nothing has been written yet. Every applied change stores what it replaced and can be reverted from the Automation tab.';
    $('#plan-apply-btn').disabled = !plan.ops.length || plan.paused;
    $('#plan-apply-btn').textContent = `Apply ${plan.ops.length} change${plan.ops.length === 1 ? '' : 's'}`;
    openModal('plan-modal');
  } catch { /* toasted */ }
}
function short(v) { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 160 ? s.slice(0, 157) + '…' : (s || '(empty)'); }
$('#plan-form').addEventListener('submit', async e => {
  e.preventDefault(); if (!currentPlan) return;
  const opIndexes = $$('#plan-ops input[name=op]:checked').map(i => Number(i.value));
  if (!opIndexes.length) return;
  const btn = $('#plan-apply-btn'); btn.disabled = true; btn.textContent = 'Applying…';
  try {
    const r = await api('POST', `/sites/${currentPlan.siteId}/fixes/apply`, { findingId: currentPlan.findingId, opIndexes });
    closeModals();
    await adapter.sync(); refreshAutomation(currentPlan.siteId); render();
    toast(`${r.applied.length} applied${r.failed.length ? `, ${r.failed.length} failed` : ''}. Re-scan to confirm from the outside.`);
  } catch { btn.disabled = false; btn.textContent = 'Apply'; }
});
$('#plan-ops').addEventListener('change', () => { const n = $$('#plan-ops input[name=op]:checked').length; $('#plan-apply-btn').disabled = !n || currentPlan?.paused; $('#plan-apply-btn').textContent = `Apply ${n} change${n === 1 ? '' : 's'}`; });
async function revertOps(opIds) {
  if (!confirm('Revert this change on the live site?')) return;
  try { const r = await api('POST', `/sites/${ui.siteId}/fixes/revert`, { opIds }); toast(`${r.reverted.length} reverted${r.failed.length ? `, ${r.failed.length} could not be` : ''}.`); await adapter.sync(); refreshAutomation(ui.siteId); render(); } catch { /* toasted */ }
}

/* ================= AI review (API backend only) ================= */
async function loadAiSettings(force = false) {
  if (!API || (ui.ai && !force)) return ui.ai;
  try { ui.ai = await adapter.call('GET', '/ai/settings'); }
  catch (e) { ui.ai = { configured: false, error: e.message, provider: 'anthropic', model: '', autoApply: false }; }
  $('#count-ai').hidden = ui.ai.configured;
  if (ui.view === 'ai' || ui.view === 'site') render();
  return ui.ai;
}
function renderAiSettings() {
  const a = ui.ai;
  if (!API) { $('#ai-status').textContent = 'AI review needs the API backend (js/config.js backend: "api").'; return; }
  if (!a) { $('#ai-status').textContent = 'loading…'; loadAiSettings(); return; }
  $('#ai-status').textContent = a.error ? `could not load: ${a.error}` : (a.configured ? `key ${a.keySource === 'env' ? 'from server environment' : 'stored'} · ${a.model}` : 'no key configured');
  if (document.activeElement && $('#ai-form').contains(document.activeElement)) return;      // don't clobber typing
  $('#ai-provider').value = a.provider || 'anthropic';
  $('#ai-model').value = a.model || '';
  $('#ai-model').placeholder = a.defaultModels?.[$('#ai-provider').value] || '';
  $('#ai-auto-apply').checked = !!a.autoApply;
  $('#ai-key').value = '';
  $('#ai-key-note').textContent = a.configured ? `A key ending in ${a.keyMasked?.slice(-4) || '…'} is ${a.keySource === 'env' ? 'set in the server environment' : 'stored for this agency'}. Leave this blank to keep it.` : 'No key yet. Paste one and save.';
}
$('#ai-provider').addEventListener('change', () => { $('#ai-model').placeholder = ui.ai?.defaultModels?.[$('#ai-provider').value] || ''; });
$('#ai-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#ai-save-btn'); btn.disabled = true; btn.textContent = 'Saving & testing…'; $('#ai-error').textContent = '';
  const key = $('#ai-key').value.trim();
  try {
    const r = await api('PUT', '/ai/settings', { provider: $('#ai-provider').value, model: $('#ai-model').value.trim(), autoApply: $('#ai-auto-apply').checked, ...(key ? { apiKey: key } : {}) });
    ui.ai = r; $('#count-ai').hidden = r.configured; $('#ai-key').value = '';
    if (r.test) { if (r.test.ok) toast(`Key works — ${r.test.model} answered.`); else $('#ai-error').textContent = `Saved, but the key test failed: ${r.test.error}`; }
    else toast('Saved. No key configured yet.');
    render();
  } catch (e2) { $('#ai-error').textContent = e2.message; }
  finally { btn.disabled = false; btn.textContent = 'Save & test key'; }
});
async function clearAiKey() {
  if (!confirm('Remove the stored API key? Reviews will fall back to the server environment key, if any.')) return;
  try { ui.ai = await api('PUT', '/ai/settings', { provider: $('#ai-provider').value, model: $('#ai-model').value.trim(), autoApply: $('#ai-auto-apply').checked, apiKey: '' }); $('#count-ai').hidden = ui.ai.configured; render(); toast('Stored key removed.'); } catch { /* toasted */ }
}

/** One item: run the review, merge the finding, open the diff when edits were proposed. */
async function aiReview(siteId, itemId, { quiet = false } = {}) {
  const key = 'ai:' + siteId + ':' + itemId;
  if (ui.busy[key]) return null;
  ui.busy[key] = { startedAt: Date.now() }; render();
  try {
    const r = await api('POST', `/sites/${siteId}/ai/review`, { itemId }, { timeoutMs: AI_REVIEW_TIMEOUT_MS });
    mergeFinding(siteId, r.finding);
    await adapter.sync();
    if (!quiet) {
      const f = r.finding;
      if (r.applied?.applied) toast(`${itemId}: ${f.verdict} — ${r.applied.applied.length} edit${r.applied.applied.length === 1 ? '' : 's'} applied automatically${r.applied.failed?.length ? `, ${r.applied.failed.length} failed` : ''}.`);
      else if (r.applied?.error) toast(`${itemId}: ${f.verdict} — auto-apply skipped: ${r.applied.error}`);
      else if (f.verdict === 'fail' && f.fixId) { toast(`${itemId}: fail — ${f.details.length} edit${f.details.length === 1 ? '' : 's'} proposed.`); openPlan(f.id); }
      else toast(`${itemId}: ${f.verdict === 'unknown' ? 'could not decide' : f.verdict} — ${f.summary}`);
    }
    return r;
  } catch { return null; }
  finally { delete ui.busy[key]; refreshAutomation(siteId); render(); }
}
function mergeFinding(siteId, finding) {
  const list = (ui.findings[siteId] || []).filter(f => f.checkId !== finding.checkId);
  ui.findings[siteId] = [finding, ...list];
}

/** Every pending item (or only the critical ones), one review at a time, until done or stopped. */
async function startAiAudit(siteId, scope) {
  if (ui.aiRun) return;
  const site = store.state.sites[siteId];
  const items = CHECKLIST.flatMap(c => c.items).filter(it => M.stateOf(site.items, it.id) === 'pending' && (scope !== 'critical' || it.crit));
  if (!items.length) { toast('Nothing pending to review.'); return; }
  if (!confirm(`Review ${items.length} pending item${items.length === 1 ? '' : 's'} with the AI? Each review is one model call sequence (roughly 30–60 s each).${ui.ai?.autoApply ? '\n\nAuto-apply is ON: proposed edits will be written to the site as they are found.' : '\n\nProposed edits will wait for your approval.'}`)) return;
  ui.aiRun = { siteId, total: items.length, done: 0, pass: 0, fail: 0, unknown: 0, current: null, stop: false };
  render();
  for (const it of items) {
    if (ui.aiRun.stop || !store.state.sites[siteId]) break;
    ui.aiRun.current = it.id; ui.aiRun.currentStartedAt = Date.now(); render();
    const r = await aiReview(siteId, it.id, { quiet: true });
    ui.aiRun.done++;
    if (r) ui.aiRun[r.finding.verdict === 'pass' ? 'pass' : r.finding.verdict === 'fail' ? 'fail' : 'unknown']++;
    else ui.aiRun.unknown++;
  }
  const run = ui.aiRun; ui.aiRun = null;
  refreshAutomation(siteId); render();
  toast(`AI audit ${run.stop ? 'stopped' : 'finished'} — ${run.done} reviewed · ${run.pass} pass · ${run.fail} fail · ${run.unknown} undecided. Failing items with edits show “Review AI edits →”.`);
}

/* ---------- sign-in ---------- */
function showAuth(show) { $('#auth-overlay').classList.toggle('open', show); if (show) setTimeout(() => $('#auth-email').focus(), 0); }
$('#auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#auth-error'); err.textContent = ''; $('#auth-submit').disabled = true;
  try {
    const r = await auth.signIn({ email: $('#auth-email').value.trim(), password: $('#auth-password').value });
    if (r.method === 'magic-link') err.textContent = 'Check your email for the sign-in link.';
  } catch (e2) { err.textContent = e2.message || 'Sign-in failed'; }
  finally { $('#auth-submit').disabled = false; }
});

/* ---------- boot ---------- */
store.subscribe(() => render());
async function boot() {
  await auth.init();
  $('#sign-out-btn').hidden = !(API && auth.mode === 'supabase');
  $('#nav-ai').hidden = !API;
  if (API && auth.mode === 'supabase' && !auth.isSignedIn()) {
    showAuth(true);
    await new Promise(resolve => auth.onChange(s => { if (s) resolve(); }));
    showAuth(false);
  }
  auth.onChange(s => { if (API && auth.mode === 'supabase' && !s) location.reload(); });
  await store.ready;
  routeFromHash(); render();
  if (API) loadAiSettings();
}
boot().catch(err => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin', `<div role="alert" style="padding:16px 20px;background:#f3ddd6;color:#c0503a;font:13px sans-serif">RankOps couldn't load its data: ${esc(err.message)}. ${adapter.name === 'api' ? 'Check the Vercel environment variables (DATABASE_URL, ENCRYPTION_KEY) and redeploy after changing them, check the Supabase schema and your agency membership, or switch js/config.js back to local.' : ''}</div>`);
});
window.rankops = { store, ui, go, adapter, auth };   // exposed for debugging and the browser test
