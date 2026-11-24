#!/usr/bin/env node
'use strict';

/*
 * MCBot Control — web dashboard + multi-bot manager.
 *
 *  • Add / edit / remove Minecraft bots (name, IP, port, password, version)
 *  • Start / stop each bot, or a whole server with one switch
 *  • Auto-login: any "/login" style prompt is answered with the bot's password
 *    (default: Sandun123) — with retries, register support and success detection
 *  • Auto server-switch (optional): "/server <name>" after login, re-switch on
 *    lobby/restart, optional periodic re-switch
 *  • Live console over Server-Sent Events (no websocket dependency)
 *
 * Runs on port 80 by default. Password-protected with DASHBOARD_PASSWORD
 * (default: Sandun123).
 */

process.env.TZ = process.env.TZ || 'Asia/Colombo';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// mineflayer pulls in minecraft-data (hundreds of MB of version files). Load
// it only when the first bot actually connects so an idle panel stays small.
let mineflayer = null;
function getMineflayer() {
  if (!mineflayer) mineflayer = require('mineflayer');
  return mineflayer;
}
let mcProtocol = null;
function getMcProtocol() {
  if (!mcProtocol) mcProtocol = require('minecraft-protocol');
  return mcProtocol;
}
let pathfinderLib = null;
function getPathfinder() {
  if (!pathfinderLib) pathfinderLib = require('mineflayer-pathfinder');
  return pathfinderLib;
}

// Velocity re-enters CONFIGURATION after login (backend transfer). While the
// client is in that state, PLAY packets are a protocol violation — the server
// answers with "An internal error occurred in your connection." mineflayer's
// physics plugin keeps sending `position`, so drop non-configuration writes
// until it is back in PLAY.
const CONFIG_WRITES = new Set([
  'configuration_acknowledged', 'select_known_packs', 'finish_configuration',
  'custom_payload', 'keep_alive', 'pong', 'accept_code_of_conduct',
  'resource_pack_receive', 'cookie_response', 'chat_session_update',
]);
function guardReconfigPackets(bot) {
  const client = bot && bot._client;
  if (!client || client._reconfigGuarded) return;
  client._reconfigGuarded = true;
  const states = getMcProtocol().states;
  const write = client.write.bind(client);
  client.write = (name, ...args) => {
    if (client.state === states.CONFIGURATION && !CONFIG_WRITES.has(name)) return;
    return write(name, ...args);
  };
}
const proxyPool = require('./proxy-pool');

// Light bot profile: fewer plugins, fewer chunks, lower RAM/CPU per bot.
const LIGHT_OPTIONS = require('./bot-options');

