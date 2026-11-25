'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { recordSession, uptimeTier, uptimeSummary, GOOD_SESSION_MS } = require('../proxy-uptime');

test('a one-hour session with no drops is good', () => {
  const p = {};
  recordSession(p, GOOD_SESSION_MS, 1000);
  assert.equal(uptimeTier(p), 'good');
  assert.equal(p.shortSessions, 0);
  assert.equal(p.totalUptimeMs, GOOD_SESSION_MS);
});

test('a 30-minute session is trial, not good', () => {
  const p = {};
  recordSession(p, 30 * 60 * 1000, 1000);
  assert.equal(uptimeTier(p), 'trial');
});

test('lifetime uptime accumulates without a cap', () => {
  const p = {};
  const twoHours = 2 * 60 * 60 * 1000;
  const threeHours = 3 * 60 * 60 * 1000;
  recordSession(p, twoHours, 1000);
  recordSession(p, threeHours, 2000);
  assert.equal(p.totalUptimeMs, twoHours + threeHours);
  assert.equal(p.bestUptimeMs, threeHours);
  assert.equal(uptimeSummary(p).lifetimeUptimeSec, 5 * 60 * 60);
});

test('legacy records are unknown', () => {
  assert.equal(uptimeTier({}), 'unknown');
});

test('a later short session removes clean status but keeps history', () => {
  const p = {};
  recordSession(p, GOOD_SESSION_MS, 1000);
  recordSession(p, 60 * 1000, 2000);
  assert.equal(p.bestUptimeMs, GOOD_SESSION_MS);
  assert.equal(p.totalUptimeMs, GOOD_SESSION_MS + 60 * 1000);
  assert.equal(p.shortSessions, 1);
  assert.equal(uptimeTier(p), 'trial');
});

test('recent history is capped at ten entries', () => {
  const p = {};
  for (let i = 0; i < 15; i++) recordSession(p, 1000 + i, 1000 + i);
  assert.equal(p.recent.length, 10);
  assert.equal(p.recent[0].ms, 1005);
  assert.equal(p.sessions, 15);
});

test('uptime summary reports lifetime and best seconds', () => {
  const p = {};
  recordSession(p, 20 * 60 * 1000, 1000);
  const s = uptimeSummary(p);
  assert.equal(s.tier, 'trial');
  assert.equal(s.bestUptimeSec, 1200);
  assert.equal(s.lifetimeUptimeSec, 1200);
  assert.equal(s.avgUptimeSec, 1200);
});
