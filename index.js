process.env.TZ = 'Asia/Colombo'; // run all timestamps/logs in Sri Lanka time (must be set before any Date use)

require('dotenv').config(); // load .env before anything else

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

// ---- Settings ----
const DEFAULT_IP = 'play.bananasmp.net';   // Used when you just press Enter on the IP prompt
const DEFAULT_PORT = 25565;       // Default Minecraft port
const VERSION = '1.20.1';         // Fixed version = skip the auto-detect ping round-trip, so the FIRST join is fast. Set false to auto-detect.
const AUTO_RECONNECT = true;      // Keep retrying while the server boots (Aternos)
const RECONNECT_DELAY = 5000;     // ms between retries
const DAILY_SHUTDOWN_HOUR = 4;    // hour (0-23, Asia/Colombo) to disconnect and EXIT without reconnecting; set to null to disable

// ---- Auto-vault: every VAULT_INTERVAL, deposit keep-items into /pv 1 and trash the rest ----
const AUTO_VAULT = true;                       // run the deposit+trash cycle on a timer
const VAULT_INTERVAL = 10 * 60 * 1000;         // every 10 minutes
const VAULT_PV_COMMAND = '/pv 1';              // command that opens the player-vault GUI to deposit into
const VAULT_TRASH_COMMAND = '/trash';          // command that opens the trash GUI (deposited items are destroyed)
const VAULT_KEEP = ['party key', 'candle']; // these go to the vault; EVERYTHING ELSE in the inventory is trashed

// ---- Auto-trade: when the owner whispers a trigger word, give them the keys+candles ----
const TRADE_ENABLED = true;                     // master switch for the whisper-triggered trade
const TRADE_OWNER = 'RO0MII';                    // ONLY this player can trigger it; also the trade target
const TRADE_TRIGGER = 'inv';                     // the whispered word that starts the flow
const TRADE_PV_COMMAND = '/pv 1';                // vault to withdraw the items from first
const TRADE_GIVE = ['party key', 'pink candle']; // withdraw these and put them into the trade
const TRADE_CONFIRM_WOOL = ['lime wool', 'green wool']; // click one of these to confirm the trade
const TRADE_AVOID_WOOL = ['red wool'];           // never click these (decline/cancel button)
const TRADE_ACCEPT_TIMEOUT = 60000;              // ms to wait for the owner to accept (trade window to open)
const JOIN_TIMEOUT = 30000;       // ms to wait for a join before giving up and retrying (fixes hangs)
const AFK_INTERVAL = 8000;        // ms between anti-AFK actions when !afk is on
const TOOL_BREAK_BUFFER = 5;      // !oneblock won't use a tool with this many uses (or fewer) left — keeps it from breaking
const MINE_REACH = 4.5;           // blocks: how close the bot must be to dig the target
const GAME_DELAY_MIN = 3000;      // !games — min delay before auto-answering a chat game (ms)
const GAME_DELAY_MAX = 4000;      // !games — max delay before auto-answering a chat game (ms)
const FILL_MISSING_LETTERS_ONLY = false; // fill games: send ONLY the missing letters instead of the full word. Default false = always send the FULL answer (e.g. "Wooden Axe", not "Oodx").
const AUTO_MISSING_LETTERS = false;      // if true, auto-switch to missing-letters mode when server prints the note. Keep false — this server wants the FULL word.
const WORDLIST_PATH = '/usr/share/dict/american-english-huge'; // dictionary used to solve "unscramble" games
const CUSTOM_WORDS_PATH = './custom-words.txt'; // extra words (one per line); checked first
const CUSTOM_TRIVIA_PATH = './custom-trivia.txt'; // extra "question keywords = answer" lines; checked first
const MINECRAFT_ITEMS_PATH = './minecraft-items.txt'; // Minecraft block/item names (one per line); solves multi-word unscrambles & breaks anagram ties

// ---- Auto login + server switch ----
const AUTO_LOGIN = true;                  // detect a login prompt in chat and log in automatically
const LOGIN_PASSWORD = 'romi321';         // password sent as "/login <password>"
const LOGIN_COMMAND = `/login ${LOGIN_PASSWORD}`;
const SWITCH_COMMAND = '/server oneblock';// command that moves us to the target sub-server
const SWITCH_AFTER_LOGIN = 4000;          // ms after logging in before switching servers
const SWITCH_FALLBACK = 8000;             // ms after joining to switch anyway (login prompt or not)
// Chat lines that mean "you must authenticate" — triggers LOGIN_COMMAND.
const LOGIN_PROMPT = /\b(login|loggin|log in|register|registro|authme|password)\b/i;

// ---- Auto re-join oneblock after a restart ----
// When the sub-server restarts we get bounced to the lobby. Re-send the switch
// command periodically (random 5-10 min, human-like) so we always end back on
// it, and react faster when a restart / "sent to lobby" message shows up.
const RESWITCH_MIN = 5 * 60 * 1000;   // re-send /server oneblock at least this often
const RESWITCH_MAX = 10 * 60 * 1000;  // ...and at most this often
const LOBBY_RESWITCH_DELAY = 5000;    // ms to wait after a restart message before re-switching
// Chat lines that mean the sub-server restarted / we were sent back to the lobby.
const LOBBY_PROMPT = /\b(restart(?:ing|ed)?|reboot(?:ing)?|sending you to|moved to (?:the )?lobby|sent to (?:the )?lobby|fell back|server is (?:going )?down|connection lost)\b/i;
// Countdown lines the server sends just before a restart ("Server restarting in 3 2 1").
// Use \b on both sides of each single digit so "120" or "$120" never matches.
const RESTART_COUNTDOWN = /\brestart(?:ing)?\b.*\b[123]\b|\b3\b[\s.]+\b2\b[\s.]+\b1\b|\brestarting\s+soon\b/i;

// Terminal colors (truecolor for rich, vivid output)
const rgb = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: rgb(80, 250, 123), yellow: rgb(255, 215, 90), cyan: rgb(80, 220, 250),
  red: rgb(255, 95, 110), gray: rgb(120, 130, 150), magenta: rgb(210, 120, 255),
  blue: rgb(90, 160, 255), orange: rgb(255, 160, 70), pink: rgb(255, 120, 200),
  white: rgb(240, 245, 255)
};

// Vertical gradient for the logo (top = cyan → bottom = purple/pink)
const LOGO_COLORS = [
  rgb(80, 230, 255), rgb(95, 200, 255), rgb(120, 170, 255),
  rgb(160, 140, 255), rgb(200, 120, 250), rgb(240, 110, 220)
];

// ---- UI helpers (consistent, colorful console output) ----
const BOX_W = 50; // inner width of framed boxes (chars between the borders)

// A single status line: colored icon + label + message. Used for all bot replies.
//   ui.ok('Anti-AFK ON', 'moving every 8s')  →  "  ✔ Anti-AFK ON — moving every 8s"
function line(icon, color, label, msg = '') {
  const tail = msg ? ` ${c.gray}${msg}${c.reset}` : '';
  console.log(`  ${color}${icon}${c.reset} ${color}${c.bold}${label}${c.reset}${tail}`);
}
const ui = {
  ok:   (l, m) => line('✔', c.green,  l, m),
  info: (l, m) => line('●', c.cyan,   l, m),
  warn: (l, m) => line('▲', c.orange, l, m),
  err:  (l, m) => line('✘', c.red,    l, m),
};

