# Proxy Uptime Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the proxy pool record real session and lifetime uptime, expose routes that have never dropped early, and prefer the longest-lived routes so bots stay online as long as possible.

**Architecture:** A small pure helper owns the uptime thresholds, counters, and clean/good classification. `proxy-pool.js` persists those fields, exposes them through `status()`/`/api/proxies/good`, and ranks `pick()` by lifetime uptime. `server.js` feeds the helper from its existing `end` event using the already-computed session duration.

**Tech Stack:** Node.js 18+, CommonJS, `node:test`, existing dashboard HTTP API.

**Spec:** `docs/superpowers/specs/2026-11-25-proxy-uptime-filter-design.md`

## Global Constraints

- Proxy-only routing: no direct fallback, ever.
- Exactly one bot per real proxy IP (`maxPerIp: 1`).
- Do not take the whole fleet offline; rollout is one bot at a time.
- Do not overwrite user-owned `dashboard/bot-options.js`, `dashboard/chat-text.js`, or untracked `dashboard/scoreboard-compat.js`.
- No commit or push until full fleet verification; when committing, stage only the explicit files listed in a task.

## Review Focus

- **A good route later has one short drop.** It must lose clean `good` status but keep its lifetime and best-session history — Task 1 test `a later short session removes clean status but keeps history`.
- **Lifetime uptime must be cumulative and uncapped.** Two multi-hour sessions must add, not reset — Task 1 test `lifetime uptime accumulates without a cap`.
- **Two sessions under 10 minutes.** The route must be cooled for 10 minutes and excluded by `pick()` — Task 2 test `two short sessions cool the route and remove it from pick`.
- **Three sessions under 10 minutes.** The route must be permanently retired — Task 2 test `three short sessions retire the route`.
- **Restart persistence.** New fields, including lifetime uptime, must survive `_load()`/`_save()` — Task 2 test `uptime fields survive a save/load round trip`.

---

### Task 1: Pure uptime accounting helper

**Files:**
- Create: `dashboard/proxy-uptime.js`
- Test: `dashboard/test/proxy-uptime.test.js`

**Interfaces:**
- Consumes: plain proxy record objects from `proxy-pool.js`.
- Produces:
  - `GOOD_SESSION_MS = 3600000`
  - `SHORT_SESSION_MS = 600000`
  - `recordSession(record, durationMs, now = Date.now()) -> record`
  - `uptimeTier(record) -> 'good' | 'trial' | 'unknown' | 'bad'`
  - `uptimeSummary(record) -> { sessions, lifetimeUptimeMs, totalUptimeMs, bestUptimeMs, shortSessions, tier, lifetimeUptimeSec, bestUptimeSec, avgUptimeSec }`

- [ ] **Step 1: Write the failing test**

Create `dashboard/test/proxy-uptime.test.js` with these tests:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { recordSession, uptimeTier, uptimeSummary, GOOD_SESSION_MS } = require('../proxy-uptime');

test('a one-hour session with no drops is good', () => {
  const p = {};
  recordSession(p, GOOD_SESSION_MS, 1000);
  assert.equal(uptimeTier(p), 'good');
  assert.equal(p.shortSessions, 0);
  assert.equal(p.totalUptimeMs, GOOD_SESSION_MS);
});

test('a 30-minute session is trial, not good', () => {
  const p = {};
  recordSession(p, 30 * 60 * 1000, 1000);
  assert.equal(uptimeTier(p), 'trial');
});

test('lifetime uptime accumulates without a cap', () => {
  const p = {};
  const twoHours = 2 * 60 * 60 * 1000;
  const threeHours = 3 * 60 * 60 * 1000;
  recordSession(p, twoHours, 1000);
  recordSession(p, threeHours, 2000);
  assert.equal(p.totalUptimeMs, twoHours + threeHours);
  assert.equal(p.bestUptimeMs, threeHours);
  assert.equal(uptimeSummary(p).lifetimeUptimeSec, 5 * 60 * 60);
});

