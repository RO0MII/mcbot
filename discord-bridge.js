// Discord <-> Minecraft bot bridge
// Forwards MC public chat to Discord, relays Discord commands/messages back to MC.
require('dotenv').config({ override: true }); // override: re-read .env even if var already set in parent env

const { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } = require('discord.js');
const fs   = require('fs');
const path = require('path');

// ---- Config ----
const DISCORD_TOKEN  = process.env.DISCORD_TOKEN || ''; // set DISCORD_TOKEN in .env
const GUILD_ID       = '1500357389596098622';
const CHANNEL_NAME   = 'mokddykoe-bot';   // will be created if it doesn't exist
const IPC_FILE       = path.join(__dirname, '.discord-ipc.json'); // shared state with index.js
const POLL_INTERVAL  = 800;  // ms — how often we poll IPC for new MC messages

// ---- Discord client ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let channel = null;   // the Discord channel we post to
let lastMsgId = null; // tracks last read IPC message so we don't re-post

// ---- IPC helpers ----
// index.js writes incoming MC chat lines to IPC_FILE as a queue.
// We read it, forward to Discord, and clear the queue.
function readIPC() {
  try { return JSON.parse(fs.readFileSync(IPC_FILE, 'utf8')); }
  catch (_) { return { mcMessages: [], botStatus: null, commands: [] }; }
}
function writeIPC(data) {
  try { fs.writeFileSync(IPC_FILE, JSON.stringify(data)); } catch (_) {}
}
function clearMcMessages() {
  const d = readIPC(); d.mcMessages = []; writeIPC(d);
}
function popDiscordReplies() {
  const d = readIPC();
  const replies = d.discordReplies || [];
  if (replies.length) { d.discordReplies = []; writeIPC(d); }
  return replies;
}
function pushDiscordCommand(cmd) {
  const d = readIPC();
  if (!d.commands) d.commands = [];
  d.commands.push(cmd);
  writeIPC(d);
}

// ---- Ensure the channel exists ----
async function ensureChannel(guild) {
  // Try to find by name
  let ch = guild.channels.cache.find(
    c => c.name === CHANNEL_NAME && c.type === ChannelType.GuildText
  );
  if (ch) return ch;

  // Create it under the first available category, or at the top level
  ch = await guild.channels.create({
    name: CHANNEL_NAME,
    type: ChannelType.GuildText,
    topic: '🟢 Minecraft bot bridge — MC chat appears here; type commands or chat to send back.',
    reason: 'Minecraft bot bridge channel',
  });
  return ch;
}

// ---- Format a MC line for Discord ----
// Returns a formatted string, or null to skip the line entirely.
function formatMC(line) {
  const s = line.replace(/§[0-9a-fk-or]/gi, '').trim();
  if (!s) return null;

  // Skip noisy server broadcast banners (vote ads, entity cleaner, play-with-friends, etc.)
  if (/^(↓|↑|VOTE TODAY|Voting for us|vote\.|PLAY WITH FRIENDS|JOIN US|ARE YOU STUCK|GET HELP|\/help)/.test(s)) return null;
  if (/Entities will be cleared|ENTITY CLEANER|CLEANER ▶/i.test(s)) return null;
  if (/^(TP REQUEST|TRADE REQUEST|TELEPORT REQUEST)/i.test(s)) return null;

  // ── CHATGAMES ──
  if (s === 'CHATGAMES') return '# 🎮  CHATGAMES';

  // Game instruction ("The first to fill/unscramble/answer/type... wins!")
  if (/first (?:to|person)/i.test(s)) return `### 📋  ${s}`;

  // Puzzle payload line starting with ▶
  if (/^▶\s+/.test(s)) return `> \`${s.replace(/^▶\s+/, '').trim()}\``;

  // Game answer hints / parenthetical clues
  if (/^\(.*\)$/.test(s)) return `> *${s}*`;

  // Game results
  if (/the (?:word|answer) was\b/i.test(s)) return `## ✅  ${s}`;
  if (/nobody (?:filled|answered|unscrambled|unjumbled|unreversed|got it)/i.test(s)) return `## ❌  ${s}`;
  if (/\b(?:answered correctly|unscrambled|unjumbled|unreversed)\b/i.test(s)) return `## 🏆  ${s}`;
  if (/\bcoins?\b.*(?:won|reward|receive)/i.test(s)) return `🪙  ${s}`;

  // Welcome / join announcements
  if (/Welcome.*to ONEBLOCK/i.test(s)) return `👋  ${s}`;

  // Player chat:  "  [RANK] username ▶ message"
  const pm = s.match(/^(?:\[[^\]]+\]\s*)*([A-Za-z0-9_]{2,16})\s*▶\s*(.+)$/);
  if (pm) return `**${pm[1]}** ▶ ${pm[2]}`;

  // Everything else — plain text
  return s;
}

