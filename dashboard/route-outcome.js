'use strict';

/**
 * Decide what a bot's `end` event means for its proxy route.
 *
 * The dashboard must not treat a deliberate stop, a ban or a server-side kick
 * as a dead proxy. It must also not reuse a route that silently dropped a
 * live session — the user sees "Disconnected." with no reason, so the failure
 * has to be inferred from the absence of any other explanation.
 */
// Velocity can drop a healthy login before auth finishes. The text differs
// between backend nodes ("internal error occurred in your connection" vs
// "unable to connect to auth"), but both mean "try the same route again in a
// few seconds" — not "this proxy is dead, burn it and pick an untested one".
const TRANSIENT_KICK = /internal error occurred in your connection|disconnect\.timeout|unable to connect to auth|internal (?:server|authentication) (?:connection )?error|authentication server (?:error|unavailable)/i;

function isTransientKick(reason) {
  return TRANSIENT_KICK.test(String(reason || ''));
}

function classifyDisconnect(s) {
  const now = Number(s.now) || Date.now();
  const proxy = s.proxy;
  const connectedAt = Number(s.connectedAt) || 0;
  // Velocity backend errors are a server hiccup, not a proxy failure. Keep the
  // route and wait out the short rejoin window instead of exiling a proven IP.
  const transientWait = Math.max(0, (Number(s.transientKickUntil) || 0) - now);
  const transientKick = transientWait > 0;
  // "This player is already online" means the server still owns the previous
  // session. Switching proxy IPs cannot clear it; reconnecting too early just
  // burns every good route. Wait for the ghost session to expire instead.
  const ghostWait = Math.max(0, (Number(s.ghostSessionUntil) || 0) - now);
  const handshakeFailed = !!(proxy && !connectedAt && ghostWait === 0);
  const protectedReason = !!(
    s.sawKick || s.lastKick || s.permanentBan ||
    (Number(s.bannedUntil) > now) ||
    (Number(s.rateLimitedUntil) > now)
  );

  const silentDrop = !!(
    proxy && s.wanted !== false && connectedAt && !handshakeFailed &&
    !transientKick && !protectedReason && ghostWait === 0
  );

  const routeFailed = handshakeFailed || silentDrop;
  let severity = null;
  if (handshakeFailed) severity = 'cooldown';
  // A silent drop after the bot was already playing means the route died
  // mid-session — exactly the 4–6 minute disconnect pattern. Do not let that
  // address back into rotation after a short cooldown.
  else if (silentDrop) severity = 'retire';

  return { handshakeFailed, transientKick, silentDrop, routeFailed, severity, ghostWait, transientWait };
}

module.exports = { classifyDisconnect, isTransientKick };