// Draw a rounded, colored box. `title` is the header; `rows` is [name, desc] pairs.
function drawBox(title, rows, footer) {
  const bar = '─'.repeat(BOX_W);
  const fit = (s, w) => (s.length > w ? s.slice(0, w) : s.padEnd(w));
  console.log('');
  console.log(`  ${c.blue}╭${bar}╮${c.reset}`);
  console.log(`  ${c.blue}│${c.reset} ${c.bold}${c.magenta}${fit(title, BOX_W - 1)}${c.reset}${c.blue}│${c.reset}`);
  console.log(`  ${c.blue}├${bar}┤${c.reset}`);
  for (const [name, desc] of rows) {
    const n = fit(name, 16);                 // command column
    const d = fit(desc, BOX_W - 16 - 2);     // description column (1 lead + 1 gap)
    console.log(`  ${c.blue}│${c.reset} ${c.yellow}${n}${c.reset} ${c.white}${d}${c.reset}${c.blue}│${c.reset}`);
  }
  console.log(`  ${c.blue}╰${bar}╯${c.reset}`);
  if (footer) console.log(`  ${c.gray}${footer}${c.reset}`);
  console.log('');
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

function printBanner() {
  console.clear();
  const logo = [
    '  ███╗   ███╗ ██████╗██████╗  ██████╗ ████████╗',
    '  ████╗ ████║██╔════╝██╔══██╗██╔═══██╗╚══██╔══╝',
    '  ██╔████╔██║██║     ██████╔╝██║   ██║   ██║   ',
    '  ██║╚██╔╝██║██║     ██╔══██╗██║   ██║   ██║   ',
    '  ██║ ╚═╝ ██║╚██████╗██████╔╝╚██████╔╝   ██║   ',
    '  ╚═╝     ╚═╝ ╚═════╝╚═════╝  ╚═════╝    ╚═╝   '
  ];
  console.log('');
  logo.forEach((row, i) => console.log(c.bold + LOGO_COLORS[i] + row + c.reset));
  console.log('');
  console.log(`  ${c.blue}──────────────────────────────────────────────${c.reset}`);
  console.log('');
}

// Network problems just mean the server is offline / unreachable — never a real crash.
const OFFLINE_CODES = ['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'EAI_AGAIN', 'EPIPE'];

// Swallow stray socket errors so Node never prints an ugly stack trace.
// The clean status line is shown by the bot's 'end' handler instead.
function handleStray(err) {
  const e = err || {};
  if (OFFLINE_CODES.includes(e.code)) return; // silent — handled as "Server offline"
  console.log(`  ${c.red}● Error:${c.reset} ${e.message || e}`);
}
process.on('uncaughtException', handleStray);
process.on('unhandledRejection', handleStray);

// Survive terminal disconnect — don't let a closed stdin kill the bot.
// In tmux / nohup / SSH the process should keep running game answers.
try { process.on('SIGHUP', () => {}); } catch (_) {} // ignore — keep running after SSH drops

// Save a key into .env without exposing the value in logs.
function saveEnvKey(key, value) {
  try {
    const envPath = require('path').join(__dirname, '.env');
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch (_) {}
    const lines = content.split('\n').filter(l => !l.startsWith(key + '=') && !l.startsWith(key + '="') && l.trim());
    lines.push(`${key}="${value}"`);
    fs.writeFileSync(envPath, lines.join('\n') + '\n');
  } catch (_) {}
}

async function main() {
  printBanner();


  // 1) Player name
  let username = '';
  while (!username.trim()) {
    username = await ask(`  ${c.green}➜${c.reset} ${c.white}${c.bold}Enter player name${c.reset}${c.gray}:${c.reset} ${c.yellow}`);
    process.stdout.write(c.reset);
    if (!username.trim()) console.log(`  ${c.red}✘ Player name cannot be empty.${c.reset}`);
  }
  username = username.trim();

  // 2) Server IP (default on Enter)
  const ipInput = (await ask(
    `  ${c.green}➜${c.reset} ${c.white}${c.bold}Enter IP${c.reset} ${c.gray}(Enter = default ${c.blue}${DEFAULT_IP}:${DEFAULT_PORT}${c.gray})${c.reset}${c.gray}:${c.reset} ${c.yellow}`
  )).trim();
  process.stdout.write(c.reset);

  let host = DEFAULT_IP;
  let port = DEFAULT_PORT;
  if (ipInput) {
    const parts = ipInput.split(':');
    host = parts[0].trim() || DEFAULT_IP;
    if (parts[1] && !isNaN(parseInt(parts[1], 10))) port = parseInt(parts[1], 10);
  }




  // 3) Discord token — ask once after IP, hidden input, saved to .env.
  if (!process.env.DISCORD_TOKEN) {
    let token = '';
    while (!token.trim()) {
      token = await new Promise((res) => {
        process.stdout.write(`  ${c.green}➜${c.reset} ${c.white}${c.bold}Enter Discord bot token${c.reset}${c.gray} (saved to .env, won't ask again):${c.reset} ${c.yellow}`);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        let buf = '';
        process.stdin.on('data', function handler(ch) {
          if (ch === '\r' || ch === '\n') {
            process.stdin.setRawMode(false);
            process.stdin.removeListener('data', handler);
            process.stdout.write(c.reset + '\n');
            res(buf);
          } else if (ch === '') { process.exit(); }
          else if (ch === '') { if (buf.length) buf = buf.slice(0, -1); }
          else { buf += ch; }
        });
      });
      if (!token.trim()) console.log(`  ${c.red}✘ Token cannot be empty.${c.reset}`);
    }
    saveEnvKey('DISCORD_TOKEN', token.trim());
    process.env.DISCORD_TOKEN = token.trim();
    console.log(`  ${c.green}✔${c.reset} ${c.gray}Discord token saved — won't ask again.${c.reset}`);
  }

  // 3) Connect (with auto-reconnect while the server boots)
  let bot = null;
  let listenerAttached = false;
  let shuttingDown = false; // true once the scheduled daily shutdown fires — blocks reconnect

  // ---- Discord IPC ----
  const IPC_FILE = require('path').join(__dirname, '.discord-ipc.json');
  function ipcRead() { try { return JSON.parse(fs.readFileSync(IPC_FILE, 'utf8')); } catch (_) { return { mcMessages: [], commands: [], botStatus: null }; } }
  function ipcWrite(d) { try { fs.writeFileSync(IPC_FILE, JSON.stringify(d)); } catch (_) {} }
  function ipcPushChat(line) { const d = ipcRead(); (d.mcMessages = d.mcMessages || []).push(line); if (d.mcMessages.length > 100) d.mcMessages = d.mcMessages.slice(-100); ipcWrite(d); }
  function ipcSetStatus(status) { const d = ipcRead(); d.botStatus = status; ipcWrite(d); }

  // ---- Auto-start Discord bridge (reads token from .env, never in command line) ----
  let discordChild = null;
  function startDiscordBridge() {
    const bridgePath = path.join(__dirname, 'discord-bridge.js');
    if (!fs.existsSync(bridgePath)) return;
    discordChild = spawn('node', [bridgePath], {
      cwd: __dirname,
      stdio: 'inherit',
      detached: false,
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' },
    });
    discordChild.on('exit', (code) => {
      if (code !== 0) ui.warn('Discord bridge', `exited with code ${code}`);
      discordChild = null;
    });
  }
  startDiscordBridge();

  // Poll IPC every second for commands sent from Discord
  setInterval(() => {
    const d = ipcRead();
    if (!d.commands || !d.commands.length) return;
    d.commands.forEach((cmd) => {
      if (!bot || !bot.player) return;
      if (cmd.startsWith('__chat__:')) {
        try { bot.chat(cmd.slice(9)); } catch (_) {}
      } else {
        handleCommand(cmd);
      }
    });
    d.commands = [];
    ipcWrite(d);
  }, 1000);

  // ---- Local bot commands (the `!` commands) ----
  // These are handled here in the console and are NEVER sent to server chat.
  let afkTimer = null;   // setInterval handle while anti-AFK is on
  let following = null;  // username we're currently following, or null
  let mining = null;     // { pos: Vec3 } while !oneblock is running, or null
  let gameMode = true;   // auto-answering is ON by default (24/7)
  let fillMissingOnly = FILL_MISSING_LETTERS_ONLY; // sticky: send only the missing letters for fill games

  const notConnected = `  ${c.orange}▲${c.reset} ${c.orange}${c.bold}Not connected${c.reset} ${c.gray}— wait for "JOINED THE SERVER".${c.reset}`;

  function stopAfk() {
    if (afkTimer) { clearInterval(afkTimer); afkTimer = null; }
  }

  // Milliseconds from now until the next HH:00:00 in Asia/Colombo (independent of
  // the host's own timezone). Used to schedule the daily shutdown precisely.
  function msUntilColomboHour(hour) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Colombo', hour12: false,
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date());
    const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
    let h = get('hour'); if (h === 24) h = 0; // some ICU builds report 24 at midnight
    const nowSec = h * 3600 + get('minute') * 60 + get('second');
    let diff = hour * 3600 - nowSec;
    if (diff <= 0) diff += 24 * 3600; // already past today -> aim for tomorrow
    return diff * 1000;
  }

  // Disconnect and EXIT at DAILY_SHUTDOWN_HOUR (Asia/Colombo), without reconnecting.
  // The user restarts the bot manually afterwards. One-shot: the process exits.
  function scheduleDailyShutdown() {
    if (DAILY_SHUTDOWN_HOUR == null) return;
    const ms = msUntilColomboHour(DAILY_SHUTDOWN_HOUR);
    ui.info('Auto-shutdown armed', `disconnecting at ${String(DAILY_SHUTDOWN_HOUR).padStart(2, '0')}:00 Asia/Colombo (in ${(ms / 3600000).toFixed(1)}h)`);
    setTimeout(() => {
      shuttingDown = true; // stop the 'end' handler from reconnecting
      console.log(`\n  ${c.yellow}● ${String(DAILY_SHUTDOWN_HOUR).padStart(2, '0')}:00 Asia/Colombo${c.reset} ${c.gray}— scheduled shutdown. Disconnecting and exiting (no reconnect).${c.reset}`);
      stopAfk();
      try { if (bot) bot.quit(); } catch (_) {}
      try { rl.close(); } catch (_) {}
      process.exit(0);
    }, ms);
  }

  // ---- Auto-vault: deposit keep-items to /pv 1, trash everything else ----
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let vaultMode = AUTO_VAULT; // toggled by !autovault
  let vaultTimer = null;      // the 10-min interval handle
  let vaultBusy = false;      // guard so two cycles never overlap

  // Flatten a chat component (string | {text, extra} | array) into plain text.
  function chatToText(j) {
    if (j == null) return '';
    if (typeof j === 'string') return j;
    if (Array.isArray(j)) return j.map(chatToText).join('');
    let s = typeof j.text === 'string' ? j.text : '';
    if (j.extra) s += chatToText(j.extra);
    return s;
  }

  // A clean, lowercase label for an item: its custom (server) name if it has one,
  // otherwise its normal display name. Color codes and symbols are stripped so a
  // fancy "✦ §ePARTY KEY §f✦" still matches "party key".
  function itemLabel(item) {
    if (!item) return '';
    let name = '';
    try {
      const cn = item.customName;
      if (cn) { try { name = chatToText(JSON.parse(cn)); } catch (_) { name = chatToText(cn); } }
    } catch (_) {}
    if (!name) name = item.displayName || item.name || '';
    return String(name).replace(/§./g, '').replace(/[^a-z0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  const isKeepItem = (item) => { const l = itemLabel(item); return l && VAULT_KEEP.some((k) => l.includes(k)); };

  // Run a command that opens a chest GUI and wait for the window. Returns the
  // window, or null if none opened within the timeout.
  function openCommandWindow(cmd, timeout = 5000) {
    return new Promise((res) => {
      let done = false;
      const onOpen = (w) => { if (done) return; done = true; clearTimeout(to); res(w); };
      const to = setTimeout(() => { if (done) return; done = true; bot.removeListener('windowOpen', onOpen); res(null); }, timeout);
      bot.once('windowOpen', onOpen);
      try { bot.chat(cmd); } catch (_) { if (!done) { done = true; clearTimeout(to); bot.removeListener('windowOpen', onOpen); res(null); } }
    });
  }

  // Shift-click every player-inventory item matching `predicate` into the open
  // container (the chest GUI). Armor/offhand aren't part of a container window,
  // so equipped gear is never touched. Returns how many stacks were moved.
  async function depositMatching(predicate) {
    const win = bot.currentWindow;
    if (!win) return 0;
    let moved = 0;
    for (let slot = win.inventoryStart; slot < win.inventoryEnd; slot++) {
      const it = win.slots[slot];
      if (it && predicate(it)) {
        try { await bot.clickWindow(slot, 0, 1); moved++; await sleep(160); } catch (_) {}
      }
    }
    return moved;
  }

  // One full cycle: keep-items -> /pv 1, then everything else -> /trash.
  async function runVaultCycle(manual = false) {
    if (!bot || !bot.player) { if (manual) console.log(notConnected); return; }
    if (vaultBusy) { if (manual) ui.warn('Vault busy', 'a cycle is already running'); return; }
    vaultBusy = true;
    try {
      const items = bot.inventory.items();
      const hasKeep = items.some(isKeepItem);
      const hasJunk = items.some((it) => !isKeepItem(it));
      if (!hasKeep && !hasJunk) { if (manual) ui.info('Vault', 'inventory empty — nothing to do'); return; }

      // 1) Deposit the keep-items into the player vault.
      if (hasKeep) {
        const w = await openCommandWindow(VAULT_PV_COMMAND);
        if (w) {
          await sleep(350);
          const n = await depositMatching(isKeepItem);
          await sleep(200);
          try { bot.closeWindow(w); } catch (_) {}
          ui.ok('Vault deposit', `${n} stack(s) → ${VAULT_PV_COMMAND}`);
        } else { ui.warn('Vault', `no GUI opened for ${VAULT_PV_COMMAND}`); }
        await sleep(500);
      }

      // 2) Trash everything that isn't a keep-item (PERMANENT). isKeepItem guards
      //    this too, so a failed deposit above never sends keep-items to the trash.
      if (bot.inventory.items().some((it) => !isKeepItem(it))) {
        const w = await openCommandWindow(VAULT_TRASH_COMMAND);
        if (w) {
          await sleep(350);
          const n = await depositMatching((it) => !isKeepItem(it));
          await sleep(200);
          try { bot.closeWindow(w); } catch (_) {}
          ui.warn('Trashed', `${n} stack(s) via ${VAULT_TRASH_COMMAND}`);
        } else { ui.warn('Vault', `no GUI opened for ${VAULT_TRASH_COMMAND}`); }
      }
    } catch (e) {
      ui.err('Vault cycle failed', e.message || String(e));
    } finally {
      vaultBusy = false;
    }
  }

  function startVaultTimer() {
    if (vaultTimer) return;
    vaultTimer = setInterval(() => { if (vaultMode && bot && bot.player) runVaultCycle(); }, VAULT_INTERVAL);
  }
  function stopVaultTimer() { if (vaultTimer) { clearInterval(vaultTimer); vaultTimer = null; } }

  // ---- Auto-trade: owner whispers "inv" -> withdraw keys+candles from /pv 1, /trade them ----
  let tradeBusy = false;
  const isGiveItem = (item) => { const l = itemLabel(item); return l && TRADE_GIVE.some((g) => l.includes(g)); };

  // Shift-click container-side items matching `predicate` INTO the player inventory (withdraw).
  async function withdrawMatching(predicate) {
    const win = bot.currentWindow;
    if (!win) return 0;
    let moved = 0;
    for (let slot = 0; slot < win.inventoryStart; slot++) {
      const it = win.slots[slot];
      if (it && predicate(it)) {
        try { await bot.clickWindow(slot, 0, 1); moved++; await sleep(160); } catch (_) {}
      }
    }
    return moved;
  }

  // Left-click the first container item whose label matches one of `names` and none of `avoid`.
  async function clickFirstMatch(names, avoid) {
    const win = bot.currentWindow;
    if (!win) return null;
    for (let slot = 0; slot < win.inventoryStart; slot++) {
      const it = win.slots[slot];
      if (!it) continue;
      const l = itemLabel(it);
      if (avoid.some((a) => l.includes(a))) continue;
      if (names.some((n) => l.includes(n))) {
        try { await bot.clickWindow(slot, 0, 0); return { slot, label: l }; } catch (_) { return null; }
      }
    }
    return null;
  }

  // Log the non-empty CONTAINER slots of a window (for tuning the trade GUI layout).
  function logWindowContainer(win, where) {
    const parts = [];
    for (let slot = 0; slot < win.inventoryStart && parts.length < 28; slot++) {
      const it = win.slots[slot];
      if (it) parts.push(`${slot}:${itemLabel(it)}`);
    }
    ui.info(`Trade GUI (${where})`, parts.length ? parts.join('  ') : '(no container items)');
  }

  // The full trade flow. Triggered by the owner's whisper, or manually via !invtrade.
  async function runTradeFlow(trigger = 'manual') {
    if (!TRADE_ENABLED) { if (trigger === 'manual') ui.warn('Trade', 'disabled (TRADE_ENABLED=false)'); return; }
    if (!bot || !bot.player) { if (trigger === 'manual') console.log(notConnected); return; }
    if (tradeBusy) { ui.warn('Trade', 'already in progress'); return; }
    tradeBusy = true;
    try {
      ui.info('Trade flow', `triggered by ${trigger} — withdrawing keys+candles from ${TRADE_PV_COMMAND}`);
      // 1) Withdraw the give-items from the vault into the inventory.
      const pv = await openCommandWindow(TRADE_PV_COMMAND);
      if (pv) {
        await sleep(350);
        const n = await withdrawMatching(isGiveItem);
        await sleep(200);
        try { bot.closeWindow(pv); } catch (_) {}
        ui.ok('Withdrew', `${n} stack(s) from ${TRADE_PV_COMMAND}`);
      } else { ui.warn('Trade', `no GUI opened for ${TRADE_PV_COMMAND} — using whatever is already in inventory`); }
      await sleep(600);

      const have = bot.inventory.items().filter(isGiveItem);
      if (!have.length) { ui.warn('Trade aborted', 'no keys/candles to trade'); return; }

      // 2) Send the trade request and wait for the owner to accept (window opens).
      const tradeCmd = `/trade invite ${TRADE_OWNER}`;
      ui.info('Trade', `sending ${tradeCmd} — waiting up to ${TRADE_ACCEPT_TIMEOUT / 1000}s for accept`);
      const win = await openCommandWindow(tradeCmd, TRADE_ACCEPT_TIMEOUT);
      if (!win) { ui.warn('Trade aborted', `${TRADE_OWNER} did not accept in time`); return; }
      await sleep(600);
      logWindowContainer(win, 'opened');

      // 3) Deposit the keys+candles into the trade window.
      const dn = await depositMatching(isGiveItem);
      ui.ok('Trade deposit', `${dn} stack(s) into the trade window`);
      await sleep(600);
      logWindowContainer(win, 'after deposit');

      // 4) Confirm: click the green/lime wool, never the red one. If no green wool
      //    is found we leave the window for manual confirm rather than risk decline.
      const clicked = await clickFirstMatch(TRADE_CONFIRM_WOOL, TRADE_AVOID_WOOL);
      if (clicked) ui.ok('Trade confirm', `clicked ${clicked.label} (slot ${clicked.slot}) — completes when ${TRADE_OWNER} confirms`);
      else ui.warn('Trade confirm', 'no green/lime wool found — confirm manually (see GUI log above)');
    } catch (e) {
      ui.err('Trade flow failed', e.message || String(e));
    } finally {
      tradeBusy = false;
    }
  }

  // Whisper trigger: only the owner, only the exact trigger word.
  function maybeTradeTrigger(sender, message, via) {
    if (!TRADE_ENABLED) return;
    if (!sender || String(sender).toLowerCase() !== TRADE_OWNER.toLowerCase()) return;
    if (String(message || '').trim().toLowerCase() !== TRADE_TRIGGER) return;
    ui.info('Trade trigger', `${sender} whispered "${TRADE_TRIGGER}" (${via})`);
    runTradeFlow(`whisper:${sender}`);
  }

  // Fallback whisper parser for custom server formats not caught by bot.on('whisper').
  function parseWhisperLine(line) {
    const s = String(line || '').replace(/§./g, '').trim();
    let m;
    // "✉⬇ MSG (RO0MII ➺ me) inv"  — server's own DM format
    if ((m = s.match(/MSG\s*\(\s*([A-Za-z0-9_]{2,16})\s*[➺→»>-]+\s*(?:me|you)\s*\)\s*(.+)$/i))) return { sender: m[1], msg: m[2].trim() };
    if ((m = s.match(/^(?:\[[^\]]*\]\s*)*([A-Za-z0-9_]{2,16})\s+whispers?(?:\s+to\s+you)?\s*[:>-]?\s*(.+)$/i))) return { sender: m[1], msg: m[2] };
    if ((m = s.match(/^\[?([A-Za-z0-9_]{2,16})\s*[-=]+>\s*(?:me|you)\s*\]?\s*[:]?\s*(.+)$/i))) return { sender: m[1], msg: m[2] };
    if ((m = s.match(/^\[?([A-Za-z0-9_]{2,16})\s*[→»]\s*(?:me|you)\s*\]?\s*[:]?\s*(.+)$/i))) return { sender: m[1], msg: m[2] };
    if ((m = s.match(/^from\s+([A-Za-z0-9_]{2,16})\s*[:]\s*(.+)$/i))) return { sender: m[1], msg: m[2] };
    return null;
  }

  // Anti-AFK: small harmless movements so the server never marks us idle.
  function startAfk() {
    if (afkTimer) return;
    let step = 0;
    afkTimer = setInterval(() => {
      if (!bot || !bot.entity) return;
      try {
        bot.swingArm('right');
        bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.6, false);
        if (step % 2 === 0) { // occasional little jump
          bot.setControlState('jump', true);
          setTimeout(() => { try { bot.setControlState('jump', false); } catch (_) {} }, 350);
        }
        step++;
      } catch (_) {}
    }, AFK_INTERVAL);
  }

  function stopFollow() {
    following = null;
    try { bot.pathfinder.setGoal(null); } catch (_) {}
  }

  function stopMining() {
    mining = null;
    try { bot.stopDigging(); } catch (_) {}
    try { bot.pathfinder.setGoal(null); } catch (_) {}
  }

  // Pick the FASTEST tool for this block that still has more than TOOL_BREAK_BUFFER
  // uses left — so !oneblock never digs with a tool that's about to break.
  // Returns { tool, skipped } where `tool` may be null (= dig with bare hand).
  function pickSafeTool(block) {
    const effects = bot.entity.effects;
    let bestTool = null;
    let fastest = Number.MAX_VALUE;
    let skipped = 0;
    for (const item of bot.inventory.items()) {
      // Durability left = maxDurability - durabilityUsed. Items with no
      // maxDurability (e.g. a torch) never wear out, so they're always safe.
      if (item.maxDurability) {
        const left = item.maxDurability - (item.durabilityUsed || 0);
        if (left <= TOOL_BREAK_BUFFER) { skipped++; continue; } // about to break — skip it
      }
      const enchants = item.nbt ? require('prismarine-nbt').simplify(item.nbt).Enchantments : [];
      const digTime = block.digTime(item.type, false, false, false, enchants, effects);
      if (digTime < fastest) { fastest = digTime; bestTool = item; }
    }
    return { tool: bestTool, skipped };
  }

  // Continuously mine the block at `mining.pos`: walk into reach, equip a safe
  // tool, dig, then wait for it to come back (oneblock-style) and repeat.
  async function mineLoop() {
    while (mining) {
      const pos = mining.pos;
      const block = bot.blockAt(pos);

      // Nothing to mine yet (air / not loaded) — wait for it to (re)appear.
      if (!block || !block.diggable || block.name === 'air') {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      // Walk into digging range if we're too far.
      if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > MINE_REACH) {
        try {
          await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
        } catch (_) {
          if (!mining) break;
          ui.warn('Can\'t reach block', 'retrying in 2s');
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
      }
      if (!mining) break;

      const { tool, skipped } = pickSafeTool(block);
      try {
        if (tool) await bot.equip(tool, 'hand');
        else await bot.unequip('hand').catch(() => {}); // no safe tool — use bare hand
      } catch (_) {}

      const toolName = tool ? tool.name : 'bare hand';
      const note = skipped ? `${toolName} · skipped ${skipped} worn tool${skipped > 1 ? 's' : ''}` : toolName;
      ui.info(`Mining ${block.name}`, note);

      try {
        await bot.dig(block, true);
        ui.ok('Block mined', `x=${pos.x} y=${pos.y} z=${pos.z}`);
      } catch (_) {
        if (!mining) break;
      }
      await new Promise((r) => setTimeout(r, 400)); // small breather before the next pass
    }
  }

  // ---- Chat-game auto-answering (!games) ----
  // Lazily-built map of "sorted letters" -> [real words] for unscramble games,
  // plus a flat list of all dictionary words for fill-in-the-blank matching.
  let anagramMap = null;
  let wordList = null;
  function loadAnagrams() {
    if (anagramMap) return anagramMap;
    anagramMap = new Map();
    wordList = [];
    try {
      const words = fs.readFileSync(WORDLIST_PATH, 'utf8').split('\n');
      for (let w of words) {
        w = w.trim().toLowerCase();
        if (!w || w.length < 2 || !/^[a-z]+$/.test(w)) continue; // skip names/apostrophes
        wordList.push(w);
        const key = w.split('').sort().join('');
        const list = anagramMap.get(key);
        if (list) { if (!list.includes(w)) list.push(w); }
        else anagramMap.set(key, [w]);
      }
      // Load custom server-specific words (one per line, plain text).
      // These are checked first and can include hyphens, apostrophes, etc.
      try {
        const custom = fs.readFileSync(CUSTOM_WORDS_PATH, 'utf8').split('\n');
        for (let w of custom) {
          w = w.trim().toLowerCase();
          if (!w || w.length < 2) continue;
          wordList.unshift(w); // prepend — checked first
          const key = w.split('').sort().join('');
          const list = anagramMap.get(key);
          if (list) { if (!list.includes(w)) list.push(w); }
          else anagramMap.set(key, [w]);
        }
      } catch (_) { /* no custom words file — that's fine */ }
    } catch (_) { /* no dictionary — unscramble/fill-blank just won't solve */ }
    return anagramMap;
  }

  // Minecraft item/block names — used to solve unscramble puzzles that the plain
  // dictionary can't. Server games scramble item names like "Waxed Oxidized Cut
  // Copper Slab", which (a) are multi-word phrases the per-word solver mangles and
  // (b) contain words with several valid anagrams (slab/labs, waxed/dewax) where
  // picking the first dictionary hit gives a wrong answer. We build:
  //   phraseMap : sorted-letters-of-whole-phrase -> original phrase  (exact match)
  //   mcWordSet : every individual word seen in an item name         (tie-breaker)
  let phraseMap = null;
  let phraseList = null;
  let mcWordSet = null;
  const lettersKey = (s) => s.toLowerCase().replace(/[^a-z]/g, '').split('').sort().join('');
  function loadPhrases() {
    if (phraseMap) return phraseMap;
    phraseMap = new Map();
    phraseList = [];
    mcWordSet = new Set();
    const ingest = (raw) => {
      const phrase = raw.trim();
      if (!phrase || phrase.startsWith('#')) return; // skip blanks and comments
      const lc = phrase.toLowerCase();
      const key = lettersKey(phrase);
      if (key.length >= 2 && !phraseMap.has(key)) { phraseMap.set(key, lc); phraseList.push(lc); }
      for (const w of lc.split(/\s+/)) {
        const clean = w.replace(/[^a-z]/g, '');
        if (clean.length >= 2) mcWordSet.add(clean);
      }
    };
    try {
      for (const line of fs.readFileSync(MINECRAFT_ITEMS_PATH, 'utf8').split('\n')) ingest(line);
    } catch (_) { /* no item list — fall back to dictionary-only solving */ }
    // Multi-word lines in custom-words.txt are treated as phrases too.
    try {
      for (const line of fs.readFileSync(CUSTOM_WORDS_PATH, 'utf8').split('\n')) {
        if (/\s/.test(line.trim())) ingest(line);
      }
    } catch (_) { /* no custom words file — fine */ }
    return phraseMap;
  }

  // Fill-in-the-blank: turn a masked token like "app_e" or "c_t" into a regex
  // and find the dictionary word(s) that fit. The defaults server uses `_` as
  // a variable-length gap (1+ chars) and `.*-` as single-letter wildcards.
  // Multi-word masks like "_uc_et _f a_o_o_l" are solved per-word and re-emitted
  // with the original whitespace preserved. If ANY word can't be solved, the
  // entire answer is abandoned — no single-word fallback, so the bot never
  // sends a wrong partial answer.
  // Build a regex from a fill mask (over one or more whitespace-separated words)
  // and find the Minecraft item name(s) that fit. This is what disambiguates
  // multi-word fill puzzles like "_ink _u__le" -> "pink bundle", where every
  // word has many dictionary matches and only the item list knows the real pair.
  function matchPhraseMask(token, opts = {}) {
    loadPhrases();
    if (!phraseList.length) return null;
    if (!/[_.*-]/.test(token)) return null; // no blank — nothing to fill
    // Non-greedy so adjacent gaps don't eat into each other (e.g. __bb_e_tone -> cobblestone).
    const gap = opts.exactOne ? '[a-z]' : '[a-z]{1,3}?';
    const words = token.toLowerCase().split(/\s+/).filter(Boolean);
    const parts = words.map((w) => {
      const masked = w.replace(/[^a-z_.*-]/g, '');
      if (!masked) return null;
      return masked.replace(/[.*-]/g, '[a-z]').replace(/_/g, gap);
    });
    if (parts.some((p) => p === null)) return null;
    const re = new RegExp('^' + parts.join('\\s+') + '$');
    const hits = phraseList.filter((p) => re.test(p));
    // Prefer the shortest match — tightest fit to the mask is almost always right.
    return hits.length ? hits.sort((a, b) => a.length - b.length)[0] : null;
  }

  function solveFillBlank(token, opts = {}) {
    loadAnagrams();
    if (!wordList) return null;
    if (!token) return null;
    // (0) Known Minecraft item name matching the whole mask wins — resolves
    // multi-word fills that per-word dictionary matching would guess wrong.
    const phraseHit = matchPhraseMask(token, opts);
    if (phraseHit) return phraseHit;
    const parts = token.split(/\s+/).filter(Boolean);
    if (parts.length > 1) {
      const solved = parts.map((p) => solveFillBlank(p, opts));
      if (solved.every((w) => w)) return solved.join(' ');
      return null; // can't solve every word — don't send a partial answer
    }
    const masked = token.toLowerCase().replace(/[^a-z_.*-]/g, '');
    if (!/[_.*-]/.test(masked) || !/[a-z]/.test(masked)) return null; // needs a blank AND a letter
    // `_` = variable-length gap (1-3 chars); `.`, `*`, `-` = single letter each.
    // With opts.exactOne every `_` is exactly ONE letter — used when we must line
    // the solved word up against the mask to read off just the missing letters.
    // Non-greedy {1,3}? prevents adjacent gaps from eating each other's letters.
    const gap = opts.exactOne ? '[a-z]' : '[a-z]{1,3}?';
    // Order: replace .*- first (keeps `_`), then _ (so _ isn't caught in .*-)
    let reStr = masked.replace(/[.*-]/g, '[a-z]').replace(/_/g, gap);
    const re = new RegExp('^' + reStr + '$');
    const fixedCount = masked.replace(/[_.*-]/g, '').length;
    const gapCount = (masked.match(/_/g) || []).length;
    const minLen = fixedCount + gapCount; // each gap contributes at least 1 letter
    const hits = wordList.filter((w) => w.length >= minLen && re.test(w));
    if (hits.length) return hits.sort((a, b) => a.length - b.length)[0];
    // Fallback: search individual words extracted from MC item names (e.g. "donkey" from
    // "donkey spawn egg") — catches mob names and other game words not in the English dict.
    if (mcWordSet) {
      const mcHits = [...mcWordSet].filter((w) => w.length >= minLen && re.test(w));
      if (mcHits.length) return mcHits.sort((a, b) => a.length - b.length)[0];
    }
    return null;
  }

  // Filler words an instruction line dangles after "type" ("type the missing
  // letters", "type your answer below"). A bare one of these is never the literal
  // a "type: X" puzzle wants, so we refuse to send it as an answer.
  const STOPWORDS = new Set([
    'the', 'a', 'an', 'your', 'this', 'that', 'it', 'its', 'in', 'on', 'to',
    'of', 'and', 'only', 'them', 'here', 'below', 'now', 'fast', 'quick',
    'missing', 'letters', 'letter', 'word', 'words', 'answer', 'answers',
  ]);

  // Built-in trivia table for question games ("first to answer the question wins").
  // Each KEY is a set of space-separated KEYWORDS: a question matches an entry
  // only when EVERY keyword appears somewhere in the question. More-specific
  // entries (more keywords) are tried first, so a precise match always wins over
  // a loose one. To add server-specific Q&A WITHOUT editing code, put
  // "keywords = answer" lines in custom-trivia.txt — those are checked first.
  const TRIVIA = {
    // --- Geography ---
    'capital of france': 'Paris',
    'capital of japan': 'Tokyo',
    'capital of italy': 'Rome',
    'capital of germany': 'Berlin',
    'capital of england': 'London',
    'capital of spain': 'Madrid',
    'capital of russia': 'Moscow',
    'capital of china': 'Beijing',
    'capital of canada': 'Ottawa',
    'capital of australia': 'Canberra',
    'capital of sri lanka': 'Sri Jayawardenepura Kotte',
    'largest ocean': 'Pacific',
    'tallest mountain': 'Mount Everest',
    'longest river': 'Nile',
    'fastest land animal': 'Cheetah',
    // --- Space / science ---
    'largest planet': 'Jupiter',
    'smallest planet': 'Mercury',
    'red planet': 'Mars',
    'closest planet to the sun': 'Mercury',
    'chemical symbol for water': 'H2O',
    'chemical symbol for gold': 'Au',
    // --- Counting ---
    'how many continents': '7',
    'how many days in a week': '7',
    'how many colors in a rainbow': '7',
    // --- Minecraft (high-confidence; tweak in custom-trivia.txt if your server differs) ---
    'how many wood types': '14',
    'how many eyes ender': '12',
    'how many end portal frames': '12',
    'how many slots hotbar': '9',
    'which mob explodes': 'Creeper',
    'mob blows up': 'Creeper',
    'creepers afraid': 'Cat',
    'creepers scared': 'Cat',
    'mine diamonds with': 'Iron Pickaxe',
    'mine diamond with': 'Iron Pickaxe',
    'tame a wolf': 'Bone',
    'breed cows': 'Wheat',
    'breed pigs': 'Carrot',
    'hardest blast resistant block': 'Obsidian',
  };

  // Lazily-built, ordered list of trivia entries: { keys:[...], answer }.
  // custom-trivia.txt entries come first; then built-ins, most-specific first.
  let triviaEntries = null;
  // ---- Self-learning trivia ----
  let unseenTriviaQ = null;               // question we couldn't answer — waiting to learn
  const recentPlayerMsgs = [];            // rolling buffer {username, text, ts}
  const PLAYER_MSG_TTL = 45000;           // keep player messages for 45s

  // Parse a plain player chat line → {username, text} or null.
  // Format: "  [rank] username ▶ message" or "  username ▶ message"
  function parsePlayerChat(line) {
    const m = String(line).replace(/§./g, '').match(/^\s*(?:\[[^\]]+\]\s*)*([A-Za-z0-9_]{2,16})\s*▶\s*(.+)$/);
    return m ? { username: m[1].toLowerCase(), text: m[2].trim() } : null;
  }

  function recordPlayerMsg(username, text) {
    const cutoff = Date.now() - PLAYER_MSG_TTL;
    while (recentPlayerMsgs.length && recentPlayerMsgs[0].ts < cutoff) recentPlayerMsgs.shift();
    recentPlayerMsgs.push({ username: username.toLowerCase(), text, ts: Date.now() });
    if (recentPlayerMsgs.length > 50) recentPlayerMsgs.shift();
  }

  // Pick 3-4 distinctive keywords from a question for the trivia key.
  function questionToKeys(q) {
    const SW = new Set(['how','what','which','who','where','when','is','are','was','were','the','a','an','of','to','in','on','at','for','and','or','but','not','does','do','can','could','much','many','minimum','maximum','amount','required','needed','used','use','type','types','first','last','total','number','much','long','far','big','old']);
    const words = q.toLowerCase().replace(/[?!.]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !SW.has(w));
    return words.slice(0, 4).join(' ');
  }

  // Append a new "keywords = answer" line to custom-trivia.txt, then reload.
  function learnTrivia(question, rawAnswer) {
    const answer = String(rawAnswer || '').trim();
    if (!answer || answer.length > 80) return; // sanity: skip empty or absurdly long answers
    const keys = questionToKeys(question);
    if (!keys || keys.split(/\s+/).length < 2) return; // need at least 2 keywords
    triviaEntries = null; // force reload before checking
    if (solveTrivia(question.toLowerCase())) return; // already known — don't duplicate
    const line = `${keys} = ${answer}`;
    try {
      fs.appendFileSync(CUSTOM_TRIVIA_PATH, '\n' + line + '\n');
      triviaEntries = null; // reload on next solve call
      ui.ok('Trivia learned', `"${question.slice(0, 55)}" → "${answer}"  [key: ${keys}]`);
    } catch (e) { ui.warn('Trivia learn failed', e.message); }
  }
  function loadTrivia() {
    if (triviaEntries) return triviaEntries;
    const entries = [];
    // (a) Custom server-specific Q&A — "keywords = answer" (or "keywords | answer").
    //     Lines starting with # are comments. These win over the built-in table.
    try {
      const lines = fs.readFileSync(CUSTOM_TRIVIA_PATH, 'utf8').split('\n');
      for (let ln of lines) {
        ln = ln.trim();
        if (!ln || ln.startsWith('#')) continue;
        const i = ln.search(/[=|]/);
        if (i < 0) continue;
        const keys = ln.slice(0, i).toLowerCase().trim().split(/\s+/).filter(Boolean);
        const answer = ln.slice(i + 1).trim();
        if (keys.length && answer) entries.push({ keys, answer, custom: true });
      }
    } catch (_) { /* no custom-trivia.txt — that's fine */ }
    // (b) Built-in table.
    for (const q in TRIVIA) {
      entries.push({ keys: q.toLowerCase().split(/\s+/).filter(Boolean), answer: TRIVIA[q], custom: false });
    }
    // Custom first; within each group, more keywords (more specific) first.
    entries.sort((a, b) => (a.custom === b.custom ? b.keys.length - a.keys.length : a.custom ? -1 : 1));
    triviaEntries = entries;
    return entries;
  }
  function solveTrivia(low) {
    for (const e of loadTrivia()) {
      if (e.keys.every((k) => low.includes(k))) return e.answer;
    }
    return null;
  }
  function evalMath(expr) {
    const clean = expr.replace(/x/gi, '*').replace(/[^0-9+\-*/().\s]/g, '');
    if (!clean.trim() || !/[0-9]/.test(clean)) return null;
    try {
      // eslint-disable-next-line no-new-func
      const v = Function(`"use strict";return (${clean})`)();
      if (typeof v === 'number' && isFinite(v)) {
        return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
      }
    } catch (_) {}
    return null;
  }

  // Solve "guess the random number" games — extract min/max from the message
  // and pick a random number in that range. Matches patterns like:
  //   "random number 1-15", "number: 1-100", "guess 1-10", "between 1 and 15"
  function solveGuessNumber(text) {
    const SEP = /\s*(?:[-–]|to|and)\s*/i; // separator: dash, "to", or "and"
    const R = (p) => text.match(p);
    let m = R(new RegExp('(?:random\\s+)?number\\s*[:>\\]]?\\s*(\\d{1,3})' + SEP.source + '(\\d{1,3})', 'i'));
    if (!m) m = R(/between\s+(\d{1,3})(?:\s+and\s+|\s*[-–]\s*)(\d{1,3})/i);
    if (!m) m = R(new RegExp('(?:guess|random|number)\\s.*?(\\d{1,3})' + SEP.source + '(\\d{1,3})', 'i'));
    if (!m) m = R(new RegExp('^(\\d{1,3})' + SEP.source + '(\\d{1,3})$', 'i')); // bare "1 to 14" / "1-14"
    if (m) {
      const min = parseInt(m[1]), max = parseInt(m[2]);
      if (min >= 1 && max > min && max <= 10000) {
        const answer = String(min + Math.floor(Math.random() * (max - min + 1)));
        return { answer, kind: 'guess' };
      }
    }
    return null;
  }

  // Given a chat line, work out the answer to a game — or null if it's not one we solve.
  // Returns { answer, kind } so the console can label what it solved.
  function solveGame(msg) {
    // Strip Minecraft color codes (§a, &b, ...) so server-formatted game lines match.
    const text = msg.replace(/[§&][0-9a-fk-or]/gi, '').trim();
    const low = text.toLowerCase();

    // Skip server status / system lines that only LOOK like games — e.g. a
    // mining "Progress: 0% (18/10172)" bar, rate-limit notices, etc. Without
    // this the "(18/10172)" gets mistaken for a division game (= 0.002).
    if (/progress|please wait|please avoid|spam|cooldown|^\s*\d+\s*%|\(\s*\d+\s*\/\s*\d+\s*\)/i.test(low)) {
      return null;
    }

    // 1) Unscramble — "unscramble: ttacle" / "scramble the word ttacle" / "jumble"
    //    Allow multi-word scrambles (e.g. "adDe buTe olarC") — grab every letter
    //    run after the keyword and unscramble the joined letters as one word.
    let m = low.match(/(?:unscramble|unjumble|scramble|jumble)[^a-z0-9]*([a-z][a-z\s]*[a-z]|[a-z]{3,})/);
    if (m) {
      const raw = m[1].trim();
      // Try per-word first (preserves word boundaries in the answer); fall back
      // to the whole string joined together.
      const parts = raw.split(/\s+/).filter(Boolean);
      if (parts.length > 1) {
        const ans = unscramblePayload(raw);
        if (ans) return { answer: ans, kind: 'unscramble' };
      } else {
        const key = raw.split('').sort().join('');
        const hits = loadAnagrams().get(key);
        const ans = hits && (hits.find((w) => w !== raw) || hits[0]);
        if (ans) return { answer: ans, kind: 'unscramble' };
      }
    }

    // 2) Math — "solve 5 + 3", "what is 12 x 4", "first to answer 7*8".
    //    Only grab a run that actually has an operator BETWEEN two numbers, so a
    //    question number ("#3"), reward ("9 coins") or timer never gets mistaken
    //    for the sum. Among all candidates, the longest is the real equation.
    const mathExprs = text.match(/\d+(?:\.\d+)?(?:\s*[-+*x/]\s*\d+(?:\.\d+)?)+/gi);
    if (mathExprs) {
      const expr = mathExprs.sort((a, b) => b.length - a.length)[0];
      // Guard against stray numbers in normal sentences: only answer when the
      // line is clearly a math QUESTION — either it has a math keyword, or the
      // message is basically just the equation itself.
      const hasMathKeyword = /\b(solve|calculate|what(?:'s| is)|answer|equation|math|sum|plus|minus|times)\b|=/.test(low);
      const compact = text.replace(/\s+/g, '');
      const isMostlyExpr = expr.replace(/\s+/g, '').length >= compact.length * 0.6;
      if (hasMathKeyword || isMostlyExpr) {
        const ans = evalMath(expr);
        if (ans !== null) return { answer: ans, kind: 'math' };
      }
    }

    // 3) Type-the-word / retype — "first to type 'PINEAPPLE' wins" / "type: HELLO"
    //    Also "retype this: <sentence>" / "repeat: <text>" / "copy this <text>".
    m = text.match(/(?:retype|repeat|copy)(?:\s+this)?[:\s]+(.+)/i);
    if (m && m[1].trim().length >= 2) return { answer: m[1].trim(), kind: 'retype' };
    //    Require a real delimiter — quotes, an explicit "type the word", or a
    //    colon — NOT just a trailing space. Bare "type the missing letters" must
    //    not grab "the": that mid-sentence instruction has no colon or quotes.
    m = text.match(/type[^'"a-z0-9]*['"]([^'"]{2,})['"]/i)        // type 'WORD' / type "WORD"
        || text.match(/type\s+the\s+word[:\s]+([^\s.,!]{2,})/i)   // type the word: WORD
        || text.match(/type\s*:\s*([^\s.,!]{2,})/i);              // type: WORD
    if (m) {
      const tok = m[1].trim();
      // Skip instruction filler ("type the missing letters", "type your answer").
      if (!STOPWORDS.has(tok.toLowerCase())) {
        // If the token has a hidden letter (e.g. "type c_t"), it's a fill-blank, not a literal.
        if (/[_.*-]/.test(tok)) {
          const filled = solveFillBlank(tok);
          if (filled) return { answer: filled, kind: 'fill-blank', mask: tok };
        }
        return { answer: tok, kind: 'type' };
      }
    }

    // 4) Fill-in-the-blank — a token with hidden letters like "app_e" or "c_t".
    // 4) Fill-in-the-blank — a token (or run of tokens) with hidden letters
    //    like "app_e" or "_uc_et _f a_o_o_l". If two or more masked words appear
    //    on the same line, try to solve the whole phrase only. DON'T fall back
    //    to single-word — that sends a wrong partial answer.
    const multi = text.match(/\b((?:[a-z]*[_.*-][a-z_.*-]*\s+){1,}[a-z]*[_.*-][a-z_.*-]*)\b/i);
    if (multi) {
      const ans = solveFillBlank(multi[1].trim());
      if (ans) return { answer: ans, kind: 'fill-blank', mask: multi[1].trim() };
      return null; // multi-word mask but can't solve all words — don't send partial
    }
    m = text.match(/\b([a-z]*[_.*-][a-z_.*-]*)\b/i);
    if (m) {
      const ans = solveFillBlank(m[1]);
      if (ans) return { answer: ans, kind: 'fill-blank', mask: m[1] };
    }

    // 5) Guess the number — "random number 1-15" / "guess a number between 1 and 10"
    const guess = solveGuessNumber(text);
    if (guess) return guess;

    // 6) Trivia — a small built-in table of common questions (offline-safe).
    const triv = solveTrivia(low);
    if (triv) return { answer: triv, kind: 'trivia' };

    return null;
  }

  // Some games announce the TYPE on one line ("The first to unreverse the
  // letters wins!") and send the actual puzzle on a LATER line ("▶ ngiS ..").
  // We remember the announced operation and apply it to the next payload line.
  let pendingGame = null;   // 'reverse' | 'unscramble' | 'math' | 'fill' | 'type' | 'trivia' | 'guess'
  let pendingTimer = null;  // forgets the pending op if no payload arrives in time

  function setPending(kind) {
    pendingGame = kind;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => { pendingGame = null; pendingTimer = null; }, 20000);
    ui.info('Game detected', `${kind} — waiting for the puzzle line`);
  }
  function clearPending() {
    pendingGame = null;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  }

  // Read the game TYPE from an instruction line, or null if it isn't one.
  function detectInstruction(low) {
    if (/unreverse|reverse the|reversed/.test(low)) return 'reverse';
    if (/unscramble|unjumble|scramble|jumble/.test(low)) return 'unscramble';
    if (/\bsolve\b|math|calculate|equation/.test(low)) return 'math';
    if (/reveal|fill|missing/.test(low)) return 'fill';
    if (/\b(type|retype|repeat|copy)\b/.test(low)) return 'type';
    // Generic knowledge question ("first to answer the question wins"). Checked
    // last so a more specific game (math/unscramble/...) is preferred. The actual
    // question arrives on the NEXT line and is solved against the trivia table.
    if (/guess(?:\s+the)?\s+(?:random\s+)?number|guess\s+(?:a\s+)?(?:correct\s+)?number|correct\s+number/i.test(low)) return 'guess';
    if (/\bquestion\b|answer the|trivia|guess the/.test(low)) return 'trivia';
    return null;
  }

  // Unscramble a payload word (or multi-word payload like "adDe buTe olarC")
  // using the dictionary anagram map. Multi-word payloads are solved per-word
  // and re-emitted with the original whitespace preserved.
  function unscramblePayload(payload) {
    if (!payload) return null;
    // (0) Best signal: does the WHOLE phrase (ignoring spaces/case) match a known
    // Minecraft item name? This nails multi-word answers like "waxed oxidized cut
    // copper slab" exactly, and also resolves single-word anagram ties (slab vs
    // labs) when the item list has the right word.
    loadPhrases();
    const phrase = phraseMap.get(lettersKey(payload));
    if (phrase) return phrase;
    // Pick the best anagram for one scrambled word: prefer a real Minecraft word,
    // then any word that isn't just the scrambled input echoed back.
    const pickHit = (hits, word) =>
      hits.find((w) => w !== word && mcWordSet.has(w)) || hits.find((w) => w !== word) || hits[0];
    // (1) Per-word: solve each whitespace-separated chunk against the dictionary.
    const parts = payload.split(/\s+/).filter(Boolean);
    if (parts.length > 1) {
      const solved = parts.map((p) => {
        const word = p.toLowerCase().replace(/[^a-z]/g, '');
        if (word.length < 2) return p; // too short — keep as-is
        const hits = loadAnagrams().get(word.split('').sort().join(''));
        return hits ? pickHit(hits, word) : null;
      });
      // Need every chunk to solve — if any failed, fall through to single-word.
      if (solved.every((w) => w)) return solved.join(' ');
    }
    // (2) Fall back to treating the whole payload as one joined word.
    const word = payload.toLowerCase().replace(/[^a-z]/g, '');
    if (word.length < 2) return null;
    const hits = loadAnagrams().get(word.split('').sort().join(''));
    return (hits && pickHit(hits, word)) || null;
  }

  // Apply a known operation to the puzzle payload -> the answer to send.
  function applyGame(kind, payload) {
    switch (kind) {
      case 'reverse':    return payload.split('').reverse().join('');
      case 'unscramble': return unscramblePayload(payload);
      case 'math':       return evalMath(payload);
      case 'fill':       return solveFillBlank(payload);
      case 'type':       return payload;
      case 'trivia':     return solveTrivia(payload.toLowerCase());
      case 'guess': {
        const r = solveGuessNumber(payload);
        return r ? r.answer : null;
      }
      default:           return null;
    }
  }

  // Send an answer after a human-like random delay (once per puzzle).
  // The server wants Title Case — capitalize the first letter of each word.
  function toTitleCase(s) { return s.replace(/\b[a-z]/g, (c) => c.toUpperCase()); }
  // Only word-based answers need Title Case. Type/reverse/math/guess must be sent EXACTLY as-is.
  const TITLE_CASE_KINDS = new Set(['unscramble', 'fill', 'fill-blank', 'trivia']);
  function scheduleAnswer(answer, kind) {
    if (answer === null || answer === undefined || answer === '') return;
    const out = TITLE_CASE_KINDS.has(kind) ? toTitleCase(String(answer)) : String(answer);
    const delay = GAME_DELAY_MIN + Math.floor(Math.random() * (GAME_DELAY_MAX - GAME_DELAY_MIN + 1));
    ui.info(`Game: ${kind}`, `answering "${out}" in ${(delay / 1000).toFixed(1)}s`);
    setTimeout(() => {
      if (!gameMode || !bot || !bot.player) return;
      try { bot.chat(out); ui.ok('Answer sent', `${c.white}${out}`); } catch (_) {}
    }, delay);
  }

  // ---- Fill-in-the-gaps: "only the missing letters" support ----
  // Some servers want ONLY the letters that go in the blanks, not the whole word
  // — they print a note like "(make sure to only type the missing letters)".
  // When that's the rule we align the solved word to the mask and send just the
  // blank letters (e.g. mask "Books__l_" + word "bookshelf" -> "hef").

  // Letters that fill the blanks of `mask`, read off `word`, in order. Aligns
  // per whitespace-separated chunk; returns null if any chunk's lengths don't
  // line up, so we never send a mis-aligned guess.
  function fillMissing(mask, word) {
    if (!word) return null;
    const mParts = String(mask).toLowerCase().split(/\s+/).filter(Boolean);
    const wParts = String(word).toLowerCase().split(/\s+/).filter(Boolean);
    if (mParts.length !== wParts.length) return null;
    let out = '';
    for (let i = 0; i < mParts.length; i++) {
      const m = mParts[i].replace(/[^a-z_.*-]/g, '');
      const w = wParts[i].replace(/[^a-z]/g, '');
      if (m.length !== w.length) return null; // can't align this chunk
      for (let j = 0; j < m.length; j++) if (/[_.*-]/.test(m[j])) out += w[j];
    }
    return out || null;
  }

  // Decide what to actually send for a fill puzzle, honoring `missingOnly`.
  // Returns { send, full, missing } or null if unsolved.
  function resolveFill(token, missingOnly) {
    const full = solveFillBlank(token);
    if (!missingOnly) return full ? { send: full, full, missing: null } : null;
    // Need a word the SAME length as the mask so blanks line up 1:1. The normal
    // (variable-gap) solve usually already is; if not, retry with exact-one gaps.
    let aligned = full;
    let miss = fillMissing(token, aligned);
    if (!miss) { aligned = solveFillBlank(token, { exactOne: true }); miss = fillMissing(token, aligned); }
    if (miss) return { send: miss, full: aligned, missing: miss };
    return full ? { send: full, full, missing: null } : null; // can't align — send the full word
  }

  // Schedule a fill answer. We resolve full-word-vs-missing-letters at SEND time
  // (not now) so a "(type only the missing letters)" note that lands in the gap
  // between the puzzle line and our delayed answer is still honored this round.
  function scheduleFill(token) {
    const delay = GAME_DELAY_MIN + Math.floor(Math.random() * (GAME_DELAY_MAX - GAME_DELAY_MIN + 1));
    ui.info('Game: fill-blank', `solving "${token}" — sending in ${(delay / 1000).toFixed(1)}s`);
    setTimeout(() => {
      if (!gameMode || !bot || !bot.player) return;
      const r = resolveFill(token, FILL_MISSING_LETTERS_ONLY);
      if (!r || !r.send) { ui.warn('Fill unsolved', token); return; }
      const send = toTitleCase(r.send);
      const note = r.missing ? `${c.white}${send}${c.gray} (missing letters of ${r.full})` : `${c.white}${send}`;
      try { bot.chat(send); ui.ok('Answer sent', note); } catch (_) {}
    }, delay);
  }

  // Decide what (if anything) to answer for one incoming chat line.
  function maybeAnswerGame(msg) {
    if (!gameMode || !bot || !bot.player) return;
    const text = msg.replace(/[§&][0-9a-fk-or]/gi, '').trim();
    if (!text) return; // blank separator line
    const low = text.toLowerCase();

    // Sticky rule: some servers want ONLY the missing letters for fill games, and
    // print a note like "(type only the missing letters)". By default we IGNORE
    // that note and always send the full word (AUTO_MISSING_LETTERS = false) — the
    // full answer is what wins on this server. Flip AUTO_MISSING_LETTERS to true
    // (or set FILL_MISSING_LETTERS_ONLY) if you ever want the missing-letters mode.
    if (AUTO_MISSING_LETTERS && !fillMissingOnly &&
        /missing letter|only the (?:missing )?letters|just the (?:missing )?letters/.test(low)) {
      fillMissingOnly = true;
      ui.info('Fill mode', 'server wants only the missing letters');
    }

    // Parenthetical asides like "(make sure to only type the missing letters)"
    // are hints/notes, never the puzzle itself. Don't guess from them — and don't
    // clear any pending op, since a hint can sit between instruction and payload.
    if (/^\(.*\)$/.test(text)) return;

    // Server NOISE — periodic broadcasts that are NOT puzzles and must NOT end a
    // round: entity cleaners, tp/kill warnings, cooldowns. These often land in the
    // gap between the instruction and the puzzle line, so ignore the line but keep
    // any pending game ALIVE. (This is what used to eat the unscramble round:
    // "Entities will be cleared in 60 seconds!" matched "in N seconds" and wiped it.)
    if (/progress|please wait|please avoid|spam|cooldown|prohibited|cancell?ed|will be cleared|entities will|tpa? request|teleport request|be careful/i.test(low)) {
      return;
    }

    // Round-END / result lines — a winner, reward, or "nobody got it". These DO
    // end the round, so drop any pending op. Keyed off result WORDS (not a bare
    // "in N seconds") so an unrelated countdown isn't mistaken for a result.
    if (/\bcoins?\b|you (?:have )?(?:won|received)|\bgg\b|\bwinner\b|\bnobody\b|the word was|\bunreversed\b|\bunscrambled\b|\bunjumbled\b|answered correctly|correct answer|the answer was|ran out of time|time(?:'s| is) up|no one (?:got|answered)/i.test(low)) {
      // Learn trivia from this round if we couldn't answer.
      if (unseenTriviaQ) {
        // "the answer was X" — server reveals it directly.
        const directAns = low.match(/the answer was[:\s]+(.+)/i);
        if (directAns) {
          learnTrivia(unseenTriviaQ, directAns[1].replace(/\bin \d+.*$/i, '').trim());
          unseenTriviaQ = null;
        } else {
          // "X answered correctly" — look up X's most recent chat message as the answer.
          // Only the winner's message counts; wrong guesses from other players are ignored
          // because we only look up the specific winner by name.
          const winnerM = text.match(/([A-Za-z0-9_]{2,16})\s+(?:answered correctly|unscrambled|unreversed|unjumbled)/i);
          // "Nobody answered correctly in time!" falsely matches the pattern above with
          // winner="nobody". Guard against these common English words so we don't clear
          // unseenTriviaQ before the "The answer was: X" line arrives.
          const NOT_A_PLAYER = new Set(['nobody', 'no', 'someone', 'everyone', 'anyone']);
          if (winnerM && !NOT_A_PLAYER.has(winnerM[1].toLowerCase())) {
            const winner = winnerM[1].toLowerCase();
            const cutoff = Date.now() - PLAYER_MSG_TTL;
            for (let i = recentPlayerMsgs.length - 1; i >= 0; i--) {
              const m = recentPlayerMsgs[i];
              if (m.ts < cutoff) break;
              if (m.username === winner && m.text.length <= 60) {
                learnTrivia(unseenTriviaQ, m.text);
                unseenTriviaQ = null; // learned from winner — done
                break;
              }
            }
            // If we didn't find the winner's message, keep unseenTriviaQ alive so the
            // "The answer was: X" line that often follows can still teach the answer.
          }
          // No real winner (e.g. "Nobody answered in time") — keep unseenTriviaQ alive so the
          // "The answer was: X" line that follows can still teach us the correct answer.
        }
      }
      clearPending();
      return;
    }

    // (1) A game type was announced earlier — this line should be the puzzle
    //     payload. Only consume the pending op if the line actually LOOKS like a
    //     payload: letter games are a single word, math has a digit. A stray
    //     broadcast that slips past the filters above won't burn the round anymore.
    if (pendingGame) {
      // Drop leading bullets/markers — but DON'T eat a sign glued to a number:
      // "▶ -7 * 10 * -8" must keep its leading "-" (stripping it made 560 -> -560).
      // A dash/star/dot is a marker only when followed by whitespace; attached to a
      // digit (-7, .5) it's part of the expression.
      const payload = text.replace(/^(?:[\s▶►»➤→•·:]|[-*.](?=\s))+/, '').trim();
      // unscramble / reverse can span multiple words ("adDe buTe olarC") — strip
      // spaces before testing so a multi-word payload still counts as a payload.
      const tokenPayload = payload.replace(/\s+/g, '');
      // Reverse just flips the string, so its puzzle is often a random code with
      // DIGITS ("NKvkd0x3v") — accept alphanumerics, not letters-only. Unscramble
      // needs real words, so it stays letters-only.
      const looksLikePayload = pendingGame === 'reverse' ? /^[a-z0-9]{2,}$/i.test(tokenPayload)
        : pendingGame === 'unscramble' ? /^[a-z]{2,}$/i.test(tokenPayload)
        : pendingGame === 'math' ? /\d/.test(payload)
        : payload.length >= 2; // fill / type: accept any non-empty line
      if (looksLikePayload) {
        if (pendingGame === 'fill') {
          // Only consume the round if we can actually solve it; otherwise leave
          // the pending op armed for a later line. scheduleFill resolves the
          // full-word-vs-missing-letters choice at send time.
          if (solveFillBlank(payload)) { clearPending(); return scheduleFill(payload); }
        } else if (pendingGame === 'guess') {
          // Always consume the payload for guess games — never fall through to
          // the math solver (which would misread "1-15" as minus 14).
          clearPending();
          const range = payload.match(/(\d{1,3})\s*(?:[-–]|to|and)\s*(\d{1,3})/i);
          if (range) {
            const min = parseInt(range[1]), max = parseInt(range[2]);
            if (min >= 1 && max > min && max <= 10000) {
              return scheduleAnswer(String(min + Math.floor(Math.random() * (max - min + 1))), 'guess');
            }
          }
          return; // consume the line even if we couldn't parse it
        } else {
          const kind = pendingGame;
          clearPending();
          const ans = applyGame(kind, payload);
          if (ans) return scheduleAnswer(ans, kind);
          // Trivia we couldn't answer — remember the question to learn from.
          if (kind === 'trivia') {
            unseenTriviaQ = payload;
            ui.warn('Trivia unknown', `"${payload.slice(0, 60)}" — watching for the answer`);
          }
        }
        // couldn't solve — fall through and treat this line normally
      }
      // not a plausible payload — leave the pending op armed for the next line
    }

    // (2) Real game instruction ("The first to <op> ... wins!"). The puzzle
    //     arrives on the NEXT line, so arm the pending op and DON'T answer this
    //     line — otherwise "type the letters" wrongly answers "the". Checked
    //     before the self-contained solver so instruction words aren't grabbed.
    if (/first (?:to|person)/.test(low)) {
      const kind = detectInstruction(low);
      if (kind) { setPending(kind); return; }
    }

    // (3) Self-contained game on one line ("Solve: 5+3", "unscramble: tcouh", ...).
    const solved = solveGame(text);
    if (solved) {
      if (solved.kind === 'fill-blank' && solved.mask) return scheduleFill(solved.mask);
      return scheduleAnswer(solved.answer, solved.kind);
    }
  }

  // Handle a `!command` typed in the console. Never touches server chat.
  function handleCommand(raw) {
    const parts = raw.slice(1).trim().split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();
    const arg = parts.join(' ');
    const connected = bot && bot.entity;

    switch (cmd) {
      case 'help':
        drawBox('  ⌘  BOT COMMANDS', [
          ['!help', 'Show this command list'],
          ['!afk on|off', 'Toggle anti-AFK movement'],
          ['!games on|off', 'Auto-answer chat games'],
          ['!pos', 'Show current coordinates'],
          ['!health', 'Show health & hunger'],
          ['!players', 'List online players'],
          ['!sco', 'Show the server sidebar scoreboard'],
          ['!vault', 'Deposit keep-items to /pv 1, trash the rest now'],
          ['!autovault on|off', 'Toggle the 10-min auto-vault cycle'],
          ['!invtrade', `Run the ${TRADE_OWNER} trade flow now (test)`],
          ['!follow <name>', 'Follow a player'],
          ['!oneblock x y z', 'Mine a block on loop (tool-safe)'],
          ['!oneblock stop', 'Stop one-block mining'],
          ['!stop', 'Stop following / mining'],
          ['!quit', 'Disconnect and exit'],
        ], 'Handled locally — never sent to the server.  Bot auto-respawns on death.');
        break;

      case 'games':
      case 'game': {
        const mode = arg.toLowerCase();
        if (mode === 'on') {
          gameMode = true;
          loadAnagrams(); // warm the dictionary so the first answer isn't slow
          loadTrivia();   // warm the trivia table (+ custom-trivia.txt) too
          ui.ok('Auto-games ON', `answering chat games in ${GAME_DELAY_MIN / 1000}-${GAME_DELAY_MAX / 1000}s`);
        } else if (mode === 'off') {
          gameMode = false;
          ui.warn('Auto-games OFF', 'no longer answering chat games');
        } else {
          ui.err('Usage', 'type  !games on  or  !games off');
        }
        break;
      }

      case 'afk': {
        const mode = arg.toLowerCase();
        if (mode === 'on') {
          startAfk();
          ui.ok('Anti-AFK ON', `moving every ${AFK_INTERVAL / 1000}s`);
        } else if (mode === 'off') {
          stopAfk();
          ui.warn('Anti-AFK OFF', 'bot will sit still');
        } else {
          ui.err('Usage', 'type  !afk on  or  !afk off');
        }
        break;
      }

      case 'pos': {
        if (!connected) { console.log(notConnected); break; }
        const p = bot.entity.position;
        ui.info('Position', `x=${p.x.toFixed(1)}  y=${p.y.toFixed(1)}  z=${p.z.toFixed(1)}`);
        break;
      }

      case 'health':
        if (!connected) { console.log(notConnected); break; }
        ui.info('Health', `❤ ${(bot.health ?? 0).toFixed(0)}/20    🍗 ${(bot.food ?? 0).toFixed(0)}/20`);
        break;

      case 'players': {
        if (!connected) { console.log(notConnected); break; }
        const names = Object.keys(bot.players);
        ui.info(`Online (${names.length})`, names.join(', '));
        break;
      }

      case 'sco':
      case 'scoreboard': {
        if (!connected) { console.log(notConnected); break; }
        // The server's sidebar is the scoreboard shown in display slot 1.
        const sb = bot.scoreboard && bot.scoreboard.sidebar;
        if (!sb) { ui.warn('No scoreboard', 'the server is not showing a sidebar right now'); break; }
        // Each item's displayName is the visible line (team prefix/suffix applied);
        // items are already sorted by score so the order matches the in-game board.
        const lines = sb.items.map((it) => {
          let txt;
          try { txt = it.displayName ? it.displayName.toString() : it.name; }
          catch (_) { txt = it.name; }
          return String(txt || '').replace(/\s+$/, '');
        });
        let title;
        try { title = sb.title && sb.title.toString ? sb.title.toString() : String(sb.title || ''); }
        catch (_) { title = ''; }
        title = title.trim() || sb.name || 'Scoreboard';
        // Render a full-width framed box (drawBox is two-column, so do it inline).
        const bar = '─'.repeat(BOX_W);
        const fit = (s, w) => (s.length > w ? s.slice(0, w) : s.padEnd(w));
        console.log('');
        console.log(`  ${c.blue}╭${bar}╮${c.reset}`);
        console.log(`  ${c.blue}│${c.reset} ${c.bold}${c.magenta}${fit('📋 ' + title, BOX_W - 1)}${c.reset}${c.blue}│${c.reset}`);
        console.log(`  ${c.blue}├${bar}┤${c.reset}`);
        if (!lines.length) {
          console.log(`  ${c.blue}│${c.reset} ${c.gray}${fit('(empty)', BOX_W - 1)}${c.reset}${c.blue}│${c.reset}`);
        } else {
          for (const t of lines) console.log(`  ${c.blue}│${c.reset} ${c.white}${fit(t, BOX_W - 1)}${c.reset}${c.blue}│${c.reset}`);
        }
        console.log(`  ${c.blue}╰${bar}╯${c.reset}`);
        console.log('');
        break;
      }

      case 'vault':
      case 'pv': {
        if (!connected) { console.log(notConnected); break; }
        ui.info('Vault', 'running deposit + trash cycle now...');
        runVaultCycle(true);
        break;
      }

      case 'invtrade':
      case 'trade': {
        if (!connected) { console.log(notConnected); break; }
        ui.info('Trade', `running the ${TRADE_OWNER} trade flow now...`);
        runTradeFlow('manual');
        break;
      }

      case 'autovault': {
        const mode = arg.toLowerCase();
        if (mode === 'on') {
          vaultMode = true; startVaultTimer();
          ui.ok('Auto-vault ON', `every ${VAULT_INTERVAL / 60000}m: keep [${VAULT_KEEP.join(', ')}] → ${VAULT_PV_COMMAND}, trash the rest`);
        } else if (mode === 'off') {
          vaultMode = false; stopVaultTimer();
          ui.warn('Auto-vault OFF', 'no longer auto-depositing/trashing');
        } else {
          ui.err('Usage', 'type  !autovault on  or  !autovault off');
        }
        break;
      }

      case 'follow': {
        if (!connected) { console.log(notConnected); break; }
        if (!arg) { ui.err('Usage', 'type  !follow <player>'); break; }
        const target = bot.players[arg];
        if (!target || !target.entity) {
          ui.err(`Can't see "${arg}"`, 'they must be online and nearby');
          break;
        }
        following = arg;
        bot.pathfinder.setGoal(new goals.GoalFollow(target.entity, 2), true);
        ui.ok(`Following ${arg}`, 'type !stop to stop');
        break;
      }

      case 'oneblock':
      case 'mine': {
        if (!connected) { console.log(notConnected); break; }
        // "!oneblock stop" turns mining off.
        if (arg.toLowerCase() === 'stop' || arg.toLowerCase() === 'off') {
          if (mining) { stopMining(); ui.warn('One-block mining OFF', 'stopped'); }
          else ui.warn('Not mining', 'nothing to stop');
          break;
        }
        // Accept "x y z" or "x,y,z"; default to the block the bot is standing on.
        const nums = arg.split(/[\s,]+/).filter(Boolean).map(Number);
        let x, y, z;
        if (nums.length === 3 && nums.every((n) => !isNaN(n))) {
          [x, y, z] = nums.map(Math.floor);
        } else if (!arg) {
          const p = bot.entity.position;
          x = Math.floor(p.x); y = Math.floor(p.y) - 1; z = Math.floor(p.z);
        } else {
          ui.err('Usage', 'type  !oneblock <x y z>  or  !oneblock stop');
          break;
        }
        stopFollow();   // can't follow and mine at once
        stopMining();   // restart cleanly if already mining
        mining = { pos: new Vec3(x, y, z) };
        ui.ok('One-block mining ON', `target x=${x} y=${y} z=${z}  ·  !oneblock stop to stop`);
        mineLoop().catch((e) => ui.err('Mining stopped', e.message || String(e)));
        break;
      }

      case 'stop':
        if (mining) { stopMining(); ui.warn('Stopped mining'); }
        if (following) { stopFollow(); ui.warn('Stopped following'); }
        if (!mining && !following) { stopFollow(); stopMining(); ui.warn('Nothing to stop'); }
        break;

      case 'quit':
      case 'exit':
        ui.ok('Goodbye!', 'disconnecting...');
        stopAfk();
        try { bot.quit(); } catch (_) {}
        rl.close();
        process.exit(0);
        break;

      default:
        ui.err(`Unknown command  !${cmd}`, 'type !help to see all commands');
    }
  }

  function connect() {
    console.log(`\n  ${c.magenta}⟳ Connecting to ${c.white}${host}:${port}${c.magenta}...${c.reset}`);

    const opts = {
      host, port, username,
      auth: 'offline',  // Cracked/offline servers. For premium servers use 'microsoft'.
      hideErrors: true, // don't let mineflayer dump raw error stacks
      logErrors: false  // we show our own clean status messages instead
    };
    if (VERSION) opts.version = VERSION; // omit when false so mineflayer auto-detects

    bot = mineflayer.createBot(opts);
    bot.loadPlugin(pathfinder); // enables !follow

    let joined = false;   // becomes true once we actually spawn in
    let offline = false;  // set when the failure is just "server unreachable"
    let loggedIn = false; // becomes true once we've sent LOGIN_COMMAND
    let switched = false; // becomes true once we've sent SWITCH_COMMAND
    let switchFallback = null; // timer that switches anyway if no login prompt arrives
    let reswitchTimer = null;  // periodic "/server oneblock" so a restart bounce gets us back
    let lobbyReswitchAt = 0;   // debounce for restart-message-triggered re-switching
    let verifying = false;    // true while GUARD bot-check is in progress — freeze all activity
    let verifyTimer = null;

    // Send the server-switch command exactly once per connection, then keep a
    // periodic re-send going so a later sub-server restart (which bounces us to
    // the lobby) always lands us back on oneblock.
    function doSwitch() {
      if (verifying || switched || !bot || !bot.player) return;
      switched = true;
      if (switchFallback) { clearTimeout(switchFallback); switchFallback = null; }
      try { bot.chat(SWITCH_COMMAND); ui.ok('Server switch', SWITCH_COMMAND); } catch (_) {}
      scheduleReswitch();
    }

    // Re-send SWITCH_COMMAND every 5-10 min (random). On oneblock the server
    // just replies "already connected" (harmless); in the lobby it brings us
    // back after a restart.
    function scheduleReswitch() {
      if (reswitchTimer) clearTimeout(reswitchTimer);
      const delay = RESWITCH_MIN + Math.floor(Math.random() * (RESWITCH_MAX - RESWITCH_MIN + 1));
      reswitchTimer = setTimeout(() => {
        if (bot && bot.player) {
          try { bot.chat(SWITCH_COMMAND); ui.info('Re-join oneblock', `${SWITCH_COMMAND} (auto, every 5-10m)`); } catch (_) {}
        }
        scheduleReswitch(); // queue the next cycle
      }, delay);
    }

    // Send the login command once, then switch SWITCH_AFTER_LOGIN ms later.
    function doLogin() {
      if (verifying || loggedIn || !bot || !bot.player) return;
      loggedIn = true;
      try { bot.chat(LOGIN_COMMAND); ui.ok('Auto-login', `sent ${LOGIN_COMMAND}`); } catch (_) {}
      setTimeout(doSwitch, SWITCH_AFTER_LOGIN);
    }

    // Watchdog: if nothing happens within JOIN_TIMEOUT (auto-detect hang,
    // server stuck "starting", etc.) tear the socket down and retry cleanly.
    const watchdog = setTimeout(() => {
      if (joined) return;
      console.log(`  ${c.orange}●${c.reset} ${c.orange}${c.bold}Join timed out${c.reset} ${c.gray}— server didn't respond. Retrying...${c.reset}`);
      try { bot.end(); } catch (_) {}
    }, JOIN_TIMEOUT);

    bot.on('spawn', () => {
      joined = true;
      clearTimeout(watchdog);
      try { bot.pathfinder.setMovements(new Movements(bot)); } catch (_) {}
      ipcSetStatus('online');
      console.log(`\n  ${c.green}${c.bold}✅ JOINED THE SERVER${c.reset} ${c.gray}— ${c.white}${username}${c.gray} is now in ${c.white}${host}:${port}${c.gray}.${c.reset}`);
      console.log(`  ${c.gray}  Type a message to chat. Start with ${c.yellow}/${c.gray} for a server command, ${c.yellow}!${c.gray} for a bot command.${c.reset}`);
      console.log(`  ${c.gray}  Type ${c.yellow}!help${c.gray} for bot commands, ${c.yellow}quit${c.gray} or ${c.yellow}Ctrl+C${c.gray} to exit.${c.reset}\n`);

      // Switch to the target server within SWITCH_FALLBACK whether or not a
      // login prompt ever shows up (covers servers that don't require auth).
      if (AUTO_LOGIN) switchFallback = setTimeout(doSwitch, SWITCH_FALLBACK);
    });

    // Auto-respawn is on by default (createBot respawn option) — just log it cleanly.
    bot.on('death', () => {
      console.log(`  ${c.red}☠ Died${c.reset} ${c.gray}— respawning automatically...${c.reset}`);
    });

    // Show server chat
    bot.on('messagestr', (message) => {
      process.stdout.write(`\r  ${c.cyan}${c.bold}[CHAT]${c.reset} ${c.white}${message}${c.reset}\n`);
      ipcPushChat(message); // forward to Discord bridge
      // GUARD anti-bot verification — freeze all activity until it passes (20s max).
      if (/you are being verified|please do not move.*automatic/i.test(message)) {
        verifying = true;
        if (verifyTimer) clearTimeout(verifyTimer);
        verifyTimer = setTimeout(() => { verifying = false; verifyTimer = null; }, 20000);
        ui.warn('GUARD', 'bot-check in progress — frozen for up to 20s');
        return; // don't process this line any further
      }
      if (/verification.*(?:complete|passed|success)|you(?:'ve| have) passed/i.test(message) && verifying) {
        verifying = false;
        if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
        ui.ok('GUARD', 'verification passed — resuming');
      }
      if (verifying) return; // still verifying — drop everything
      // Auto-login: the server asks us to authenticate -> send LOGIN_COMMAND.
      if (AUTO_LOGIN && !loggedIn && LOGIN_PROMPT.test(message)) doLogin();
      // Restart / "sent to lobby" -> re-join oneblock fast (debounced 30s).
      if (AUTO_LOGIN && (LOBBY_PROMPT.test(message) || RESTART_COUNTDOWN.test(message))) {
        const now = Date.now();
        if (now - lobbyReswitchAt > 30000) {
          lobbyReswitchAt = now;
          ui.warn('Restart / lobby detected', `re-joining oneblock in ${LOBBY_RESWITCH_DELAY / 1000}s`);
          setTimeout(() => {
            if (bot && bot.player) { try { bot.chat(SWITCH_COMMAND); ui.ok('Re-join oneblock', SWITCH_COMMAND); } catch (_) {} }
          }, LOBBY_RESWITCH_DELAY);
        }
      }
      if (gameMode) maybeAnswerGame(message); // auto-answer chat games when !games is on
      // Record player chat for the self-learning trivia system.
      const pc = parsePlayerChat(message); if (pc) recordPlayerMsg(pc.username, pc.text);
      // Fallback whisper trigger for custom /msg formats (native 'whisper' covers vanilla).
      if (TRADE_ENABLED) { const w = parseWhisperLine(message); if (w) maybeTradeTrigger(w.sender, w.msg, 'messagestr'); }
    });

    // Native whisper event (vanilla "X whispers: .." and "[X -> me] .." formats).
    bot.on('whisper', (username, message) => maybeTradeTrigger(username, message, 'whisper-event'));

    bot.on('kicked', (reason) => console.log(`  ${c.orange}●${c.reset} ${c.orange}${c.bold}Kicked:${c.reset} ${c.white}${reason}${c.reset}`));

    // Connection-level problems just mean the server is offline / unreachable.
    bot.on('error', (err) => {
      if (OFFLINE_CODES.includes(err.code)) {
        offline = true; // handled in 'end' as a clean "offline" message
      } else {
        console.log(`  ${c.red}● Error:${c.reset} ${err.message}`);
      }
    });

    bot.on('end', () => {
      clearTimeout(watchdog);
      if (switchFallback) { clearTimeout(switchFallback); switchFallback = null; }
      if (reswitchTimer) { clearTimeout(reswitchTimer); reswitchTimer = null; }
      if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
      verifying = false;
      if (mining) mining = null; // stop the mine loop; the old bot is gone
      unseenTriviaQ = null;      // clear any pending learn-question on disconnect
      ipcSetStatus('offline');
      if (shuttingDown) return;  // scheduled daily shutdown — do NOT reconnect
      if (!joined) {
        if (offline) {
          console.log(`  ${c.orange}●${c.reset} ${c.orange}${c.bold}Server offline${c.reset} ${c.gray}— not reachable right now.${c.reset}`);
        } else {
          console.log(`  ${c.red}●${c.reset} ${c.red}${c.bold}Could not join.${c.reset}`);
        }
      } else {
        console.log(`  ${c.red}●${c.reset} ${c.red}${c.bold}Disconnected.${c.reset}`);
      }
      if (AUTO_RECONNECT) {
        console.log(`  ${c.gray}  Retrying in ${c.yellow}${RECONNECT_DELAY / 1000}s${c.gray}... (${c.yellow}Ctrl+C${c.gray} to stop)${c.reset}`);
        setTimeout(connect, RECONNECT_DELAY);
      } else {
        rl.close();
        process.exit(0);
      }
    });

    // 4) Send what you type (chat + commands) — attach the console listener once
    if (!listenerAttached) {
      listenerAttached = true;
      rl.on('line', (input) => {
        const text = input.trim();
        if (!text) return;

        // Local bot commands start with "!" — handled here, never sent to the server.
        if (text.startsWith('!')) { handleCommand(text); return; }

        // Bare "quit"/"exit" still exits (kept for convenience).
        if (text.toLowerCase() === 'quit' || text.toLowerCase() === 'exit') {
          console.log(`  ${c.yellow}Goodbye!${c.reset}`);
          stopAfk();
          try { bot.quit(); } catch (_) {}
          rl.close();
          process.exit(0);
        }

        // Everything else goes to the server: plain text = chat, "/" prefix = command.
        if (bot.player) bot.chat(text);
        else console.log(notConnected);
      });
      // Terminal disconnect (SSH drop, tmux detach) can error stdin. Swallow
      // it — the bot keeps running and answering games.
      process.stdin.on('error', () => {}).on('close', () => {});
    }
  }

  scheduleDailyShutdown();
  loadAnagrams(); // warm dictionaries at startup so first game answer is instant
  loadTrivia();
  ui.ok('Auto-games ON', `answering chat games in ${GAME_DELAY_MIN / 1000}-${GAME_DELAY_MAX / 1000}s (24/7)`);
  if (AUTO_VAULT) {
    startVaultTimer();
    ui.info('Auto-vault armed', `every ${VAULT_INTERVAL / 60000}m: keep [${VAULT_KEEP.join(', ')}] → ${VAULT_PV_COMMAND}, trash the rest`);
  }
  connect();
}

main().catch((err) => {
  console.error(`${c.red}Fatal: ${err.message}${c.reset}`);
  process.exit(1);
});
