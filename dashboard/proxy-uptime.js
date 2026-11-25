'use strict';

/** Real session uptime accounting for proxy routes.
 *
 * A successful handshake is not enough: a route that drops after 30 seconds
 * must not earn the same trust as one that stays online for hours. 1 hour is
 * the minimum evidence for a "clean/good" route; after that routes are ranked
 * by cumulative lifetime uptime, with no cap.
 */

const GOOD_SESSION_MS = 60 * 60 * 1000;
const SHORT_SESSION_MS = 10 * 60 * 1000;
const RECENT_LIMIT = 10;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Fold one completed bot session into a proxy record. Mutates and returns it. */
function recordSession(record, durationMs, now = Date.now()) {
  const p = record || {};
  const ms = Math.max(0, num(durationMs));
  p.sessions = num(p.sessions) + 1;
  p.totalUptimeMs = num(p.totalUptimeMs) + ms;
  p.lifetimeUptimeMs = p.totalUptimeMs;
  p.bestUptimeMs = Math.max(num(p.bestUptimeMs), ms);
  p.shortSessions = num(p.shortSessions);
  p.longSessions = num(p.longSessions);
  if (ms < SHORT_SESSION_MS) p.shortSessions += 1;
  if (ms >= GOOD_SESSION_MS) p.longSessions += 1;
  if (!Array.isArray(p.recent)) p.recent = [];
  p.recent.push({ ms, at: num(now) || Date.now() });
  if (p.recent.length > RECENT_LIMIT) p.recent = p.recent.slice(-RECENT_LIMIT);
  return p;
}

/** good = never dropped early and has survived at least one hour.
 *  bad = three early drops; trial = recovering or not yet proven. */
function uptimeTier(record) {
  if (!record) return 'unknown';
  const shortSessions = num(record.shortSessions);
  const bestUptimeMs = num(record.bestUptimeMs);
  if (shortSessions >= 3) return 'bad';
  if (shortSessions === 0 && bestUptimeMs >= GOOD_SESSION_MS) return 'good';
  if (bestUptimeMs >= SHORT_SESSION_MS) return 'trial';
  return 'unknown';
}

function uptimeSummary(record) {
  const sessions = num(record && record.sessions);
  const totalUptimeMs = num(record && record.totalUptimeMs);
  const bestUptimeMs = num(record && record.bestUptimeMs);
  return {
    sessions,
    totalUptimeMs,
    lifetimeUptimeMs: totalUptimeMs,
    bestUptimeMs,
    shortSessions: num(record && record.shortSessions),
    tier: uptimeTier(record),
    lifetimeUptimeSec: Math.round(totalUptimeMs / 1000),
    bestUptimeSec: Math.round(bestUptimeMs / 1000),
    avgUptimeSec: sessions ? Math.round(totalUptimeMs / sessions / 1000) : 0,
  };
}

module.exports = {
  GOOD_SESSION_MS,
  SHORT_SESSION_MS,
  recordSession,
  uptimeTier,
  uptimeSummary,
};
