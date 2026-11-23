'use strict';
/* MCBot Control — fresh core panel: dashboard + bot page (console / inventory / player) */

document.documentElement.classList.add('js');

const $  = (sel, root = document) => (root || document).querySelector(sel);
const $$ = (sel, root = document) => Array.from((root || document).querySelectorAll(sel));
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls = 'ico') => '<svg class="' + cls + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
const fmtClock = (t) => new Date(t).toLocaleTimeString('en-GB', { hour12: false });
const fmtRelative = (t) => {
  const diff = Math.max(0, Date.now() - Number(t || 0));
  if (diff < 10000) return 'just now';
  if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
};
const fmtDuration = (ms) => {
  const s = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + (s % 60) + 's';
  return s + 's';
};
const statusMeta = (bot) => ({
  online: { label: 'Online', pill: 'pill--online', dot: 'online' },
  connecting: { label: 'Connecting', pill: 'pill--connecting', dot: 'connecting' },
  reconnecting: { label: 'Retrying', pill: 'pill--connecting', dot: 'connecting' },
  error: { label: 'Error', pill: 'pill--error', dot: 'error' },
  stopped: { label: 'Stopped', pill: 'pill--stopped', dot: 'stopped' },
  offline: { label: 'Offline', pill: 'pill--offline', dot: 'stopped' },
})[bot && bot.status] || { label: 'Offline', pill: 'pill--offline', dot: 'stopped' };
const isActive = (bot) => !!bot && ['online', 'connecting', 'reconnecting'].includes(bot.status);
const findBot = (id) => (state.bots || []).find((b) => b.id === id) || null;
const initial = (name) => String(name || '?').trim().charAt(0).toUpperCase() || '?';
const hashHue = (name) => {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
};
const serverKey = (b) => b.host + ':' + b.port;
const serverLabel = (b) => b.host + ':' + b.port;
const uniquePlayers = (bots) => {
  const m = new Map();
  (bots || []).forEach((b) => { if (b.status === 'online') { const k = serverKey(b); m.set(k, Math.max(m.get(k) || 0, b.players || 0)); } });
  let n = 0;
  m.forEach((v) => { n += v; });
  return n;
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
  const list = (state.bots || []).filter((b) => {
    if (state.filter !== 'all') { const act = isActive(b); if (state.filter === 'online' ? !act : act) return false; }
    if (!q) return true;
    return (b.name + ' ' + b.host + ':' + b.port).toLowerCase().includes(q);
  });
  return list;
}

/* ── item icons ── */
function assetVersion(version) { return /^\d+\.\d+(\.\d+)?$/.test(String(version || '')) ? version : '1.20.1'; }
function itemIconUrl(name, version) { return '/api/icon/' + encodeURIComponent(assetVersion(version)) + '/' + encodeURIComponent(name) + '.png'; }
function itemImgHtml(item, version, cls) {
  cls = cls || 'slot__img';
  if (!item || !item.name) return '';
  return '<img class="' + cls + '" src="' + itemIconUrl(item.name, version) + '" alt="' + esc(item.displayName || item.name) + '" loading="lazy" decoding="async" />';
}
function itemTipText(item) {
  if (!item) return '';
  const bits = [item.displayName || item.name];
  if (item.count > 1) bits.push('x' + item.count);
  if (item.maxDurability && item.durabilityUsed) bits.push(Math.max(0, item.maxDurability - item.durabilityUsed) + '/' + item.maxDurability + ' dur');
  (item.enchants || []).forEach((e) => bits.push(e.name + ' ' + e.lvl));
  return bits.join(' · ');
}
function invStripSig(bot) {
  const items = Array.isArray(bot.inventoryPreview) ? bot.inventoryPreview : [];
  return items.map((it) => (it ? it.name + 'x' + it.count : '-')).join(',') + '|' + (bot.inventoryUsed || 0) + '|' + bot.status + '|' + (bot.version || '');
}
function vitalsSig(bot) {
  const p = bot.position;
  return [bot.status, bot.health, bot.food, bot.autoEat, p ? p.x + ',' + p.y + ',' + p.z : ''].join('|');
}
function gearSig(bot) {
  const enc = (it) => (it ? it.name + 'x' + it.count : '-');
  const armor = Array.isArray(bot.armor) ? bot.armor : [null, null, null, null];
  return [enc(bot.heldItem)].concat(armor.map(enc), [enc(bot.offhand), bot.version || '']).join('|');
}
function setSigHtml(el, sig, html) {
  if (!el) return;
  if (el.getAttribute('data-sig') === sig) return;
  el.setAttribute('data-sig', sig);
  el.innerHTML = html;
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
  live: 'connecting',
  sse: null,
  lastEventAt: 0,
  tick: null,
  sseWatch: null,
};

