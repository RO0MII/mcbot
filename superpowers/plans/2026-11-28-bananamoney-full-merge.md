# BananaMoney Full Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add every missing BananaMoney panel capability and automation module into the existing MCBot dashboard without changing proxy routing or one-IP-one-bot assignment.

**Architecture:** Port BananaMoney's logic into small CommonJS modules under `dashboard/automation/`, each with pure decisions plus a thin `ManagedBot` glue. Keep one dashboard process, one mineflayer client per bot, and the existing authenticated API/SSE/JSON persistence. Payout and Discord become dashboard-owned optional features behind the same session. All testable helpers live in modules; `server.js` imports them and boots the service, so tests must never `require('../server')`.

**Tech Stack:** Node.js CommonJS, mineflayer 4.37.1, mineflayer-pathfinder (parent install), discord.js 14 (parent install), `node --test`, vanilla HTML/CSS/JS dashboard.

**Spec:** `/home/ubuntu/mcbot/docs/superpowers/specs/2026-11-28-bananamoney-full-merge-design.md`

## Global Constraints

- Proxy-only egress and strict `1 IP = 1 bot` are unchanged: no edits to `_connect()` in `server.js`, `proxy-pool.js`, `connect-gate.js`, or proxy assignment.
- No real-IP/VOS joins; no `connectionMode` or direct toggle.
- Dashboard auth (`isAuthed()`) covers every new API route and payout view. Use the design's route names under `/api/bots/:id/...`; do not invent unprotected aliases.
- New automation modules default to disabled per bot. Preserve the exact trusted TPA flow: `RO0MII`, `/tpaaccept RO0MII`, green-glass Confirm, `onna`-only queue.
- `!` automation commands are handled on the explicit panel console/action path before a chat message is sent. In-game player chat never triggers them.
- One atomic service restart at the end; no milestone restarts.
- Existing `discord-bridge.js` process stays running and untouched.
- Reuse MCBot groups via `groupIds`; category is never a second single-string field. `version` is the existing MC version field. `authMode` is stored/displayed only.
- Scripts/aliases allow chat text and in-game `/` commands but block `!quit`, `!setlogin`, `!linkdc`, `!reload`.
- Mining suspends that bot's AFK walker and restores it when mining stops. Mining loads mineflayer's `digging` plugin lazily; `bot-options.js` stays unchanged.
- `TpKiller` and the trusted-player TPA placement watcher are mutually exclusive per bot.
- Payouts use one bot selected by `payoutBotId` with `/pay <username> <amount>`.
- `dashboard/data/` is gitignored: `payout.json`, `aliases.json`, `profiles.json` and script files are generated at runtime, never committed.
- Test command: `node --test /home/ubuntu/mcbot/dashboard/test/*.test.js`.

## Review Focus

- **Reconnect while mining is on:** `_miningMovement` keeps `_checkArenaPosition()` from reconnecting; AFK walker resumes when mining stops. Test: `test/owner-sync.test.js`.
- **Payer bot offline:** queued claims survive, are flushed on payer return, and are marked `paying` before send so they cannot double-pay. Test: `test/payout-store.test.js`.
- **Dangerous script/alias action:** `!quit`, `!setlogin`, `!linkdc`, `!reload` rejected in scripts and aliases. Test: `test/automation-config.test.js`.
- **TpKiller and trusted TPA on one bot:** `syncTpaOwner()` clears trusted flags and `tpaQueueBots()` skips blocked bots. Test: `test/owner-sync.test.js`.
- **Proxy invariants after the atomic restart:** 15 bots online, 15 unique IPs, `collisions=0`. Test: final live verification in Task 13.
- **Unauthenticated access to new routes:** every new endpoint is behind `isAuthed()`. Test: `test/automation-api.test.js` plus final live check.

---

### Task 1: Automation config, allowlist, protection helper

**Files:**
- Create: `dashboard/automation/config.js`
- Create: `dashboard/automation/index.js`
- Modify: `dashboard/server.js` (import, `normalizeConfig`, `ManagedBot.config`, `ManagedBot.public`)
- Test: `dashboard/test/automation-config.test.js`

**Interfaces:**
- Consumes: existing `normalizeConfig()`, `ManagedBot.config()`, `ManagedBot.public()` in `server.js`.
- Produces from `automation/config.js`:
  - `AUTOMATION_DEFAULTS` — frozen object using the design's canonical keys:
    `boneCollector`, `mineAndSell`, `inventoryCleaner`, `tpKiller`, `guiManager`,
    `scriptsEnabled` all `false`; `boneSpawner: null`, `boneChest: null`,
    `boneSlot: 13`, `boneDelayMs: 30000`, `mineBlock: 'stone'`,
    `mineRadius: 12`, `tpKillTarget: ''`, `tpKillMode: 'off'`,
    `authMode: 'offline'`, `botWebhook: ''`.
  - `normalizeAutomation(raw)` — fully populated, clamped config. Category stays
    in existing `groupIds`; MC version stays in existing `version`.
  - `automationPublic(cfg)` — UI-safe copy.
  - `normalizeAutomationPatch(body)` — `{ ok, patch, error }`.
  - `isAllowedScriptAction(text)` — boolean; rejects the four dangerous meta commands.
  - `isProtectedAutomationRoute(pathname)` — true for
    `/api/bots/:id/(automation|scripts|discord)` and
    `/api/(aliases|payout|discord)` families.
