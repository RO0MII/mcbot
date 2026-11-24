'use strict';
/* MCBot Control — Noir & Rose panel: dashboard · servers · scoreboard · bot page */

document.documentElement.classList.add('js');

const $  = (sel, root = document) => (root || document).querySelector(sel);
const $$ = (sel, root = document) => Array.from((root || document).querySelectorAll(sel));
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls = 'ico') => '<svg class="' + cls + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
const reducedMotion = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
const fmtClock = (t) => new Date(t).toLocaleTimeString('en-GB', { hour12: false });
const fmtDuration = (ms) => {
  const s = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + (s % 60) + 's';
  return s + 's';
};
const fmtCompact = (n) => {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(n % 1e9 ? 1 : 0) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 ? 1 : 0) + 'K';
  return String(Math.round(n));
};
const statusMeta = (bot) => ({
  online: { label: 'Online', pill: 'pill--online', dot: 'online' },
  connecting: { label: 'Connecting', pill: 'pill--connecting', dot: 'connecting' },
  reconnecting: { label: 'Retrying', pill: 'pill--connecting', dot: 'connecting' },
  error: { label: 'Error', pill: 'pill--error', dot: 'error' },
  banned: { label: 'Banned', pill: 'pill--error', dot: 'error' },
  stopped: { label: 'Stopped', pill: 'pill--stopped', dot: 'stopped' },
  offline: { label: 'Offline', pill: 'pill--offline', dot: 'stopped' },
})[bot && bot.status] || { label: 'Offline', pill: 'pill--offline', dot: 'stopped' };
const isActive = (bot) => !!bot && ['online', 'connecting', 'reconnecting', 'banned'].includes(bot.status);
const findBot = (id) => (state.bots || []).find((b) => b.id === id) || null;
const initial = (name) => String(name || '?').trim().charAt(0).toUpperCase() || '?';
const serverKey = (b) => b.host + ':' + b.port;
const serverLabel = (b) => b.host + ':' + b.port;
const uniquePlayers = (bots) => {
  const m = new Map();
  (bots || []).forEach((b) => { if (b.status === 'online') { const k = serverKey(b); m.set(k, Math.max(m.get(k) || 0, b.players || 0)); } });
  let n = 0; m.forEach((v) => { n += v; });
  return n;
};

const VIEW_META = {
  dashboard: ['Command center', 'Everything your bots are doing, at a glance.'],
  servers: ['Servers', 'Bots grouped by the endpoint they connect to.'],
  scores: ['Scoreboard', 'Live sidebar scores, ranked across your fleet.'],
  proxies: ['Proxies', 'Automatic SOCKS5 egress — five bots per IP.'],
  bot: ['Bot profile', 'Live console, inventory, player state and scoreboard.'],
};

function getStats() {
  const bots = state.bots || [];
  const online = bots.filter((b) => b.status === 'online').length;
  const connecting = bots.filter((b) => b.status === 'connecting' || b.status === 'reconnecting').length;
  const keys = new Set();
  bots.forEach((b) => keys.add(serverKey(b)));
  return { total: bots.length, online: online, connecting: connecting, offline: bots.length - online - connecting, servers: keys.size, players: uniquePlayers(bots), masterOn: online + connecting > 0 };
}
function filteredBots() {
  const q = state.query.trim().toLowerCase();
  return (state.bots || []).filter((b) => {
    if (state.filter !== 'all') { const act = isActive(b); if (state.filter === 'online' ? !act : act) return false; }
    if (!q) return true;
    return (b.name + ' ' + b.host + ':' + b.port).toLowerCase().includes(q);
  });
}

/* ── item icons ── */
function assetVersion(version) { return /^\d+\.\d+(\.\d+)?$/.test(String(version || '')) ? version : '1.20.1'; }
// A few blocks only ship as multi-face textures; point them at a face that exists.
const ICON_ALIAS = {
  crafting_table: 'crafting_table_front',
  furnace: 'furnace_front',
  blast_furnace: 'blast_furnace_front',
  smoker: 'smoker_front',
  grass_block: 'grass_block_side',
  dirt_path: 'dirt_path_top',
  beehive: 'beehive_front',
  bee_nest: 'bee_nest_front',
  cartography_table: 'cartography_table_side1',
  fletching_table: 'fletching_table_front',
  smithing_table: 'smithing_table_front',
  loom: 'loom_front',
  stonecutter: 'stonecutter_saw',
  grindstone: 'grindstone_side',
  lectern: 'lectern_front',
  composter: 'composter_side',
  chiseled_bookshelf: 'chiseled_bookshelf_top',
  barrel: 'barrel_side',
  jukebox: 'jukebox_side',
  enchanting_table: 'enchanting_table_top',
  scaffolding: 'scaffolding_side',
  cauldron: 'cauldron_top',
};
function iconName(name) { return ICON_ALIAS[name] || name; }
function itemIconUrl(name, version) { return '/api/icon/' + encodeURIComponent(assetVersion(version)) + '/' + encodeURIComponent(iconName(name)) + '.png'; }
function itemImgHtml(item, version, cls) {
  cls = cls || 'slot__img';
  if (!item || !item.name) return '';
  return '<img class="' + cls + '" src="' + itemIconUrl(item.name, version) + '" alt="' + esc(item.displayName || item.name) + '" loading="lazy" decoding="async" />';
}
function invStripSig(bot) {
  const items = Array.isArray(bot.inventoryPreview) ? bot.inventoryPreview : [];
  return items.map((it) => (it ? it.name + 'x' + it.count : '-')).join(',') + '|' + (bot.inventoryUsed || 0) + '|' + bot.status + '|' + (bot.version || '');
}
function vitalsSig(bot) {
  const p = bot.position;
  return [bot.status, bot.health, bot.food, bot.autoEat, p ? p.x + ',' + p.y + ',' + p.z : ''].join('|');
}
function boardSig() {
  return (state.bots || []).map((b) => {
    const t = botTopScore(b);
    return b.id + ':' + b.status + ':' + (b.scoreboard ? b.scoreboard.items.length : 0) + ':' + (t ? t.label + t.amount : '-');
  }).join('|');
}
function pulseSig() {
  return (state.bots || []).map((b) => b.id + ':' + b.status + ':' + (b.players || 0) + ':' + ((b.lastLog && b.lastLog.text) || '')).join('|');
}
function scoreSig(bot) {
  const sb = bot && bot.scoreboard;
  if (!sb) return 'none';
  return (sb.title || '') + '|' + (sb.items || []).map((it) => (it.nameLabel || it.label || '') + ':' + (it.amountText || it.value || '')).join('|');
}
function setSigHtml(el, sig, html) {
  if (!el) return;
  if (el.getAttribute('data-sig') === sig) return;
  el.setAttribute('data-sig', sig);
  el.innerHTML = html;
}

/* ── local cache: instant paint on reload, no extra requests ── */
const SNAP_KEY = 'mcbot.snap.v2';
const LASTBOT_KEY = 'mcbot.lastbot.v2';
function fleetSig(list) {
  return (list || []).map((b) => [b.id, b.status, b.players, b.health, b.food, b.loggedIn ? 1 : 0, b.joinedAt || 0, (b.lastLog && b.lastLog.t) || 0, b.autoEat ? 1 : 0].join(':')).join('|');
}
function saveSnapshot() {
  try { localStorage.setItem(SNAP_KEY, JSON.stringify({ bots: state.bots, stats: state.stats, at: Date.now() })); } catch (e) {}
}
function scheduleSnapshot() {
  if (state._snapTimer) return;
  state._snapTimer = setTimeout(() => { state._snapTimer = null; saveSnapshot(); }, 1500);
}
function loadSnapshot() {
  try {
    const d = JSON.parse(localStorage.getItem(SNAP_KEY) || 'null');
    if (d && Array.isArray(d.bots) && d.bots.length && Date.now() - (d.at || 0) < 15 * 60 * 1000) return d;
  } catch (e) {}
  return null;
}
function saveLastBot(id, patch) {
  try {
    let cur = {};
    try { cur = JSON.parse(localStorage.getItem(LASTBOT_KEY) || '{}') || {}; } catch (e) { cur = {}; }
    if (cur.id !== id) cur = { id: id };
    Object.assign(cur, patch, { id: id, at: Date.now() });
    localStorage.setItem(LASTBOT_KEY, JSON.stringify(cur));
  } catch (e) {}
}
function hydrateLastBot() {
  if (!state.botId) return;
  try {
    const d = JSON.parse(localStorage.getItem(LASTBOT_KEY) || 'null');
    if (!d || d.id !== state.botId) return;
    if (Array.isArray(d.logs) && d.logs.length && !state.logs.has(d.id)) state.logs.set(d.id, d.logs);
    if (d.inv && !state.invs.has(d.id)) state.invs.set(d.id, d.inv);
  } catch (e) {}
}
function prefetchBot(id) {
  if (!id) return;
  const now = Date.now();
  if (now - (state._prefetch[id] || 0) < 15000) return;
  state._prefetch[id] = now;
  if (!state.logs.has(id)) loadBotLogs(id);
  if (!state.invs.has(id)) loadBotInventory(id);
}

/* ── state ── */
const state = {
  authed: false,
  loading: true,
  bots: [],
  stats: {},
  view: 'dashboard',
  query: '',
  filter: 'all',
  botId: null,
  logs: new Map(),
  invs: new Map(),
  proxy: null,
  _pxPoll: null,
  _pxBusy: false,
  live: 'connecting',
  sse: null,
  lastEventAt: 0,
  lastSyncAt: 0,
  tick: null,
  sseWatch: null,
  _spy: null,
  _tabLock: 0,
  _tabTarget: null,
  _snapTimer: null,
  _prefetch: {},
  _inflight: { logs: {}, inv: {} },
};

/* ── api ── */
async function api(path, opts) {
  opts = opts || {};
  // Always honour an explicit method — a DELETE/POST with no body must not
  // silently become a GET. That made the delete buttons appear to do nothing.
  const options = { credentials: 'same-origin', method: opts.method || (opts.body != null ? 'POST' : 'GET') };
  if (opts.body != null) { options.headers = { 'Content-Type': 'application/json' }; options.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body); }
  const res = await fetch(path, options);
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (res.status === 401) { showLogin(); throw new Error('Session expired'); }
  if (!res.ok) throw new Error((data && data.error) || 'Request failed (' + res.status + ')');
  return data;
}

/* ── login / shell ── */
async function enterApp() {
  state.authed = true;
  state.loading = true;
  $('#login-screen').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  $('#mobilenav').classList.remove('hidden');
  document.body.classList.remove('is-locked');
  document.title = 'Dashboard · MCBot Control';

  // Paint immediately from the last known fleet, then reconcile with the server.
  const snap = loadSnapshot();
  if (snap) { state.bots = snap.bots; state.stats = snap.stats || {}; state.loading = false; }
  applyRoute();
  renderSidebar();
  patchAggregates();

  try {
    const data = await api('/api/state');
    const next = Array.isArray(data.bots) ? data.bots : [];
    const changed = fleetSig(state.bots) !== fleetSig(next);
    state.bots = next;
    state.stats = data.stats || {};
    state.loading = false;
    state.lastSyncAt = Date.now();
    if (changed) applyRoute();
    else { renderView(); renderSidebar(); patchAggregates(); }
    scheduleSnapshot();
    connectSSE();
    startTick();
  } catch (e) { state.loading = false; renderAll(); }
}
function showLogin() {
  state.authed = false;
  state.loading = true;
  state.bots = [];
  state.stats = {};
  state.view = 'dashboard';
  state.botId = null;
  $('#shell').classList.add('hidden');
  $('#mobilenav').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  document.body.classList.remove('is-locked');
  document.title = 'Sign in · MCBot Control';
}
async function doLogout() { try { await api('/api/logout', { method: 'POST' }); } catch (e) {} showLogin(); }

