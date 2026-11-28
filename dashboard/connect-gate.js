'use strict';

// Velocity rate-limits joins per egress IP ("You are logging in too fast").
// The gate is therefore per proxy IP, not global: two bots on different routes
// may dial together, but two bots sharing one IP must be spaced out.

const IP_GAP_MS = 30000;
const nextByIp = new Map();
let blockedUntil = 0;

function time(now) {
  const t = Number(now);
  return Number.isFinite(t) ? t : Date.now();
}

function keyOf(ip) {
  return String(ip || 'default');
}

/** Milliseconds before this IP may dial. Does not reserve anything. */
function waitFor(ip, now) {
  const t = time(now);
  return Math.max(0, Math.max(nextByIp.get(keyOf(ip)) || 0, blockedUntil) - t);
}

/** Reserve the next slot for this IP and return how long to wait before dialling. */
function take(ip, now) {
  const t = time(now);
  const key = keyOf(ip);
  const at = Math.max(t, nextByIp.get(key) || 0, blockedUntil);
  nextByIp.set(key, at + IP_GAP_MS);
  return at - t;
}

function block(ms, now) {
  const delay = Math.max(0, Number(ms) || 0);
  blockedUntil = Math.max(blockedUntil, time(now) + delay);
}

function reset() {
  nextByIp.clear();
  blockedUntil = 0;
}

module.exports = { IP_GAP_MS, take, waitFor, block, reset };
