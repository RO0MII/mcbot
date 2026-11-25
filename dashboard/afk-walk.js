'use strict';

const DEFAULT_MIN = 5;
const DEFAULT_MAX = 10;
const DEFAULT_COUNT = 16;

/**
 * Pick one walkable-looking target in each direction around the arena origin.
 * Targets are integer block coordinates 5–10 blocks from the entry point, so
 * pathfinder can choose a real route instead of the bot ramming one wall.
 */
function walkTargets(origin, min = DEFAULT_MIN, max = DEFAULT_MAX, count = DEFAULT_COUNT, phase = 0, targetDistance) {
  const ox = Math.floor(Number(origin && origin.x) || 0);
  const oy = Math.floor(Number(origin && origin.y) || 0);
  const oz = Math.floor(Number(origin && origin.z) || 0);
  const wanted = Math.min(max, Math.max(min, Number(targetDistance) || (min + max) / 2));
  const targets = [];

  for (let i = 0; i < count; i++) {
    const angle = phase + (i * Math.PI * 2) / count;
    // Vary the radius slightly so nearby headings do not round to the same
    // integer block — sixteen headings should offer sixteen real options.
    const radius = Math.min(max, Math.max(min, wanted + ((i % 5) - 2) * 0.6));
    const fx = Math.cos(angle) * radius;
    const fz = Math.sin(angle) * radius;
    let best = null;
    for (let dx = Math.floor(fx) - 1; dx <= Math.ceil(fx) + 1; dx++) {
      for (let dz = Math.floor(fz) - 1; dz <= Math.ceil(fz) + 1; dz++) {
        const distance = Math.hypot(dx, dz);
        if (distance < min || distance > max) continue;
        const actual = Math.atan2(dz, dx);
        const delta = Math.abs(Math.atan2(Math.sin(actual - angle), Math.cos(actual - angle)));
        const score = Math.abs(distance - radius) + delta * 0.1;
        if (!best || score < best.score) best = { dx, dz, distance, score };
      }
    }
    if (!best) continue;
    targets.push({
      x: ox + best.dx,
      y: oy,
      z: oz + best.dz,
      dx: best.dx,
      dz: best.dz,
      distance: best.distance,
      // Mineflayer's forward vector is (-sin(yaw), -cos(yaw)).
      yaw: Math.atan2(-best.dx, -best.dz),
    });
  }
  return targets;
}

function blockTop(block) {
  if (!block || block.boundingBox === 'empty') return 0;
  if (!Array.isArray(block.shapes)) return 1;
  let top = 0;
  for (const shape of block.shapes) {
    if (Array.isArray(shape) && Number(shape[4]) > top) top = Number(shape[4]);
  }
  return top;
}

/** Check the straight corridor from the arena origin to a target. A clear
 *  corridor means plain forward walking can finish the one random walk without
 *  pathfinder, digging or block placement. The arena floor mixes sea lanterns
 *  with smooth-stone slabs, so a slab at foot level counts as the floor. */
function clearWalkTarget(origin, target, blockAt) {
  if (!origin || !target || typeof blockAt !== 'function') return false;
  const ox = Number(origin.x) || 0;
  const oy = Math.floor(Number(origin.y) || 0);
  const oz = Number(origin.z) || 0;
  const dx = Number(target.dx) || 0;
  const dz = Number(target.dz) || 0;
  const distance = Math.hypot(dx, dz);
  if (distance < 1) return false;
  const steps = Math.max(2, Math.ceil(distance * 2));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.floor(ox + dx * t);
    const z = Math.floor(oz + dz * t);
    const feet = blockAt(x, oy, z);
    const head = blockAt(x, oy + 1, z);
    const below = blockAt(x, oy - 1, z);
    if (!feet || !head || !below) return false;
    const feetTop = blockTop(feet);
    if (feetTop > 0.6 || blockTop(head) > 0.6) return false;
    // Slab/carpet at foot level is itself the floor; otherwise a solid block
    // directly below is required so the bot never walks into a gap.
    if (feetTop <= 0 && blockTop(below) <= 0) return false;
  }
  return true;
}

/** Choose the first target pathfinder can actually reach without breaking or
 *  placing blocks. Blocked headings are skipped before any movement starts. */
function firstWalkableTarget(targets, makeGoal, pathFor) {
  for (const target of targets) {
    const goal = makeGoal(target);
    const result = pathFor(goal, target);
    if (result && result.status === 'success' && result.path && result.path.length) {
      return { target, goal, path: result.path };
    }
  }
  return null;
}

/** Keep the arena walk to ordinary movement: no digging, no bridging. */
function configureMovements(movements) {
  if (!movements) return movements;
  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  movements.placeCost = Number.POSITIVE_INFINITY;
  movements.countScaffoldingItems = () => 0;
  return movements;
}

module.exports = { walkTargets, configureMovements, firstWalkableTarget, clearWalkTarget };
