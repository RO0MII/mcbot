const readline = require('readline');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

// ---- Settings ----
const DEFAULT_IP = 'localhost';   // Used when you just press Enter on the IP prompt
const DEFAULT_PORT = 25565;       // Default Minecraft port
const VERSION = '1.20.1';         // Fixed version = skip the auto-detect ping round-trip, so the FIRST join is fast. Set false to auto-detect.
const AUTO_RECONNECT = true;      // Keep retrying while the server boots (Aternos)
const RECONNECT_DELAY = 5000;     // ms between retries
const JOIN_TIMEOUT = 30000;       // ms to wait for a join before giving up and retrying (fixes hangs)
const AFK_INTERVAL = 8000;        // ms between anti-AFK actions when !afk is on

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

  const notConnected = `  ${c.yellow}Not connected yet — wait for "JOINED THE SERVER".${c.reset}`;

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

  // Handle a `!command` typed in the console. Never touches server chat.
  function handleCommand(raw) {
    const parts = raw.slice(1).trim().split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();
    const arg = parts.join(' ');
    const connected = bot && bot.entity;

    switch (cmd) {
      case 'help':
        console.log(`  ${c.magenta}${c.bold}Bot commands${c.reset} ${c.gray}(handled locally — not sent to the server):${c.reset}`);
        console.log(`  ${c.yellow}!help${c.reset}            ${c.gray}Show this list${c.reset}`);
        console.log(`  ${c.yellow}!afk on|off${c.reset}      ${c.gray}Toggle anti-AFK movement${c.reset}`);
        console.log(`  ${c.yellow}!pos${c.reset}             ${c.gray}Show current coordinates${c.reset}`);
        console.log(`  ${c.yellow}!health${c.reset}          ${c.gray}Show health & hunger${c.reset}`);
        console.log(`  ${c.yellow}!players${c.reset}         ${c.gray}List online players${c.reset}`);
        console.log(`  ${c.yellow}!follow <name>${c.reset}   ${c.gray}Follow a player${c.reset}`);
        console.log(`  ${c.yellow}!stop${c.reset}            ${c.gray}Stop following${c.reset}`);
        console.log(`  ${c.yellow}!quit${c.reset}            ${c.gray}Disconnect and exit${c.reset}`);
        break;

      case 'afk': {
        const mode = arg.toLowerCase();
        if (mode === 'on') {
          startAfk();
          console.log(`  ${c.green}● Anti-AFK ON${c.reset} ${c.gray}— moving every ${AFK_INTERVAL / 1000}s.${c.reset}`);
        } else if (mode === 'off') {
          stopAfk();
          console.log(`  ${c.yellow}● Anti-AFK OFF${c.reset}`);
        } else {
          console.log(`  ${c.red}Usage:${c.reset} ${c.yellow}!afk on${c.reset} ${c.gray}or${c.reset} ${c.yellow}!afk off${c.reset}`);
        }
        break;
      }

      case 'pos': {
        if (!connected) { console.log(notConnected); break; }
        const p = bot.entity.position;
        console.log(`  ${c.cyan}● Position:${c.reset} ${c.white}x=${p.x.toFixed(1)} y=${p.y.toFixed(1)} z=${p.z.toFixed(1)}${c.reset}`);
        break;
      }

      case 'health':
        if (!connected) { console.log(notConnected); break; }
        console.log(`  ${c.pink}● Health:${c.reset} ${c.white}${(bot.health ?? 0).toFixed(0)}/20${c.reset}   ${c.orange}Hunger:${c.reset} ${c.white}${(bot.food ?? 0).toFixed(0)}/20${c.reset}`);
        break;

      case 'players': {
        if (!connected) { console.log(notConnected); break; }
        const names = Object.keys(bot.players);
        console.log(`  ${c.blue}● Online (${names.length}):${c.reset} ${c.white}${names.join(', ')}${c.reset}`);
        break;
      }

      case 'follow': {
        if (!connected) { console.log(notConnected); break; }
        if (!arg) { console.log(`  ${c.red}Usage:${c.reset} ${c.yellow}!follow <player>${c.reset}`); break; }
        const target = bot.players[arg];
        if (!target || !target.entity) {
          console.log(`  ${c.red}● Can't see "${arg}".${c.reset} ${c.gray}They must be online and nearby.${c.reset}`);
          break;
        }
        following = arg;
        bot.pathfinder.setGoal(new goals.GoalFollow(target.entity, 2), true);
        console.log(`  ${c.green}● Following ${c.white}${arg}${c.reset}${c.gray}. Type ${c.yellow}!stop${c.gray} to stop.${c.reset}`);
        break;
      }

      case 'stop':
        stopFollow();
        console.log(`  ${c.yellow}● Stopped following.${c.reset}`);
        break;

      case 'quit':
      case 'exit':
        console.log(`  ${c.yellow}Goodbye!${c.reset}`);
        stopAfk();
        try { bot.quit(); } catch (_) {}
        rl.close();
        process.exit(0);
        break;

      default:
        console.log(`  ${c.red}● Unknown command:${c.reset} ${c.yellow}!${cmd}${c.reset} ${c.gray}— type ${c.yellow}!help${c.gray} for the list.${c.reset}`);
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
    });

    // Auto-respawn is on by default (createBot respawn option) — just log it cleanly.
    bot.on('death', () => {
      console.log(`  ${c.red}☠ Died${c.reset} ${c.gray}— respawning automatically...${c.reset}`);
    });

    // Show server chat
    bot.on('messagestr', (message) => {
      process.stdout.write(`\r  ${c.cyan}${c.bold}[CHAT]${c.reset} ${c.white}${message}${c.reset}\n`);
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
