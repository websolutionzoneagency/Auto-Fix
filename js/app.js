// RankOps Console — UI layer. Reads store.state, renders, and turns clicks into store.dispatch() calls.
// No business logic lives here: health, sorting and status rules are in model.js; mutations in store.js.
import { CONFIG } from './config.js';
import { CHECKLIST, TOTAL_ITEMS, CRITICAL } from './checklist.js';
import * as M from './model.js';
import { createStore, makeClient, makeSite, makeFlag, makeFixReq, emptyState } from './store.js';
import { createLocalAdapter } from './adapters/local.js';
import { createApiAdapter } from './adapters/api.js';
import { demoState } from './seed.js';

const adapter = CONFIG.backend === 'api' ? createApiAdapter(CONFIG) : createLocalAdapter({ key: CONFIG.storageKey });
const store = createStore({ adapter, seed: demoState });

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = M.escapeHtml;
const VIEWS = ['dashboard', 'clients', 'flags', 'site', 'templates'];
const SUBS = ['checklist', 'fixreq', 'siteflags', 'log'];
const SEV_RANK = { high: 0, medium: 1, low: 2 };

/* ---------- UI-only state (what's open, filters, search) — never persisted ---------- */
const ui = {
  view: 'dashboard', siteId: null, sub: 'checklist',
  search: '', flagFilter: 'all', showResolved: false,
  checklistFilter: 'all', openCats: new Set(), editingEvidence: null,
  tmplSearch: '',
};

/* ---------- routing (#/dashboard, #/site/<id>/<tab>) ---------- */
function routeFromHash() {
  const [view, a, b] = location.hash.replace(/^#\/?/, '').split('/');
  if (view === 'site' && a && store.state.sites[a]) { ui.view = 'site'; ui.siteId = a; if (SUBS.includes(b)) ui.sub = b; }
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

  if (ui.sub === 'checklist') renderChecklist(site, reqs);
  else if (ui.sub === 'fixreq') renderKanban(reqs);
  else if (ui.sub === 'siteflags') renderSiteFlags(s, flags);
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
  } else if (st === 'pending') {
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
  $('#tmpl-sub').textContent = `${TOTAL_ITEMS} items in ${CHECKLIST.length} categories · ${CRITICAL.size} critical (each open one costs a site 6 health points)`;
  $('#templates-body').innerHTML = CHECKLIST.map((cat, i) => {
    const items = cat.items.filter(it => !q || it.id.toLowerCase().includes(q) || it.label.toLowerCase().includes(q) || (it.hint || '').toLowerCase().includes(q));
    if (q && !items.length) return '';
    const crit = cat.items.filter(x => x.crit).length;
    return `<div class="card">
      <div class="card-head"><h3>${String(i + 1).padStart(2, '0')} · ${esc(cat.title)}</h3><span class="hint">${items.length} item${items.length === 1 ? '' : 's'}${crit ? ` · ${crit} critical` : ''}</span></div>
      <div class="card-body">${items.map(it => `<div class="tmpl-item"><span class="tmpl-code">${esc(it.id)}</span><span class="tmpl-label">${esc(it.label)}${it.hint ? `<span class="tmpl-hint">${esc(it.hint)}</span>` : ''}</span>${it.crit ? '<span class="crit-badge">Critical</span>' : ''}</div>`).join('')}</div>
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
      store.dispatch('audit/record', { siteId: ui.siteId });
      toast('Audit date recorded. Nothing was scanned — connect a CMS connector for live checks.');
      break;
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

/* ---------- boot ---------- */
store.subscribe(() => render());
store.ready.then(() => { routeFromHash(); render(); }).catch(err => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin', `<div role="alert" style="padding:16px 20px;background:#f3ddd6;color:#c0503a;font:13px sans-serif">RankOps couldn't load its data: ${esc(err.message)}. ${adapter.name === 'api' ? 'Check the API token and DATABASE_URL, or switch js/config.js back to local.' : ''}</div>`);
});
window.rankops = { store, ui, go };   // exposed for debugging and the browser test
