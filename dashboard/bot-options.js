'use strict';

/*
 * Lightweight mineflayer options for AFK bots.
 *
 * Every internal plugin adds event listeners and packet work to every bot.
 * Fleet bots only need chat, login/game state, inventory, vitals, scoreboard,
 * tab list and movement — the rest is switched off. Keeping the view distance
 * at 2 also cuts the number of decoded/stored chunks per bot.
 */

const DISABLED = [
  'anvil', 'bed', 'block_actions', 'book', 'boss_bar', 'breath', 'chest', 'craft',
  'creative', 'digging', 'enchantment_table', 'explosion', 'fishing', 'furnace',
  'generic_place', 'particle', 'place_block', 'place_entity', 'rain', 'ray_trace',
  'resource_pack', 'sound', 'spawn_point', 'time', 'title', 'villager', 'team', 'tablist',
];

const plugins = {};
for (const name of DISABLED) plugins[name] = false;

module.exports = { viewDistance: 2, plugins, disabled: DISABLED };
