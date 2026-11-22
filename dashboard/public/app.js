'use strict';
document.documentElement.classList.add('js');

/* ══════════════════════════════════════════════════════════════════════════
   MCBot Control — core: helpers, state, API, SSE, rendering
   ══════════════════════════════════════════════════════════════════════════ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls = 'ico') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const nowMs = () => Date.now();

/* ── Minecraft item textures (jsDelivr, with block fallback) ────────────── */
function assetVersion(version) {
  return /^\d+\.\d+(?:\.\d+)?$/.test(String(version || '')) ? version : '1.20.1';
}
function itemIconUrl(name, version) {
  return `/api/icon/${encodeURIComponent(assetVersion(version))}/${encodeURIComponent(name)}.png`;
}
function itemImgHtml(item, version, cls = 'item-img') {
  if (!item || !item.name) return '';
  return `<img class="${cls}" src="${itemIconUrl(item.name, version)}" alt="${esc(item.displayName || item.name)}" loading="lazy" decoding="async" data-item="${esc(item.name)}" data-version="${esc(assetVersion(version))}" data-fallback="1" />`;
}
function itemTipText(item) {
  if (!item) return '';
  const bits = [item.displayName || item.name];
  if (item.count > 1) bits.push(`×${item.count}`);
  if (item.maxDurability && item.durabilityUsed) bits.push(`${Math.max(0, item.maxDurability - item.durabilityUsed)}/${item.maxDurability} durability`);
  (item.enchants || []).forEach((e) => bits.push(`${e.name} ${e.lvl}`));
  return bits.join(' · ');
}
function itemCountHtml(item) {
  return item && item.count > 1 ? `<span class="slot__count">${item.count}</span>` : '';
}
function durabilityHtml(item) {
  if (!item || !item.maxDurability || !item.durabilityUsed) return '';
  const left = Math.max(0, item.maxDurability - item.durabilityUsed);
  const pct = Math.round((left / item.maxDurability) * 100);
  const tone = pct > 55 ? 'good' : (pct > 25 ? 'warn' : 'bad');
  return `<span class="slot__dur ${tone}"><i style="width:${pct}%"></i></span>`;
}

const revealState = new Set();
let revealObserver = null;

function initReveals(root = document) {
  if (revealObserver) { revealObserver.disconnect(); revealObserver = null; }
  const scope = root || document;
  const els = Array.from(scope.querySelectorAll('[data-reveal]'));
  if (!els.length) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    els.forEach((el) => el.classList.add('is-in', 'no-anim'));
    return;
  }
  revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      el.classList.add('is-in');
      if (el.dataset.reveal) revealState.add(el.dataset.reveal);
      revealObserver.unobserve(el);
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -30px 0px' });
  els.forEach((el) => {
    const key = el.dataset.reveal || '';
    if (key && revealState.has(key)) { el.classList.add('is-in', 'no-anim'); return; }
    revealObserver.observe(el);
  });
}

const PAGES = {
  dashboard: { title: 'Command center', sub: 'Everything your bots are doing, at a glance.' },
  servers: { title: 'Servers', sub: 'Group bots by server and cut power to a whole server at once.' },
  groups: { title: 'Bot groups', sub: 'Bundle bots into groups and control each collection with one switch.' },
  bot: { title: 'Bot profile', sub: 'Everything this bot is doing, on one page.' },
  terminal: { title: 'Terminal', sub: 'Every bot, one merged terminal — filter it, search it, command it.' },
  activity: { title: 'Activity', sub: 'A live feed of chat, logins, switches and errors across every bot.' },
};

const STATUS = {
  online: { label: 'Online', pill: 'pill--online', dot: 'online' },
  connecting: { label: 'Connecting', pill: 'pill--connecting', dot: 'connecting' },
  reconnecting: { label: 'Retrying', pill: 'pill--connecting', dot: 'connecting' },
  error: { label: 'Error', pill: 'pill--error', dot: 'error' },
  stopped: { label: 'Stopped', pill: 'pill--stopped', dot: 'stopped' },
  offline: { label: 'Offline', pill: 'pill--offline', dot: 'stopped' },
};

const state = {
  authed: false,
  loading: true,
  bots: [],
  groups: [],
  stats: {},
  view: 'dashboard',
  query: '',
  filter: 'all',
  groupFilter: 'all',
  activityFilter: 'all',
  activityQuery: '',
  activity: [],
  terminalLogs: [],
  botId: null,
  termLoaded: false,
  termFilter: 'all',
  termQuery: '',
  termTarget: '',
  termPaused: false,
  termHistory: [],
  termHistoryIndex: -1,
  termTimer: null,
  logs: new Map(),
  consoleId: null,
  unread: false,
  sse: null,
  tick: null,
  viewTimer: null,
  lastEventAt: 0,
  live: 'connecting',
  sseWatch: null,
  sseTimer: null,
};

let formDraft = null;
let confirmResolver = null;
let consoleHistory = [];
let consoleHistoryIndex = -1;

/* ── formatting ─────────────────────────────────────────────────────────── */
function statusMeta(bot) { return STATUS[bot && bot.status] || STATUS.stopped; }
function isActive(bot) { return !!bot && ['online', 'connecting', 'reconnecting'].includes(bot.status); }
function findBot(id) { return state.bots.find((b) => b.id === id) || null; }
function initial(name) { return String(name || '?').trim().charAt(0).toUpperCase() || '?'; }

