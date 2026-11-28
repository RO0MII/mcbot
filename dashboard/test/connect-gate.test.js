'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const connectGate = require('../connect-gate');

test('two bots on different proxy IPs can connect at the same time', () => {
  connectGate.reset();
  assert.equal(connectGate.take('1.1.1.1', 1000), 0);
  assert.equal(connectGate.take('2.2.2.2', 1000), 0);
});

test('two bots on the same proxy IP are spaced out', () => {
  connectGate.reset();
  assert.equal(connectGate.take('1.1.1.1', 1000), 0);
  const second = connectGate.take('1.1.1.1', 1000);
  assert.ok(second >= connectGate.IP_GAP_MS, `second wait was ${second}ms`);
});

test('waitFor reports a busy IP without consuming its slot', () => {
  connectGate.reset();
  connectGate.take('1.1.1.1', 1000);
  assert.equal(connectGate.waitFor('2.2.2.2', 1000), 0);
  assert.ok(connectGate.waitFor('1.1.1.1', 1000) >= connectGate.IP_GAP_MS);
  assert.ok(connectGate.take('1.1.1.1', 1000) >= connectGate.IP_GAP_MS);
});

test('a server block delays every IP', () => {
  connectGate.reset();
  connectGate.block(5000, 1000);
  assert.equal(connectGate.waitFor('1.1.1.1', 1000), 5000);
  assert.equal(connectGate.take('1.1.1.1', 1000), 5000);
});

test('bots waking from the same block still get staggered on one IP', () => {
  connectGate.reset();
  connectGate.block(5000, 1000);
  assert.equal(connectGate.take('1.1.1.1', 6000), 0);
  assert.ok(connectGate.take('1.1.1.1', 6000) >= connectGate.IP_GAP_MS);
});
