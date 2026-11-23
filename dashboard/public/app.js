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
  bot: { title: 'Bot profile', sub: 'Everything this bot is doing, on one page.' },
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
  activity: [],
  botId: null,
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

function kindIcon(kind) {
  return ({ chat: 'terminal', sent: 'send', auth: 'shield', ok: 'check', warn: 'alert', err: 'alert', info: 'activity' })[kind] || 'activity';
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
  const sKey = serverKey(bot);
  const sHue = hashHue(sKey);
  const peers = state.bots.filter((b) => serverKey(b) === sKey).length;
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
        <div class="metric metric--blue"><span>${icon('server')} Servers</span><b>${s.servers}</b><em>${s.total} bots</em></div>
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
`;
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
  bindTilt($('.botpage__hero'), 3.2);
  try {
    const data = await api(`/api/bots/${id}/logs`);
    state.logs.set(id, Array.isArray(data.logs) ? data.logs : []);
    if (state.view === 'bot' && state.botId === id) renderView();
  } catch (_) {}
  bpPatch.invSig = '';
  bpPatch.scoreKeys = '';
  loadBotInventory(id, true);
}

function bpMetric(iconName, label, value, sub = '', tone = '', id = '') {
  return `<div class="bpmetric ${tone}">
    <span>${icon(iconName)} ${esc(label)}</span>
    <b ${id ? `id="${id}"` : ''}>${esc(value)}</b>
    ${sub ? `<em>${esc(sub)}</em>` : ''}
  </div>`;
}

function bpcRow(entry) {
  return `<div class="bpc-line kind-${esc(entry.kind || 'chat')}">
    <time>${fmtClock(entry.t)}</time>
    <span class="bpc-kind">${esc(kindLabel(entry.kind))}</span>
    <p>${esc(entry.text)}</p>
  </div>`;
}

function renderBotConsole(id) {
  const box = $('#bp-console-lines');
  if (!box) return;
  const prev = box.scrollTop;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
  const logs = (state.logs.get(id) || []).slice(-40);
  box.innerHTML = logs.length
    ? logs.map(bpcRow).join('')
    : `<div class="bp-empty">${icon('terminal')}No console activity yet.</div>`;
  box.scrollTop = atBottom ? box.scrollHeight : prev;
}

function appendBotConsole(entry) {
  const box = $('#bp-console-lines');
  if (!box) return;
  if (box.querySelector('.bp-empty')) box.innerHTML = '';
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
  box.insertAdjacentHTML('beforeend', bpcRow(entry));
  while (box.children.length > 60) box.firstElementChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

const scoreHistory = new Map();

function trackScore(bot) {
  const sb = bot && bot.scoreboard;
  if (!sb || !Array.isArray(sb.items) || !sb.items.length) return;
  const lead = sb.items.find((it) => it.amount != null) || sb.items[0];
  const v = lead.amount != null ? lead.amount : lead.value;
  const arr = scoreHistory.get(bot.id) || [];
  if (!arr.length || arr[arr.length - 1].v !== v) {
    arr.push({ v, t: Date.now() });
    if (arr.length > 30) arr.splice(0, arr.length - 30);
    scoreHistory.set(bot.id, arr);
  }
}

function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return v.toLocaleString('en-US');
}

function sparkline(values) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - min) / span) * 24}`).join(' ');
  return `<svg class="bpspark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>`;
}