- `automation/index.js` re-exports `config.js` only.

Clamps: `boneSlot` 0–53, `boneDelayMs` 1000–300000, `mineRadius` 1–64,
`mineBlock` string default `'stone'`, coords `{x,y,z}` finite numbers or `null`,
`tpKillMode` one of `off|main|send|status`, `authMode` one of
`offline|microsoft` (display only).

- [ ] **Step 1: Write the failing test**

```js
test('normalizeAutomation fills defaults and clamps values', () => {
  const c = normalizeAutomation({
    boneSlot: 99, boneDelayMs: 1, mineRadius: 999, tpKillMode: 'nonsense',
  });
  assert.equal(c.boneCollector, false);
  assert.equal(c.boneSlot, 53);
  assert.equal(c.boneDelayMs, 1000);
  assert.equal(c.mineRadius, 64);
  assert.equal(c.mineBlock, 'stone');
  assert.equal(c.tpKillMode, 'off');
});

test('isAllowedScriptAction blocks dangerous meta commands', () => {
  for (const s of ['!quit', '!setlogin x', '!linkdc', '!reload']) {
    assert.equal(isAllowedScriptAction(s), false, s);
  }
  assert.equal(isAllowedScriptAction('Hi'), true);
  assert.equal(isAllowedScriptAction('/balance'), true);
  assert.equal(isAllowedScriptAction('!bones'), true);
});

test('isProtectedAutomationRoute covers every new API family', () => {
  for (const p of [
    '/api/bots/b_1/automation', '/api/bots/b_1/scripts',
    '/api/bots/b_1/discord', '/api/aliases', '/api/payout', '/api/discord',
  ]) assert.equal(isProtectedAutomationRoute(p), true, p);
  assert.equal(isProtectedAutomationRoute('/api/health'), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test /home/ubuntu/mcbot/dashboard/test/automation-config.test.js`
Expected: FAIL with module/export missing.

- [ ] **Step 3: Implement `config.js` and wire persistence**

Create the module with the exact exports above. In `server.js`, call
`normalizeAutomation(raw.automation)` and the canonical top-level fields inside
`normalizeConfig()`, fill defaults for old `bots.json` records, return them from
`ManagedBot.config()` under `automation`, and include
`automationPublic(this._automation)` in `public()`. No connection field is added.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test /home/ubuntu/mcbot/dashboard/test/automation-config.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/mcbot && git add dashboard/automation dashboard/test/automation-config.test.js dashboard/server.js && git commit -m "feat: automation config foundation"
```

---

### Task 2: Inventory cleaner module

**Files:**
- Create: `dashboard/automation/inventory-cleaner.js`
- Test: `dashboard/test/inventory-cleaner.test.js`

**Interfaces:**
- Consumes: `AUTOMATION_DEFAULTS.inventoryCleaner` from Task 1.
- Produces:
  - `shouldVaultItem(item)` — true when item is not bamboo/empty.
  - `nextCleanStep(state)` — `state = { windowOpen, slots, attemptedAt, now }`; returns `'open' | 'shift' | 'close' | 'wait'`.
  - `class InventoryCleaner` — `start(bot, cfg)`, `stop()`, `onWindowOpen(window)`, `tick(now)`.

- [ ] **Step 1: Write the failing test**

```js
test('shouldVaultItem keeps bamboo and vaults everything else', () => {
  assert.equal(shouldVaultItem({ name: 'bamboo' }), false);
  assert.equal(shouldVaultItem({ name: 'dirt' }), true);
  assert.equal(shouldVaultItem(null), false);
});