// Returns true if the line is a game-related event that should be flushed immediately.
function isGameLine(raw) {
  const s = raw.replace(/§[0-9a-fk-or]/gi, '').trim();
  return s === 'CHATGAMES'
    || /first (?:to|person)/i.test(s)
    || /^▶\s+/.test(s)
    || /the (?:word|answer) was\b/i.test(s)
    || /nobody (?:filled|answered|unscrambled)/i.test(s)
    || /\b(?:answered correctly|unscrambled|unjumbled|unreversed)\b/i.test(s);
}

// ---- Poll IPC and forward MC messages to Discord ----
let pendingLines = []; // lines waiting to be batched into one message

async function flushToDiscord() {
  if (!channel || !pendingLines.length) return;
  const text = pendingLines.join('\n').slice(0, 1900);
  pendingLines = [];
  await channel.send({ content: text }).catch(() => {});
}

function startPolling() {
  setInterval(async () => {
    if (!channel) return;
    const d = readIPC();
    const msgs = d.mcMessages || [];
    if (!msgs.length) return;
    clearMcMessages();

    for (const raw of msgs) {
      const formatted = formatMC(raw);
      if (!formatted) continue; // skip noisy line

      if (isGameLine(raw)) {
        // Flush any buffered chat first, then send game line alone so it stands out.
        await flushToDiscord();
        await channel.send({ content: formatted }).catch(() => {});
      } else {
        pendingLines.push(formatted);
        // Flush if batch is getting large.
        if (pendingLines.join('\n').length > 1400) await flushToDiscord();
      }
    }
  }, POLL_INTERVAL);

  // Flush remaining buffered lines every 2s so chat isn't held too long.
  setInterval(flushToDiscord, 2000);

  // Send bot command replies back to Discord (from !help, !games, etc.)
  setInterval(async () => {
    if (!channel) return;
    for (const reply of popDiscordReplies()) {
      await channel.send({ content: reply.slice(0, 1900) }).catch(() => {});
    }
  }, 500);
}

// ---- Ready ----
client.once('ready', async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) { console.error('[Discord] Guild not found — check GUILD_ID'); return; }
  channel = await ensureChannel(guild);
  console.log(`[Discord] Using channel #${channel.name} (${channel.id})`);
  await channel.send('🟢 **Minecraft bot is online** — chat will appear here.');
  startPolling();
  // Write channel id to IPC so index.js knows where to post status updates
  const d = readIPC(); d.discordChannelId = channel.id; d.botStatus = 'online'; writeIPC(d);
});

// ---- Incoming Discord messages ----
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  if (!channel || msg.channelId !== channel.id) return;

  const text = msg.content.trim();
  if (!text) return;

  if (text.startsWith('!')) {
    // Bot command — relay to MC bot via IPC
    pushDiscordCommand(text);
    await msg.react('⚙️').catch(() => {});
  } else {
    // Regular chat — relay to MC server chat via IPC
    pushDiscordCommand(`__chat__:${msg.author.username}: ${text}`);
    await msg.react('📨').catch(() => {});
  }
});

// ---- Send offline notice on exit ----
async function shutdown() {
  if (channel) {
    await channel.send('🔴 **Minecraft bot is offline.**').catch(() => {});
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(DISCORD_TOKEN).catch((err) => {
  console.error(`  ✘ Discord login failed: ${err.message || err}`);
  process.exit(1);
});
