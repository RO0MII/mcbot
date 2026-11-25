'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBanDuration } = require('../ban-duration');

const NOW = 1795000000000;

test('a 3-day Wurst Client ban sets a 72-hour cooldown', () => {
  const result = parseBanDuration('You are banned for 3 Days (Detected disallowed mod: Wurst Client)', NOW);
  assert.equal(result.permanent, false);
  assert.equal(result.ms, 3 * 24 * 60 * 60 * 1000);
  assert.equal(result.until, NOW + result.ms);
});

test('hours and minutes are parsed too', () => {
  assert.equal(parseBanDuration('banned for 12 hours', NOW).ms, 12 * 60 * 60 * 1000);
  assert.equal(parseBanDuration('banned for 45 minutes', NOW).ms, 45 * 60 * 1000);
});

test('a permanent ban is never given an auto-restart time', () => {
  const result = parseBanDuration('You have been permanently banned. Appeal at https://discord.gg/sgrcFUdjXU', NOW);
  assert.equal(result.permanent, true);
  assert.equal(result.until, 0);
});

test('an unspecified ban keeps the conservative 30-minute cooldown', () => {
  const result = parseBanDuration('You are banned from this server', NOW);
  assert.equal(result.permanent, false);
  assert.equal(result.ms, 30 * 60 * 1000);
});

test('another player being banned in chat is not a ban on this bot', () => {
  const result = parseBanDuration('CONSOLE banned lachith for 3 Days (Detected disallowed mod: Wurst Client)', NOW);
  // The kick handler only receives kick packets, but be defensive: a player
  // name in the text must not be mistaken for this bot's own duration.
  assert.equal(result.owner, 'lachith');
});
