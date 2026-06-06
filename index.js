const readline = require('readline');
const fs = require('fs');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

// ---- Settings ----
const DEFAULT_IP = 'play.bananasmp.net';   // Used when you just press Enter on the IP prompt
const DEFAULT_PORT = 25565;       // Default Minecraft port
const VERSION = '1.20.1';         // Fixed version = skip the auto-detect ping round-trip, so the FIRST join is fast. Set false to auto-detect.
const AUTO_RECONNECT = true;      // Keep retrying while the server boots (Aternos)
const RECONNECT_DELAY = 5000;     // ms between retries
const JOIN_TIMEOUT = 30000;       // ms to wait for a join before giving up and retrying (fixes hangs)
const AFK_INTERVAL = 8000;        // ms between anti-AFK actions when !afk is on
const TOOL_BREAK_BUFFER = 5;      // !oneblock won't use a tool with this many uses (or fewer) left — keeps it from breaking
const MINE_REACH = 4.5;           // blocks: how close the bot must be to dig the target
const GAME_DELAY_MIN = 6000;      // !games — min delay before auto-answering a chat game (ms)
const GAME_DELAY_MAX = 8000;      // !games — max delay before auto-answering a chat game (ms)
const WORDLIST_PATH = '/usr/share/dict/words'; // dictionary used to solve "unscramble" games

