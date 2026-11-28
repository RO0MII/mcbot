'use strict';

// Pure helpers for the "place bot at RO0MII's spot with /tpa" flow. Keeping
// them here makes the chat matching and reconnect decision testable without
// starting the dashboard or opening a Minecraft session.

const TPA_NAME = 'RO0MII';

const FANCY = {
  'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f', 'ɢ': 'g', 'ʜ': 'h',
  'ɪ': 'i', 'ᴊ': 'j', 'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p',
  'ʀ': 'r', 'ꜱ': 's', 'ᴛ': 't', 'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'ʏ': 'y', 'ᴢ': 'z',
};
function normalize(text) {
  return String(text == null ? '' : text).replace(/[ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘʀꜱᴛᴜᴠᴡʏᴢ]/g, (c) => FANCY[c] || c);
}

function isPlayerChat(text) {
  const s = String(text == null ? '' : text).trim();
  return /^[A-Za-z0-9_.]{1,16}\s*:/.test(s) || /^<\s*[A-Za-z0-9_.]{1,16}\s*>/.test(s);
}

function isTpaTeleportProof(text) {
  const s = String(text == null ? '' : text);
  if (isPlayerChat(s)) return false;
  return /\b(?:teleported successfully|teleporting you to|teleported to|teleportation complete)\b/i.test(s);
}

function isTpaAcceptance(text) {
  const s = String(text == null ? '' : text);
  if (isPlayerChat(s)) return false;
  if (/\byou\s+(?:have\s+|just\s+)?request(?:ed|ing)?\b|\brequest\s+sent\b/i.test(s)) return false;
  const accepted = /\b(?:accepted|approved)\b/i.test(s);
  const tpa = new RegExp('\\b' + TPA_NAME + '\\b|\\b(?:tpa|tpahere|teleport)\\b', 'i');
  return accepted && tpa.test(s);
}

/** Should a reconnecting bot ask RO0MII for a teleport instead of sending /afk?
 *  A spot learned from a TPA landing is always restored. Legacy spots are
 *  inferred from distance: the old /afk walk never held a far-away position. */
function savedSpotNeedsTpa(home, pos, placed) {
  if (!home || !pos) return false;
  const hx = Number(home.x), hy = Number(home.y), hz = Number(home.z);
  const px = Number(pos.x), py = Number(pos.y), pz = Number(pos.z);
  if (![hx, hy, hz, px, py, pz].every(Number.isFinite)) return false;
  const flat = Math.hypot(hx - px, hz - pz);
  const vertical = Math.abs((hy || py) - py);
  if (flat <= 3 && vertical <= 2) return false;
  return !!placed || flat > 3;
}

// Strip the visible sender prefix before comparing a chat command.
function tpaCommandText(text) {
  let s = normalize(text).trim();
  s = s.replace(/^\s*<\s*[A-Za-z0-9_.]{1,16}\s*>\s*/, '');
  s = s.replace(/^\s*[A-Za-z0-9_.]{1,16}\s*:\s*/, '');
  return s.replace(/^["'“”]|["'“”]$/g, '').trim();
}

// The queue has exactly one chat trigger: RO0MII saying "onna". Nothing else
// (not even RO0MII's own "teleport..." messages) may send an outgoing /tpa.
function isTpaQueueTrigger(text, fromTrustedPlayer) {
  return !!fromTrustedPlayer && tpaCommandText(text).toLowerCase() === 'onna';
}

// Arena bots are the normal queue. A bot whose saved spot is away from spawn
// is also an arena bot; it is waiting for RO0MII's "onna" to be placed back.
function isTpaQueueBot(s) {
  return !!(s && s.wanted && s.status === 'online' && s.loggedIn && s.autoAfk &&
    (s.inArena || s.awaitingRestore));
}

module.exports = {
  TPA_NAME,
  isPlayerChat,
  isTpaTeleportProof,
  isTpaAcceptance,
  isTpaQueueTrigger,
  isTpaQueueBot,
  tpaCommandText,
  savedSpotNeedsTpa,
};
