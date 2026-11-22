'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   MCBot Control — bot drawer: live console + Minecraft inventory
   ══════════════════════════════════════════════════════════════════════════ */

let drawerTab = 'console';
let inventoryTimer = null;

function drawerStatusHtml(bot) {
  const st = statusMeta(bot);
  return `
    <span>State <b class="${st.dot === 'online' ? 'good' : ''}">${st.label}</b></span>
    <span>Uptime <b data-uptime="${bot.joinedAt || ''}">${bot.joinedAt ? fmtDuration(nowMs() - bot.joinedAt) : '—'}</b></span>
    <span>Login <b class="${bot.loggedIn ? 'good' : ''}">${bot.loggedIn ? 'Verified' : (bot.autoLogin ? 'Auto' : 'Off')}</b></span>
    <span>Players <b>${bot.status === 'online' ? (bot.players || 0) : '—'}</b></span>`;
}

function drawerTabsHtml(bot) {
  return `
    <div class="drawer__tabs" role="tablist" aria-label="Bot panel">
      <button class="drawer__tab ${drawerTab === 'console' ? 'is-active' : ''}" type="button" role="tab"
        aria-selected="${drawerTab === 'console'}" data-drawer-tab="console">${icon('terminal')} Console</button>
      <button class="drawer__tab ${drawerTab === 'inventory' ? 'is-active' : ''}" type="button" role="tab"
        aria-selected="${drawerTab === 'inventory'}" data-drawer-tab="inventory">${icon('chest')} Inventory
        <em id="inv-tab-count">${bot.inventoryUsed || 0}</em></button>
      <button class="drawer__tab ${drawerTab === 'player' ? 'is-active' : ''}" type="button" role="tab"
        aria-selected="${drawerTab === 'player'}" data-drawer-tab="player">${icon('user')} Player</button>
    </div>`;
}

function lineHtml(entry) {
  return `<div class="console__line kind-${esc(entry.kind || 'chat')}">
    <span class="console__time">${fmtClock(entry.t)}</span>
    <span class="console__text">${esc(entry.text)}</span>
  </div>`;
}

function renderDrawer(bot) {
  const drawer = $('#console-drawer');
  if (!drawer) return;
  const st = statusMeta(bot);
  drawer.innerHTML = `
    <div class="drawer__head">
      <div class="bot-avatar" id="drawer-avatar" style="--hue:${hashHue(bot.name)}"><span class="avatar-initial">${esc(initial(bot.name))}</span>${skinHeadHtml(bot.name)}<span class="status-dot ${st.dot}"></span></div>
      <div class="drawer__title">
        <h2 id="drawer-name">${esc(bot.name)} <span class="pill ${st.pill}"><i></i>${st.label}</span></h2>
        <p id="drawer-host">${esc(bot.host)}:${bot.port} · v${esc(bot.version)}</p>
      </div>
      <button class="icon-btn" type="button" data-action="close-console" aria-label="Close panel">${icon('x')}</button>
    </div>
    <div class="drawer__status" id="drawer-status">${drawerStatusHtml(bot)}</div>
    ${drawerTabsHtml(bot)}
    <div class="drawer__pane ${drawerTab === 'console' ? '' : 'hidden'}" id="pane-console">
      <div class="drawer__body" id="console-body">
        <div class="console" id="console-lines"></div>
      </div>
      <div class="drawer__foot">
        <div class="quick-chips">
          <button class="quick-chip quick-chip--accent" type="button" data-action="console-login">${icon('shield')} /login</button>
          <button class="quick-chip" type="button" data-action="console-afk">${icon('clock')} /afk</button>
          <button class="quick-chip ${bot.autoEat ? 'is-on' : ''}" type="button" id="auto-eat-chip" data-action="console-autoeat">${icon('food')} Auto-eat ${bot.autoEat ? 'on' : 'off'}</button>
          <button class="quick-chip" type="button" data-action="console-switch">${icon('server')} Switch server</button>
          <button class="quick-chip" type="button" data-action="console-restart">${icon('restart')} Restart</button>
          <button class="quick-chip" type="button" data-action="console-stop">${icon('stop')} Stop bot</button>
        </div>
        <form class="console-form" id="console-form" autocomplete="off">
          <label class="field__control">
            <input id="console-input" type="text" maxlength="250" placeholder="Message or /command…" aria-label="Message or command" autocomplete="off" spellcheck="false" />
          </label>
          <button class="console-send" type="submit" aria-label="Send">${icon('send')}</button>
        </form>
      </div>
    </div>
    <div class="drawer__pane ${drawerTab === 'inventory' ? '' : 'hidden'}" id="pane-inventory">
      <div class="inventory-scroll"><div id="inventory-root"></div></div>
    </div>
    <div class="drawer__pane ${drawerTab === 'player' ? '' : 'hidden'}" id="pane-player">
      <div class="inventory-scroll"><div id="player-root"></div></div>
    </div>`;
  renderConsoleLines(bot.id);
  updateUptimes();
  if (drawerTab === 'inventory') {
    renderInventory(bot, null);
    loadInventory(bot.id);
  } else if (drawerTab === 'player') {
    renderPlayer(bot);
  }
}