test('nextCleanStep opens, shifts, then closes', () => {
  assert.equal(nextCleanStep({ windowOpen: false, slots: [], attemptedAt: 0, now: 1000 }), 'open');
  assert.equal(nextCleanStep({ windowOpen: true, slots: [{ name: 'dirt' }], attemptedAt: 0, now: 2000 }), 'shift');
  assert.equal(nextCleanStep({ windowOpen: true, slots: [], attemptedAt: 2000, now: 3000 }), 'close');
  assert.equal(nextCleanStep({ windowOpen: false, slots: [], attemptedAt: 3000, now: 4000 }), 'wait');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test /home/ubuntu/mcbot/dashboard/test/inventory-cleaner.test.js`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement the module**

Use `/pv 1` to open, shift-click vaultable slots, then close. `start()` twice is
safe; `stop()` clears its interval. It only acts when it is the bot's current
GUI owner.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test /home/ubuntu/mcbot/dashboard/test/inventory-cleaner.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/mcbot && git add dashboard/automation/inventory-cleaner.js dashboard/test/inventory-cleaner.test.js && git commit -m "feat: inventory cleaner module"
```

---

### Task 3: Bone collector and coordinate profiles

**Files:**
- Create: `dashboard/automation/bone-collector.js`
- Create: `dashboard/automation/profile-manager.js`
- Test: `dashboard/test/bone-collector.test.js`
- Test: `dashboard/test/profile-manager.test.js`

**Interfaces:**
- Consumes: `normalizeAutomation()` from Task 1.
- Produces:
  - `nextBoneStep(state)` — returns `'walk-spawner' | 'activate' | 'click-loot' | 'sell' | 'walk-chest' | 'deposit' | 'chat-sell' | 'stop' | 'wait'`.
  - `class ProfileManager` — `list()`, `save(name, coords)`, `load(name)`, `delete(name)`; runtime file `dashboard/data/profiles.json`.
  - `class BoneCollector` — `start(bot, cfg, profiles)`, `stop()`, `setCoords(kind, coords)`, `tick(now)`.

- [ ] **Step 1: Write the failing tests**

```js
test('nextBoneStep follows spawner, loot, sell, chest, deposit, chat', () => {
  assert.equal(nextBoneStep({ atSpawner: false }), 'walk-spawner');
  assert.equal(nextBoneStep({ atSpawner: true, guiOpen: false }), 'activate');
  assert.equal(nextBoneStep({ atSpawner: true, guiOpen: true, bonesInSlot: true }), 'click-loot');
  assert.equal(nextBoneStep({ atSpawner: true, guiOpen: true, bonesInSlot: false, sold: false }), 'sell');
  assert.equal(nextBoneStep({ atChest: false, sold: true }), 'walk-chest');
  assert.equal(nextBoneStep({ atChest: true, deposited: false }), 'deposit');
  assert.equal(nextBoneStep({ atChest: true, deposited: true }), 'chat-sell');
  assert.equal(nextBoneStep({ failStreak: 3 }), 'stop');
});

test('ProfileManager saves and reloads named coordinates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-profile-'));
  const pm = new ProfileManager(path.join(dir, 'profiles.json'));
  pm.save('main', { x: 1, y: 2, z: 3 });
  assert.deepEqual(pm.load('main'), { x: 1, y: 2, z: 3 });
  assert.deepEqual(pm.list(), ['main']);
  pm.delete('main');
  assert.equal(pm.load('main'), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test /home/ubuntu/mcbot/dashboard/test/bone-collector.test.js /home/ubuntu/mcbot/dashboard/test/profile-manager.test.js`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement both modules**

Port the BananaMoney sequence from `src/modules/BoneCollector.js` using
MCBot's `sendChat()` and existing GUI click helper. No
`bot.setMovements({ canDig: true })` call here; movement owner stays explicit
in Task 7.

- [ ] **Step 4: Run to verify it passes**

Run: same two test files. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/mcbot && git add dashboard/automation/bone-collector.js dashboard/automation/profile-manager.js dashboard/test/bone-collector.test.js dashboard/test/profile-manager.test.js && git commit -m "feat: bone collector and profiles"
```

---

### Task 4: Mine and sell with AFK movement ownership

**Files:**
- Create: `dashboard/automation/mine-and-sell.js`
- Test: `dashboard/test/mine-and-sell.test.js`

**Interfaces:**
- Consumes: `normalizeAutomation()` from Task 1; injected `loadDiggingPlugin()` from Task 7.
- Produces:
  - `chooseTool(inventory, block)` — returns best slot index or `null`; `block.digTime(item)` returns milliseconds.
  - `parseBalance(text)` — number or `null`.
  - `nextMineStep(state)` — `'find' | 'path' | 'dig' | 'sell' | 'deposit' | 'wait'`.
  - `resolveMovementOwner(state)` — `'afk' | 'mining'`; state `{ miningEnabled, afkActive }`.
  - `class MineAndSell` — `start(bot, cfg, hooks)`, `stop()`, `onMessage(text)`, `tick(now)`.

- [ ] **Step 1: Write the failing test**

```js
test('chooseTool picks the fastest tool against the target block', () => {
  const block = { digTime: (item) => (item.name === 'diamond_pickaxe' ? 1 : 4) };
  const inv = [{ name: 'wooden_pickaxe' }, { name: 'diamond_pickaxe' }];
  assert.equal(chooseTool(inv, block), 1);
  assert.equal(chooseTool([], block), null);
});

test('parseBalance reads balance chat only', () => {
  assert.equal(parseBalance('Balance: 12,500'), 12500);
  assert.equal(parseBalance('RO0MII: balance 100'), null);
});

test('resolveMovementOwner gives mining priority and restores AFK', () => {
  assert.equal(resolveMovementOwner({ miningEnabled: false, afkActive: true }), 'afk');
  assert.equal(resolveMovementOwner({ miningEnabled: true, afkActive: true }), 'mining');
  assert.equal(resolveMovementOwner({ miningEnabled: false, afkActive: false }), 'afk');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test /home/ubuntu/mcbot/dashboard/test/mine-and-sell.test.js`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement the module**

Port the mining loop and `/sell all`, `/balance`, `/bank deposit` parsing from
`src/modules/MineAndSell.js`. `start()` calls the injected
`loadDiggingPlugin(bot)` once (loading `mineflayer/lib/plugins/digging` if the
plugin is absent) and the AFK-suspend hook; `stop()` calls the restore hook.
No `bot-options.js` or `_connect()` edit is allowed. Movement owner is always
single-valued.

- [ ] **Step 4: Run to verify it passes**

Run: same test file. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/mcbot && git add dashboard/automation/mine-and-sell.js dashboard/test/mine-and-sell.test.js && git commit -m "feat: mine and sell module"
```

---

### Task 5: TPA killer, GUI manager, and TPA ownership

**Files:**
- Create: `dashboard/automation/tp-killer.js`
- Create: `dashboard/automation/gui-manager.js`
- Test: `dashboard/test/tp-killer.test.js`
- Test: `dashboard/test/gui-manager.test.js`

**Interfaces:**
- Consumes: `normalizeAutomation()` from Task 1.
- Produces:
  - `parseTpKillCommand(text)` — `{ mode, target } | null`; modes `main|send|off|status`.
  - `isTpRequestFor(text, target)` — boolean.
  - `shouldAttack(distance)` — boolean (`distance <= 3.5`).
  - `resolveTpaOwner(state)` — `'trusted' | 'killer' | 'none'`; state `{ trustedEnabled, killerEnabled }`.
  - `parseGuiCommand(text)` — `{ action, slot, name } | null`.
  - `findConfirmSlot(window, label)` — slot index or `null`.
  - `class TpKiller`, `class GuiManager` — `start/stop` and event handlers.

- [ ] **Step 1: Write the failing tests**

```js
test('parseTpKillCommand accepts the documented modes', () => {
  assert.deepEqual(parseTpKillCommand('!tpkill main RO0MII'), { mode: 'main', target: 'RO0MII' });
  assert.deepEqual(parseTpKillCommand('!tpkill status RO0MII'), { mode: 'status', target: 'RO0MII' });
  assert.deepEqual(parseTpKillCommand('!tpkill off'), { mode: 'off', target: '' });
  assert.equal(parseTpKillCommand('!tpkill nonsense RO0MII'), null);
});

test('resolveTpaOwner allows only one TPA controller', () => {
  assert.equal(resolveTpaOwner({ trustedEnabled: true, killerEnabled: false }), 'trusted');
  assert.equal(resolveTpaOwner({ trustedEnabled: false, killerEnabled: true }), 'killer');
  assert.equal(resolveTpaOwner({ trustedEnabled: false, killerEnabled: false }), 'none');
});

test('shouldAttack uses 3.5 block reach', () => {
  assert.equal(shouldAttack(3.4), true);
  assert.equal(shouldAttack(3.6), false);
});

test('parseGuiCommand handles the quick buttons', () => {
  assert.deepEqual(parseGuiCommand('!click 15'), { action: 'click', slot: 15, name: null });
  assert.deepEqual(parseGuiCommand('!close'), { action: 'close', slot: null, name: null });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test /home/ubuntu/mcbot/dashboard/test/tp-killer.test.js /home/ubuntu/mcbot/dashboard/test/gui-manager.test.js`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement both modules**

Port `src/modules/TpKiller.js` and `src/modules/GuiManager.js`, but replace the
source's plain `/tpaccept` with `/tpaaccept <target>`: this server ignores the
plain command. Outgoing `/tpa <target>` stays. Trusted `RO0MII` handling in
`server.js` is not changed. `resolveTpaOwner()` is consumed by Task 7 so the
two clickers can never be active together.

- [ ] **Step 4: Run to verify it passes**

Run: same two test files. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/mcbot && git add dashboard/automation/tp-killer.js dashboard/automation/gui-manager.js dashboard/test/tp-killer.test.js dashboard/test/gui-manager.test.js && git commit -m "feat: tpa killer and gui manager"
```

---

### Task 6: Scripts, message triggers, aliases

**Files:**
- Create: `dashboard/automation/message-trigger.js`
- Create: `dashboard/automation/script-manager.js`
- Create: `dashboard/automation/alias-manager.js`
- Test: `dashboard/test/automation-scripts.test.js`

**Interfaces:**
- Consumes: `isAllowedScriptAction()` from Task 1.
- Produces:
  - `matchTrigger(trigger, message, source)` — trigger shape matches source: `{ matchType, pattern, ignoreCase, source }`; source is `'chat' | 'system' | 'all'`.
  - `makeIntervalScript(body)` — `{ id, name, type: 'interval', interval, action: { type, value }, enabled, cooldown, lastRunAt }`.
  - `makeTriggerScript(body)` — `{ id, name, type: 'message-trigger', trigger, action, enabled, cooldown, lastTriggered }`.
  - `shouldRunScript(script, message, source, now)` — boolean respecting cooldown.
  - `resolveAlias(input, aliases)` — keys include the leading `!` exactly as BananaMoney's `config/aliases.json`.
  - `class ScriptManager` — `register/list/enable/disable/delete/destroy`, runtime file `dashboard/data/scripts/<botId>.json`.
  - `class AliasManager` — `list/add/delete/reload`, runtime file `dashboard/data/aliases.json`.

- [ ] **Step 1: Write the failing test**

```js
test('matchTrigger supports exact, contains, regex and source filtering', () => {
  assert.equal(matchTrigger({ matchType: 'exact', pattern: 'onna', source: 'chat' }, 'onna', 'chat'), true);
  assert.equal(matchTrigger({ matchType: 'contains', pattern: 'sell', source: 'all' }, '/sell all', 'chat'), true);
  assert.equal(matchTrigger({ matchType: 'regex', pattern: '^/pay \\d+$', source: 'system' }, '/pay 10', 'system'), true);
  assert.equal(matchTrigger({ matchType: 'exact', pattern: 'onna', source: 'system' }, 'onna', 'chat'), false);
});

test('script factories reject dangerous actions', () => {
  const bad = { action: { type: 'command', value: '!quit' } };
  assert.equal(makeIntervalScript({ interval: 5000, ...bad }), null);
  assert.equal(makeTriggerScript({ trigger: { pattern: 'sell' }, ...bad }), null);
  const s = makeIntervalScript({ interval: 5000, action: { type: 'command', value: '/balance' } });
  assert.equal(s.enabled, true);
  assert.equal(s.interval, 5000);
});

test('shouldRunScript respects cooldown', () => {
  const s = { cooldown: 1000, lastTriggered: 500 };
  assert.equal(shouldRunScript(s, '', 'chat', 1000), false);
  assert.equal(shouldRunScript(s, '', 'chat', 1600), true);
});

test('resolveAlias expands only safe aliases and preserves arguments', () => {
  const aliases = { '!c': '/balance' };
  assert.equal(resolveAlias('!c', aliases), '/balance');
  assert.equal(resolveAlias('!c 5', aliases), '/balance 5');
  assert.equal(resolveAlias('!quit', { '!quit': '!quit' }), '!quit');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test /home/ubuntu/mcbot/dashboard/test/automation-scripts.test.js`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement the three modules**

Port `src/utils/MessageTrigger.js`, `ScriptManager.js`, `AliasManager.js` with
the shapes above. Every `action.value` and alias target is passed through
`isAllowedScriptAction()` before execution. Files are written atomically via
`.tmp` + rename and are created only at runtime.

- [ ] **Step 4: Run to verify it passes**

Run: same test file. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/mcbot && git add dashboard/automation dashboard/test/automation-scripts.test.js && git commit -m "feat: scripts triggers and aliases"
```

---

### Task 7: Command router, movement/TPA owners, ManagedBot glue

**Files:**
- Create: `dashboard/automation/command-router.js`
- Create: `dashboard/automation/owner-sync.js`
- Modify: `dashboard/server.js` (constructor, spawn/end/stop, `_onWindowOpen`, chat API action)
- Test: `dashboard/test/command-router.test.js`
- Test: `dashboard/test/owner-sync.test.js`

**Interfaces:**
- Consumes: all module classes from Tasks 2–6 and `resolveTpaOwner()` from Task 5.
- Produces from `command-router.js`:
  - `routeAutomationCommand(text, state)` — `{ handled, action, payload }`. Must
    dispatch `!bones`, `!invclean`, `!stats`, `!reload`, `!gui`, `!click`,
    `!shift`, `!close`, `!profile`, `!mine`, `!tpkill`, `!repeat`, `!trigger`,
    `!alias`.
  - `routePanelCommand(text, state)` — same shape; used only by the panel chat
    route before `bot.sendChat()`. It must not be called from `_onMessage()`.
- Produces from `owner-sync.js`:
  - `syncMovementOwner(bot, owner)` — `'afk' | 'mining'`.
  - `syncTpaOwner(bot, owner)` — `'trusted' | 'killer' | 'none'`.
  - `loadDiggingPlugin(bot)` — loads `mineflayer/lib/plugins/digging` once when absent.

- [ ] **Step 1: Write the failing tests**

```js
test('routeAutomationCommand dispatches quick actions', () => {
  assert.deepEqual(routeAutomationCommand('!invclean on', {}), { handled: true, action: 'invclean-on', payload: {} });
  assert.deepEqual(routeAutomationCommand('!profile save main', {}), { handled: true, action: 'profile-save', payload: { name: 'main' } });
  assert.deepEqual(routeAutomationCommand('hello', {}), { handled: false, action: null, payload: {} });
});

test('syncMovementOwner suspends AFK and restores it after mining', () => {
  const bot = { _afkWalkActive: true, _afkWalkPaused: false, _miningMovement: false, _atLearnedArena: () => true, _stayAtLearnedArena() { this.restored = true; } };
  syncMovementOwner(bot, 'mining');
  assert.equal(bot._miningMovement, true);
  assert.equal(bot._afkWalkPaused, true);
  syncMovementOwner(bot, 'afk');
  assert.equal(bot._miningMovement, false);
  assert.equal(bot.restored, true);
});

test('syncTpaOwner blocks the trusted watcher for a killer bot', () => {
  const bot = { _tpaClickUntil: 123, _tpaPlacePending: true, _tpaPlaceTimer: {}, _tpaQueueBlocked: false, _awaitingTpaRestore: true };
  syncTpaOwner(bot, 'killer');
  assert.equal(bot._tpaQueueBlocked, true);
  assert.equal(bot._tpaClickUntil, 0);
  assert.equal(bot._tpaPlacePending, false);
  assert.equal(bot._tpaPlaceTimer, null);
  assert.equal(bot._awaitingTpaRestore, false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test /home/ubuntu/mcbot/dashboard/test/command-router.test.js /home/ubuntu/mcbot/dashboard/test/owner-sync.test.js`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement helpers and glue**

`syncMovementOwner(bot, 'mining')` cancels the pending AFK sequence, sets
`_miningMovement = true` and `_afkWalkPaused = true`; `_checkArenaPosition()`
must return early while `_miningMovement` is true. `'afk'` clears those flags,
then calls `_stayAtLearnedArena()` when `_atLearnedArena()` is true, otherwise
`_scheduleAutoAfk()`. No `_connect()` edit.

`syncTpaOwner(bot, 'killer')` clears `_tpaClickUntil`, `_tpaPlaceTimer`,
`_tpaPlacePending`, `_tpaPlaceIsRestore`, `_awaitingTpaRestore`, the restore
timer, and sets `_tpaQueueBlocked = true`. `'trusted'` clears the block only
when killer mode is off; `'none'` keeps it blocked. `tpaQueueBots()` and
`runTpaQueueStep()` must include `!b._tpaQueueBlocked` in their filter.

In `server.js`, create one lazy module instance per bot from `this._automation`.
Start enabled modules on spawn, stop all on `end`/`stop()`, and forward
`_onWindowOpen` only to the current GUI owner. Change the panel chat action to
call `routePanelCommand()` first and skip `bot.sendChat()` when handled; leave
`sendChat()` and in-game chat untouched.

- [ ] **Step 4: Run to verify it passes**

Run: both test files plus the full suite. Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/mcbot && git add dashboard/automation dashboard/server.js dashboard/test/command-router.test.js dashboard/test/owner-sync.test.js && git commit -m "feat: wire automation commands and owners"
```

---

### Task 8: Payout store and payer bot

**Files:**
- Create: `dashboard/payout-store.js`
- Test: `dashboard/test/payout-store.test.js`
- Runtime-only: `dashboard/data/payout.json` (do not `git add`)

**Interfaces:**
- Consumes: none.
- Produces:
  - `PAYOUT_DEFAULTS` — `{ payoutBotId: null, balance: 0, payoutAmount: '50M', totalPaid: 0, discord: { token: '', guildId: '', channelId: '', enabled: false }, perBotDiscord: {}, claims: [] }`.
  - `parseAmount(text)` — number or `null`; accepts `k|m|b` suffix.
  - `formatAmount(n)` — display string with uppercase `K/M/B`.
  - `loadPayoutStore(file)` / `savePayoutStore(file, data)` — atomic JSON with defaults.
  - `createClaim(store, { discordId, mcName, amount, source })` — `{ ok, claim, error }`; rejects duplicate discordId/mcName.
  - `directPay(store, { mcName, amount, payerOnline })` — `{ ok, error }`; queues when `payerOnline === false`.
  - `flushQueuedClaims(store, sendPay)` — sends only `queued` claims when the payer is online, marks `paying` before send, marks `paid` after success, restores `queued` on failure.
  - `revertClaim(store, id, reason)` — admin cancellation only; never called on a send failure.

- [ ] **Step 1: Write the failing test**

```js
test('parseAmount and formatAmount handle k/m/b', () => {
  assert.equal(parseAmount('1.5k'), 1500);
  assert.equal(parseAmount('2m'), 2000000);
  assert.equal(formatAmount(1500), '1.5K');
});

test('createClaim rejects duplicates and directPay queues offline payer', () => {
  const store = { payoutBotId: 'b_1', balance: 100, payoutAmount: '50', claims: [] };
  assert.equal(createClaim(store, { discordId: 'd1', mcName: 'Alice', amount: 10, source: 'discord' }).ok, true);
  assert.equal(createClaim(store, { discordId: 'd1', mcName: 'Alice', amount: 10, source: 'discord' }).ok, false);
  assert.deepEqual(directPay(store, { mcName: 'Bob', amount: 10, payerOnline: false }), { ok: false, error: 'payer-offline' });
  assert.equal(store.claims.some((c) => c.status === 'queued'), true);
});

test('flushQueuedClaims sends once and restores a failed claim', () => {
  const store = { payoutBotId: 'b_1', balance: 100, claims: [{ id: 'c1', mcUsername: 'Bob', amount: 10, status: 'queued' }] };
  let calls = 0;
  flushQueuedClaims(store, () => { calls += 1; return false; });
  assert.equal(calls, 1);
  assert.equal(store.claims[0].status, 'queued');
  flushQueuedClaims(store, () => { calls += 1; return true; });
  assert.equal(calls, 2);
  assert.equal(store.claims[0].status, 'paid');
  flushQueuedClaims(store, () => { calls += 1; return true; });
  assert.equal(calls, 2, 'paid claims are never sent twice');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test /home/ubuntu/mcbot/dashboard/test/payout-store.test.js`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement the store**

Use `payoutBotId` for the single payer; never pay from all bots. Claims are
one-per-Discord and one-per-MC account. `savePayoutStore()` creates the
directory and writes atomically. No payout password file.

- [ ] **Step 4: Run to verify it passes**

Run: same test file. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/mcbot && git add dashboard/payout-store.js dashboard/test/payout-store.test.js && git commit -m "feat: payout store with designated payer"
```

---

### Task 9: Payout Discord bridge

**Files:**
- Create: `dashboard/payout-bridge.js`
- Modify: `dashboard/package.json` (document `discord.js`, `mineflayer-pathfinder` as panel deps)
- Test: `dashboard/test/payout-bridge.test.js`

**Interfaces:**
- Consumes: `createClaim`, `directPay`, `revertClaim`, `flushQueuedClaims` from Task 8.
- Produces:
  - `buildSetupEmbed(store)` — Discord embed object using `formatAmount(parseAmount(store.payoutAmount))`.
  - `claimModalFields()` — array of custom-id strings.
  - `class PayoutBridge` — `start(client, store, sendPay)`, `stop()`, `handleInteraction(interaction)`.

- [ ] **Step 1: Write the failing test**

```js
test('claimModalFields includes verify and claim custom ids', () => {
  assert.deepEqual(claimModalFields(), ['banana_verify', 'banana_claim_modal']);
});

test('buildSetupEmbed shows payout amount', () => {
  const e = buildSetupEmbed({ balance: 1000, payoutAmount: '50M' });
  assert.match(e.description, /1000/);
  assert.match(e.description, /50M/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test /home/ubuntu/mcbot/dashboard/test/payout-bridge.test.js`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement the bridge**

Register only `/setup-panel`, `banana_verify`, `banana_claim_modal` as in the
real BananaMoney code, not the README. `sendPay(mcName, amount)` is injected by
the server and resolves to the `payoutBotId` bot's `sendChat('/pay ...')`.
No separate listening port, no plaintext admin credential. Do not run
`npm install` during the live window; `discord.js` already resolves from the
parent `node_modules`.

- [ ] **Step 4: Run to verify it passes**

Run: same test file. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/mcbot && git add dashboard/payout-bridge.js dashboard/package.json dashboard/test/payout-bridge.test.js && git commit -m "feat: payout discord bridge"
```

---

### Task 10: Per-bot Discord bridge

**Files:**
- Create: `dashboard/automation/discord-bridge.js`
- Test: `dashboard/test/discord-bridge.test.js`

**Interfaces:**
- Consumes: `routePanelCommand()` from Task 7 and `payout.json` `perBotDiscord[botId]`.
- Produces:
  - `channelNameFor(username)` — `banana-<lowercase username>`.
  - `shouldRelayLine(line)` — boolean; skips empty/system-noise lines.
  - `class BotDiscordBridge` — `start(client, bot, cfg)`, `stop()`, `queueLine(line)`, `flush()`, `onMessage(msg)`.

- [ ] **Step 1: Write the failing test**

```js
test('channelNameFor lowercases and prefixes username', () => {
  assert.equal(channelNameFor('Alice'), 'banana-alice');
});

test('shouldRelayLine skips blank lines', () => {
  assert.equal(shouldRelayLine(''), false);
  assert.equal(shouldRelayLine('Logged in'), true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test /home/ubuntu/mcbot/dashboard/test/discord-bridge.test.js`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement the bridge**

Batch log lines with a flush interval. `!` messages route through
`routePanelCommand()`; plain messages become in-game chat via `sendChat()`.
The bridge never starts without `perBotDiscord[botId].token` and never touches
the existing standalone `discord-bridge.js`.

- [ ] **Step 4: Run to verify it passes**

Run: same test file. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/mcbot && git add dashboard/automation/discord-bridge.js dashboard/test/discord-bridge.test.js && git commit -m "feat: per-bot discord bridge"
```

---

### Task 11: Server API and SSE for all new features

**Files:**
- Create: `dashboard/automation/api.js`
- Modify: `dashboard/server.js` (API router, SSE broadcasts, boot/shutdown)
- Test: `dashboard/test/automation-api.test.js`

**Interfaces:**
- Consumes: every export from Tasks 1–10.
- Produces from `automation/api.js`:
  - `automationApiResponse(pathname, method, body, ctx)` — `{ code, payload }`; `ctx` contains `manager`, `payoutStore`, `payoutBridge`, `sendPay`.
- SSE event types: `automation`, `script`, `payout`, `discord`, `disruption`.

Routes to add, all after `isAuthed()`, matching the design:
- `GET /api/bots/:id/automation`, `POST /api/bots/:id/automation` with `{ patch }`
- `GET|POST /api/bots/:id/scripts`, `POST /api/bots/:id/scripts/:action`
- `GET|PUT /api/aliases`
- `GET /api/payout`, `POST /api/payout` with `{ action: 'update'|'pay'|'link' }`
- `GET /api/payout/events`
- `GET|POST /api/bots/:id/discord` (masked token response)

- [ ] **Step 1: Write the failing test**

```js
test('automationApiResponse rejects unknown actions and dangerous patches', () => {
  const ctx = { manager: { bots: new Map() }, payoutStore: {}, sendPay() {} };
  assert.equal(automationApiResponse('/api/bots/b_1/automation', 'POST', { patch: { boneSlot: 999 } }, ctx).code, 200);
  assert.equal(automationApiResponse('/api/payout', 'POST', { action: 'unknown' }, ctx).code, 400);
  assert.equal(automationApiResponse('/api/aliases', 'PUT', { alias: '!quit', text: '!quit' }, ctx).code, 400);
  assert.equal(automationApiResponse('/api/bots/b_1/discord', 'GET', {}, ctx).code, 200);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test /home/ubuntu/mcbot/dashboard/test/automation-api.test.js`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement API router integration**

Import the helper into `server.js`, wire the routes above, broadcast SSE on
changes, load `aliases.json`/`payout.json` at boot, flush queued claims when
`payoutBotId` comes online, and stop bridges in `shutdown()`. Keep
`isAuthed()` ahead of every new route. `server.js` still exports nothing.

- [ ] **Step 4: Run to verify it passes**

Run: same test file plus the full suite. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/mcbot && git add dashboard/automation/api.js dashboard/server.js dashboard/test/automation-api.test.js && git commit -m "feat: automation payout and discord API"
```

---

### Task 12: Dashboard UI — missing panel capabilities

**Files:**
- Modify: `dashboard/public/index.html`
- Modify: `dashboard/public/app.js`
- Modify: `dashboard/public/styles.css`
- Test: `dashboard/test/ui-contract.test.js`

**Interfaces:**
- Consumes: API routes from Task 11 and SSE types from Task 11.
- Produces: nav views `automation`, `scripts`, `payout`; bot tabs `Terminal`,
  `Configuration`, `Live Inventory`, `Scripts & Actions`; actions
  `automation-toggle`, `automation-save`, `script-add`, `script-toggle`,
  `alias-add`, `payout-update`, `payout-pay`, `discord-link`.

- [ ] **Step 1: Write the failing test**

```js
const path = require('node:path');
const fs = require('node:fs');
const root = path.join(__dirname, '../public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

test('UI declares every new view and action', () => {
  for (const v of ['automation', 'scripts', 'payout']) assert.match(html, new RegExp(`data-view="${v}"`));
  for (const a of ['automation-toggle', 'automation-save', 'script-add', 'payout-update', 'discord-link']) {
    assert.match(app, new RegExp(`'${a}'|"${a}"`));
  }
});

test('UI declares deploy fields, grouped rendering and disruption toasts', () => {
  for (const s of ['authMode', 'botWebhook', 'groupIds', 'running', 'sorted']) assert.match(app, new RegExp(s));
  for (const q of ['!bones', '!invclean', '!stats', '!gui', '!click', '!shift', '!close']) {
    assert.match(app, new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  for (const e of ['kick', 'disconnect', 'death', 'crash']) assert.match(app, new RegExp(e));
  for (const t of ['automation', 'script', 'payout', 'disruption']) assert.match(app, new RegExp(`'${t}'|"${t}"`));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test /home/ubuntu/mcbot/dashboard/test/ui-contract.test.js`
Expected: FAIL, strings missing.

- [ ] **Step 3: Implement UI**

Add nav items, view metadata/renderers, grouped bot list using existing groups
with collapsible sections, `running/total` counts and sorting, dirty-save bar,
toasts, richer inventory grid (armour/offhand/backpack/hotbar), terminal history
and all quick buttons, automation/config forms including `authMode` and
`botWebhook`, scripts/aliases manager, payout view, Discord link status, SSE
delta patching and `disruption` toasts for kick/disconnect/death/crash.
`switchView()` whitelist and `applyRoute()` must include the three new views.

- [ ] **Step 4: Run to verify it passes**

Run: same test file plus the full suite. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/mcbot && git add dashboard/public dashboard/test/ui-contract.test.js && git commit -m "feat: dashboard UI for merged features"
```

---

### Task 13: Final verification and atomic deploy

**Files:** none (verification only)

- [ ] **Step 1: Static checks**

Run:
```bash
cd /home/ubuntu/mcbot/dashboard && for f in server.js payout-store.js payout-bridge.js automation/*.js public/app.js; do node --check "$f" || exit 1; done
node --test /home/ubuntu/mcbot/dashboard/test/*.test.js
```
Expected: all `node --check` clean; full suite passes with zero failures.

- [ ] **Step 2: Atomic restart**

Run:
```bash
systemctl restart mcbot-dashboard
```
Expected: service active, no start errors in `journalctl -u mcbot-dashboard -n 60`.

- [ ] **Step 3: Proxy and bot invariants**

Log in, fetch `/api/state` and `/api/proxies`, assert:
```js
counts.online === 15
unique IPs === 15
collisions === 0
every automation module disabled by default
```
Expected: all true. No `logging in too fast` in logs since restart.

- [ ] **Step 4: Auth gate and UI smoke**

Without the session cookie, every route from Task 11 must return 401/403. With
the cookie, open `automation`, `scripts`, `payout` views and confirm no console
errors. Verify the existing `discord-bridge.js` process is still running.

- [ ] **Step 5: Final commit note**

No code changes expected. If a fix is needed, make it in the owning task's
files, re-run that task's tests, then repeat Task 13.