// Velocity rate-limits joins per IP ("Papyrus — You're connecting too quickly").
// Ten bots retrying together therefore never get in. This gate spaces every
// connection attempt across the whole fleet.
const CONNECT_GAP_MS = 3200;
let gateNextAt = 0;
let gateBlockedUntil = 0;
function takeConnectSlot() {
  const t = Date.now();
  const at = Math.max(t, gateNextAt, gateBlockedUntil);
  gateNextAt = at + CONNECT_GAP_MS + Math.floor(Math.random() * 1100);
  return at - t;
}
function blockConnectGate(ms) {
  gateBlockedUntil = Math.max(gateBlockedUntil, Date.now() + ms);
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const BOTS_FILE = path.join(DATA_DIR, 'bots.json');
const PORTFOLIO_DIR = process.env.PORTFOLIO_DIR || '/home/ubuntu/sandun-portfolio';
const SITE_DIR = process.env.SITE_DIR || path.join(ROOT, '..', 'docs');
const PORT = parseInt(process.env.PORT || '80', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'Sandun123';
const DEFAULT_MC_PASSWORD = process.env.MC_DEFAULT_PASSWORD || 'Sandun123';
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_LOGS = 400;
const MAX_BODY = 64 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────
const now = () => Date.now();
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const clean = (s, max = 512) => String(s == null ? '' : s).replace(/\r/g, '').slice(0, max);
const stripColor = (s) => String(s == null ? '' : s).replace(/§[0-9a-fk-or]/gi, '');
const mask = (s) => '•'.repeat(Math.min(String(s || '').length, 12));

// Kick reasons vary by protocol version — flatten them before truncating.
const { chatText } = require('./chat-text');

function log(...args) {
  const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
  console.log(`\x1b[2m[${t}]\x1b[0m`, ...args);
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Minecraft item icons (proxied + cached, so the browser never needs a CDN)
// ─────────────────────────────────────────────────────────────────────────────
const ICON_DIR = path.join(DATA_DIR, 'icons');
const ICON_MEM = new Map();       // key -> Buffer | null (null = known miss)
const ICON_PENDING = new Map();   // key -> Promise
const ICON_CDN = 'https://cdn.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@';

function fetchPng(url, depth = 0) {
  return new Promise((resolve) => {
    if (depth > 3) return resolve(null);
    let req;
    try {
      req = https.get(url, { timeout: 7000, headers: { 'User-Agent': 'MCBot-Control/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return resolve(fetchPng(next, depth + 1));
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > 512 * 1024) { req.destroy(); resolve(null); return; }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', () => resolve(null));
      });
    } catch (_) { return resolve(null); }
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function iconPaths(version, name) {
  const ver = /^\d+\.\d+(?:\.\d+)?$/.test(String(version || '')) ? version : '1.20.1';
  const base = `${ICON_CDN}${ver}/assets/minecraft/textures`;
  return {
    ver,
    file: path.join(ICON_DIR, ver, `${name}.png`),
    urls: [`${base}/item/${name}.png`, `${base}/block/${name}.png`],
  };
}

async function getIcon(version, name) {
  if (!/^[a-z0-9_]{1,64}$/.test(name)) return null;
  const { ver, file, urls } = iconPaths(version, name);
  const key = `${ver}/${name}`;
  if (ICON_MEM.has(key)) return ICON_MEM.get(key);
  if (ICON_PENDING.has(key)) return ICON_PENDING.get(key);

  const job = (async () => {
    try {
      if (fs.existsSync(file)) {
        const buf = fs.readFileSync(file);
        if (buf.length > 0) { ICON_MEM.set(key, buf); return buf; }
      }
    } catch (_) {}
    for (const url of urls) {
      const buf = await fetchPng(url);
      if (buf && buf.length > 0) {
        ICON_MEM.set(key, buf);
        try { ensureDir(path.dirname(file)); fs.writeFileSync(file, buf); } catch (_) {}
        return buf;
      }
    }
    ICON_MEM.set(key, null);
    return null;
  })();

  ICON_PENDING.set(key, job);
  try { return await job; } finally { ICON_PENDING.delete(key); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Player skins (Minotar proxy, cached on disk)
// ─────────────────────────────────────────────────────────────────────────────
const SKIN_DIR = path.join(DATA_DIR, 'skins');
const SKIN_MEM = new Map();
const SKIN_PENDING = new Map();

async function getSkin(name, kind = 'head', size = 64) {
  const safe = String(name || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 32);
  if (!safe) return null;
  const k = kind === 'body' ? 'body' : 'head';
  const s = Math.max(32, Math.min(320, parseInt(size, 10) || (k === 'body' ? 160 : 64)));
  // Bedrock/offline names (dots, >16 chars) have no Java skin — use Steve.
  const remote = /^[A-Za-z0-9_]{1,16}$/.test(safe) ? safe : 'Steve';
  const key = `${k}/${s}/${safe.toLowerCase()}`;
  if (SKIN_MEM.has(key)) return SKIN_MEM.get(key);
  if (SKIN_PENDING.has(key)) return SKIN_PENDING.get(key);

  const job = (async () => {
    const file = path.join(SKIN_DIR, `${k}-${s}-${safe.toLowerCase()}.png`);
    try {
      if (fs.existsSync(file)) {
        const buf = fs.readFileSync(file);
        if (buf.length > 0) { SKIN_MEM.set(key, buf); return buf; }
      }
    } catch (_) {}
    const urls = k === 'body'
      ? [`https://minotar.net/body/${encodeURIComponent(remote)}/${s}.png`, `https://minotar.net/body/Steve/${s}.png`]
      : [`https://minotar.net/helm/${encodeURIComponent(remote)}/${s}.png`, `https://minotar.net/helm/Steve/${s}.png`];
    for (const url of urls) {
      const buf = await fetchPng(url);
      if (buf && buf.length > 0) {
        SKIN_MEM.set(key, buf);
        try { ensureDir(SKIN_DIR); fs.writeFileSync(file, buf); } catch (_) {}
        return buf;
      }
    }
    SKIN_MEM.set(key, null);
    return null;
  })();

  SKIN_PENDING.set(key, job);
  try { return await job; } finally { SKIN_PENDING.delete(key); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat pattern matchers (auto-login / auto-switch)
// ─────────────────────────────────────────────────────────────────────────────
// These are deliberately specific: they must look like a SERVER auth prompt,
// not a player casually typing "login" in chat.
const LOGIN_PROMPTS = [
  /\/login\b/i,
  /\bplease\s+(?:type\s+)?\/?(?:log\s*in|login)\b/i,
  /\byou\s+(?:must|need\s+to|have\s+to|should)\s+(?:\/)?(?:log\s*in|login|register)\b/i,
  /\b(?:log\s*in|login)\s+(?:to\s+(?:the\s+)?(?:server|game|network)|with\s+\/login)\b/i,
  /\bnot\s+(?:logged\s*in|authenticated)\b/i,
  /\bauthenticate\s+(?:yourself|to|with)\b/i,
  /\b(?:login|register)\s*[:>]\s*$/i,
  /\b(?:use|type)\s+\/login\b/i,
  /\bauthme\b/i,
  /\b(?:enter|send)\s+(?:your\s+)?password\b/i,
];
const REGISTER_PROMPTS = [
  /\/register\b/i,
  /\bplease\s+register\b/i,
  /\bregister\s+(?:to|with|using|an?\s+account)\b/i,
  /\bnot\s+registered\b/i,
  /\bcreate\s+(?:an?\s+)?account\b/i,
];
const LOGIN_SUCCESS = [
  /\bsuccessfully\s+(?:logged|logged\s+in|authenticated|registered)\b/i,
  /\blogged\s+in\s+successfully\b/i,
  /\bregistered\s+successfully\b/i,
  /\blogin\s+successful\b/i,
  /\bregistration\s+successful\b/i,
  /\bwelcome\s+back\b/i,
  /\byou\s+are\s+now\s+(?:logged\s*in|authenticated|registered)\b/i,
  /\bauthentication\s+successful\b/i,
  /\balready\s+(?:logged\s*in|authenticated)\b/i,
];
const LOBBY_PROMPT = /\b(restart(?:ing|ed)?|reboot(?:ing)?|sending you to|moved to (?:the )?lobby|sent to (?:the )?lobby|fell back|server is (?:going )?down|connection lost)\b/i;
const RESTART_COUNTDOWN = /\brestart(?:ing)?\b.*\b[123]\b|\b3\b[\s.]+\b2\b[\s.]+\b1\b|\brestarting\s+soon\b/i;
const VERIFY_PROMPT = /you are being verified|please do not move.*automatic|verification.*(?:complete|passed|success)|you(?:'ve| have) passed/i;
const OFFLINE_CODES = ['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH'];

// /afk → GUI slot 1 → 5..4..3..2..1 → AFK arena → ONE short random walk.
// The walk is ordinary movement (no mining / digging / placing).
const AFK_WALK_MIN = 5;
const AFK_WALK_MAX = 15;
const AFK_TELEPORT_WATCH_MS = 60000;

// ─────────────────────────────────────────────────────────────────────────────
// Bot manager
// ─────────────────────────────────────────────────────────────────────────────
let manager = null;

class ManagedBot {
  constructor(cfg, hooks) {
    this.hooks = hooks; // { broadcast(type, payload), save() }
    this.id = cfg.id;
    this.createdAt = cfg.createdAt || now();

    // ── persisted config ──
    this.name = cfg.name;
    this.host = cfg.host;
    this.port = cfg.port;
    this.version = cfg.version;
    this.password = cfg.password || DEFAULT_MC_PASSWORD;
    this.autoLogin = cfg.autoLogin !== false;
    this.autoSwitch = !!cfg.autoSwitch;
    this.switchCommand = cfg.switchCommand || '/server oneblock';
    this.switchDelay = clamp(Number(cfg.switchDelay) || 4000, 1000, 60000);
    this.autoReconnect = cfg.autoReconnect !== false;
    this.antiAfk = cfg.antiAfk !== false;
    this.autoEat = cfg.autoEat !== false;
    this._eating = false;
    this._eatWarned = false;
    this.reswitch = !!cfg.reswitch;
    this.desiredOn = !!cfg.desiredOn;
    this.groupIds = Array.isArray(cfg.groupIds) ? cfg.groupIds.slice(0, 50) : [];

    // ── runtime ──
    this.bot = null;
    this.wanted = false;
    this.status = 'stopped';
    this.statusText = 'Stopped';
    this.connectedAt = null;
    this.joinedAt = null;
    this.lastError = '';
    this.logs = [];
    this.players = 0;
    this.health = null;
    this.food = null;
    this.position = null;
    this.ping = null;
    this.proxy = null;
    this.proxySince = null;
    this._retries = 0;
    this._throttleHits = 0;
    this._rateLimitedUntil = 0;
    this._bannedUntil = 0;
    this._banText = '';
    this._sawKick = false;
    this._lastKick = '';
    this._permanentBan = false;
    this._pauseLogged = false;
    this._proxyTries = 0;
    this._gateTimer = null;
    this.loggedIn = false;
    this.loginAttempts = 0;
    this.switched = false;
    this.nextRetryAt = null;

    this._timers = new Set();
    this._watchdog = null;
    this._afkTimer = null;
    this._loginRetry = null;
    this._assumeLogin = null;
    this._loginCooldown = 0;
    this._loginPromptSeen = false;
    this._loginGaveUp = false;
    this._lastPromptAt = 0;
    this._lastAssumedAt = 0;
    this._switchTimer = null;
    this._reswitchTimer = null;
    this._lobbyReswitchAt = 0;
    this._verifying = false;
    this._verifyTimer = null;
    this._refreshAt = 0;
    this._firstSpawn = true;
    this._guardKicked = false;
    this._invCache = null;
    this._afkClickUntil = 0;
    this._afkClickTimer = null;
    this._afkSequence = null;
    this._afkTeleportTimer = null;
    this._afkWalkTimer = null;
    this._afkWalkPaused = false;
    this._afkMovements = null;
    this._inAfkArena = false;

    this.addLog('info', `Bot created for ${this.host}:${this.port}`);
  }

  // ── rich in-game player state for the Player tab ──
  playerDetail() {
    const b = this.bot;
    if (!b) return null;
    const DIFFICULTY = { 0: 'Peaceful', 1: 'Easy', 2: 'Normal', 3: 'Hard' };
    const out = {
      uuid: null, entityId: null, gamemode: null, dimension: null, difficulty: null,
      serverBrand: null, xp: null, saturation: null, air: null, effects: [], time: null,
    };
    try { if (b.player && b.player.uuid) out.uuid = b.player.uuid; } catch (_) {}
    try { if (b.entity && typeof b.entity.id === 'number') out.entityId = b.entity.id; } catch (_) {}
    try {
      const g = b.game || {};
      out.gamemode = g.gameMode != null ? String(g.gameMode) : null;
      const dim = g.dimension;
      out.dimension = typeof dim === 'string' ? dim
        : (dim && dim.name ? String(dim.name) : (typeof dim === 'number' ? `dimension ${dim}` : null));
      out.difficulty = g.difficulty != null
        ? (typeof g.difficulty === 'number' ? (DIFFICULTY[g.difficulty] || g.difficulty) : String(g.difficulty))
        : null;
      out.serverBrand = g.serverBrand || null;
    } catch (_) {}
    try {
      if (b.experience) out.xp = {
        level: b.experience.level || 0,
        points: b.experience.points || 0,
        progress: Math.round((b.experience.progress || 0) * 1000) / 1000,
      };
    } catch (_) {}
    try { if (typeof b.foodSaturation === 'number') out.saturation = Math.round(b.foodSaturation * 10) / 10; } catch (_) {}
    try { if (typeof b.oxygenLevel === 'number') out.air = b.oxygenLevel; } catch (_) {}
    try {
      const raw = b.entity && b.entity.effects;
      let list = [];
      if (raw instanceof Map) list = Array.from(raw.values());
      else if (Array.isArray(raw)) list = raw;
      else if (raw && typeof raw === 'object') list = Object.values(raw);
      out.effects = list.map((e) => {
        if (!e) return null;
        let name = e.name || null;
        if (!name) {
          try {
            const reg = b.registry && b.registry.effects && b.registry.effects[e.id];
            if (reg) name = reg.name || reg.displayName;
          } catch (_) {}
        }
        return {
          name: String(name || `effect_${e.id}`).replace(/^effect\./, ''),
          amplifier: e.amplifier || 0,
          duration: e.duration || 0,
        };
      }).filter(Boolean);
    } catch (_) {}
    try {
      if (b.time) out.time = { day: b.time.day, timeOfDay: b.time.timeOfDay, isDay: b.time.isDay };
    } catch (_) {}
    return out;
  }

  // ── public shape sent to the browser ──
  public() {
    let inv = inventoryPreview(this.bot);
    // While a transfer/respawn re-syncs the inventory, keep showing the last
    // known items instead of flashing an empty card.
    if (!inv.used && this._invCache && now() - this._invCache.at < 120000) {
      const snap = this._invCache.snap;
      inv = {
        items: [...snap.hotbar, ...snap.main].filter(Boolean).slice(0, 8),
        used: snap.used,
      };
    }
    return {
      id: this.id,
      name: this.name,
      host: this.host,
      port: this.port,
      version: this.version,
      password: this.password,
      autoLogin: this.autoLogin,
      autoSwitch: this.autoSwitch,
      switchCommand: this.switchCommand,
      switchDelay: this.switchDelay,
      autoReconnect: this.autoReconnect,
      antiAfk: this.antiAfk,
      autoEat: this.autoEat,
      reswitch: this.reswitch,
      desiredOn: this.desiredOn,
      groupIds: this.groupIds.slice(),
      createdAt: this.createdAt,
      status: this.status,
      statusText: this.statusText,
      connectedAt: this.connectedAt,
      joinedAt: this.joinedAt,
      uptimeMs: this.joinedAt ? now() - this.joinedAt : 0,
      lastError: this.lastError,
      players: this.players,
      health: this.health,
      food: this.food,
      position: this.position,
      afkArena: !!this._inAfkArena,
      ping: this.ping,
      proxy: this.proxy,
      proxySince: this.proxySince,
      banned: !!this._banText,
      banText: this._banText,
      permanentBan: !!this._permanentBan,
      appealUrl: (this._banText.match(/https?:\/\/[^\s]+/i) || [null])[0]
        || (/hungrybirds/i.test(this.host) ? 'https://discord.gg/sgrcFUdjXU' : null),
      lastKick: this._lastKick || null,
      loggedIn: this.loggedIn,
      loginAttempts: this.loginAttempts,
      switched: this.switched,
      nextRetryAt: this.nextRetryAt,
      inventoryPreview: inv.items,
      inventoryUsed: inv.used,
      inventoryTotal: 36,
      scoreboard: this.bot ? scoreboardSnapshot(this.bot) : null,
      heldItem: this.bot && this.bot.heldItem ? itemJson(this.bot.heldItem) : null,
      selectedSlot: this.bot && Number.isInteger(this.bot.quickBarSlot) ? this.bot.quickBarSlot : 0,
      armor: armorPreview(this.bot),
      offhand: offhandPreview(this.bot),
      detail: this.playerDetail(),
      lastLog: this.logs.length ? this.logs[this.logs.length - 1] : null,
    };
  }

  config() {
    return {
      id: this.id,
      name: this.name,
      host: this.host,
      port: this.port,
      version: this.version,
      password: this.password,
      autoLogin: this.autoLogin,
      autoSwitch: this.autoSwitch,
      switchCommand: this.switchCommand,
      switchDelay: this.switchDelay,
      autoReconnect: this.autoReconnect,
      antiAfk: this.antiAfk,
      autoEat: this.autoEat,
      reswitch: this.reswitch,
      desiredOn: this.desiredOn,
      groupIds: this.groupIds.slice(),
      createdAt: this.createdAt,
    };
  }

  addLog(kind, text) {
    const entry = { t: now(), kind, text: clean(stripColor(text), 2000) };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    if (this.hooks && this.hooks.broadcast) this.hooks.broadcast('log', { id: this.id, entry });
    return entry;
  }

  emit() {
    if (this.hooks && this.hooks.broadcast) this.hooks.broadcast('bot', { bot: this.public() });
  }

  setStatus(status, text) {
    this.status = status;
    this.statusText = text;
    this.emit();
  }

  // ── timers ──
  _later(fn, ms) {
    const t = setTimeout(() => { this._timers.delete(t); try { fn(); } catch (e) { log('timer error', e.message); } }, ms);
    this._timers.add(t);
    return t;
  }
  _clearTimers() {
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
    if (this._loginRetry) { clearTimeout(this._loginRetry); this._loginRetry = null; }
    if (this._assumeLogin) { clearTimeout(this._assumeLogin); this._assumeLogin = null; }
    if (this._verifyTimer) { clearTimeout(this._verifyTimer); this._verifyTimer = null; }
    if (this._switchTimer) { clearTimeout(this._switchTimer); this._switchTimer = null; }
    if (this._reswitchTimer) { clearTimeout(this._reswitchTimer); this._reswitchTimer = null; }
    if (this._afkClickTimer) { clearTimeout(this._afkClickTimer); this._afkClickTimer = null; }
    if (this._aliveTimer) { clearInterval(this._aliveTimer); this._aliveTimer = null; }
    if (this._worldTimer) { clearInterval(this._worldTimer); this._worldTimer = null; }
  }
  _startAliveWatch() {
    if (this._aliveTimer) clearInterval(this._aliveTimer);
    this._aliveTimer = setInterval(() => this._checkAlive(), 10000);
    if (this._worldTimer) clearInterval(this._worldTimer);
    // Chunks are the biggest per-bot memory cost. Keep only the nine around
    // the bot; physics still has the blocks under its feet.
    this._worldTimer = setInterval(() => this._trimWorld(), 30000);
  }

  _trimWorld() {
    const b = this.bot;
    const world = b && b.world;
    const cols = world && world.columns;
    if (!cols) return;
    const keys = Object.keys(cols);
    if (keys.length <= 9) return;
    const pos = (b.entity && b.entity.position) || { x: 0, z: 0 };
    const cx = Math.floor(pos.x / 16);
    const cz = Math.floor(pos.z / 16);
    keys.map((k) => {
      const [x, z] = k.split(',').map(Number);
      return { x, z, d: (x - cx) ** 2 + (z - cz) ** 2 };
    }).sort((a, c) => a.d - c.d).slice(9).forEach((c) => {
      try { world.unloadColumn(c.x, c.z); } catch (_) {}
    });
  }

  _checkAlive() {
    if (!this.bot || this.status !== 'online') return;
    let sock = null;
    try { sock = this.bot._client && this.bot._client.socket; } catch (_) {}
    const dead = !sock || sock.destroyed || sock.readyState === 'closed' || sock.readyState === 'closing';
    if (!dead) return;
    this.addLog('warn', 'Connection dropped silently — restarting the session.');
    this.setStatus('reconnecting', 'Connection lost');
    let ended = false;
    try { this.bot.once('end', () => { ended = true; }); } catch (_) {}
    try { this.bot.end(); } catch (_) {}
    // If mineflayer never emits end, force a fresh session ourselves.
    this._later(() => {
      if (ended || !this.wanted) return;
      if (this.status === 'reconnecting' && this.bot) {
        this.addLog('warn', 'Reconnect watchdog: forcing a fresh session.');
        try { this.bot.end(); } catch (_) {}
        this.bot = null;
        this._scheduleReconnect(this._guardKicked ? 30000 : 3000);
      }
    }, 5000);
  }

  _stopAfk() {
    if (this._afkTimer) { clearInterval(this._afkTimer); this._afkTimer = null; }
    this._cancelAfkSequence();
  }

  // Cancel the /afk → countdown → arena walk sequence and release movement.
  _cancelAfkSequence() {
    if (this._afkTeleportTimer) { clearInterval(this._afkTeleportTimer); this._afkTeleportTimer = null; }
    if (this._afkWalkTimer) { clearInterval(this._afkWalkTimer); this._afkWalkTimer = null; }
    this._afkWalkPaused = false;
    if (this._afkSequence && !this._afkSequence.walked && this.bot) {
      try { this.bot.clearControlState('forward'); } catch (_) {}
    }
    if (this.bot && this.bot.pathfinder) {
      try { this.bot.pathfinder.setGoal(null); } catch (_) {}
    }
    this._afkSequence = null;
    this._afkMovements = null;
    this._inAfkArena = false;
  }

  // ── lifecycle ──
  start() {
    if (this.wanted && this.bot) return;
    this.wanted = true;
    this._loginGaveUp = false;
    this._permanentBan = false;
    this._pauseLogged = false;
    this._proxyTries = 0;
    this.addLog('info', 'Starting bot…');
    this._connect();
  }

  stop(reason = 'Stopped by user') {
    if (this._gateTimer) { clearTimeout(this._gateTimer); this._gateTimer = null; }
    this._retries = 0;
    this._proxyTries = 0;
    this._rateLimitedUntil = 0;
    this.wanted = false;
    this._clearTimers();
    this._stopAfk();
    this._verifying = false;
    try { if (this.bot) this.bot.quit(reason); } catch (_) {}
    this.bot = null;
    this.proxy = null;
    this.proxySince = null;
    this.connectedAt = null;
    this.joinedAt = null;
    this.nextRetryAt = null;
    this.loggedIn = false;
    this.players = 0;
    this.health = null;
    this.food = null;
    this.position = null;
    this.ping = null;
    this.setStatus('stopped', 'Stopped');
    this.addLog('warn', reason);
  }

  restart() {
    this.addLog('info', 'Restarting bot…');
    const wasWanted = true;
    this.stop('Restarting…');
    this.wanted = wasWanted;
    this._permanentBan = false;
    this._pauseLogged = false;
    this._later(() => this._connect(), 700);
  }

  /**
   * Choose an egress route, then dial. Every bot is routed through a proxy —
   * there is no direct fallback, so the host's real IP is never exposed. A
   * dead route is retried with a fresh proxy instead.
   */
  _connect(slotTaken) {
    if (!this.wanted) return;
    if (this._gateTimer) { clearTimeout(this._gateTimer); this._gateTimer = null; }
    if (!slotTaken) {
      const wait = takeConnectSlot();
      if (wait > 0) {
        this.setStatus('connecting', 'Waiting for a connect slot…');
        this._gateTimer = setTimeout(() => {
          this._gateTimer = null;
          if (this.wanted) this._connect(true);
        }, wait);
        return;
      }
    }
    const gen = (this._gen = (this._gen || 0) + 1);
    // Webshare tunnels dial this bot's own host:port, so the public pool's
    // validation target is irrelevant while the rotating provider is active.
    if (!proxyPool.webshareActive() && this.host && proxyPool.target
        && proxyPool.target.host !== this.host) {
      this.addLog('info', `Verifying proxy routes against ${this.host}…`);
      proxyPool.setTarget(this.host, this.port);
    }
    // No direct path: local/private targets are no longer an exception, so a
    // bot can never dial out with the host's real IP.
    const px = proxyPool.pick(this.id, this.name);
    if (!px) {
      this.addLog('warn', 'No proxy route available — waiting for a route instead of connecting direct.');
      this.setStatus('reconnecting', 'Waiting for a proxy route…');
      this._scheduleReconnect(5000);
      return;
    }

    const routeLabel = px.virtual ? 'Webshare tunnel' : `${px.ip}:${px.port}`;
    this.setStatus('connecting', px.virtual ? 'Opening Webshare tunnel…' : `Opening proxy ${px.ip}…`);
    this.addLog('info', px.virtual
      ? 'Routing through Webshare — fresh IP per bot…'
      : `Routing through ${routeLabel} (${px.latency} ms)…`);
    proxyPool.open(px, this.host, this.port, 9000).then((socket) => {
      if (!this.wanted || gen !== this._gen) { try { socket.destroy(); } catch (_) {} return; }
      proxyPool.reportOk(px);
      this._connectNow(px, socket);
    }).catch((err) => {
      if (!this.wanted || gen !== this._gen) return;
      proxyPool.reportFailure(px);
      // Drop the dead pin so the next attempt cannot reuse the same address.
      proxyPool.release(this.id);
      const why = clean(err && err.message || err, 80);
      this._proxyTries++;
      // A rotating tunnel is retried even when the public pool is empty —
      // otherwise a fresh-IP route would be skipped on the first failure.
      if (this._proxyTries < 3 && px && (px.virtual || proxyPool.summary().total)) {
        this.addLog('warn', `${routeLabel} unreachable (${why}) — trying another route.`);
        this._later(() => this._connect(), 600);
        return;
      }
      this._proxyTries = 0;
      this.addLog('warn', `${routeLabel} unreachable (${why}) — no direct fallback; retrying with a fresh proxy.`);
      this._scheduleReconnect(4000 + Math.floor(Math.random() * 3000));
    });
  }

  _connectNow(proxy, socket) {
    if (!this.wanted) return;
    this._clearTimers();
    this._stopAfk();
    this._guardKicked = false;
    this._sawKick = false;
    this._loginPromptSeen = false;
    this._loginCooldown = 0;
    this._loginGaveUp = false;
    this._pendingAuthText = '';
    this._firstSpawn = true;
    this.loggedIn = false;
    this.loginAttempts = 0;
    this.switched = false;
    this.lastError = '';
    this.connectedAt = null;
    this.joinedAt = null;
    this.nextRetryAt = null;
    this.setStatus('connecting', `Connecting to ${this.host}:${this.port}…`);
    this.addLog('info', `Connecting to ${this.host}:${this.port} as ${this.name}…`);

    const opts = {
      host: this.host,
      port: this.port,
      username: this.name,
      auth: 'offline',
      hideErrors: true,
      logErrors: false,
      checkTimeoutInterval: 60000,
      // Small render distance = far fewer chunks decoded and stored per bot.
      viewDistance: LIGHT_OPTIONS.viewDistance,
      // Pathfinder is loaded per bot (the library itself stays lazy at idle).
      plugins: Object.assign({}, LIGHT_OPTIONS.plugins, { pathfinder: getPathfinder().pathfinder }),
    };
    if (this.version && this.version !== 'auto') opts.version = this.version;
    if (socket) {
      // minecraft-protocol calls options.connect(client) *before* it registers
      // the handshake plugin. The proxy socket is already connected, so its
      // own 'connect' event never fires again — emit on the next tick, after
      // setProtocol is installed. Emitting synchronously sends no handshake
      // and the server closes the idle tunnel ("socketClosed").
      opts.connect = (client) => {
        try {
          client.setSocket(socket);
          setImmediate(() => {
            try { if (!client.ended) client.emit('connect'); } catch (_) {}
          });
        } catch (e) { try { client.emit('error', e); } catch (_) {} }
      };
    }
    this.proxy = proxy ? {
      ip: proxy.ip, port: proxy.port, latency: proxy.latency,
      key: proxy.key || (proxy.ip + ':' + proxy.port),
      virtual: !!proxy.virtual, protocol: proxy.protocol || 'socks5',
    } : null;
    this.proxySince = proxy ? now() : null;

    let bot;
    try {
      bot = getMineflayer().createBot(opts);
    } catch (e) {
      this.lastError = e.message || String(e);
      this.addLog('err', `Could not create bot: ${this.lastError}`);
      this.setStatus('error', 'Connection failed');
      this._scheduleReconnect(10000);
      return;
    }
    this.bot = bot;
    guardReconfigPackets(bot);

    // Join watchdog — a silent hang should retry instead of sitting forever.
    this._watchdog = setTimeout(() => {
      if (!this.bot || this.connectedAt) return;
      this.addLog('warn', 'Join timed out — retrying.');
      try { this.bot.end(); } catch (_) {}
    }, 45000);

    try {
      if (bot._client && typeof bot._client.on === 'function') {
        bot._client.on('end', () => {
          if (this.status === 'online') {
            this.addLog('warn', 'Socket closed by the server — reconnecting.');
            this.setStatus('reconnecting', 'Connection lost');
          }
        });
      }
    } catch (_) {}

    bot.on('spawn', () => {
      const firstSpawn = this._firstSpawn;
      this._firstSpawn = false;
      this.connectedAt = this.connectedAt || now();
      if (firstSpawn) this.joinedAt = now();
      if (this.proxy) proxyPool.reportOk(this.proxy);
      if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
      this.nextRetryAt = null;
      this._retries = 0;
      this._proxyTries = 0;
      this._throttleHits = 0;
      this._rateLimitedUntil = 0;
      this._bannedUntil = 0;
      this._banText = '';
      this._permanentBan = false;
      this._pauseLogged = false;
      this._lastKick = '';
      this.setStatus('online', 'Online');
      this.addLog('ok', `Joined ${this.host}:${this.port} as ${this.name}`);

      this._startAfk();
      this._startAliveWatch();
      this._refresh(true);
      this._later(() => this._maybeEat(), 2600);
      this._scheduleSwitchFallback();

      // The auth prompt often arrives before the first spawn (server sends it
      // immediately on join). Replay it now that bot.player exists.
      if (this.autoLogin && this._pendingAuthText) {
        const pending = this._pendingAuthText;
        this._pendingAuthText = null;
        this._later(() => this._tryLogin(pending), 250);
      }

      // Give the server a moment, then be ready for auth prompts.
      if (this.autoLogin) {
        this._later(() => {
          if (this.wanted && this.bot && this.bot.player && !this.loggedIn) {
            this.addLog('info', 'Waiting for a /login prompt…');
          }
        }, 1200);
      }

      if (!firstSpawn) this.addLog('info', 'Spawned again (sub-server transfer).');
      // A dimension/world change after the AFK countdown is a teleport signal.
      if (this._afkSequence && !this._afkSequence.teleported && !this._afkSequence.walked && now() - this._afkSequence.armedAt > 4000) {
        this._afkTeleportDetected('world change');
      }
    });

    bot.on('death', () => {
      this.addLog('warn', 'Bot died — respawning.');
    });

    bot.on('kicked', (reason) => {
      this._sawKick = true;
      this._lastKick = chatText(reason) || stripColor(String(reason || ''));
    });

    bot.on('messagestr', (message) => this._onMessage(message));

    bot.on('whisper', (username, message) => {
      this.addLog('chat', `[whisper] ${username}: ${message}`);
    });

    bot.on('death', () => {
      this.addLog('warn', 'Bot died — respawning automatically.');
      this._refresh(true);
    });

    bot.on('health', () => { this._refresh(); this._maybeEat(); });

    // AFK GUIs: some servers open a chest-style menu shortly after /afk.
    // When armed (see sendChat), click its first slot automatically.
    bot.on('windowOpen', (window) => this._onWindowOpen(window));

    // Sidebar scoreboard updates — keep the panel tracker live.
    ['scoreUpdated', 'scoreRemoved', 'scoreboardTitleChanged', 'scoreboardCreated', 'scoreboardDeleted', 'scoreboardPosition'].forEach((ev) => {
      try { bot.on(ev, () => this._refresh(true)); } catch (_) {}
    });

    // Keep the player count fresh without flooding the console with the
    // server's join/leave spam (NPC shop/auction bots churn constantly).
    bot.on('playerJoined', () => this._refresh(true));
    bot.on('playerLeft', () => this._refresh(true));

    bot.on('kicked', (reason) => {
      const r = (chatText(reason) || stripColor(String(reason || ''))).slice(0, 600);
      if (/banned/i.test(r)) {
        this._banText = stripColor(r).replace(/\s+/g, ' ').trim().slice(0, 400);
        // A staff ban is not a cooldown. Stop retrying forever and let the
        // user resolve it through the server's appeal channel.
        this._permanentBan = /permanently banned|ip-banned by an operator|appeal at/i.test(r);
        this._bannedUntil = this._permanentBan ? 0 : now() + 30 * 60 * 1000;
        blockConnectGate(120000);
        // Some servers send the kick packet but leave the socket open. Close it
        // ourselves so the ban settles immediately instead of looking like a
        // generic join timeout.
        this._later(() => { try { if (this.bot) this.bot.end('Banned by server'); } catch (_) {} }, 300);
      }
      if (/slow down|connecting too quickly|too many connections|rate.?limit|throttl|too fast|try again later|too many login/i.test(r)) {
        this._throttleHits = (this._throttleHits || 0) + 1;
        const steps = [180000, 360000, 600000, 900000, 1200000];
        const wait = steps[Math.min(this._throttleHits - 1, steps.length - 1)] + Math.floor(Math.random() * 45000);
        this._rateLimitedUntil = now() + wait;
        // Keep the entire fleet quiet too — every extra attempt extends the block.
        blockConnectGate(wait);
      }
      const short = r.length > 220 ? r.slice(0, 217) + '…' : r;
      let label = 'Kicked — reconnecting';
      if (/verification failed|verify/i.test(r)) label = 'Server verification failed';
      else if (/blocked from entering/i.test(r)) label = 'Temporarily blocked by server';
      else if (/banned/i.test(r)) label = 'Banned by server';
      else if (/slow down|too quickly|throttl/i.test(r)) label = 'Server rate-limited joins';
      this.setStatus('reconnecting', label);
      this.lastError = short || this.lastError;
      this.addLog('err', `Server rejected the login: ${short || 'no reason given'}`);
      if (/guard|bot verification|failed.*verif/i.test(r)) {
        this._guardKicked = true;
      }
    });

    bot.on('error', (err) => {
      const code = err && err.code;
      const msg = clean((err && err.message) || err, 300);
      this.lastError = msg;
      if (OFFLINE_CODES.includes(code)) {
        this.addLog('warn', `Server unreachable (${code}).`);
      } else {
        this.addLog('err', `Error: ${msg}`);
      }
    });

    bot.on('end', () => {
      this._clearTimers();
      this._stopAfk();
      this._verifying = false;
      if (this.proxy && !this.connectedAt) proxyPool.reportFailure(this.proxy);
      this.connectedAt = null;
      this.joinedAt = null;
      this.players = 0;
      this.health = null;
      this.food = null;
      this.position = null;
      this.ping = null;
      this.loggedIn = false;
      this.switched = false;
      this.bot = null;
      this.emit();

      if (!this.wanted) {
        this.setStatus('stopped', 'Stopped');
        return;
      }
      this.addLog('warn', 'Disconnected.');
      this.setStatus('reconnecting', 'Disconnected');
      this._retries = (this._retries || 0) + 1;
      // Kick reasons are read from the tunnel itself — never retry direct,
      // even when a proxy closes before the server's reason packet arrives.
      this._sawKick = false;
      let delay;
      if (this._bannedUntil && now() < this._bannedUntil) {
        delay = (this._bannedUntil - now()) + Math.floor(Math.random() * 120000);
      } else if (this._rateLimitedUntil && now() < this._rateLimitedUntil) {
        // Politely wait out the limiter instead of feeding it.
        delay = (this._rateLimitedUntil - now()) + Math.floor(Math.random() * 15000);
      } else {
        const steps = [8000, 15000, 30000, 60000, 120000, 300000];
        delay = steps[Math.min(this._retries - 1, steps.length - 1)] + Math.floor(Math.random() * 4000);
      }
      if (this._guardKicked) delay = Math.max(delay, 30000);
      this._scheduleReconnect(delay);
    });
  }

  _scheduleReconnect(delay) {
    if (this._permanentBan) {
      this.nextRetryAt = null;
      this.setStatus('banned', 'Permanently banned — appeal required');
      if (!this._pauseLogged) {
        this._pauseLogged = true;
        this.addLog('warn', 'Auto-reconnect paused after a permanent ban. Use the appeal link in the player card — restart only after staff clears it.');
      }
      return;
    }
    if (!this.wanted || !this.autoReconnect) {
      if (this.wanted) {
        this.setStatus('offline', 'Offline (auto-reconnect off)');
        this.addLog('warn', 'Auto-reconnect is off — bot stays offline.');
      }
      return;
    }
    this.nextRetryAt = now() + delay;
    if (this._banText) {
      this.setStatus('banned', `Banned · next attempt in ${Math.max(1, Math.round(delay / 60000))} min`);
    } else {
      this.setStatus('reconnecting', `Retrying in ${Math.round(delay / 1000)}s…`);
    }
    this._later(() => {
      if (!this.wanted) return;
      this.addLog('info', 'Reconnecting…');
      this._connect();
    }, delay);
  }

  // ── auto login ──
  _onMessage(raw) {
    const message = stripColor(raw);
    // Don't flood the console with other players' join/leave spam. The bot's
    // own join/leave is already logged as a real event.
    const joinLeave = /^(?:\[\+\]|\[-\]|▶|◀)?\s*[A-Za-z0-9_.]{1,16}\s+(?:joined|left|quit)\s+(?:the\s+)?(?:server|game|lobby)\b/i.test(message);
    if (!joinLeave) this.addLog('chat', message);

    if (VERIFY_PROMPT.test(message)) {
      if (/you are being verified|please do not move.*automatic/i.test(message)) {
        this._verifying = true;
        if (this._verifyTimer) clearTimeout(this._verifyTimer);
        this._verifyTimer = setTimeout(() => { this._verifying = false; this._verifyTimer = null; }, 20000);
        this.addLog('warn', 'GUARD bot-check — pausing all actions for up to 20s.');
        return;
      }
      if (/verification.*(?:complete|passed|success)|you(?:'ve| have) passed/i.test(message)) {
        this._verifying = false;
        if (this._verifyTimer) { clearTimeout(this._verifyTimer); this._verifyTimer = null; }
        this.addLog('ok', 'GUARD verification passed.');
      }
    }
    if (this._verifying) return;

    // Server announcement confirming the arena teleport (ignore player chat).
    if (this._afkSequence && !this._afkSequence.teleported && !this._afkSequence.walked &&
        /\b(?:afk[ -]?arena|teleported successfully|teleport(?:ed)? to (?:the )?afk)\b/i.test(message) &&
        !/^[A-Za-z0-9_.]{1,16}\s*:/.test(message)) {
      this._afkTeleportDetected('server message');
    }

    // Login success?
    if (!this.loggedIn && LOGIN_SUCCESS.some((r) => r.test(message))) {
      this._loginSuccess('server confirmed');
    }

    // Auth prompt?
    if (this.autoLogin && !this.loggedIn) {
      const isPrompt = LOGIN_PROMPTS.some((r) => r.test(message)) || REGISTER_PROMPTS.some((r) => r.test(message));
      if (isPrompt) {
        if (now() - this._lastPromptAt > 3000) this.addLog('auth', `Auth prompt: ${message.slice(0, 120)}`);
        this._lastPromptAt = now();
        this._tryLogin(message);
      }
    }

    // Lobby / restart → re-switch when enabled.
    if (this.autoSwitch && (LOBBY_PROMPT.test(message) || RESTART_COUNTDOWN.test(message))) {
      if (now() - this._lobbyReswitchAt > 30000) {
        this._lobbyReswitchAt = now();
        this.addLog('warn', 'Restart/lobby detected — re-joining in 5s.');
        this._scheduleSwitch('lobby/restart', 5000);
      }
    }
  }

  _tryLogin(text) {
    if (!this.wanted || !this.autoLogin || this.loggedIn) return;
    if (!this.bot || !this.bot.player) {
      // Prompt arrived before spawn — replay it once we're in.
      this._pendingAuthText = text || '';
      return;
    }
    if (now() < this._loginCooldown) return;
    const isRegister = REGISTER_PROMPTS.some((r) => r.test(text));
    this._sendLogin(isRegister);
  }

  _sendLogin(isRegister) {
    if (!this.wanted || !this.bot || !this.bot.player || this.loggedIn) return;
    if (this.loginAttempts >= 5) {
      if (!this._loginGaveUp) {
        this._loginGaveUp = true;
        this.addLog('err', 'Auto-login failed after 5 attempts — check the password for this bot.');
      }
      return;
    }
    this.loginAttempts += 1;
    const pw = this.password || DEFAULT_MC_PASSWORD;
    const cmd = isRegister ? `/register ${pw} ${pw}` : `/login ${pw}`;
    try {
      this.bot.chat(cmd);
      this.addLog('auth', `→ ${isRegister ? '/register' : '/login'} ${mask(pw)}  (attempt ${this.loginAttempts}/5)`);
    } catch (e) {
      this.addLog('err', `Could not send login command: ${e.message || e}`);
      return;
    }
    this._loginCooldown = now() + 5000;

    if (this._loginRetry) clearTimeout(this._loginRetry);
    this._loginRetry = setTimeout(() => {
      this._loginRetry = null;
      if (this.wanted && this.bot && this.bot.player && !this.loggedIn) {
        this.addLog('warn', 'No login confirmation yet — retrying…');
        this._sendLogin(isRegister);
      }
    }, 5000);

    // Some servers never confirm. If no fresh prompt arrived after 8s, assume
    // authentication worked so the optional server-switch can still run.
    if (this._assumeLogin) clearTimeout(this._assumeLogin);
    const sentAt = now();
    this._assumeLogin = setTimeout(() => {
      this._assumeLogin = null;
      if (!this.wanted || !this.bot || !this.bot.player || this.loggedIn) return;
      if (this._lastPromptAt > sentAt) return; // a new prompt arrived — keep retrying
      this.loggedIn = true;
      this._loginGaveUp = false;
      this.addLog('info', 'No further login prompt — assuming authentication succeeded.');
      this._afterLogin();
    }, 8000);
  }

  _loginSuccess(via) {
    if (this.loggedIn) return;
    this.loggedIn = true;
    this.loginAttempts = 0;
    this._loginGaveUp = false;
    if (this._loginRetry) { clearTimeout(this._loginRetry); this._loginRetry = null; }
    if (this._assumeLogin) { clearTimeout(this._assumeLogin); this._assumeLogin = null; }
    this.addLog('ok', `Logged in${via ? ` (${via})` : ''}.`);
    this.emit();
    this._afterLogin();
  }

  _afterLogin() {
    if (this.autoSwitch) this._scheduleSwitch('after login', this.switchDelay);
  }

  // ── server switch ──
  _scheduleSwitchFallback() {
    if (!this.autoSwitch) return;
    this._scheduleSwitch('join fallback', 8000);
  }

  _scheduleSwitch(reason, delay) {
    if (!this.autoSwitch || !this.switchCommand) return;
    if (this._switchTimer) clearTimeout(this._switchTimer);
    this._switchTimer = setTimeout(() => {
      this._switchTimer = null;
      if (!this.wanted || !this.bot || !this.bot.player) return;
      // Never switch away while an auth prompt is still unresolved.
      if (this.autoLogin && this._loginPromptSeen && !this.loggedIn) {
        this.addLog('warn', 'Not switching yet — login is still pending.');
        return;
      }
      this._doSwitch(reason);
    }, delay);
  }

  _doSwitch(reason) {
    if (!this.bot || !this.bot.player) return;
    if (this.switched) return;
    try {
      this.bot.chat(this.switchCommand);
      this.switched = true;
      this.addLog('info', `Server switch → ${this.switchCommand} (${reason})`);
      this.emit();
      if (this.reswitch) this._scheduleReswitch();
    } catch (e) {
      this.addLog('err', `Server switch failed: ${e.message || e}`);
    }
  }

  _scheduleReswitch() {
    if (!this.autoSwitch || !this.reswitch) return;
    if (this._reswitchTimer) clearTimeout(this._reswitchTimer);
    const delay = 5 * 60 * 1000 + Math.floor(Math.random() * 5 * 60 * 1000);
    this._reswitchTimer = setTimeout(() => {
      this._reswitchTimer = null;
      if (this.wanted && this.bot && this.bot.player) {
        try {
          this.bot.chat(this.switchCommand);
          this.addLog('info', `Periodic re-switch → ${this.switchCommand}`);
        } catch (_) {}
      }
      this._scheduleReswitch();
    }, delay);
  }

  // ── anti-AFK ──
  // ── auto-eat ──
  _foodScore(item) {
    if (!item || !item.name) return -1;
    // Keep special/risky foods for emergencies only.
    const special = ['golden_apple', 'enchanted_golden_apple', 'chorus_fruit', 'poisonous_potato',
      'spider_eye', 'pufferfish', 'suspicious_stew', 'rotten_flesh', 'honey_bottle'];
    if (special.includes(item.name)) return -0.5;
    try {
      const reg = this.bot && this.bot.registry;
      const f = reg && reg.foodsByName ? reg.foodsByName[item.name] : null;
      if (f) {
        const quality = Number.isFinite(f.effectiveQuality) ? f.effectiveQuality : (f.foodPoints || 0) * 2;
        return quality;
      }
    } catch (_) {}
    // Fallback ranking for older registries.
    const order = ['golden_apple', 'enchanted_golden_apple', 'cooked_beef', 'cooked_porkchop',
      'cooked_mutton', 'cooked_chicken', 'cooked_salmon', 'cooked_cod', 'bread', 'baked_potato',
      'pumpkin_pie', 'carrot', 'apple', 'sweet_berries', 'beef', 'porkchop', 'mutton', 'chicken',
      'salmon', 'cod', 'potato', 'melon_slice', 'cookie', 'rotten_flesh'];
    const i = order.indexOf(item.name);
    return i >= 0 ? 100 - i : -1;
  }

  _maybeEat() {
    if (!this.autoEat || this._eating) return;
    const b = this.bot;
    if (!b || !b.player || typeof b.food !== 'number') return;
    if (b.food > 14) return;
    let foods = [];
    try {
      foods = (b.inventory.items() || [])
        .map((it) => ({ it, score: this._foodScore(it) }))
        .filter((x) => x.score >= -0.5);
    } catch (_) {}
    if (!foods.length) {
      if (!this._eatWarned) {
        this._eatWarned = true;
        this.addLog('warn', `Auto-eat: food is ${b.food}/20 but there is nothing to eat in the inventory.`);
      }
      return;
    }
    foods.sort((x, y) => y.score - x.score);
    const target = foods[0].it;
    this._eating = true;
    Promise.resolve()
      .then(() => b.equip(target, 'hand'))
      .then(() => b.consume())
      .then(() => this.addLog('ok', `Auto-eat: ate ${target.displayName || target.name} (food ${b.food}/20).`))
      .catch((e) => this.addLog('warn', `Auto-eat failed: ${(e && e.message) || e}`))
      .finally(() => {
        this._eating = false;
        this._eatWarned = false;
        this._refresh(true);
      });
  }

  _startAfk() {
    if (!this.antiAfk || this._afkTimer) return;
    let step = 0;
    this._afkTimer = setInterval(() => {
      if (!this.bot || !this.bot.entity) return;
      if (this._verifying || this._afkWalkPaused) return;
      try {
        this.bot.swingArm('right');
        this.bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.6, false);
        if (step % 2 === 0) {
          this.bot.setControlState('jump', true);
          setTimeout(() => { try { this.bot.setControlState('jump', false); } catch (_) {} }, 350);
        }
        step++;
      } catch (_) {}
    }, 8000);
  }

  // ── live stats ──
  _refresh(force = false) {
    if (!this.bot) return;
    if (!force && now() - this._refreshAt < 1500) return;
    this._refreshAt = now();
    try {
      this.players = Object.keys(this.bot.players || {}).length;
      if (typeof this.bot.health === 'number') this.health = Math.round(this.bot.health);
      if (typeof this.bot.food === 'number') this.food = Math.round(this.bot.food);
      if (this.bot.entity && this.bot.entity.position) {
        const p = this.bot.entity.position;
        this.position = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
      }
      // Velocity/HungryBirds reports 0 for tab-list latency. Zero is not a
      // measured round trip, so keep it as "no data" instead of showing a
      // fake 0 ms / excellent connection in the panel.
      const tabPing = this.bot.player && this.bot.player.ping;
      this.ping = typeof tabPing === 'number' && Number.isFinite(tabPing) && tabPing > 0 ? Math.round(tabPing) : null;
    } catch (_) {}
    this.emit();
  }

  // ── actions from the dashboard ──
  sendChat(text) {
    const msg = clean(text, 250).trim();
    if (!msg) throw new Error('Message is empty.');
    if (!this.bot || !this.bot.player) throw new Error('Bot is not connected.');
    this.bot.chat(msg);
    this.addLog('sent', msg);
    // /afk usually opens a chest-style GUI a few seconds later — arm the click.
    if (/^\/afk\b/i.test(msg)) {
      this._afkClickUntil = now() + 20000;
      this.addLog('info', 'AFK armed — the first slot of the GUI that opens will be clicked automatically.');
    }
  }

  _onWindowOpen(window) {
    if (!window || now() > this._afkClickUntil) return;
    this._afkClickUntil = 0;
    let title = '';
    try { title = stripColor(chatText(window.title) || String(window.title || '')).slice(0, 80); } catch (_) {}
    this.addLog('info', `AFK GUI opened${title ? `: ${title.slice(0, 60)}` : ''} — clicking slot 1 in 0.4s.`);
    if (this._afkClickTimer) clearTimeout(this._afkClickTimer);
    this._afkClickTimer = setTimeout(() => {
      this._afkClickTimer = null;
      if (!this.bot) return;
      try {
        this.bot.clickWindow(0, 0, 0);
        this.addLog('ok', 'AFK: clicked the first slot automatically.');
        this._startAfkSequence();
      } catch (e) {
        this.addLog('err', `AFK auto-click failed: ${e.message || e}`);
      }
    }, 400);
  }

  // ── /afk → GUI click → countdown → arena → one random walk ──
  // Movement is plain walking. No block is mined, dug or placed.
  _startAfkSequence() {
    this._cancelAfkSequence();
    const p = this.bot && this.bot.entity && this.bot.entity.position;
    const dim = this.bot && this.bot.game && this.bot.game.dimension;
    this._afkSequence = {
      armedAt: now(),
      origin: p ? { x: p.x, y: p.y, z: p.z } : null,
      dimension: dim == null ? null : dim,
      teleported: false,
      walked: false,
    };
    this.addLog('info', 'AFK: countdown 5 → 4 → 3 → 2 → 1, waiting for the arena teleport.');
    for (let n = 5; n >= 1; n--) {
      this._later(() => {
        const seq = this._afkSequence;
        if (!seq || seq.teleported) return;
        this.addLog('info', `AFK: ${n}`);
        if (n === 1) this._watchAfkTeleport();
      }, (6 - n) * 1000);
    }
  }

  _watchAfkTeleport() {
    const seq = this._afkSequence;
    if (!seq || seq.teleported || this._afkTeleportTimer) return;
    const deadline = now() + AFK_TELEPORT_WATCH_MS;
    this._afkTeleportTimer = setInterval(() => {
      const s = this._afkSequence;
      if (!s) { this._cancelAfkSequence(); return; }
      if (!this.bot || !this.bot.entity) return;
      const p = this.bot.entity.position;
      let moved = 0;
      let height = 0;
      if (s.origin) {
        moved = Math.hypot(p.x - s.origin.x, p.z - s.origin.z);
        height = Math.abs(p.y - s.origin.y);
      }
      const dim = this.bot.game && this.bot.game.dimension;
      const dimChanged = s.dimension != null && dim != null && dim !== s.dimension;
      if (moved >= 10 || height >= 8 || dimChanged) {
        this._afkTeleportDetected(moved >= 10 ? `moved ${moved.toFixed(1)} blocks` : dimChanged ? 'world changed' : 'height changed');
        return;
      }
      if (now() > deadline) {
        this._cancelAfkSequence();
        this.addLog('warn', 'AFK: no arena teleport detected — skipping the one-time move.');
      }
    }, 500);
  }

  _afkTeleportDetected(reason) {
    const seq = this._afkSequence;
    if (!seq || seq.teleported || seq.walked) return;
    seq.teleported = true;
    this._inAfkArena = true;
    if (this.status === 'online') this.setStatus('online', 'AFK arena');
    if (this._afkTeleportTimer) { clearInterval(this._afkTeleportTimer); this._afkTeleportTimer = null; }
    this.addLog('ok', `AFK: arena reached (${reason}) — moving ${AFK_WALK_MIN}–${AFK_WALK_MAX} blocks in a random direction once.`);
    this._later(() => this._afkWalkOnce(), 1500);
  }

  _afkWalkOnce() {
    const seq = this._afkSequence;
    if (!seq || !seq.teleported || seq.walked || !this.bot || !this.bot.entity) return;
    seq.walked = true;
    this._afkWalkPaused = true;
    this._afkTarget = AFK_WALK_MIN + Math.floor(Math.random() * (AFK_WALK_MAX - AFK_WALK_MIN + 1));
    this._afkWalkMoved = 0;
    this._afkWalkLegs = 0;
    this._afkWalkDeadline = now() + 30000;
    this.addLog('info', `AFK arena: pathfinding ${this._afkTarget} blocks in random directions (no mining).`);
    this._nextAfkPath();
  }

  // One short pathfinder leg to a random nearby goal. canDig is forced off so
  // the bot only walks — it never mines, digs or places a block.
  _nextAfkPath() {
    const b = this.bot;
    if (!b || !b.entity || !b.pathfinder) { this._finishAfkWalk('pathfinder unavailable'); return; }
    if (this._afkWalkMoved >= this._afkTarget) {
      this._finishAfkWalk(`${this._afkWalkMoved.toFixed(1)} blocks in ${this._afkWalkLegs} path${this._afkWalkLegs === 1 ? '' : 's'}`);
      return;
    }
    if (this._afkWalkLegs >= 6 || now() > this._afkWalkDeadline) {
      this._finishAfkWalk(`${this._afkWalkMoved.toFixed(1)} of ${this._afkTarget} blocks (arena limit)`);
      return;
    }
    this._afkWalkLegs++;
    const lib = getPathfinder();
    if (!this._afkMovements) {
      this._afkMovements = new lib.Movements(b);
      this._afkMovements.canDig = false;
      this._afkMovements.allowSprinting = false;
      this._afkMovements.maxDropDown = 1;
    }
    const start = { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z };
    const dist = Math.min(this._afkTarget - this._afkWalkMoved, 3 + Math.floor(Math.random() * 4));
    this._afkLegTarget = dist;
    const angle = Math.random() * Math.PI * 2;
    const goal = new lib.goals.GoalNear(
      Math.round(start.x + Math.sin(angle) * dist),
      Math.round(b.entity.position.y),
      Math.round(start.z + Math.cos(angle) * dist),
      1
    );
    let settled = false;
    const legDone = () => {
      if (settled) return;
      settled = true;
      if (this._afkWalkTimer) { clearTimeout(this._afkWalkTimer); this._afkWalkTimer = null; }
      const p = this.bot && this.bot.entity && this.bot.entity.position;
      const moved = p ? Math.hypot(p.x - start.x, p.z - start.z) : 0;
      // The server can relocate the bot mid-leg (AFK arena, minigame lobby,
      // etc.). That jump is not walking — never count it as movement distance.
      if (moved > (this._afkLegTarget || 6) + 3 || (p && Math.abs(p.y - start.y) > 4)) {
        this._finishAfkWalk(`${this._afkWalkMoved.toFixed(1)} blocks (server teleported mid-walk — jump ignored)`);
        return;
      }
      this._afkWalkMoved += moved;
      if (this._afkWalkMoved >= this._afkTarget) {
        this._finishAfkWalk(`${this._afkWalkMoved.toFixed(1)} blocks in ${this._afkWalkLegs} path${this._afkWalkLegs === 1 ? '' : 's'}`);
        return;
      }
      if (this._afkWalkLegs >= 6 || now() > this._afkWalkDeadline) {
        this._finishAfkWalk(`${this._afkWalkMoved.toFixed(1)} of ${this._afkTarget} blocks (arena limit)`);
        return;
      }
      this._later(() => this._nextAfkPath(), 300);
    };
    try {
      b.pathfinder.setMovements(this._afkMovements);
      Promise.resolve(b.pathfinder.goto(goal)).then(legDone, legDone);
    } catch (_) { legDone(); return; }
    this._afkWalkTimer = setTimeout(() => {
      try { b.pathfinder.setGoal(null); } catch (_) {}
      legDone();
    }, 6000);
  }

  _finishAfkWalk(reason) {
    if (this._afkWalkTimer) { clearTimeout(this._afkWalkTimer); this._afkWalkTimer = null; }
    this._afkWalkPaused = false;
    try { if (this.bot && this.bot.pathfinder) this.bot.pathfinder.setGoal(null); } catch (_) {}
    try {
      if (this.bot) {
        this.bot.clearControlState('forward');
        this.bot.clearControlState('sprint');
      }
    } catch (_) {}
    this.addLog('ok', `AFK arena: pathfind walk finished — ${reason}.`);
  }

  switchNow() {
    if (!this.bot || !this.bot.player) throw new Error('Bot is not connected.');
    this.bot.chat(this.switchCommand);
    this.addLog('info', `Server switch → ${this.switchCommand} (manual)`);
  }

  loginNow() {
    if (!this.bot || !this.bot.player) throw new Error('Bot is not connected.');
    this.loggedIn = false;
    this.loginAttempts = 0;
    this._loginGaveUp = false;
    this._loginCooldown = 0;
    this._sendLogin(false);
  }

  updateConfig(patch) {
    const connectionChanged = ['name', 'host', 'port', 'version'].some((k) => patch[k] !== undefined && patch[k] !== this[k]);
    if (patch.name !== undefined) this.name = patch.name;
    if (patch.host !== undefined) this.host = patch.host;
    if (patch.port !== undefined) this.port = patch.port;
    if (patch.version !== undefined) this.version = patch.version;
    if (patch.password !== undefined) this.password = patch.password;
    if (patch.autoLogin !== undefined) this.autoLogin = !!patch.autoLogin;
    if (patch.autoSwitch !== undefined) this.autoSwitch = !!patch.autoSwitch;
    if (patch.switchCommand !== undefined) this.switchCommand = patch.switchCommand;
    if (patch.switchDelay !== undefined) this.switchDelay = clamp(Number(patch.switchDelay) || 4000, 1000, 60000);
    if (patch.autoReconnect !== undefined) this.autoReconnect = !!patch.autoReconnect;
    if (patch.antiAfk !== undefined) {
      this.antiAfk = !!patch.antiAfk;
      if (!this.antiAfk) this._stopAfk();
      else if (this.status === 'online') this._startAfk();
    }
    if (patch.autoEat !== undefined) this.autoEat = !!patch.autoEat;
    if (patch.reswitch !== undefined) this.reswitch = !!patch.reswitch;
    if (patch.groupIds !== undefined && Array.isArray(patch.groupIds)) this.groupIds = patch.groupIds.slice(0, 50);
    if (connectionChanged && (this.wanted || this.status === 'online')) {
      this.addLog('info', 'Connection settings changed — restarting bot.');
      this.restart();
    } else {
      this.emit();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Config validation + persistence
// ─────────────────────────────────────────────────────────────────────────────
function normalizeConfig(input, existing) {
  const src = Object.assign({}, existing || {}, input || {});
  const name = clean(src.name, 16).trim();
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) {
    throw new Error('Player name must be 1–16 characters: letters, numbers or underscore.');
  }
  let host = clean(src.host, 253).trim().toLowerCase();
  host = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!host || !/^[a-z0-9._-]+$/i.test(host)) {
    throw new Error('Server IP / host looks invalid.');
  }
  const port = clamp(parseInt(src.port, 10) || 25565, 1, 65535);
  let version = clean(src.version, 20).trim() || '1.21.11';
  if (/^auto$/i.test(version)) version = 'auto';
  const password = clean(src.password == null ? DEFAULT_MC_PASSWORD : src.password, 64).trim();
  if (!password) throw new Error('Password cannot be empty.');
  const switchCommand = clean(src.switchCommand == null ? '/server oneblock' : src.switchCommand, 100).trim() || '/server oneblock';
  return {
    name,
    host,
    port,
    version,
    password,
    autoLogin: src.autoLogin !== false,
    autoSwitch: !!src.autoSwitch,
    switchCommand,
    switchDelay: clamp(parseInt(src.switchDelay, 10) || 4000, 1000, 60000),
    autoReconnect: src.autoReconnect !== false,
    antiAfk: !!src.antiAfk,
    autoEat: src.autoEat !== false,
    reswitch: !!src.reswitch,
    groupIds: Array.isArray(src.groupIds) ? src.groupIds.filter((id) => typeof id === 'string').slice(0, 50) : [],
  };
}

function loadStore() {
  ensureDir(DATA_DIR);
  try {
    const raw = JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.bots;
    const bots = Array.isArray(list) ? list.filter((b) => b && b.id && b.name && b.host).map((b) => {
      try {
        return Object.assign(normalizeConfig(b, b), {
          id: b.id,
          createdAt: b.createdAt || now(),
          desiredOn: !!b.desiredOn,
        });
      } catch (_) {
        return null;
      }
    }).filter(Boolean) : [];
    const groups = Array.isArray(raw && raw.groups) ? raw.groups.filter((g) => g && g.id && g.name).map((g) => ({
      id: g.id,
      name: clean(g.name, 40).trim() || 'Group',
      color: /^#[0-9a-f]{6}$/i.test(g.color) ? g.color : '#46e08a',
      botIds: Array.isArray(g.botIds) ? g.botIds.filter((id) => typeof id === 'string') : [],
      createdAt: g.createdAt || now(),
    })) : [];
    return { bots, groups };
  } catch (_) {
    return { bots: [], groups: [] };
  }
}

function saveConfigs() {
  try {
    ensureDir(DATA_DIR);
    const data = {
      savedAt: new Date().toISOString(),
      bots: Array.from(manager.bots.values()).map((b) => b.config()),
      groups: Array.from(manager.groups.values()).map((g) => ({
        id: g.id,
        name: g.name,
        color: g.color,
        botIds: g.botIds.slice(),
        createdAt: g.createdAt,
      })),
    };
    const tmp = BOTS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, BOTS_FILE);
  } catch (e) {
    log('save failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Inventory helpers
// ─────────────────────────────────────────────────────────────────────────────
function itemJson(it) {
  if (!it) return null;
  let displayName = it.displayName;
  if (displayName && typeof displayName.toString === 'function' && typeof displayName !== 'string') {
    try { displayName = displayName.toString(); } catch (_) { displayName = it.name; }
  }
  const enchants = Array.isArray(it.enchants)
    ? it.enchants.map((e) => ({ name: e.name, lvl: e.lvl })).filter((e) => e && e.name)
    : [];
  return {
    name: it.name,
    displayName: String(displayName || it.name || 'Item'),
    count: it.count || 1,
    slot: typeof it.slot === 'number' ? it.slot : null,
    maxDurability: it.maxDurability || 0,
    durabilityUsed: it.durabilityUsed || 0,
    enchants,
  };
}

function inventorySnapshot(bot) {
  if (!bot || !bot.inventory) return null;
  const slots = bot.inventory.slots || [];
  const at = (i) => itemJson(slots[i]);
  const main = Array.from({ length: 27 }, (_, i) => at(9 + i));
  const hotbar = Array.from({ length: 9 }, (_, i) => at(36 + i));
  const armor = [at(5), at(6), at(7), at(8)];
  const offhand = at(45);
  const craft = [at(1), at(2), at(3), at(4)];
  const craftResult = at(0);
  const storage = [...main, ...hotbar].filter(Boolean);
  return {
    main,
    hotbar,
    armor,
    offhand,
    craft,
    craftResult,
    selected: Number.isInteger(bot.quickBarSlot) ? bot.quickBarSlot : 0,
    held: itemJson(bot.heldItem),
    used: storage.length,
    total: 36,
    empty: Math.max(0, 36 - storage.length),
  };
}

function inventoryPreview(bot) {
  const out = [];
  let used = 0;
  try {
    if (!bot || !bot.inventory) return { items: out, used };
    const slots = bot.inventory.slots || [];
    for (let i = 36; i < 45 && out.length < 8; i++) if (slots[i]) out.push(itemJson(slots[i]));
    for (let i = 9; i < 36 && out.length < 8; i++) if (slots[i]) out.push(itemJson(slots[i]));
    for (let i = 9; i <= 44; i++) if (slots[i]) used++;
  } catch (_) {}
  return { items: out, used };
}

function armorPreview(bot) {
  try {
    const slots = bot && bot.inventory ? bot.inventory.slots : [];
    return [5, 6, 7, 8].map((i) => itemJson(slots[i]));
  } catch (_) { return [null, null, null, null]; }
}

function scoreboardSnapshot(bot) {
  try {
    const positions = bot && bot.scoreboard;
    if (!positions) return null;
    // Prefer the sidebar, but some servers only publish to list/belowName.
    const sb = positions.sidebar || positions.list || positions.belowName;
    if (!sb) return null;
    const title = chatText(sb.title) || 'Scoreboard';
    const items = (sb.items || []).slice(0, 24).map((it) => {
      let label = it.name;
      try { if (it.displayName && typeof it.displayName.toString === 'function') label = it.displayName.toString(); } catch (_) {}
      const clean = chatText(label);
      if (!clean) return null;
      // Sidebar labels usually carry the real value (Money 1K, Shards 537).
      const m = clean.match(/^(.*?)([\d,.]+)\s*([KMB])?\s*$/i);
      let amount = null;
      let amountText = '';
      let nameLabel = clean.replace(/^[^A-Za-z0-9$]+/, '').trim() || clean;
      if (m && m[2]) {
        let n = parseFloat(m[2].replace(/,/g, ''));
        if (Number.isFinite(n)) {
          const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[3] || '').toUpperCase()] || 1;
          amount = Math.round(n * mult);
          amountText = `${m[2]}${m[3] || ''}`.trim();
          nameLabel = (m[1] || '').replace(/^[^A-Za-z0-9$]+/, '').trim() || clean;
        }
      }
      return {
        name: it.name,
        value: Number(it.value) || 0,
        label: clean,
        nameLabel,
        player: (() => {
          try { if (it.displayName && typeof it.displayName.toString === 'function') {
            const pn = chatText(it.displayName.toString());
            if (pn) return pn;
          } } catch (_) {}
          return chatText(it.name);
        })(),
        amount,
        amountText,
      };
    }).filter(Boolean);
    return { title, items };
  } catch (_) { return null; }
}

function playerList(bot) {
  try {
    const self = bot && bot.username;
    const list = Object.values((bot && bot.players) || {}).map((p) => {
      let name = p.username || '';
      if (!name && p.displayName && typeof p.displayName.toString === 'function') {
        try { name = p.displayName.toString(); } catch (_) { name = ''; }
      }
      return {
        name,
        uuid: p.uuid || null,
        ping: typeof p.ping === 'number' ? p.ping : null,
        gamemode: p.gamemode != null ? String(p.gamemode) : null,
      };
    }).filter((p) => p.name && p.name !== self);
    list.sort((a, b) => (a.ping == null ? 9999 : a.ping) - (b.ping == null ? 9999 : b.ping) || a.name.localeCompare(b.name));
    return list.slice(0, 120);
  } catch (_) { return []; }
}

function offhandPreview(bot) {
  try {
    const slots = bot && bot.inventory ? bot.inventory.slots : [];
    return itemJson(slots[45]);
  } catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Groups
// ─────────────────────────────────────────────────────────────────────────────
function normalizeGroup(input, existing) {
  const src = Object.assign({}, existing || {}, input || {});
  const name = clean(src.name, 40).trim();
  if (!name) throw new Error('Group name is required.');
  const color = /^#[0-9a-f]{6}$/i.test(String(src.color || '')) ? String(src.color).toLowerCase() : '#46e08a';
  const botIds = Array.isArray(src.botIds)
    ? Array.from(new Set(src.botIds.filter((id) => typeof id === 'string')))
    : [];
  return { name, color, botIds };
}

function publicGroup(g) {
  const bots = g.botIds.map((id) => manager.bots.get(id)).filter(Boolean);
  return {
    id: g.id,
    name: g.name,
    color: g.color,
    botIds: g.botIds.filter((id) => manager.bots.has(id)),
    createdAt: g.createdAt,
    total: bots.length,
    online: bots.filter((b) => b.status === 'online').length,
    connecting: bots.filter((b) => b.status === 'connecting' || b.status === 'reconnecting').length,
    players: bots.reduce((n, b) => n + (b.status === 'online' ? b.players : 0), 0),
  };
}

// Keep bot.groupIds and group.botIds in sync in both directions.
function syncBotGroups(bot) {
  manager.groups.forEach((g) => {
    const should = bot.groupIds.includes(g.id);
    const has = g.botIds.includes(bot.id);
    if (should && !has) g.botIds.push(bot.id);
    if (!should && has) g.botIds = g.botIds.filter((id) => id !== bot.id);
  });
}

function syncGroupBots(group) {
  manager.bots.forEach((b) => {
    const should = group.botIds.includes(b.id);
    const has = b.groupIds.includes(group.id);
    if (should && !has) b.groupIds.push(group.id);
    if (!should && has) b.groupIds = b.groupIds.filter((id) => id !== group.id);
  });
}

function broadcastGroups() {
  Array.from(manager.groups.values()).forEach((g) => broadcast('group', { group: publicGroup(g) }));
  broadcast('stats', stats());
}


const sessions = new Map();
const loginAttempts = new Map();
const sseClients = new Set();

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function isAuthed(req) {
  const token = parseCookies(req).mcbot_session;
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < now()) { sessions.delete(token); return false; }
  return true;
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function safeJoin(base, rel) {
  const decoded = decodeURIComponent(rel);
  const p = path.normalize(path.join(base, decoded));
  if (p !== base && !p.startsWith(base + path.sep)) return null;
  return p;
}

function serveFile(req, res, filePath, cache = 'no-cache') {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

function broadcast(type, payload) {
  if (!sseClients.size) return;
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch (_) { sseClients.delete(res); }
  }
}

function stats() {
  const bots = Array.from(manager.bots.values());
  const online = bots.filter((b) => b.status === 'online').length;
  const connecting = bots.filter((b) => b.status === 'connecting' || b.status === 'reconnecting').length;
  // Players are counted once per server: the tab list is the same for every
  // bot connected to that server, so summing per bot double-counts them.
  const byServer = new Map();
  bots.forEach((b) => {
    const key = `${b.host}:${b.port}`;
    const rec = byServer.get(key) || { key, host: b.host, port: b.port, bots: 0, online: 0, players: 0 };
    rec.bots += 1;
    if (b.status === 'online') {
      rec.online += 1;
      rec.players = Math.max(rec.players, b.players || 0);
    }
    byServer.set(key, rec);
  });
  const serverList = Array.from(byServer.values());
  const players = serverList.reduce((n, s) => n + s.players, 0);
  const uptimes = bots.filter((b) => b.joinedAt).map((b) => now() - b.joinedAt);
  const avgUptime = uptimes.length ? Math.round(uptimes.reduce((a, b) => a + b, 0) / uptimes.length) : 0;
  return {
    total: bots.length,
    online,
    connecting,
    offline: bots.length - online - connecting,
    servers: serverList.length,
    serverList,
    groups: manager.groups ? manager.groups.size : 0,
    players,
    avgUptime,
    masterOn: online + connecting > 0,
    proxies: proxyPool.summary(),
  };
}

function snapshot() {
  const activity = [];
  Array.from(manager.bots.values()).forEach((b) => {
    b.logs.slice(-14).forEach((entry) => activity.push({ id: b.id, name: b.name, entry }));
  });
  activity.sort((a, b) => a.entry.t - b.entry.t);
  return {
    bots: Array.from(manager.bots.values()).map((b) => b.public()),
    groups: Array.from(manager.groups.values()).map((g) => publicGroup(g)),
    stats: stats(),
    activity: activity.slice(-80),
    startedAt: manager.startedAt,
    now: now(),
  };
}

function findBot(id) {
  return manager.bots.get(id) || null;
}

function findGroup(id) {
  return manager.groups.get(id) || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  // ── item icons (public, cached) ──
  if (parts[1] === 'icon' && parts[2] && parts[3] && method === 'GET') {
    const name = parts[3].replace(/\.png$/i, '');
    const buf = await getIcon(parts[2], name);
    if (!buf) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=86400' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=604800, immutable',
    });
    return res.end(buf);
  }

  // ── player skins (public, cached) ──
  if (parts[1] === 'skin' && parts[2] && method === 'GET') {
    const name = parts[2].replace(/\.png$/i, '');
    const buf = await getSkin(name, url.searchParams.get('kind') || 'head', url.searchParams.get('size'));
    if (!buf) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=3600' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=604800, immutable',
    });
    return res.end(buf);
  }

  // ── auth (public) ──
  if (parts[1] === 'auth' && method === 'GET') {
    return json(res, 200, { authenticated: isAuthed(req), passwordRequired: true });
  }

  if (parts[1] === 'login' && method === 'POST') {
    const ip = clientIp(req);
    const rec = loginAttempts.get(ip) || { count: 0, reset: now() + 5 * 60 * 1000 };
    if (rec.reset < now()) { rec.count = 0; rec.reset = now() + 5 * 60 * 1000; }
    if (rec.count >= 12) return json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    rec.count += 1;
    loginAttempts.set(ip, rec);

    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    if (String(body.password || '') !== DASHBOARD_PASSWORD) {
      await new Promise((r) => setTimeout(r, 450));
      return json(res, 401, { error: 'Wrong password.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, now() + SESSION_TTL);
    res.setHeader('Set-Cookie', `mcbot_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
    return json(res, 200, { ok: true });
  }

  if (parts[1] === 'logout' && method === 'POST') {
    const token = parseCookies(req).mcbot_session;
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', 'mcbot_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  if (parts[1] === 'health' && method === 'GET') {
    return json(res, 200, { ok: true, uptime: Math.round(process.uptime()), bots: manager.bots.size });
  }

  // ── everything below requires a session ──
  if (!isAuthed(req)) return json(res, 401, { error: 'Not authenticated' });

  if (parts[1] === 'state' && method === 'GET') return json(res, 200, snapshot());

  if (parts[1] === 'proxies' && method === 'GET') return json(res, 200, proxyPool.status());

  if (parts[1] === 'proxies' && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    if (body.enabled != null) proxyPool.setEnabled(!!body.enabled);
    if (body.webshare != null) proxyPool.setWebshare(!!body.webshare);
    if (body.maxPerIp != null) proxyPool.setMaxPerIp(body.maxPerIp);
    if (body.reshuffle) proxyPool.reshuffle();
    if (body.refresh) proxyPool.refresh(true).catch(() => {});
    if (body.apply) {
      // Rolling re-home: one bot at a time, seven seconds apart, so the fleet
      // never dips all at once.
      const targets = Array.from(manager.bots.values()).filter((b) => b.wanted);
      targets.forEach((b, i) => setTimeout(() => {
        proxyPool.release(b.id);
        if (!b.wanted) return;
        b.addLog('info', 'Re-homing through the proxy pool…');
        b.restart();
      }, i * 7000));
      return json(res, 200, { ok: true, rolling: targets.length, status: proxyPool.status() });
    }
    return json(res, 200, proxyPool.status());
  }

  if (parts[1] === 'logs' && method === 'GET') {
    const limit = Math.min(1200, Math.max(50, parseInt(url.searchParams.get('limit') || '600', 10)));
    const entries = [];
    Array.from(manager.bots.values()).forEach((b) => {
      b.logs.slice(-220).forEach((entry) => entries.push({ id: b.id, name: b.name, entry }));
    });
    entries.sort((a, b) => a.entry.t - b.entry.t);
    return json(res, 200, { entries: entries.slice(-limit), bots: Array.from(manager.bots.values()).map((b) => b.public()) });
  }

  if (parts[1] === 'events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write('retry: 2000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ now: now() })}\n\n`);
    sseClients.add(res);
    // Heartbeat keeps proxies and sleeping tabs from silently dropping the stream.
    const ping = setInterval(() => {
      try { res.write(`event: ping\ndata: ${now()}\n\n`); } catch (_) {}
    }, 10000);
    res.on('error', () => { clearInterval(ping); sseClients.delete(res); });
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  if (parts[1] === 'bots' && parts.length === 2 && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    let cfg;
    try { cfg = normalizeConfig(body, null); } catch (e) { return json(res, 400, { error: e.message }); }
    const id = 'b_' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
    const bot = new ManagedBot(Object.assign({ id, createdAt: now(), desiredOn: true }, cfg), { broadcast, save: saveConfigs });
    manager.bots.set(id, bot);
    syncBotGroups(bot);
    saveConfigs();
    bot.start();
    broadcast('bot', { bot: bot.public() });
    broadcastGroups();
    return json(res, 201, { bot: bot.public() });
  }

  if (parts[1] === 'bots' && parts[2] === 'bulk' && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const action = String(body.action || '');
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const targets = ids.length ? ids.map(findBot).filter(Boolean) : Array.from(manager.bots.values());
    if (!['start', 'stop', 'restart'].includes(action)) return json(res, 400, { error: 'Unknown bulk action.' });
    targets.forEach((b) => {
      if (action === 'start') { b.desiredOn = true; b.start(); }
      else if (action === 'stop') { b.desiredOn = false; b.stop('Stopped by user'); }
      else { b.desiredOn = true; b.restart(); }
    });
    saveConfigs();
    broadcast('stats', stats());
    return json(res, 200, { ok: true, affected: targets.length });
  }

  if (parts[1] === 'master' && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const on = !!body.on;
    Array.from(manager.bots.values()).forEach((b) => {
      if (on) { b.desiredOn = true; b.start(); }
      else { b.desiredOn = false; b.stop('Master power off'); }
    });
    saveConfigs();
    broadcast('stats', stats());
    return json(res, 200, { ok: true, masterOn: on });
  }

  // ── groups ──
  if (parts[1] === 'groups' && parts.length === 2 && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    let cfg;
    try { cfg = normalizeGroup(body, null); } catch (e) { return json(res, 400, { error: e.message }); }
    const group = {
      id: 'g_' + crypto.randomUUID().replace(/-/g, '').slice(0, 10),
      name: cfg.name,
      color: cfg.color,
      botIds: cfg.botIds.filter((id) => manager.bots.has(id)),
      createdAt: now(),
    };
    manager.groups.set(group.id, group);
    syncGroupBots(group);
    saveConfigs();
    broadcast('group', { group: publicGroup(group) });
    Array.from(manager.bots.values()).forEach((b) => broadcast('bot', { bot: b.public() }));
    broadcast('stats', stats());
    return json(res, 201, { group: publicGroup(group) });
  }

  if (parts[1] === 'groups' && parts[2] && parts.length === 3 && method === 'PUT') {
    const group = findGroup(parts[2]);
    if (!group) return json(res, 404, { error: 'Group not found.' });
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    let cfg;
    try { cfg = normalizeGroup(body, { name: group.name, color: group.color, botIds: group.botIds }); }
    catch (e) { return json(res, 400, { error: e.message }); }
    group.name = cfg.name;
    group.color = cfg.color;
    group.botIds = cfg.botIds.filter((id) => manager.bots.has(id));
    syncGroupBots(group);
    saveConfigs();
    broadcast('group', { group: publicGroup(group) });
    Array.from(manager.bots.values()).forEach((b) => broadcast('bot', { bot: b.public() }));
    broadcast('stats', stats());
    return json(res, 200, { group: publicGroup(group) });
  }

  if (parts[1] === 'groups' && parts[2] && parts.length === 3 && method === 'DELETE') {
    const group = findGroup(parts[2]);
    if (!group) return json(res, 404, { error: 'Group not found.' });
    manager.groups.delete(group.id);
    Array.from(manager.bots.values()).forEach((b) => {
      if (b.groupIds.includes(group.id)) {
        b.groupIds = b.groupIds.filter((id) => id !== group.id);
        broadcast('bot', { bot: b.public() });
      }
    });
    saveConfigs();
    broadcast('group-removed', { id: group.id });
    broadcast('stats', stats());
    return json(res, 200, { ok: true });
  }

  if (parts[1] === 'groups' && parts[2] && parts[3] && method === 'POST') {
    const group = findGroup(parts[2]);
    if (!group) return json(res, 404, { error: 'Group not found.' });
    const action = parts[3];
    if (!['start', 'stop', 'restart', 'command'].includes(action)) return json(res, 404, { error: 'Unknown action.' });
    const targets = group.botIds.map(findBot).filter(Boolean);

    if (action === 'command') {
      let body;
      try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
      const message = clean(body.message, 250).trim();
      if (!message) return json(res, 400, { error: 'Command is empty.' });
      let sent = 0;
      const skipped = [];
      targets.forEach((b) => {
        try { b.sendChat(message); sent += 1; }
        catch (_) { skipped.push(b.name); }
      });
      if (!sent) return json(res, 400, { error: 'No online bots in this group.' });
      broadcast('stats', stats());
      return json(res, 200, { ok: true, sent, skipped, message });
    }
    targets.forEach((b) => {
      if (action === 'start') { b.desiredOn = true; b.start(); }
      else if (action === 'stop') { b.desiredOn = false; b.stop('Group power off'); }
      else { b.desiredOn = true; b.restart(); }
    });
    saveConfigs();
    broadcast('stats', stats());
    return json(res, 200, { ok: true, affected: targets.length });
  }

  // Bulk import / clear — used by the Fleet setup dialog.
  if (parts[1] === 'bots' && parts[2] === 'clear' && method === 'POST') {
    let body = {};
    try { body = await readBody(req) || {}; } catch (_) {}
    let n = 0;
    manager.bots.forEach((b) => { b.desiredOn = false; b.stop('Removed by fleet setup'); n++; broadcast('removed', { id: b.id }); });
    manager.bots.clear();
    manager.groups.forEach((g) => { g.botIds = []; });
    saveConfigs();
    broadcastGroups();
    proxyPool.reshuffle();
    return json(res, 200, { ok: true, removed: n });
  }

  if (parts[1] === 'bots' && parts[2] === 'import' && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const raw = typeof body.names === 'string'
      ? body.names.split(/[\r\n,;\s]+/)
      : (Array.isArray(body.names) ? body.names : []);
    const names = [];
    const seen = new Set();
    for (const entry of raw) {
      const nm = clean(entry, 16).trim();
      if (!/^[A-Za-z0-9_]{1,16}$/.test(nm)) continue;
      const key = nm.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(nm);
    }
    if (!names.length) return json(res, 400, { error: 'Add at least one valid name — letters, numbers or underscore, max 16 characters.' });
    if (names.length > 100) return json(res, 400, { error: 'Maximum 100 bots per import.' });

    if (body.replace) {
      manager.bots.forEach((b) => { b.desiredOn = false; b.stop('Replaced by fleet setup'); broadcast('removed', { id: b.id }); });
      manager.bots.clear();
      manager.groups.forEach((g) => { g.botIds = []; });
    }
    const base = {
      host: body.host, port: body.port, version: body.version, password: body.password,
      autoLogin: body.autoLogin, autoReconnect: body.autoReconnect,
      antiAfk: body.antiAfk, autoEat: body.autoEat,
      autoSwitch: body.autoSwitch, switchCommand: body.switchCommand, switchDelay: body.switchDelay,
    };
    const created = [];
    for (const name of names) {
      let cfg;
      try { cfg = normalizeConfig(Object.assign({}, base, { name }), null); } catch (e) { continue; }
      const id = 'b_' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
      const bot = new ManagedBot(Object.assign({ id, createdAt: now(), desiredOn: body.start !== false }, cfg), { broadcast, save: saveConfigs });
      manager.bots.set(id, bot);
      syncBotGroups(bot);
      created.push(bot);
      broadcast('bot', { bot: bot.public() });
    }
    saveConfigs();
    broadcastGroups();
    // Stagger the joins — one bot every few seconds, never a burst.
    created.forEach((bot, i) => {
      if (!bot.desiredOn) return;
      setTimeout(() => {
        if (manager.bots.get(bot.id) === bot) bot.start();
      }, 1500 + i * 5000);
    });
    proxyPool.reshuffle();
    return json(res, 201, { created: created.length, names: created.map((b) => b.name) });
  }

  // /api/bots/:id...
  if (parts[1] === 'bots' && parts[2]) {
    const bot = findBot(parts[2]);
    if (!bot) return json(res, 404, { error: 'Bot not found.' });

    if (parts.length === 3 && method === 'GET') return json(res, 200, { bot: bot.public() });

    if (parts.length === 3 && method === 'PUT') {
      let body;
      try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
      let cfg;
      try { cfg = normalizeConfig(body, bot.config()); } catch (e) { return json(res, 400, { error: e.message }); }
      bot.updateConfig(cfg);
      syncBotGroups(bot);
      saveConfigs();
      broadcast('bot', { bot: bot.public() });
      broadcastGroups();
      return json(res, 200, { bot: bot.public() });
    }

    if (parts.length === 3 && method === 'DELETE') {
      bot.desiredOn = false;
      bot.stop('Removed from dashboard');
      proxyPool.release(bot.id);
      manager.bots.delete(bot.id);
      manager.groups.forEach((g) => { g.botIds = g.botIds.filter((id) => id !== bot.id); });
      saveConfigs();
      broadcast('removed', { id: bot.id });
      broadcastGroups();
      return json(res, 200, { ok: true });
    }

    if (parts[3] === 'logs' && method === 'GET') {
      return json(res, 200, { logs: bot.logs, bot: bot.public() });
    }

    if (parts[3] === 'players' && method === 'GET') {
      return json(res, 200, {
        players: bot.bot ? playerList(bot.bot) : [],
        bot: bot.public(),
      });
    }

    if (parts[3] === 'inventory' && method === 'GET') {
      let inventory = bot.bot ? inventorySnapshot(bot.bot) : null;
      if (inventory) {
        if (inventory.used > 0) bot._invCache = { at: now(), snap: inventory };
        else if (bot._invCache && now() - bot._invCache.at < 120000) {
          inventory = { ...bot._invCache.snap, stale: true };
        }
      }
      return json(res, 200, { inventory, bot: bot.public() });
    }

    if (parts[3] && method === 'POST') {
      const action = parts[3];
      let body = {};
      try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
      try {
        if (action === 'start') { bot.desiredOn = true; bot.start(); }
        else if (action === 'stop') { bot.desiredOn = false; bot.stop('Stopped by user'); }
        else if (action === 'restart') { bot.desiredOn = true; bot.restart(); }
        else if (action === 'switch') { bot.switchNow(); }
        else if (action === 'login') { bot.loginNow(); }
        else if (action === 'chat') { bot.sendChat(String(body.message || '')); }
        else if (action === 'auto-eat') {
          bot.autoEat = !bot.autoEat;
          bot._eatWarned = false;
          bot.addLog(bot.autoEat ? 'ok' : 'info', `Auto-eat ${bot.autoEat ? 'enabled' : 'disabled'}.`);
        }
        else return json(res, 404, { error: 'Unknown action.' });
      } catch (e) {
        return json(res, 400, { error: e.message || String(e) });
      }
      saveConfigs();
      broadcast('stats', stats());
      return json(res, 200, { ok: true, bot: bot.public() });
    }
  }

  return json(res, 404, { error: 'Not found' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Server
// ─────────────────────────────────────────────────────────────────────────────
function createServer() {
  return http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch (_) { return json(res, 400, { error: 'Bad request' }); }

    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    // The bundled project site (/site) shows player skins from minotar.net.
    const isSite = url.pathname === '/site' || url.pathname.startsWith('/site/');
    res.setHeader(
      'Content-Security-Policy',
      isSite
        ? "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://minotar.net; connect-src 'self'; script-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
        : "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; script-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
    );

    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((e) => {
        log('API error:', e && e.stack ? e.stack : e);
        if (!res.headersSent) json(res, 500, { error: 'Internal server error' });
      });
      return;
    }

    // ── static: the project website at /site (also used by GitHub Pages) ──
    if (url.pathname === '/site' || url.pathname.startsWith('/site/')) {
      const rel = url.pathname.replace(/^\/site\/?/, '');
      if (!rel || rel.endsWith('/')) {
        return serveFile(req, res, path.join(SITE_DIR, 'index.html'));
      }
      const file = safeJoin(SITE_DIR, rel);
      if (!file) { res.writeHead(400); return res.end('Bad path'); }
      return serveFile(req, res, file);
    }

    // ── static: portfolio at /portfolio ──
    if (url.pathname === '/portfolio' || url.pathname.startsWith('/portfolio/')) {
      const rel = url.pathname.replace(/^\/portfolio\/?/, '');
      if (!rel || rel.endsWith('/')) {
        return serveFile(req, res, path.join(PORTFOLIO_DIR, 'index.html'));
      }
      const file = safeJoin(PORTFOLIO_DIR, rel);
      if (!file) { res.writeHead(400); return res.end('Bad path'); }
      return serveFile(req, res, file);
    }

    // ── static: dashboard ──
    let rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
    if (rel === 'login') rel = 'index.html';
    if (rel === 'favicon.ico') rel = 'favicon.svg';
    const file = safeJoin(PUBLIC_DIR, rel);
    if (!file) { res.writeHead(400); return res.end('Bad path'); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Method not allowed'); }
    serveFile(req, res, file);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────
function boot() {
  ensureDir(DATA_DIR);
  manager = {
    bots: new Map(),
    groups: new Map(),
    startedAt: now(),
  };

  const store = loadStore();
  store.groups.forEach((g) => manager.groups.set(g.id, g));
  store.bots.forEach((cfg) => {
    const bot = new ManagedBot(cfg, { broadcast, save: saveConfigs });
    manager.bots.set(bot.id, bot);
  });

  // Repair any stale membership left behind by deleted bots/groups.
  Array.from(manager.bots.values()).forEach((bot) => {
    bot.groupIds = bot.groupIds.filter((id) => manager.groups.has(id));
    syncBotGroups(bot);
  });
  Array.from(manager.groups.values()).forEach((group) => {
    group.botIds = group.botIds.filter((id) => manager.bots.has(id));
    syncGroupBots(group);
  });

  if (!fs.existsSync(BOTS_FILE)) saveConfigs();

  const firstBot = Array.from(manager.bots.values())[0];
  const poolReady = proxyPool.init({
    dataDir: DATA_DIR,
    target: {
      host: process.env.PROXY_TARGET_HOST || (firstBot && firstBot.host) || '',
      port: parseInt(process.env.PROXY_TARGET_PORT || String((firstBot && firstBot.port) || 25565), 10),
    },
    botIds: () => Array.from(manager.bots.keys()),
    log,
  });

  const server = createServer();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\x1b[31mPort ${PORT} is already in use.\x1b[0m`);
      process.exit(1);
    }
    console.error('Server error:', err.message);
  });

  server.listen(PORT, HOST, () => {
    log(`\x1b[32mMCBot Control\x1b[0m listening on \x1b[36mhttp://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\x1b[0m`);
    log(`${manager.bots.size} bot(s) and ${manager.groups.size} group(s) loaded from ${BOTS_FILE}`);
    // Restore bots that were running before the dashboard restarted. Give the
    // cached proxy pool a few seconds to re-validate first, so the very first
    // connection already egresses through a proxy (9s cap either way).
    const restore = Array.from(manager.bots.values()).filter((b) => b.desiredOn);
    const kick = () => {
      if (!restore.length) return;
      log(`Restoring ${restore.length} bot(s)…`);
      restore.forEach((b, i) => setTimeout(() => { if (b.desiredOn) b.start(); }, 1000 + i * 1500));
    };
    Promise.race([poolReady || Promise.resolve(), new Promise((r) => setTimeout(r, 9000))])
      .then(kick).catch(kick);
  });

  const shutdown = (signal) => {
    log(`${signal} — shutting down…`);
    try { server.close(); } catch (_) {}
    Array.from(manager.bots.values()).forEach((b) => { try { b.stop('Dashboard shutting down'); } catch (_) {} });
    setTimeout(() => process.exit(0), 800);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    if (OFFLINE_CODES.includes(err && err.code)) return;
    log('uncaughtException:', err && err.stack ? err.stack : err);
  });
  process.on('unhandledRejection', (err) => {
    if (OFFLINE_CODES.includes(err && err.code)) return;
    log('unhandledRejection:', err && err.stack ? err.stack : err);
  });

  // Keep uptimeMs fresh in the UI (cheap, once every 5s).
  setInterval(() => {
    if (!sseClients.size) return;
    const bots = Array.from(manager.bots.values()).filter((b) => b.joinedAt).map((b) => b.public());
    if (bots.length) broadcast('tick', { bots });
  }, 5000);
}

boot();