function updateDrawer(bot) {
  if (!bot || state.consoleId !== bot.id) return;
  const st = statusMeta(bot);
  const avatar = $('#drawer-avatar');
  if (avatar) {
    avatar.style.setProperty('--hue', hashHue(bot.name));
    const dot = avatar.querySelector('.status-dot');
    if (dot) dot.className = `status-dot ${st.dot}`;
    else avatar.innerHTML = `<span class="avatar-initial">${esc(initial(bot.name))}</span>${skinHeadHtml(bot.name)}<span class="status-dot ${st.dot}"></span>`;
  }
  const name = $('#drawer-name');
  if (name) name.innerHTML = `${esc(bot.name)} <span class="pill ${st.pill}"><i></i>${st.label}</span>`;
  const host = $('#drawer-host');
  if (host) host.textContent = `${bot.host}:${bot.port} · v${bot.version}`;
  const status = $('#drawer-status');
  if (status) status.innerHTML = drawerStatusHtml(bot);
  const count = $('#inv-tab-count');
  if (count) count.textContent = bot.inventoryUsed || 0;
  const ae = $('#auto-eat-chip');
  if (ae) {
    ae.classList.toggle('is-on', !!bot.autoEat);
    ae.innerHTML = `${icon('food')} Auto-eat ${bot.autoEat ? 'on' : 'off'}`;
  }
  if (drawerTab === 'inventory' && !$('#inventory-root')?.children.length) loadInventory(bot.id);
  if (drawerTab === 'player' && $('#player-root') && (Date.now() - lastPlayerRender) > 1200) renderPlayer(bot);
}

/* ── console ────────────────────────────────────────────────────────────── */
function renderConsoleLines(id) {
  const lines = $('#console-lines');
  if (!lines) return;
  const logs = state.logs.get(id) || [];
  if (!logs.length) {
    lines.innerHTML = `<div class="console__empty">${icon('terminal')}No messages yet — say hello or run a command.</div>`;
    return;
  }
  lines.innerHTML = logs.map(lineHtml).join('');
  const body = $('#console-body');
  if (body) body.scrollTop = body.scrollHeight;
}

function appendConsoleLine(entry) {
  const lines = $('#console-lines');
  if (!lines) return;
  const body = $('#console-body');
  const nearBottom = body ? (body.scrollHeight - body.scrollTop - body.clientHeight < 100) : true;
  const empty = lines.querySelector('.console__empty');
  if (empty) lines.innerHTML = '';
  const div = document.createElement('div');
  div.className = `console__line kind-${entry.kind || 'chat'}`;
  div.innerHTML = `<span class="console__time">${fmtClock(entry.t)}</span><span class="console__text">${esc(entry.text)}</span>`;
  lines.appendChild(div);
  while (lines.children.length > 500) lines.firstElementChild.remove();
  if (nearBottom && body) body.scrollTop = body.scrollHeight;
}

