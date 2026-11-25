'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const proxyPool = require('../proxy-pool');

const HOUR = 60 * 60 * 1000;

function seed(key, fields = {}) {
  const at = key.indexOf(':');
  const host = key.slice(0, at);
  const port = Number(key.slice(at + 1));
  proxyPool.alive.set(key, {
    key, host, port, protocol: 'socks5', region: '', latency: 20,
    okAt: Date.now(), source: 'user', fails: 0, failStreak: 0,
    successes: 0, retired: false, quarantineUntil: 0, ...fields,
  });
}

function withCleanPool() {
  const saved = {
    alive: new Map(proxyPool.alive),
    assignments: new Map(proxyPool.assignments),
    names: new Map(proxyPool.names),
    enabled: proxyPool.opts.enabled,
    maxPerIp: proxyPool.opts.maxPerIp,
    maxPool: proxyPool.opts.maxPool,
    webshare: { enabled: proxyPool.webshare.enabled, username: proxyPool.webshare.username },
    file: proxyPool.file,
    static: proxyPool.static,
    log: proxyPool.log,
    save: proxyPool._save,
    botIds: proxyPool._botIds,
    saveTimer: proxyPool._saveTimer,
  };
  proxyPool.alive.clear();
  proxyPool.assignments.clear();
  proxyPool.names.clear();
  proxyPool.opts.enabled = true;
  proxyPool.opts.maxPerIp = 1;
  proxyPool.webshare.enabled = false;
  proxyPool.webshare.username = '';
  proxyPool.file = null;
  proxyPool._botIds = null;
  proxyPool.log = () => {};
  proxyPool._save = () => {};
  proxyPool._saveTimer = null;
  return () => {
    if (proxyPool._saveTimer) { clearTimeout(proxyPool._saveTimer); proxyPool._saveTimer = null; }
    proxyPool.alive.clear();
    saved.alive.forEach((v, k) => proxyPool.alive.set(k, v));
    proxyPool.assignments.clear();
    saved.assignments.forEach((v, k) => proxyPool.assignments.set(k, v));
    proxyPool.names.clear();
    saved.names.forEach((v, k) => proxyPool.names.set(k, v));
    proxyPool.opts.enabled = saved.enabled;
    proxyPool.opts.maxPerIp = saved.maxPerIp;
    proxyPool.opts.maxPool = saved.maxPool;
    proxyPool.webshare.enabled = saved.webshare.enabled;
    proxyPool.webshare.username = saved.webshare.username;
    proxyPool.file = saved.file;
    proxyPool.static = saved.static;
    proxyPool.log = saved.log;
    proxyPool._save = saved.save;
    proxyPool._botIds = saved.botIds;
    if (saved.saveTimer) proxyPool._saveTimer = saved.saveTimer;
  };
}

test('two short sessions cool the route and remove it from pick', () => {
  const restore = withCleanPool();
  try {
    seed('short.test:1');
    seed('healthy.test:9');
    proxyPool.reportSession({ ip: 'short.test', port: 1 }, 60 * 1000);
    proxyPool.reportSession({ ip: 'short.test', port: 1 }, 90 * 1000);
    assert.ok(proxyPool.alive.get('short.test:1').quarantineUntil > Date.now());
    assert.equal(proxyPool.pick('b-short').key, 'healthy.test:9');
  } finally {
    restore();
  }
});

test('three short sessions retire the route', () => {
  const restore = withCleanPool();
  try {
    seed('short.test:1');
    for (let i = 0; i < 3; i++) proxyPool.reportSession({ ip: 'short.test', port: 1 }, 60 * 1000);
    assert.equal(proxyPool.alive.get('short.test:1').retired, true);
  } finally {
    restore();
  }
});

test('pick prefers good over trial', () => {
  const restore = withCleanPool();
  try {
    seed('good.test:1', { latency: 30, bestUptimeMs: 2 * HOUR, totalUptimeMs: 5 * HOUR, shortSessions: 0 });
    seed('trial.test:2', { latency: 10, bestUptimeMs: 30 * 60 * 1000, totalUptimeMs: 3 * HOUR, shortSessions: 0 });
    assert.equal(proxyPool.pick('b-rank').key, 'good.test:1');
  } finally {
    restore();
  }
});

