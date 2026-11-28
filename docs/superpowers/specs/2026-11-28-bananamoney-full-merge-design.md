# BananaMoney → MCBot dashboard full merge

Date: 2026-11-28

## Intent and why

The user wants everything from the BananaMoney fleet panel and its automation
modules available inside the existing MCBot dashboard, not as a separate
product. The explicit instruction was “ඔක්කොම add කරන්න” and, when asked about
the conflicts, “Rules remove කර full port”. So this is a full behaviour port,
not a UI-only copy.

Today MCBot is a password-protected, proxy-routed, AFK-oriented fleet panel.
BananaMoney is an unauthenticated fleet panel plus a separate payout panel,
with direct connections, mining, bone collection, inventory cleaning, GUI
helpers, TPA killing, scripts/triggers/aliases, Discord bridges and payouts.
The job is to bring those capabilities into MCBot's single authenticated
dashboard without running a second competing control plane.

## Decisions already made with the partner

- **Full port chosen.** Approaches A (UI only) and B (UI + selective
  automation) were rejected by the user in favour of C.
- **Proxy is explicitly out of scope.** When asked, the user chose “proxy
  aththam thiyanna”: the existing proxy pool/routing stays exactly as it is,
  and no direct-connection mode or toggle is added. The earlier “rules remove”
  answer applies to the *gameplay* rules only.
- **The following old MCBot gameplay rules are deliberately overridden by the
  user**: `onna`-only outgoing `/tpa`, AFK-only/no-dig gameplay, and the ban on
  `/sethome`/`/home`/`/back` no longer constrain feature design.
- **Dashboard authentication is retained.** BananaMoney's unauthenticated HTTP
  surface is not reproduced.
- **Latest instruction:** find what the current panel cannot do that
  BananaMoney's panel can, and build those missing pieces into MCBot.
- **Latest reaffirmation:** no real-IP/VOS joins; proxy-only and strict
  `1 IP = 1 bot` remain non-negotiable.

## Builder-review resolutions

An independent reviewer raised eight questions. Resolutions:

1. **Restarts:** one atomic deploy at the end of implementation; no
   milestone-by-milestone service restarts. Builder call to avoid fleet
   downtime.
2. **Payer bot:** user chose one designated bot. Add `payoutBotId`; payouts
   use `/pay <username> <amount>` exactly as BananaMoney's code sends them.
   If the payer is offline, claims stay queued.
3. **Discord:** user chose to keep the existing `discord-bridge.js` process.
   New per-bot bridges and the payout Discord client are default-off and only
   start when a token is configured in the dashboard.
4. **Category:** reuse MCBot's existing many-to-many groups. No parallel
   single-string `category` field. Builder call to avoid two control planes.
5. **Auth mode:** the deploy field is stored/displayed only. Microsoft device
   login is not implemented because `_connect()` is untouched. Builder call.
6. **Script/trigger/alias allowlist:** chat text and in-game `/` commands are
   allowed, but dangerous meta commands (`!quit`, `!setlogin`, `!linkdc`,
   `!reload`) are blocked inside scripts/aliases. The panel console keeps its
   existing explicit command path. Builder call.
7. **Mining vs AFK:** enabling mining suspends that bot's AFK walker and
   restores it when mining stops. One movement owner per bot. Builder call.
8. **Payout password change:** dropped. There is no separate payout credential;
   the payout view uses the dashboard session. Builder call.

## Goals

1. One authenticated dashboard at the existing address contains all
   BananaMoney fleet-panel controls and all its bot automation modules.
2. Per-bot configuration, runtime state, logs and commands for every ported
   module are visible and editable from the new UI.
3. Existing MCBot features (login, switch, AFK, **proxy pool/routing**, TPA
   queue, inventory, scoreboard, groups, reconnect handling) keep working
   untouched; new features are additive and default-off unless enabled.
4. Payroll/payout and Discord features run inside the dashboard process and
   are protected by the same session as the rest of the panel.
5. Every ported behaviour has focused tests or a pure decision helper before
   it is wired into the live bot.

## Non-goals

- Running `bananamoney/index.js` as a child process alongside MCBot.
- Reusing BananaMoney's unauthenticated HTTP server, plaintext-secret files,
  or child-stdin newline command channel.
- Keeping two separate bot databases (`bots.json` in each project).
- Changing proxy pool code, proxy selection, connect gating or IP assignment.
- Adding a direct-connection mode.
- Automatically enabling mining/bones/TPA-kill/payout on the current 15 bots.

## Anti-goals (what would make this a failure)