/* ── inventory (Minecraft-style) ────────────────────────────────────────── */
function slotHtml(item, version, extra = '') {
  const tip = item ? itemTipText(item) : '';
  return `<div class="slot ${item ? 'has-item' : 'is-empty'} ${extra}"${tip ? ` data-tip="${esc(tip)}"` : ''}>
    ${item ? itemImgHtml(item, version) : ''}
    ${itemCountHtml(item)}
    ${durabilityHtml(item)}
  </div>`;
}

function invGrid(items, version, cls = '') {
  return `<div class="inv-grid ${cls}">${items.map((it) => slotHtml(it, version)).join('')}</div>`;
}

function renderInventory(bot, inv) {
  const root = $('#inventory-root');
  if (!root) return;
  if (!inv) {
    root.innerHTML = `
      <div class="inv-empty">
        ${icon('chest')}
        <h3>${bot.status === 'online' ? 'Reading inventory…' : 'Bot is offline'}</h3>
        <p>${bot.status === 'online' ? 'Waiting for the server to send the inventory.' : 'Start the bot to see its items live, exactly like in-game.'}</p>
      </div>`;
    return;
  }
  const held = inv.held || bot.heldItem;
  const heldHtml = held
    ? `<span class="inv-held__slot">${slotHtml(held, bot.version)}</span><span class="inv-held__text">Held in hand<strong>${esc(held.displayName)}</strong></span>`
    : `<span class="inv-held__slot">${slotHtml(null, bot.version)}</span><span class="inv-held__text">Held in hand<strong>Empty</strong></span>`;
  root.innerHTML = `
    <div class="inv-head">
      <div class="inv-head__title">${icon('chest')} <span>Inventory</span><em>${inv.used}/36</em></div>
      <div class="inv-head__held">${heldHtml}</div>
    </div>
    <div class="inv-panel">
      <div class="inv-top">
        <div class="inv-block">
          <p class="inv-label">Crafting <em>2×2</em></p>
          <div class="inv-craft">
            <div class="inv-craft__grid">${[0, 1, 2, 3].map((i) => slotHtml(inv.craft[i], bot.version)).join('')}</div>
            ${icon('arrow', 'ico inv-craft__arrow')}
            ${slotHtml(inv.craftResult, bot.version, 'inv-result')}
          </div>
        </div>
        <div class="inv-player">
          <div class="inv-player__avatar" style="--hue:${hashHue(bot.name)}"><span class="inv-player__initial">${esc(initial(bot.name))}</span>${skinHeadHtml(bot.name, 'inv-player__skin')}</div>
          <div class="inv-player__bars">
            <span class="inv-player__bar is-hp" title="Health ${Number.isFinite(bot.health) ? bot.health : 20}/20">${icon('heart')}<i><em style="width:${(Number.isFinite(bot.health) ? bot.health : 20) * 5}%"></em></i></span>
            <span class="inv-player__bar is-food" title="Food ${Number.isFinite(bot.food) ? bot.food : 20}/20">${icon('food')}<i><em style="width:${(Number.isFinite(bot.food) ? bot.food : 20) * 5}%"></em></i></span>
          </div>
          <span class="inv-player__name">${esc(bot.name)}</span>
        </div>
        <div class="inv-block inv-gear">
          <p class="inv-label">Armour</p>
          <div class="inv-gear__row">
            <div class="inv-gear__armor">${inv.armor.map((it) => slotHtml(it, bot.version)).join('')}</div>
            <div class="inv-gear__off">
              <span class="inv-label inv-label--mini">Off-hand</span>
              ${slotHtml(inv.offhand, bot.version)}
            </div>
          </div>
        </div>
      </div>
      <div class="inv-block">
        <p class="inv-label">Storage <em>27</em></p>
        ${invGrid(inv.main, bot.version, 'inv-grid--9')}
      </div>
      <div class="inv-block inv-hotbar">
        <p class="inv-label">Hotbar <em>9</em></p>
        <div class="inv-grid inv-grid--9">${inv.hotbar.map((it, idx) => slotHtml(it, bot.version, idx === inv.selected ? 'is-selected' : '')).join('')}</div>
      </div>
    </div>
    <p class="inv-foot">${icon('activity')} ${inv.stale ? 'Syncing with the server… showing your last snapshot' : 'Live from the bot · updates automatically'}</p>`;
}