/* ── SSE ── */
function connectSSE() {
  closeSSE();
  state.lastEventAt = Date.now();
  const es = new EventSource('/api/events');
  state.sse = es;
  const wrap = (name, fn) => { es.addEventListener(name, (e) => { bumpSse(); try { fn(JSON.parse(e.data)); } catch (err) {} }); };
  es.onopen = () => { bumpSse(); };
  wrap('bot', (d) => onBot(d.bot));
  wrap('stats', (d) => onStats(d));
  wrap('log', (d) => onLog(d));
  wrap('removed', (d) => { if (d && d.id) { state.bots = state.bots.filter((b) => b.id !== d.id); renderAll(); scheduleSnapshot(); } });
  es.addEventListener('ping', () => bumpSse());
  es.addEventListener('hello', () => {
    bumpSse();
    // Only pull the full fleet when we actually lost the stream (or have nothing yet).
    if (!state.bots.length || Date.now() - state.lastSyncAt > 15000) resync();
  });
  es.onerror = () => { setLive('offline'); if (!state.authed) return; scheduleReconnect(1500); };
  startSseWatchdog();
}
function closeSSE() { if (state.sse) { try { state.sse.close(); } catch (e) {} state.sse = null; } }
function startSseWatchdog() {
  if (state.sseWatch) clearInterval(state.sseWatch);
  state.sseWatch = setInterval(() => {
    if (!state.authed) return;
    if (Date.now() - state.lastEventAt > 26000) { closeSSE(); scheduleReconnect(2000); }
  }, 5000);
}
function startTick() { if (state.tick) clearInterval(state.tick); state.tick = setInterval(() => { if (state.authed) updateUptimes(); }, 1000); }
function bumpSse() { state.lastEventAt = Date.now(); setLive('live'); }
function setLive(mode) {
  state.live = mode;
  const label = mode === 'live' ? 'Live' : (mode === 'connecting' ? 'Connecting' : 'Reconnecting');
  $$('#live-pill, #live-pill-m').forEach((pill) => {
    pill.dataset.state = mode;
    const s = pill.querySelector('span');
    if (s) s.textContent = label;
  });
}
function scheduleReconnect(delay) { setLive('offline'); setTimeout(() => { if (!state.authed) return; connectSSE(); }, delay || 1500); }
function resync() {
  api('/api/state').then((d) => {
    const next = Array.isArray(d.bots) ? d.bots : [];
    const changed = fleetSig(state.bots) !== fleetSig(next);
    state.bots = next;
    state.stats = d.stats || {};
    state.lastSyncAt = Date.now();
    if (changed) renderAll();
    else { renderSidebar(); patchAggregates(); }
    scheduleSnapshot();
  }).catch(() => {});
}

/* ── live events ── */
function onBot(bot) {
  if (!bot) return;
  const i = state.bots.findIndex((b) => b.id === bot.id);
  if (i >= 0) state.bots[i] = bot; else state.bots.push(bot);
  scheduleSnapshot();
  renderSidebar();
  patchAggregates();
  if (state.view === 'bot' && state.botId === bot.id) patchBotPage(bot);
  else if (state.view === 'dashboard') {
    const card = document.querySelector('[data-bot="' + bot.id + '"]');
    if (card) patchBotCard(bot); else updateGrid();
    patchLivePanels();
  } else if (state.view === 'scores') {
    patchLivePanels();
  }
}
function onLog(d) {
  if (!d || !d.id || !d.entry) return;
  if (!state.logs.has(d.id)) state.logs.set(d.id, []);
  const arr = state.logs.get(d.id); arr.push(d.entry);
  if (arr.length > 400) state.logs.set(d.id, arr.slice(-400));
  if (state.view === 'bot' && state.botId === d.id) renderBotConsole();
}
function onStats(d) { if (d && d.stats) { state.stats = d.stats; scheduleSnapshot(); } renderSidebar(); patchAggregates(); }

/* ── chrome ── */
function updateChrome() {
  const meta = VIEW_META[state.view] || VIEW_META.dashboard;
  $('#page-title').textContent = meta[0];
  $('#page-sub').textContent = meta[1];
  document.title = (state.view === 'bot' ? 'Bot profile' : meta[0]) + ' · MCBot Control';
  $$('.nav__item[data-view], .mobilenav__item[data-view]').forEach((el) => el.classList.toggle('is-active', el.dataset.view === state.view));
}
function renderSidebar() {
  const stats = getStats();
  const sig = [stats.masterOn, stats.online, stats.connecting, stats.servers, (stats.proxies && stats.proxies.total) || 0].join('|');
  if (sig === state._sidebarSig) return;
  state._sidebarSig = sig;
  const master = $('#master-toggle');
  if (master) {
    const on = !!stats.masterOn;
    master.classList.toggle('is-on', on);
    master.setAttribute('aria-checked', String(on));
    const label = master.querySelector('.switch__label');
    if (label) label.textContent = on ? 'On' : 'Off';
  }
  const card = $('#power-card'); if (card) card.classList.toggle('is-on', !!stats.masterOn);
  const powerState = $('#power-state');
  if (powerState) powerState.textContent = stats.masterOn ? stats.online + ' online · ' + stats.connecting + ' connecting' : 'All systems idle';
  const count = $('#nav-servers-count'); if (count) count.textContent = String(stats.servers);
  const pxCount = $('#nav-proxies-count');
  if (pxCount) {
    const px = stats.proxies || (state.proxy ? { total: state.proxy.total } : null);
    pxCount.textContent = px && px.total ? String(px.total) : '0';
  }
}
function renderAll() { updateChrome(); renderView(); renderSidebar(); patchAggregates(); }
function patchAggregates() {
  const s = getStats();
  const pct = s.total ? Math.round((s.online / s.total) * 100) : 0;
  $$('[data-agg]').forEach((el) => {
    const k = el.getAttribute('data-agg');
    if (k === 'ring') {
      el.style.setProperty('--p', pct);
      const b = el.querySelector('b'); if (b) b.textContent = pct + '%';
      return;
    }
    if (k === 'pct') { el.textContent = pct + '%'; return; }
    if (k === 'connect-hint') { el.textContent = s.connecting ? s.connecting + ' connecting' : 'all systems go'; return; }
    const v = s[k];
    if (v != null && el.textContent !== String(v)) el.textContent = String(v);
  });
}

/* ── scoreboard helpers ── */
function botTopScore(bot) {
  const items = (bot && bot.scoreboard && bot.scoreboard.items) || [];
  let best = null;
  items.forEach((it) => {
    const amt = Number.isFinite(it.amount) ? it.amount : null;
    if (amt == null) return;
    if (!best || amt > best.amount) {
      best = { label: (it.nameLabel || it.label || it.name || 'Score'), amount: amt, text: it.amountText || fmtCompact(amt) };
    }
  });
  return best;
}
function boardRows(limit) {
  const rows = (state.bots || [])
    .filter((b) => b.status === 'online')
    .map((b) => ({ bot: b, top: botTopScore(b) }))
    .filter((r) => r.top);
  rows.sort((a, b) => b.top.amount - a.top.amount);
  return limit ? rows.slice(0, limit) : rows;
}
function boardRowsHtml(limit) {
  const rows = boardRows(limit);
  if (!rows.length) {
    return '<div class="board__empty">' + icon('trophy') + '<span>No scoreboard data yet.<br />Sidebar scores appear once a bot is in-game.</span></div>';
  }
  const max = Math.max.apply(null, rows.map((r) => r.top.amount).concat([1]));
  return rows.map((r, i) => {
    const pct = Math.max(4, Math.round((r.top.amount / max) * 100));
    return '<div class="board__row' + (i === 0 ? ' is-top' : '') + '">'
      + '<span class="board__rank">' + String(i + 1).padStart(2, '0') + '</span>'
      + '<span class="board__av">' + esc(initial(r.bot.name)) + '<img src="/api/skin/' + encodeURIComponent(r.bot.name) + '?kind=head&size=64" alt="" loading="lazy" decoding="async" /></span>'
      + '<div class="board__body"><div class="board__name">' + esc(r.bot.name) + '</div><div class="board__meta">' + esc(r.top.label) + ' · ' + esc(r.bot.host) + '</div>'
      + '<div class="pulse-row__bar" style="margin-top:6px"><span style="width:' + pct + '%"></span></div></div>'
      + '<div class="board__val"><b>' + esc(r.top.text) + '</b><span>' + esc(r.top.label) + '</span></div>'
      + '</div>';
  }).join('');
}
function serverRows() {
  const map = new Map();
  (state.bots || []).forEach((b) => {
    const key = serverKey(b);
    const rec = map.get(key) || { key: key, host: b.host, port: b.port, bots: 0, online: 0, players: 0 };
    rec.bots += 1;
    if (b.status === 'online') { rec.online += 1; rec.players = Math.max(rec.players, b.players || 0); }
    map.set(key, rec);
  });
  return Array.from(map.values());
}
function pulseRowsHtml() {
  const rows = serverRows();
  if (!rows.length) return '<div class="board__empty">' + icon('server') + '<span>No servers yet.</span></div>';
  return rows.map((s) => {
    const pct = s.bots ? Math.round((s.online / s.bots) * 100) : 0;
    return '<div class="pulse-row' + (s.online ? ' is-online' : '') + '">'
      + '<div class="pulse-row__top"><i></i><span class="pulse-row__host">' + esc(s.host) + ':' + s.port + '</span><span class="pulse-row__count">' + s.online + '/' + s.bots + '</span></div>'
      + '<div class="pulse-row__bar"><span style="width:' + pct + '%"></span></div>'
      + '<div class="pulse-row__foot"><span>' + s.players + ' players</span><span>' + (s.online ? 'streaming' : 'idle') + '</span></div>'
      + '</div>';
  }).join('');
}
function activityHtml() {
  const items = (state.bots || []).filter((b) => b.lastLog && b.lastLog.text).slice(0, 5);
  if (!items.length) return '';
  return '<div class="panel__divider"></div><div class="activity"><span class="activity__label">' + icon('zap') + 'Recent activity</span>'
    + items.map((b) => '<div class="activity__row"><b>' + esc(b.name) + '</b><span>' + esc(String(b.lastLog.text).slice(0, 90)) + '</span></div>').join('')
    + '</div>';
}
function pulseBodyHtml() { return pulseRowsHtml() + activityHtml(); }

