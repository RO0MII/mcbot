'use strict';

/*
 * Sidebar scoreboard compatibility for Minecraft 1.21.5+ (protocol >= 770).
 *
 * mineflayer 4.37 still expects `scoreboard_score` to carry an `action` field
 * and only stores scores when action === 0. Mojang removed that field: a plain
 * scoreboard_score packet now means "set", and removals arrive as reset_score.
 * Without this plugin every score is silently dropped and the panel shows an
 * empty sidebar. Team prefixes are kept enabled in bot-options.js because
 * that's where servers put the actual visible sidebar text.
 */

module.exports = function scoreboardCompat(bot) {
  // `team` stays enabled: modern servers put the visible sidebar text in team
  // prefixes (the score entries themselves are often just formatting codes).

  bot._client.on('scoreboard_score', (packet) => {
    // Older protocols still carry `action`; the built-in plugin owns those.
    if (!packet || packet.action !== undefined) return;
    const board = bot.scoreboards && bot.scoreboards[packet.scoreName];
    if (!board || packet.itemName == null) return;
    const updated = board.add(packet.itemName, packet.value);
    bot.emit('scoreUpdated', board, updated);
  });

  bot._client.on('reset_score', (packet) => {
    if (!packet) return;
    const board = bot.scoreboards && bot.scoreboards[packet.objective_name];
    if (!board || !packet.entity_name) return;
    const removed = board.remove(packet.entity_name);
    if (removed) bot.emit('scoreRemoved', board, removed);
  });
};
