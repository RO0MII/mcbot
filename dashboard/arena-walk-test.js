#!/usr/bin/env node
'use strict';

/**
 * arena-walk-test.js — live single-bot test for arena-walker.js.
 *
 * Usage:
 *   node arena-walk-test.js                 # tests igudesa
 *   node arena-walk-test.js --bot unify98   # tests any panel bot
 *   node arena-walk-test.js --bot unify98 --keep   # leave the bot to the panel
 *
 * Only the chosen bot is stopped. The other 11 stay online. The bot is always
 * started again in the panel, even when the test fails.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { Vec3 } = require('vec3');
const mineflayer = require('mineflayer');
const mcProtocol = require('minecraft-protocol');
const proxyPool = require('./proxy-pool');
const { runArenaWalk } = require('./arena-walker');
const LIGHT_OPTIONS = require('./bot-options');

const ROOT = __dirname;
const BASE = 'http://127.0.0.1';
const PASSWORD = 'Sandun123';
const ARGS = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = ARGS.indexOf(name);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : fallback;
};
const BOT_NAME = argOf('--bot', process.env.TEST_BOT || 'igudesa');
const KEEP_RUNNING = ARGS.includes('--keep');
const FORCE_PROXY = argOf('--proxy', '');
const STAND_ONLY = ARGS.includes('--stand');
const SNEAK = ARGS.includes('--sneak');

const CONFIG_WRITES = new Set([
  'configuration_acknowledged', 'select_known_packs', 'finish_configuration',
  'custom_payload', 'keep_alive', 'pong', 'accept_code_of_conduct',
  'resource_pack_receive', 'cookie_response', 'chat_session_update',
]);
function guardReconfigPackets(bot) {
  const client = bot && bot._client;
  if (!client || client._reconfigGuarded) return;
  client._reconfigGuarded = true;
  const states = mcProtocol.states;
  const write = client.write.bind(client);
  client.write = (name, ...args) => {
    if (client.state === states.CONFIGURATION && !CONFIG_WRITES.has(name)) return;
    return write(name, ...args);
  };
}

let cookie = '';
function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(BASE + urlPath, {
      method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        cookie ? { Cookie: cookie } : {},
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}
      ),
    }, (res) => {
      const set = res.headers['set-cookie'];
      if (set) cookie = set.map((c) => c.split(';')[0]).join('; ');
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function openProxy(preferred) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/proxies.json'), 'utf8'));
  const assigned = new Set(Object.values(data.assignments || {}));
  const usedIps = new Set([...assigned].map((k) => String(k).split(':')[0]));
  const now = Date.now();
  const preferredList = preferred && (preferred.ip || preferred.host) ? [{
    host: preferred.ip || preferred.host,
    port: preferred.port,
    protocol: preferred.protocol || 'socks5',
  }] : [];
  const seen = new Set();
  const candidates = [];
  for (const p of preferredList) {
    const key = p.host + ':' + p.port;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(p);
  }
  for (const p of [...(data.static || []), ...(data.alive || [])]) {
    if (!p || !p.host || !p.port) continue;
    const key = p.host + ':' + p.port;
    if (seen.has(key)) continue;
    seen.add(key);
    if (p.retired || (p.quarantineUntil || 0) > now) continue;
    if (assigned.has(key) || usedIps.has(p.host)) continue;
    candidates.push(p);
  }
  for (const p of candidates.slice(0, 30)) {
    try {
      log('trying proxy', p.host + ':' + p.port, p.protocol || 'socks5');
      const socket = await proxyPool.open(p, 'mc.hungrybirds.org', 25565, 7000);
      return { proxy: p, socket };
    } catch (e) {
      log('proxy failed:', (e && e.message) || e);
    }
  }
  throw new Error('no free proxy could open the game server');
}

async function main() {
  await api('POST', '/api/login', { password: PASSWORD });
  const state = await api('GET', '/api/state');
  const cfgBot = state.bots.find((b) => b.name === BOT_NAME);
  if (!cfgBot) throw new Error('bot not found in panel: ' + BOT_NAME);
  const id = cfgBot.id;

  log('stopping only', BOT_NAME, 'in the panel (other bots stay online)');
  await api('POST', `/api/bots/${id}/stop`, {});
  await sleep(8000);

  const { proxy, socket } = await openProxy(
    FORCE_PROXY
      ? { host: FORCE_PROXY.split(':')[0], port: Number(FORCE_PROXY.split(':')[1] || 1080), protocol: 'socks5' }
      : cfgBot.proxy
  );
  log('connected proxy', proxy.host + ':' + proxy.port, '- other bots untouched');

  let bot;
  let loginSent = false;
  let afkSent = false;
  let clicked = false;
  let arenaMessage = false;
  const started = Date.now();

  const sendLogin = () => {
    if (loginSent) return;
    loginSent = true;
    try { bot.chat('/login ' + PASSWORD); log('sent /login'); } catch (_) {}
  };

  try {
    bot = mineflayer.createBot({
      host: 'mc.hungrybirds.org',
      port: 25565,
      username: BOT_NAME,
      auth: 'offline',
      version: '1.21.11',
      hideErrors: true,
      logErrors: false,
      checkTimeoutInterval: 60000,
      viewDistance: LIGHT_OPTIONS.viewDistance,
      plugins: Object.assign({}, LIGHT_OPTIONS.plugins),
      connect: (client) => {
        try {
          client.setSocket(socket);
          setImmediate(() => {
            try { if (!client.ended) client.emit('connect'); } catch (_) {}
          });
        } catch (e) { try { client.emit('error', e); } catch (_) {} }
      },
    });
    guardReconfigPackets(bot);
    const origWrite = bot._client.write.bind(bot._client);
    bot._client.write = (name, ...args) => {
      if (name === 'teleport_confirm') log('CONFIRM teleport', JSON.stringify(args), 'state=', bot._client.state);
      return origWrite(name, ...args);
    };

    bot.on('spawn', () => {
      log('spawned');
      setTimeout(sendLogin, 800);
      setTimeout(() => {
        if (afkSent) return;
        afkSent = true;
        try { bot.chat('/afk'); log('sent /afk'); } catch (_) {}
      }, 4500);
    });
    bot.on('messagestr', (m) => {
      const s = String(m || '');
      if (/\/login|please login|login with/i.test(s)) sendLogin();
      if (/teleported successfully|afk[ -]?arena/i.test(s)) {
        arenaMessage = true;
        log('arena teleport message:', s.slice(0, 80));
      }
    });
    bot.on('windowOpen', (window) => {
      log('GUI opened:', window && window.title);
      if (clicked) return;
      clicked = true;
      setTimeout(() => {
        bot.clickWindow(0, 0, 0).then(() => log('clicked GUI slot 1')).catch((e) => log('GUI click failed:', e.message));
      }, 500);
    });
    bot.on('error', (e) => log('bot error:', e && e.message));
    bot.on('end', (reason) => log('bot end:', reason));

    // Spawn and the arena share the same coordinates. The chat announcement
    // is the only reliable signal that the countdown and teleport finished.
    for (let i = 0; i < 70; i++) {
      await sleep(1000);
      if (arenaMessage && bot.entity) break;
    }
    if (!arenaMessage) throw new Error('no arena teleport announcement within 70s');
    log('arena teleport confirmed at', bot.entity.position.toString());
    log('server ping', bot.player && bot.player.ping);
    let posPackets = 0;
    bot._client.on('position', (pkt) => {
      posPackets++;
      if (posPackets <= 12) log('SERVER position packet', JSON.stringify(pkt), 'state=', bot._client.state);
    });
    await sleep(1500);

    if (STAND_ONLY) {
      log('standing still for 8s — logging server position packets');
      await sleep(8000);
      log('stand test done, packets seen:', posPackets);
      return;
    }

    const result = await runArenaWalk(bot, {
      minDistance: 5,
      maxDistance: 10,
      preferMin: 6,
      debugEveryMs: 1000,
      sneak: SNEAK,
      onTrace: (t) => log('  trace:', t),
    });
    const pos = bot.entity.position;
    log('RESULT', JSON.stringify({
      ok: result.ok,
      moved: Number(result.moved.toFixed(2)),
      reason: result.reason,
      target: result.target ? { x: result.target.x, z: result.target.z } : null,
      final: { x: Number(pos.x.toFixed(2)), y: Number(pos.y.toFixed(2)), z: Number(pos.z.toFixed(2)) },
      ms: result.ms,
      route: result.route,
    }));
    if (!result.ok || result.moved < 4.5) {
      throw new Error(`walk failed: moved ${result.moved.toFixed(2)} (${result.reason})`);
    }
    log('ONE-BOT ARENA WALK PASS');
  } finally {
    try { if (bot) bot.quit('arena walk test done'); } catch (_) {}
    try { socket.destroy(); } catch (_) {}
    await sleep(1000);
    if (KEEP_RUNNING) {
      log('--keep set: not restarting', BOT_NAME);
    } else {
      log('starting', BOT_NAME, 'again in the panel');
      try { await api('POST', `/api/bots/${id}/start`, {}); } catch (e) { log('restart failed:', e.message); }
    }
  }
}

main().catch((e) => {
  console.error('ONE-BOT ARENA WALK FAIL:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