/* ── dashboard ── */
function heroHtml() {
  const s = getStats();
  const pct = s.total ? Math.round((s.online / s.total) * 100) : 0;
  const line = s.total === 0
    ? 'Add a server and a password — the bot logs in and stays connected for you.'
    : s.online + ' online · ' + s.connecting + ' connecting · ' + s.servers + ' server' + (s.servers === 1 ? '' : 's') + ' under control.';
  return '<section class="hero">'
    + '<div class="hero__main">'
    + '<div class="hero__copy">'
    + '<span class="eyebrow"><i></i> Control center</span>'
    + '<h1>Your fleet, <em>live</em>.</h1>'
    + '<p>' + esc(line) + '</p>'
    + '<div class="hero__actions"><button class="btn btn-primary" data-action="add">' + icon('plus') + '<span>Add bot</span></button><button class="btn btn-ghost" data-action="setup">' + icon('layers') + '<span>Fleet setup</span></button><button class="btn btn-ghost" data-action="refresh">' + icon('restart') + '<span>Refresh</span></button></div>'
    + '</div>'
    + '<div class="hero__stage" aria-hidden="true"><div class="stage stage--float"><div class="stage__ring"></div><div class="cube-wrap"><div class="cube">'
    + '<span class="cube__f cube__f--f"></span><span class="cube__f cube__f--b"></span><span class="cube__f cube__f--r"></span><span class="cube__f cube__f--l"></span><span class="cube__f cube__f--t"></span><span class="cube__f cube__f--u"></span>'
    + '</div></div><div class="stage__shadow"></div></div></div>'
    + '</div>'
    + '<aside class="hero__side">'
    + '<span class="eyebrow"><i></i> Live now</span>'
    + '<div class="hero__count"><b data-agg="online">' + s.online + '</b><span>/ <span data-agg="total">' + s.total + '</span></span></div>'
    + '<div class="hero__ring" data-agg="ring" style="--p:' + pct + '"><b>' + pct + '%</b></div>'
    + '<ul class="hero__mini"><li><i></i>Online<b data-agg="online">' + s.online + '</b></li><li><i class="is-dim"></i>Connecting<b data-agg="connecting">' + s.connecting + '</b></li><li><i class="is-dim"></i>Servers<b data-agg="servers">' + s.servers + '</b></li></ul>'
    + '</aside>'
    + '</section>';
}
function statsHtml() {
  const s = getStats();
  const cards = [
    { icon: 'zap', value: s.online, agg: 'online', label: 'Bots online', hint: '<span data-agg="connect-hint">' + (s.connecting ? s.connecting + ' connecting' : 'all systems go') + '</span>', cls: 'stat--gold' },
    { icon: 'cube', value: s.total, agg: 'total', label: 'Total bots', hint: 'unlimited fleet', cls: 'stat--white' },
    { icon: 'server', value: s.servers, agg: 'servers', label: 'Servers', hint: 'unique endpoints', cls: '' },
    { icon: 'users', value: s.players, agg: 'players', label: 'Players online', hint: 'seen by your bots', cls: '' },
  ];
  return '<section class="stats">' + cards.map((c) =>
    '<div class="stat ' + c.cls + '"><span class="stat__icon">' + icon(c.icon) + '</span><div><div class="stat__value" data-agg="' + c.agg + '">' + c.value + '</div><div class="stat__label">' + c.label + '</div><div class="stat__hint">' + c.hint + '</div></div></div>'
  ).join('') + '</section>';
}
function gridHtml() {
  const bots = filteredBots();
  if (bots.length) return '<div class="bot-grid">' + bots.map(botCard).join('') + '</div>';
  if (state.bots.length) return '<div class="no-results">No bots match this search or filter. Try another name, IP or status.</div>';
  if (state.loading) {
    const sk = '<article class="bot-card is-skeleton" aria-hidden="true">'
      + '<div class="sk-top"><span class="sk sk-av"></span><div class="sk-lines"><span class="sk sk-line" style="width:44%"></span><span class="sk sk-line" style="width:66%"></span></div></div>'
      + '<div class="sk-row">' + '<span class="sk sk-block"></span>'.repeat(4) + '</div>'
      + '<span class="sk sk-line" style="width:82%"></span>'
      + '<span class="sk sk-line" style="width:100%;height:34px;border-radius:11px"></span>'
      + '</article>';
    return '<div class="bot-grid">' + sk.repeat(4) + '</div>';
  }
  return '<div class="empty"><div class="empty__art">' + icon('cube') + '</div><h3>No bots yet</h3><p>Add your first Minecraft bot — name, server IP and password. Auto-login, reconnect and server switching are handled for you.</p><button class="btn btn-primary" data-action="add">' + icon('plus') + '<span>Add your first bot</span></button></div>';
}
function dashboardHtml() {
  const s = getStats();
  const shown = filteredBots().length;
  return '<div class="dash">'
    + heroHtml()
    + statsHtml()
    + '<div class="dash__cols">'
    + '<section class="panel board"><div class="panel__head"><div><div class="panel__title">' + icon('trophy') + '<h3>Fleet scoreboard</h3></div><p class="panel__sub">Highest sidebar stat per bot, ranked live.</p></div><span class="panel__tag">' + s.online + ' online</span></div><div class="board__list" id="board-body" data-sig="' + esc(boardSig()) + '">' + boardRowsHtml(8) + '</div></section>'
    + '<section class="panel"><div class="panel__head"><div><div class="panel__title">' + icon('server') + '<h3>Server pulse</h3></div><p class="panel__sub">Every endpoint your bots sit on.</p></div><span class="panel__tag">' + s.servers + ' live</span></div><div class="pulse-list" id="pulse-body" data-sig="' + esc(pulseSig()) + '">' + pulseBodyHtml() + '</div></section>'
    + '</div>'
    + '<section class="fleet">'
    + '<div class="fleet__head"><div class="fleet__headline"><div><h2>Your bots</h2><p><span id="fleet-count">' + shown + '</span> of ' + state.bots.length + ' shown · live updates</p></div>'
    + (state.bots.length ? '<button class="btn btn-ghost btn-sm btn-danger-ghost" data-action="clear-all">' + icon('trash') + '<span>Remove all</span></button>' : '') + '</div>'
    + '<div class="fleet__tools"><label class="search" style="width:auto;flex:1 1 190px"><svg class="ico"><use href="#i-search"></use></svg><input data-search type="search" placeholder="Search bots or IPs…" autocomplete="off" aria-label="Search bots" value="' + esc(state.query) + '" /></label>'
    + '<div class="chips"><button class="chip ' + (state.filter === 'all' ? 'is-active' : '') + '" data-filter="all">All</button><button class="chip ' + (state.filter === 'online' ? 'is-active' : '') + '" data-filter="online">Online</button><button class="chip ' + (state.filter === 'offline' ? 'is-active' : '') + '" data-filter="offline">Offline</button></div></div></div>'
    + '<div id="bot-grid-wrap">' + gridHtml() + '</div>'
    + '</section>'
    + '</div>';
}
function updateGrid() {
  const wrap = $('#bot-grid-wrap'); if (!wrap) return;
  wrap.innerHTML = gridHtml();
  const count = $('#fleet-count');
  if (count) count.textContent = String(filteredBots().length);
  $$('.chip').forEach((c) => c.classList.toggle('is-active', c.getAttribute('data-filter') === state.filter));
  bindCards();
}
function patchLivePanels() {
  setSigHtml($('#board-body'), boardSig(), boardRowsHtml(8));
  setSigHtml($('#pulse-body'), pulseSig(), pulseBodyHtml());
  const full = $('#scores-board');
  if (full) setSigHtml(full, boardSig(), boardRowsHtml());
}

/* ── bot card ── */
function botVitals(bot) {
  if (bot.status !== 'online') return '';
  const hp = Number.isFinite(bot.health) ? Math.max(0, Math.min(20, bot.health)) : null;
  const food = Number.isFinite(bot.food) ? Math.max(0, Math.min(20, bot.food)) : null;
  const p = bot.position;
  const pos = p && Number.isFinite(p.x) ? p.x + ' ' + p.y + ' ' + p.z : '';
  if (hp === null && food === null && !pos) return '';
  let out = '<div class="bot-vitals">';
  if (hp !== null) out += '<span class="vital vital--hp" title="Health">' + icon('heart') + '<b>' + hp + '</b></span>';
  if (food !== null) out += '<span class="vital vital--food" title="Food">' + icon('food') + '<b>' + food + '</b></span>';
  if (bot.autoEat) out += '<span class="bot-flag" title="Auto-eat">' + icon('zap') + 'AE</span>';
  if (pos) out += '<span class="bot-coords" title="Position">' + icon('pin') + esc(pos) + '</span>';
  out += '</div>';
  return out;
}
function invStripHtml(bot) {
  const items = Array.isArray(bot.inventoryPreview) ? bot.inventoryPreview : [];
  const used = bot.inventoryUsed || 0;
  if (items.length) {
    const slots = items.slice(0, 6).map((it) => {
      const extra = it.count > 1 ? '<i class="mini-more">x' + it.count + '</i>' : '';
      return '<span class="mini-slot">' + itemImgHtml(it, bot.version, 'mini-img') + extra + '</span>';
    }).join('');
    const more = items.length > 6 ? '<span class="mini-extra">+' + (items.length - 6) + '</span>' : '';
    return '<span class="bot-inv" data-action="bot-page" data-id="' + esc(bot.id) + '" title="Open ' + esc(bot.name) + '\u2019s inventory"><span class="bot-inv__slots">' + slots + more + '</span><span class="bot-inv__label">' + icon('layers') + '<b>' + used + '</b><span>/36</span></span></span>';
  }
  return '<span class="bot-inv is-off"><span class="bot-inv__empty">' + icon('layers') + '<span>' + (bot.status === 'online' ? 'Inventory empty' : 'Inventory offline') + '</span></span></span>';
}
function botCard(bot) {
  const st = statusMeta(bot);
  const uptime = bot.joinedAt ? fmtDuration(Date.now() - bot.joinedAt) : '—';
  const last = (bot.lastLog && bot.lastLog.text) || 'No activity yet';
  const loginLabel = bot.loggedIn ? 'Verified' : (bot.autoLogin ? 'Auto' : 'Off');
  const loginCls = bot.loggedIn ? 'good' : (bot.autoLogin ? '' : 'warn');
  const active = isActive(bot);
  return '<article class="bot-card' + (bot.status === 'online' ? ' is-online' : '') + '" data-bot="' + esc(bot.id) + '">'
    + '<div class="bot-card__top">'
    + '<button class="bot-avatar" type="button" data-action="bot-page" data-id="' + esc(bot.id) + '" title="Open ' + esc(bot.name) + '"><span class="avatar-initial">' + esc(initial(bot.name)) + '</span><img src="/api/skin/' + encodeURIComponent(bot.name) + '?kind=head&size=64" alt="" loading="lazy" decoding="async" /><span class="status-dot ' + st.dot + '" data-f="dot"></span></button>'
    + '<button class="bot-id" type="button" data-action="bot-page" data-id="' + esc(bot.id) + '"><h3>' + esc(bot.name) + '</h3><p><i class="server-dot"></i>' + esc(serverLabel(bot)) + '</p></button>'
    + '<span class="pill ' + st.pill + '" data-f="pill"><i></i>' + st.label + '</span>'
    + '</div>'
    + '<div class="bot-meta">'
    + '<div class="bot-meta__item"><span>Uptime</span><b data-uptime="' + (bot.joinedAt || '') + '">' + uptime + '</b></div>'
    + '<div class="bot-meta__item"><span>Players</span><b data-f="players">' + (bot.status === 'online' ? (bot.players || 0) : '—') + '</b></div>'
    + '<div class="bot-meta__item"><span>Version</span><b>' + esc(bot.version) + '</b></div>'
    + '<div class="bot-meta__item"><span>Login</span><b class="' + loginCls + '" data-f="login">' + loginLabel + '</b></div>'
    + '</div>'
    + '<div data-f="vitals" data-sig="' + esc(vitalsSig(bot)) + '">' + (botVitals(bot) || '') + '</div>'
    + '<div data-f="inv" data-sig="' + esc(invStripSig(bot)) + '">' + invStripHtml(bot) + '</div>'
    + '<div class="bot-last" data-f="last" title="' + esc(last) + '">' + esc(last) + '</div>'
    + '<div class="bot-actions">'
    + '<button class="switch ' + (active ? 'is-on' : '') + '" type="button" role="switch" aria-checked="' + String(active) + '" data-action="toggle" data-id="' + esc(bot.id) + '" data-f="switch" aria-label="' + (active ? 'Stop' : 'Start') + ' ' + esc(bot.name) + '"><span class="switch__track"><span class="switch__thumb"></span></span><span class="switch__label" data-f="switch-label">' + (active ? 'On' : 'Off') + '</span></button>'
    + '<button class="btn btn-ghost btn-sm" data-action="console" data-id="' + esc(bot.id) + '">' + icon('terminal') + '<span>Console</span></button>'
    + '<button class="icon-btn" data-action="bot-page" data-id="' + esc(bot.id) + '" title="Open full page" aria-label="Open ' + esc(bot.name) + '">' + icon('arrow') + '</button>'
    + '<button class="icon-btn" data-action="restart" data-id="' + esc(bot.id) + '" title="Restart" aria-label="Restart ' + esc(bot.name) + '">' + icon('restart') + '</button>'
    + '<button class="icon-btn icon-btn--danger" data-action="delete-bot" data-id="' + esc(bot.id) + '" title="Delete bot" aria-label="Delete ' + esc(bot.name) + '">' + icon('trash') + '</button>'
    + '</div>'
    + '</article>';
}
function patchBotCard(bot) {
  const card = document.querySelector('[data-bot="' + bot.id + '"]');
  if (!card) return;
  const st = statusMeta(bot);
  const active = isActive(bot);
  card.classList.toggle('is-online', bot.status === 'online');
  const pill = card.querySelector('[data-f="pill"]');
  if (pill) { const cls = 'pill ' + st.pill; if (pill.className !== cls) pill.className = cls; if (pill.innerHTML !== '<i></i>' + st.label) pill.innerHTML = '<i></i>' + st.label; }
  const dot = card.querySelector('[data-f="dot"]');
  if (dot) { const cls = 'status-dot ' + st.dot; if (dot.className !== cls) dot.className = cls; }
  const sw = card.querySelector('[data-f="switch"]');
  if (sw) {
    if (sw.classList.contains('is-on') !== active) sw.classList.toggle('is-on', active);
    if (sw.getAttribute('aria-checked') !== String(active)) sw.setAttribute('aria-checked', String(active));
    const l = sw.querySelector('[data-f="switch-label"]');
    if (l) { const label = active ? 'On' : 'Off'; if (l.textContent !== label) l.textContent = label; }
  }
  const players = card.querySelector('[data-f="players"]');
  if (players) { const v = bot.status === 'online' ? String(bot.players || 0) : '—'; if (players.textContent !== v) players.textContent = v; }
  const login = card.querySelector('[data-f="login"]');
  if (login) {
    const label = bot.loggedIn ? 'Verified' : (bot.autoLogin ? 'Auto' : 'Off');
    const cls = bot.loggedIn ? 'good' : (bot.autoLogin ? '' : 'warn');
    if (login.textContent !== label) login.textContent = label;
    if (login.className !== cls) login.className = cls;
  }
  setSigHtml(card.querySelector('[data-f="vitals"]'), vitalsSig(bot), botVitals(bot) || '');
  setSigHtml(card.querySelector('[data-f="inv"]'), invStripSig(bot), invStripHtml(bot));
  const last = card.querySelector('[data-f="last"]');
  if (last) { const t = (bot.lastLog && bot.lastLog.text) || 'No activity yet'; if (last.textContent !== t) { last.textContent = t; last.title = t; } }
  const up = card.querySelector('[data-uptime]');
  if (up) { const val = bot.joinedAt || ''; if (up.getAttribute('data-uptime') !== String(val)) up.setAttribute('data-uptime', val); }
}

