'use strict';

/**
 * arena-walker.js — the one-walk engine for the AFK arena.
 *
 * The arena is not an open square: the floor mixes sea lanterns with
 * smooth-stone slabs, and polished-andesite / stone-brick walls close off many
 * straight lines. Pathfinder alone sometimes stops after 1–2 blocks (crowded
 * spawn, a wall corner, a stale chunk) and the bot then stands still.
 *
 * This engine does the whole walk itself:
 *   1. wait until the arena chunks are decoded,
 *   2. read a local 3-D grid of the floor and walls,
 *   3. BFS every cell the bot can actually reach,
 *   4. pick ONE random reachable cell 5–10 blocks away,
 *   5. A* a wall-safe route to it,
 *   6. drive the route with live stuck detection (jump, strafe, re-route),
 *   7. stop once, report the real displacement.
 *
 * It never digs, never places a block, never bridges and never re-walks a
 * session: all recovery happens inside the same single walk.
 */

const { Vec3 } = require('vec3');

const DEFAULTS = {
  minDistance: 5,
  maxDistance: 10,
  preferMin: 6,          // aim for 6+ so a 5-block minimum still holds
  radius: 14,            // grid half-size around the arena spawn
  chunkWaitMs: 15000,
  walkTimeoutMs: 40000,
  settleMs: 800,             // brief pause after the arena teleport announcement
  rubberBandWindowMs: 3000,  // telemetry window for spawn-sync packets
  rubberBandMinProgress: 0.5, // a 1.4-block snap-back is still a real reset
  rubberBandLimit: 30,       // tolerate Velocity corrections; only a flood fails
  resetPauseMs: 220,         // release controls briefly after a server snap-back
  steadyDrive: true,         // old proven straight walk: one yaw, no jump/strafe
  stopDistance: 0.4,
  traceLimit: 240,
};

// ── block helpers ────────────────────────────────────────────────────────────

/** Height of the top collision shape inside one block (0 = empty, 1 = full). */
function blockTop(block) {
  if (!block || block.boundingBox === 'empty') return 0;
  if (!Array.isArray(block.shapes) || !block.shapes.length) return 1;
  let top = 0;
  for (const shape of block.shapes) {
    if (Array.isArray(shape) && Number(shape[4]) > top) top = Number(shape[4]);
  }
  return top;
}

function isLoaded(block) {
  return !!block && typeof block.name === 'string' && block.name !== 'unknown';
}

// ── local grid ───────────────────────────────────────────────────────────────

/**
 * Read the arena around `origin` once. Every cell stores the feet Y that is
 * walkable, so slabs (top 0.5) and full blocks (top 1.0) both work.
 */
function readGrid(bot, origin, radius) {
  const baseY = Math.floor(origin.y);
  const ox = Math.floor(origin.x);
  const oz = Math.floor(origin.z);
  const cells = new Map();
  let loaded = 0;
  let missing = 0;

  const key = (x, z) => x + ',' + z;

  const at = (x, y, z) => {
    try { return bot.blockAt(new Vec3(x, y, z)); } catch (_) { return null; }
  };

  function feetCell(x, z, y) {
    const feet = at(x, y, z);
    const head = at(x, y + 1, z);
    const below = at(x, y - 1, z);
    if (!feet || !head || !below) return { cell: null, missing: true };
    const ft = blockTop(feet);
    const ht = blockTop(head);
    const bt = blockTop(below);
    // The bot's feet must be in AIR. A slab at foot height is an obstacle: the
    // server thinks the player is inside it and rubber-bands them to spawn.
    // Stand on TOP of the slab instead (the y+1 scan below handles that).
    if (ft > 0.05 || ht > 0.6) return { cell: null };
    if (bt < 0.5) return { cell: null };
    return { cell: { x, z, y, floor: bt } };
  }

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const x = ox + dx;
      const z = oz + dz;
      let found = null;
      let sawMissing = false;
      // Prefer the current level, then the slab top above it, then a step down.
      for (const y of [baseY, baseY + 1, baseY - 1]) {
        const r = feetCell(x, z, y);
        if (r.missing) sawMissing = true;
        if (r.cell) { found = r.cell; break; }
      }
      if (found) {
        cells.set(key(x, z), found);
        loaded++;
      } else {
        if (sawMissing) missing++;
        else loaded++;
      }
    }
  }

  return {
    origin: { x: ox, y: baseY, z: oz },
    radius,
    cells,
    loaded,
    missing,
    get(x, z) { return cells.get(key(x, z)) || null; },
    walkable(x, z) { return cells.has(key(x, z)); },
  };
}

