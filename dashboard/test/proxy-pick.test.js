'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const proxyPool = require('../proxy-pool');

test('pick drops a retired or quarantined sticky assignment', () => {
  const saved = {
    alive: new Map(proxyPool.alive),
    assignments: new Map(proxyPool.assignments),
    names: new Map(proxyPool.names),
    enabled: proxyPool.opts.enabled,
    webshare: { enabled: proxyPool.webshare.enabled, username: proxyPool.webshare.username },
    save: proxyPool._save,
    log: proxyPool.log,
  };
  proxyPool._save = () => {};
  proxyPool.log = () => {};
  proxyPool.opts.enabled = true;
  proxyPool.webshare.enabled = false;
  proxyPool.webshare.username = '';
  const bad = 'retired.test:1111';
  const good = 'healthy.test:2222';
  try {
    proxyPool.alive.clear();
    proxyPool.assignments.clear();
    proxyPool.alive.set(bad, {
      key: bad, host: 'retired.test', port: 1111, retired: true,
      quarantineUntil: 0, latency: 10, successes: 0, source: 'user',
    });
    proxyPool.alive.set(good, {
      key: good, host: 'healthy.test', port: 2222, retired: false,
      quarantineUntil: 0, latency: 12, successes: 0, source: 'user',
    });
    proxyPool.assignments.set('bot-under-test', bad);
    const picked = proxyPool.pick('bot-under-test', 'tester');
    assert.equal(picked.key, good);
    assert.equal(proxyPool.assignments.get('bot-under-test'), good);
  } finally {
    proxyPool.alive.clear();
    saved.alive.forEach((v, k) => proxyPool.alive.set(k, v));
    proxyPool.assignments.clear();
    saved.assignments.forEach((v, k) => proxyPool.assignments.set(k, v));
    proxyPool.names.clear();
    saved.names.forEach((v, k) => proxyPool.names.set(k, v));
    proxyPool.opts.enabled = saved.enabled;
    proxyPool.webshare.enabled = saved.webshare.enabled;
    proxyPool.webshare.username = saved.webshare.username;
    proxyPool._save = saved.save;
    proxyPool.log = saved.log;
  }
});
