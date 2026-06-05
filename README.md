# 🤖 MCBot — Minecraft Console Bot

A lightweight, interactive **Minecraft bot** for **version 1.20.1**, built on [Mineflayer](https://github.com/PrismarineJS/mineflayer).
It connects to any server, shows live in-game chat right in your terminal, and lets you chat or run commands — all from a clean, colorful console.

```
  ███╗   ███╗ ██████╗██████╗  ██████╗ ████████╗
  ████╗ ████║██╔════╝██╔══██╗██╔═══██╗╚══██╔══╝
  ██╔████╔██║██║     ██████╔╝██║   ██║   ██║
  ██║╚██╔╝██║██║     ██╔══██╗██║   ██║   ██║
  ██║ ╚═╝ ██║╚██████╗██████╔╝╚██████╔╝   ██║
  ╚═╝     ╚═╝ ╚═════╝╚═════╝  ╚═════╝    ╚═╝
```

---

## ✨ Features

- **Interactive login** — prompts for player name and server IP at startup.
- **Live chat console** — see server chat in your terminal and type to chat back.
- **Run commands** — start a message with `/` to send a Minecraft command.
- **Auto-reconnect** — keeps retrying while the server boots (great for [Aternos](https://aternos.org/)).
- **Join watchdog** — gives up and retries cleanly if a join hangs (default 30s).
- **Fast first join** — version is pinned to `1.20.1` to skip the auto-detect ping.
- **Clean output** — network hiccups are shown as friendly status lines, not ugly stack traces.
- **Offline (cracked) servers** by default — switch to `microsoft` auth for premium servers.

---

## 📦 Requirements

- [Node.js](https://nodejs.org/) **v16+** (v18+ recommended)
- A Minecraft server running **1.20.1**

---

## 🚀 Installation

```bash
# Clone the repo
git clone https://github.com/RO0MII/mcbot.git
cd mcbot

# Install dependencies
npm install
```

---

## ▶️ Usage

```bash
npm start
# or
node index.js
```

You'll be asked for:

1. **Player name** — the username the bot joins with.
2. **Server IP** — `host` or `host:port`. Press **Enter** to use the default (`localhost:25565`).

Once connected:

| Action            | How                                              |
| ----------------- | ------------------------------------------------ |
| Send a chat message | Type text and press **Enter**                  |
| Run a command      | Start with `/` (e.g. `/gamemode creative`)      |
| Quit               | Type `quit` / `exit`, or press **Ctrl+C**       |

---

## ⚙️ Configuration

Edit the settings at the top of [`index.js`](index.js):

| Setting           | Default       | Description                                                        |
| ----------------- | ------------- | ----------------------------------------------------------------- |
| `DEFAULT_IP`      | `localhost`   | Used when you press Enter on the IP prompt.                        |
| `DEFAULT_PORT`    | `25565`       | Default Minecraft port.                                            |
| `VERSION`         | `1.20.1`      | Pinned version. Set to `false` to auto-detect the server version. |
| `AUTO_RECONNECT`  | `true`        | Keep retrying while the server boots.                             |
| `RECONNECT_DELAY` | `5000`        | Milliseconds between reconnect attempts.                           |
| `JOIN_TIMEOUT`    | `30000`       | Milliseconds to wait for a join before retrying.                  |

### Premium (Microsoft) accounts

By default the bot uses `auth: 'offline'` for cracked/offline servers.
For premium servers, open `index.js` and change the auth option inside `connect()`:

```js
auth: 'microsoft',
```

---

## 🛠️ Tech Stack

- [Node.js](https://nodejs.org/)
- [Mineflayer](https://github.com/PrismarineJS/mineflayer) `^4.20.1`

---

## 📄 License

MIT — free to use, modify, and share.