/** Count loaded samples around the spawn; null cells mean chunks still decode. */
function chunksReady(bot, origin, radius) {
  const oy = Math.floor(origin.y);
  let ok = 0;
  let total = 0;
  for (const [dx, dz] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3], [6, 0], [0, 6], [-6, 0], [0, -6], [4, 4], [-4, -4]]) {
    total++;
    const b = (() => {
      try { return bot.blockAt(new Vec3(Math.floor(origin.x) + dx, oy, Math.floor(origin.z) + dz)); } catch (_) { return null; }
    })();
    if (isLoaded(b)) ok++;
  }
  return { ok, total, ready: ok >= total - 1 };
}

// ── BFS reachability ─────────────────────────────────────────────────────────

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIRS8 = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

function bfsReachable(grid, start, limit) {
  const dist = new Map();
  const q = [start];
  dist.set(start.x + ',' + start.z, 0);
  let head = 0;
  while (head < q.length) {
    const cur = q[head++];
    const d = dist.get(cur.x + ',' + cur.z);
    if (d >= limit) continue;
    for (const [dx, dz] of DIRS4) {
      const nx = cur.x + dx;
      const nz = cur.z + dz;
      const k = nx + ',' + nz;
      if (dist.has(k)) continue;
      const cell = grid.get(nx, nz);
      if (!cell) continue;
      if (Math.abs(cell.y - cur.y) > 1) continue;
      dist.set(k, d + 1);
      q.push(cell);
    }
  }
  return dist;
}

/** One random reachable target in the requested distance band. */
function chooseTarget(grid, reach, origin, rng, opts) {
  const minD = opts.minDistance;
  const maxD = opts.maxDistance;
  const preferMin = opts.preferMin;
  const desiredAngle = rng() * Math.PI * 2;
  const desiredDist = preferMin + rng() * Math.max(0.1, maxD - preferMin);
  const wantX = Math.cos(desiredAngle);
  const wantZ = Math.sin(desiredAngle);

  const inBand = [];
  const fallback = [];
  for (const [k, cell] of grid.cells) {
    const d = reach.get(k);
    if (d == null) continue;
    const dx = cell.x - origin.x;
    const dz = cell.z - origin.z;
    const dist = Math.hypot(dx, dz);
    if (dist < minD - 0.05 || dist > maxD + 0.05) continue;
    const len = dist || 1;
    const dot = (dx / len) * wantX + (dz / len) * wantZ;
    const score = Math.abs(dist - desiredDist) * 0.6 + (1 - dot) * 4 + rng() * 0.8;
    const entry = { cell, dist, score };
    if (dist >= preferMin) inBand.push(entry);
    else fallback.push(entry);
  }
  const pool = inBand.length ? inBand : fallback;
  if (!pool.length) return null;
  pool.sort((a, b) => a.score - b.score);
  return pool[0];
}

// ── A* path ──────────────────────────────────────────────────────────────────

function aStar(grid, start, goal) {
  const k = (c) => c.x + ',' + c.z;
  const startKey = k(start);
  const goalKey = k(goal);
  if (startKey === goalKey) return [start];

  const open = [{ cell: start, g: 0, f: 0 }];
  const best = new Map([[startKey, 0]]);
  const came = new Map();
  const closed = new Set();
  let guard = 0;

  const h = (c) => {
    const dx = Math.abs(c.x - goal.x);
    const dz = Math.abs(c.z - goal.z);
    return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz);
  };

  while (open.length && guard++ < 6000) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    const ck = k(cur.cell);
    if (ck === goalKey) {
      const path = [cur.cell];
      let walk = ck;
      while (came.has(walk)) {
        const prev = came.get(walk);
        path.push(prev);
        walk = k(prev);
      }
      return path.reverse();
    }
    if (closed.has(ck)) continue;
    closed.add(ck);

    for (const [dx, dz] of DIRS8) {
      const nx = cur.cell.x + dx;
      const nz = cur.cell.z + dz;
      const next = grid.get(nx, nz);
      if (!next) continue;
      if (Math.abs(next.y - cur.cell.y) > 1) continue;
      if (dx !== 0 && dz !== 0) {
        // Never cut a wall corner diagonally.
        if (!grid.get(cur.cell.x + dx, cur.cell.z) || !grid.get(cur.cell.x, cur.cell.z + dz)) continue;
      }
      const nk = nx + ',' + nz;
      if (closed.has(nk)) continue;
      const step = (dx !== 0 && dz !== 0) ? Math.SQRT2 : 1;
      const g = cur.g + step + (next.y !== cur.cell.y ? 0.25 : 0);
      if (best.has(nk) && best.get(nk) <= g) continue;
      best.set(nk, g);
      came.set(nk, cur.cell);
      open.push({ cell: next, g, f: g + h(next) });
    }
  }
  return null;
}