/* ── player profile (all in-game state) ─────────────────────────────────── */
let lastPlayerRender = 0;
function fmtEffectTime(ticks) {
  const s = Math.max(0, Math.round((ticks || 0) / 20));
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}
function fmtGameClock(timeOfDay) {
  if (!Number.isFinite(timeOfDay)) return '—';
  const total = ((Math.floor(timeOfDay / 1000) + 6) % 24) * 60;
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function roman(n) {
  return ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n] || String(n);
}
function playerMeter(label, value, max, iconName, tone) {
  const pct = max ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0;
  return `<div class="pmeter ${tone}">
    <div class="pmeter__head">${icon(iconName)}<span>${esc(label)}</span><b>${value}<em>/${max}</em></b></div>
    <i><em style="width:${pct}%"></em></i>
  </div>`;
}
function playerStat(iconName, label, value, sub = '') {
  const text = value == null || value === '' ? '—' : String(value);
  return `<div class="pstat">
    <span class="pstat__ico">${icon(iconName)}</span>
    <div class="pstat__body"><span>${esc(label)}</span><b title="${esc(text)}">${esc(text)}</b>${sub ? `<em>${esc(sub)}</em>` : ''}</div>
  </div>`;
}

function renderPlayer(bot) {
  const root = $('#player-root');
  if (!root) return;
  lastPlayerRender = Date.now();
  const d = bot.detail || {};
  const st = statusMeta(bot);
  const hue = hashHue(bot.name);
  const serverHue = serverHueOf(bot);
  const hp = Number.isFinite(bot.health) ? bot.health : 0;
  const food = Number.isFinite(bot.food) ? bot.food : 0;
  const xp = d.xp;
  const pos = bot.position ? `${bot.position.x} ${bot.position.y} ${bot.position.z}` : '—';
  const effects = Array.isArray(d.effects) ? d.effects : [];
  const armor = Array.isArray(bot.armor) ? bot.armor : [null, null, null, null];
  const gameTime = d.time ? `Day ${d.time.day || 1} · ${fmtGameClock(d.time.timeOfDay)}` : '—';
  const uuid = d.uuid ? String(d.uuid) : '';

  root.innerHTML = `
    <div class="player-hero" style="--server:${serverHue};--hue:${hue}">
      <div class="player-hero__skin">
        <span class="player-hero__initial">${esc(initial(bot.name))}</span>
        <img src="${skinUrl(bot.name, 'body', 200)}" alt="" loading="lazy" decoding="async" data-skin="1" />
      </div>
      <div class="player-hero__info">
        <span class="player-hero__eyebrow">${icon('user')} Player profile</span>
        <h3>${esc(bot.name)} <span class="pill ${st.pill}"><i></i>${st.label}</span></h3>
        <p>${esc(serverLabel(bot))} · v${esc(bot.version)}</p>
        <div class="player-tags">
          <span class="ptag">${icon('cube')} ${esc(prettyGameId(d.gamemode))}</span>
          <span class="ptag">${icon('pin')} ${esc(prettyGameId(d.dimension))}</span>
          <span class="ptag ${bot.loggedIn ? 'is-good' : ''}">${icon('shield')} ${bot.loggedIn ? 'Logged in' : (bot.autoLogin ? 'Auto login' : 'Not logged in')}</span>
        </div>
        ${uuid ? `<button class="player-uuid" type="button" data-copy="${esc(uuid)}" title="Copy UUID">${icon('copy')} ${esc(uuid.slice(0, 8))}…${esc(uuid.slice(-4))}</button>` : ''}
      </div>
    </div>

    <div class="player-block">
      <p class="inv-label">Vitals</p>
      <div class="pmeters">
        ${playerMeter('Health', hp, 20, 'heart', 'is-hp')}
        ${playerMeter('Food', food, 20, 'food', 'is-food')}
        ${Number.isFinite(d.saturation) ? playerMeter('Saturation', d.saturation, 20, 'sparkle', 'is-sat') : ''}
        ${Number.isFinite(d.air) ? playerMeter('Air', Math.round(d.air), 300, 'activity', 'is-air') : ''}
        ${xp ? playerMeter(`XP · level ${xp.level}`, Math.round((xp.progress || 0) * 100), 100, 'zap', 'is-xp') : ''}
      </div>
    </div>

    <div class="player-block">
      <p class="inv-label">World & connection</p>
      <div class="pstats">
        ${playerStat('cube', 'Gamemode', prettyGameId(d.gamemode))}
        ${playerStat('pin', 'Dimension', prettyGameId(d.dimension))}
        ${playerStat('sliders', 'Difficulty', d.difficulty ? String(d.difficulty).charAt(0).toUpperCase() + String(d.difficulty).slice(1) : '—')}
        ${playerStat('users', 'Players', bot.players == null ? '—' : bot.players)}
        ${playerStat('activity', 'Ping', bot.ping == null ? '—' : `${bot.ping} ms`)}
        ${playerStat('server', 'Server', serverLabel(bot))}
        ${playerStat('clock', 'In-game time', gameTime, d.time ? (d.time.isDay ? 'Daytime' : 'Night') : '')}
        ${playerStat('arrow', 'Position', pos)}
        ${playerStat('shield', 'Server brand', d.serverBrand)}
        ${playerStat('zap', 'XP points', xp ? xp.points : '—')}
      </div>
    </div>

    <div class="player-block">
      <p class="inv-label">Equipped</p>
      <div class="player-gear">
        <div class="player-gear__slot"><span>Held</span>${slotHtml(bot.heldItem, bot.version)}</div>
        ${armor.map((it, i) => `<div class="player-gear__slot"><span>${['Helmet', 'Chestplate', 'Leggings', 'Boots'][i]}</span>${slotHtml(it, bot.version)}</div>`).join('')}
        <div class="player-gear__slot"><span>Off-hand</span>${slotHtml(bot.offhand, bot.version)}</div>
      </div>
    </div>

    ${effects.length ? `<div class="player-block">
      <p class="inv-label">Active effects <em>${effects.length}</em></p>
      <div class="player-effects">
        ${effects.map((e) => `<span class="peffect"><i></i>${esc(prettyGameId(e.name))}${e.amplifier ? ` ${roman(e.amplifier + 1)}` : ''}<em>${fmtEffectTime(e.duration)}</em></span>`).join('')}
      </div>
    </div>` : ''}

    <p class="inv-foot">${icon('activity')} Live player state · updates with every server tick</p>`;
}

