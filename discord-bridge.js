// Discord <-> Minecraft bot bridge
// Forwards MC public chat to Discord, relays Discord commands/messages back to MC.

const { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } = require('discord.js');
const fs   = require('fs');
const path = require('path');

// ---- Config ----
const DISCORD_TOKEN  = process.env.DISCORD_TOKEN || ''; // set DISCORD_TOKEN env var
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
function formatMC(line) {
  // Strip Minecraft §-color codes
  return line.replace(/§[0-9a-fk-or]/gi, '').trim();
}

// ---- Poll IPC and forward MC messages to Discord ----
function startPolling() {
  setInterval(() => {
    if (!channel) return;
    const d = readIPC();
    const msgs = d.mcMessages || [];
    if (!msgs.length) return;
    // Batch into one Discord message (max 1900 chars)
    const lines = msgs.map(formatMC).filter(Boolean);
    if (!lines.length) { clearMcMessages(); return; }
    const text = lines.join('\n').slice(0, 1900);
    channel.send({ content: text }).catch(() => {});
    clearMcMessages();
  }, POLL_INTERVAL);
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

client.login(DISCORD_TOKEN);