function bpScoreHtml(bot, opts = {}) {
  const sb = bot.scoreboard;
  if (!sb || !Array.isArray(sb.items) || !sb.items.length) {
    return `<div class="bp-empty">${icon('activity')}No sidebar scoreboard from this server right now.</div>`;
  }
  const items = opts.limit ? sb.items.slice(0, opts.limit) : sb.items;
  const max = Math.max(...items.map((it) => (it.amount != null ? Math.abs(Number(it.amount) || 0) : 0)), 1);
  const selfIdx = items.findIndex((it) => String(it.player || it.name || it.label || '').toLowerCase().includes(String(bot.name || '').toLowerCase()));
  const hist = (scoreHistory.get(bot.id) || []).map((x) => x.v);
  const delta = hist.length > 1 ? hist[hist.length - 1] - hist[hist.length - 2] : 0;
  const selfDelta = selfIdx >= 0 && hist.length > 1 ? hist[hist.length - 1] - hist[hist.length - 2] : 0;
  const lead = items.find((it) => it.amount != null) || items[0];
  const leadVal = lead.amountText || (lead.amount == null ? '—' : fmtNum(lead.amount));
  const selfVal = selfIdx >= 0 ? (items[selfIdx].amountText || (items[selfIdx].amount == null ? '—' : fmtNum(items[selfIdx].amount))) : null;
  return `<div class="bpscore">
    <div class="bpscore__top">
      <div><span class="bpscore__eyebrow"><i></i> live tracker</span><h4>${esc(sb.title || 'Scoreboard')}</h4></div>
      <span class="bpscore__meta">${items.length} lines</span>
    </div>
    <div class="bpscore__rows" id="bp-score-rows">
      ${items.map((it, i) => {
        const self = i === selfIdx;
        const pct = it.amount == null ? 0 : Math.max(2, Math.min(100, (Math.abs(it.amount) / max) * 100));
        const shown = it.amountText || (it.amount == null ? '—' : fmtNum(it.amount));
        return `<div class="bpscore__row ${self ? 'is-self' : ''}" style="--i:${i}">
          <span class="bpscore__rank ${i < 3 ? 'is-podium' : ''}">${i + 1}</span>
          <span class="bpscore__label">${esc(it.nameLabel || it.label)}</span>
          <span class="bpscore__bar"><i style="width:${pct}%"></i></span>
          <b>${esc(shown)}</b>
          ${self && selfDelta ? `<em class="${selfDelta > 0 ? 'is-up' : 'is-down'}">${selfDelta > 0 ? '+' : ''}${fmtNum(selfDelta)}</em>` : ''}
        </div>`;
      }).join('')}
    </div>
    <div class="bpscore__foot" id="bp-score-foot">
      <div><span>top stat</span><b id="bp-score-lead">${esc(leadVal)}</b></div>
      ${sparkline(hist)}
      <span class="bpscore__foot-note">${hist.length > 1 ? `${hist.length} samples` : 'collecting…'}</span>
    </div>
  </div>`;
}

let bpInv = { id: null, data: null, at: 0 };

async function loadBotInventory(id, force = false) {
  if (!id) return;
  if (!force && bpInv.id === id && Date.now() - bpInv.at < 8000) return;
  try {
    const data = await api(`/api/bots/${id}/inventory`);
    bpInv = { id, data: data.inventory, at: Date.now() };
    if (state.view === 'bot' && state.botId === id) renderBotInventory();
  } catch (_) {}
}

function renderBotInventory() {
  const root = $('#bp-inv-root');
  if (!root) return;
  if (!bpInv.data || bpInv.id !== state.botId) {
    root.innerHTML = `<div class="bp-empty">${icon('chest')}Reading inventory…</div>`;
    return;
  }
  const inv = bpInv.data;
  const version = (findBot(state.botId) || {}).version || '1.20.1';
  root.innerHTML = `<div class="bp-inv">
    <div class="bp-inv__side">
      <div class="bp-inv__block">
        <p class="inv-label">Crafting</p>
        <div class="bp-craft">
          <div class="inv-craft__grid">${[0, 1, 2, 3].map((i) => slotHtml(inv.craft[i], version)).join('')}</div>
          ${icon('arrow', 'ico inv-craft__arrow')}
          ${slotHtml(inv.craftResult, version, 'inv-result')}
        </div>
      </div>
      <div class="bp-inv__block">
        <p class="inv-label">Armour</p>
        <div class="bp-armor">${inv.armor.map((it) => slotHtml(it, version)).join('')}</div>
      </div>
      <div class="bp-inv__block">
        <p class="inv-label">Off-hand</p>
        ${slotHtml(inv.offhand, version)}
      </div>
    </div>
    <div class="bp-inv__main">
      <p class="inv-label">Storage <em>27</em></p>
      <div class="inv-grid bp-grid">${inv.main.map((it) => slotHtml(it, version)).join('')}</div>
      <p class="inv-label">Hotbar <em>9</em></p>
      <div class="inv-grid bp-grid">${inv.hotbar.map((it, i) => slotHtml(it, version, i === inv.selected ? 'is-selected' : '')).join('')}</div>
    </div>
  </div>`;
}