- Taking the 15 current bots offline during the merge.
- Changing which proxy IP any bot uses as a side effect of this merge.
- Letting `TpKiller` and the trusted-player TPA flow fight over the same GUI.
- Letting scripts/triggers execute arbitrary JavaScript or shell commands.
- Losing dashboard auth or writing secrets to an unauthenticated endpoint.

## Constraints

- Existing stack stays: Node.js, CommonJS, `mineflayer`, one `http` server,
  SSE, `dashboard/data` JSON files, `node --test` tests.
- One bot = one `ManagedBot` instance inside the dashboard process.
- The current MCP/Discord integrations in BananaMoney use `discord.js`; the
  dashboard already has `discord-bridge.js`, so reuse the same dependency if
  present, otherwise isolate the Discord feature behind a config toggle.
- Connection stays exactly as it is today: proxy-only egress via the existing
  `proxy-pool.js` + `connect-gate.js`. No `connectionMode` field, no direct
  toggle, no changes to IP assignment.
- Automation defaults: every newly ported module starts `false` per bot. The
  user must enable it in the panel.

## Approaches considered

| Approach | What it means | Trade-off | Decision |
|---|---|---|---|
| A — UI only | Port grouping, toasts, dirty-save, richer inventory, terminal history, expose existing groups/TPA console. | Safest, but no automation parity. | Rejected by user. |
| B — A + selective automation | Add inventory cleaner and GUI helpers behind allowlists; keep old rules. | Medium risk, still not “okkoma”. | Rejected by user. |
| C — Full port | Port all modules, scripts, Discord and payout into MCBot; override the gameplay rules, leave proxy untouched. | Largest change and highest operational risk; matches the user's instruction. | **Chosen.** |

## Gap list — what MCBot's panel cannot do today

Derived from the BananaMoney `multibot.html` / `panel.html` inventory and the
live MCBot `app.js`. These are the exact things to add; proxy features are not
on this list.

1. Collapsible category groups with `running/total` counts and sorted bots.
2. Deploy/config fields for category (stored in existing `groupIds`), MC
   version (existing `version`), auth mode and bot webhook.
3. Dirty-state save bar on configuration forms.
4. Terminal command history/quick buttons: `!bones`, `!invclean`, `!stats`,
   `!reload`, `!gui`, `!click`, `!shift`, `!close`.
5. Live inventory grid with armour, offhand, backpack and hotbar rendering.
6. Bone collector config: spawner/chest coords, collect slot, cycle delay,
   profiles (`!profile`).
7. Inventory cleaner toggle (`!invclean`).
8. Mining automation (`!mine <block>`, radius, best-tool equip, sell/deposit).
9. TPA killer modes (`!tpkill main|send|off|status <player>`).
10. GUI manager commands (`!gui`, `!click`, `!shift`, `!close`, click-by-name).
11. Script manager and message triggers (interval + text trigger, enable/
    disable/delete/list).
12. Global aliases (`!alias list|add|delete|reload`).
13. Per-bot Discord bridge (channel per username, batched log mirror, `!`
    commands, plain chat relay).
14. Payout admin view: balance, per-user payout, claims table, direct pay,
    Discord claim button/modal (dashboard session only; no payout password).
15. SSE disruption toasts for kick/disconnect/death/crash.

MCBot already has: bot cards, console, inventory, scoreboard, proxy controls,
login/switch/AFK, reconnect/ban handling, groups in the backend, TPA queue,
and its own auto-eat. Those are not rebuilt.

## Architecture / implementation shape

### 1. Single process, per-bot module instances

Create small CommonJS modules under `dashboard/` mirroring BananaMoney's
modules, each with a pure decision/helper part plus a thin `ManagedBot` glue:

- `automation/inventory-cleaner.js` — `/pv 1`, shift-click non-bamboo, close.
- `automation/bone-collector.js` — spawner/chest coordinates, collect slot,
  cycle delay, sell slot, `/sell all`, profiles.
- `automation/mine-and-sell.js` — block lookup, tool selection, digging,
  `/sell all`, `/balance`, `/bank deposit`.
- `automation/tp-killer.js` — target, `main`/`send`/`off`/`status`, accept with
  `/tpaaccept <target>` (plain `/tpaccept` does nothing on this server), outgoing
  `/tpa <target>` interval, sword equip, attack loop.
- `automation/gui-manager.js` — show/click/shift-click/close/click-by-name.
- `automation/script-manager.js` — per-bot interval scripts and message
  triggers with an explicit action allowlist.
- `automation/alias-manager.js` — global aliases in `dashboard/data/aliases.json`.
- `automation/message-trigger.js` — `exact|contains|startsWith|regex`,
  `chat|system|all`, cooldown, `{message}`/`{player}` substitution.
- `automation/profile-manager.js` — named bone-collector coordinate profiles.

