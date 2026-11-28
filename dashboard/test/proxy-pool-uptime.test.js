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

test('a long-lived route is cooled, not retired, after three game failures', () => {
  const restore = withCleanPool();
  try {
    const key = 'game.test:1';
    seed(key, { bestUptimeMs: 2 * HOUR, totalUptimeMs: 5 * HOUR, shortSessions: 0 });
    proxyPool.reportGameFailure({ ip: 'game.test', port: 1 });
    assert.equal(proxyPool.alive.get(key).retired, false);
    assert.ok(proxyPool.alive.get(key).quarantineUntil > Date.now());
    proxyPool.reportGameFailure({ ip: 'game.test', port: 1 });
    assert.equal(proxyPool.alive.get(key).retired, false);
    proxyPool.reportGameFailure({ ip: 'game.test', port: 1 });
    assert.equal(proxyPool.alive.get(key).retired, false);
    // Once the cooldown expires the hours-old route is still worth a bot.
    proxyPool.alive.get(key).quarantineUntil = 0;
    assert.equal(proxyPool.pick('b-proven').key, key);
    proxyPool.reportGameFailure({ ip: 'game.test', port: 1 });
    assert.equal(proxyPool.alive.get(key).retired, true);
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

test('a free healthy route is still preferred over a shared one', () => {
  const restore = withCleanPool();
  try {
    seed('taken.test:1', { latency: 20 });
    seed('free.test:2', { latency: 900 });
    proxyPool.assignments.set('bot-a', 'taken.test:1');
    assert.equal(proxyPool.pick('bot-b').key, 'free.test:2');
  } finally {
    restore();
  }
});

test('unproven curated routes are tried only after discovered routes', () => {
  const restore = withCleanPool();
  try {
    seed('newuser.test:1', { source: 'user', latency: 10 });
    seed('discovered.test:2', { source: 'list', region: 'asia', latency: 300 });
    assert.equal(proxyPool.pick('b-rank').key, 'discovered.test:2');
  } finally {
    restore();
  }
});

test('one IP is never given to a second bot when every route is assigned', () => {
  const restore = withCleanPool();
  try {
    seed('only.test:1', { latency: 20 });
    proxyPool.assignments.set('bot-a', 'only.test:1');
    assert.equal(proxyPool.pick('bot-b'), null);
    assert.equal(proxyPool.assignments.has('bot-b'), false);
    // Cleanup must not invent a shared slot either.
    proxyPool.assignments.set('bot-b', 'only.test:1');
    proxyPool._pruneAssignments();
    assert.equal(proxyPool.assignments.has('bot-b'), false);
    assert.equal(proxyPool.assignments.get('bot-a'), 'only.test:1');
  } finally {
    restore();
  }
});

test('an endpoint probe does not erase handshake failure history', () => {
  const restore = withCleanPool();
  try {
    const key = 'probe.test:1';
    seed(key, { failStreak: 2, fails: 2, quarantineUntil: Date.now() + 60000 });
    proxyPool.probeOk({ ip: 'probe.test', port: 1, latency: 80 }, 80);
    const p = proxyPool.alive.get(key);
    assert.equal(p.failStreak, 2);
    assert.equal(p.fails, 2);
    assert.ok(p.quarantineUntil > Date.now());
    assert.ok(p.latency > 20);
  } finally {
    restore();
  }
});

test('a real game success clears failure history', () => {
  const restore = withCleanPool();
  try {
    const key = 'win.test:1';
    seed(key, { failStreak: 2, fails: 2, quarantineUntil: Date.now() + 60000, okAt: Date.now() - 60000 });
    proxyPool.reportOk({ ip: 'win.test', port: 1, latency: 90 });
    const p = proxyPool.alive.get(key);
    assert.equal(p.failStreak, 0);
    assert.equal(p.fails, 0);
    assert.equal(p.quarantineUntil, 0);
    assert.ok(p.successes >= 1);
  } finally {
    restore();
  }
});

test('refreshing a cached route keeps its failure history', () => {
  const restore = withCleanPool();
  try {
    const key = 'upsert.test:1';
    seed(key, { failStreak: 3, fails: 3, quarantineUntil: Date.now() + 60000 });
    proxyPool._upsert({ host: 'upsert.test', port: 1, protocol: 'socks5', latency: 30, okAt: Date.now() }, true);
    const p = proxyPool.alive.get(key);
    assert.equal(p.failStreak, 3);
    assert.equal(p.fails, 3);
    assert.ok(p.quarantineUntil > Date.now());
  } finally {
    restore();
  }
});

test('endpoint probes cannot keep a repeatedly failing route alive forever', () => {
  const restore = withCleanPool();
  try {
    const key = 'zombie.test:1';
    seed(key, { bestUptimeMs: 2 * HOUR });
    for (let i = 0; i < 4; i++) {
      proxyPool.alive.get(key).lastFail = 0; // count each distinct attempt
      proxyPool.reportFailure({ ip: 'zombie.test', port: 1 });
      proxyPool.probeOk({ ip: 'zombie.test', port: 1, latency: 70 }, 70);
    }
    assert.equal(proxyPool.alive.get(key).retired, true);
  } finally {
    restore();
  }
});

test('the health sweep runs once a minute', () => {
  const restore = withCleanPool();
  const savedCheck = proxyPool.lastHealthCheck;
  try {
    proxyPool.lastHealthCheck = 1000000;
    const health = proxyPool.status().health;
    assert.equal(health.intervalMs, 60000);
    assert.equal(health.nextCheck, 1060000);
  } finally {
    proxyPool.lastHealthCheck = savedCheck;
    restore();
  }
});

test('a reconnecting bot gets the route with the best single-session uptime', () => {
  const restore = withCleanPool();
  const savedRandom = Math.random;
  try {
    seed('long-total.test:1', {
      latency: 10, bestUptimeMs: 70 * 60 * 1000,
      totalUptimeMs: 20 * HOUR, shortSessions: 0,
    });
    seed('best-session.test:2', {
      latency: 900, bestUptimeMs: 5 * HOUR,
      totalUptimeMs: 6 * HOUR, shortSessions: 0,
    });
    Math.random = () => 0;
    assert.equal(proxyPool.pick('b-best').key, 'best-session.test:2');
  } finally {
    Math.random = savedRandom;
    restore();
  }
});

test('status().good ranks the longest clean session above lifetime uptime', () => {
  const restore = withCleanPool();
  try {
    seed('long-total.test:1', {
      bestUptimeMs: 90 * 60 * 1000, totalUptimeMs: 10 * HOUR, shortSessions: 0,
    });
    seed('best-session.test:2', {
      bestUptimeMs: 5 * HOUR, totalUptimeMs: 6 * HOUR, shortSessions: 0,
    });
    assert.equal(proxyPool.status().good[0].key, 'best-session.test:2');
  } finally {
    restore();
  }
});

test('a good endpoint probe lets a timed-out route back into rotation', () => {
  const restore = withCleanPool();
  try {
    const key = 'recover.test:1';
    seed(key, { latency: 100 });
    proxyPool._healthFail({ ip: 'recover.test', port: 1 }, 'timeout', 'probe');
    const cooled = proxyPool.alive.get(key);
    assert.ok(cooled.quarantineUntil > Date.now());
    // Quarantine has expired and the same endpoint answers this sweep.
    cooled.quarantineUntil = 0;
    cooled.lastProbeFail = 0;
    proxyPool.probeOk({ ip: 'recover.test', port: 1, latency: 60 }, 60);
    assert.equal(proxyPool.alive.get(key).probeFailStreak, 0);
    assert.equal(proxyPool.pick('b-recover').key, key);
  } finally {
    restore();
  }
});