test('legacy records are unknown', () => {
  assert.equal(uptimeTier({}), 'unknown');
});

test('a later short session removes clean status but keeps history', () => {
  const p = {};
  recordSession(p, GOOD_SESSION_MS, 1000);
  recordSession(p, 60 * 1000, 2000);
  assert.equal(p.bestUptimeMs, GOOD_SESSION_MS);
  assert.equal(p.totalUptimeMs, GOOD_SESSION_MS + 60 * 1000);
  assert.equal(p.shortSessions, 1);
  assert.equal(uptimeTier(p), 'trial');
});

test('recent history is capped at ten entries', () => {
  const p = {};
  for (let i = 0; i < 15; i++) recordSession(p, 1000 + i, 1000 + i);
  assert.equal(p.recent.length, 10);
  assert.equal(p.recent[0].ms, 1005);
  assert.equal(p.sessions, 15);
});

test('uptime summary reports lifetime and best seconds', () => {
  const p = {};
  recordSession(p, 20 * 60 * 1000, 1000);
  const s = uptimeSummary(p);
  assert.equal(s.tier, 'trial');
  assert.equal(s.bestUptimeSec, 1200);
  assert.equal(s.lifetimeUptimeSec, 1200);
  assert.equal(s.avgUptimeSec, 1200);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/ubuntu/mcbot/dashboard && node --test test/proxy-uptime.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `dashboard/proxy-uptime.js`**

Export the constants and functions from the Interfaces block. `recordSession` must mutate the record, initialising missing numeric fields to 0 and `recent` to `[]`, increment `sessions`, accumulate `totalUptimeMs` (lifetime), keep the maximum `bestUptimeMs`, increment `shortSessions` only for durations `< SHORT_SESSION_MS`, increment `longSessions` only for durations `>= GOOD_SESSION_MS`, push `{ ms, at }` into `recent`, and trim `recent` to the last 10 entries. Set `lifetimeUptimeMs` equal to `totalUptimeMs`. `uptimeTier` returns `bad` if `shortSessions >= 3`, then `good` if `shortSessions === 0 && bestUptimeMs >= GOOD_SESSION_MS`, then `trial` if `bestUptimeMs >= SHORT_SESSION_MS`, otherwise `unknown`. `uptimeSummary` returns the listed fields with `lifetimeUptimeSec`, `bestUptimeSec`, and `avgUptimeSec` rounded from milliseconds.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/ubuntu/mcbot/dashboard && node --test test/proxy-uptime.test.js`
Expected: PASS.

- [ ] **Step 5: No commit yet**

Global constraint: commit only after full fleet verification.

---

### Task 2: Wire uptime into the proxy pool

**Files:**
- Modify: `dashboard/proxy-pool.js` (load/save near lines 377–419, `pick()` near 792–847, `status()` near 977–1021, add `reportSession()` near `reportOk()`)
- Test: `dashboard/test/proxy-pool-uptime.test.js`

**Interfaces:**
- Consumes: `recordSession`, `uptimeTier`, `uptimeSummary`, `GOOD_SESSION_MS`, `SHORT_SESSION_MS` from `dashboard/proxy-uptime.js`.
- Produces:
  - `proxyPool.reportSession(proxy, durationMs, reason) -> 'good'|'trial'|'unknown'|'bad'`
  - `proxyPool.status().good` — array of `{ key, ip, port, lifetimeUptimeSec, bestUptimeSec, sessions }`, sorted by lifetime uptime descending
  - Per-proxy status fields: `sessions`, `totalUptimeMs`, `lifetimeUptimeMs`, `bestUptimeMs`, `avgUptimeMs`, `shortSessions`, `tier`
  - `pick()` ranks tiers `good`, `trial`, `unknown`; `bad` is excluded by retirement. Within `good` and `trial`, higher `totalUptimeMs` wins before latency weighting.

- [ ] **Step 1: Write the failing test**

Create `dashboard/test/proxy-pool-uptime.test.js`. Use the same save/restore-of-global-state pattern as `dashboard/test/proxy-pick.test.js`. Include:

```js
test('two short sessions cool the route and remove it from pick', () => {
  // seed alive with key 'short.test:1', source 'user'
  proxyPool.reportSession({ ip: 'short.test', port: 1 }, 60 * 1000);
  proxyPool.reportSession({ ip: 'short.test', port: 1 }, 90 * 1000);
  assert.ok(proxyPool.alive.get('short.test:1').quarantineUntil > Date.now());
  assert.notEqual(proxyPool.pick('b-short').key, 'short.test:1');
});

test('three short sessions retire the route', () => {
  // fresh pool state
  for (let i = 0; i < 3; i++) proxyPool.reportSession({ ip: 'short.test', port: 1 }, 60 * 1000);
  assert.equal(proxyPool.alive.get('short.test:1').retired, true);
});

test('pick prefers good over trial', () => {
  // seed 'good.test:1': bestUptimeMs = 2h, totalUptimeMs = 5h, shortSessions = 0, source 'user'
  // seed 'trial.test:2': bestUptimeMs = 30m, totalUptimeMs = 3h, shortSessions = 0, source 'user'
  const picked = proxyPool.pick('b-rank');
  assert.equal(picked.key, 'good.test:1');
});

test('status().good only contains clean healthy routes', () => {
  // seed one clean healthy (lifetime 7200000), one retired clean, one trial
  const good = proxyPool.status().good;
  assert.deepEqual(good.map((p) => p.key), ['good.test:1']);
  assert.equal(good[0].lifetimeUptimeSec, 7200);
});

test('uptime fields survive a save/load round trip', () => {
  // seed a record with sessions=4, totalUptimeMs=3700000, bestUptimeMs=3700000,
  // shortSessions=0, recent=[{ms:3700000,at:1}], then _save() and _load()
  const p = proxyPool.alive.get('persist.test:1');
  assert.equal(p.totalUptimeMs, 3700000);
  assert.equal(p.bestUptimeMs, 3700000);
  assert.equal(p.sessions, 4);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/ubuntu/mcbot/dashboard && node --test test/proxy-pool-uptime.test.js`
Expected: FAIL, `proxyPool.reportSession is not a function`.

- [ ] **Step 3: Implement the pool changes**

In `proxy-pool.js`:

- Import the helper module.
- In `_load()`, when rebuilding each `alive` record, include `sessions`, `totalUptimeMs`, `lifetimeUptimeMs`, `bestUptimeMs`, `shortSessions`, `longSessions` as numbers and `recent` as a bounded array of `{ ms, at }` from `raw.recent || []`.
- In `_save()`, write those fields for each persisted proxy.
- Add `reportSession(proxy, durationMs, reason)`: resolve the key from `proxy.ip || proxy.host` and `proxy.port`, look up `this.alive`, call `recordSession(p, durationMs)`, apply `quarantineUntil = Date.now() + 10 * 60 * 1000` when `p.shortSessions === 2`, set `p.retired = true` when `p.shortSessions >= 3`, log the transition, call `this._save()`, and return `uptimeTier(p)`.
- In `pick()`, after the existing quarantine and per-IP filters, rank candidates by `uptimeTier`: `good` first, then `trial`, then `curated` (`source === 'user'`), then `asian`, then all remaining candidates. Sort the `good` and `trial` groups by `totalUptimeMs` descending before applying the existing weighted-random tie-break within the selected tier.
- In `status()`, add the `uptimeSummary()` fields to each proxy entry (including `tier`) and add `good` to the returned object: healthy, non-retired records with tier `good`, mapped to `{ key, ip, port, lifetimeUptimeSec, bestUptimeSec, sessions }` and sorted by `totalUptimeMs` descending.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/ubuntu/mcbot/dashboard && node --test test/*.test.js`
Expected: PASS, including the existing 19 tests.

- [ ] **Step 5: No commit yet**

Global constraint: commit only after full fleet verification.

---

### Task 3: Feed real sessions from the bot lifecycle and expose the API

**Files:**
- Modify: `dashboard/server.js` (end handler around lines 1137–1172; HTTP route near line 2433)
- Verify with: live dashboard API

**Interfaces:**
- Consumes: `proxyPool.reportSession(proxy, durationMs, reason)` from Task 2.
- Produces: `GET /api/proxies/good` returning `{ good: [...] }` with lifetime uptime fields.

- [ ] **Step 1: Add the session hook**

In the `bot.on('end', ...)` handler, immediately after `sessionSec` is computed at line 1146 and before `connectedAt` is cleared, call:

```js
if (this.proxy && sessionSec > 0) {
  proxyPool.reportSession(this.proxy, sessionSec * 1000, endReason);
}
```

Use `endReason` already defined on the next line; move its definition above the call if needed. Do not call this for handshakes that never reached spawn (`sessionSec === 0`).

- [ ] **Step 2: Add the read-only API route**

Immediately after the existing `if (parts[1] === 'proxies' && method === 'GET')` line, add:

```js
if (parts[1] === 'proxies' && parts[2] === 'good' && method === 'GET') {
  return json(res, 200, { good: proxyPool.status().good });
}
```

- [ ] **Step 3: Run static and unit checks**

Run: `cd /home/ubuntu/mcbot/dashboard && node --check server.js && node --test test/*.test.js`
Expected: all tests PASS, no syntax errors.

- [ ] **Step 4: Verify after restart, one bot at a time**

Do not restart while another rolling pass is running. After the current pass finishes:

```bash
sudo systemctl restart mcbot-dashboard
sleep 50
curl -s -c /tmp/opencode/mcbot-cj -b /tmp/opencode/mcbot-cj \
  -X POST http://127.0.0.1/api/login -H 'Content-Type: application/json' \
  -d '{"password":"Sandun123"}' >/dev/null
curl -s -b /tmp/opencode/mcbot-cj http://127.0.0.1/api/proxies/good
curl -s -b /tmp/opencode/mcbot-cj http://127.0.0.1/api/state
```

Expected: service active; 12/12 online; proxy collisions 0; `/api/proxies/good` returns valid JSON (empty until the first clean 1h session completes).

- [ ] **Step 5: No commit yet**

Global constraint: commit only after full fleet verification.

---

### Task 4: Fleet verification and commit

**Files:** no new source files; commit only the files below plus prior verified fixes.

- [ ] **Step 1: Wait for real lifetime uptime to accumulate**

Run: `python3 /tmp/opencode/afk_finish.py`
Expected: no early disconnect, each bot online, and at least one proxy in `/api/proxies/good` with `lifetimeUptimeSec` continuing to increase across checks.

- [ ] **Step 2: Confirm the longest-lived route is actually chosen**

Run: `curl -s -b /tmp/opencode/mcbot-cj http://127.0.0.1/api/proxies`
Expected: `good` contains the longest-lived key, `collisions: 0`, and no retired/quarantined route is assigned to an online bot.

- [ ] **Step 3: Commit explicit files**

```bash
cd /home/ubuntu/mcbot
git add dashboard/proxy-uptime.js dashboard/proxy-pool.js dashboard/server.js \
  dashboard/test/proxy-uptime.test.js dashboard/test/proxy-pool-uptime.test.js \
  docs/superpowers/specs/2026-11-25-proxy-uptime-filter-design.md \
  docs/superpowers/plans/2026-11-25-proxy-uptime-filter.md
git commit -m "feat: rank proxies by lifetime session uptime"
```

Expected: commit succeeds. Do not push until credentials are provided.

- [ ] **Step 4: Report the result**

State the promoted proxy keys, current online count, their lifetime uptime, and whether push remains blocked.