/* ── bot page ── */
function scoreboardHtml(bot) {
  const sb = bot && bot.scoreboard;
  const items = (sb && Array.isArray(sb.items)) ? sb.items : [];
  const title = (sb && sb.title) || 'Scoreboard';
  const head = '<div class="sb__head"><span class="sb__title">' + icon('trophy') + '<b>' + esc(title) + '</b></span>'
    + '<span class="sb__live' + (items.length ? '' : ' is-idle') + '"><i></i>' + (items.length ? 'live' : 'idle') + '</span></div>';
  if (!items.length) {
    return '<div class="sb">' + head
      + '<div class="sb__empty">' + icon('list') + '<span>No sidebar scoreboard visible right now.</span></div>'
      + '<div class="sb__foot"><span>sidebar</span><b>waiting</b></div></div>';
  }
  const rows = items.slice(0, 15);
  const nums = rows.map((it) => (Number.isFinite(it.amount) ? it.amount : 0));
  const max = Math.max.apply(null, nums.concat([1]));
  const body = rows.map((it, i) => {
    const label = it.nameLabel || it.label || it.name || '—';
    const raw = it.amountText || (Number.isFinite(it.amount) ? fmtCompact(it.amount) : '');
    const w = Math.max(6, Math.round(((nums[i] || 0) / max) * 100));
    const rank = i + 1;
    return '<div class="sb__row' + (rank === 1 ? ' is-top' : '') + (rank <= 3 ? ' is-p' + rank : '') + '" style="--w:' + w + '%">'
      + '<span class="sb__rank">' + rank + '</span>'
      + '<span class="sb__label">' + esc(label) + '</span>'
      + '<span class="sb__bar"><i></i></span>'
      + '<span class="sb__val">' + esc(raw) + '</span></div>';
  }).join('');
  return '<div class="sb">' + head
    + '<div class="sb__rows">' + body + '</div>'
    + '<div class="sb__foot"><span>' + rows.length + ' lines · sidebar</span><b>' + esc(title) + '</b></div></div>';
}
/* ── player card ── */
function pingLevel(ping) {
  if (ping == null || !Number.isFinite(ping)) return 0;
  if (ping <= 80) return 5;
  if (ping <= 150) return 4;
  if (ping <= 300) return 3;
  if (ping <= 500) return 2;
  return 1;
}
function pingQuality(ping) {
  if (ping == null || !Number.isFinite(ping)) return 'no signal';
  if (ping <= 80) return 'excellent';
  if (ping <= 150) return 'good';
  if (ping <= 300) return 'fair';
  return 'poor';
}
function pingBarsHtml(ping) {
  const lvl = pingLevel(ping);
  let out = '<span class="pingbars" data-lvl="' + lvl + '" data-q="' + pingQuality(ping).replace(/\s+/g, '-') + '" title="' + (ping == null ? 'No ping data yet' : ping + ' ms') + '">';
  for (let i = 1; i <= 5; i++) out += '<i class="' + (i <= lvl ? 'is-on' : '') + '" style="height:' + (5 + i * 3) + 'px"></i>';
  return out + '</span>';
}
function proxyChipHtml(bot, cls) {
  const p = bot && bot.proxy;
  if (p) return '<span class="pxchip is-on' + (cls ? ' ' + cls : '') + '" title="Egress ' + esc(p.ip) + ':' + p.port + '">' + icon('globe') + '<b>' + esc(p.ip) + '</b><span>:' + p.port + '</span></span>';
  return '<span class="pxchip' + (cls ? ' ' + cls : '') + '" title="No proxy — connecting direct">' + icon('globe') + '<b>Direct</b><span>no proxy</span></span>';
}
function playerCardHtml(bot) {
  const st = statusMeta(bot);
  const d = bot.detail || {};
  const ping = bot.ping;
  const p = bot.position;
  const pos = p && Number.isFinite(p.x) ? Math.round(p.x) + ' ' + Math.round(p.y) + ' ' + Math.round(p.z) : '';
  const routeSig = bot.proxy ? bot.proxy.ip + ':' + bot.proxy.port : 'direct';
  const tags = '<span class="ptag">' + icon('user') + ' ' + esc(d.gamemode || 'Survival') + '</span>'
    + '<span class="ptag">' + icon('pin') + ' ' + esc(d.dimension || 'Overworld') + '</span>'
    + (pos ? '<span class="ptag ptag--mono">' + icon('cube') + ' ' + esc(pos) + '</span>' : '')
    + '<span class="ptag ' + (bot.loggedIn ? 'is-good' : '') + '" data-f="hero-tag">' + icon('shield') + ' ' + (bot.loggedIn ? 'Logged in' : 'Auto login') + '</span>';
  return '<section class="pcard' + (bot.status === 'online' ? ' is-online' : '') + '">'
    + '<div class="pcard__skin">'
    + '<div class="pcard__stage"><span class="pcard__halo" aria-hidden="true"></span><span class="avatar-initial">' + esc(initial(bot.name)) + '</span>'
    + '<img class="pcard__img" src="/api/skin/' + encodeURIComponent(bot.name) + '?kind=body&size=220" alt="" loading="lazy" decoding="async" /></div>'
    + '<span class="status-dot ' + st.dot + '" data-f="hero-dot"></span>'
    + '</div>'
    + '<div class="pcard__main">'
    + '<span class="pcard__eyebrow"><i></i>Player</span>'
    + '<h2 class="pcard__name">' + esc(bot.name) + '<span class="pill ' + st.pill + '" data-f="hero-pill"><i></i>' + st.label + '</span></h2>'
    + '<p class="pcard__server" data-f="hero-login">' + esc(bot.host) + ':' + bot.port + ' · v' + esc(bot.version) + ' · ' + (bot.loggedIn ? 'Logged in' : 'Auto login pending') + '</p>'
    + '<div class="bot-tags">' + tags + '</div>'
    + '</div>'
    + '<div class="pcard__side">'
    + '<div class="pcard__stat">'
    + '<span class="pcard__label">Ping</span>'
    + '<div class="pcard__pingrow">' + pingBarsHtml(ping) + '<b data-f="pc-ping">' + (ping == null ? '—' : ping + '<small>ms</small>') + '</b></div>'
    + '<span class="pcard__hint" data-f="pc-quality">' + pingQuality(ping) + '</span>'
    + '</div>'
    + '<div class="pcard__stat">'
    + '<span class="pcard__label">Route</span>'
    + '<div class="pcard__route" data-f="pc-route" data-sig="' + esc(routeSig) + '">' + proxyChipHtml(bot) + '</div>'
    + '<span class="pcard__hint">' + (bot.proxy ? 'proxied egress' : 'direct connection') + '</span>'
    + '</div>'
    + '</div>'
    + '<div class="pcard__actions">'
    + '<button class="btn btn-ghost btn-sm" data-action="toggle" data-id="' + esc(bot.id) + '">' + icon(isActive(bot) ? 'stop' : 'play') + '<span>' + (isActive(bot) ? 'Stop' : 'Start') + '</span></button>'
    + '<button class="btn btn-ghost btn-sm" data-action="restart" data-id="' + esc(bot.id) + '">' + icon('restart') + '<span>Restart</span></button>'
    + '<button class="btn btn-ghost btn-sm" data-action="auto-eat" data-id="' + esc(bot.id) + '">' + icon('zap') + '<span>Auto-eat</span></button>'
    + '<button class="btn btn-ghost btn-sm btn-danger-ghost" data-action="delete-bot" data-id="' + esc(bot.id) + '">' + icon('trash') + '<span>Delete</span></button>'
    + '<span class="pcard__spacer"></span>'
    + '<button class="btn btn-primary btn-sm" data-action="add">' + icon('plus') + '<span>New bot</span></button>'
    + '</div>'
    + '<div class="pcard__alert' + (bot.banned ? '' : ' hidden') + '" data-f="pc-alert">' + icon('alert')
    + '<div><b>Banned by the server</b><span data-f="pc-alert-text">' + esc(bot.banText || '') + '</span></div></div>'
    + '</section>';
}