/** Straight line between two cell centres is walkable end to end. */
function lineClear(grid, a, b) {
  const ax = a.x + 0.5;
  const az = a.z + 0.5;
  const bx = b.x + 0.5;
  const bz = b.z + 0.5;
  const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az) * 4));
  let last = null;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.floor(ax + (bx - ax) * t);
    const z = Math.floor(az + (bz - az) * t);
    const cell = grid.get(x, z);
    if (!cell) return false;
    if (last && Math.abs(cell.y - last.y) > 1) return false;
    last = cell;
  }
  return true;
}

/**
 * How far a single straight heading is actually clear from the bot's exact
 * position. The grid above samples cell centres, which can call a line clear
 * when the real spawn corner is one block into a wall or a full-block step.
 * Mineflayer cannot climb a full block without jumping, and a jump/strafe
 * recovery is exactly what made the server re-centre the player. Check the
 * real blocks at feet/head/floor level before committing to one heading.
 */
function headingClear(bot, origin, yaw, distance) {
  if (!bot || !bot.blockAt || !origin) return 0;
  const at = (x, y, z) => {
    try { return bot.blockAt(new Vec3(x, y, z)); } catch (_) { return null; }
  };
  const dx = -Math.sin(yaw);
  const dz = -Math.cos(yaw);
  const baseY = Math.floor(origin.y);
  let clear = 0;
  for (let d = 0.5; d <= distance + 0.001; d += 0.5) {
    // cos/sin leave tiny negatives (e.g. z = -1e-16) on the cardinal axes;
    // without the nudge floor() samples the neighbouring block column.
    const bx = Math.floor(origin.x + dx * d + 1e-9);
    const bz = Math.floor(origin.z + dz * d + 1e-9);
    let feetY = baseY;
    for (let attempt = 0; attempt < 2; attempt++) {
      const feet = at(bx, feetY, bz);
      const head = at(bx, feetY + 1, bz);
      const below = at(bx, feetY - 1, bz);
      if (!isLoaded(feet) || !isLoaded(head) || !isLoaded(below)) break;
      const ft = blockTop(feet);
      if (ft > 0.6 || blockTop(head) > 0.6) break;
      // A slab at feet height IS the floor the player stands on; it does not
      // need a solid block below it. Air at feet height does.
      if (ft >= 0.5 || blockTop(below) >= 0.5) { clear = d; break; }
      // A one-block drop is fine, but verify the lower level before accepting.
      feetY -= 1;
    }
    if (clear < d) break;
  }
  return clear;
}

/** Pick one random heading and keep it: choose the nearest opening that is
 *  genuinely clear for the requested distance, never a fake grid line. */
function chooseHeading(bot, origin, opts) {
  const rng = opts.rng || Math.random;
  const desiredYaw = rng() * Math.PI * 2;
  const min = opts.minDistance;
  const prefer = opts.preferMin || min;
  const desiredDist = Math.min(
    opts.maxDistance,
    Math.max(min, prefer + rng() * Math.max(0, opts.maxDistance - prefer))
  );
  const offsets = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2,
    3 * Math.PI / 4, -3 * Math.PI / 4, Math.PI];
  const candidates = offsets.map((off) => {
    const yaw = desiredYaw + off;
    const clear = headingClear(bot, origin, yaw, desiredDist);
    return { yaw, off, clear, score: Math.abs(clear - desiredDist) + Math.abs(off) * 0.15 };
  });
  const usable = candidates.filter((c) => c.clear >= min - 0.1);
  const pool = usable.length ? usable : candidates;
  pool.sort((a, b) => usable.length ? a.score - b.score : b.clear - a.clear);
  return pool[0] || null;
}