async function loadInventory(id = state.consoleId) {
  if (!id) return;
  try {
    const data = await api(`/api/bots/${id}/inventory`);
    if (state.consoleId !== id) return;
    if (data.bot) {
      const i = state.bots.findIndex((b) => b.id === id);
      if (i >= 0) state.bots[i] = data.bot;
    }
    renderInventory(findBot(id) || data.bot, data.inventory);
    const count = $('#inv-tab-count');
    if (count) count.textContent = data.inventory ? data.inventory.used : 0;
  } catch (_) {}
}

function startInventoryPolling() {
  stopInventoryPolling();
  inventoryTimer = setInterval(() => {
    if (drawerTab === 'inventory' && state.consoleId) loadInventory();
  }, 2500);
}
function stopInventoryPolling() {
  if (inventoryTimer) { clearInterval(inventoryTimer); inventoryTimer = null; }
}

function setDrawerTab(tab) {
  drawerTab = ['inventory', 'player'].includes(tab) ? tab : 'console';
  $$('.drawer__tab').forEach((b) => {
    const on = b.dataset.drawerTab === drawerTab;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
  });
  const consolePane = $('#pane-console');
  const invPane = $('#pane-inventory');
  const playerPane = $('#pane-player');
  if (consolePane) consolePane.classList.toggle('hidden', drawerTab !== 'console');
  if (invPane) invPane.classList.toggle('hidden', drawerTab !== 'inventory');
  if (playerPane) playerPane.classList.toggle('hidden', drawerTab !== 'player');
  if (drawerTab === 'inventory') {
    loadInventory();
    startInventoryPolling();
  } else {
    stopInventoryPolling();
    if (drawerTab === 'player') {
      const bot = findBot(state.consoleId);
      if (bot) renderPlayer(bot);
    } else {
      setTimeout(() => { const input = $('#console-input'); if (input) input.focus(); }, 120);
    }
  }
}