function botPageHtml() {
  const bot = findBot(state.botId) || (state.bots || [])[0];
  if (!bot) return '<div class="empty"><div class="empty__art">' + icon('cube') + '</div><h3>No bot selected</h3><p>Go back to the dashboard and pick a bot.</p><button class="btn btn-primary" data-view="dashboard">' + icon('grid') + '<span>Back to overview</span></button></div>';
  const st = statusMeta(bot);
  const d = bot.detail || {};
  const xp = (d && d.xp) || { level: 0, points: 0 };
  const hp = Number.isFinite(bot.health) ? Math.max(0, Math.min(20, bot.health)) : 0;
  const food = Number.isFinite(bot.food) ? Math.max(0, Math.min(20, bot.food)) : 0;
  const metrics = [
    { key: 'health', icon: 'heart', label: 'Health', value: hp + '/20', bad: hp <= 6 },
    { key: 'food', icon: 'food', label: 'Food', value: food + '/20', warn: food <= 6 },
    { key: 'ping', icon: 'wifi', label: 'Ping', value: bot.ping == null ? '—' : bot.ping + ' ms' },
    { key: 'players', icon: 'users', label: 'Players', value: bot.players == null ? '—' : String(bot.players) },
    { key: 'uptime', icon: 'clock', label: 'Uptime', value: bot.joinedAt ? fmtDuration(Date.now() - bot.joinedAt) : '—', uptime: bot.joinedAt || '' },
    { key: 'xp', icon: 'zap', label: 'XP', value: String(xp.level || 0) },
  ];
  const metricsHtml = metrics.map((m) =>
    '<div class="bp-metric' + (m.bad ? ' is-bad' : (m.warn ? ' is-warn' : '')) + '" data-f="metric-' + m.key + '"><span>' + icon(m.icon) + ' ' + m.label + '</span><b data-f="m-' + m.key + '"' + (m.key === 'uptime' ? ' data-uptime="' + m.uptime + '"' : '') + '>' + m.value + '</b><em>' + m.label + '</em></div>'
  ).join('');
  return '<div class="bp-progress" aria-hidden="true"><i></i></div>'
    + playerCardHtml(bot)
    + '<div class="bp-stats">' + metricsHtml + '</div>'
    + '<div class="bp-tabs" role="tablist">'
    + '<button class="is-active" data-bp-scroll="bp-console">' + icon('terminal') + '<span>Console</span></button>'
    + '<button data-bp-scroll="bp-inventory">' + icon('layers') + '<span>Inventory</span></button>'
    + '<button data-bp-scroll="bp-score">' + icon('trophy') + '<span>Scoreboard</span></button>'
    + '</div>'
    + '<div class="sheet">'
    + '<section class="bpsec" id="bp-console">'
    + '<div class="bpsec__head"><span class="bpsec__num">01</span><h3>Console</h3><span class="bpsec__rule"></span><span class="bpsec__sub">Live output from ' + esc(bot.name) + ' — system, chat, sent and errors.</span></div>'
    + '<div class="console" id="bp-console-lines"><div class="console-empty">' + icon('terminal') + '<span>Console is quiet</span></div></div>'
    + '<form class="console-composer" id="bot-command-form" data-id="' + esc(bot.id) + '" autocomplete="off">'
    + '<input id="bot-command-input" type="text" maxlength="250" placeholder="Message or /command for ' + esc(bot.name) + '…" aria-label="Command for ' + esc(bot.name) + '" spellcheck="false" />'
    + '<button class="btn btn-primary" type="submit">' + icon('send') + '<span>Send</span></button>'
    + '</form></section>'
    + '<section class="bpsec" id="bp-inventory">'
    + '<div class="bpsec__head"><span class="bpsec__num">02</span><h3>Inventory</h3><span class="bpsec__rule"></span><span class="bpsec__sub">All 36 slots — crafting, result, armour, off-hand, storage and hotbar.</span></div>'
    + '<div id="bp-inv-root"></div></section>'
    + '<section class="bpsec" id="bp-score">'
    + '<div class="bpsec__head"><span class="bpsec__num">03</span><h3>Scoreboard</h3><span class="bpsec__rule"></span><span class="bpsec__sub">The server sidebar exactly as ' + esc(bot.name) + ' sees it.</span></div>'
    + '<div data-f="scoreboard" data-sig="' + esc(scoreSig(bot)) + '">' + scoreboardHtml(bot) + '</div></section>'
    + '</div>';
}
function patchBotPage(bot) {
  const root = $('#view');
  if (!root || !root.querySelector('.bot-hero')) return;
  const st = statusMeta(bot);
  const d = bot.detail || {};
  const xp = (d && d.xp) || { level: 0, points: 0 };
  const hp = Number.isFinite(bot.health) ? Math.max(0, Math.min(20, bot.health)) : 0;
  const food = Number.isFinite(bot.food) ? Math.max(0, Math.min(20, bot.food)) : 0;
  const setText = (sel, val) => { const el = root.querySelector(sel); if (el && el.textContent !== String(val)) el.textContent = String(val); };
  const pill = root.querySelector('[data-f="hero-pill"]');
  if (pill) { const cls = 'pill ' + st.pill; if (pill.className !== cls) pill.className = cls; if (pill.innerHTML !== '<i></i>' + st.label) pill.innerHTML = '<i></i>' + st.label; }
  const dot = root.querySelector('[data-f="hero-dot"]');
  if (dot) { const cls = 'status-dot ' + st.dot; if (dot.className !== cls) dot.className = cls; }
  const login = root.querySelector('[data-f="hero-login"]');
  if (login) { const html = esc(bot.host) + ':' + bot.port + ' · v' + esc(bot.version) + ' · ' + (bot.loggedIn ? 'Logged in' : 'Auto login pending'); if (login.innerHTML !== html) login.innerHTML = html; }
  const tag = root.querySelector('[data-f="hero-tag"]');
  if (tag) { tag.className = 'ptag' + (bot.loggedIn ? ' is-good' : ''); const html = icon('shield') + ' ' + (bot.loggedIn ? 'Logged in' : 'Auto login'); if (tag.innerHTML !== html) tag.innerHTML = html; }
  setText('[data-f="m-health"]', hp + '/20');
  setText('[data-f="m-food"]', food + '/20');
  setText('[data-f="m-ping"]', bot.ping == null ? '—' : bot.ping + ' ms');
  const pcPing = root.querySelector('[data-f="pc-ping"]');
  if (pcPing) { const html = bot.ping == null ? '—' : bot.ping + '<small>ms</small>'; if (pcPing.innerHTML !== html) pcPing.innerHTML = html; }
  const bars = root.querySelector('.pcard .pingbars');
  if (bars) {
    const lvl = pingLevel(bot.ping);
    if (bars.getAttribute('data-lvl') !== String(lvl)) {
      bars.setAttribute('data-lvl', String(lvl));
      bars.setAttribute('data-q', pingQuality(bot.ping).replace(/\s+/g, '-'));
      Array.prototype.forEach.call(bars.children, (el, i) => el.classList.toggle('is-on', i < lvl));
    }
  }
  const pq = root.querySelector('[data-f="pc-quality"]'); if (pq) pq.textContent = pingQuality(bot.ping);
  const alertEl = root.querySelector('[data-f="pc-alert"]');
  if (alertEl) {
    alertEl.classList.toggle('hidden', !bot.banned);
    const at = alertEl.querySelector('[data-f="pc-alert-text"]');
    if (at && bot.banned && at.textContent !== (bot.banText || '')) at.textContent = bot.banText || '';
  }
  const route = root.querySelector('[data-f="pc-route"]');
  if (route) {
    const sig = bot.proxy ? bot.proxy.ip + ':' + bot.proxy.port : 'direct';
    if (route.getAttribute('data-sig') !== sig) { route.setAttribute('data-sig', sig); route.innerHTML = proxyChipHtml(bot); }
  }
  setText('[data-f="m-players"]', bot.players == null ? '—' : bot.players);
  setText('[data-f="m-xp"]', xp.level || 0);
  const mh = root.querySelector('[data-f="metric-health"]'); if (mh) mh.classList.toggle('is-bad', hp <= 6);
  const mf = root.querySelector('[data-f="metric-food"]'); if (mf) mf.classList.toggle('is-warn', food <= 6);
  const up = root.querySelector('[data-f="m-uptime"]'); if (up) up.setAttribute('data-uptime', bot.joinedAt || '');
  setSigHtml(root.querySelector('[data-f="scoreboard"]'), scoreSig(bot), scoreboardHtml(bot));
}

/* ── servers + scores views ── */
function serversHtml() {
  const rows = serverRows();
  const cards = rows.map((s) => {
    const bots = (state.bots || []).filter((b) => serverKey(b) === s.key);
    return '<div class="server-card"><div class="server-card__head"><span class="server-dot"></span><h3>' + esc(s.host) + ':' + s.port + '</h3><span class="pill ' + (s.online ? 'pill--online' : 'pill--offline') + '"><i></i>' + s.online + '/' + s.bots.length + ' online</span></div>'
      + '<div class="server-card__bots">' + bots.map((b) => '<span class="server-card__bot">' + esc(b.name) + '</span>').join('') + '</div>'
      + '<div class="pulse-row__bar" style="margin-top:12px"><span style="width:' + (s.bots ? Math.round(s.online / s.bots * 100) : 0) + '%"></span></div>'
      + '<div class="pulse-row__foot"><span>' + s.players + ' players</span><span>' + (s.online ? 'streaming' : 'idle') + '</span></div></div>';
  }).join('');
  return '<div class="page-head"><div><span class="eyebrow"><i></i> Fleet</span><h2>Servers</h2><p>Bots grouped by the endpoint they connect to.</p></div></div>'
    + '<div class="bot-grid">' + (cards || '<div class="no-results">No servers yet.</div>') + '</div>';
}
function podiumHtml() {
  const rows = boardRows(3);
  if (!rows.length) return '';
  const order = [1, 0, 2];
  return '<div class="podium">' + order.map((idx) => {
    const r = rows[idx];
    if (!r) return '<div class="podium__card is-empty"></div>';
    const place = idx + 1;
    return '<div class="podium__card is-' + place + '">'
      + '<span class="podium__rank">#' + place + '</span>'
      + '<span class="podium__av">' + esc(initial(r.bot.name)) + '<img src="/api/skin/' + encodeURIComponent(r.bot.name) + '?kind=head&size=64" alt="" loading="lazy" decoding="async" /></span>'
      + '<b>' + esc(r.bot.name) + '</b>'
      + '<span class="podium__val">' + esc(r.top.text) + '</span>'
      + '<span class="podium__label">' + esc(r.top.label) + '</span>'
      + '</div>';
  }).join('') + '</div>';
}
function scoresHtml() {
  const online = (state.bots || []).filter((b) => b.status === 'online');
  const cards = online.map((b) =>
    '<div class="panel"><div class="panel__head"><div class="panel__title">' + icon('list') + '<h3>' + esc(b.name) + '</h3></div><span class="panel__tag">' + esc(serverLabel(b)) + '</span></div>' + scoreboardHtml(b) + '</div>'
  ).join('');
  return '<div class="page-head"><div><span class="eyebrow"><i></i> Live ranking</span><h2>Scoreboard</h2><p>Highest sidebar stat per bot, plus every sidebar in full.</p></div></div>'
    + podiumHtml()
    + '<section class="panel" style="margin-bottom:16px"><div class="panel__head"><div><div class="panel__title">' + icon('trophy') + '<h3>Fleet leaderboard</h3></div><p class="panel__sub">Ranked by the top sidebar value each bot reports.</p></div><span class="panel__tag">' + online.length + ' online</span></div><div class="board__list" id="scores-board" data-sig="' + esc(boardSig()) + '">' + boardRowsHtml() + '</div></section>'
    + (cards ? '<div class="bot-grid">' + cards + '</div>' : '<div class="empty"><div class="empty__art">' + icon('trophy') + '</div><h3>No scoreboards yet</h3><p>Sidebar scores show up here as soon as a bot is in-game.</p></div>');
}

