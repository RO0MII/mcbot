# Proxy uptime filter — short design

Date: 2026-11-25 (amended: lifetime uptime, not a 1-hour cap)

## Intent

The fleet must stay online as long as possible — effectively **unlimited /
lifetime uptime**, with no disconnects. One hour is only the minimum evidence
that a route is worth trusting; after that, routes are ranked by **cumulative
lifetime uptime**, not capped at 1h. Today the proxy pool rewards a route for
completing a TCP/Minecraft handshake (`successes`), so a proxy that survives 30
seconds earns the same credit as one that survives hours. There is no way to
filter or select routes by real session uptime.

## Goals

- Record the real duration of every bot session against the proxy used.
- Accumulate lifetime uptime (`totalUptimeMs`) across sessions and restarts.
- Keep the longest current session (`bestUptimeMs`) for ranking.
- `GET /api/proxies/good` returns only **clean** routes: no short drops ever,
  and at least one session >= 3600s. Results include lifetime uptime.
- `pick()` ranks by lifetime uptime and longest session, so the fleet converges
  on the routes that have stayed online the longest.
- Short-lived routes are cooled/retired based on session history, not just
  handshake failures.
- Keep proxy-only routing, one bot per real IP, and no direct fallback.

## Non-goals

- No changes to bot credentials, AFK flow, walk engine, or user-owned files
  (`bot-options.js`, `chat-text.js`, `scoreboard-compat.js`).
- No fleet-wide offline action; rollout stays one bot at a time.
- No promise of literally zero disconnects: the game server and public proxy
  providers can still churn. The goal is to stop routing bots through routes
  with a proven history of short sessions.

## Approaches considered

1. **Pool-native uptime memory (chosen).** Hook the existing `end` event in
   `server.js`, add uptime fields to each proxy record in `proxy-pool.js`,
   expose a good list, and use it in `pick()`. Fast, persisted, no new process.
2. **Separate verifier script.** Watch one bot at a time and write a curated
   list. More accurate but slow, and duplicates logic the dashboard already
   has. Not chosen as the primary path.

## Design

- On session end, call `proxyPool.reportSession(proxy, durationMs, reason)`.
  Update `sessions`, `totalUptimeMs` (lifetime), `bestUptimeMs`,
  `shortSessions`, `longSessions`, and a bounded `recent` array (last 10
  durations).
- Thresholds: `GOOD_SESSION_MS = 3600_000` (minimum evidence),
  `SHORT_SESSION_MS = 600_000` (a drop).
  - **good / clean**: `shortSessions === 0` and `bestUptimeMs >= 1h`.
  - **trial**: no short drop so far, or recovering after one; ranked by
    lifetime uptime.
  - Two sessions < 10m -> 10-minute cooldown; three -> retire.
- `pick()` priority: clean `good` routes first, sorted by `totalUptimeMs`
  descending, then `trial` routes (also lifetime-sorted), then curated
  bootstrap routes, then the rest. One-bot-per-IP and sticky-pin rules still
  apply; a good route never overrides a still-healthy pin.
- `status()` includes uptime fields per proxy plus a `good` array;
  `GET /api/proxies/good` returns that array with `lifetimeUptimeSec`,
  `bestUptimeSec`, and `sessions`.
- `_load()` / `_save()` round-trip the new fields with safe numeric defaults.
- Bootstrap: no route has clean 1h evidence yet, so the six known working
  routes are treated as `trial` candidates. Real sessions decide which become
  `good`, and their lifetime uptime keeps growing while they stay online.

## Verification

- Unit tests for lifetime accumulation, clean-good classification, retirement
  after repeated short sessions, legacy-record safety, and `pick()` ranking.
- `node --check` on changed JS files; full `node --test test/*.test.js`.
- After rollout: 12/12 online, no proxy collisions, and at least one route
  promoted to `good` whose `lifetimeUptimeSec` keeps increasing.
