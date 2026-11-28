'use strict';

// Proxy/handshake failures are external: waiting five minutes does not make a
// dead route work. Keep a small backoff so a flapping server is not hammered,
// then keep retrying every ~30s until spawn resets the counter. Bans and
// server throttles are handled separately with their own long waits.
const STEPS = [5000, 10000, 20000, 30000];

function routeRetryDelay(attempt) {
  const n = Math.max(1, Number(attempt) || 1);
  return STEPS[Math.min(n - 1, STEPS.length - 1)];
}

module.exports = { routeRetryDelay };
