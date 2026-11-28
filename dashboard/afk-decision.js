'use strict';

// Pure decision for the one AFK action a reconnecting bot may take.
//
// The spawn event fires *before* login is confirmed, and its coordinates are
// the lobby (-468, 98, 368), not the real arena. Deciding at that moment used
// to call _startTpaRestore() while loggedIn was still false, which returned
// silently and left the bot at spawn with no /afk and no retry. Keep the
// decision here so it can be tested, and always return "wait" until both
// login and the settled position are available.

const { savedSpotNeedsTpa } = require('./tpa-place');

function chooseAfkAction(s) {
  if (!s.wanted) return 'none';
  if (s.inAfkArena || s.autoAfkSent) return 'none';
  if (s.autoLogin && !s.loggedIn) return 'wait';
  if (!s.settled) return 'wait';

  const pos = s.pos;
  if (!pos) return 'afk';

  const home = s.home;
  const flat = home ? Math.hypot(pos.x - home.x, pos.z - home.z) : Infinity;
  const vertical = home ? Math.abs(pos.y - home.y) : Infinity;
  if (flat <= 3 && vertical <= 2) return 'stay';

  // Only a spot the user placed through /tpa must wait for RO0MII's "onna"
  // command. Reconnect never sends /tpa by itself; legacy spots learned from
  // the arena walk still use /afk.
  if (pos.y > 10 && s.placed && savedSpotNeedsTpa(home, pos, true)) return 'restore';

  return 'afk';
}

module.exports = { chooseAfkAction };