// ---- Auto login + server switch ----
const AUTO_LOGIN = true;                  // detect a login prompt in chat and log in automatically
const LOGIN_PASSWORD = 'romi321';         // password sent as "/login <password>"
const LOGIN_COMMAND = `/login ${LOGIN_PASSWORD}`;
const SWITCH_COMMAND = '/server oneblock';// command that moves us to the target sub-server
const SWITCH_AFTER_LOGIN = 4000;          // ms after logging in before switching servers
const SWITCH_FALLBACK = 8000;             // ms after joining to switch anyway (login prompt or not)
// Chat lines that mean "you must authenticate" — triggers LOGIN_COMMAND.
const LOGIN_PROMPT = /\b(login|loggin|log in|register|registro|authme|password)\b/i;

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

  // 3) Connect (with auto-reconnect while the server boots)
  let bot = null;
  let listenerAttached = false;

  // ---- Local bot commands (the `!` commands) ----
  // These are handled here in the console and are NEVER sent to server chat.
  let afkTimer = null;   // setInterval handle while anti-AFK is on
  let following = null;  // username we're currently following, or null
  let mining = null;     // { pos: Vec3 } while !oneblock is running, or null
  let gameMode = false;  // true while !games auto-answering is on

  const notConnected = `  ${c.orange}▲${c.reset} ${c.orange}${c.bold}Not connected${c.reset} ${c.gray}— wait for "JOINED THE SERVER".${c.reset}`;

  function stopAfk() {
    if (afkTimer) { clearInterval(afkTimer); afkTimer = null; }
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
    } catch (_) { /* no dictionary — unscramble/fill-blank just won't solve */ }
    return anagramMap;
  }

  // Fill-in-the-blank: turn a masked token like "app_e" or "c_t" into a regex
  // and find the dictionary word(s) that fit. Blanks may be _ . * or -.
  function solveFillBlank(token) {
    loadAnagrams();
    if (!wordList) return null;
    const masked = token.toLowerCase().replace(/[^a-z_.*-]/g, '');
    if (!/[_.*-]/.test(masked) || !/[a-z]/.test(masked)) return null; // needs a blank AND a letter
    const re = new RegExp('^' + masked.replace(/[_.*-]/g, '[a-z]') + '$');
    // Prefer the most common-ish (shortest then alphabetical is a decent proxy).
    const hits = wordList.filter((w) => w.length === masked.length && re.test(w));
    return hits.length ? hits[0] : null;
  }

  // Small built-in trivia table for the few question types a bot can answer offline.
  // Add your own "question substring": "answer" pairs here — first match wins.
  const TRIVIA = {
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
    'largest planet': 'Jupiter',
    'smallest planet': 'Mercury',
    'red planet': 'Mars',
    'closest planet to the sun': 'Mercury',
    'how many continents': '7',
    'how many days in a week': '7',
    'how many colors in a rainbow': '7',
    'chemical symbol for water': 'H2O',
    'chemical symbol for gold': 'Au',
    'fastest land animal': 'Cheetah',
    'largest ocean': 'Pacific',
    'tallest mountain': 'Mount Everest',
    'longest river': 'Nile',
  };
  function solveTrivia(low) {
    for (const q in TRIVIA) if (low.includes(q)) return TRIVIA[q];
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

  // Given a chat line, work out the answer to a game — or null if it's not one we solve.
  // Returns { answer, kind } so the console can label what it solved.
  function solveGame(msg) {
    // Strip Minecraft color codes (§a, &b, ...) so server-formatted game lines match.
    const text = msg.replace(/[§&][0-9a-fk-or]/gi, '').trim();
    const low = text.toLowerCase();

    // 1) Unscramble — "unscramble: ttacle" / "scramble the word ttacle" / "jumble"
    let m = low.match(/(?:unscramble|unjumble|scramble|jumble)[^a-z0-9]*(?:the word[:\s]*)?([a-z]{3,})/);
    if (m) {
      const key = m[1].split('').sort().join('');
      const hits = loadAnagrams().get(key);
      // Prefer an answer that isn't the scrambled token itself.
      const ans = hits && (hits.find((w) => w !== m[1]) || hits[0]);
      if (ans) return { answer: ans, kind: 'unscramble' };
    }

    // 2) Math — "solve 5 + 3", "what is 12 x 4", "first to answer 7*8".
    //    Only grab a run that actually has an operator BETWEEN two numbers, so a
    //    question number ("#3"), reward ("9 coins") or timer never gets mistaken
    //    for the sum. Among all candidates, the longest is the real equation.
    const mathExprs = text.match(/\d+(?:\.\d+)?(?:\s*[-+*x/]\s*\d+(?:\.\d+)?)+/gi);
    if (mathExprs) {
      const expr = mathExprs.sort((a, b) => b.length - a.length)[0];
      const ans = evalMath(expr);
      if (ans !== null) return { answer: ans, kind: 'math' };
    }

    // 3) Type-the-word / retype — "first to type 'PINEAPPLE' wins" / "type: HELLO"
    //    Also "retype this: <sentence>" / "repeat: <text>" / "copy this <text>".
    m = text.match(/(?:retype|repeat|copy)(?:\s+this)?[:\s]+(.+)/i);
    if (m && m[1].trim().length >= 2) return { answer: m[1].trim(), kind: 'retype' };
    m = text.match(/type[^'"a-z0-9]*['"]([^'"]{2,})['"]/i)
        || text.match(/type(?:\s+the\s+word)?[:\s]+([^\s.,!]{2,})/i);
    if (m) {
      // If the token has a hidden letter (e.g. "type c_t"), it's a fill-blank, not a literal.
      if (/[_.*-]/.test(m[1])) {
        const filled = solveFillBlank(m[1]);
        if (filled) return { answer: filled, kind: 'fill-blank' };
      }
      return { answer: m[1], kind: 'type' };
    }

    // 4) Fill-in-the-blank — a token with hidden letters like "app_e" or "c_t".
    m = text.match(/\b([a-z]*[_.*-][a-z_.*-]*)\b/i);
    if (m) {
      const ans = solveFillBlank(m[1]);
      if (ans) return { answer: ans, kind: 'fill-blank' };
    }

    // 5) Trivia — a small built-in table of common questions (offline-safe).
    const triv = solveTrivia(low);
    if (triv) return { answer: triv, kind: 'trivia' };

    return null;
  }

  // Schedule an answer to a detected game after a human-like random delay.
  function maybeAnswerGame(msg) {
    if (!gameMode || !bot || !bot.player) return;
    const solved = solveGame(msg);
    if (!solved) return;
    const delay = GAME_DELAY_MIN + Math.floor(Math.random() * (GAME_DELAY_MAX - GAME_DELAY_MIN + 1));
    ui.info(`Game: ${solved.kind}`, `answering "${solved.answer}" in ${(delay / 1000).toFixed(1)}s`);
    setTimeout(() => {
      if (!gameMode || !bot || !bot.player) return;
      try {
        bot.chat(solved.answer);
        ui.ok('Answer sent', `${c.white}${solved.answer}`);
      } catch (_) {}
    }, delay);
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

    // Send the server-switch command exactly once per connection.
    function doSwitch() {
      if (switched || !bot || !bot.player) return;
      switched = true;
      if (switchFallback) { clearTimeout(switchFallback); switchFallback = null; }
      try { bot.chat(SWITCH_COMMAND); ui.ok('Server switch', SWITCH_COMMAND); } catch (_) {}
    }

    // Send the login command once, then switch SWITCH_AFTER_LOGIN ms later.
    function doLogin() {
      if (loggedIn || !bot || !bot.player) return;
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
      // Auto-login: the server asks us to authenticate -> send LOGIN_COMMAND.
      if (AUTO_LOGIN && !loggedIn && LOGIN_PROMPT.test(message)) doLogin();
      if (gameMode) maybeAnswerGame(message); // auto-answer chat games when !games is on
    });

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
      if (mining) mining = null; // stop the mine loop; the old bot is gone
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
    }
  }

  connect();
}

main().catch((err) => {
  console.error(`${c.red}Fatal: ${err.message}${c.reset}`);
  process.exit(1);
});
