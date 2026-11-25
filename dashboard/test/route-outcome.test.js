'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyDisconnect, isTransientKick } = require('../route-outcome');

const proxy = { ip: '1.2.3.4', port: 8080 };

test('a connected bot that ends with no reason retires the dead live route', () => {
  const result = classifyDisconnect({
    proxy,
    wanted: true,
    connectedAt: 1000,
    sawKick: false,
    lastKick: '',
    permanentBan: false,
    bannedUntil: 0,
    rateLimitedUntil: 0,
    transientKickUntil: 0,
    now: 2000,
  });
  assert.equal(result.silentDrop, true);
  assert.equal(result.routeFailed, true);
  assert.equal(result.severity, 'retire');
});

test('a manual stop is not a route failure', () => {
  const result = classifyDisconnect({
    proxy,
    wanted: false,
    connectedAt: 1000,
    now: 2000,
  });
  assert.equal(result.silentDrop, false);
  assert.equal(result.routeFailed, false);
  assert.equal(result.severity, null);
});

test('a Velocity backend error keeps the proven route and waits to rejoin', () => {
  const result = classifyDisconnect({
    proxy,
    wanted: true,
    connectedAt: 1000,
    sawKick: true,
    lastKick: 'An internal error occurred in your connection',
    transientKickUntil: 3000,
    now: 2000,
  });
  assert.equal(result.silentDrop, false);
  assert.equal(result.transientWait, 1000);
  assert.equal(result.routeFailed, false);
  assert.equal(result.severity, null);
});

test('a ban is not treated as a proxy failure', () => {
  const result = classifyDisconnect({
    proxy,
    wanted: true,
    connectedAt: 1000,
    sawKick: true,
    lastKick: 'You are permanently banned',
    permanentBan: true,
    transientKickUntil: 0,
    now: 2000,
  });
  assert.equal(result.silentDrop, false);
  assert.equal(result.routeFailed, false);
  assert.equal(result.severity, null);
});

test('an already-online ghost session waits instead of burning proxy routes', () => {
  const result = classifyDisconnect({
    proxy,
    wanted: true,
    connectedAt: 0,
    sawKick: true,
    lastKick: 'This player is already online',
    ghostSessionUntil: 5000,
    now: 2000,
  });
  assert.equal(result.ghostWait, 3000);
  assert.equal(result.routeFailed, false);
  assert.equal(result.severity, null);
});

test('a failed handshake is a cooldown route failure', () => {
  const result = classifyDisconnect({
    proxy,
    wanted: true,
    connectedAt: 0,
    now: 2000,
  });
  assert.equal(result.handshakeFailed, true);
  assert.equal(result.silentDrop, false);
  assert.equal(result.routeFailed, true);
  assert.equal(result.severity, 'cooldown');
});

test('an auth-backend kick is a server hiccup, not a dead proxy route', () => {
  assert.equal(isTransientKick('Unable to connect to auth: An internal server connection error occurred.'), true);
  assert.equal(isTransientKick('An internal error occurred in your connection'), true);
  assert.equal(isTransientKick('disconnect.timeout'), true);
  // Real rejections must still be handled normally.
  assert.equal(isTransientKick('You are permanently banned'), false);
  assert.equal(isTransientKick('The server is full'), false);
});
