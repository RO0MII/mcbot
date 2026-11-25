'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  runArenaWalk, readGrid, bfsReachable, chooseTarget, aStar, simplify, blockTop,
} = require('../arena-walker');

// ── a tiny synthetic arena ───────────────────────────────────────────────────
// Floor y=64 (full blocks), feet/head air at y=65/66. A wall of full blocks at
// x=5, z=-3..3 forces the route around it. A slab patch at z=4 is walkable.
function fakeArena(origin = { x: 0, y: 65, z: 0 }) {
  const floor = { name: 'smooth_stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
  const slab = { name: 'smooth_stone_slab', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1]] };
  const wall = { name: 'polished_andesite', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
  const air = { name: 'air', boundingBox: 'empty', shapes: [] };
  const sign = { name: 'oak_sign', boundingBox: 'empty', shapes: [] };

  const bot = {
    blockAt(v) {
      const x = v.x, y = v.y, z = v.z;
      if (y === 64) {
        if (z === 4 && x >= -4 && x <= 4) return slab;
        return floor;
      }
      if (y === 65 || y === 66) {
        if (x === 5 && z >= -3 && z <= 3) return wall;
        if (y === 65 && x === 0 && z === 0) return sign;
        return air;
      }
      if (y > 66) return air;
      return air;
    },
    entity: { position: { x: origin.x + 0.5, y: origin.y, z: origin.z + 0.5 } },
  };
  return bot;
}

test('blockTop reads full blocks, slabs and empty shapes', () => {
  assert.equal(blockTop({ boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }), 1);
  assert.equal(blockTop({ boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1]] }), 0.5);
  assert.equal(blockTop({ boundingBox: 'empty', shapes: [] }), 0);
  assert.equal(blockTop(null), 0);
});

test('readGrid marks the spawn walkable and the wall blocked', () => {
  const bot = fakeArena();
  const grid = readGrid(bot, bot.entity.position, 8);
  assert.ok(grid.get(0, 0), 'spawn cell should be walkable');
  assert.ok(!grid.get(5, 0), 'wall cell should not be walkable');
  assert.ok(grid.get(0, 4), 'slab patch should be walkable');
});

test('BFS only reaches cells around the wall, never through it', () => {
  const bot = fakeArena();
  const grid = readGrid(bot, bot.entity.position, 10);
  const start = grid.get(0, 0);
  const reach = bfsReachable(grid, start, 20);
  assert.ok(reach.has('4,0'), 'near side of the wall is reachable');
  assert.ok(!reach.has('5,0'), 'wall itself is not reachable');
  assert.ok(reach.has('6,0'), 'the far side is reachable around the wall');
  assert.ok(reach.get('6,0') > 6, 'the detour must be longer than the straight line');
});

test('A* routes around the wall instead of into it', () => {
  const bot = fakeArena();
  const grid = readGrid(bot, bot.entity.position, 12);
  const start = grid.get(0, 0);
  const goal = grid.get(6, 0);
  const path = aStar(grid, start, goal);
  assert.ok(path && path.length > 6, 'path should detour around the wall');
  assert.ok(path.every((c) => grid.get(c.x, c.z)), 'every step is walkable');
  assert.ok(!path.some((c) => c.x === 5 && Math.abs(c.z) <= 3), 'path never enters the wall');
});

test('chooseTarget returns a reachable cell inside the 5–10 band', () => {
  const bot = fakeArena();
  const grid = readGrid(bot, bot.entity.position, 12);
  const start = grid.get(0, 0);
  const reach = bfsReachable(grid, start, 24);
  for (let i = 0; i < 30; i++) {
    const pick = chooseTarget(grid, reach, start, Math.random, {
      minDistance: 5, maxDistance: 10, preferMin: 6,
    });
    assert.ok(pick, 'a target must exist');
    assert.ok(pick.dist >= 4.95 && pick.dist <= 10.05, `distance ${pick.dist}`);
    assert.ok(reach.has(pick.cell.x + ',' + pick.cell.z), 'target must be reachable');
  }
});

test('simplify keeps the route walkable and ends at the goal', () => {
  const bot = fakeArena();
  const grid = readGrid(bot, bot.entity.position, 12);
  const start = grid.get(0, 0);
  const goal = grid.get(6, 0);
  const path = aStar(grid, start, goal);
  const simple = simplify(grid, path);
  assert.ok(simple.length >= 2 && simple.length <= path.length);
  assert.equal(simple[simple.length - 1].x, goal.x);
  assert.equal(simple[simple.length - 1].z, goal.z);
});

test('a cancelled walk stops early and releases the controls', async () => {
  const bot = fakeArena();
  const released = [];
  bot.look = () => {};
  bot.setControlState = (name, state) => {
    if (!state) released.push(name);
  };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const result = await runArenaWalk(bot, {
    settleMs: 0,
    walkTimeoutMs: 2000,
    signal: controller.signal,
  });
  assert.equal(result.reason, 'cancelled');
  assert.ok(result.ms < 800, `cancelled walk took ${result.ms}ms`);
  assert.ok(released.includes('forward'), 'forward must be released');
});
