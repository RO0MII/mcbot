'use strict';

/** Parse a server ban message into an auto-restart cooldown.
 *
 * Permanent bans are never retried — the user has to appeal. Temporary bans
 * carry their own duration ("banned for 3 Days"), which is used as the exact
 * cooldown instead of the old fixed 30-minute guess. A third-person message
 * ("CONSOLE banned lachith for 3 Days") records the owner so the kick handler
 * can ignore a ban that belongs to another player.
 */
const UNITS = {
  second: 1000,
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};

function parseBanDuration(reason, now = Date.now()) {
  const text = String(reason || '').replace(/\s+/g, ' ').trim();
  const permanent = /permanently banned|ip-banned by an operator|appeal at/i.test(text);
  const match = text.match(/\b(?:for|duration:?)\s+(\d+)\s*(second|minute|hour|day)s?\b/i);
  const ownerMatch = text.match(/\bbanned\s+(?:player\s+)?([A-Za-z0-9_.-]{2,16})\s+(?:for|because)\b/i);
  const ms = match
    ? Number(match[1]) * UNITS[match[2].toLowerCase()]
    : 30 * 60 * 1000;
  return {
    permanent,
    ms: permanent ? 0 : ms,
    until: permanent ? 0 : (Number(now) || Date.now()) + ms,
    owner: ownerMatch ? ownerMatch[1] : '',
    text: text.slice(0, 400),
  };
}

module.exports = { parseBanDuration };