`ManagedBot` owns one instance of each module, starts/stops them on spawn/end,
and tears them down in `stop()`. Mining loads mineflayer's `digging` plugin
lazily when it is enabled, so `bot-options.js` and `_connect()` are untouched.

Panel `!` commands are handled on the explicit console/action path before a
message is sent as game chat. In-game player chat never triggers automation
commands.

### 2. Proxy stays untouched

All ported modules attach to the existing `ManagedBot` mineflayer client. They
do not create sockets, choose routes, or call `proxyPool.pick()`. No code in
`server.js` `_connect()`, `proxy-pool.js` or `connect-gate.js` changes as part
of this merge.

### 3. TPA coexistence

The existing trusted-player flow (`RO0MII` + `/tpaaccept RO0MII` + green-glass
Confirm GUI + strict `onna` queue) remains available. `TpKiller` is a separate
per-bot mode. A single bot may not have both active at once: enabling
`TpKiller` disables the trusted-player placement watcher for that bot, and vice
versa. This mutual exclusion is a builder call to prevent two GUI clickers
fighting.

### 4. Persistence and migration

- Extend `normalizeConfig()` and `ManagedBot.config()` with:
  `boneCollector`, `mineAndSell`, `inventoryCleaner`, `tpKiller`, `guiManager`,
  `scriptsEnabled`, plus their scalar fields (coords, slot, delay, target,
  block, radius). No connection field is added.
- Add top-level `data/aliases.json`, `data/payout.json` (including
  `payoutBotId`), and per-bot script files under `data/scripts/<botId>.json`,
  written atomically like `bots.json`.
- Load old `bots.json` records without the new fields and fill defaults; no
  destructive migration.

### 5. Discord and payout

- Leave the existing standalone `discord-bridge.js` process untouched.
- Port `DiscordBridge` as an optional per-bot integration (channel
  `banana-<username>`, batched log mirroring, `!` command routing, plain chat
  relay), default-off and only started when its token is configured.
- Port `PayoutBridge` + `PayoutStore` into a dashboard-owned Discord client,
  default-off. Add payout endpoints behind the existing session gate and a
  new `payout` dashboard view with balance, per-user payout, claims table,
  update and direct-pay controls. No separate listening port and no plaintext
  admin password file; reuse the dashboard session model.
- Payouts are sent by the bot selected in `payoutBotId` using
  `/pay <username> <amount>`. If that bot is offline, claims stay queued until
  it is online. A queued claim must be flushed when the payer returns, marked
  `paying` before send, and restored to `queued` (never deleted) on send
  failure; duplicate claims are rejected rather than paid twice.
- Discord tokens are stored in `data/payout.json`: `discord` for the payout bot
  and `perBotDiscord[botId]` for optional per-bot bridges. Both are masked in
  API responses. `dashboard/data/payout.json` is generated at runtime, not
  committed, because `dashboard/data/` is ignored.

### 6. UI/API

New nav items/views: `Automation`, `Scripts`, `Payout`. Bot page gains tabs:
`Terminal`, `Configuration`, `Live Inventory`, `Scripts & Actions`. Port from
BananaMoney's `multibot.html`: collapsible groups backed by MCBot's existing
groups with running counts, toasts, dirty-save bar, armor/offhand inventory
grid, terminal history and quick-action buttons (`!bones`, `!invclean`,
`!stats`, `!reload`, GUI helpers, script manager).

New/protected API routes: per-bot automation toggles/config, `POST
/api/bots/:id/automation`, `GET/POST /api/bots/:id/scripts`, `GET/PUT
/api/aliases`, payout read/update/pay/events, Discord link status. All go
through `isAuthed()`.

SSE adds `automation`, `script`, `payout` event types and delta patching in
`public/app.js`.

### 7. Verification

- Pure helpers and decisions tested with `node --test`.
- Integration smoke: dashboard starts, 15 existing bots remain online, every
  bot still has one assigned proxy IP and `collisions=0`, new modules off by
  default, auth gate blocks new endpoints.
- One atomic restart only, after all code and tests are ready.
- Manual panel check: enable one module on one bot at a time; verify logs,
  inventory, scripts, payout view, no duplicate GUI clickers.

## Risks

- Gameplay automation (dig/pathfind/PvP) increases ban and CPU load risk; this
  is accepted by the user's full-port choice but will be default-off.
- Proxy routing is unchanged, so no new IP-exposure risk is introduced.
- Full port is a project-sized chunk, not a single patch. Implementation will
  be split into an ordered plan, but deployed in one restart.

## What remains for the builder

Write the implementation plan (writing-plans), then execute in milestone
order: foundation/config + tests, UI shell, each automation module, Discord,
payout, final live verification. No further product decisions are expected
from the partner except approving this document.