async function openInventory(id) {
  await openConsole(id, 'inventory');
}

async function openPlayer(id) {
  await openConsole(id, 'player');
}

/* ── drawer lifecycle ───────────────────────────────────────────────────── */
async function openConsole(id, tab = 'console') {
  const bot = findBot(id);
  if (!bot) return;
  state.consoleId = id;
  drawerTab = ['inventory', 'player'].includes(tab) ? tab : 'console';
  consoleHistory = [];
  consoleHistoryIndex = -1;
  renderDrawer(bot);
  $('#drawer-overlay').hidden = false;
  const drawer = $('#console-drawer');
  drawer.classList.add('is-open');
  drawer.setAttribute('aria-hidden', 'false');
  syncLock();
  if (drawerTab === 'inventory') startInventoryPolling();
  else if (window.innerWidth > 760) setTimeout(() => { const input = $('#console-input'); if (input) input.focus(); }, 280);
  await refreshDrawerLogs(id);
}

async function refreshDrawerLogs(id) {
  if (!id) return;
  try {
    const data = await api(`/api/bots/${id}/logs`);
    if (state.consoleId !== id) return;
    state.logs.set(id, Array.isArray(data.logs) ? data.logs : []);
    if (data.bot) {
      const i = state.bots.findIndex((b) => b.id === id);
      if (i >= 0) state.bots[i] = data.bot;
    }
    renderConsoleLines(id);
  } catch (_) {
    renderConsoleLines(id);
  }
}

function closeConsole(silent = false) {
  const drawer = $('#console-drawer');
  if (!drawer) return;
  const wasOpen = drawer.classList.contains('is-open');
  stopInventoryPolling();
  state.consoleId = null;
  drawer.classList.remove('is-open');
  drawer.setAttribute('aria-hidden', 'true');
  $('#drawer-overlay').hidden = true;
  syncLock();
  if (!silent && wasOpen) {
    setTimeout(() => {
      if (!drawer.classList.contains('is-open')) { drawer.innerHTML = ''; drawerTab = 'console'; }
    }, 400);
  }
}

async function sendConsoleMessage(text) {
  const id = state.consoleId;
  if (!id) return false;
  const msg = String(text || '').trim();
  if (!msg) return false;
  await api(`/api/bots/${id}/chat`, { method: 'POST', body: JSON.stringify({ message: msg }) });
  if (consoleHistory[consoleHistory.length - 1] !== msg) consoleHistory.push(msg);
  if (consoleHistory.length > 60) consoleHistory.shift();
  consoleHistoryIndex = consoleHistory.length;
  return true;
}

function syncLock() {
  const modalOpen = !$('#modal-root').hidden;
  const drawerOpen = $('#console-drawer').classList.contains('is-open');
  document.body.classList.toggle('is-locked', modalOpen || drawerOpen);
}