const bpPatch = { invSig: '', scoreKeys: '', dashBot: null };

function bindTilt(el, max = 3) {
  if (!el || el.dataset.tiltBound) return;
  el.dataset.tiltBound = '1';
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = `perspective(1100px) rotateX(${(-y * max).toFixed(2)}deg) rotateY(${(x * max).toFixed(2)}deg)`;
  });
  el.addEventListener('pointerleave', () => { el.style.transform = ''; });
}

function effectsText(d) {
  const fx = Array.isArray(d.effects) ? d.effects : [];
  return fx.length ? fx.map((e) => `${e.name ? esc(prettyGameId(e.name)) : 'Effect'}${e.amplifier ? ` ${roman(e.amplifier + 1)}` : ''}`).join(', ') : 'None';
}

function patchBotPage(bot) {
  const d = bot.detail || {};
  const st = statusMeta(bot);
  const set = (sel, html) => { const el = $(sel); if (el) el.innerHTML = html; };
  const setText = (sel, text) => { const el = $(sel); if (el) el.textContent = text; };
  const hp = Number.isFinite(bot.health) ? Math.max(0, Math.min(20, bot.health)) : 0;
  const food = Number.isFinite(bot.food) ? Math.max(0, Math.min(20, bot.food)) : 0;
  const xp = d.xp || { level: 0, points: 0 };
  setText('#bp-hp', `${hp}/20`);
  setText('#bp-food', `${food}/20`);
  setText('#bp-ping', bot.ping == null ? '—' : `${bot.ping} ms`);
  setText('#bp-players', bot.players == null ? '—' : bot.players);
  setText('#bp-xp', xp.level || 0);
  const hpCard = $('#bp-hp') && $('#bp-hp').closest('.bpmetric');
  if (hpCard) { hpCard.classList.toggle('is-bad', hp <= 6); hpCard.classList.toggle('is-warn', false); }
  const foodCard = $('#bp-food') && $('#bp-food').closest('.bpmetric');
  if (foodCard) { foodCard.classList.toggle('is-warn', food <= 6); foodCard.classList.toggle('is-bad', false); }
  const pos = bot.position ? `${bot.position.x} ${bot.position.y} ${bot.position.z}` : '—';
  setText('#bp-pos', pos);
  setText('#bp-dim', prettyGameId(d.dimension));
  setText('#bp-diff', d.difficulty ? String(d.difficulty).charAt(0).toUpperCase() + String(d.difficulty).slice(1) : '—');
  setText('#bp-brand', d.serverBrand || '—');
  setText('#bp-effects', effectsText(d));
  const pill = $('#bp-pill');
  if (pill) { pill.className = `pill ${st.pill}`; pill.innerHTML = `<i></i>${st.label}`; }
  const dot = $('#bp-dot');
  if (dot) dot.className = `status-dot ${st.dot}`;
  setText('#bp-ae', bot.autoEat ? 'On' : 'Off');
  setText('#bp-afk', bot.antiAfk ? 'On' : 'Off');
  setText('#bp-reconnect', bot.autoReconnect ? 'On' : 'Off');
  setText('#bp-autologin', bot.autoLogin ? 'On' : 'Off');
  setText('#bp-attempts', `${bot.loginAttempts || 0}/5`);
  patchBotScore(bot);
  const sig = (bot.inventoryUsed || 0) + ':' + (bot.inventoryPreview || []).map((i) => `${i.name}:${i.count}`).join(',');
  if (sig !== bpPatch.invSig) { bpPatch.invSig = sig; renderBotInventory(); }
}

