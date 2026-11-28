'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseAfkAction } = require('../afk-decision');

const lobby = { x: -468.5, y: 98, z: 368.4 };

test('does not decide before login — the spawn position is still the lobby', () => {
  assert.equal(chooseAfkAction({
    wanted: true,
    autoLogin: true,
    loggedIn: false,
    settled: true,
    inAfkArena: false,
    autoAfkSent: false,
    home: { x: 1.2, y: 73, z: 1.7 },
    placed: false,
    pos: lobby,
  }), 'wait');
});

test('does not decide before the post-login position settles', () => {
  assert.equal(chooseAfkAction({
    wanted: true,
    autoLogin: true,
    loggedIn: true,
    settled: false,
    inAfkArena: false,
    autoAfkSent: false,
    home: { x: 1.2, y: 73, z: 1.7 },
    placed: false,
    pos: lobby,
  }), 'wait');
});

test('stays put when the settled spawn is the saved spot', () => {
  assert.equal(chooseAfkAction({
    wanted: true,
    autoLogin: true,
    loggedIn: true,
    settled: true,
    inAfkArena: false,
    autoAfkSent: false,
    home: { x: 1.2, y: 73, z: 1.7 },
    placed: false,
    pos: { x: 0.5, y: 73, z: 0.5 },
  }), 'stay');
});

test('waits for the onna trigger instead of auto-sending /tpa for a placed spot', () => {
  assert.equal(chooseAfkAction({
    wanted: true,
    autoLogin: true,
    loggedIn: true,
    settled: true,
    inAfkArena: false,
    autoAfkSent: false,
    home: { x: 10.1, y: 75, z: 8.7 },
    placed: true,
    pos: { x: 0, y: 73, z: 0 },
  }), 'restore');
});

test('sends /afk for a legacy spot after login', () => {
  assert.equal(chooseAfkAction({
    wanted: true,
    autoLogin: true,
    loggedIn: true,
    settled: true,
    inAfkArena: false,
    autoAfkSent: false,
    home: { x: 1.2, y: 73, z: 1.7 },
    placed: false,
    pos: { x: 40, y: 73, z: 20 },
  }), 'afk');
});

test('does nothing once this session already started its AFK sequence', () => {
  assert.equal(chooseAfkAction({
    wanted: true,
    autoLogin: true,
    loggedIn: true,
    settled: true,
    inAfkArena: true,
    autoAfkSent: true,
    home: { x: 1.2, y: 73, z: 1.7 },
    placed: false,
    pos: { x: 0, y: 73, z: 0 },
  }), 'none');
});