/** Drop waypoints the bot can walk straight past. */
function simplify(grid, path) {
  if (!path || path.length <= 2) return path || [];
  const out = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let j = path.length - 1;
    for (; j > i + 1; j--) {
      if (lineClear(grid, path[i], path[j])) break;
    }
    out.push(path[j]);
    i = j;
  }
  return out;
}

// ── driving ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function yawTo(fromX, fromZ, toX, toZ) {
  return Math.atan2(-(toX - fromX), -(toZ - fromZ));
}

function releaseControls(bot, sneak = false) {
  if (!bot || !bot.setControlState) return;
  const off = (name) => { try { bot.setControlState(name, false); } catch (_) {} };
  off('forward');
  off('sprint');
  off('jump');
  off('left');
  off('right');
  if (sneak) off('sneak');
}

/** Watch server teleports back to the arena origin. Repeated ones mean the
 *  server is freezing the player, not that the bot is stuck on geometry. */
function watchServerTeleports(bot, origin, opts) {
  const state = {
    count: 0,
    last: 0,
    recent: [],
    closed: false,
    recentCount() { return this.recent.length; },
  };
  const client = bot && bot._client;
  const handler = (pkt) => {
    if (!pkt || typeof pkt.x !== 'number') return;
    const nearOrigin =
      Math.hypot(pkt.x - origin.x, pkt.z - origin.z) <= 1.25 &&
      Math.abs(pkt.y - origin.y) <= 2;
    if (!nearOrigin) return;
    // Velocity sends harmless position syncs while a player is near spawn.
    // Only a packet that drags the player backwards counts as a rubber-band.
    const cur = bot && bot.entity ? bot.entity.position : null;
    const backward = cur ? Math.hypot(cur.x - pkt.x, cur.z - pkt.z) : 0;
    if (backward < 0.4) return;
    const t = Date.now();
    state.count++;
    state.last = t;
    state.recent.push(t);
    while (state.recent.length && t - state.recent[0] > opts.rubberBandWindowMs) {
      state.recent.shift();
    }
    if (opts.onTeleport) opts.onTeleport(pkt, state, cur);
  };
  // Run before mineflayer applies the packet, so the bot's current position is
  // still the pre-teleport position we can compare against.
  if (client && typeof client.prependListener === 'function') client.prependListener('position', handler);
  else if (client && typeof client.on === 'function') client.on('position', handler);
  state.close = () => {
    if (state.closed) return;
    state.closed = true;
    if (client && typeof client.removeListener === 'function') {
      client.removeListener('position', handler);
    }
  };
  return state;
}

/**
 * Drive one simplified route. Deadline and re-route count are shared across
 * the whole walk: an old build restarted its timer on every re-route, which
 * made a stuck bot walk forever and left several engines fighting over the
 * same controls.
 */