function hashHue(name) {
  let h = 0;
  for (const ch of String(name || 'bot')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/* One identity per server — every bot on the same host:port shares its hue. */
function serverKey(bot) { return bot ? `${bot.host}:${bot.port}` : ''; }
function serverHueOf(bot) { return hashHue(serverKey(bot)); }
function serverLabel(bot) { return bot ? `${bot.host}${bot.port && bot.port !== 25565 ? `:${bot.port}` : ''}` : ''; }

/* The tab-list is shared by every bot on a server — never sum it per bot. */
function uniquePlayers(bots) {
  const byServer = new Map();
  (bots || []).forEach((b) => {
    if (!b || b.status !== 'online') return;
    const k = serverKey(b);
    byServer.set(k, Math.max(byServer.get(k) || 0, b.players || 0));
  });
  return Array.from(byServer.values()).reduce((n, v) => n + v, 0);
}

/* Real Minecraft skin heads (proxied + cached by the dashboard). */
function skinUrl(name, kind = 'head', size = 64) {
  return `/api/skin/${encodeURIComponent(name)}.png?kind=${kind}&size=${size}`;
}
function skinHeadHtml(name, cls = 'avatar-skin') {
  return `<img class="${cls}" src="${skinUrl(name)}" alt="" loading="lazy" decoding="async" data-skin="1" />`;
}

function prettyGameId(v) {
  if (v == null) return '—';
  const s = String(v).replace(/^minecraft:/, '').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtClock(t) {
  return new Date(t).toLocaleTimeString('en-GB', { hour12: false });
}

function fmtRelative(t) {
  const diff = Math.max(0, nowMs() - Number(t || 0));
  if (diff < 10000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function kindLabel(kind) {
  return ({ chat: 'chat', sent: 'sent', info: 'system', ok: 'success', warn: 'warning', err: 'error', auth: 'auth' })[kind] || 'event';
}

/* ── derived stats (always fresh from the bot list) ─────────────────────── */
function getStats() {
  const bots = state.bots;
  const online = bots.filter((b) => b.status === 'online').length;
  const connecting = bots.filter((b) => b.status === 'connecting' || b.status === 'reconnecting').length;
  const servers = new Set(bots.map((b) => `${b.host}:${b.port}`)).size;
  const players = uniquePlayers(bots);
  return {
    total: bots.length,
    online,
    connecting,
    offline: bots.length - online - connecting,
    servers,
    groups: state.groups.length,
    players,
    masterOn: online + connecting > 0,
  };
}

function matchesQuery(bot) {
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  return `${bot.name} ${bot.host} ${bot.host}:${bot.port}`.toLowerCase().includes(q);
}

function filteredBots() {
  return state.bots.filter((b) => {
    if (!matchesQuery(b)) return false;
    if (state.groupFilter !== 'all' && !(b.groupIds || []).includes(state.groupFilter)) return false;
    if (state.filter === 'online') return isActive(b);
    if (state.filter === 'offline') return !isActive(b);
    return true;
  });
}

function filteredActivity() {
  const q = state.activityQuery.trim().toLowerCase();
  return state.activity.filter((item) => {
    if (state.activityFilter === 'chat' && !['chat', 'sent'].includes(item.entry.kind)) return false;
    if (state.activityFilter === 'system' && ['chat', 'sent'].includes(item.entry.kind)) return false;
    if (q) {
      const bot = findBot(item.id);
      const hay = `${item.name} ${item.entry.text} ${bot ? serverLabel(bot) : ''} ${kindLabel(item.entry.kind)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/* ── API ────────────────────────────────────────────────────────────────── */
async function api(path, opts = {}) {
  const options = { credentials: 'same-origin', ...opts };
  if (options.body && !options.headers) options.headers = { 'Content-Type': 'application/json' };
  const res = await fetch(path, options);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (res.status === 401) {
    showLogin();
    throw new Error('Session expired. Please sign in again.');
  }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

/* ── rendering: page head ───────────────────────────────────────────────── */
function pageHead(eyebrow, title, sub, actions = '') {
  return `
    <div class="page-head">
      <div class="page-head__text">
        <span class="eyebrow">${esc(eyebrow)}</span>
        <h2>${esc(title)}</h2>
        <p>${esc(sub)}</p>
      </div>
      <div class="page-head__actions">${actions}</div>
    </div>`;
}

function statCard(iconName, value, label, hint, cls = '') {
  return `
    <div class="stat ${cls}">
      <span class="stat__icon">${icon(iconName)}</span>
      <div>
        <div class="stat__value">${value}</div>
        <div class="stat__label">${esc(label)}</div>
        <div class="stat__hint">${esc(hint)}</div>
      </div>
    </div>`;
}

function statsHtml() {
  const s = getStats();
  return `
    <div class="stats" id="stats">
      ${statCard('zap', s.online, 'Bots online', s.connecting ? `${s.connecting} connecting` : 'All systems go')}
      ${statCard('cube', s.total, 'Total bots', s.offline ? `${s.offline} offline · unlimited` : 'Unlimited bots', 'stat--cyan')}
      ${statCard('server', s.servers, 'Servers', 'unique endpoints', 'stat--violet')}
      ${statCard('users', s.players, 'Players online', 'seen by your bots', 'stat--amber')}
    </div>`;
}

function serverPulseHtml() {
  if (!state.bots.length) return '';
  const map = new Map();
  state.bots.forEach((b) => {
    const key = serverKey(b);
    const rec = map.get(key) || { key, host: b.host, port: b.port, hue: hashHue(key), bots: 0, online: 0, players: 0 };
    rec.bots += 1;
    if (b.status === 'online') {
      rec.online += 1;
      rec.players = Math.max(rec.players, b.players || 0);
    }
    map.set(key, rec);
  });
  return `
    <div class="server-pulse" data-reveal="dash-pulse">
      <span class="server-pulse__label">${icon('server')} Server pulse</span>
      <div class="server-pulse__list">
        ${Array.from(map.values()).map((s) => `
          <div class="server-pill ${s.online ? 'is-online' : ''}" style="--server:${s.hue}">
            <i class="server-pill__dot"></i>
            <span class="server-pill__name">${esc(serverLabel(s))}</span>
            <span class="server-pill__stat">${s.online}/${s.bots} bots</span>
            <span class="server-pill__stat server-pill__stat--players">${s.players} players</span>
          </div>`).join('')}
      </div>
    </div>`;
}

function groupFilterHtml() {
  if (!state.groups.length) return '';
  return `
    <div class="group-filter" role="tablist" aria-label="Filter by group">
      <button class="group-chip ${state.groupFilter === 'all' ? 'is-active' : ''}" data-group-filter="all">
        ${icon('group')}<span>All groups</span><em>${state.bots.length}</em>
      </button>
      ${state.groups.map((g) => {
        const n = state.bots.filter((b) => (b.groupIds || []).includes(g.id)).length;
        return `<button class="group-chip ${state.groupFilter === g.id ? 'is-active' : ''}" data-group-filter="${esc(g.id)}" style="--group:${esc(g.color)}">
          <i></i><span>${esc(g.name)}</span><em>${n}</em>
        </button>`;
      }).join('')}
      <button class="group-chip group-chip--add" data-action="add-group">${icon('plus')}<span>New</span></button>
    </div>`;
}

/* ── rendering: bot card ────────────────────────────────────────────────── */
function inventoryStripHtml(bot) {
  const items = Array.isArray(bot.inventoryPreview) ? bot.inventoryPreview : [];
  const used = bot.inventoryUsed || 0;
  if (!items.length) {
    return `<button class="bot-inv is-off" type="button" data-action="inventory" data-id="${esc(bot.id)}" data-inv="${esc(inventorySig(bot))}" aria-label="Open inventory">
      <span class="bot-inv__empty">${icon('chest')}<span>${bot.status === 'online' ? 'Inventory is empty' : 'Inventory offline'}</span></span>
      ${icon('arrow', 'ico bot-inv__arrow')}
    </button>`;
  }
  const shown = items.slice(0, 6);
  return `<button class="bot-inv" type="button" data-action="inventory" data-id="${esc(bot.id)}" data-inv="${esc(inventorySig(bot))}" aria-label="Open ${esc(bot.name)} inventory">
    <span class="bot-inv__slots">
      ${shown.map((it) => `<span class="mini-slot" title="${esc(itemTipText(it))}">${itemImgHtml(it, bot.version, 'mini-img')}${itemCountHtml(it)}</span>`).join('')}
      ${used > shown.length ? `<span class="mini-more">+${used - shown.length}</span>` : ''}
    </span>
    <span class="bot-inv__label">${icon('chest')}<b>${used}</b><span>/36</span></span>
    ${icon('arrow', 'ico bot-inv__arrow')}
  </button>`;
}

function vitalsHtml(bot) {
  if (bot.status !== 'online') return '';
  const hp = Number.isFinite(bot.health) ? Math.max(0, Math.min(20, bot.health)) : null;
  const food = Number.isFinite(bot.food) ? Math.max(0, Math.min(20, bot.food)) : null;
  const p = bot.position;
  const pos = p && Number.isFinite(p.x) ? `${p.x} ${p.y} ${p.z}` : '';
  if (hp === null && food === null && !pos) return '';
  return `<div class="bot-vitals">
    ${hp !== null ? `<span class="vital vital--hp" title="Health ${hp}/20">${icon('heart')}<b>${hp}</b><i><em style="width:${(hp / 20) * 100}%"></em></i></span>` : ''}
    ${food !== null ? `<span class="vital vital--food" title="Food ${food}/20">${icon('food')}<b>${food}</b><i><em style="width:${(food / 20) * 100}%"></em></i></span>` : ''}
    ${bot.autoEat ? `<span class="bot-flag" title="Auto-eat is on">${icon('food')}AE</span>` : ''}
    ${pos ? `<span class="bot-coords" title="Position">${icon('pin')}${esc(pos)}</span>` : ''}
  </div>`;
}

function structuralSig(bot) {
  return [bot.name, bot.status, bot.loggedIn, bot.autoEat, bot.version, bot.host, bot.port,
    (bot.groupIds || []).slice().sort().join(',')].join('|');
}
function inventorySig(bot) {
  return `${bot.inventoryUsed || 0}|` + (bot.inventoryPreview || []).map((it) => `${it.name}:${it.count}:${it.durabilityUsed || 0}`).join(',');
}

function botCard(bot, i = 0) {
  const st = statusMeta(bot);
  const active = isActive(bot);
  const hue = hashHue(bot.name);
  const uptime = bot.joinedAt ? fmtDuration(nowMs() - bot.joinedAt) : '—';
  const last = bot.lastLog ? bot.lastLog.text : 'No activity yet — start the bot to see live chat.';
  const loginLabel = bot.loggedIn ? 'Verified' : (bot.autoLogin ? 'Auto' : 'Off');
  const loginCls = bot.loggedIn ? 'good' : (bot.autoLogin ? '' : 'warn');
  const groups = (bot.groupIds || []).map((id) => state.groups.find((g) => g.id === id)).filter(Boolean);
  const sKey = serverKey(bot);
  const sHue = hashHue(sKey);
  const peers = state.bots.filter((b) => serverKey(b) === sKey).length;
  const groupsHtml = groups.length
    ? `<div class="bot-groups">${groups.map((g) => `<span class="bot-group" style="--group:${esc(g.color)}"><i></i>${esc(g.name)}</span>`).join('')}</div>`
    : '';
  return `
    <article class="bot-card ${bot.status === 'online' ? 'is-online' : ''} ${peers > 1 ? 'is-shared' : ''}" data-id="${esc(bot.id)}" data-sig="${esc(structuralSig(bot))}" style="--i:${i};--hue:${hue};--server:${sHue}">
      <div class="bot-card__top">
        <button class="bot-avatar bot-avatar--btn" type="button" style="--hue:${hue}" data-action="bot-page" data-id="${esc(bot.id)}" title="Open ${esc(bot.name)}'s full profile" aria-label="Open ${esc(bot.name)}'s full profile"><span class="avatar-initial">${esc(initial(bot.name))}</span>${skinHeadHtml(bot.name)}<span class="status-dot ${st.dot}"></span></button>
        <button class="bot-id bot-id--btn" type="button" data-action="bot-page" data-id="${esc(bot.id)}" title="Open ${esc(bot.name)}'s full page">
          <h3 title="${esc(bot.name)}">${esc(bot.name)}</h3>
          <p title="${esc(bot.host)}:${bot.port}"><i class="server-dot"></i>${esc(serverLabel(bot))}</p>
        </button>
        <span class="pill ${st.pill}"><i></i>${st.label}</span>
      </div>

      <div class="bot-meta">
        <div class="bot-meta__item"><span>Uptime</span><b data-uptime="${bot.joinedAt || ''}">${uptime}</b></div>
        <div class="bot-meta__item"><span>Players</span><b>${bot.status === 'online' ? (bot.players || 0) : '—'}</b></div>
        <div class="bot-meta__item"><span>Version</span><b>${esc(bot.version)}</b></div>
        <div class="bot-meta__item"><span>Login</span><b class="${loginCls}">${loginLabel}</b></div>
      </div>

      ${vitalsHtml(bot)}

      ${groupsHtml}

      ${inventoryStripHtml(bot)}

      <div class="bot-last" title="${esc(last)}">${esc(last)}</div>

      <div class="bot-actions">
        <button class="switch ${active ? 'is-on' : ''}" type="button" role="switch" aria-checked="${active}"
          data-action="toggle" data-id="${esc(bot.id)}" aria-label="${active ? 'Stop' : 'Start'} ${esc(bot.name)}">
          <span class="switch__track"><span class="switch__thumb"></span></span>
          <span class="switch__label">${active ? 'On' : 'Off'}</span>
        </button>
        <button class="btn btn-ghost btn-sm" data-action="console" data-id="${esc(bot.id)}">
          ${icon('terminal')}<span class="hide-sm">Console</span>
        </button>
        <button class="icon-btn" data-action="bot-page" data-id="${esc(bot.id)}" title="Open full bot page" aria-label="Open ${esc(bot.name)} full page">${icon('arrow')}</button>
        <button class="icon-btn" data-action="restart" data-id="${esc(bot.id)}" title="Restart" aria-label="Restart ${esc(bot.name)}">${icon('restart')}</button>
        <button class="icon-btn" data-action="edit" data-id="${esc(bot.id)}" title="Edit" aria-label="Edit ${esc(bot.name)}">${icon('edit')}</button>
        <button class="icon-btn is-danger" data-action="delete" data-id="${esc(bot.id)}" title="Delete" aria-label="Delete ${esc(bot.name)}">${icon('trash')}</button>
      </div>
    </article>`;
}

function emptyState() {
  return `
    <div class="empty">
      <svg class="empty__art" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="30" y="40" width="60" height="48" rx="14"/>
        <path d="M60 40V27"/><circle cx="60" cy="21" r="4"/>
        <rect x="43" y="57" width="11" height="11" rx="3.5" fill="currentColor" fill-opacity=".16"/>
        <rect x="66" y="57" width="11" height="11" rx="3.5" fill="currentColor" fill-opacity=".16"/>
        <path d="M52 76h16"/>
        <path d="M24 62h-7M103 62h-7" opacity=".45"/>
        <path d="M17 31l9 4-9 4M103 87l-9-4 9-4" opacity=".3"/>
        <circle cx="23" cy="94" r="2.5" opacity=".35"/>
        <circle cx="100" cy="27" r="2" opacity=".45"/>
      </svg>
      <h3>No bots yet</h3>
      <p>Add your first Minecraft bot — name, server IP and password. Auto-login and server switching are handled for you.</p>
      <button class="btn btn-primary" data-action="add">${icon('plus')}<span>Add your first bot</span></button>
    </div>`;
}

function noResults() {
  return `
    <div class="empty">
      <svg class="empty__art" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
        <circle cx="54" cy="54" r="25"/><path d="m73 73 16 16"/>
        <path d="M44 54h20" opacity=".5"/>
      </svg>
      <h3>No matches</h3>
      <p>No bots match this search or filter. Try a different name, IP or status.</p>
      <button class="btn btn-ghost" data-action="clear-filters">Clear filters</button>
    </div>`;
}

/* ── rendering: dashboard ───────────────────────────────────────────────── */
function fleetHtml(title, sub) {
  const s = getStats();
  const bars = Array.from({ length: 26 }, (_, i) => `<i style="--h:${18 + ((i * 37) % 74)}%;--d:${i * 55}"></i>`).join('');
  const events = state.activity.slice(0, 5);
  const ticker = events.length
    ? events.concat(events).map((item) => {
        const e = item.entry;
        const t = String(e.text || '').slice(0, 90);
        return `<span class="ticker__item"><b>${esc(item.name)}</b>${esc(t)}</span>`;
      }).join('')
    : '<span class="ticker__item"><b>Waiting</b>for the first event…</span>';
  return `
    <section class="fleet">
      <div class="fleet__head">
        <div class="fleet__copy">
          <span class="fleet__eyebrow"><i></i> Fleet control</span>
          <h2>${esc(title)}</h2>
          <p>${esc(sub)}</p>
        </div>
        <div class="fleet__actions">
          <button class="btn btn-ghost" data-action="refresh">${icon('restart')}<span>Refresh</span></button>
          <button class="btn btn-primary" data-action="add">${icon('plus')}<span>Add bot</span></button>
        </div>
      </div>
      <div class="fleet__deck">
        <div class="metric metric--lime"><span>${icon('zap')} Bots online</span><b>${s.online}</b><em>of ${s.total}</em></div>
        <div class="metric metric--blue"><span>${icon('server')} Servers</span><b>${s.servers}</b><em>${s.groups} groups</em></div>
        <div class="metric metric--coral"><span>${icon('users')} Players</span><b>${s.players}</b><em>unique</em></div>
        <div class="metric metric--mint"><span>${icon('clock')} Avg uptime</span><b>${fmtShort(s.avgUptime || 0)}</b><em>${s.connecting} connecting</em></div>
        <div class="fleet__wave" aria-hidden="true"><span>signal</span><div>${bars}</div></div>
        <div class="fleet__health">
          <span class="fleet__health-dot"></span>
          <div><b>${s.masterOn ? 'Streaming' : 'Idle'}</b><em>live socket</em></div>
        </div>
      </div>
      <div class="ticker">
        <span class="ticker__tag">Live</span>
        <div class="ticker__viewport"><div class="ticker__track">${ticker}</div></div>
      </div>
    </section>`;
}

function fmtShort(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function dashboardHtml() {
  const s = getStats();
  const bots = filteredBots();
  const title = s.total === 0 ? 'Let’s get your first bot online.'
    : s.online > 0 ? 'Your bots are live.' : 'Your bots are ready when you are.';
  const sub = s.total === 0
    ? 'Add a server, drop in the password, and the bot will log in and stay connected for you.'
    : `${s.online} online · ${s.connecting} connecting · ${s.servers} server${s.servers === 1 ? '' : 's'} under control.`;

  return `
    ${fleetHtml(title, sub)}
    ${serverPulseHtml()}
    ${groupFilterHtml()}
    <div class="section-head">
      <div class="section-head__title">
        <h3>Your bots</h3>
        <span class="section-head__count">${bots.length} of ${state.bots.length}</span>
      </div>
      <div class="section-head__actions">
        <div class="chips" role="tablist" aria-label="Filter bots">
          <button class="chip ${state.filter === 'all' ? 'is-active' : ''}" data-filter="all">All</button>
          <button class="chip ${state.filter === 'online' ? 'is-active' : ''}" data-filter="online">Online</button>
          <button class="chip ${state.filter === 'offline' ? 'is-active' : ''}" data-filter="offline">Offline</button>
        </div>
      </div>
    </div>
    ${bots.length
      ? `<div class="bot-grid">${bots.map((b, i) => botCard(b, i)).join('')}</div>`
      : (state.bots.length ? noResults() : emptyState())}
    ${activityPreviewHtml()}`;
}

/* ── rendering: servers ─────────────────────────────────────────────────── */
function serversHtml() {
  const visible = state.bots.filter(matchesQuery);
  const groups = new Map();
  visible.forEach((b) => {
    const key = `${b.host}:${b.port}`;
    if (!groups.has(key)) groups.set(key, { host: b.host, port: b.port, bots: [] });
    groups.get(key).bots.push(b);
  });
  const list = Array.from(groups.values());

  return `
    ${pageHead('Infrastructure', 'Servers under control', 'One switch per server. Stop every bot on it instantly, or bring the whole group back online.', `
      <button class="btn btn-primary" data-action="add">${icon('plus')}<span>Add bot</span></button>
    `)}
    ${list.length
      ? `<div class="server-grid">${list.map((g, i) => serverCard(g, i)).join('')}</div>`
      : (state.bots.length ? noResults() : emptyState())}`;
}

function serverCard(group, i) {
  const active = group.bots.some(isActive);
  const online = group.bots.filter((b) => b.status === 'online').length;
  const players = uniquePlayers(group.bots);
  return `
    <article class="server-card" style="--i:${i}">
      <div class="server-card__head">
        <span class="server-card__icon">${icon('server')}</span>
        <div style="min-width:0;flex:1">
          <p class="server-card__host">${esc(group.host)}<span style="color:var(--faint)">:${group.port}</span></p>
          <div class="server-card__meta">
            <span><b>${online}</b>/${group.bots.length} online</span>
            <span><b>${players}</b> players</span>
            <span><b>${group.bots.filter((b) => b.loggedIn).length}</b> logged in</span>
          </div>
        </div>
        <button class="switch ${active ? 'is-on' : ''}" type="button" role="switch" aria-checked="${active}"
          data-action="server-toggle" data-host="${esc(group.host)}" data-port="${group.port}"
          aria-label="${active ? 'Stop' : 'Start'} every bot on ${esc(group.host)}">
          <span class="switch__track"><span class="switch__thumb"></span></span>
          <span class="switch__label">${active ? 'On' : 'Off'}</span>
        </button>
      </div>
      <div class="server-bots">
        ${group.bots.map((b) => {
          const st = statusMeta(b);
          return `
            <div class="server-bot">
              <span class="status-dot ${st.dot}"></span>
              <span class="server-bot__name">${esc(b.name)}</span>
              <span class="server-bot__state ${b.status === 'online' ? 'online' : ''}">${st.label}</span>
              <button class="server-bot__open" data-action="console" data-id="${esc(b.id)}" aria-label="Open ${esc(b.name)} console" title="Open console">${icon('terminal')}</button>
            </div>`;
        }).join('')}
      </div>
      <div class="server-card__foot">
        <button class="btn btn-ghost btn-sm" data-action="add-to-server" data-host="${esc(group.host)}" data-port="${group.port}">${icon('plus')} Add bot here</button>
      </div>
    </article>`;
}

/* ── rendering: groups ──────────────────────────────────────────────────── */
function groupMember(b) {
  const st = statusMeta(b);
  return `
    <div class="group-member">
      <span class="status-dot ${st.dot}"></span>
      <span class="group-member__name">${esc(b.name)}</span>
      <span class="group-member__host">${esc(b.host)}:${b.port}</span>
      <span class="server-bot__state ${b.status === 'online' ? 'online' : ''}">${st.label}</span>
      <button class="server-bot__open" data-action="console" data-id="${esc(b.id)}" aria-label="Open ${esc(b.name)} console" title="Open console">${icon('terminal')}</button>
    </div>`;
}

function groupCard(group, i = 0) {
  const members = group.botIds.map(findBot).filter(Boolean);
  const active = members.some(isActive);
  const online = members.filter((b) => b.status === 'online').length;
  const players = uniquePlayers(members);
  return `
    <article class="group-card" style="--i:${i};--group:${esc(group.color)}">
      <span class="group-card__bar"></span>
      <div class="group-card__head">
        <span class="group-card__icon">${icon('group')}</span>
        <div style="min-width:0;flex:1">
          <p class="group-card__name">${esc(group.name)}</p>
          <div class="group-card__meta">
            <span><b>${online}</b>/${members.length} online</span>
            <span><b>${players}</b> players</span>
            <span><b>${members.filter((b) => b.loggedIn).length}</b> logged in</span>
          </div>
        </div>
        <button class="switch ${active ? 'is-on' : ''}" type="button" role="switch" aria-checked="${active}"
          data-action="group-toggle" data-id="${esc(group.id)}" aria-label="${active ? 'Stop' : 'Start'} group ${esc(group.name)}">
          <span class="switch__track"><span class="switch__thumb"></span></span>
          <span class="switch__label">${active ? 'On' : 'Off'}</span>
        </button>
      </div>
      <div class="group-members">
        ${members.length ? members.map(groupMember).join('') : `<p class="group-empty">No bots in this group yet — add a few to control them together.</p>`}
      </div>
      <div class="group-card__foot">
        <button class="btn btn-soft btn-sm" data-action="group-command" data-id="${esc(group.id)}">${icon('terminal')} Run command</button>
        <button class="btn btn-ghost btn-sm" data-action="edit-group" data-id="${esc(group.id)}">${icon('sliders')} Manage bots</button>
        <span style="flex:1"></span>
        <button class="icon-btn" data-action="edit-group" data-id="${esc(group.id)}" title="Edit group" aria-label="Edit ${esc(group.name)}">${icon('edit')}</button>
        <button class="icon-btn is-danger" data-action="delete-group" data-id="${esc(group.id)}" title="Delete group" aria-label="Delete ${esc(group.name)}">${icon('trash')}</button>
      </div>
    </article>`;
}

function groupsEmpty() {
  return `
    <div class="empty">
      <svg class="empty__art" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
        <circle cx="60" cy="38" r="11"/><circle cx="32" cy="78" r="11"/><circle cx="88" cy="78" r="11"/>
        <path d="M52 47 40 68M68 47l12 21M43 78h34" opacity=".7"/>
        <circle cx="60" cy="38" r="3" fill="currentColor" fill-opacity=".25"/>
        <circle cx="32" cy="78" r="3" fill="currentColor" fill-opacity=".25"/>
        <circle cx="88" cy="78" r="3" fill="currentColor" fill-opacity=".25"/>
      </svg>
      <h3>No groups yet</h3>
      <p>Create collections like “Farming”, “AFK” or “Oneblock” and control every bot in them with a single switch.</p>
      <button class="btn btn-primary" data-action="add-group">${icon('plus')}<span>Create your first group</span></button>
    </div>`;
}

function groupsHtml() {
  const q = state.query.trim().toLowerCase();
  const groups = state.groups.filter((g) => !q || g.name.toLowerCase().includes(q));
  const ungrouped = state.bots.filter((b) => !(b.groupIds || []).length && matchesQuery(b));
  return `
    ${pageHead('Collections', 'Bot groups', 'Create unlimited groups, add unlimited bots to each, and power every collection on or off independently.', `
      <button class="btn btn-primary" data-action="add-group">${icon('plus')}<span>New group</span></button>
    `)}
    ${groups.length ? `<div class="groups-grid">${groups.map((g, i) => groupCard(g, i)).join('')}</div>` : groupsEmpty()}
    ${ungrouped.length ? `
      <div class="section-head" style="margin-top:30px">
        <div class="section-head__title"><h3>Ungrouped bots</h3><span class="section-head__count">${ungrouped.length}</span></div>
        <div class="section-head__actions">
          <button class="btn btn-ghost btn-sm" data-action="add-group" data-ungrouped="1">${icon('plus')} Group these bots</button>
        </div>
      </div>
      <div class="group-card group-card--ghost">
        <div class="group-members">${ungrouped.map(groupMember).join('')}</div>
      </div>` : ''}`;
}

/* ── rendering: activity ────────────────────────────────────────────────── */
function activityRow(item) {
  const e = item.entry;
  const bot = findBot(item.id);
  const hue = bot ? serverHueOf(bot) : 210;
  const label = bot ? serverLabel(bot) : '';
  return `
    <div class="activity-row ${bot ? 'has-server' : ''}" style="--server:${hue}">
      <span class="activity-row__dot ${esc(e.kind)}"></span>
      <div class="activity-row__body">
        <div class="activity-row__meta">
          <b>${esc(item.name)}</b>
          ${label ? `<span class="activity-row__server"><i></i>${esc(label)}</span>` : ''}
          <span>${kindLabel(e.kind)}</span>
        </div>
        <div class="activity-row__text">${esc(e.text)}</div>
      </div>
      <span class="activity-row__time" title="${esc(new Date(e.t).toLocaleString())}">${fmtRelative(e.t)}</span>
    </div>`;
}

function activityPreviewHtml() {
  const items = state.activity.slice(0, 6);
  return `
    <div class="section-head" style="margin-top:30px">
      <div class="section-head__title"><h3>Live activity</h3><span class="section-head__count">${state.activity.length} events</span></div>
      <div class="section-head__actions">
        <button class="btn btn-ghost btn-sm" data-action="view-all-activity">View all ${icon('arrow')}</button>
      </div>
    </div>
    <div class="activity-list" id="activity-preview">
      ${items.length ? items.map(activityRow).join('') : `
        <div class="activity-row"><span class="activity-row__dot"></span><div class="activity-row__body">
          <div class="activity-row__meta"><b>Waiting for events</b></div>
          <div class="activity-row__text">Start a bot and its chat will appear here.</div>
        </div></div>`}
    </div>`;
}

function dayLabel(t) {
  const d = new Date(t);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start - day) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function kindIcon(kind) {
  return ({ chat: 'terminal', sent: 'send', auth: 'shield', ok: 'check', warn: 'alert', err: 'alert', info: 'activity' })[kind] || 'activity';
}

function streamRow(item) {
  const e = item.entry;
  const bot = findBot(item.id);
  const hue = bot ? serverHueOf(bot) : 210;
  const chat = ['chat', 'sent'].includes(e.kind);
  const server = bot ? serverLabel(bot) : '';
  return `
    <article class="msg ${chat ? 'msg--chat' : 'msg--system'} kind-${esc(e.kind)}" style="--server:${hue};--hue:${bot ? hashHue(bot.name) : 210}">
      <span class="msg__avatar">
        <span class="msg__initial">${esc(initial(item.name))}</span>
        ${bot ? skinHeadHtml(bot.name, 'msg__skin') : ''}
        <span class="msg__badge">${icon(kindIcon(e.kind))}</span>
      </span>
      <div class="msg__body">
        <div class="msg__head">
          <b>${esc(item.name)}</b>
          ${server ? `<span class="msg__server"><i></i>${esc(server)}</span>` : ''}
          <span class="msg__kind">${kindLabel(e.kind)}</span>
          <time>${fmtClock(e.t)}</time>
        </div>
        <div class="msg__text">${esc(e.text)}</div>
      </div>
    </article>`;
}

function streamListHtml(items) {
  if (!items.length) {
    return `<div class="stream-empty">${icon('terminal')}<h3>Nothing here yet</h3><p>Chat and system events will stream in as soon as a bot connects.</p></div>`;
  }
  let lastDay = '';
  return items.map((item) => {
    const day = dayLabel(item.entry.t);
    const sep = day !== lastDay ? `<div class="msg-day"><span>${esc(day)}</span></div>` : '';
    lastDay = day;
    return sep + streamRow(item);
  }).join('');
}

function activityHtml() {
  const items = filteredActivity();
  const chatCount = state.activity.filter((i) => ['chat', 'sent'].includes(i.entry.kind)).length;
  const systemCount = state.activity.length - chatCount;
  return `
    ${pageHead('Event stream', 'Live activity', 'Every chat line, login, server switch and error across your bots — one clean stream.', `
      <button class="btn btn-ghost" data-action="clear-activity">${icon('trash')}<span>Clear feed</span></button>
    `)}
    <div class="stream-bar">
      <label class="stream-search">
        ${icon('search')}
        <input id="activity-search" type="search" placeholder="Search messages, bots or servers…" aria-label="Search activity" value="${esc(state.activityQuery)}" autocomplete="off" />
      </label>
      <div class="chips" role="tablist" aria-label="Filter activity">
        <button class="chip ${state.activityFilter === 'all' ? 'is-active' : ''}" data-afilter="all">All <em id="act-count-all">${state.activity.length}</em></button>
        <button class="chip ${state.activityFilter === 'chat' ? 'is-active' : ''}" data-afilter="chat">Chat <em id="act-count-chat">${chatCount}</em></button>
        <button class="chip ${state.activityFilter === 'system' ? 'is-active' : ''}" data-afilter="system">System <em id="act-count-system">${systemCount}</em></button>
      </div>
      <span class="stream-count" id="activity-count">${items.length} events</span>
    </div>
    <div class="stream-shell" data-reveal="act-stream">
      <div class="stream" id="activity-feed">${streamListHtml(items)}</div>
    </div>`;
}

/* ── single bot page ────────────────────────────────────────────────────── */
async function openBotPage(id, push = true) {
  const bot = findBot(id);
  if (!bot) return;
  if (state.view === 'bot' && state.botId === id) return;
  if ($('#console-drawer') && $('#console-drawer').classList.contains('is-open')) closeConsole(true);
  revealState.clear();
  state.botId = id;
  state.view = 'bot';
  updateChrome();
  renderView();
  const title = $('#page-title');
  const sub = $('#page-sub');
  if (title) title.textContent = bot.name;
  if (sub) sub.textContent = `${bot.host}:${bot.port} · ${statusMeta(bot).label}`;
  if (push) history.pushState({}, '', `#/bot/${id}`);
  if (window.innerWidth <= 1080) window.scrollTo({ top: 0, behavior: 'smooth' });
  if (!state.logs.get(id) || !state.logs.get(id).length) {
    try {
      const data = await api(`/api/bots/${id}/logs`);
      state.logs.set(id, Array.isArray(data.logs) ? data.logs : []);
      if (state.view === 'bot' && state.botId === id) renderView();
    } catch (_) {}
  }
}

function bpMetric(iconName, label, value, sub = '', tone = '') {
  return `<div class="bpmetric ${tone}">
    <span>${icon(iconName)} ${esc(label)}</span>
    <b>${esc(value)}</b>
    ${sub ? `<em>${esc(sub)}</em>` : ''}
  </div>`;
}

function bpRecentRow(entry) {
  return `<div class="brecent__row kind-${esc(entry.kind || 'chat')}">
    <time>${fmtClock(entry.t)}</time>
    <span class="brecent__kind">${esc(kindLabel(entry.kind))}</span>
    <span class="brecent__text">${esc(entry.text)}</span>
  </div>`;
}

function appendBotRecent(entry) {
  const list = $('#bp-recent');
  if (!list) return;
  const empty = list.querySelector('.brecent__empty');
  if (empty) list.innerHTML = '';
  list.insertAdjacentHTML('afterbegin', bpRecentRow(entry));
  while (list.children.length > 8) list.lastElementChild.remove();
}

function botPageHtml(id) {
  const bot = findBot(id) || state.bots[0];
  if (!bot) {
    return `${pageHead('Bot profile', 'No bot selected', 'Pick a bot from the fleet to open its page.', `<button class="btn btn-primary" data-action="add">${icon('plus')}<span>Add bot</span></button>`)}`;
  }
  const st = statusMeta(bot);
  const d = bot.detail || {};
  const hp = Number.isFinite(bot.health) ? Math.max(0, Math.min(20, bot.health)) : 0;
  const food = Number.isFinite(bot.food) ? Math.max(0, Math.min(20, bot.food)) : 0;
  const xp = d.xp || { level: 0, points: 0, progress: 0 };
  const pos = bot.position ? `${bot.position.x} ${bot.position.y} ${bot.position.z}` : '—';
  const effects = Array.isArray(d.effects) ? d.effects : [];
  const armor = Array.isArray(bot.armor) ? bot.armor : [null, null, null, null];
  const logs = (state.logs.get(bot.id) || []).slice(-8).reverse();
  const inv = Array.isArray(bot.inventoryPreview) ? bot.inventoryPreview : [];
  const used = bot.inventoryUsed || 0;
  const uuid = d.uuid ? String(d.uuid) : '';
  return `
    <div class="botpage" style="--hue:${hashHue(bot.name)};--server:${serverHueOf(bot)}">
      <button class="botpage__back" type="button" data-view="dashboard">${icon('arrow')} Back to fleet</button>

      <header class="botpage__hero" data-reveal="bp-hero">
        <div class="botpage__avatar"><span class="avatar-initial">${esc(initial(bot.name))}</span><img class="botpage__skin" src="${skinUrl(bot.name, 'body', 200)}" alt="" loading="lazy" decoding="async" data-skin="1" /><span class="status-dot ${st.dot}"></span></div>
        <div class="botpage__id">
          <span class="botpage__eyebrow">bot profile</span>
          <h2>${esc(bot.name)} <span class="pill ${st.pill}"><i></i>${st.label}</span></h2>
          <p><i class="server-dot"></i>${esc(bot.host)}:${bot.port} <span>· v${esc(bot.version)}</span></p>
          <div class="player-tags">
            <span class="ptag">${icon('cube')} ${esc(prettyGameId(d.gamemode))}</span>
            <span class="ptag">${icon('pin')} ${esc(prettyGameId(d.dimension))}</span>
            <span class="ptag ${bot.loggedIn ? 'is-good' : ''}">${icon('shield')} ${bot.loggedIn ? 'Logged in' : (bot.autoLogin ? 'Auto login' : 'Not logged in')}</span>
          </div>
        </div>
        <div class="botpage__actions">
          <button class="btn btn-ghost btn-sm" data-action="console" data-id="${esc(bot.id)}">${icon('terminal')}<span>Console</span></button>
          <button class="btn btn-ghost btn-sm" data-action="inventory" data-id="${esc(bot.id)}">${icon('chest')}<span>Inventory</span></button>
          <button class="icon-btn" data-action="restart" data-id="${esc(bot.id)}" title="Restart" aria-label="Restart">${icon('restart')}</button>
          <button class="icon-btn" data-action="edit" data-id="${esc(bot.id)}" title="Edit" aria-label="Edit">${icon('edit')}</button>
        </div>
      </header>

      <div class="botpage__stats" data-reveal="bp-stats" style="--d:70ms">
        ${bpMetric('heart', 'Health', `${hp}/20`, 'hitpoints', hp <= 6 ? 'is-bad' : '')}
        ${bpMetric('food', 'Food', `${food}/20`, 'hunger', food <= 6 ? 'is-warn' : '')}
        ${bpMetric('activity', 'Ping', bot.ping == null ? '—' : `${bot.ping} ms`, 'latency')}
        ${bpMetric('users', 'Players', bot.players == null ? '—' : bot.players, 'on this server')}
        ${bpMetric('clock', 'Uptime', bot.joinedAt ? fmtDuration(nowMs() - bot.joinedAt) : '—', 'this session')}
        ${bpMetric('zap', 'XP level', xp.level || 0, `${xp.points || 0} points`)}
      </div>

      <div class="botpage__grid">
        <section class="bpanel" data-reveal="bp-player" style="--d:120ms">
          <header class="bpanel__head"><h3>Player</h3><span class="bpanel__live"><i></i> live</span></header>
          <div class="bkv">
            <div><span>Position</span><b>${esc(pos)}</b></div>
            <div><span>Dimension</span><b>${esc(prettyGameId(d.dimension))}</b></div>
            <div><span>Difficulty</span><b>${esc(d.difficulty ? String(d.difficulty).charAt(0).toUpperCase() + String(d.difficulty).slice(1) : '—')}</b></div>
            <div><span>Server brand</span><b>${esc(d.serverBrand || '—')}</b></div>
            <div><span>UUID</span><b title="${esc(uuid)}">${uuid ? `${esc(uuid.slice(0, 8))}…${esc(uuid.slice(-4))}` : '—'}</b></div>
            <div><span>Effects</span><b>${effects.length ? effects.map((e) => `${esc(prettyGameId(e.name))}${e.amplifier ? ` ${roman(e.amplifier + 1)}` : ''}`).join(', ') : 'None'}</b></div>
          </div>
          <p class="bpanel__sub">Equipped</p>
          <div class="player-gear">
            <div class="player-gear__slot"><span>Held</span>${slotHtml(bot.heldItem, bot.version)}</div>
            ${armor.map((it, i) => `<div class="player-gear__slot"><span>${['Helmet', 'Chestplate', 'Leggings', 'Boots'][i]}</span>${slotHtml(it, bot.version)}</div>`).join('')}
            <div class="player-gear__slot"><span>Off-hand</span>${slotHtml(bot.offhand, bot.version)}</div>
          </div>
        </section>

        <section class="bpanel" data-reveal="bp-recent" style="--d:170ms">
          <header class="bpanel__head"><h3>Recent activity</h3><button class="bpanel__link" type="button" data-action="console" data-id="${esc(bot.id)}">Open console ${icon('arrow')}</button></header>
          <div class="brecent" id="bp-recent">
            ${logs.length ? logs.map(bpRecentRow).join('') : `<div class="brecent__empty">${icon('terminal')}No activity yet. Open the console and say hello.</div>`}
          </div>
        </section>

        <section class="bpanel bpanel--wide" data-reveal="bp-inv" style="--d:220ms">
          <header class="bpanel__head"><h3>Inventory</h3><span class="bpanel__count">${used}/36 slots</span><button class="bpanel__link" type="button" data-action="inventory" data-id="${esc(bot.id)}">Open inventory ${icon('arrow')}</button></header>
          <div class="binv">
            ${inv.length ? inv.slice(0, 9).map((it) => `<span class="binv__slot">${itemImgHtml(it, bot.version, 'binv__img')}${itemCountHtml(it)}</span>`).join('') : `<span class="binv__empty">${icon('chest')}Inventory is empty</span>`}
            ${used > Math.min(inv.length, 9) ? `<span class="binv__more">+${used - Math.min(inv.length, 9)} more</span>` : ''}
          </div>
          <p class="bpanel__sub">Hotbar first, then storage — the full Minecraft layout lives in the inventory drawer.</p>
        </section>

        <section class="bpanel" data-reveal="bp-session" style="--d:270ms">
          <header class="bpanel__head"><h3>Session</h3><span class="bpanel__live"><i></i> ${st.label}</span></header>
          <div class="bkv">
            <div><span>Auto-eat</span><b>${bot.autoEat ? 'On' : 'Off'}</b></div>
            <div><span>Anti-AFK</span><b>${bot.antiAfk ? 'On' : 'Off'}</b></div>
            <div><span>Auto-reconnect</span><b>${bot.autoReconnect ? 'On' : 'Off'}</b></div>
            <div><span>Auto-login</span><b>${bot.autoLogin ? 'On' : 'Off'}</b></div>
            <div><span>Login attempts</span><b>${bot.loginAttempts || 0}/5</b></div>
            <div><span>Version</span><b>${esc(bot.version)}</b></div>
          </div>
        </section>
      </div>

      <form class="term-composer" id="bot-command-form" data-id="${esc(bot.id)}" autocomplete="off">
        <input id="bot-command-input" type="text" maxlength="250" placeholder="Message or /command for ${esc(bot.name)}…" aria-label="Command for ${esc(bot.name)}" spellcheck="false" />
        <button class="btn btn-primary" type="submit">${icon('send')}<span>Send</span></button>
      </form>
    </div>`;
}

async function submitBotCommand(form) {
  const id = form.dataset.id;
  const input = form.querySelector('input');
  const message = String((input && input.value) || '').trim();
  if (!message) return;
  try {
    await api(`/api/bots/${id}/chat`, { method: 'POST', body: JSON.stringify({ message }) });
    if (input) input.value = '';
    toast('ok', 'Sent', message);
  } catch (e) {
    toast('err', 'Could not send', e.message || String(e));
  }
}

/* ── terminal page ──────────────────────────────────────────────────────── */
async function loadTerminal() {
  if (state.termLoaded) return;
  try {
    const data = await api('/api/logs?limit=600');
    if (Array.isArray(data.entries)) state.terminalLogs = data.entries;
    state.termLoaded = true;
    if (!state.termTarget || state.termTarget === 'all' || !state.bots.some((b) => b.id === state.termTarget)) {
      const first = state.bots.find((b) => b.status === 'online') || state.bots[0];
      state.termTarget = first ? first.id : '';
    }
    if (state.view === 'terminal') renderView();
  } catch (_) {}
}

function termLogsForTarget() {
  if (!state.termTarget) return [];
  return state.terminalLogs.filter((x) => x.id === state.termTarget);
}
function termCounts() {
  const base = termLogsForTarget();
  const c = { total: base.length, chat: 0, system: 0, err: 0 };
  base.forEach((x) => {
    const k = x.entry.kind || 'chat';
    if (['chat', 'sent'].includes(k)) c.chat += 1;
    else c.system += 1;
    if (['err', 'warn'].includes(k)) c.err += 1;
  });
  return c;
}

function termMatches(item) {
  const e = item.entry;
  const kind = e.kind || 'chat';
  if (!state.termTarget || item.id !== state.termTarget) return false;
  if (state.termFilter === 'chat' && !['chat', 'sent'].includes(kind)) return false;
  if (state.termFilter === 'system' && ['chat', 'sent'].includes(kind)) return false;
  if (state.termFilter === 'errors' && !['err', 'warn'].includes(kind)) return false;
  const q = state.termQuery.trim().toLowerCase();
  if (q && !`${item.name} ${e.text}`.toLowerCase().includes(q)) return false;
  return true;
}

function termFiltered() {
  return state.terminalLogs.filter(termMatches);
}

function terminalLineHtml(item) {
  const e = item.entry;
  const kind = e.kind || 'chat';
  const bot = findBot(item.id);
  return `<div class="tline kind-${esc(kind)}">
    <time>${fmtClock(e.t)}</time>
    <span class="tline__bot"><i style="background:hsl(${bot ? serverHueOf(bot) : hashHue(item.name)} 70% 55%)"></i>${esc(item.name)}</span>
    <span class="tline__kind">${esc(kindLabel(kind))}</span>
    <span class="tline__text">${esc(e.text)}</span>
  </div>`;
}

function renderTerminalLines() {
  const box = $('#term-lines');
  if (!box) return;
  const items = termFiltered();
  box.innerHTML = items.length
    ? items.map(terminalLineHtml).join('')
    : `<div class="term-empty">${icon('search')}<b>No lines match</b><span>Change the target, filter or search.</span></div>`;
  const all = termCounts();
  const count = $('#term-count');
  if (count) count.textContent = all.total.toLocaleString();
  const pairs = [['#term-chat', all.chat], ['#term-system', all.system], ['#term-alerts', all.err], ['#term-head-total', all.total], ['#term-head-chat', all.chat], ['#term-head-alerts', all.err]];
  pairs.forEach(([sel, val]) => { const el = $(sel); if (el) el.textContent = val.toLocaleString(); });
  if (!state.termPaused) box.scrollTop = box.scrollHeight;
}

function appendTerminalLine(payload) {
  state.terminalLogs.push(payload);
  if (state.terminalLogs.length > 1200) state.terminalLogs.splice(0, state.terminalLogs.length - 1200);
  const box = $('#term-lines');
  if (!box) return;
  const item = { id: payload.id, name: payload.name, entry: payload.entry };
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (termMatches(item) && !state.termPaused) {
    box.insertAdjacentHTML('beforeend', terminalLineHtml(item));
    if (box.children.length > 800) box.firstElementChild.remove();
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  const count = $('#term-count');
  if (count) count.textContent = termFiltered().length.toLocaleString();
  const all = termCounts();
  const pairs = [['#term-chat', all.chat], ['#term-system', all.system], ['#term-alerts', all.err], ['#term-head-total', all.total], ['#term-head-chat', all.chat], ['#term-head-alerts', all.err]];
  pairs.forEach(([sel, val]) => { const el = $(sel); if (el) el.textContent = val.toLocaleString(); });
  const lastEl = $('#term-head-last');
  if (lastEl) lastEl.textContent = fmtRelative(payload.entry.t);
}

function terminalTargetOptions() {
  const bots = state.bots.slice().sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : (a.status === 'online' ? -1 : 1)));
  if (!bots.length) return '<option value="">No bots yet</option>';
  return bots.map((b) => `<option value="${esc(b.id)}" ${state.termTarget === b.id ? 'selected' : ''}>${esc(b.name)}${b.status === 'online' ? '' : ` — ${b.status}`}</option>`).join('');
}

function terminalHtml() {
  const c = termCounts();
  const online = state.bots.filter((b) => b.status === 'online');
  const last = state.terminalLogs.length ? state.terminalLogs[state.terminalLogs.length - 1].entry : null;
  const fleet = state.bots.slice().sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : (a.status === 'online' ? -1 : 1)));
  return `
    <div class="term-page">
      <div class="term-head">
        <div>
          <span class="term-live"><i></i> live terminal</span>
          <h2>One terminal.<br />Every bot.</h2>
          <p>Merged chat, logins, switches and errors from ${state.bots.length} bots — searchable, filterable and commandable.</p>
        </div>
        <div class="term-statrow">
          <div><b id="term-head-online">${online.length}</b><span>online</span></div>
          <div><b id="term-head-total">${c.total.toLocaleString()}</b><span>lines</span></div>
          <div><b id="term-head-chat">${c.chat.toLocaleString()}</b><span>chat</span></div>
          <div><b id="term-head-alerts">${c.err.toLocaleString()}</b><span>alerts</span></div>
          <div><b id="term-head-last">${last ? fmtRelative(last.t) : '—'}</b><span>last event</span></div>
        </div>
      </div>

      <div class="term-toolbar">
        <select id="term-target" class="term-select" aria-label="Terminal target">
          ${terminalTargetOptions()}
        </select>
        <label class="stream-search">
          ${icon('search')}
          <input id="terminal-search" type="search" placeholder="Search this terminal…" value="${esc(state.termQuery)}" autocomplete="off" />
        </label>
        <div class="chips" role="tablist" aria-label="Terminal filter">
          <button class="chip ${state.termFilter === 'all' ? 'is-active' : ''}" data-term-filter="all">All</button>
          <button class="chip ${state.termFilter === 'chat' ? 'is-active' : ''}" data-term-filter="chat">Chat</button>
          <button class="chip ${state.termFilter === 'system' ? 'is-active' : ''}" data-term-filter="system">System</button>
          <button class="chip ${state.termFilter === 'errors' ? 'is-active' : ''}" data-term-filter="errors">Alerts</button>
        </div>
        <div class="term-actions">
          <button class="btn btn-ghost btn-sm ${state.termPaused ? 'is-on' : ''}" id="term-pause" type="button" title="${state.termPaused ? 'Resume auto-scroll' : 'Pause auto-scroll'}">${icon(state.termPaused ? 'play' : 'pause')}<span>${state.termPaused ? 'Paused' : 'Pause'}</span></button>
          <button class="btn btn-ghost btn-sm" id="term-export" type="button" title="Export lines as .txt">${icon('download')}<span class="hide-sm">Export</span></button>
          <button class="btn btn-ghost btn-sm" id="term-clear" type="button" title="Clear the view">${icon('trash')}<span class="hide-sm">Clear</span></button>
        </div>
      </div>

      <div class="term-shell">
        <div class="term-main">
          <div class="term-lines" id="term-lines"></div>
          <button class="term-jump" id="term-jump" type="button" hidden>${icon('arrow')} Jump to latest</button>
        </div>
        <aside class="term-side">
          <div class="term-card" data-reveal="term-fleet">
            <p class="term-side__title">Fleet</p>
            <div class="term-fleet">
              ${fleet.map((b) => `
                <button type="button" class="term-bot ${state.termTarget === b.id ? 'is-active' : ''}" data-term-bot="${esc(b.id)}">
                  <span class="term-bot__dot"></span>
                  <span class="term-bot__name">${esc(b.name)}</span>
                  <em>${b.status === 'online' ? `${b.ping || 0} ms` : b.status}</em>
                </button>`).join('') || '<span class="term-none">No bots yet.</span>'}
            </div>
          </div>
          <div class="term-card" data-reveal="term-quick" style="--d:80ms">
            <p class="term-side__title">Quick commands</p>
            <div class="term-quick">
              ${['/afk', '/login Sandun123', '/spawn', '/home', '/warp crates', '/list'].map((cmd) => `<button type="button" class="cmd-preset" data-term-cmd="${esc(cmd)}">${esc(cmd)}</button>`).join('')}
            </div>
          </div>
          <div class="term-card" data-reveal="term-session" style="--d:160ms">
            <p class="term-side__title">Session</p>
            <div class="term-session">
              <div><span>Lines</span><b id="term-count">${c.total.toLocaleString()}</b></div>
              <div><span>Chat</span><b id="term-chat">${c.chat.toLocaleString()}</b></div>
              <div><span>System</span><b id="term-system">${c.system.toLocaleString()}</b></div>
              <div><span>Alerts</span><b id="term-alerts">${c.err.toLocaleString()}</b></div>
            </div>
          </div>
        </aside>
      </div>

      <form class="term-composer" id="term-form" autocomplete="off">
        <select id="term-send-target" class="term-select" aria-label="Send to">
          <option value="all">Send to all online bots</option>
          ${state.bots.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}${b.status === 'online' ? '' : ` — offline`}</option>`).join('')}
        </select>
        <input id="term-input" type="text" maxlength="250" placeholder="Type a message or /command…" aria-label="Terminal command" spellcheck="false" />
        <button class="btn btn-primary" type="submit">${icon('send')}<span>Send</span></button>
      </form>
    </div>`;
}

/* ── rendering: view + chrome ───────────────────────────────────────────── */
function loadingHtml() {
  return `
    ${pageHead('Live overview', 'Loading your fleet…', 'Fetching bots, servers and live status.')}
    <div class="stats">${Array.from({ length: 4 }).map(() => '<div class="stat skeleton" style="height:92px"></div>').join('')}</div>
    <div class="loading-grid">${Array.from({ length: 3 }).map(() => '<div class="loading-card skeleton"></div>').join('')}</div>`;
}

function renderView() {
  if (!state.authed) return;
  if (state.loading) { $('#view').innerHTML = loadingHtml(); return; }
  if (state.view === 'servers') $('#view').innerHTML = serversHtml();
  else if (state.view === 'groups') $('#view').innerHTML = groupsHtml();
  else if (state.view === 'activity') $('#view').innerHTML = activityHtml();
  else if (state.view === 'terminal') { $('#view').innerHTML = terminalHtml(); renderTerminalLines(); }
  else if (state.view === 'bot') $('#view').innerHTML = botPageHtml(state.botId);
  else $('#view').innerHTML = dashboardHtml();
  updateUptimes();
  initReveals($('#view'));
}

function scheduleViewRender() {
  if (state.viewTimer) return;
  state.viewTimer = setTimeout(() => {
    state.viewTimer = null;
    if (!state.loading) renderView();
  }, 140);
}

function renderStats() {
  const el = $('#stats');
  if (el) el.outerHTML = statsHtml();
}

function updateChrome() {
  const page = PAGES[state.view] || PAGES.dashboard;
  $('#page-title').textContent = page.title;
  $('#page-sub').textContent = page.sub;
  document.title = `${page.title} · MCBot Control`;
  $$('.nav__item[data-view], .mobilenav__item[data-view]').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.view === state.view);
  });
  const search = $('#search-input');
  if (search) {
    search.placeholder = state.view === 'activity' ? 'Search activity…' : 'Search bots or IPs…';
  }
}

function renderSidebar() {
  const s = getStats();
  const on = s.masterOn;
  const toggle = $('#master-toggle');
  if (toggle) {
    toggle.classList.toggle('is-on', on);
    toggle.setAttribute('aria-checked', String(on));
    const label = toggle.querySelector('.switch__label');
    if (label) label.textContent = on ? 'On' : 'Off';
  }
  const powerCard = $('#power-card');
  if (powerCard) powerCard.classList.toggle('is-on', on);
  const powerState = $('#power-state');
  if (powerState) {
    powerState.textContent = on
      ? `${s.online} online · ${s.connecting} connecting`
      : (s.total ? 'All bots are stopped' : 'No bots yet');
  }
  const count = $('#nav-servers-count');
  if (count) count.textContent = s.servers;
  const groupCount = $('#nav-groups-count');
  if (groupCount) groupCount.textContent = s.groups;
  const topbarPower = $('#topbar-power');
  if (topbarPower) {
    topbarPower.classList.toggle('is-on', on);
    topbarPower.setAttribute('aria-pressed', String(on));
    topbarPower.title = on ? 'Master power is on — click to stop every bot' : 'Master power is off — click to start every bot';
  }
  updateActivityDot();
}

function updateActivityDot() {
  const dot = $('#nav-activity-dot');
  if (dot) dot.hidden = !(state.unread && state.view !== 'activity');
}

function updateUptimes() {
  $$('[data-uptime]').forEach((el) => {
    const t = Number(el.dataset.uptime || 0);
    el.textContent = t ? fmtDuration(nowMs() - t) : '—';
  });
}

function renderAll() {
  updateChrome();
  renderView();
  renderSidebar();
}

/* ── live events ────────────────────────────────────────────────────────── */
function pushActivity(id, entry) {
  const bot = findBot(id);
  state.activity.unshift({ id, name: bot ? bot.name : 'Bot', entry });
  if (state.activity.length > 160) state.activity.length = 160;
}

let cardFrame = null;
const cardQueue = new Map();

function updateBotCard(bot) {
  cardQueue.set(bot.id, bot);
  if (cardFrame) return;
  cardFrame = requestAnimationFrame(() => {
    cardFrame = null;
    const batch = Array.from(cardQueue.values());
    cardQueue.clear();
    batch.forEach(patchBotCard);
  });
}

function patchBotCard(bot) {
  const card = document.querySelector(`.bot-card[data-id="${CSS.escape(bot.id)}"]`);
  if (!card) { scheduleViewRender(); return; }
  // Connection / inventory shape changed → safe to rebuild the card once.
  if (card.dataset.sig !== structuralSig(bot)) {
    card.outerHTML = botCard(bot, state.bots.indexOf(bot));
    return;
  }
  const st = statusMeta(bot);
  card.classList.toggle('is-online', bot.status === 'online');
  const sKey = serverKey(bot);
  const peers = state.bots.filter((b) => serverKey(b) === sKey).length;
  card.classList.toggle('is-shared', peers > 1);

  const dot = card.querySelector('.bot-avatar .status-dot');
  if (dot) dot.className = `status-dot ${st.dot}`;
  const pill = card.querySelector('.pill');
  if (pill) { pill.className = `pill ${st.pill}`; pill.innerHTML = `<i></i>${st.label}`; }

  const metas = card.querySelectorAll('.bot-meta__item b');
  if (metas[1]) metas[1].textContent = bot.status === 'online' ? (bot.players || 0) : '—';
  if (metas[3]) {
    metas[3].className = bot.loggedIn ? 'good' : (bot.autoLogin ? '' : 'warn');
    metas[3].textContent = bot.loggedIn ? 'Verified' : (bot.autoLogin ? 'Auto' : 'Off');
  }

  const vit = card.querySelector('.bot-vitals');
  if (bot.status !== 'online') {
    if (vit) vit.remove();
  } else if (!vit) {
    const anchor = card.querySelector('.bot-groups') || card.querySelector('.bot-inv') || card.querySelector('.bot-last');
    if (anchor) anchor.insertAdjacentHTML('beforebegin', vitalsHtml(bot));
  } else {
    const hp = Number.isFinite(bot.health) ? Math.max(0, Math.min(20, bot.health)) : null;
    const food = Number.isFinite(bot.food) ? Math.max(0, Math.min(20, bot.food)) : null;
    if (hp !== null) {
      const bar = vit.querySelector('.vital--hp em');
      const val = vit.querySelector('.vital--hp b');
      if (bar) bar.style.width = `${(hp / 20) * 100}%`;
      if (val) val.textContent = hp;
    }
    if (food !== null) {
      const bar = vit.querySelector('.vital--food em');
      const val = vit.querySelector('.vital--food b');
      if (bar) bar.style.width = `${(food / 20) * 100}%`;
      if (val) val.textContent = food;
    }
    const coords = vit.querySelector('.bot-coords');
    const p = bot.position;
    if (coords && p && Number.isFinite(p.x)) {
      coords.innerHTML = `${icon('pin')}${esc(`${p.x} ${p.y} ${p.z}`)}`;
    }
  }

  const strip = card.querySelector('.bot-inv');
  if (strip && strip.dataset.inv !== inventorySig(bot)) {
    const tpl = document.createElement('div');
    tpl.innerHTML = inventoryStripHtml(bot).trim();
    strip.replaceWith(tpl.firstElementChild);
  }

  const lastEl = card.querySelector('.bot-last');
  if (lastEl && bot.lastLog) { lastEl.textContent = bot.lastLog.text; lastEl.title = bot.lastLog.text; }

  const sw = card.querySelector('.switch[data-action="toggle"]');
  if (sw) {
    const active = isActive(bot);
    sw.classList.toggle('is-on', active);
    sw.setAttribute('aria-checked', String(active));
    const label = sw.querySelector('.switch__label');
    if (label) label.textContent = active ? 'On' : 'Off';
  }
}

const notifyAt = new Map();

function onBot(bot) {
  if (!bot || !bot.id) return;
  const i = state.bots.findIndex((b) => b.id === bot.id);
  const prev = i >= 0 ? state.bots[i] : null;
  if (i >= 0) state.bots[i] = bot; else state.bots.push(bot);

  // Make connection changes obvious (and tell the user why it dropped).
  if (prev && prev.status !== bot.status && Date.now() - (notifyAt.get(bot.id) || 0) > 30000) {
    if (prev.status === 'online' && bot.status !== 'online') {
      notifyAt.set(bot.id, Date.now());
      toast('warn', `${bot.name} went offline`, bot.statusText || bot.lastError || 'Reconnecting automatically…');
    } else if (prev.status !== 'online' && bot.status === 'online') {
      notifyAt.set(bot.id, Date.now());
      toast('ok', `${bot.name} is back online`, `${bot.host}:${bot.port}`);
    }
  }

  if (state.view === 'dashboard') {
    if (state.query || state.filter !== 'all' || state.groupFilter !== 'all') scheduleViewRender();
    else updateBotCard(bot);
    updateGroupCounts();
  } else if (state.view === 'servers' || state.view === 'groups') {
    scheduleViewRender();
  }
  if (state.consoleId === bot.id) updateDrawer(bot);
  if (state.view === 'bot' && state.botId === bot.id) scheduleViewRender();
  renderSidebar();
}

function updateGroupCounts() {
  $$('.group-chip[data-group-filter]').forEach((chip) => {
    const id = chip.dataset.groupFilter;
    const em = chip.querySelector('em');
    if (!em) return;
    em.textContent = id === 'all'
      ? state.bots.length
      : state.bots.filter((b) => (b.groupIds || []).includes(id)).length;
  });
}

function onGroup(group) {
  if (!group || !group.id) return;
  const i = state.groups.findIndex((g) => g.id === group.id);
  if (i >= 0) state.groups[i] = group; else state.groups.push(group);
  if (state.view === 'groups' || state.view === 'dashboard') scheduleViewRender();
  renderSidebar();
}

function onGroupRemoved(id) {
  state.groups = state.groups.filter((g) => g.id !== id);
  if (state.groupFilter === id) state.groupFilter = 'all';
  state.bots.forEach((b) => {
    if (Array.isArray(b.groupIds)) b.groupIds = b.groupIds.filter((g) => g !== id);
  });
  if (state.view === 'groups' || state.view === 'dashboard') renderView();
  renderSidebar();
}

function onStats(stats) {
  state.stats = stats || {};
  renderStats();
  renderSidebar();
  if (state.view === 'servers') scheduleViewRender();
}

function onLog(payload) {
  if (!payload || !payload.id || !payload.entry) return;
  const { id, entry } = payload;
  const arr = state.logs.get(id) || [];
  arr.push(entry);
  if (arr.length > 400) arr.splice(0, arr.length - 400);
  state.logs.set(id, arr);

  const bot = findBot(id);
  if (bot) bot.lastLog = entry;

  const lastEl = document.querySelector(`.bot-card[data-id="${id}"] .bot-last`);
  if (lastEl) { lastEl.textContent = entry.text; lastEl.title = entry.text; }

  pushActivity(id, entry);
  if (state.view === 'terminal') appendTerminalLine({ id, name: (bot || {}).name || 'Bot', entry });
  else if (state.termLoaded) state.terminalLogs.push({ id, name: (bot || {}).name || 'Bot', entry });
  if (state.view === 'activity') scheduleActivityFeedRender();
  else if (state.view === 'dashboard') scheduleActivityPreviewRender();
  if (state.view !== 'activity') {
    state.unread = true;
    updateActivityDot();
  }
  if (state.consoleId === id) appendConsoleLine(entry);
  if (state.view === 'bot' && state.botId === id) appendBotRecent(entry);
}

function onRemoved(id) {
  state.bots = state.bots.filter((b) => b.id !== id);
  if (state.consoleId === id) closeConsole();
  renderView();
  renderSidebar();
}

function onTick(bots) {
  if (!Array.isArray(bots)) return;
  bots.forEach((t) => {
    const b = findBot(t.id);
    if (b && t.joinedAt) b.joinedAt = t.joinedAt;
  });
  updateUptimes();
}

let previewTimer = null;
function scheduleActivityPreviewRender() {
  if (previewTimer) return;
  previewTimer = setTimeout(() => {
    previewTimer = null;
    const el = $('#activity-preview');
    if (!el) return;
    const items = state.activity.slice(0, 6);
    el.innerHTML = items.length ? items.map(activityRow).join('') : '';
  }, 180);
}

let feedTimer = null;
function scheduleActivityFeedRender() {
  if (feedTimer) return;
  feedTimer = setTimeout(() => {
    feedTimer = null;
    const el = $('#activity-feed');
    if (!el) return;
    const items = filteredActivity();
    el.innerHTML = streamListHtml(items);
    const count = $('#activity-count');
    if (count) count.textContent = `${items.length} events`;
    const chatCount = state.activity.filter((i) => ['chat', 'sent'].includes(i.entry.kind)).length;
    const allCount = $('#act-count-all');
    const chatEl = $('#act-count-chat');
    const systemEl = $('#act-count-system');
    if (allCount) allCount.textContent = state.activity.length;
    if (chatEl) chatEl.textContent = chatCount;
    if (systemEl) systemEl.textContent = state.activity.length - chatCount;
  }, 160);
}

/* ── auth / boot ────────────────────────────────────────────────────────── */
async function loadState() {
  const data = await api('/api/state');
  state.bots = Array.isArray(data.bots) ? data.bots : [];
  state.groups = Array.isArray(data.groups) ? data.groups : [];
  state.stats = data.stats || {};
  state.activity = Array.isArray(data.activity) ? data.activity.slice().reverse() : [];
  state.loading = false;
  renderAll();
}

async function enterApp() {
  state.authed = true;
  state.loading = true;
  $('#login-screen').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  $('#mobilenav').classList.remove('hidden');
  document.body.classList.remove('is-locked');
  renderView();
  try {
    await loadState();
    connectSSE();
    startTick();
    applyRoute();
  } catch (e) {
    if (!state.authed) return;
    state.loading = false;
    renderAll();
    toast('err', 'Could not load bots', e.message);
  }
}

function showLogin() {
  state.authed = false;
  state.loading = true;
  state.bots = [];
  state.groups = [];
  state.activity = [];
  state.logs.clear();
  state.consoleId = null;
  state.unread = false;
  closeSSE();
  closeConsole(true);
  closeModal();
  $('#shell').classList.add('hidden');
  $('#mobilenav').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  document.body.classList.remove('is-locked');
  document.title = 'Sign in · MCBot Control';
  const err = $('#login-error');
  if (err) err.textContent = '';
  setTimeout(() => { const p = $('#login-password'); if (p) p.focus(); }, 120);
}

async function doLogout() {
  try { await api('/api/logout', { method: 'POST' }); } catch (_) {}
  showLogin();
  toast('info', 'Signed out', 'Your session has been cleared.');
}

function setLive(mode) {
  state.live = mode;
  const pill = $('#live-pill');
  if (!pill) return;
  const label = pill.querySelector('span');
  pill.dataset.state = mode;
  if (label) label.textContent = mode === 'live' ? 'Live' : (mode === 'connecting' ? 'Connecting' : 'Reconnecting');
  pill.title = mode === 'live'
    ? 'Live updates are connected'
    : 'Live updates are reconnecting — the panel will resync automatically';
}

function bumpSse() {
  state.lastEventAt = Date.now();
  if (state.live !== 'live') setLive('live');
}

async function resyncAll() {
  if (!state.authed) return;
  try { await loadState(); } catch (_) {}
  if (state.consoleId) refreshDrawerLogs(state.consoleId);
}

function scheduleReconnect(delay = 1200) {
  if (state.sseTimer) return;
  setLive('offline');
  state.sseTimer = setTimeout(() => {
    state.sseTimer = null;
    if (!state.authed) return;
    connectSSE();
  }, delay);
}

function startSseWatchdog() {
  if (state.sseWatch) return;
  state.sseWatch = setInterval(() => {
    if (!state.authed) return;
    const age = Date.now() - state.lastEventAt;
    if (age > 26000) {
      // The stream went quiet: rebuild it instead of showing stale state.
      try { if (state.sse) state.sse.close(); } catch (_) {}
      state.sse = null;
      scheduleReconnect(200);
    }
  }, 5000);
}

function connectSSE() {
  closeSSE();
  setLive('connecting');
  const es = new EventSource('/api/events');
  state.sse = es;
  state.lastEventAt = Date.now();
  const wrap = (name, fn) => es.addEventListener(name, (e) => {
    bumpSse();
    try { fn(JSON.parse(e.data)); } catch (_) {}
  });
  es.onopen = () => {
    bumpSse();
    resyncAll();
  };
  wrap('bot', (d) => onBot(d.bot));
  wrap('stats', (d) => onStats(d));
  wrap('log', (d) => onLog(d));
  wrap('removed', (d) => onRemoved(d.id));
  wrap('group', (d) => onGroup(d.group));
  wrap('group-removed', (d) => onGroupRemoved(d.id));
  wrap('tick', (d) => onTick(d.bots));
  es.addEventListener('ping', () => bumpSse());
  es.addEventListener('hello', () => {
    bumpSse();
    if (state.authed) resyncAll();
  });
  es.onerror = () => {
    if (state.sse !== es) return;
    setLive('offline');
    if (!state.authed) return;
    fetch('/api/auth', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((a) => { if (!a.authenticated) showLogin(); })
      .catch(() => {});
    scheduleReconnect(1500);
  };
  startSseWatchdog();
}

function closeSSE() {
  if (state.sseTimer) { clearTimeout(state.sseTimer); state.sseTimer = null; }
  if (state.sse) { try { state.sse.close(); } catch (_) {} state.sse = null; }
}

function startTick() {
  if (state.tick) return;
  state.tick = setInterval(updateUptimes, 1000);
}

function switchView(view, push = true) {
  if (!PAGES[view] || state.view === view) {
    if (state.view === view) {
      state.unread = false;
      updateActivityDot();
    }
    return;
  }
  revealState.clear();
  state.view = view;
  if (view === 'activity') state.unread = false;
  if (view === 'terminal') loadTerminal().catch(() => {});
  updateChrome();
  renderView();
  updateActivityDot();
  if (push) history.pushState({}, '', `#/${view}`);
  if (window.innerWidth <= 1080) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function applyRoute() {
  if (!state.authed) return;
  const raw = String(location.hash || '').replace(/^#\/?/, '');
  const [view, id] = raw.split('/');
  if (view === 'bot' && id) { openBotPage(id, false); return; }
  if (PAGES[view]) { switchView(view, false); return; }
  if (!raw) switchView('dashboard', false);
}
window.addEventListener('popstate', () => applyRoute());
