'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { headingClear, chooseHeading, watchServerTeleports } = require('../arena-walker');

const AIR = { name: 'air', boundingBox: 'empty', shapes: [] };
const SOLID = { name: 'stone', boundingBox: 'full', shapes: [[0, 0, 0, 1, 1, 1]] };
const SLAB = { name: 'smooth_stone_slab', boundingBox: 'full', shapes: [[0, 0, 0, 1, 0.5, 1]] };

function fakeBot(blockAt) {
  return {
    entity: { position: { x: 0, y: 73, z: 0 } },
    blockAt,
  };
}

function corridor(extra) {
  return (v) => {
    if (extra && Object.prototype.hasOwnProperty.call(extra, `${v.x},${v.y},${v.z}`)) {
      return extra[`${v.x},${v.y},${v.z}`];
    }
    if (v.y === 72) return SOLID;
    if (v.y === 73 || v.y === 74) return AIR;
    return AIR;
  };
}

test('headingClear stops before a full block at feet height', () => {
  const blocks = corridor({ '3,73,0': SOLID });
  const clear = headingClear(fakeBot(blocks), { x: 0, y: 73, z: 0 }, -Math.PI / 2, 7);
  assert.ok(clear < 3, `expected to stop before x=3, got ${clear}`);
  assert.ok(clear >= 2, `expected real progress first, got ${clear}`);
});

test('headingClear accepts a slab step and a solid floor', () => {
  const blocks = corridor({
    '1,73,0': SLAB, '2,73,0': SLAB, '3,73,0': SLAB,
    '4,73,0': SLAB, '5,73,0': SLAB, '6,73,0': SLAB,
  });
  const clear = headingClear(fakeBot(blocks), { x: 0, y: 73, z: 0 }, -Math.PI / 2, 7);
  assert.ok(clear >= 5, `expected a clear slab corridor, got ${clear}`);
});

test('headingClear accepts a slab at feet height as the floor', () => {
  const blocks = (v) => {
    if (v.y === 73) return SLAB;
    if (v.y === 74) return AIR;
    return AIR; // no solid block under the slab — the slab itself is the floor
  };
  const clear = headingClear(fakeBot(blocks), { x: 0, y: 73, z: 0 }, -Math.PI / 2, 7);
  assert.ok(clear >= 5, `expected the slab floor to count as clear, got ${clear}`);
});

test('a routine spawn-sync packet is not a rubber-band; a backward snap is', () => {
  const handlers = [];
  const client = {
    on: (_event, fn) => handlers.push(fn),
    prependListener: (_event, fn) => handlers.unshift(fn),
    removeListener: (_event, fn) => {
      const i = handlers.indexOf(fn);
      if (i >= 0) handlers.splice(i, 1);
    },
  };
  const bot = { entity: { position: { x: 0.42, y: 73, z: 0.42 } }, _client: client };
  const tele = watchServerTeleports(bot, { x: 0, y: 73, z: 0 }, {
    rubberBandWindowMs: 3000, rubberBandMinProgress: 0.5,
  });
  handlers.slice().forEach((h) => h({ x: 0.42, y: 73, z: 0.42 }));
  assert.equal(tele.count, 0, 'a packet at the current position is just a sync');
  bot.entity.position = { x: 1.4, y: 73, z: 1.4 };
  handlers.slice().forEach((h) => h({ x: 0, y: 73, z: 0 }));
  assert.equal(tele.count, 1, 'a packet that snaps the bot back is a reset');
  tele.close();
});

test('chooseHeading picks the random heading when that opening is clear', () => {
  // Only +X is open. A fixed rng of 0.75 makes the first random yaw point +X.
  const blocks = (v) => {
    if (v.y === 72) return SOLID;
    if (v.x >= 0 && v.z === 0 && (v.y === 73 || v.y === 74)) return AIR;
    return SOLID;
  };
  const picked = chooseHeading(fakeBot(blocks), { x: 0, y: 73, z: 0 }, {
    minDistance: 5, maxDistance: 10, preferMin: 6, rng: () => 0.75,
  });
  assert.ok(picked, 'expected a heading');
  assert.ok(picked.clear >= 5, `expected a 5+ block opening, got ${picked.clear}`);
  const dirX = -Math.sin(picked.yaw);
  const dirZ = -Math.cos(picked.yaw);
  assert.ok(dirX > 0.98 && Math.abs(dirZ) < 0.1, `expected +X, got yaw ${picked.yaw}`);
});
