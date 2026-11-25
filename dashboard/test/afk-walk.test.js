'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { walkTargets, configureMovements, firstWalkableTarget, clearWalkTarget } = require('../afk-walk');

test('walk targets cover 16 headings at 5–10 blocks from the arena origin', () => {
  const targets = walkTargets({ x: 0.3, y: 73.1, z: -0.2 }, 5, 10, 16, 0.25);
  assert.equal(targets.length, 16);
  for (const t of targets) {
    assert.equal(Number.isInteger(t.x), true);
    assert.equal(Number.isInteger(t.z), true);
    const d = Math.hypot(t.x - Math.floor(0.3), t.z - Math.floor(-0.2));
    assert.ok(d >= 5 && d <= 10, `distance ${d} outside 5–10`);
    // Mineflayer's forward vector is (-sin(yaw), -cos(yaw)); the yaw must
    // point from the origin to the chosen target.
    const fx = -Math.sin(t.yaw);
    const fz = -Math.cos(t.yaw);
    assert.ok(fx * t.dx + fz * t.dz > 0, 'yaw does not face the target');
  }
  const angles = targets.map((t) => Math.atan2(t.dz, t.dx));
  const unique = new Set(angles.map((a) => a.toFixed(3)));
  assert.ok(unique.size >= 12, 'targets should be spread around the arena');
});

test('movement configuration forbids digging and placing', () => {
  const movements = {
    canDig: true,
    allow1by1towers: true,
    allowParkour: true,
    countScaffoldingItems() { return 64; },
  };
  configureMovements(movements);
  assert.equal(movements.canDig, false);
  assert.equal(movements.allow1by1towers, false);
  assert.equal(movements.allowParkour, false);
  assert.equal(movements.countScaffoldingItems(), 0);
});

test('clearWalkTarget rejects a wall and accepts an open corridor', () => {
  const origin = { x: 0.5, y: 73, z: 0.5 };
  const walled = { x: 8, y: 73, z: 0, dx: 8, dz: 0, distance: 8 };
  const open = { x: 0, y: 73, z: -7, dx: 0, dz: -7, distance: 7 };
  const blockAt = (x, y, z) => {
    if (y === 72) return { boundingBox: 'block' }; // floor
    if (x === 2 && y === 73 && z === 0) return { boundingBox: 'block' }; // wall
    return { boundingBox: 'empty' };
  };
  assert.equal(clearWalkTarget(origin, walled, blockAt), false);
  assert.equal(clearWalkTarget(origin, open, blockAt), true);
});

test('clearWalkTarget accepts a slab walking surface without a block below', () => {
  const origin = { x: 0.5, y: 73, z: 0.5 };
  const target = { x: 0, y: 73, z: -7, dx: 0, dz: -7, distance: 7 };
  const slab = { boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1]] };
  const air = { boundingBox: 'empty', shapes: [] };
  const blockAt = (x, y, z) => (y === 73 ? slab : air);
  assert.equal(clearWalkTarget(origin, target, blockAt), true);
});

test('first walkable target skips blocked directions', () => {
  const targets = [
    { x: 1, y: 73, z: 0, distance: 6 },
    { x: 2, y: 73, z: 0, distance: 7 },
  ];
  const makeGoal = (t) => ({ x: t.x });
  const pathFor = (goal) => goal.x === 1
    ? { status: 'noPath', path: [] }
    : { status: 'success', path: [{ x: 1 }, { x: 2 }] };

  const chosen = firstWalkableTarget(targets, makeGoal, pathFor);
  assert.equal(chosen.target, targets[1]);
  assert.deepEqual(chosen.goal, { x: 2 });
  assert.equal(chosen.path.length, 2);
});