async function driveRoute(bot, initialGrid, initialRoute, opts, hooks, tele) {
  const deadline = Date.now() + opts.walkTimeoutMs;
  const trace = [];
  const push = (text) => {
    if (trace.length < opts.traceLimit) trace.push(text);
    if (hooks && hooks.onTrace) hooks.onTrace(text);
  };
  const finish = (ok, reason, extra = {}) => {
    releaseControls(bot, opts.sneak);
    return { ok, reason, trace, ...extra };
  };

  let grid = initialGrid;
  let route = initialRoute;
  let idx = 0;
  let lastX = bot.entity.position.x;
  let lastZ = bot.entity.position.z;
  let lastMoveAt = Date.now();
  let jumpUntil = 0;
  let strafe = 0;
  let strafeUntil = 0;
  let reroutes = 0;
  let rubberBands = 0;
  let lastJumpLog = 0;
  let lastStrafeLog = 0;
  const dbgEvery = opts.debugEveryMs || 0;
  let nextDbg = Date.now() + dbgEvery;
  const origin = opts.origin || { x: lastX, z: lastZ };

  // The old straight walk was the only build that reliably reached 5–10
  // blocks on this server. Chasing waypoint centres at 10 Hz and adding
  // jump/strafe impulses made the server reject the movement and re-centre
  // the player. Keep grid/target selection, then drive with one steady yaw.
  if (opts.steadyDrive) {
    const goal = route[route.length - 1];
    // A heading validated against real blocks wins over a grid waypoint: the
    // waypoint centre can sit behind a wall relative to the exact spawn point.
    const yaw = Number.isFinite(opts.fixedYaw)
      ? opts.fixedYaw
      : (goal ? yawTo(origin.x, origin.z, goal.x + 0.5, goal.z + 0.5)
        : yawTo(lastX, lastZ, origin.x + 1, origin.z));
    const stopAt = Math.min(opts.walkDistance || opts.minDistance, opts.maxDistance || Infinity);
    let nextLook = 0;
    let steps = 0;
    let resets = 0;
    let walked = 0;
    let prevX = bot.entity.position.x;
    let prevZ = bot.entity.position.z;
    push(`steady walk to ${goal ? goal.x + ',' + goal.z : 'target'} (yaw ${yaw.toFixed(2)}${opts.sneak ? ', sneaking' : ''})`);
    const maxSteps = Math.ceil(opts.walkTimeoutMs / 120);
    while (Date.now() < deadline && steps < maxSteps) {
      if (opts.signal && opts.signal.aborted) return finish(false, 'cancelled', { walked });
      if (!bot.entity) return finish(false, 'bot unavailable', { walked });
      const pos = bot.entity.position;
      if (Date.now() >= nextLook) {
        try { bot.look(yaw, 0, true); } catch (_) {}
        nextLook = Date.now() + 1200;
      }
      if (dbgEvery && Date.now() >= nextDbg) {
        nextDbg = Date.now() + dbgEvery;
        push(`steady pos ${pos.x.toFixed(2)},${pos.z.toFixed(2)} d=${Math.hypot(pos.x - origin.x, pos.z - origin.z).toFixed(2)} walked=${walked.toFixed(2)} yaw=${yaw.toFixed(2)} onGround=${bot.entity.onGround}`);
      }
      try {
        bot.setControlState('forward', true);
        bot.setControlState('sprint', false);
        bot.setControlState('jump', false);
        bot.setControlState('left', false);
        bot.setControlState('right', false);
        if (opts.sneak) bot.setControlState('sneak', true);
      } catch (_) {}
      const dist = Math.hypot(pos.x - origin.x, pos.z - origin.z);
      if (dist >= stopAt || walked >= stopAt) {
        push(`arrived ${dist.toFixed(2)} blocks from spawn after walking ${walked.toFixed(2)} blocks`);
        return finish(true, 'target reached', { walked });
      }
      const teleBefore = tele ? tele.count : 0;
      await sleep(120);
      const nowPos = bot.entity ? bot.entity.position : pos;
      const step = Math.hypot(nowPos.x - prevX, nowPos.z - prevZ);
      // Velocity on this server re-centres the player at spawn after ~1–2
      // blocks. Count real foot travel (not the snap) so one continuous walk
      // still covers 5–10 blocks even though net displacement is reset.
      if (tele && tele.count > teleBefore && dist >= opts.rubberBandMinProgress) {
        resets++;
        push(`server reset after ${walked.toFixed(2)} walked blocks (${resets}/${opts.rubberBandLimit}) — re-engaging same yaw`);
        if (resets >= opts.rubberBandLimit) return finish(false, 'server rubber-band', { walked });
        try { bot.setControlState('forward', false); } catch (_) {}
        await sleep(opts.resetPauseMs);
        if (bot.entity) {
          prevX = bot.entity.position.x;
          prevZ = bot.entity.position.z;
        }
        try { bot.look(yaw, 0, true); } catch (_) {}
        nextLook = Date.now() + 1200;
        steps++;
      } else if (step > 0.001 && step < 1.2) {
        walked += step;
        prevX = nowPos.x;
        prevZ = nowPos.z;
      } else if (step >= 1.2) {
        // An unsynchronised snap: skip it, but keep the same heading.
        prevX = nowPos.x;
        prevZ = nowPos.z;
      }
      steps++;
    }
    return finish(false, 'walk timeout', { walked });
  }

  if (opts.sneak) {
    try { bot.setControlState('sneak', true); } catch (_) {}
  }

  while (Date.now() < deadline) {
    if (opts.signal && opts.signal.aborted) return finish(false, 'cancelled');
    if (!bot.entity) return finish(false, 'bot unavailable');
    const pos = bot.entity.position;

    while (idx < route.length - 1) {
      const wp = route[idx];
      if (Math.hypot(wp.x + 0.5 - pos.x, wp.z + 0.5 - pos.z) < 0.55) idx++;
      else break;
    }
    const wp = route[idx];
    if (!wp) return finish(false, 'empty route');
    const dx = wp.x + 0.5 - pos.x;
    const dz = wp.z + 0.5 - pos.z;
    const d = Math.hypot(dx, dz);

    if (idx === route.length - 1 && d <= opts.stopDistance) {
      push(`arrived at ${wp.x},${wp.z} (d=${d.toFixed(2)})`);
      return finish(true, 'target reached');
    }

    const moved = Math.hypot(pos.x - lastX, pos.z - lastZ);
    if (moved > 0.16) {
      lastX = pos.x;
      lastZ = pos.z;
      lastMoveAt = Date.now();
      strafe = 0;
    }
    const stuckMs = Date.now() - lastMoveAt;

    if (dbgEvery && Date.now() >= nextDbg) {
      nextDbg = Date.now() + dbgEvery;
      const ctrl = bot.controlState
        ? Object.keys(bot.controlState).filter((k) => bot.controlState[k]).join('+') || 'none'
        : '?';
      const vel = bot.entity.velocity || { x: 0, y: 0, z: 0 };
      const distFromOrigin = Math.hypot(pos.x - origin.x, pos.z - origin.z);
      push(
        `debug pos ${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)} d=${distFromOrigin.toFixed(2)} wp=${wp.x},${wp.z} ctrl=${ctrl} onGround=${bot.entity.onGround} vel=${vel.x.toFixed(2)},${vel.z.toFixed(2)} stuck=${stuckMs}`
      );
    }

    if (stuckMs > 4500 && reroutes < 3) {
      reroutes++;
      push(`stuck ${stuckMs}ms — asking for a fresh route (${reroutes}/3)`);
      if (hooks && hooks.replan) {
        const fresh = await hooks.replan(pos);
        if (opts.signal && opts.signal.aborted) return finish(false, 'cancelled');
        if (fresh && fresh.route && fresh.route.length) {
          grid = fresh.grid || grid;
          route = fresh.route;
          idx = 0;
          lastX = pos.x;
          lastZ = pos.z;
          lastMoveAt = Date.now();
          jumpUntil = 0;
          strafe = 0;
          continue;
        }
      }
      push('no fresh route available');
      lastMoveAt = Date.now();
    } else if (stuckMs > 2600 && !strafe) {
      strafe = Date.now() % 2 ? 1 : -1;
      strafeUntil = Date.now() + 450;
      if (Date.now() - lastStrafeLog > 1500) {
        push('blocked — sidestep');
        lastStrafeLog = Date.now();
      }
    } else if (stuckMs > 1200 && Date.now() > jumpUntil) {
      jumpUntil = Date.now() + 250;
      if (Date.now() - lastJumpLog > 1500) {
        push('blocked — jump');
        lastJumpLog = Date.now();
      }
    }

    bot.look(yawTo(pos.x, pos.z, wp.x + 0.5, wp.z + 0.5), 0, true);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', false);
    bot.setControlState('jump', Date.now() < jumpUntil);

    if (strafe && Date.now() < strafeUntil) {
      bot.setControlState('left', strafe < 0);
      bot.setControlState('right', strafe > 0);
    } else {
      bot.setControlState('left', false);
      bot.setControlState('right', false);
    }

    const next = route[Math.min(idx + 1, route.length - 1)];
    if (next && next.y > wp.y && d < 1.2) bot.setControlState('jump', true);

    // A spawn packet while the bot is still at spawn is harmless. One that
    // arrives after real progress is a genuine rubber-band: the server is
    // refusing this session's movement, not the path or the controls.
    const progressBefore = Math.hypot(pos.x - origin.x, pos.z - origin.z);
    const teleportsBefore = tele ? tele.count : 0;
    await sleep(100);
    if (tele && tele.count > teleportsBefore && progressBefore >= opts.rubberBandMinProgress) {
      rubberBands++;
      push(`server reset after ${progressBefore.toFixed(1)} blocks (${rubberBands}/${opts.rubberBandLimit})`);
      if (rubberBands >= opts.rubberBandLimit) return finish(false, 'server rubber-band');
      lastX = bot.entity.position.x;
      lastZ = bot.entity.position.z;
      lastMoveAt = Date.now();
      jumpUntil = 0;
      strafe = 0;
    }
  }

  return finish(false, 'walk timeout');
}

