'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const proxyPool = require('../proxy-pool');

test('a rubber-banding route is cooled down, not retired outright', () => {
  const key = 'walk-failure.test:9999';
  const prior = proxyPool.alive.get(key);
  const save = proxyPool._save;
  const log = proxyPool.log;
  proxyPool._save = () => {};
  proxyPool.log = () => {};
  try {
    proxyPool.alive.set(key, { key, host: 'walk-failure.test', port: 9999, retired: false });
    proxyPool.reportWalkFailure({ ip: 'walk-failure.test', port: 9999 });
    const p = proxyPool.alive.get(key);
    assert.equal(p.retired, false);
    assert.ok(p.quarantineUntil > Date.now());
  } finally {
    if (prior) proxyPool.alive.set(key, prior);
    else proxyPool.alive.delete(key);
    proxyPool._save = save;
    proxyPool.log = log;
  }
});