/* ── proxies view ── */
function pxLatencyClass(ms) { return ms <= 700 ? 'is-good' : ms <= 1500 ? 'is-ok' : 'is-slow'; }
function pxSig(p) {
  if (!p) return 'none';
  return [p.enabled, p.total, p.assigned, p.uniqueIps, p.collisions, p.refreshing, p.maxPerIp, p.proxies.map((x) => x.key + ':' + x.bots.length).join(',')].join('|');
}
function pxStat(label, value, hint, cls) {
  return '<div class="pxstat' + (cls ? ' ' + cls : '') + '"><span>' + esc(label) + '</span><b>' + esc(value) + '</b><em>' + esc(hint) + '</em></div>';
}
function pxCardHtml(x, max) {
  const pct = Math.min(100, Math.round((x.bots.length / Math.max(1, max)) * 100));
  const bots = x.bots.length
    ? x.bots.map((n) => '<span class="pxbot"><span class="pxbot__av">' + esc(initial(n)) + '<img src="/api/skin/' + encodeURIComponent(n) + '?kind=head&size=48" alt="" loading="lazy" decoding="async" /></span><i>' + esc(n) + '</i></span>').join('')
    : '<span class="pxbot pxbot--free">no bots pinned</span>';
  return '<article class="pxcard">'
    + '<header class="pxcard__top"><span class="pxcard__ip"><b>' + esc(x.ip) + '</b><span>:' + x.port + '</span></span>'
    + '<span class="pxpill ' + pxLatencyClass(x.latency) + '">' + x.latency + ' ms</span></header>'
    + '<div class="pxcard__load"><i style="width:' + pct + '%"></i><span>' + x.bots.length + ' / ' + max + ' bots</span></div>'
    + '<div class="pxcard__bots">' + bots + '</div>'
    + '<footer class="pxcard__foot"><span>' + icon('shield') + (x.source === 'cached' ? 'cached' : 'verified') + '</span><span>' + x.fails + ' fails</span></footer>'
    + '</article>';
}
function proxyBodyHtml(p) {
  if (!p) return '<div class="pxgrid">' + new Array(3).fill('<div class="pxcard is-skel"><span class="sk sk-line"></span><span class="sk sk-line sk-sm"></span><span class="sk sk-block"></span></div>').join('') + '</div>';
  const inUse = p.proxies.filter((x) => x.bots.length);
  const spare = p.proxies.filter((x) => !x.bots.length);
  const routed = inUse.reduce((a, x) => a + x.bots.length, 0);
  const avg = inUse.length ? Math.round(inUse.reduce((a, x) => a + x.latency, 0) / inUse.length) : 0;
  const guard = (p.collisions || 0) > 0
    ? '<div class="pxwarn">' + icon('alert') + '<span><b>Route collision detected.</b> ' + p.collisions + ' bot' + (p.collisions === 1 ? '' : 's') + ' share an address — reshuffle to give each one its own IP.</span>'
      + '<button class="btn btn-ghost btn-sm" data-action="proxy-reshuffle">Reshuffle</button></div>'
    : '';
  const stats = '<div class="pxstats">'
    + pxStat('Pool', String(p.total), p.total ? 'live SOCKS5 routes' : 'none yet', 'is-brand')
    + pxStat('In use', String(inUse.length), 'egress addresses', 'is-gold')
    + pxStat('Routed bots', String(routed), 'pinned to an IP')
    + pxStat('Avg latency', avg ? avg + ' ms' : '—', 'on active routes')
    + pxStat('Max per IP', String(p.maxPerIp), 'bots per address')
    + '</div>';
  const refreshNote = p.refreshing
    ? '<span class="pxspin"><i></i>testing routes…</span>'
    : '<span class="pxmeta">' + (p.lastRefresh ? 'swept ' + fmtDuration(Date.now() - p.lastRefresh) + ' ago' : 'not swept yet') + '</span>';
  const controls = '<div class="pxcontrols">'
    + '<div class="pxcontrols__state"><span class="switch' + (p.enabled ? ' is-on' : '') + '" role="switch" aria-checked="' + (p.enabled ? 'true' : 'false') + '" data-action="proxy-toggle" tabindex="0"><span class="switch__track"><span class="switch__thumb"></span></span><span class="switch__label">' + (p.enabled ? 'On' : 'Off') + '</span></span>'
    + '<div><b>Automatic proxy pool</b><span>Fetch · verify · pin · fail over</span></div></div>'
    + '<div class="pxcontrols__right">' + refreshNote
    + '<label class="pxmax">max / IP <input id="px-max" type="number" min="1" max="50" value="' + p.maxPerIp + '" inputmode="numeric" /></label>'
    + '<button class="btn btn-ghost btn-sm" data-action="proxy-reshuffle">' + icon('restart') + '<span>Reshuffle</span></button>'
    + '</div></div>';
  const active = inUse.length
    ? '<div class="pxgrid">' + inUse.map((x) => pxCardHtml(x, p.maxPerIp)).join('') + '</div>'
    : '<div class="pxempty">' + icon('globe') + '<div><b>No bots are proxied yet</b><span>' + (p.total ? 'Hit “Apply to fleet” to re-home them one at a time, or they pick a route on the next reconnect.' : 'The pool is still filling — give it a minute.') + '</span></div></div>';
  const list = spare.length
    ? '<section class="pxpool"><header class="pxpool__head"><h3>' + icon('list') + 'Spare routes</h3><span>' + spare.length + ' ready</span></header>'
      + '<div class="pxpool__list">' + spare.slice(0, 60).map((x) =>
        '<div class="pxrow"><span class="pxrow__ip">' + esc(x.ip) + '<span>:' + x.port + '</span></span>'
        + '<span class="pxrow__bar"><i style="width:' + Math.max(8, Math.min(100, Math.round((1 - Math.min(x.latency, 2500) / 2500) * 100))) + '%"></i></span>'
        + '<span class="pxpill ' + pxLatencyClass(x.latency) + '">' + x.latency + ' ms</span>'
        + '<span class="pxrow__free">free</span></div>').join('') + '</div>'
      + (spare.length > 60 ? '<div class="pxpool__more">+' + (spare.length - 60) + ' more validated routes</div>' : '')
      + '</section>'
    : '';
  return guard + stats + controls + active + list;
}
function proxiesHtml() {
  const p = state.proxy;
  return '<div class="page-head"><div><span class="eyebrow"><i></i> Egress</span><h2>Proxies</h2>'
    + '<p>Each bot gets its own SOCKS5 address — one bot per IP — with a different route on every reconnect. Direct is only a last resort.</p></div>'
    + '<div class="page-head__actions">'
    + '<button class="btn btn-ghost" data-action="proxy-refresh">' + icon('restart') + '<span>Refresh pool</span></button>'
    + '<button class="btn btn-primary" data-action="proxy-apply">' + icon('zap') + '<span>Apply to fleet</span></button>'
    + '</div></div>'
    + '<div id="px-root" data-sig="' + esc(pxSig(p)) + '">' + proxyBodyHtml(p) + '</div>';
}
function patchProxies() {
  const root = document.getElementById('px-root');
  const p = state.proxy;
  if (!root || !p) return;
  const sig = pxSig(p);
  if (root.getAttribute('data-sig') === sig) return;
  root.setAttribute('data-sig', sig);
  root.innerHTML = proxyBodyHtml(p);
}
async function loadProxies(force) {
  if (state._pxBusy && !force) return;
  state._pxBusy = true;
  try {
    const d = await api('/api/proxies');
    state.proxy = d;
    if (state.view === 'proxies') patchProxies();
  } catch (e) {
    if (state.view === 'proxies') toast('err', 'Proxy pool', e.message);
  } finally { state._pxBusy = false; }
}
function proxyPost(body, title, msg) {
  return api('/api/proxies', { method: 'POST', body: body }).then((d) => {
    if (d && d.status) state.proxy = d.status; else state.proxy = d;
    patchProxies();
    if (title) toast('ok', title, msg || '');
    setTimeout(() => loadProxies(true), 900);
    if (body && body.refresh) setTimeout(() => loadProxies(true), 12000);
    return d;
  });
}

/* ── views ── */
function renderView() {
  if (state._pxPoll) { clearInterval(state._pxPoll); state._pxPoll = null; }
  if (state.view === 'bot') $('#view').innerHTML = botPageHtml();
  else if (state.view === 'servers') $('#view').innerHTML = serversHtml();
  else if (state.view === 'scores') $('#view').innerHTML = scoresHtml();
  else if (state.view === 'proxies') $('#view').innerHTML = proxiesHtml();
  else $('#view').innerHTML = dashboardHtml();
  afterRender();
}
function afterRender() {
  if (state.view === 'dashboard') { bindCards(); bindParallax(); }
  else if (state.view === 'bot') {
    bindSectionSpy();
    if (state.botId) { renderBotConsole(); renderBotInventory(); }
  }
  else if (state.view === 'proxies') {
    loadProxies(true);
    state._pxPoll = setInterval(() => { if (state.view === 'proxies') loadProxies(false); }, 6000);
  }
}
function updateUptimes() {
  $$('[data-uptime]').forEach((el) => {
    const t = Number(el.getAttribute('data-uptime') || 0);
    el.textContent = t ? fmtDuration(Date.now() - t) : '—';
  });
}
function switchView(view, push) {
  if (push === undefined) push = true;
  if (!['dashboard', 'servers', 'scores', 'proxies', 'bot'].includes(view)) return;
  if (state.view === view && view !== 'bot') return;
  state.view = view;
  if (view === 'bot') hydrateLastBot();
  updateChrome();
  renderView();
  renderSidebar();
  if (push) history.pushState({}, '', view === 'bot' ? '#/bot/' + state.botId : '#/' + view);
  if (view === 'bot' && state.botId) { loadBotLogs(state.botId); loadBotInventory(state.botId); }
  try { window.scrollTo(0, 0); } catch (e) {}
}
function applyRoute() {
  const raw = String(location.hash || '').replace(/^#\/?/, '');
  const parts = raw.split('/');
  if (parts[0] === 'bot' && parts[1]) { state.view = 'bot'; state.botId = parts[1]; }
  else if (parts[0] === 'servers') { state.view = 'servers'; state.botId = null; }
  else if (parts[0] === 'scores') { state.view = 'scores'; state.botId = null; }
  else if (parts[0] === 'proxies') { state.view = 'proxies'; state.botId = null; }
  else { state.view = 'dashboard'; state.botId = null; }
  if (state.bots.length) state.loading = false;
  if (state.view === 'bot') hydrateLastBot();
  updateChrome();
  renderView();
  renderSidebar();
  patchAggregates();
  // A deep link or reload straight into a bot page still needs its data.
  if (state.view === 'bot' && state.botId) { loadBotLogs(state.botId); loadBotInventory(state.botId); }
}

/* ── interaction ── */
function bindCards() {
  $$('.bot-card').forEach((card) => {
    if (card.getAttribute('data-tilt')) return;
    card.setAttribute('data-tilt', '1');
    const id = card.getAttribute('data-bot');
    // Warm logs + inventory the moment a mouse user aims at a card.
    card.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') prefetchBot(id); });
    if (reducedMotion()) return;
    let raf = 0, last = null;
    card.addEventListener('pointermove', (e) => {
      last = e;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!last) return;
        const r = card.getBoundingClientRect();
        const x = (last.clientX - r.left) / (r.width || 1) - 0.5;
        const y = (last.clientY - r.top) / (r.height || 1) - 0.5;
        card.style.transform = 'perspective(1000px) rotateX(' + (-y * 4).toFixed(2) + 'deg) rotateY(' + (x * 4).toFixed(2) + 'deg) translateY(-3px)';
        card.style.setProperty('--mx', ((x + 0.5) * 100).toFixed(1) + '%');
        card.style.setProperty('--my', ((y + 0.5) * 100).toFixed(1) + '%');
      });
    });
    card.addEventListener('pointerleave', () => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      card.style.transform = '';
    });
  });
}
function bindParallax() {
  const host = $('.hero__main');
  const stage = $('.hero__stage');
  if (!host || !stage || host.getAttribute('data-parallax')) return;
  host.setAttribute('data-parallax', '1');
  if (reducedMotion()) return;
  host.addEventListener('pointermove', (e) => {
    const r = host.getBoundingClientRect();
    const x = (e.clientX - r.left) / (r.width || 1) - 0.5;
    const y = (e.clientY - r.top) / (r.height || 1) - 0.5;
    stage.style.setProperty('--px', (x * 24).toFixed(1) + 'px');
    stage.style.setProperty('--py', (y * 20).toFixed(1) + 'px');
  });
  host.addEventListener('pointerleave', () => { stage.style.setProperty('--px', '0px'); stage.style.setProperty('--py', '0px'); });
}
function bindSectionSpy() {
  const tabs = $$('.bp-tabs button');
  if (!tabs.length) return;
  const map = tabs.map((b) => ({ b: b, el: document.getElementById(b.getAttribute('data-bp-scroll')) })).filter((m) => m.el);
  if (!map.length) return;
  const onScroll = () => {
    if (state._tabLock && Date.now() < state._tabLock) return;
    const y = window.scrollY + 220;
    let cur = map[0];
    map.forEach((m) => { if (m.el.getBoundingClientRect().top + window.scrollY <= y) cur = m; });
    tabs.forEach((t) => t.classList.toggle('is-active', t === cur.b));
  };
  if (state._spy) window.removeEventListener('scroll', state._spy);
  state._spy = onScroll;
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}
function scrollToSection(id) {
  const el = document.getElementById(id);
  if (!el) return;
  state._tabTarget = id;
  state._tabLock = Date.now() + 2600;
  $$('.bp-tabs button').forEach((b) => b.classList.toggle('is-active', b.getAttribute('data-bp-scroll') === id));
  const go = () => {
    if (state._tabTarget !== id) return;
    const target = document.getElementById(id);
    if (target) target.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  };
  go();
  // Inventory/logs finish loading after the first scroll, which shifts the page height.
  setTimeout(go, 420);
  setTimeout(go, 1150);
}

/* ── console ── */
function botLogs(id) { return state.logs.get(id) || []; }
function renderBotConsole() {
  const box = $('#bp-console-lines'); if (!box) return;
  const logs = botLogs(state.botId).slice(-90);
  let html = '';
  if (logs.length) {
    logs.forEach((e) => { html += '<div class="console-line kind-' + esc(e.kind || 'chat') + '"><time>' + fmtClock(e.t) + '</time><span class="console-kind">' + esc(e.kind || 'chat') + '</span><p>' + esc(e.text) + '</p></div>'; });
  } else html = '<div class="console-empty">' + icon('terminal') + '<span>Console is quiet</span></div>';
  box.innerHTML = html;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  if (nearBottom) box.scrollTop = box.scrollHeight;
}
async function loadBotLogs(id) {
  if (!id || state._inflight.logs[id]) return;
  state._inflight.logs[id] = 1;
  try {
    const d = await api('/api/bots/' + id + '/logs');
    const logs = Array.isArray(d.logs) ? d.logs : [];
    state.logs.set(id, logs);
    saveLastBot(id, { logs: logs.slice(-60) });
    if (state.view === 'bot' && state.botId === id) renderBotConsole();
  } catch (e) {} finally { delete state._inflight.logs[id]; }
}

/* ── inventory ── */
const ARMOR_GHOSTS = {
  helmet: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.6 10.4a7.4 7.4 0 0 1 14.8 0v3.8a2.2 2.2 0 0 1-2.2 2.2h-1.1v-2.6H7.9v2.6H6.8a2.2 2.2 0 0 1-2.2-2.2z"/></svg>',
  chest: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.6 3.1 12 5l3.4-1.9 4.7 3.3-1.9 3.4-1.7-.9V21H7.5V9l-1.7.9L4 6.5z"/></svg>',
  legs: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 3.4h10.8v4.2H6.6zM7.1 9h4.1v12H7.1zM12.8 9h4.1v12h-4.1z"/></svg>',
  boots: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 4h4.1v9.4h2.3V17H6.4zM13.4 4h4.1v13h-4.1z"/></svg>',
};