test('status().good only contains clean healthy routes', () => {
  const restore = withCleanPool();
  try {
    seed('good.test:1', { bestUptimeMs: 2 * HOUR, totalUptimeMs: 7200000, shortSessions: 0 });
    seed('retired.test:3', { bestUptimeMs: 2 * HOUR, totalUptimeMs: 9000000, shortSessions: 0, retired: true });
    seed('trial.test:2', { bestUptimeMs: 30 * 60 * 1000, totalUptimeMs: 3 * HOUR, shortSessions: 0 });
    const good = proxyPool.status().good;
    assert.deepEqual(good.map((p) => p.key), ['good.test:1']);
    assert.equal(good[0].lifetimeUptimeSec, 7200);
  } finally {
    restore();
  }
});

test('a proven route keeps its owner through one handshake failure', () => {
  const restore = withCleanPool();
  try {
    seed('proven.test:1', { bestUptimeMs: 2 * HOUR, totalUptimeMs: 5 * HOUR, shortSessions: 0 });
    proxyPool.assignments.set('bot-proven', 'proven.test:1');
    const kept = proxyPool.handleHandshakeFailure('bot-proven', { ip: 'proven.test', port: 1 });
    assert.equal(kept, true);
    assert.equal(proxyPool.assignments.get('bot-proven'), 'proven.test:1');
  } finally {
    restore();
  }
});

test('an unproven route is released after a handshake failure', () => {
  const restore = withCleanPool();
  try {
    seed('new.test:1');
    proxyPool.assignments.set('bot-new', 'new.test:1');
    const kept = proxyPool.handleHandshakeFailure('bot-new', { ip: 'new.test', port: 1 });
    assert.equal(kept, false);
    assert.equal(proxyPool.assignments.has('bot-new'), false);
  } finally {
    restore();
  }
});

test('a single game failure cools a route; the third one retires it', () => {
  const restore = withCleanPool();
  try {
    seed('game.test:1', { bestUptimeMs: 2 * HOUR, totalUptimeMs: 5 * HOUR, shortSessions: 0 });
    proxyPool.reportGameFailure({ ip: 'game.test', port: 1 });
    assert.equal(proxyPool.alive.get('game.test:1').retired, false);
    assert.ok(proxyPool.alive.get('game.test:1').quarantineUntil > Date.now());
    proxyPool.reportGameFailure({ ip: 'game.test', port: 1 });
    assert.equal(proxyPool.alive.get('game.test:1').retired, false);
    proxyPool.reportGameFailure({ ip: 'game.test', port: 1 });
    assert.equal(proxyPool.alive.get('game.test:1').retired, true);
  } finally {
    restore();
  }
});

test('discovered routes stop being added once the live pool hits its cap', () => {
  const restore = withCleanPool();
  try {
    proxyPool.opts.maxPool = 10;
    for (let i = 1; i <= 10; i++) seed(`cap.test:${i}`, { latency: i });
    assert.equal(proxyPool._upsert({ host: 'new.test', port: 11, source: 'list' }, true), null);
    assert.equal(proxyPool.alive.size, 10);
    // Curated/user routes must still get in: they are the trusted fallback set.
    assert.ok(proxyPool._upsert({ host: 'user.test', port: 12, source: 'user' }, true));
    assert.equal(proxyPool.alive.size, 11);
  } finally {
    restore();
  }
});

test('uptime fields survive a save/load round trip', async () => {
  const realSave = proxyPool._save;
  const restore = withCleanPool();
  const tmp = '/tmp/opencode/proxy-uptime-roundtrip.json';
  try {
    proxyPool.file = tmp;
    proxyPool._save = realSave;
    seed('persist.test:1', {
      sessions: 4, totalUptimeMs: 3700000, lifetimeUptimeMs: 3700000,
      bestUptimeMs: 3700000, shortSessions: 0, longSessions: 0,
      recent: [{ ms: 3700000, at: 1 }],
    });
    proxyPool._save();
    await new Promise((resolve) => setTimeout(resolve, 900));
    proxyPool.alive.clear();
    proxyPool._load();
    const p = proxyPool.alive.get('persist.test:1');
    assert.equal(p.totalUptimeMs, 3700000);
    assert.equal(p.bestUptimeMs, 3700000);
    assert.equal(p.sessions, 4);
    assert.equal(p.shortSessions, 0);
    assert.equal(p.recent[0].ms, 3700000);
  } finally {
    if (proxyPool._saveTimer) { clearTimeout(proxyPool._saveTimer); proxyPool._saveTimer = null; }
    try { fs.unlinkSync(tmp); } catch (_) {}
    restore();
  }
});
