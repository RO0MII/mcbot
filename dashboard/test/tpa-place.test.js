'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  isPlayerChat,
  isTpaTeleportProof,
  isTpaAcceptance,
  isTpaQueueTrigger,
  isTpaQueueBot,
  savedSpotNeedsTpa,
} = require('../tpa-place');

test('teleport proof accepts server lines but not player chat', () => {
  assert.equal(isTpaTeleportProof('You have been teleported successfully.'), true);
  assert.equal(isTpaTeleportProof('Teleporting you to RO0MII.'), true);
  assert.equal(isTpaTeleportProof('RO0MII: teleported successfully'), false);
  assert.equal(isPlayerChat('RO0MII: teleported successfully'), true);
  assert.equal(isPlayerChat('<RO0MII> teleported successfully'), true);
  assert.equal(isPlayerChat('You have been teleported successfully.'), false);
});

test('acceptance recognises Essentials wording, not our own request echo', () => {
  assert.equal(isTpaAcceptance('RO0MII accepted your tpa request.'), true);
  assert.equal(isTpaAcceptance('RO0MII accepted your teleport request.'), true);
  assert.equal(isTpaAcceptance('You have requested RO0MII to teleport to you.'), false);
  assert.equal(isTpaAcceptance('RO0MII sent you a tpahere request.'), false);
});

test('a saved place away from spawn needs a TPA restore, a nearby spot does not', () => {
  const spawn = { x: 0, y: 73, z: 0 };
  const place = { x: 10.7, y: 74, z: 2.3 };
  assert.equal(savedSpotNeedsTpa(place, spawn, true), true, 'learned place restores via TPA');
  assert.equal(savedSpotNeedsTpa(place, spawn, false), true, 'legacy far spot also restores');
  assert.equal(savedSpotNeedsTpa(place, { x: 10.4, y: 74, z: 2.1 }, true), false, 'already at the spot');
  assert.equal(savedSpotNeedsTpa({ x: 0.5, y: 73, z: 0.5 }, spawn, false), false, 'spawn-near walk spot uses /afk');
});

test('only the exact chat "onna" from RO0MII starts the TPA queue', () => {
  assert.equal(isTpaQueueTrigger('RO0MII: onna', true), true);
  assert.equal(isTpaQueueTrigger('<RO0MII> onna', true), true);
  assert.equal(isTpaQueueTrigger('RO0MII: ONNA', true), true);
  assert.equal(isTpaQueueTrigger('RO0MII: onna please', true), false);
  assert.equal(isTpaQueueTrigger('RO0MII: teleport me', true), false);
  assert.equal(isTpaQueueTrigger('Someone: onna', false), false);
  assert.equal(isTpaQueueTrigger('onna', false), false);
  assert.equal(isTpaQueueTrigger('RO0MII sent you a tpahere request.', false), false);
});

test('the TPA queue takes arena bots and bots waiting for a restore', () => {
  const base = { wanted: true, status: 'online', loggedIn: true, autoAfk: true };
  assert.equal(isTpaQueueBot({ ...base, inArena: true, awaitingRestore: false }), true);
  assert.equal(isTpaQueueBot({ ...base, inArena: false, awaitingRestore: true }), true);
  assert.equal(isTpaQueueBot({ ...base, inArena: false, awaitingRestore: false }), false);
  assert.equal(isTpaQueueBot({ ...base, status: 'connecting', inArena: true }), false);
  assert.equal(isTpaQueueBot({ ...base, loggedIn: false, inArena: true }), false);
  assert.equal(isTpaQueueBot({ ...base, autoAfk: false, inArena: true }), false);
  assert.equal(isTpaQueueBot({ ...base, wanted: false, inArena: true }), false);
});