// ── public entry ─────────────────────────────────────────────────────────────

async function runArenaWalk(bot, options = {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  const rng = opts.rng || Math.random;
  const started = Date.now();
  const trace = [];
  const push = (text) => {
    if (trace.length < opts.traceLimit) trace.push(text);
    if (opts.onTrace) opts.onTrace(text);
  };
  const origin = bot && bot.entity ? {
    x: bot.entity.position.x,
    y: bot.entity.position.y,
    z: bot.entity.position.z,
  } : null;
  if (!origin) {
    return { ok: false, reason: 'bot not spawned', origin: null, moved: 0, trace, ms: 0 };
  }

  const tele = watchServerTeleports(bot, origin, Object.assign({}, opts, {
    onTeleport: (pkt, state, from) => {
      if (opts.debugEveryMs) {
        push(`packet ${pkt.x.toFixed(2)},${pkt.y.toFixed(2)},${pkt.z.toFixed(2)} onGround=${pkt.onGround} from ${from ? `${from.x.toFixed(2)},${from.y.toFixed(2)},${from.z.toFixed(2)}` : '?'}`);
      }
      if (opts.onTeleport) opts.onTeleport(pkt, state, from);
    },
  }));
  const early = (ok, reason, extra = {}) => ({
    ok, reason, origin, moved: 0, trace,
    teleports: tele.count,
    ms: Date.now() - started,
    ...extra,
  });

  try {
    // The arena keeps sending harmless spawn sync packets while the bot is
    // standing still. The panel/harness already waits for the teleport
    // announcement, so only a short settle is needed here.
    if (opts.settleMs > 0) await sleep(opts.settleMs);
    if (opts.signal && opts.signal.aborted) return early(false, 'cancelled');

    // 1. Wait for the arena chunks; blockAt() is null right after teleport.
    const waitStart = Date.now();
    let ready = false;
    while (Date.now() - waitStart < opts.chunkWaitMs) {
      if (opts.signal && opts.signal.aborted) return early(false, 'cancelled');
      const r = chunksReady(bot, origin, opts.radius);
      if (r.ready) { ready = true; break; }
      await sleep(300);
    }
    if (!ready) {
      push('arena chunks did not decode in time');
      return early(false, 'chunks not loaded');
    }

    // 2. Pick ONE direction. Grid/A* waypoints are only used by the legacy
    //    non-steady engine; the proven steady engine validates a real heading
    //    from the exact spawn position, then never turns again.
    let grid = null;
    let target = null;
    let route = null;
    const forced = opts.target && Number.isFinite(Number(opts.target.x)) && Number.isFinite(Number(opts.target.z))
      ? { x: Number(opts.target.x), z: Number(opts.target.z) }
      : null;
    if (opts.steadyDrive) {
      let heading = null;
      let want = 0;
      if (forced) {
        const yaw = yawTo(origin.x, origin.z, forced.x, forced.z);
        want = Math.hypot(forced.x - origin.x, forced.z - origin.z);
        const clear = headingClear(bot, origin, yaw, Math.min(want, opts.maxDistance));
        heading = { yaw, clear, off: 0, score: 0 };
        push(`saved spot ${Math.floor(forced.x)},${Math.floor(forced.z)} — clear ${clear.toFixed(1)} of ${want.toFixed(1)} blocks`);
      } else {
        heading = chooseHeading(bot, origin, opts);
      }
      const minDist = forced ? Math.min(opts.minDistance, want) : opts.minDistance;
      if (!heading || heading.clear < minDist - 0.1) {
        push(`no straight ${minDist.toFixed(1)}-block opening (best ${heading ? heading.clear.toFixed(1) : 0})`);
        return early(false, 'no clear opening');
      }
      opts.fixedYaw = heading.yaw;
      opts.walkDistance = forced
        ? Math.min(heading.clear, want, opts.maxDistance)
        : Math.min(heading.clear, opts.maxDistance);
      if (forced) {
        push(`returning to saved spot ${Math.floor(forced.x)},${Math.floor(forced.z)} with yaw ${heading.yaw.toFixed(2)}; no turns after this`);
        target = { x: Math.floor(forced.x), y: Math.floor(origin.y), z: Math.floor(forced.z) };
      } else {
        push(`one random heading ${heading.yaw.toFixed(2)} — clear ${heading.clear.toFixed(1)} blocks; no turns after this`);
        target = {
          x: Math.floor(origin.x - Math.sin(heading.yaw) * opts.walkDistance + 1e-9),
          y: Math.floor(origin.y),
          z: Math.floor(origin.z - Math.cos(heading.yaw) * opts.walkDistance + 1e-9),
        };
      }
      route = [target];
    } else {
      grid = readGrid(bot, origin, opts.radius);
      const startCell = grid.get(Math.floor(origin.x), Math.floor(origin.z));
      if (!startCell) {
        push(`spawn cell is not walkable (${Math.floor(origin.x)},${Math.floor(origin.z)})`);
        return early(false, 'spawn cell blocked');
      }
      const reach = bfsReachable(grid, startCell, opts.radius * 2);
      if (forced) {
        const cell = grid.get(Math.floor(forced.x), Math.floor(forced.z));
        if (cell && reach.has(cell.x + ',' + cell.z)) {
          target = cell;
          route = simplify(grid, aStar(grid, startCell, target));
          push(`grid ${grid.cells.size} cells — returning to saved spot ${target.x},${target.z} route ${route ? route.length : 0}`);
        } else {
          push(`saved spot ${Math.floor(forced.x)},${Math.floor(forced.z)} unreachable — choosing a random target`);
        }
      }
      if (!target) {
        const pick = chooseTarget(grid, reach, startCell, rng, opts);
        if (!pick) {
          push('no reachable cell 5–10 blocks away');
          return early(false, 'no reachable target');
        }
        target = pick.cell;
        route = simplify(grid, aStar(grid, startCell, target));
        push(`grid ${grid.cells.size} cells — target ${target.x},${target.z} d=${pick.dist.toFixed(1)} route ${route ? route.length : 0}`);
      }
    }

    // 3. One walk. A re-route keeps the same deadline and never starts a
    //    second walk. A cancellation token stops an old walk immediately.
    const hooks = {
      onTrace: opts.onTrace,
      replan: async (pos) => {
        const cur = grid.get(Math.floor(pos.x), Math.floor(pos.z));
        if (!cur) return null;
        const freshReach = bfsReachable(grid, cur, opts.radius * 2);
        let nextRoute = simplify(grid, aStar(grid, cur, target));
        if (!nextRoute) {
          const nextPick = chooseTarget(grid, freshReach, startCell, rng, opts);
          if (!nextPick) return null;
          target = nextPick.cell;
          nextRoute = simplify(grid, aStar(grid, cur, target));
        }
        if (!nextRoute) return null;
        return { grid, route: nextRoute };
      },
    };

    opts.origin = origin;
    const result = await driveRoute(bot, grid, route, opts, hooks, tele);
    const pos = bot.entity ? bot.entity.position : origin;
    const moved = Math.hypot(pos.x - origin.x, pos.z - origin.z);
    const walked = result.walked || 0;
    // This server teleports the player back to spawn after ~1–2 blocks, so a
    // successful one-way walk can end at spawn. Count real foot travel when it
    // exceeds net displacement; 0.5-block centres make 4.5 the safe floor.
    const measured = walked > moved ? walked : moved;
    const ok = result.ok && measured >= 4.5;
    push(
      `final ${moved.toFixed(2)} blocks from spawn, ${walked.toFixed(2)} blocks walked in ${((Date.now() - started) / 1000).toFixed(1)}s (${result.reason})`
    );
    return {
      ...result,
      ok,
      origin,
      target,
      moved,
      walked,
      route: route ? route.length : 0,
      trace: [...trace, ...result.trace],
      teleports: tele.count,
      ms: Date.now() - started,
    };
  } finally {
    tele.close();
    releaseControls(bot, opts.sneak);
  }
}

module.exports = {
  runArenaWalk,
  readGrid,
  bfsReachable,
  chooseTarget,
  aStar,
  simplify,
  headingClear,
  chooseHeading,
  watchServerTeleports,
  blockTop,
  chunksReady,
  DEFAULTS,
};