/* A slot that looks like a Minecraft slot: inset well, square, bevel. */
function mcSlot(it, version, opts) {
  opts = opts || {};
  const selected = !!opts.selected;
  const cls = 'mc-slot' + (opts.cls ? ' ' + opts.cls : '') + (it ? '' : ' is-empty') + (selected ? ' is-selected' : '');
  const name = it ? (it.displayName || it.name) : '';
  const tip = it ? name + (it.count > 1 ? ' ×' + it.count : '') : (opts.empty || '');
  let inner = '';
  if (it) {
    inner += itemImgHtml(it, version, 'mc-item');
    if (it.count > 1) inner += '<i class="mc-slot__count">' + it.count + '</i>';
    if (it.maxDurability > 1 && it.durabilityUsed > 0) {
      const left = Math.max(0, Math.min(1, 1 - it.durabilityUsed / it.maxDurability));
      inner += '<i class="mc-slot__dura" style="width:' + Math.round(left * 100) + '%;background:hsl(' + Math.round(left * 120) + ',85%,52%)"></i>';
    }
  } else if (opts.ghost && ARMOR_GHOSTS[opts.ghost]) {
    inner = '<span class="mc-ghost">' + ARMOR_GHOSTS[opts.ghost] + '</span>';
  }
  if (selected) inner += '<i class="mc-slot__sel" aria-hidden="true"></i>';
  return '<div class="' + cls + '"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' + inner + '</div>';
}

function inventoryHtml(inv, version, skeleton) {
  const slot = (it, opts) => mcSlot(it || null, version, opts);
  const craft = (inv && Array.isArray(inv.craft)) ? inv.craft : [null, null, null, null];
  const hotbar = (inv && Array.isArray(inv.hotbar)) ? inv.hotbar : new Array(9).fill(null);
  const main = (inv && Array.isArray(inv.main)) ? inv.main : new Array(27).fill(null);
  const armor = (inv && Array.isArray(inv.armor)) ? inv.armor : [null, null, null, null];
  const sel = inv ? (Number.isInteger(inv.selected) ? inv.selected : 0) : -1;
  const used = inv ? (inv.used || 0) : 0;
  const names = ['helmet', 'chest', 'legs', 'boots'];
  const label = (t) => '<span class="mcinv__label">' + esc(t) + '</span>';

  const head = '<div class="mcinv__head"><div class="mcinv__title">' + icon('layers') + '<b>Inventory</b>'
    + '<span>' + (skeleton ? 'loading…' : used + ' / 36 used') + '</span></div>'
    + '<div class="mcinv__legend"><i></i>selected hotbar</div></div>';

  const top = '<div class="mcinv__top">'
    + '<div class="mcinv__block mcinv__block--craft">' + label('Crafting')
    + '<div class="mcinv__craftrow"><div class="mcinv__cgrid">' + craft.map((it) => slot(it)).join('') + '</div>'
    + '<span class="mcinv__arrow">' + icon('arrow') + '</span>'
    + '<div class="mcinv__cres">' + slot(inv ? inv.craftResult : null) + '</div></div></div>'
    + '<div class="mcinv__block mcinv__block--armor">' + label('Armour')
    + '<div class="mcinv__acol">' + armor.map((it, i) => slot(it, { cls: 'mc-slot--armor', ghost: names[i], empty: names[i] })).join('') + '</div></div>'
    + '</div>';

  const body = '<div class="mcinv__block mcinv__block--main">' + label('Backpack')
    + '<div class="mcinv__grid">' + main.map((it) => slot(it)).join('') + '</div></div>';

  const bottom = '<div class="mcinv__bottom">'
    + '<div class="mcinv__hot">' + label('Hotbar')
    + '<div class="mcinv__hotgrid">' + hotbar.map((it, i) => slot(it, { selected: i === sel })).join('') + '</div></div>'
    + '<div class="mcinv__off">' + label('Off-hand')
    + '<div class="mcinv__offslot">' + slot(inv ? inv.offhand : null, { cls: 'mc-slot--off', empty: 'Off-hand' }) + '</div></div>'
    + '</div>';

  const foot = '<div class="mcinv__foot"><span>' + icon('cube') + (skeleton ? 'syncing slots' : (36 - used) + ' free slots') + '</span>'
    + '<span>' + (skeleton ? '' : 'capacity 36') + '</span></div>';

  return '<div class="mcinv' + (skeleton ? ' is-skel' : '') + '">' + head + top + body + bottom + foot + '</div>';
}

function renderBotInventory() {
  const root = $('#bp-inv-root'); if (!root) return;
  const inv = state.invs.get(state.botId) || null;
  const bot = findBot(state.botId) || {};
  root.innerHTML = inventoryHtml(inv, bot.version || '1.20.1', !inv);
}
async function loadBotInventory(id) {
  if (!id || state._inflight.inv[id]) return;
  state._inflight.inv[id] = 1;
  try {
    const d = await api('/api/bots/' + id + '/inventory');
    if (d && d.inventory) { state.invs.set(id, d.inventory); saveLastBot(id, { inv: d.inventory }); }
    if (state.view === 'bot' && state.botId === id) renderBotInventory();
  } catch (e) {} finally { delete state._inflight.inv[id]; }
}

/* ── actions ── */
function toggleMaster() {
  const on = !(state.stats && typeof state.stats.masterOn === 'boolean' ? state.stats.masterOn : getStats().masterOn);
  api('/api/master', { method: 'POST', body: JSON.stringify({ on: on }) })
    .then(() => { renderAll(); toast('ok', 'Master power', on ? 'All bots starting…' : 'All bots stopping…'); })
    .catch((e) => { toast('err', 'Master power', e.message); });
}
function handleAction(action, el) {
  const id = el ? el.getAttribute('data-id') : null;
  const act = () => {
    if (action === 'toggle' && id) { const bot = findBot(id); const stop = !bot || bot.status === 'online'; return api('/api/bots/' + id + '/' + (stop ? 'stop' : 'start'), { method: 'POST', body: JSON.stringify({}) }).then(() => renderAll()).catch((e) => toast('err', 'Action failed', e.message)); }
    if (action === 'restart' && id) { return api('/api/bots/' + id + '/restart', { method: 'POST', body: JSON.stringify({}) }).then(() => { renderAll(); toast('ok', 'Restarting', 'Bot is reconnecting…'); }).catch((e) => toast('err', 'Action failed', e.message)); }
    if (action === 'auto-eat' && id) { return api('/api/bots/' + id + '/auto-eat', { method: 'POST', body: JSON.stringify({}) }).then(() => { renderAll(); toast('ok', 'Auto-eat', 'Toggled.'); }).catch((e) => toast('err', 'Action failed', e.message)); }
    if (action === 'console' && id) { state.botId = id; switchView('bot'); return Promise.resolve(); }
    if (action === 'bot-page' && id) { state.botId = id; switchView('bot'); return Promise.resolve(); }
    if (action === 'add') { openAddBot(); return Promise.resolve(); }
    if (action === 'setup') { openFleetSetup(); return Promise.resolve(); }
    if (action === 'delete-bot' && id) { const bot = findBot(id); openConfirm('Delete bot', 'Remove ' + (bot ? bot.name : 'this bot') + ' from the panel? Its config and saved state will be erased.', 'Delete bot', () => api('/api/bots/' + id, { method: 'DELETE' }).then(() => afterRemoval('Bot deleted.'))); return Promise.resolve(); }
    if (action === 'clear-all') { openConfirm('Remove all bots', 'Delete all ' + state.bots.length + ' bots from the panel? This cannot be undone.', 'Remove all', () => api('/api/bots/clear', { method: 'POST', body: {} }).then((d) => afterRemoval((d.removed || 0) + ' bots removed.'))); return Promise.resolve(); }
    if (action === 'master') { toggleMaster(); return Promise.resolve(); }
    if (action === 'proxy-refresh') return proxyPost({ refresh: true }, 'Refreshing pool', 'Testing SOCKS5 routes — this takes about a minute.');
    if (action === 'proxy-reshuffle') return proxyPost({ reshuffle: true }, 'Assignments cleared', 'Bots pick a new IP on their next reconnect.');
    if (action === 'proxy-toggle') { const on = !(state.proxy && state.proxy.enabled); return proxyPost({ enabled: on }, 'Proxy pool ' + (on ? 'on' : 'off'), on ? 'New connections route through the pool.' : 'Direct connections only from now on.'); }
    if (action === 'proxy-apply') return proxyPost({ apply: true }, 'Re-homing fleet', 'One bot every 7 seconds, so the fleet never drops at once.');
    if (action === 'refresh') { return api('/api/state').then((d) => { state.bots = Array.isArray(d.bots) ? d.bots : []; state.stats = d.stats || {}; renderAll(); toast('ok', 'Refreshed', 'State synced.'); }).catch((e) => toast('err', 'Refresh failed', e.message)); }
    return Promise.resolve();
  };
  return act().catch((e) => toast('err', 'Action failed', e.message));
}
function toast(kind, title, text) {
  const box = $('#toasts'); if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast';
  const icoName = kind === 'err' ? 'alert' : (kind === 'ok' ? 'check' : 'zap');
  el.innerHTML = '<svg class="ico"><use href="#i-' + icoName + '"></use></svg><div><b>' + esc(title) + '</b><span>' + esc(text) + '</span></div>';
  box.appendChild(el);
  setTimeout(() => { try { el.remove(); } catch (e) {} }, 3600);
}
async function submitBotCommand(form) {
  const id = form.getAttribute('data-id');
  const input = form.querySelector('input');
  const message = String((input && input.value) || '').trim();
  if (!id || !message) return;
  try {
    await api('/api/bots/' + id + '/chat', { method: 'POST', body: JSON.stringify({ message: message }) });
    input.value = '';
    toast('ok', 'Sent', message);
  } catch (e) { toast('err', 'Send failed', e.message); }
}

/* ── add bot modal ── */
function openConfirm(title, body, label, onSubmit) {
  const root = $('#modal-root'); if (!root) return;
  state._confirmSubmit = onSubmit;
  root.hidden = false;
  root.innerHTML = '<div class="modal-backdrop" data-close="1"></div>'
    + '<div class="modal-card modal-card--sm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">'
    + '<div class="modal-head"><h2 id="confirm-title">' + esc(title) + '</h2><button class="icon-btn" type="button" data-close="1" aria-label="Close">' + icon('x') + '</button></div>'
    + '<form id="confirm-form" class="modal-body">'
    + '<p class="confirm__body">' + icon('alert') + '<span>' + esc(body) + '</span></p>'
    + '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-close="1">Cancel</button><button class="btn btn-danger" type="submit">' + esc(label) + '</button></div>'
    + '</form></div>';
}

async function afterRemoval(msg) {
  const d = await api('/api/state');
  state.bots = Array.isArray(d.bots) ? d.bots : [];
  state.stats = d.stats || {};
  if (state.view === 'bot' && state.botId && !findBot(state.botId)) {
    state.botId = null;
    location.hash = '#/dashboard';
    applyRoute();
  } else renderAll();
  toast('ok', 'Removed', msg);
}