/* ── api ── */
async function api(path, opts) {
  opts = opts || {};
  const options = { credentials: 'same-origin' };
  if (opts.body) { options.method = opts.method || 'POST'; options.headers = { 'Content-Type': 'application/json' }; options.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body); }
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
  document.body.classList.remove('is-locked');
  document.title = 'Dashboard · MCBot Control';
  renderAll();
  try {
    const data = await api('/api/state');
    state.bots = Array.isArray(data.bots) ? data.bots : [];
    state.stats = data.stats || {};
    state.loading = false;
    renderAll();
    connectSSE();
    startTick();
    applyRoute();
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
  es.onopen = () => { bumpSse(); resync(); };
  wrap('bot', (d) => onBot(d.bot));
  wrap('stats', (d) => onStats(d));
  wrap('log', (d) => onLog(d));
  wrap('removed', (d) => { if (d && d.id) { state.bots = state.bots.filter((b) => b.id !== d.id); renderAll(); } });
  es.addEventListener('ping', () => bumpSse());
  es.addEventListener('hello', () => { bumpSse(); resync(); });
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
function setLive(mode) { state.live = mode; const pill = $('#live-pill'); if (!pill) return; pill.dataset.state = mode; const label = pill.querySelector('span'); if (label) label.textContent = mode === 'live' ? 'Live' : (mode === 'connecting' ? 'Connecting' : 'Reconnecting'); }
function scheduleReconnect(delay) { setLive('offline'); setTimeout(() => { if (!state.authed) return; connectSSE(); }, delay || 1500); }
function resync() { api('/api/state').then((d) => { state.bots = Array.isArray(d.bots) ? d.bots : []; state.stats = d.stats || {}; renderAll(); }).catch(() => {}); }

/* ── live events ── */
function onBot(bot) {
  if (!bot) return;
  const i = state.bots.findIndex((b) => b.id === bot.id);
  if (i >= 0) state.bots[i] = bot; else state.bots.push(bot);
  renderSidebar();
  if (state.view === 'bot' && state.botId === bot.id) patchBotPage(bot);
  else if (state.view === 'dashboard') patchBotCard(bot);
}
function onLog(d) { if (!d || !d.id || !d.entry) return; if (!state.logs.has(d.id)) state.logs.set(d.id, []); const arr = state.logs.get(d.id); arr.push(d.entry); if (arr.length > 400) state.logs.set(d.id, arr.slice(-400)); if (state.view === 'bot' && state.botId === d.id) renderBotConsole(); }
function onStats(d) { if (d && d.stats) state.stats = d.stats; renderSidebar(); }
/* ── rendering: chrome ── */
function updateChrome() {
  const isBot = state.view === 'bot';
  $('#page-title').textContent = isBot ? 'Bot profile' : 'Dashboard';
  $('#page-sub').textContent = isBot ? 'Live console, inventory and player panel.' : 'Everything your bots are doing, at a glance.';
  document.title = (isBot ? 'Bot profile · ' : 'Dashboard · ') + 'MCBot Control';
  $$('.nav__item[data-view], .mobilenav__item[data-view]').forEach((el) => el.classList.toggle('is-active', el.dataset.view === state.view));
}
function renderSidebar() {
  const stats = getStats();
  const sig = [stats.masterOn, stats.online, stats.connecting, stats.servers].join('|');
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
  const powerState = $('#power-state'); if (powerState) powerState.textContent = stats.masterOn ? stats.online + ' online · ' + stats.connecting + ' connecting' : 'All systems idle';
  const count = $('#nav-servers-count'); if (count) count.textContent = String(stats.servers);
}
function renderAll() { updateChrome(); renderView(); renderSidebar(); }

/* ── rendering: dashboard pieces ── */
function statsHtml() {
  const s = getStats();
  const cards = [
    { icon: 'zap', value: s.online, label: 'Bots online', hint: s.connecting ? s.connecting + ' connecting' : 'All systems go', cls: 'stat--lime' },
    { icon: 'cube', value: s.total, label: 'Total bots', hint: 'Unlimited bots', cls: 'stat--blue' },
    { icon: 'server', value: s.servers, label: 'Servers', hint: 'unique endpoints', cls: 'stat--coral' },
    { icon: 'users', value: s.players, label: 'Players online', hint: 'seen by your bots', cls: 'stat--mint' },
  ];
  let cardsHtml = '';
  cards.forEach((c) => { cardsHtml += '<div class="stat ' + c.cls + '"><span class="stat__icon">' + icon(c.icon) + '</span><div><div class="stat__value">' + c.value + '</div><div class="stat__label">' + c.label + '</div><div class="stat__hint">' + c.hint + '</div></div></div>'; });
  return '<div class="stats">' + cardsHtml + '</div>';
}
function serverPulseHtml() {
  const bots = state.bots || [];
  if (!bots.length) return '';
  const map = new Map();
  bots.forEach((b) => {
    const key = serverKey(b);
    const rec = map.get(key) || { key: key, host: b.host, port: b.port, hue: hashHue(key), bots: 0, online: 0, players: 0 };
    rec.bots += 1;
    if (b.status === 'online') { rec.online += 1; rec.players = Math.max(rec.players, b.players || 0); }
    map.set(key, rec);
  });
  let pills = '';
  map.forEach((s) => { pills += '<span class="server-pill' + (s.online ? ' is-online' : '') + '" style="--server:' + s.hue + '"><i></i><span>' + esc(s.host) + ':' + s.port + '</span><span class="server-pill__stat">' + s.online + '/' + s.bots + ' bots</span><span class="server-pill__stat server-pill__stat--players">' + s.players + ' players</span></span>'; });
  return '<div class="server-pulse"><span class="server-pulse__label">' + icon('server') + 'Server pulse</span><div class="server-pulse__list">' + pills + '</div></div>';
}
function invStripHtml(bot) {
  const items = Array.isArray(bot.inventoryPreview) ? bot.inventoryPreview : [];
  const used = bot.inventoryUsed || 0;
  let body = '';
  if (items.length) {
    const slots = items.slice(0, 6).map((it) => {
      let extra = '';
      if (it.count > 1) extra = '<i class="mini-more">x' + it.count + '</i>';
      return '<span class="mini-slot">' + itemImgHtml(it, bot.version, 'mini-img') + extra + '</span>';
    }).join('');
    body = '<span class="bot-inv"><span class="bot-inv__slots">' + slots + '</span><span class="bot-inv__label"><svg class="ico"><use href="#i-server"></use></svg><b>' + used + '</b><span>/36</span></span></span>';
  } else {
    body = '<span class="bot-inv is-off"><span class="bot-inv__empty"><svg class="ico"><use href="#i-server"></use></svg><span>' + (bot.status === 'online' ? 'Inventory empty' : 'Inventory offline') + '</span></span></span>';
  }
  return body;
}
function botVitals(bot) {
  if (bot.status !== 'online') return '';
  const hp = Number.isFinite(bot.health) ? Math.max(0, Math.min(20, bot.health)) : null;
  const food = Number.isFinite(bot.food) ? Math.max(0, Math.min(20, bot.food)) : null;
  const p = bot.position;
  const pos = p && Number.isFinite(p.x) ? p.x + ' ' + p.y + ' ' + p.z : '';
  if (hp === null && food === null && !pos) return '';
  let out = '<div class="bot-vitals">';
  if (hp !== null) out += '<span class="vital vital--hp" title="Health"><svg class="ico"><use href="#i-heart"></use></svg><b>' + hp + '</b></span>';
  if (food !== null) out += '<span class="vital vital--food" title="Food"><svg class="ico"><use href="#i-food"></use></svg><b>' + food + '</b></span>';
  if (bot.autoEat) out += '<span class="bot-flag" title="Auto-eat"><svg class="ico"><use href="#i-zap"></use></svg>AE</span>';
  if (pos) out += '<span class="bot-coords" title="Position"><svg class="ico"><use href="#i-pin"></use></svg>' + esc(pos) + '</span>';
  out += '</div>';
  return out;
}
function botCard(bot) {
  const st = statusMeta(bot);
  const hue = hashHue(bot.name);
  const uptime = bot.joinedAt ? fmtDuration(Date.now() - bot.joinedAt) : '—';
  const last = (bot.lastLog && bot.lastLog.text) || 'No activity yet';
  const loginLabel = bot.loggedIn ? 'Verified' : (bot.autoLogin ? 'Auto' : 'Off');
  const loginCls = bot.loggedIn ? 'good' : (bot.autoLogin ? '' : 'warn');
  const active = isActive(bot);
  let actions = '<button class="switch ' + (active ? 'is-on' : '') + '" type="button" role="switch" aria-checked="' + String(active) + '" data-action="toggle" data-id="' + esc(bot.id) + '" data-f="switch" aria-label="' + (active ? 'Stop' : 'Start') + ' ' + esc(bot.name) + '"><span class="switch__track"><span class="switch__thumb"></span></span><span class="switch__label" data-f="switch-label">' + (active ? 'On' : 'Off') + '</span></button>';
  actions += '<button class="btn btn-ghost btn-sm" data-action="console" data-id="' + esc(bot.id) + '"><svg class="ico"><use href="#i-terminal"></use></svg><span>Console</span></button>';
  actions += '<button class="icon-btn" data-action="bot-page" data-id="' + esc(bot.id) + '" title="Open full bot page" aria-label="Open ' + esc(bot.name) + ' full page"><svg class="ico"><use href="#i-arrow"></use></svg></button>';
  actions += '<button class="icon-btn" data-action="restart" data-id="' + esc(bot.id) + '" title="Restart" aria-label="Restart ' + esc(bot.name) + '"><svg class="ico"><use href="#i-restart"></use></svg></button>';
  return '<article class="bot-card' + (bot.status === 'online' ? ' is-online' : '') + '" data-bot="' + esc(bot.id) + '">'
    + '<div class="bot-card__top">'
    + '<button class="bot-avatar" type="button" data-action="bot-page" data-id="' + esc(bot.id) + '" style="--hue:' + hue + '" title="Open ' + esc(bot.name) + ' full profile"><span class="avatar-initial">' + esc(initial(bot.name)) + '</span><img src="/api/skin/' + encodeURIComponent(bot.name) + '?kind=head&size=64" alt="" loading="lazy" decoding="async" /><span class="status-dot ' + st.dot + '" data-f="dot"></span></button>'
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
    + '<div class="bot-actions">' + actions + '</div>'
    + '</article>';
}
function patchBotCard(bot) {
  const card = document.querySelector('[data-bot="' + bot.id + '"]');
  if (!card) return;
  const st = statusMeta(bot);
  const active = isActive(bot);
  const pill = card.querySelector('[data-f="pill"]');
  if (pill) { const cls = 'pill ' + st.pill; if (pill.className !== cls) pill.className = cls; if (pill.innerHTML !== '<i></i>' + st.label) pill.innerHTML = '<i></i>' + st.label; }
  const dot = card.querySelector('[data-f="dot"]');
  if (dot) { const cls = 'status-dot ' + st.dot; if (dot.className !== cls) dot.className = cls; }
  const sw = card.querySelector('[data-f="switch"]');
  if (sw) {
    const on = sw.classList.contains('is-on');
    if (on !== active) sw.classList.toggle('is-on', active);
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
  const vit = card.querySelector('[data-f="vitals"]');
  if (vit) setSigHtml(vit, vitalsSig(bot), botVitals(bot) || '');
  const inv = card.querySelector('[data-f="inv"]');
  if (inv) setSigHtml(inv, invStripSig(bot), invStripHtml(bot));
  const last = card.querySelector('[data-f="last"]');
  if (last) { const t = (bot.lastLog && bot.lastLog.text) || 'No activity yet'; if (last.textContent !== t) { last.textContent = t; last.title = t; } }
  const up = card.querySelector('[data-uptime]');
  if (up) { const val = bot.joinedAt || ''; if (up.getAttribute('data-uptime') !== String(val)) up.setAttribute('data-uptime', val); }
}
function emptyState() {
  return '<div class="empty"><div class="empty__art">' + icon('cube') + '</div><h3>No bots yet</h3><p>Add your first Minecraft bot — name, server IP and password. Auto-login and server switching are handled for you.</p><button class="btn btn-primary" data-action="add"><svg class="ico"><use href="#i-plus"></use></svg><span>Add your first bot</span></button></div>';
}
function noResults() { return '<div class="no-results">No bots match this search or filter. Try a different name, IP or status.</div>'; }
function fleetHtml(title, sub) {
  const s = getStats();
  let bars = '';
  for (let i = 0; i < 26; i++) { bars += '<i style="--h:' + (18 + ((i * 37) % 74)) + '%"></i>'; }
  const tickerItems = (state.bots || []).slice(0, 8).map((b) => '<span class="ticker__item"><b>' + esc(b.name) + '</b>' + esc(String((b.lastLog && b.lastLog.text) || '').slice(0, 90)) + '</span>').join('');
  const ticker = tickerItems ? tickerItems : '<span class="ticker__item"><b>Waiting</b>for the first event…</span>';
  return '<section class="fleet">'
    + '<div class="fleet__head">'
    + '<div class="fleet__copy"><span class="fleet__eyebrow">' + icon('zap') + 'Fleet control</span><h2>' + esc(title) + '</h2><p>' + esc(sub) + '</p></div>'
    + '<div class="fleet__actions"><button class="btn btn-ghost" data-action="refresh">' + icon('restart') + '<span>Refresh</span></button><button class="btn btn-primary" data-action="add">' + icon('plus') + '<span>Add bot</span></button></div>'
    + '</div>'
    + '<div class="fleet__deck">'
    + '<div class="metric metric--lime"><span>' + icon('zap') + 'Bots online</span><b>' + s.online + '</b><em>of ' + s.total + '</em></div>'
    + '<div class="metric metric--blue"><span>' + icon('server') + 'Servers</span><b>' + s.servers + '</b><em>' + s.total + ' bots</em></div>'
    + '<div class="metric metric--coral"><span>' + icon('users') + 'Players</span><b>' + s.players + '</b><em>unique</em></div>'
    + '<div class="metric metric--mint"><span>' + icon('clock') + 'Avg uptime</span><b>—</b><em>' + s.connecting + ' connecting</em></div>'
    + '<div class="fleet__wave" aria-hidden="true"><span>signal</span><div class="wave">' + bars + '</div></div>'
    + '<div class="fleet__health"><span class="fleet__health-dot"></span><div><b>' + (s.masterOn ? 'Streaming' : 'Idle') + '</b><em>live socket</em></div></div>'
    + '</div>'
    + '<div class="ticker"><span class="ticker__tag">' + icon('zap') + 'Live</span><div class="ticker__viewport"><div class="ticker__track">' + ticker + '</div></div></div>'
    + '</section>';
}
function dashboardHtml() {
  const s = getStats();
  const bots = filteredBots();
  const title = s.total === 0 ? 'Let’s get your first bot online.' : s.online > 0 ? 'Your bots are live.' : 'Your bots are ready when you are.';
  const sub = s.total === 0 ? 'Add a server, drop in the password, and the bot will log in and stay connected for you.' : s.online + ' online · ' + s.connecting + ' connecting · ' + s.servers + ' server' + (s.servers === 1 ? '' : 's') + ' under control.';
  let grid = '';
  if (bots.length) { bots.forEach((b) => { grid += botCard(b) + '\n'; }); grid = '<div class="bot-grid">' + grid + '</div>'; }
  else if (state.bots.length) grid = noResults(); else grid = emptyState();
  return '<div class="page-head"><div class="page-head__text"><span class="eyebrow">Control</span><h2>Live fleet</h2><p>' + esc(sub) + '</p></div><div class="page-head__actions"><div class="chips">'
    + '<button class="chip ' + (state.filter === 'all' ? 'is-active' : '') + '" data-filter="all">All</button>'
    + '<button class="chip ' + (state.filter === 'online' ? 'is-active' : '') + '" data-filter="online">Online</button>'
    + '<button class="chip ' + (state.filter === 'offline' ? 'is-active' : '') + '" data-filter="offline">Offline</button>'
    + '</div></div></div>'
    + statsHtml()
    + serverPulseHtml()
    + fleetHtml(title, sub)
    + '<div class="section-head"><div class="section-head__title"><h3>Your bots</h3><span class="section-head__count">' + bots.length + ' of ' + state.bots.length + '</span></div></div>'
    + grid;
}
/* ── rendering: views ── */
function renderView() {
  const progress = '<div class="bp-progress" aria-hidden="true"><i></i></div>';
  if (state.view === 'bot') $('#view').innerHTML = progress + botPageHtml();
  else if (state.view === 'servers') $('#view').innerHTML = progress + serversHtml();
  else { $('#view').innerHTML = progress + dashboardHtml(); bindTilt($('.fleet__deck')); }
}
function updateUptimes() { $$('[data-uptime]').forEach((el) => { const t = Number(el.getAttribute('data-uptime') || 0); el.textContent = t ? fmtDuration(Date.now() - t) : '—'; }); }
function switchView(view, push) {
  if (push === undefined) push = true;
  if (view !== 'dashboard' && view !== 'servers' && view !== 'bot') return;
  if (state.view === view) { state.unread = false; return; }
  state.view = view;
  updateChrome();
  renderView();
  renderSidebar();
  if (push) history.pushState({}, '', view === 'bot' ? '#/bot/' + state.botId : '#/' + view);
  if (view === 'bot') { loadBotLogs(state.botId); loadBotInventory(state.botId); }
  if (window.innerWidth <= 1080) window.scrollTo(0, 0);
}
function applyRoute() {
  const raw = String(location.hash || '').replace(/^#\/?/, '');
  const parts = raw.split('/');
  if (parts[0] === 'bot' && parts[1]) { state.view = 'bot'; state.botId = parts[1]; }
  else { state.view = 'dashboard'; state.botId = null; }
  state.loading = false;
  updateChrome();
  renderView();
  renderSidebar();
}

/* ── events wiring ── */
function bindTilt(el, max) { max = max == null ? 3 : max; if (!el || el.getAttribute('data-tilt')) return; el.setAttribute('data-tilt', '1'); if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return; el.addEventListener('pointermove', (e) => { const r = el.getBoundingClientRect(); const x = (e.clientX - r.left) / (r.width || 1) - 0.5; const y = (e.clientY - r.top) / (r.height || 1) - 0.5; el.style.transform = 'perspective(1100px) rotateX(' + (-y * max).toFixed(2) + 'deg) rotateY(' + (x * max).toFixed(2) + 'deg)'; }); el.addEventListener('pointerleave', () => { el.style.transform = ''; }); }
function bindEvents() {
  const loginForm = $('#login-form');
  if (loginForm) loginForm.addEventListener('submit', handleLogin);
  const addBtn = $('#add-bot-btn');
  if (addBtn) addBtn.addEventListener('click', () => switchView('dashboard'));
  const master = $('#master-toggle');
  if (master) master.addEventListener('click', toggleMaster);
  const topbarPower = $('#topbar-power');
  if (topbarPower) topbarPower.addEventListener('click', toggleMaster);
  const logoutBtn = $('#logout-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', doLogout);
  const search = $('#search-input');
  if (search) search.addEventListener('input', (e) => { state.query = e.target.value; renderView(); });
  const chips = document.querySelectorAll('.chip[data-filter]');
  chips.forEach((chip) => chip.addEventListener('click', () => { state.filter = chip.getAttribute('data-filter'); renderView(); }));
  document.addEventListener('click', (e) => {
    const scrollTo = e.target && e.target.closest ? e.target.closest('[data-bp-scroll]') : null;
    if (scrollTo) { e.preventDefault(); const el = document.getElementById(scrollTo.getAttribute('data-bp-scroll')); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const nav = e.target && e.target.closest ? e.target.closest('[data-view]') : null;
    if (nav) { e.preventDefault(); switchView(nav.getAttribute('data-view')); return; }
    const action = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (action) { e.preventDefault(); handleAction(action.getAttribute('data-action'), action); }
  });
  document.addEventListener('submit', (e) => { if (e.target && e.target.id === 'bot-command-form') { e.preventDefault(); submitBotCommand(e.target); } });
  document.addEventListener('keydown', (e) => { if (e.key === '/' && state.authed) { const tag = (e.target.tagName || '').toLowerCase(); if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return; e.preventDefault(); const s = $('#search-input'); if (s) s.focus(); } });
  window.addEventListener('popstate', () => applyRoute());
  window.addEventListener('scroll', () => { const bar = document.querySelector('#view .bp-progress i'); if (!bar) return; const max = Math.max(document.documentElement.scrollHeight - window.innerHeight, 0); const y = Math.min(Math.max(window.scrollY || 0, 0), max); bar.style.width = max > 0 ? (y / max * 100) + '%' : '0%'; });
}
function toggleMaster() { const on = !(state.stats && typeof state.stats.masterOn === 'boolean' ? state.stats.masterOn : getStats().masterOn); api('/api/master', { method: 'POST', body: JSON.stringify({ on: on }) }).then(() => { renderAll(); }).catch((e) => { toast('err', 'Master power', e.message); }); }
function handleAction(action, el) {
  const id = el ? el.getAttribute('data-id') : null;
  const act = () => {
    if (action === 'toggle' && id) { const bot = findBot(id); const stop = !bot || bot.status === 'online'; return api('/api/bots/' + id + '/' + (stop ? 'stop' : 'start'), { method: 'POST', body: JSON.stringify({}) }).then(() => { renderAll(); }).catch((e) => { toast('err', 'Action failed', e.message); }); }
    if (action === 'restart' && id) { return api('/api/bots/' + id + '/restart', { method: 'POST', body: JSON.stringify({}) }).then(() => { renderAll(); }).catch((e) => { toast('err', 'Action failed', e.message); }); }
    if (action === 'auto-eat' && id) { return api('/api/bots/' + id + '/auto-eat', { method: 'POST', body: JSON.stringify({}) }).then(() => { renderAll(); }).catch((e) => { toast('err', 'Action failed', e.message); }); }
    if (action === 'console' && id) { state.botId = id; switchView('bot'); return Promise.resolve(); };
    if (action === 'bot-page' && id) { state.botId = id; switchView('bot'); return Promise.resolve(); };
    if (action === 'add') { openAddBot(); return Promise.resolve(); };
    if (action === 'refresh') { return api('/api/state').then((d) => { state.bots = Array.isArray(d.bots) ? d.bots : []; state.stats = d.stats || {}; renderAll(); }).catch((e) => { toast('err', 'Refresh failed', e.message); }); };
    return Promise.resolve();
  };
  return act().catch((e) => { toast('err', 'Action failed', e.message); });
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
async function submitBotCommand(form) { const id = form.getAttribute('data-id'); const input = form.querySelector('input'); const message = String((input && input.value) || '').trim(); if (!id || !message) return; try { await api('/api/bots/' + id + '/chat', { method: 'POST', body: JSON.stringify({ message: message }) }); input.value = ''; toast('ok', 'Sent', message); } catch (e) { toast('err', 'Send failed', e.message); } }

/* ── bot console ── */
function botLogs(id) { return state.logs.get(id) || []; }
function renderBotConsole() {
  const box = $('#bp-console-lines'); if (!box) return;
  const logs = botLogs(state.botId).slice(-80);
  let html = '';
  if (logs.length) { logs.forEach((e) => { html += '<div class="console-line kind-' + esc(e.kind || 'chat') + '"><time>' + fmtClock(e.t) + '</time><span class="console-kind">' + esc(e.kind || 'chat') + '</span><p>' + esc(e.text) + '</p></div>'; }); }
  else html = '<div class="console-empty">' + icon('terminal') + '<span>Console is quiet</span></div>';
  box.innerHTML = html;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  if (nearBottom) box.scrollTop = box.scrollHeight;
}
async function loadBotLogs(id) { try { const d = await api('/api/bots/' + id + '/logs'); state.logs.set(id, Array.isArray(d.logs) ? d.logs : []); if (state.view === 'bot' && state.botId === id) renderBotConsole(); } catch (e) {} }
function renderBotConsoleFromEntry(e) { if (state.view === 'bot' && state.botId) { if (!state.logs.has(state.botId)) state.logs.set(state.botId, []); state.logs.get(state.botId).push(e); renderBotConsole(); } }

/* ── bot inventory ── */
function renderBotInventory() {
  const root = $('#bp-inv-root'); if (!root) return;
  const inv = state.invs.get(state.botId) || null;
  if (!inv) { root.innerHTML = '<div class="console-empty">' + icon('server') + '<span>Reading inventory…</span></div>'; return; }
  const version = (findBot(state.botId) || {}).version || '1.20.1';
  const slotHtml = (it, selected) => { let cls = 'slot'; if (!it) cls += ' is-empty'; if (selected) cls += ' is-selected'; let inner = itemImgHtml(it, version) + (it && it.count > 1 ? '<i class="slot__count">x' + it.count + '</i>' : ''); return '<div class="' + cls + '">' + inner + '</div>'; };
  const craftGrid = (arr) => '<div class="inv-craft__grid">' + (arr || []).map((it, i) => slotHtml(it, i === 0)).join('') + '</div>';
  let html = '<div class="inv"><div class="inv__side">'
    + '<div class="inv-block"><div class="inv-block__label">Crafting</div><div class="inv-craft"><div class="inv-craft__grid">' + craftGrid(inv.craft) + '</div><div class="inv-craft__result">' + slotHtml(inv.craftResult, true) + '</div></div></div>'
    + '<div class="inv-block"><div class="inv-block__label">Armour</div><div class="inv-armor">' + (inv.armor || []).map((it, i) => slotHtml(it, false)).join('') + '</div></div>'
    + '<div class="inv-block"><div class="inv-block__label">Off-hand</div><div class="inv-block__off">' + slotHtml(inv.offhand, false) + '</div></div>'
    + '</div><div class="inv__main">'
    + '<div class="inv-block__label">Hotbar · selected ' + (inv.selected || 0) + '</div>'
    + '<div class="inv-grid inv-grid--hotbar">' + (inv.hotbar || []).map((it, i) => slotHtml(it, i === (inv.selected || 0))).join('') + '</div>'
    + '<div class="inv-block__label">Storage</div>'
    + '<div class="inv-grid inv-grid--storage">' + (inv.main || []).map((it, i) => slotHtml(it, false)).join('') + '</div>'
    + '</div></div>';
  root.innerHTML = html;
}
async function loadBotInventory(id) { try { const d = await api('/api/bots/' + id + '/inventory'); if (d && d.inventory) state.invs.set(id, d.inventory); if (state.view === 'bot' && state.botId === id) renderBotInventory(); } catch (e) {} }

/* ── bot page html ── */
function gearHtml(bot) {
  const version = bot.version || '1.20.1';
  const armor = Array.isArray(bot.armor) ? bot.armor : [null, null, null, null];
  const armorLabels = ['Helmet', 'Chestplate', 'Leggings', 'Boots'];
  let gear = '<div class="player-gear">'
    + '<div class="player-gear__slot"><span>Held</span><div class="slot">' + itemImgHtml(bot.heldItem || null, version) + '</div></div>';
  for (let i = 0; i < 4; i++) gear += '<div class="player-gear__slot"><span>' + armorLabels[i] + '</span><div class="slot">' + itemImgHtml(armor[i], version) + '</div></div>';
  gear += '<div class="player-gear__slot"><span>Off-hand</span><div class="slot">' + itemImgHtml(bot.offhand || null, version) + '</div></div></div>';
  return gear;
}
function botPageHtml() {
  const bot = (state.bots || []).find((b) => b.id === state.botId) || (state.bots || [])[0];
  if (!bot) { return emptyState(); }
  const st = statusMeta(bot);
  const d = bot.detail || {};
  const xp = (d && d.xp) || { level: 0, points: 0 };
  const hp = Number.isFinite(bot.health) ? Math.max(0, Math.min(20, bot.health)) : 0;
  const food = Number.isFinite(bot.food) ? Math.max(0, Math.min(20, bot.food)) : 0;
  const pos = bot.position ? bot.position.x + ' ' + bot.position.y + ' ' + bot.position.z : '—';
  const metrics = [
    { key: 'health', icon: 'heart', label: 'Health', value: hp + '/20', bad: hp <= 6 },
    { key: 'food', icon: 'food', label: 'Food', value: food + '/20', warn: food <= 6 },
    { key: 'ping', icon: 'wifi', label: 'Ping', value: bot.ping == null ? '—' : bot.ping + ' ms' },
    { key: 'players', icon: 'users', label: 'Players', value: bot.players == null ? '—' : String(bot.players) },
    { key: 'uptime', icon: 'clock', label: 'Uptime', value: bot.joinedAt ? fmtDuration(Date.now() - bot.joinedAt) : '—', uptime: bot.joinedAt || '' },
    { key: 'xp', icon: 'zap', label: 'XP', value: String(xp.level || 0) },
  ];
  let metricsHtml = '';
  metrics.forEach((m) => {
    metricsHtml += '<div class="bp-metric' + (m.bad ? ' is-bad' : (m.warn ? ' is-warn' : '')) + '" data-f="metric-' + m.key + '"><span>' + icon(m.icon) + ' ' + m.label + '</span><b data-f="m-' + m.key + '"' + (m.key === 'uptime' ? ' data-uptime="' + m.uptime + '"' : '') + '>' + m.value + '</b><em>' + m.label + '</em></div>';
  });
  const kv = [
    { key: 'pos', label: 'Position', value: pos },
    { key: 'dim', label: 'Dimension', value: d.dimension || '—' },
    { key: 'difficulty', label: 'Difficulty', value: d.difficulty || '—' },
    { key: 'brand', label: 'Server brand', value: d.serverBrand || '—' },
    { key: 'gamemode', label: 'Gamemode', value: d.gamemode || '—' },
    { key: 'uuid', label: 'UUID', value: d.uuid ? String(d.uuid).slice(0, 8) + '…' : '—' },
    { key: 'effects', label: 'Effects', value: d.effects && d.effects.length ? d.effects.map((e) => e.name || e.type).join(', ') : 'None' },
    { key: 'xplevel', label: 'XP level', value: String(xp.level || 0) },
  ];
  let kvHtml = '';
  kv.forEach((k) => { kvHtml += '<div><span>' + esc(k.label) + '</span><b data-f="kv-' + k.key + '">' + esc(k.value) + '</b></div>'; });
  return '<section class="bot-hero" style="--hue:' + hashHue(bot.name) + '">'
    + '<div class="bot-hero__avatar"><span class="avatar-initial">' + esc(initial(bot.name)) + '</span><img src="/api/skin/' + encodeURIComponent(bot.name) + '?kind=body&size=200" alt="" loading="lazy" decoding="async" /><span class="status-dot ' + st.dot + '" data-f="hero-dot"></span></div>'
    + '<div class="bot-hero__id"><span class="bot-hero__eyebrow">Bot profile</span><h2>' + esc(bot.name) + ' <span class="pill ' + st.pill + '" data-f="hero-pill"><i></i>' + st.label + '</span></h2>'
    + '<p data-f="hero-login"><i class="server-dot"></i>' + esc(bot.host) + ':' + bot.port + ' · v' + esc(bot.version) + ' · ' + (bot.loggedIn ? 'Logged in' : 'Auto login pending') + '</p>'
    + '<div class="bot-tags"><span class="ptag">' + icon('user') + ' ' + esc(d.gamemode || 'Survival') + '</span><span class="ptag">' + icon('pin') + ' ' + esc(d.dimension || 'Overworld') + '</span><span class="ptag ' + (bot.loggedIn ? 'is-good' : '') + '" data-f="hero-tag">' + icon('shield') + ' ' + (bot.loggedIn ? 'Logged in' : 'Auto login') + '</span></div>'
    + '</div>'
    + '<div class="bot-hero__actions">'
    + '<button class="btn btn-ghost btn-sm" data-bp-scroll="bp-console">' + icon('terminal') + '<span>Console</span></button>'
    + '<button class="btn btn-ghost btn-sm" data-bp-scroll="bp-inventory">' + icon('server') + '<span>Inventory</span></button>'
    + '<button class="btn btn-ghost btn-sm" data-bp-scroll="bp-player">' + icon('user') + '<span>Player</span></button>'
    + '<button class="icon-btn" data-action="restart" data-id="' + esc(bot.id) + '" title="Restart">' + icon('restart') + '</button>'
    + '</div>'
    + '</div>'
    + '<div class="bp-stats">' + metricsHtml + '</div>'
    + '<div class="sheet">'
    + '<section class="bpsec" id="bp-console">'
    + '<div class="bpsec__head"><span class="bpsec__num">01</span><h3>Console</h3><span class="bpsec__rule"></span><span class="bpsec__sub">Live output from ' + esc(bot.name) + ' — system, chat, sent and errors.</span></div>'
    + '<div class="console" id="bp-console-lines"><div class="console-empty">' + icon('terminal') + '<span>Console is quiet</span></div></div>'
    + '<form class="console-composer" id="bot-command-form" data-id="' + esc(bot.id) + '" autocomplete="off">'
    + '<input id="bot-command-input" type="text" maxlength="250" placeholder="Message or /command for ' + esc(bot.name) + '…" aria-label="Command for ' + esc(bot.name) + '" spellcheck="false" />'
    + '<button class="btn btn-primary" type="submit"><svg class="ico"><use href="#i-send"></use></svg><span>Send</span></button>'
    + '</form>'
    + '</section>'
    + '<section class="bpsec" id="bp-inventory">'
    + '<div class="bpsec__head"><span class="bpsec__num">02</span><h3>Inventory</h3><span class="bpsec__rule"></span><span class="bpsec__sub">All 36 slots — crafting, result, armour, off-hand, storage and hotbar.</span></div>'
    + '<div id="bp-inv-root"></div>'
    + '</section>'
    + '<section class="bpsec" id="bp-player">'
    + '<div class="bpsec__head"><span class="bpsec__num">03</span><h3>Player</h3><span class="bpsec__rule"></span><span class="bpsec__sub">Vitals, world state and gear of this bot.</span></div>'
    + '<div class="bp-kv">' + kvHtml + '</div>'
    + '<div data-f="gear" data-sig="' + esc(gearSig(bot)) + '">' + gearHtml(bot) + '</div>'
    + '</section>'
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
  if (login) { const html = '<i class="server-dot"></i>' + esc(bot.host) + ':' + bot.port + ' · v' + esc(bot.version) + ' · ' + (bot.loggedIn ? 'Logged in' : 'Auto login pending'); if (login.innerHTML !== html) login.innerHTML = html; }
  const tag = root.querySelector('[data-f="hero-tag"]');
  if (tag) { tag.className = 'ptag' + (bot.loggedIn ? ' is-good' : ''); const html = icon('shield') + ' ' + (bot.loggedIn ? 'Logged in' : 'Auto login'); if (tag.innerHTML !== html) tag.innerHTML = html; }
  setText('[data-f="m-health"]', hp + '/20');
  setText('[data-f="m-food"]', food + '/20');
  setText('[data-f="m-ping"]', bot.ping == null ? '—' : bot.ping + ' ms');
  setText('[data-f="m-players"]', bot.players == null ? '—' : bot.players);
  setText('[data-f="m-xp"]', xp.level || 0);
  const mh = root.querySelector('[data-f="metric-health"]'); if (mh) mh.classList.toggle('is-bad', hp <= 6);
  const mf = root.querySelector('[data-f="metric-food"]'); if (mf) mf.classList.toggle('is-warn', food <= 6);
  const up = root.querySelector('[data-f="m-uptime"]'); if (up) up.setAttribute('data-uptime', bot.joinedAt || '');
  setText('[data-f="kv-pos"]', bot.position ? bot.position.x + ' ' + bot.position.y + ' ' + bot.position.z : '—');
  setText('[data-f="kv-dim"]', d.dimension || '—');
  setText('[data-f="kv-difficulty"]', d.difficulty || '—');
  setText('[data-f="kv-brand"]', d.serverBrand || '—');
  setText('[data-f="kv-gamemode"]', d.gamemode || '—');
  setText('[data-f="kv-effects"]', d.effects && d.effects.length ? d.effects.map((e) => e.name || e.type).join(', ') : 'None');
  setText('[data-f="kv-xplevel"]', String(xp.level || 0));
  const gear = root.querySelector('[data-f="gear"]');
  if (gear) setSigHtml(gear, gearSig(bot), gearHtml(bot));
}
function serversHtml() {
  const bots = state.bots || [];
  const map = new Map();
  bots.forEach((b) => { const key = serverKey(b); const rec = map.get(key) || { key: key, host: b.host, port: b.port, hue: hashHue(key), bots: [], online: 0, players: 0 }; rec.bots.push(b); if (b.status === 'online') { rec.online += 1; rec.players = Math.max(rec.players, b.players || 0); } map.set(key, rec); });
  const rows = Array.from(map.values()).map((s) => '<div class="server-card"><div class="server-card__head"><span class="server-dot"></span><h3>' + esc(s.host) + ':' + s.port + '</h3><span class="pill ' + (s.online ? 'pill--online' : 'pill--offline') + '"><i></i>' + s.online + '/' + s.bots.length + ' online</span></div><div class="server-card__bots">' + s.bots.map((b) => '<span class="server-card__bot">' + esc(b.name) + '</span>').join('') + '</div></div>');
  return '<div class="page-head"><div class="page-head__text"><span class="eyebrow">Fleet</span><h2>Servers</h2><p>Bots grouped by the server they connect to.</p></div></div><div class="bot-grid">' + rows.join('') + '</div>';
}

/* ── add bot modal ── */
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
  if (first) setTimeout(() => { try { first.focus(); } catch (e) {} }, 30);
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

/* ── login handler ── */
async function handleLogin(e) { e.preventDefault(); const form = e.target; const input = form.querySelector('input'); const err = $('#login-error'); const btn = $('#login-submit'); if (!input || !btn) return; const password = input.value; if (!password) { if (err) { err.textContent = 'Enter the dashboard password.'; err.removeAttribute('hidden'); } input.focus(); return; } if (err) { err.textContent = ''; err.removeAttribute('hidden'); } btn.disabled = true; const idle = btn.innerHTML; btn.innerHTML = '<svg class="ico spin"><use href="#i-restart"></use></svg><span>Signing in…</span>'; try { const res = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }); const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || 'Wrong password.'); input.value = ''; await enterApp(); } catch (ex) { if (err) { err.textContent = ex.message || 'Sign in failed.'; err.removeAttribute('hidden'); } } finally { btn.disabled = false; btn.innerHTML = idle; } }

/* ── boot ── */
async function boot() { try { const res = await fetch('/api/auth', { credentials: 'same-origin' }); const data = await res.json(); if (data.authenticated) await enterApp(); else showLogin(); } catch (e) { showLogin(); } }
function init() {
  const loginForm = $('#login-form'); if (loginForm) loginForm.addEventListener('submit', handleLogin);
  const loginEye = $('#login-eye'); if (loginEye) loginEye.addEventListener('click', () => { const inp = $('#login-password'); if (!inp) return; const show = inp.type === 'password'; inp.type = show ? 'text' : 'password'; loginEye.innerHTML = icon(show ? 'eye-off' : 'eye'); });
  const addBtn = $('#add-bot-btn'); if (addBtn) addBtn.addEventListener('click', openAddBot);
  const master = $('#master-toggle'); if (master) master.addEventListener('click', toggleMaster);
  const topbarPower = $('#topbar-power'); if (topbarPower) topbarPower.addEventListener('click', toggleMaster);
  const logoutBtn = $('#logout-btn'); if (logoutBtn) logoutBtn.addEventListener('click', doLogout);
  const search = $('#search-input'); if (search) search.addEventListener('input', (e) => { state.query = e.target.value; renderView(); });
  const chips = document.querySelectorAll('.chip[data-filter]');
  document.addEventListener('click', (e) => {
    const t = e.target; if (!t || !t.closest) return;
    if (t.closest('[data-close]')) { e.preventDefault(); closeModal(); return; }
    const chip = t.closest('.chip'); if (chip) { e.preventDefault(); state.filter = chip.getAttribute('data-filter'); renderView(); return; }
    const scrollTo = t.closest('[data-bp-scroll]'); if (scrollTo) { e.preventDefault(); const el = document.getElementById(scrollTo.getAttribute('data-bp-scroll')); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const nav = t.closest('[data-view]'); if (nav) { e.preventDefault(); switchView(nav.getAttribute('data-view')); return; }
    const action = t.closest('[data-action]'); if (action) { e.preventDefault(); handleAction(action.getAttribute('data-action'), action); }
  });
  document.addEventListener('submit', (e) => {
    if (!e.target) return;
    if (e.target.id === 'bot-command-form') { e.preventDefault(); submitBotCommand(e.target); }
    else if (e.target.id === 'add-bot-form') { e.preventDefault(); submitAddBot(e.target); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { const m = $('#modal-root'); if (m && !m.hidden) { closeModal(); return; } }
    if (e.key === '/' && state.authed) { const tag = (e.target.tagName || '').toLowerCase(); if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return; e.preventDefault(); const s = $('#search-input'); if (s) s.focus(); }
  });
  window.addEventListener('popstate', () => applyRoute());
  window.addEventListener('scroll', () => { const bar = document.querySelector('#view .bp-progress i'); if (!bar) return; const max = Math.max(document.documentElement.scrollHeight - window.innerHeight, 0); const y = Math.min(Math.max(window.scrollY || 0, 0), max); bar.style.width = max > 0 ? (y / max * 100) + '%' : '0%'; });
}
window.MCBot = { state: state, getStats: getStats, renderView: renderView, switchView: switchView, applyRoute: applyRoute, findBot: findBot, api: api, enterApp: enterApp, showLogin: showLogin, toggleMaster: toggleMaster, handleAction: handleAction, renderBotConsole: renderBotConsole, renderBotInventory: renderBotInventory, submitBotCommand: submitBotCommand, toast: toast, fmtDuration: fmtDuration, statusMeta: statusMeta };
init();
boot();