function patchBotScore(bot) {
  const root = $('#bp-score-root');
  if (!root) return;
  const sb = bot.scoreboard;
  const keys = sb && Array.isArray(sb.items) ? sb.items.map((i) => i.name).join('|') : '';
  if (keys !== bpPatch.scoreKeys) {
    bpPatch.scoreKeys = keys;
    root.innerHTML = bpScoreHtml(bot);
    return;
  }
  if (!sb || !Array.isArray(sb.items)) return;
  const max = Math.max(...sb.items.map((it) => (it.amount != null ? Math.abs(Number(it.amount) || 0) : 0)), 1);
  const rows = root.querySelectorAll('.bpscore__row');
  sb.items.forEach((it, i) => {
    const row = rows[i];
    if (!row) return;
    const self = String(it.player || it.name || it.label || '').toLowerCase().includes(String(bot.name || '').toLowerCase());
    row.classList.toggle('is-self', self);
    const pct = it.amount == null ? 0 : Math.max(2, Math.min(100, (Math.abs(it.amount) / max) * 100));
    const bar = row.querySelector('.bpscore__bar i');
    if (bar) bar.style.width = `${pct}%`;
    const val = row.querySelector('b');
    if (val) val.textContent = it.amountText || (it.amount == null ? '—' : fmtNum(it.amount));
    const label = row.querySelector('.bpscore__label');
    if (label) label.textContent = it.nameLabel || it.label;
  });
  const leadEl = $('#bp-score-lead');
  if (leadEl && sb.items.length) {
    const lead = sb.items.find((it) => it.amount != null) || sb.items[0];
    leadEl.textContent = lead.amountText || (lead.amount == null ? '—' : fmtNum(lead.amount));
  }
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
  const uuid = d.uuid ? String(d.uuid) : '';
  return `
    <div class="botpage" style="--hue:${hashHue(bot.name)};--server:${serverHueOf(bot)}">
      <button class="botpage__back" type="button" data-view="dashboard">${icon('arrow')} Back to fleet</button>

      <header class="botpage__hero" data-reveal="bp-hero">
        <div class="botpage__avatar"><span class="avatar-initial">${esc(initial(bot.name))}</span><img class="botpage__skin" src="${skinUrl(bot.name, 'body', 200)}" alt="" loading="lazy" decoding="async" data-skin="1" /><span class="status-dot ${st.dot}" id="bp-dot"></span></div>
        <div class="botpage__id">
          <span class="botpage__eyebrow">bot profile</span>
          <h2>${esc(bot.name)} <span class="pill ${st.pill}" id="bp-pill"><i></i>${st.label}</span></h2>
          <p><i class="server-dot"></i>${esc(bot.host)}:${bot.port} <span>· v${esc(bot.version)}</span></p>
          <div class="player-tags">
            <span class="ptag">${icon('cube')} ${esc(prettyGameId(d.gamemode))}</span>
            <span class="ptag">${icon('pin')} ${esc(prettyGameId(d.dimension))}</span>
            <span class="ptag ${bot.loggedIn ? 'is-good' : ''}">${icon('shield')} ${bot.loggedIn ? 'Logged in' : (bot.autoLogin ? 'Auto login' : 'Not logged in')}</span>
          </div>
        </div>
        <div class="botpage__actions">
          <button class="btn btn-ghost btn-sm" data-bp-scroll="bp-console">${icon('terminal')}<span>Console</span></button>
          <button class="btn btn-ghost btn-sm" data-bp-scroll="bp-inventory">${icon('chest')}<span>Inventory</span></button>
          <button class="icon-btn" data-action="restart" data-id="${esc(bot.id)}" title="Restart" aria-label="Restart">${icon('restart')}</button>
          <button class="icon-btn" data-action="edit" data-id="${esc(bot.id)}" title="Edit" aria-label="Edit">${icon('edit')}</button>
        </div>
      </header>

      <div class="botpage__stats" data-reveal="bp-stats" style="--d:60ms">
        ${bpMetric('heart', 'Health', `${hp}/20`, 'hitpoints', hp <= 6 ? 'is-bad' : '', 'bp-hp')}
        ${bpMetric('food', 'Food', `${food}/20`, 'hunger', food <= 6 ? 'is-warn' : '', 'bp-food')}
        ${bpMetric('activity', 'Ping', bot.ping == null ? '—' : `${bot.ping} ms`, 'latency', '', 'bp-ping')}
        ${bpMetric('users', 'Players', bot.players == null ? '—' : bot.players, 'on this server', '', 'bp-players')}
        ${bpMetric('clock', 'Uptime', bot.joinedAt ? fmtDuration(nowMs() - bot.joinedAt) : '—', 'this session', '', 'bp-uptime')}
        ${bpMetric('zap', 'XP level', xp.level || 0, `${xp.points || 0} points`, '', 'bp-xp')}
      </div>

      <nav class="bp-nav" aria-label="Bot sections">
        ${[['bp-console', 'Console'], ['bp-inventory', 'Inventory'], ['bp-scoreboard', 'Scoreboard'], ['bp-player', 'Player'], ['bp-session', 'Session']].map(([id2, label]) => `<button type="button" data-bp-jump="${id2}">${label}</button>`).join('')}
      </nav>

      <div class="bp-progress" aria-hidden="true"><i></i></div>

      <div class="bpsheet" data-reveal="bp-sheet" style="--d:40ms">
        <div class="bpsec" id="bp-console" data-reveal="bp-console" style="--d:60ms">
          <div class="bpsec__head">
            <span class="bpsec__num">01</span>
            <h3>Console</h3>
            <span class="bpsec__rule"></span>
            <span class="bpsec__sub">Every line this bot prints — system, chat, sent and error output — streamed live from the server.</span>
          </div>
          <div class="bp-console" id="bp-console-lines"></div>
        </div>

        <div class="bpsec" id="bp-inventory" data-reveal="bp-inventory" style="--d:120ms">
          <div class="bpsec__head">
            <span class="bpsec__num">02</span>
            <h3>Inventory</h3>
            <span class="bpsec__rule"></span>
            <span class="bpsec__sub">All 36 slots of the Minecraft inventory — crafting grid, result, armour, off-hand, storage and hotbar.</span>
            <button class="bpanel__link" type="button" data-action="inventory" data-id="${esc(bot.id)}">Open drawer ${icon('arrow')}</button>
          </div>
          <div id="bp-inv-root"></div>
        </div>

        <div class="bpsec" id="bp-scoreboard" data-reveal="bp-scoreboard" style="--d:180ms">
          <div class="bpsec__head">
            <span class="bpsec__num">03</span>
            <h3>Scoreboard</h3>
            <span class="bpsec__rule"></span>
            <span class="bpsec__sub">The live sidebar of the server this bot is riding on right now.</span>
          </div>
          <div id="bp-score-root">${bpScoreHtml(bot)}</div>
        </div>

        <div class="bpsec" id="bp-player" data-reveal="bp-player" style="--d:240ms">
          <div class="bpsec__head">
            <span class="bpsec__num">04</span>
            <h3>Player</h3>
            <span class="bpsec__rule"></span>
            <span class="bpsec__sub">Live vitals, world position, gear and identity of this bot.</span>
          </div>
          <div class="bkv bkv--3">
            <div><span>Position</span><b id="bp-pos">${esc(pos)}</b></div>
            <div><span>Dimension</span><b id="bp-dim">${esc(prettyGameId(d.dimension))}</b></div>
            <div><span>Difficulty</span><b id="bp-diff">${esc(d.difficulty ? String(d.difficulty).charAt(0).toUpperCase() + String(d.difficulty).slice(1) : '—')}</b></div>
            <div><span>Server brand</span><b id="bp-brand">${esc(d.serverBrand || '—')}</b></div>
            <div><span>UUID</span><b id="bp-uuid" title="${esc(uuid)}">${uuid ? `${esc(uuid.slice(0, 8))}…${esc(uuid.slice(-4))}` : '—'}</b></div>
            <div><span>Effects</span><b id="bp-effects">${effects.length ? effects.map((e) => `${esc(prettyGameId(e.name))}${e.amplifier ? ` ${roman(e.amplifier + 1)}` : ''}`).join(', ') : 'None'}</b></div>
          </div>
          <p class="bpanel__sub">Equipped</p>
          <div class="player-gear">
            <div class="player-gear__slot"><span>Held</span>${slotHtml(bot.heldItem, bot.version)}</div>
            ${armor.map((it, i) => `<div class="player-gear__slot"><span>${['Helmet', 'Chestplate', 'Leggings', 'Boots'][i]}</span>${slotHtml(it, bot.version)}</div>`).join('')}
            <div class="player-gear__slot"><span>Off-hand</span>${slotHtml(bot.offhand, bot.version)}</div>
          </div>
        </div>

        <div class="bpsec" id="bp-session" data-reveal="bp-session" style="--d:320ms">
          <div class="bpsec__head">
            <span class="bpsec__num">05</span>
            <h3>Session</h3>
            <span class="bpsec__rule"></span>
            <span class="bpsec__sub">Behaviour switches: auto-eat, anti-afk, reconnects, auto-login and friends.</span>
          </div>
          <div class="bkv bkv--3">
            <div><span>Auto-eat</span><b id="bp-ae">${bot.autoEat ? 'On' : 'Off'}</b></div>
            <div><span>Anti-AFK</span><b id="bp-afk">${bot.antiAfk ? 'On' : 'Off'}</b></div>
            <div><span>Auto-reconnect</span><b id="bp-reconnect">${bot.autoReconnect ? 'On' : 'Off'}</b></div>
            <div><span>Auto-login</span><b id="bp-autologin">${bot.autoLogin ? 'On' : 'Off'}</b></div>
            <div><span>Login attempts</span><b id="bp-attempts">${bot.loginAttempts || 0}/5</b></div>
            <div><span>Version</span><b id="bp-ver">${esc(bot.version)}</b></div>
          </div>
        </div>
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
  else if (state.view === 'bot') {
    $('#view').innerHTML = botPageHtml(state.botId);
    renderBotConsole(state.botId);
    renderBotInventory();
    bindTilt($('.botpage__hero'), 3.2);
  }
  else $('#view').innerHTML = dashboardHtml();
  if (state.view === 'dashboard') bindTilt($('.fleet__deck'), 2.4);
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
  if (search) search.placeholder = 'Search bots or IPs…';
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
  trackScore(bot);

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
  if (state.view === 'bot' && state.botId === bot.id) patchBotPage(bot);
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
  if (state.consoleId === id) appendConsoleLine(entry);
  if (state.view === 'bot' && state.botId === id) appendBotConsole(entry);
}

function onRemoved(id) {
  state.bots = state.bots.filter((b) => b.id !== id);
  if (state.consoleId === id) closeConsole();
  renderView();
  renderSidebar();
}

function onTick(bots) {
  if (!Array.isArray(bots)) return;
  if (state.view === 'bot' && state.botId) loadBotInventory(state.botId);
  bots.forEach((t) => {
    const b = findBot(t.id);
    if (b && t.joinedAt) b.joinedAt = t.joinedAt;
  });
  updateUptimes();
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

window.addEventListener('popstate', () => applyRoute());

function botScrollTick() {
  const bar = document.querySelector('#view .bp-progress i');
  if (!bar) return;
  const max = Math.max(document.documentElement.scrollHeight - window.innerHeight, 0);
  const y = Math.min(Math.max(window.scrollY || 0, 0), max);
  bar.style.width = max > 0 ? `${(y / max) * 100}%` : '0%';
}
window.addEventListener('scroll', botScrollTick, { passive: true });
window.addEventListener('resize', botScrollTick);