function openFleetSetup() {
  const root = $('#modal-root'); if (!root) return;
  root.hidden = false;
  root.innerHTML = '<div class="modal-backdrop" data-close="1"></div>'
    + '<div class="modal-card modal-card--wide" role="dialog" aria-modal="true" aria-labelledby="fleet-title">'
    + '<div class="modal-head"><h2 id="fleet-title">Fleet setup</h2><button class="icon-btn" type="button" data-close="1" aria-label="Close">' + icon('x') + '</button></div>'
    + '<form id="fleet-form" class="modal-body" autocomplete="off">'
    + '<p class="fleet__note">' + icon('shield') + '<span><b>One bot, one IP.</b> Each name gets its own SOCKS5 route. Joins are staggered automatically.</span></p>'
    + '<label class="field"><span class="field__label">Player names — one per line</span>'
    + '<textarea name="names" class="fleet__names" rows="6" spellcheck="false" placeholder="PlayerOne' + String.fromCharCode(10) + 'PlayerTwo" required></textarea></label>'
    + '<div class="modal-grid">'
    + '<label class="field"><span class="field__label">Server IP</span><span class="field__box"><input name="host" placeholder="play.example.org" required /></span></label>'
    + '<label class="field"><span class="field__label">Port</span><span class="field__box"><input name="port" type="number" value="25565" min="1" max="65535" /></span></label>'
    + '<label class="field"><span class="field__label">Version</span><span class="field__box"><input name="version" value="1.20.1" /></span></label>'
    + '<label class="field"><span class="field__label">Minecraft password</span><span class="field__box"><input name="password" type="password" value="Sandun123" /></span></label>'
    + '</div>'
    + '<div class="modal-toggles">'
    + '<label class="check"><input type="checkbox" name="autoLogin" checked /> Auto-login</label>'
    + '<label class="check"><input type="checkbox" name="autoReconnect" checked /> Auto-reconnect</label>'
    + '<label class="check"><input type="checkbox" name="antiAfk" /> Anti-AFK</label>'
    + '<label class="check"><input type="checkbox" name="autoEat" checked /> Auto-eat</label>'
    + '<label class="check fleet__danger"><input type="checkbox" name="replace" checked /> Replace current fleet</label>'
    + '<label class="check"><input type="checkbox" name="start" checked /> Start after import</label>'
    + '</div>'
    + '<p id="fleet-error" class="login__error" hidden></p>'
    + '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-close="1">Cancel</button><button class="btn btn-primary" type="submit">' + icon('zap') + '<span>Import fleet</span></button></div>'
    + '</form></div>';
  const first = root.querySelector('textarea[name="names"]');
  if (first) setTimeout(() => { try { first.focus(); } catch (e) {} }, 40);
}

async function submitFleetSetup(form) {
  const err = $('#fleet-error');
  const fd = new FormData(form);
  const body = {
    names: String(fd.get('names') || ''),
    host: String(fd.get('host') || '').trim(),
    port: Number(fd.get('port') || 25565),
    version: String(fd.get('version') || '1.20.1').trim(),
    password: String(fd.get('password') || 'Sandun123'),
    autoLogin: fd.get('autoLogin') === 'on',
    autoReconnect: fd.get('autoReconnect') === 'on',
    antiAfk: fd.get('antiAfk') === 'on',
    autoEat: fd.get('autoEat') === 'on',
    replace: fd.get('replace') === 'on',
    start: fd.get('start') === 'on',
  };
  if (err) { err.textContent = ''; err.setAttribute('hidden', ''); }
  const btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    const d = await api('/api/bots/import', { method: 'POST', body: JSON.stringify(body) });
    await api('/api/proxies', { method: 'POST', body: { maxPerIp: 1, reshuffle: true } });
    closeModal();
    toast('ok', 'Fleet imported', d.created + ' bot' + (d.created === 1 ? '' : 's') + ' · one IP each, joining staggered.');
    const st = await api('/api/state');
    state.bots = Array.isArray(st.bots) ? st.bots : [];
    state.stats = st.stats || {};
    state.proxy = null;
    renderAll();
  } catch (e) { if (err) { err.textContent = e.message; err.removeAttribute('hidden'); } }
  finally { if (btn) btn.disabled = false; }
}

function openAddBot() {
  const root = $('#modal-root');
  if (!root) return;
  root.hidden = false;
  root.innerHTML = '<div class="modal-backdrop" data-close="1"></div>'
    + '<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="add-title">'
    + '<div class="modal-head"><h2 id="add-title">Add a bot</h2><button class="icon-btn" type="button" data-close="1" aria-label="Close">' + icon('x') + '</button></div>'
    + '<form id="add-bot-form" class="modal-body" autocomplete="off">'
    + '<div class="modal-grid">'
    + '<label class="field"><span class="field__label">Bot name</span><span class="field__box"><input name="name" maxlength="16" placeholder="e.g. adalei" required /></span></label>'
    + '<label class="field"><span class="field__label">Server IP</span><span class="field__box"><input name="host" placeholder="mc.example.org" required /></span></label>'
    + '<label class="field"><span class="field__label">Port</span><span class="field__box"><input name="port" type="number" value="25565" min="1" max="65535" /></span></label>'
    + '<label class="field"><span class="field__label">Version</span><span class="field__box"><input name="version" value="1.20.1" /></span></label>'
    + '</div>'
    + '<label class="field"><span class="field__label">Minecraft password</span><span class="field__box"><input name="password" type="password" value="Sandun123" /></span></label>'
    + '<div class="modal-toggles">'
    + '<label class="check"><input type="checkbox" name="autoLogin" checked /> Auto-login</label>'
    + '<label class="check"><input type="checkbox" name="autoReconnect" checked /> Auto-reconnect</label>'
    + '<label class="check"><input type="checkbox" name="antiAfk" checked /> Anti-AFK</label>'
    + '<label class="check"><input type="checkbox" name="autoEat" checked /> Auto-eat</label>'
    + '</div>'
    + '<p id="add-bot-error" class="login__error" hidden></p>'
    + '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-close="1">Cancel</button><button class="btn btn-primary" type="submit">' + icon('plus') + '<span>Add bot</span></button></div>'
    + '</form></div>';
  const first = root.querySelector('input[name="name"]');
  if (first) setTimeout(() => { try { first.focus(); } catch (e) {} }, 40);
}
function closeModal() { const root = $('#modal-root'); if (!root) return; root.hidden = true; root.innerHTML = ''; }
async function submitAddBot(form) {
  const err = $('#add-bot-error');
  const fd = new FormData(form);
  const cfg = {
    name: String(fd.get('name') || '').trim(),
    host: String(fd.get('host') || '').trim(),
    port: Number(fd.get('port') || 25565),
    version: String(fd.get('version') || '1.20.1').trim(),
    password: String(fd.get('password') || 'Sandun123'),
    autoLogin: fd.get('autoLogin') === 'on',
    autoReconnect: fd.get('autoReconnect') === 'on',
    antiAfk: fd.get('antiAfk') === 'on',
    autoEat: fd.get('autoEat') === 'on',
    desiredOn: true,
  };
  if (err) { err.textContent = ''; err.setAttribute('hidden', ''); }
  try {
    await api('/api/bots', { method: 'POST', body: JSON.stringify(cfg) });
    closeModal();
    toast('ok', 'Bot added', cfg.name + ' is connecting…');
    const d = await api('/api/state');
    state.bots = Array.isArray(d.bots) ? d.bots : [];
    state.stats = d.stats || {};
    renderAll();
  } catch (e) { if (err) { err.textContent = e.message; err.removeAttribute('hidden'); } }
}

/* ── login ── */
async function handleLogin(e) {
  e.preventDefault();
  const form = e.target;
  const input = form.querySelector('input');
  const err = $('#login-error');
  const btn = $('#login-submit');
  if (!input || !btn) return;
  const password = input.value;
  if (!password) { if (err) { err.textContent = 'Enter the dashboard password.'; err.removeAttribute('hidden'); } input.focus(); return; }
  if (err) { err.textContent = ''; err.setAttribute('hidden', ''); }
  btn.disabled = true;
  const idle = btn.innerHTML;
  btn.innerHTML = '<svg class="ico spin"><use href="#i-restart"></use></svg><span>Signing in…</span>';
  try {
    const res = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Wrong password.');
    input.value = '';
    await enterApp();
  } catch (ex) {
    if (err) { err.textContent = ex.message || 'Sign in failed.'; err.removeAttribute('hidden'); }
  } finally { btn.disabled = false; btn.innerHTML = idle; }
}

/* ── boot ── */
async function boot() { try { const res = await fetch('/api/auth', { credentials: 'same-origin' }); const data = await res.json(); if (data.authenticated) await enterApp(); else showLogin(); } catch (e) { showLogin(); } }
function init() {
  const loginForm = $('#login-form'); if (loginForm) loginForm.addEventListener('submit', handleLogin);  const loginEye = $('#login-eye');
  if (loginEye) loginEye.addEventListener('click', () => {
    const inp = $('#login-password'); if (!inp) return;
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    loginEye.innerHTML = icon(show ? 'eye-off' : 'eye');
  });
  const addBtn = $('#add-bot-btn'); if (addBtn) addBtn.addEventListener('click', openAddBot);
  const master = $('#master-toggle'); if (master) master.addEventListener('click', toggleMaster);
  const topbarPower = $('#topbar-power'); if (topbarPower) topbarPower.addEventListener('click', toggleMaster);
  const logoutBtn = $('#logout-btn'); if (logoutBtn) logoutBtn.addEventListener('click', doLogout);

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.matches || !t.matches('[data-search]')) return;
    state.query = t.value;
    $$('[data-search]').forEach((o) => { if (o !== t) o.value = t.value; });
    if (state.view === 'dashboard') updateGrid();
  });

  document.addEventListener('click', (e) => {
    const t = e.target; if (!t || !t.closest) return;
    if (t.closest('[data-close]')) { e.preventDefault(); closeModal(); return; }
    const chip = t.closest('.chip'); if (chip) { e.preventDefault(); state.filter = chip.getAttribute('data-filter'); updateGrid(); return; }
    const scrollTo = t.closest('[data-bp-scroll]');
    if (scrollTo) {
      e.preventDefault();
      scrollToSection(scrollTo.getAttribute('data-bp-scroll'));
      return;
    }
    const nav = t.closest('[data-view]'); if (nav) { e.preventDefault(); switchView(nav.getAttribute('data-view')); return; }
    const action = t.closest('[data-action]');
    if (action) { e.preventDefault(); handleAction(action.getAttribute('data-action'), action); }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || t.id !== 'px-max') return;
    const v = Math.max(1, Math.min(50, parseInt(t.value, 10) || 5));
    t.value = v;
    api('/api/proxies', { method: 'POST', body: { maxPerIp: v } })
      .then((d) => { state.proxy = d; patchProxies(); toast('ok', 'Max per IP', 'Now ' + v + ' bots per address.'); })
      .catch((err) => toast('err', 'Failed', err.message));
  });

  document.addEventListener('submit', (e) => {
    if (!e.target) return;
    if (e.target.id === 'bot-command-form') { e.preventDefault(); submitBotCommand(e.target); }
    else if (e.target.id === 'add-bot-form') { e.preventDefault(); submitAddBot(e.target); }
    else if (e.target.id === 'fleet-form') { e.preventDefault(); submitFleetSetup(e.target); }
    else if (e.target.id === 'confirm-form') { e.preventDefault(); const fn = state._confirmSubmit; state._confirmSubmit = null; closeModal(); if (fn) fn().catch((err) => toast('err', 'Remove failed', err.message)); }
  });

  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.closest('.bot-avatar, .pcard__skin, .board__av, .podium__av, .slot, .mini-slot, .mc-slot, .pxbot__av')) t.classList.add('is-missing');
  }, true);

  const releaseTabLock = () => { state._tabLock = 0; state._tabTarget = null; };
  window.addEventListener('wheel', releaseTabLock, { passive: true });
  window.addEventListener('touchstart', releaseTabLock, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { const m = $('#modal-root'); if (m && !m.hidden) { closeModal(); return; } }
    if (e.key === '/' && state.authed) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
      e.preventDefault();
      const s = $('#search-input') || $('[data-search]');
      if (s) s.focus();
    }
  });

  window.addEventListener('popstate', () => applyRoute());
  window.addEventListener('hashchange', () => applyRoute());
  window.addEventListener('scroll', () => {
    const bar = document.querySelector('#view .bp-progress i'); if (!bar) return;
    const max = Math.max(document.documentElement.scrollHeight - window.innerHeight, 0);
    const y = Math.min(Math.max(window.scrollY || 0, 0), max);
    bar.style.width = max > 0 ? (y / max * 100) + '%' : '0%';
  }, { passive: true });
}

window.MCBot = { state: state, getStats: getStats, renderView: renderView, switchView: switchView, applyRoute: applyRoute, findBot: findBot, api: api, enterApp: enterApp, showLogin: showLogin, toggleMaster: toggleMaster, handleAction: handleAction, renderBotConsole: renderBotConsole, renderBotInventory: renderBotInventory, submitBotCommand: submitBotCommand, toast: toast, fmtDuration: fmtDuration, statusMeta: statusMeta };
init();
boot();
