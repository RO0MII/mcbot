'use strict';
/**
 * Proxy pool — automatic SOCKS5 discovery, validation and sticky assignment.
 *
 *  · Fetches free SOCKS5 lists from several public sources.
 *  · Validates each candidate by opening a real SOCKS5 tunnel to the Minecraft
 *    server the bots use, and keeps the ones that answer fast.
 *  · Hands each bot a sticky proxy (same IP across reconnects) and never puts
 *    more than `maxPerIp` bots behind one IP.
 *  · A 3-minute health sweep probes routes in the background. Successful
 *    routes earn weight; timeouts/failures earn a cooldown and are skipped in
 *    later sweeps instead of being retried over and over. After repeated
 *    failures a route is retired from rotation entirely.
 *
 * There is no direct fallback: if no proxy is alive, bots wait for a route.
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { recordSession, uptimeTier, uptimeSummary } = require('./proxy-uptime');

// spys.one sits behind a Cloudflare challenge, so use ProxyScrape's country
// feeds instead — same idea (Asian routes), machine-readable and free.
const ASIA_COUNTRIES = ['JP', 'HK', 'SG', 'KR', 'TW', 'TH', 'MY', 'ID', 'IN', 'VN', 'PH'];

const SOURCES = [
  // protocolipport keeps the scheme on each line, so one feed supplies both
  // SOCKS5 and HTTP CONNECT routes (socks4 is ignored — this client cannot dial it).
  { url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text' },
  { url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt' },
  { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt' },
  { url: 'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt' },
  { url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt' },
  { url: 'https://openproxylist.xyz/socks5.txt' },
].concat(ASIA_COUNTRIES.map((country) => ({
  url: `https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&country=${country}`,
  region: 'asia',
}))).concat([{
  url: 'https://roundproxies.com/api/get-free-proxies/?limit=100&page=1&sort_by=lastChecked&sort_type=desc&country=SG',
  region: 'asia',
  parse: 'roundproxies',
}]);

const DEFAULTS = {
  enabled: true,
  maxPerIp: 1,
  validateTimeout: 2500,
  validateConcurrency: 60,
  maxCandidates: 200,
  maxPool: 400,                // hard cap on live routes; no endless growth
  refreshMs: 12 * 60 * 1000,   // full re-discover
  pruneMs: 4 * 60 * 1000,      // re-check what we already have
};

// Health model. A failed route is not retried on every sweep: it sits out the
// next few sweeps, then gets one more chance. Repeated failures retire it.
const HEALTH_CHECK_MS = 3 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 2500;
const HEALTH_CONCURRENCY = 20;
const HEALTH_BATCH = 160;
const QUARANTINE_STEPS = [3, 15, 60].map((m) => m * 60 * 1000);
const RETIRE_AFTER = QUARANTINE_STEPS.length + 1;
const FAIL_DEDUPE_MS = 30000;
// A live-session failure deserves a long cooldown, but one hiccup must not
// permanently exile a route that has carried bots for hours. The third
// confirmed game failure is enough evidence to retire it.
const GAME_COOLDOWNS = [10, 30].map((m) => m * 60 * 1000);
const GAME_RETIRE_AFTER = GAME_COOLDOWNS.length + 1;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function isQuarantined(p, now) {
  return !!(p && (p.retired || (p.quarantineUntil || 0) > (now || Date.now())));
}

/** Low cost = good route. Every confirmed success makes a route cheaper to
 *  pick; each consecutive failure makes it less attractive. */
function healthCost(p) {
  const latency = clamp(Number(p.latency) || 3000, 50, 6000);
  const wins = clamp(Number(p.successes) || 0, 0, 30);
  const streak = clamp(Number(p.failStreak) || 0, 0, 10);
  return latency / (1 + wins * 0.6) + streak * 220;
}

/**
 * Local/private destinations must never be sent through a public proxy —
 * most providers refuse them, and there is nothing to gain by hiding them.
 * Works for IP literals and the usual local hostnames without a DNS lookup.
 */
function isLocalTarget(host) {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  const ip = net.isIP(h);
  if (!ip) return false;
  if (ip === 4) {
    const a = h.split('.').map(Number);
    return a[0] === 0 || a[0] === 10 || a[0] === 127
      || (a[0] === 169 && a[1] === 254)
      || (a[0] === 172 && a[1] >= 16 && a[1] <= 31)
      || (a[0] === 192 && a[1] === 168)
      || (a[0] === 100 && a[1] >= 64 && a[1] <= 127); // CGNAT
  }
  const v = h.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd')
    || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')
    || /^::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v);
}

/* ── tiny SOCKS5 client ──────────────────────────────────────────────────── */

function socks5Connect(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) { try { sock.destroy(); } catch (_) {} reject(err); }
      else { sock.removeListener('data', onData); sock.removeListener('error', onError); sock.setTimeout(0); resolve(sock); }
    };
    const timer = setTimeout(() => finish(new Error('proxy timeout')), timeoutMs || 6000);
    const onError = (e) => finish(e);
    sock.once('error', onError);
    sock.setTimeout(timeoutMs || 6000, () => finish(new Error('proxy timeout')));

    // Handshake state: 0 greeting, 1 auth, 2 connect reply
    let stage = 0;
    let buf = Buffer.alloc(0);
    const want = (n) => buf.length >= n;

    const step = () => {
      if (stage === 0) {
        if (!want(2)) return;
        const ver = buf[0];
        const method = buf[1];
        buf = buf.slice(2);
        if (ver !== 5) return finish(new Error('not socks5'));
        if (method === 0xff) return finish(new Error('proxy rejected auth'));
        if (method === 0x02) {
          if (!proxy.username) return finish(new Error('proxy wants auth'));
          const u = Buffer.from(String(proxy.username));
          const p = Buffer.from(String(proxy.password || ''));
          const pkt = Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]);
          sock.write(pkt);
          stage = 1;
        } else {
          sendConnect();
        }
        return step();
      }
      if (stage === 1) {
        if (!want(2)) return;
        const ok = buf[1] === 0x00;
        buf = buf.slice(2);
        if (!ok) return finish(new Error('proxy auth failed'));
        return sendConnect();
      }
      if (stage === 2) {
        if (!want(4)) return;
        const rep = buf[1];
        const atyp = buf[3];
        if (rep !== 0x00) {
          const MSG = { 1: 'general failure', 2: 'not allowed', 3: 'network unreachable', 4: 'host unreachable', 5: 'refused', 6: 'ttl expired', 7: 'cmd unsupported', 8: 'atyp unsupported' };
          return finish(new Error('socks ' + (MSG[rep] || ('error ' + rep))));
        }
        let need = 4;
        if (atyp === 0x01) need += 4 + 2;
        else if (atyp === 0x03) { if (!want(5)) return; need += 1 + buf[4] + 2; }
        else if (atyp === 0x04) need += 16 + 2;
        else return finish(new Error('bad address type'));
        if (!want(need)) return;
        buf = buf.slice(need);
        return finish(null);
      }
    };

    const sendConnect = () => {
      const h = Buffer.from(host);
      const head = Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]);
      const tail = Buffer.alloc(2);
      tail.writeUInt16BE(port, 0);
      sock.write(Buffer.concat([head, h, tail]));
      stage = 2;
    };

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try { step(); } catch (e) { finish(e); }
    };

    sock.on('connect', () => {
      const methods = proxy.username ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
      sock.write(methods);
    });
    sock.on('data', onData);
  });
}

/* ── tiny HTTP CONNECT client (Webshare rotating endpoint) ──────────────── */

function httpConnect(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) { try { sock.destroy(); } catch (_) {} reject(err); }
      else { sock.removeListener('data', onData); sock.removeListener('error', onError); sock.setTimeout(0); resolve(sock); }
    };
    const timer = setTimeout(() => finish(new Error('proxy timeout')), timeoutMs || 9000);
    const onError = (e) => finish(e);
    sock.once('error', onError);
    sock.setTimeout(timeoutMs || 9000, () => finish(new Error('proxy timeout')));
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const cut = buf.indexOf('\r\n\r\n');
      if (cut < 0) return;
      const line = buf.slice(0, cut).toString('latin1').split('\r\n')[0] || '';
      const code = Number((line.match(/\s(\d{3})\s/) || [])[1] || 0);
      if (code !== 200) return finish(new Error('proxy CONNECT ' + (code || 'rejected')));
      const rest = buf.slice(cut + 4);
      finish(null);
      // Keep the tunnel quiet until minecraft-protocol pipes it. A socket left
      // flowing with no 'data' listener drops bytes, and bytes that arrived in
      // the same chunk as the CONNECT reply are lost outright — both desync the
      // decoder and surface as "Missing characters in string".
      sock.pause();
      if (rest.length) sock.unshift(rest);
    };
    sock.on('connect', () => {
      const auth = proxy.username
        ? 'Proxy-Authorization: Basic ' + Buffer.from(proxy.username + ':' + (proxy.password || '')).toString('base64') + '\r\n'
        : '';
      sock.write('CONNECT ' + host + ':' + port + ' HTTP/1.1\r\nHost: ' + host + ':' + port + '\r\n' + auth + '\r\n');
    });
    sock.on('data', onData);
  });
}

/* ── pool ────────────────────────────────────────────────────────────────── */

class ProxyPool {
  constructor() {
    this.opts = Object.assign({}, DEFAULTS);
    this.file = null;
    this.target = { host: '', port: 25565 };
    this.static = [];             // curated proxies from data/proxies.json (both protocols)
    this.alive = new Map();       // key -> { key, host, port, latency, okAt, fails, source }
    this.assignments = new Map(); // botId -> key
    this.names = new Map();       // botId -> bot name (display only)
    this._botIds = null;          // live bot ids, supplied by the server
    this.webshare = {             // rotating HTTP CONNECT provider (local config)
      enabled: false, host: 'p.webshare.io', port: 80, username: '', password: '',
    };
    this.lastRefresh = 0;
    this.lastHealthCheck = 0;
    this.healthBusy = false;
    this.refreshing = false;
    this.lastError = '';
    this.timers = [];
    this._saveTimer = null;
    this.log = () => {};
  }

  init({ dataDir, target, log, botIds }) {
    if (log) this.log = log;
    if (typeof botIds === 'function') this._botIds = botIds;
    if (target && target.host) this.target = { host: target.host, port: target.port || 25565 };
    this.file = path.join(dataDir, 'proxies.json');
    this._load();
    this._loadWebshare();
    this._pruneAssignments(); // drop pins belonging to bots that no longer exist
    this._schedule();
    // Re-validate the cached list (fast, a couple of seconds) so the first
    // connections can already use a route. Fresh discovery runs in parallel.
    this._boot = this._revalidateCached().catch((e) => { this.lastError = e.message; });
    this.refresh(false).catch((e) => { this.lastError = e.message; });
    return this._boot;
  }

  _schedule() {
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [
      setInterval(() => this.refresh(false).catch(() => {}), this.opts.refreshMs),
      setInterval(() => this.healthCheck().catch(() => {}), HEALTH_CHECK_MS),
    ];
    if (this.timers.forEach) this.timers.forEach((t) => { if (t.unref) t.unref(); });
  }

  setTarget(host, port) {
    if (host && (host !== this.target.host || port !== this.target.port)) {
      this.target = { host, port: port || 25565 };
      this.refresh(true).catch(() => {});
    }
  }

  setEnabled(on) {
    this.opts.enabled = !!on;
    this._save();
    return this.opts.enabled;
  }

  setMaxPerIp(n) {
    this.opts.maxPerIp = clamp(Number(n) || 1, 1, 50);
    this._save();
    return this.opts.maxPerIp;
  }

  /* ── rotating provider (credentials live in gitignored data/webshare.json) ── */
  _webshareFile() {
    return this.file ? path.join(path.dirname(this.file), 'webshare.json') : null;
  }

  _loadWebshare() {
    const file = this._webshareFile();
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      this.webshare = {
        enabled: !!raw.enabled,
        host: String(raw.host || 'p.webshare.io'),
        port: Number(raw.port || 80),
        username: String(raw.username || ''),
        password: String(raw.password || ''),
      };
    } catch (_) {}
  }

  _saveWebshare() {
    const file = this._webshareFile();
    if (!file) return;
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(this.webshare, null, 2), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    } catch (e) { this.lastError = 'webshare save: ' + e.message; }
  }

  webshareActive() {
    return !!(this.webshare.enabled && this.webshare.username);
  }

  setWebshare(on) {
    this.webshare.enabled = !!on;
    if (!this.webshare.enabled) {
      // Drop per-bot tunnels so the next connect goes back to the public pool.
      this.assignments.forEach((key, botId) => {
        if (key.indexOf('webshare:') === 0) this.assignments.delete(botId);
      });
      // The public pool was idle while Webshare was on — make it usable again.
      if (this.opts.enabled && this.target.host) this.refresh(true).catch(() => {});
    }
    this._saveWebshare();
    this._save();
    return this.webshareActive();
  }

  /* ── persistence ── */
  _load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (typeof raw.enabled === 'boolean') this.opts.enabled = raw.enabled;
        if (raw.maxPerIp) this.opts.maxPerIp = clamp(Number(raw.maxPerIp) || this.opts.maxPerIp, 1, 50);
        if (raw.assignments && typeof raw.assignments === 'object') {
          Object.keys(raw.assignments).forEach((k) => this.assignments.set(k, raw.assignments[k]));
        }
        if (Array.isArray(raw.static)) {
          this.static = raw.static.filter((p) => p && p.host && p.port).map((p) => ({
            host: p.host, port: Number(p.port),
            protocol: p.protocol === 'http' ? 'http' : 'socks5',
            region: p.region || '',
            username: p.username || undefined, password: p.password || undefined,
          }));
        }
        if (Array.isArray(raw.alive)) {
          raw.alive.forEach((p) => {
            if (!p || !p.host || !p.port) return;
            const key = p.host + ':' + p.port;
            this.alive.set(key, {
              key, host: p.host, port: Number(p.port),
              protocol: p.protocol === 'http' ? 'http' : 'socks5',
              region: p.region || '',
              username: p.username || undefined, password: p.password || undefined,
              latency: Number(p.latency) || 999, okAt: Number(p.okAt) || 0,
              fails: Number(p.fails) || 0,
              failStreak: Number(p.failStreak) || 0,
              successes: Number(p.successes) || 0,
              sessions: Number(p.sessions) || 0,
              totalUptimeMs: Number(p.totalUptimeMs) || 0,
              lifetimeUptimeMs: Number(p.lifetimeUptimeMs) || Number(p.totalUptimeMs) || 0,
              bestUptimeMs: Number(p.bestUptimeMs) || 0,
              shortSessions: Number(p.shortSessions) || 0,
              longSessions: Number(p.longSessions) || 0,
              recent: Array.isArray(p.recent)
                ? p.recent.slice(-10).map((r) => ({ ms: Number(r && r.ms) || 0, at: Number(r && r.at) || 0 }))
                : [],
              checkedAt: Number(p.checkedAt) || 0,
              quarantineUntil: Number(p.quarantineUntil) || 0,
              retired: !!p.retired,
              lastFail: Number(p.lastFail) || 0,
              gameFailures: Number(p.gameFailures) || 0,
              source: p.source || 'cache', checked: false,
            });
          });
        }
        this.lastRefresh = Number(raw.lastRefresh) || 0;
      }
    } catch (_) {}
  }

  _save() {
    if (!this.file) return;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const alive = Array.from(this.alive.values())
          .sort((a, b) => a.latency - b.latency)
          .slice(0, 400)
          .map((p) => ({
            host: p.host, port: p.port, protocol: p.protocol, region: p.region || '',
            latency: p.latency, okAt: p.okAt, source: p.source,
            fails: p.fails || 0, failStreak: p.failStreak || 0, successes: p.successes || 0,
            sessions: p.sessions || 0, totalUptimeMs: p.totalUptimeMs || 0,
            lifetimeUptimeMs: p.lifetimeUptimeMs || p.totalUptimeMs || 0,
            bestUptimeMs: p.bestUptimeMs || 0, shortSessions: p.shortSessions || 0,
            longSessions: p.longSessions || 0,
            recent: Array.isArray(p.recent) ? p.recent.slice(-10) : [],
            checkedAt: p.checkedAt || 0, quarantineUntil: p.quarantineUntil || 0,
            retired: !!p.retired, lastFail: p.lastFail || 0,
            gameFailures: p.gameFailures || 0,
          }));
        const assignments = {};
        this.assignments.forEach((v, k) => { assignments[k] = v; });
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({
          enabled: this.opts.enabled,
          maxPerIp: this.opts.maxPerIp,
          lastRefresh: this.lastRefresh,
          static: this.static,
          alive,
          assignments,
          savedAt: Date.now(),
        }, null, 2));
        fs.renameSync(tmp, this.file);
      } catch (e) { this.lastError = 'save: ' + e.message; }
    }, 800);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  /* ── discovery ── */
  _fetch(url) {
    return new Promise((resolve) => {
      let req;
      const fail = () => { try { req && req.destroy(); } catch (_) {} resolve([]); };
      try {
        req = https.get(url, { timeout: 12000, headers: { 'user-agent': 'Mozilla/5.0 (mcbot proxy pool)' } }, (res) => {
          if (res.statusCode !== 200) { res.resume(); return resolve([]); }
          let size = 0;
          const chunks = [];
          res.on('data', (c) => {
            size += c.length;
            if (size > 4 * 1024 * 1024) { req.destroy(); return; }
            chunks.push(c);
          });
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').split(/\r?\n/)));
          res.on('error', fail);
        });
        req.on('timeout', fail);
        req.on('error', fail);
      } catch (_) { resolve([]); }
    });
  }

  _parseLine(line, region) {
    let s = String(line || '').trim();
    if (!s || s.startsWith('#')) return null;
    let protocol = 'socks5';
    const scheme = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    if (scheme) {
      const p = scheme[1].toLowerCase();
      if (p === 'socks4' || p === 'socks4a') return null; // unsupported by this client
      protocol = p.indexOf('http') === 0 ? 'http' : 'socks5';
      s = s.slice(scheme[0].length);
    }
    s = s.split(/[\s,;|]/)[0];
    let user = '', pass = '';
    const credsAt = s.lastIndexOf('@');
    if (credsAt > 0) {
      const creds = s.slice(0, credsAt);
      s = s.slice(credsAt + 1);
      const ci = creds.indexOf(':');
      if (ci > 0) { user = creds.slice(0, ci); pass = creds.slice(ci + 1); }
      else user = creds;
    }
    const m = s.match(/^\[?([0-9a-fA-F:.]+?)\]?:(\d{1,5})$/);
    if (!m) return null;
    const host = m[1];
    const port = Number(m[2]);
    if (!port || port > 65535) return null;
    if (!net.isIP(host)) return null; // skip hostnames: too slow to re-resolve
    return { host, port, protocol, region: region || '', username: user || undefined, password: pass || undefined };
  }

  async _discover() {
    const lists = await Promise.all(SOURCES.map(async (s) => {
      const lines = await this._fetch(s.url).catch(() => []);
      if (s.parse !== 'roundproxies' || !lines.length) return lines;
      try {
        const j = JSON.parse(lines.join(''));
        return (j.data || [])
          .filter((x) => x.ip && x.port && (x.protocols || []).some((p) => p !== 'socks4'))
          .sort((a, b) => (b.upTime || 0) - (a.upTime || 0) || (a.latency || 99999) - (b.latency || 99999))
          .map((x) => {
            const proto = (x.protocols || []).find((p) => p !== 'socks4');
            return `${proto.indexOf('socks') === 0 ? 'socks5' : 'http'}://${x.ip}:${x.port}`;
          });
      } catch (_) { return []; }
    }));
    const seen = new Set();
    const out = [];
    lists.forEach((lines, i) => {
      const region = SOURCES[i].region || '';
      // Keep one feed from swallowing the validation budget.
      const cap = region === 'asia' ? 40 : 120;
      lines.slice(0, cap).forEach((line) => {
        const p = this._parseLine(line, region);
        if (!p) return;
        const key = p.host + ':' + p.port;
        if (seen.has(key)) return;
        if (this.assignments.size) {
          // Never re-add something we already dropped as dead this cycle.
          const prev = this.alive.get(key);
          if (prev && prev.fails >= 2) return;
        }
        seen.add(key);
        out.push(p);
      });
    });
    // Shuffle so a single big list can't monopolise the validation budget.
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out.slice(0, this.opts.maxCandidates);
  }

  async _validate(list, source) {
    const results = [];
    let idx = 0;
    const workers = new Array(Math.min(this.opts.validateConcurrency, list.length || 1)).fill(0).map(async () => {
      while (idx < list.length) {
        const p = list[idx++];
        try {
          // Endpoint-only check: no game-server tunnel from the validator.
          const latency = await this.probe(p, this.opts.validateTimeout);
          // Keep a curated proxy's 'user' tag so pick() can prioritise it;
          // only untagged discoveries get the feed's source name.
          results.push({ ...p, latency, okAt: Date.now(), source: p.source || source || 'list' });
        } catch (_) { /* dead */ }
      }
    });
    await Promise.all(workers);
    return results;
  }

  async refresh(force) {
    if (this.refreshing) return this.status();
    if (!this.opts.enabled) return this.status();
    // Rotating tunnels do not use the public pool — no point validating
    // hundreds of SOCKS5 routes against another server in the background.
    if (this.webshareActive() && !force) return this.status();
    if (!this.target.host) return this.status();
    if (!force && Date.now() - this.lastRefresh < 60000) return this.status();
    this.refreshing = true;
    const t0 = Date.now();
    try {
      const discovered = this.opts.enabled ? await this._discover() : [];
      // Curated proxies from data/proxies.json are validated first and given
      // priority by pick(); discovered routes are backup only.
      const candidates = (this.static.length ? this.static.map((p) => ({ ...p, source: 'user' })) : [])
        .concat(discovered);
      const fresh = await this._validate(candidates, 'live');
      fresh.forEach((p) => this._upsert(p, true));
      this.lastRefresh = Date.now();
      this.lastError = '';
      const curated = fresh.filter((p) => p.source === 'user').length;
      this.log(`proxy pool: ${fresh.length}/${candidates.length} alive (${curated} curated) in ${((Date.now() - t0) / 1000).toFixed(1)}s (${this.alive.size} total)`);
      this._pruneAssignments();
      this._save();
    } catch (e) {
      this.lastError = e.message || String(e);
    } finally {
      this.refreshing = false;
    }
    return this.status();
  }

  async _revalidateCached() {
    if (this.webshareActive()) return;
    if (!this.alive.size || !this.target.host) return;
    const list = Array.from(this.alive.values()).map((p) => ({
      host: p.host, port: p.port, protocol: p.protocol,
      username: p.username, password: p.password, source: p.source, region: p.region,
    }));
    const ok = await this._validate(list, 'cached');
    // Boot revalidation only refreshes latency. Scoring (success weight,
    // cooldown, retirement) belongs to the 3-minute health sweep so a slow
    // startup test cannot quarantine a route before the bots even connect.
    ok.forEach((p) => this._upsert(p, false));
    this._pruneAssignments();
    this._save();
  }

  /* ── rolling health sweep ─────────────────────────────────────────────── */
  /** Every three minutes: probe idle routes, reward the ones that answer,
   *  and park the ones that time out so later sweeps do not waste time on
   *  them. Bot connect/spawn callbacks feed the same score. */
  async healthCheck(force) {
    if (!this.opts.enabled || !this.target.host || this.webshareActive()) return this.status();
    if (this.healthBusy && !force) return this.status();
    this.healthBusy = true;
    const started = Date.now();
    let okCount = 0;
    let failCount = 0;
    try {
      const used = new Set(this.assignments.values());
      const list = Array.from(this.alive.values())
        .filter((p) => !used.has(p.key) && !isQuarantined(p, started))
        .sort((a, b) => (a.checkedAt || a.okAt || 0) - (b.checkedAt || b.okAt || 0))
        .slice(0, HEALTH_BATCH);
      // Curated routes that were never validated get one chance too.
      this.static.forEach((s) => {
        if (list.length >= HEALTH_BATCH) return;
        const key = s.host + ':' + s.port;
        if (this.alive.has(key) || used.has(key)) return;
        list.push({ ...s, ip: s.host, key, source: 'user' });
      });
      let idx = 0;
      await Promise.all(new Array(Math.min(HEALTH_CONCURRENCY, Math.max(1, list.length))).fill(0).map(async () => {
        while (idx < list.length) {
          const p = list[idx++];
          try {
            // Endpoint probe only. Tunnel validation is left to real bot
            // joins so the health sweep cannot disturb live game sessions.
            const latency = await this.probe(p, HEALTH_TIMEOUT_MS);
            this._healthOk(p, latency, true);
            okCount++;
          } catch (e) {
            const msg = String((e && e.message) || e || '');
            this._healthFail(p, /timeout|timed out|ETIMEDOUT/i.test(msg) ? 'timeout' : 'error');
            failCount++;
          }
        }
      }));
      this.lastHealthCheck = Date.now();
      this.log(`proxy health (endpoints): ${okCount} ok, ${failCount} failed in ${((this.lastHealthCheck - started) / 1000).toFixed(1)}s`);
      this._pruneAssignments();
      this._save();
    } finally {
      this.healthBusy = false;
    }
    return this.status();
  }

  _healthOk(proxy, latency, count) {
    const key = (proxy && (proxy.ip || proxy.host)) + ':' + (proxy && proxy.port);
    const p = this.alive.get(key);
    if (!p) return;
    const now = Date.now();
    if (count && now - (p.okAt || 0) > 15000) {
      p.successes = Math.min(60, (p.successes || 0) + 1);
    }
    p.fails = 0;
    p.failStreak = 0;
    p.quarantineUntil = 0;
    // A retired route stays retired until an explicit reset. An endpoint can
    // answer TCP while still killing live game sessions, so a successful probe
    // must never resurrect it.
    p.lastReason = '';
    const sample = clamp(Number(latency) || 3000, 20, 12000);
    p.latency = Math.round((Number(p.latency) || sample) * 0.65 + sample * 0.35);
    p.checkedAt = now;
    p.okAt = now;
  }

  _healthFail(proxy, reason) {
    if (!proxy) return;
    const key = (proxy.ip || proxy.host) + ':' + proxy.port;
    let p = this.alive.get(key);
    if (!p) {
      p = {
        key, host: proxy.ip || proxy.host, port: Number(proxy.port),
        protocol: proxy.protocol === 'http' ? 'http' : 'socks5',
        region: proxy.region || '', latency: Number(proxy.latency) || 999,
        source: proxy.source || 'user', fails: 0, failStreak: 0, successes: 0,
        checkedAt: 0, quarantineUntil: 0, retired: false, lastFail: 0,
      };
      this.alive.set(key, p);
    }
    const now = Date.now();
    // One route can report the same failed attempt from the dial and from the
    // handshake. Count it once, not twice.
    if (now - (p.lastFail || 0) < FAIL_DEDUPE_MS) return;
    p.lastFail = now;
    p.checkedAt = now;
    p.fails = (p.fails || 0) + 1;
    p.failStreak = (p.failStreak || 0) + 1;
    p.lastReason = reason || 'error';
    if (p.failStreak >= RETIRE_AFTER) {
      p.retired = true;
      p.quarantineUntil = 0;
      this.log(`proxy health: retired ${key} after ${p.failStreak} failures`);
    } else {
      const step = clamp(p.failStreak - 1, 0, QUARANTINE_STEPS.length - 1);
      p.quarantineUntil = now + QUARANTINE_STEPS[step];
    }
    this._save();
  }

  resetHealth() {
    this.alive.forEach((p) => {
      p.fails = 0;
      p.failStreak = 0;
      p.successes = 0;
      p.checkedAt = 0;
      p.quarantineUntil = 0;
      p.retired = false;
      p.lastFail = 0;
      p.lastReason = '';
    });
    this._save();
    return this.status();
  }

  _upsert(p, isNew) {
    const key = p.host + ':' + p.port;
    const cur = this.alive.get(key);
    if (cur) {
      cur.latency = Math.min(cur.latency || 99999, p.latency);
      cur.okAt = p.okAt || Date.now();
      cur.fails = 0;
      cur.checked = true;
      if (p.protocol) cur.protocol = p.protocol;
      if (p.region) cur.region = p.region;
      if (p.username) cur.username = p.username;
      if (p.password) cur.password = p.password;
      return cur;
    }
    // Keep the live map small: discovery can find thousands of endpoints, but
    // only a capped set is useful. Curated/user routes are always allowed in.
    if (this.alive.size >= (Number(this.opts.maxPool) || 400) && p.source !== 'user') return null;
    const rec = {
      key, host: p.host, port: Number(p.port),
      protocol: p.protocol === 'http' ? 'http' : 'socks5',
      region: p.region || '',
      username: p.username, password: p.password,
      latency: p.latency, okAt: p.okAt || Date.now(),
      fails: 0, source: p.source || 'list', checked: true,
    };
    this.alive.set(key, rec);
    return rec;
  }

  // Keep the pin table honest: no dead routes, no deleted bots, no duplicate
  // pins, never more than maxPerIp bots on the same address. Stale pins were
  // the reason removed bots kept holding IPs (and new bots shared the rest).
  _pruneAssignments() {
    let changed = false;
    const validIds = this._botIds ? new Set(this._botIds()) : null;
    const usedKeys = new Set();
    const perIp = new Map();
    this.assignments.forEach((key, botId) => {
      const virtual = key.indexOf('webshare:') === 0;
      const p = virtual ? null : this.alive.get(key);
      // A virtual pin is its own address: each bot gets a fresh tunnel/IP.
      const bucket = virtual ? key : (p && p.host);
      if (!bucket || (virtual && (!this.webshare.enabled || !this.webshare.username))
          || (validIds && !validIds.has(botId)) || usedKeys.has(key)
          || (perIp.get(bucket) || 0) >= this.opts.maxPerIp) {
        this.assignments.delete(botId);
        changed = true;
        return;
      }
      usedKeys.add(key);
      perIp.set(bucket, (perIp.get(bucket) || 0) + 1);
    });
    if (changed) this._save();
  }

  /* ── assignment ── */
  /** Pin usage counted by real IP, not by host:port — two ports on one box
   *  still mean one egress address. */
  _ipCounts(exceptBotId) {
    const counts = new Map();
    this.assignments.forEach((key, botId) => {
      if (botId === exceptBotId) return;
      const virtual = key.indexOf('webshare:') === 0;
      const p = virtual ? null : this.alive.get(key);
      if (!virtual && !p) return;
      const bucket = virtual ? key : p.host;
      counts.set(bucket, (counts.get(bucket) || 0) + 1);
    });
    return counts;
  }

  /** Sticky proxy for a bot, or null when the pool is empty/disabled. */
  pick(botId, name) {
    if (!this.opts.enabled) return null;
    if (name) this.names.set(botId, name);
    this._pruneAssignments();
    if (this.webshareActive()) {
      // Every CONNECT to the rotating endpoint exits at a different IP, so
      // each bot gets its own tunnel and its own address.
      const key = 'webshare:' + botId;
      this.assignments.set(botId, key);
      this._save();
      return {
        ip: this.webshare.host, port: this.webshare.port, key,
        username: this.webshare.username, password: this.webshare.password,
        protocol: 'http', virtual: true, latency: 0,
      };
    }
    const now = Date.now();
    const assigned = this.assignments.get(botId);
    if (assigned) {
      const p = this.alive.get(assigned);
      // A retired/quarantined sticky route must not survive just because the
      // bot still has an assignment. Otherwise the same dead IP is retried
      // after every reconnect, which is the 4–6 minute disconnect loop.
      if (p && !p.retired && !(p.quarantineUntil > now)) return this._public(p);
      this.assignments.delete(botId);
      this._save();
    }
    if (!this.alive.size) return null;
    const perIp = this._ipCounts(botId);
    const candidates = Array.from(this.alive.values())
      .filter((p) => !isQuarantined(p, now) && (perIp.get(p.host) || 0) < this.opts.maxPerIp);
    if (!candidates.length) return null;
    // The longest-lived routes win first: clean one-hour+ sessions, then
    // recovering/trial routes, then curated bootstrap routes, then public
    // Asian routes. Lifetime uptime breaks ties before latency, so a route
    // that has stayed online for hours is preferred over a fast newcomer.
    const tierRank = (p) => {
      const tier = uptimeTier(p);
      if (tier === 'good') return 0;
      if (tier === 'trial') return 1;
      if (p.source === 'user') return 2;
      if (p.region === 'asia') return 3;
      return 4;
    };
    const tiered = candidates.slice().sort((a, b) => tierRank(a) - tierRank(b)
      || (b.totalUptimeMs || 0) - (a.totalUptimeMs || 0)
      || healthCost(a) - healthCost(b));
    const bestRank = tierRank(tiered[0]);
    const tier = tiered.filter((p) => tierRank(p) === bestRank);
    const free = tier.filter((p) => !perIp.has(p.host));
    const pool = free.length ? free : tier;
    const ranked = pool; // already tier-ranked, then lifetime-ranked
    const best = ranked.slice(0, Math.min(12, ranked.length));
    // Weighted random: a route with N confirmed wins is N+1 times as likely
    // as an untested one, but no single fast route swallows the whole fleet.
    const weights = best.map((p) => 1 + Math.min(20, p.successes || 0));
    let roll = Math.random() * weights.reduce((a, b) => a + b, 0);
    let chosen = best[best.length - 1];
    for (let i = 0; i < best.length; i++) {
      roll -= weights[i];
      if (roll <= 0) { chosen = best[i]; break; }
    }
    this.assignments.set(botId, chosen.key);
    this._save();
    return this._public(chosen);
  }

  /** Cheap liveness probe: open a TCP socket to the proxy endpoint only.
   *  Never tunnel to the game server from background validation — hundreds of
   *  tunnels in three minutes made Velocity drop active bot sessions. A real
   *  bot join/spawn is the only proof a route can actually reach the server. */
  probe(proxy, timeoutMs) {
    const host = proxy && (proxy.ip || proxy.host);
    const port = Number(proxy && proxy.port);
    if (!host || !port) return Promise.reject(new Error('no proxy endpoint'));
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      let done = false;
      let sock = null;
      const finish = (err, ms) => {
        if (done) return;
        done = true;
        try { sock.setTimeout(0); sock.destroy(); } catch (_) {}
        if (err) reject(err); else resolve(ms);
      };
      sock = net.connect({ host, port });
      sock.setTimeout(timeoutMs || HEALTH_TIMEOUT_MS, () => finish(new Error('timeout')));
      sock.once('connect', () => finish(null, Date.now() - t0));
      sock.once('error', (e) => finish(e));
      sock.once('close', () => finish(new Error('closed')));
    });
  }

  /** Dial the game server through a proxy, resolving a ready socket. */
  open(proxy, host, port, timeoutMs) {
    if (!proxy) return Promise.reject(new Error('no proxy'));
    const target = { host: proxy.ip || proxy.host, port: proxy.port, username: proxy.username, password: proxy.password };
    const destHost = host || this.target.host;
    const destPort = port || this.target.port;
    if (proxy.protocol === 'http') return httpConnect(target, destHost, destPort, timeoutMs || 9000);
    return socks5Connect(target, destHost, destPort, timeoutMs || 8000);
  }

  reportOk(proxy) {
    if (!proxy) return;
    this._healthOk(proxy, proxy.latency, true);
  }

  /** Fold one completed live session into the route's uptime history. A
   *  short session is a real disconnect, not a handshake failure: two of them
   *  cool the route for ten minutes and three retire it permanently. */
  reportSession(proxy, durationMs, reason) {
    if (!proxy) return null;
    const key = (proxy.ip || proxy.host) + ':' + proxy.port;
    const p = this.alive.get(key);
    if (!p) return null;
    recordSession(p, durationMs);
    if (p.shortSessions === 2) {
      p.quarantineUntil = Date.now() + 10 * 60 * 1000;
      this.log(`proxy health: ${key} cooled down after two short sessions`);
    } else if (p.shortSessions >= 3) {
      p.retired = true;
      p.quarantineUntil = 0;
      this.log(`proxy health: retired ${key} after three short sessions`);
    }
    this._save();
    return uptimeTier(p);
  }

  reportFailure(proxy) {
    if (!proxy) return;
    this._healthFail(proxy, 'handshake');
  }

  /** The route connected fine but the game server kept resetting the player
   *  back to spawn. Cool it down instead of retiring it on a single walk: some
   *  endpoints recover, but they must not be picked again immediately. */
  reportWalkFailure(proxy) {
    if (!proxy) return;
    const key = `${proxy.ip || proxy.host}:${proxy.port}`;
    const p = this.alive.get(key);
    if (!p) return;
    p.quarantineUntil = Date.now() + 10 * 60 * 1000;
    p.failStreak = (p.failStreak || 0) + 1;
    this._save();
    this.log(`proxy health: ${key} cooled down after an AFK rubber-band`);
  }

  /** A route that kills an already-connected session is worse than one that
   *  times out during setup, but a single Velocity hiccup is not proof the IP
   *  is dead. Cool it down twice, then retire it on the third confirmed drop. */
  reportGameFailure(proxy) {
    if (!proxy) return;
    const key = (proxy.ip || proxy.host) + ':' + proxy.port;
    const p = this.alive.get(key);
    if (!p || p.retired) return;
    const now = Date.now();
    p.gameFailures = (p.gameFailures || 0) + 1;
    p.fails = (p.fails || 0) + 1;
    p.failStreak = (p.failStreak || 0) + 1;
    p.lastFail = now;
    if (p.gameFailures >= GAME_RETIRE_AFTER) {
      p.retired = true;
      p.quarantineUntil = 0;
      this.log(`proxy health: retired ${key} after ${p.gameFailures} live-session failures`);
    } else {
      p.quarantineUntil = now + GAME_COOLDOWNS[p.gameFailures - 1];
      this.log(`proxy health: ${key} cooled down after live-session failure ${p.gameFailures}`);
    }
    this._save();
  }

  /** A route with real uptime evidence is worth another attempt: losing the
   *  sticky assignment would let another bot take the proven IP while its
   *  owner reconnects. Unproven routes are released so a bad IP is not retried. */
  isProvenRoute(proxy) {
    const key = proxy && ((proxy.ip || proxy.host) + ':' + proxy.port);
    const p = key && this.alive.get(key);
    if (!p || p.retired || p.quarantineUntil > Date.now()) return false;
    const tier = uptimeTier(p);
    return tier === 'good' || tier === 'trial'
      || (Number(p.bestUptimeMs) || 0) >= 10 * 60 * 1000;
  }

  /** Called when a bot never reached spawn. Report the failure, but keep the
   *  pin on a proven route so no other bot can steal that address. */
  handleHandshakeFailure(botId, proxy) {
    const proven = this.isProvenRoute(proxy);
    this.reportFailure(proxy);
    if (!proven) this.release(botId);
    return proven;
  }

  release(botId) {
    if (!botId) return;
    this.assignments.delete(botId);
    this._save();
  }

  /** Re-pin a bot to the proxy its live socket is actually using. Reshuffles
   *  must not leave connected bots unpinned, or pick() can hand their IP to
   *  another bot and break the one-bot-per-IP rule. */
  hold(botId, proxy) {
    if (!botId || !proxy) return;
    const key = proxy.key || `${proxy.ip || proxy.host}:${proxy.port}`;
    if (!String(key).startsWith('webshare:') && !this.alive.has(key)) return;
    if (this.assignments.get(botId) === key) return;
    this.assignments.set(botId, key);
    this._save();
  }

  /** Re-home every bot (used by the "reshuffle" button). */
  reshuffle() {
    this.assignments.clear();
    this.names.clear();
    this._save();
  }

  _public(p) {
    return {
      ip: p.host,
      port: p.port,
      key: p.key,
      protocol: p.protocol === 'http' ? 'http' : 'socks5',
      region: p.region || '',
      latency: p.latency,
      username: p.username,
      password: p.password,
    };
  }

  assignmentFor(botId) {
    const key = this.assignments.get(botId);
    if (!key) return null;
    const p = this.alive.get(key);
    return p ? this._public(p) : null;
  }

  summary() {
    const now = Date.now();
    let healthy = 0;
    this.alive.forEach((p) => { if (!isQuarantined(p, now)) healthy++; });
    return { enabled: this.opts.enabled, total: healthy, assigned: this.assignments.size };
  }

  status() {
    const botsByKey = new Map();
    const perIp = new Map();
    let webshareBots = 0;
    let collisions = 0;
    this.assignments.forEach((key, botId) => {
      if (!botsByKey.has(key)) botsByKey.set(key, []);
      botsByKey.get(key).push(this.names.get(botId) || botId);
      const virtual = key.indexOf('webshare:') === 0;
      if (virtual) { webshareBots++; return; }
      const p = this.alive.get(key);
      if (!p) return;
      perIp.set(p.host, (perIp.get(p.host) || 0) + 1);
      if (perIp.get(p.host) > 1) collisions++;
    });
    const now = Date.now();
    let quarantined = 0;
    let retired = 0;
    let proven = 0;
    const good = [];
    const proxies = Array.from(this.alive.values())
      .sort((a, b) => healthCost(a) - healthCost(b))
      .map((p) => {
        if (p.retired) retired++;
        else if ((p.quarantineUntil || 0) > now) quarantined++;
        if ((p.successes || 0) > 0) proven++;
        const uptime = uptimeSummary(p);
        if (uptime.tier === 'good' && !isQuarantined(p, now)) {
          good.push({
            key: p.key,
            ip: p.host,
            port: p.port,
            lifetimeUptimeSec: uptime.lifetimeUptimeSec,
            bestUptimeSec: uptime.bestUptimeSec,
            sessions: uptime.sessions,
          });
        }
        return {
          ip: p.host,
          port: p.port,
          key: p.key,
          protocol: p.protocol || 'socks5',
          region: p.region || '',
          latency: p.latency,
          okAt: p.okAt,
          fails: p.fails || 0,
          failStreak: p.failStreak || 0,
          successes: p.successes || 0,
          ...uptime,
          checkedAt: p.checkedAt || 0,
          quarantineUntil: p.quarantineUntil || 0,
          retired: !!p.retired,
          lastReason: p.lastReason || '',
          score: Math.round(10000 / (1 + healthCost(p) / 100)),
          source: p.source,
          bots: botsByKey.get(p.key) || [],
        };
      });
    good.sort((a, b) => b.lifetimeUptimeSec - a.lifetimeUptimeSec);
    return {
      enabled: this.opts.enabled,
      maxPerIp: this.opts.maxPerIp,
      total: this.alive.size,
      assigned: this.assignments.size,
      uniqueIps: perIp.size,
      collisions,
      refreshing: this.refreshing,
      lastRefresh: this.lastRefresh,
      nextRefresh: this.lastRefresh ? this.lastRefresh + this.opts.refreshMs : null,
      health: {
        intervalMs: HEALTH_CHECK_MS,
        lastCheck: this.lastHealthCheck,
        nextCheck: this.lastHealthCheck ? this.lastHealthCheck + HEALTH_CHECK_MS : null,
        checking: this.healthBusy,
        healthy: this.alive.size - quarantined - retired,
        quarantined,
        retired,
        proven,
      },
      target: this.target,
      lastError: this.lastError,
      sources: SOURCES.length,
      webshare: {
        enabled: this.webshare.enabled && !!this.webshare.username,
        host: this.webshare.host,
        port: this.webshare.port,
        user: this.webshare.username ? this.webshare.username.slice(0, 4) + '••••' : '',
        mode: 'rotating',
        bots: webshareBots,
      },
      good,
      proxies,
    };
  }
}

module.exports = new ProxyPool();
module.exports.socks5Connect = socks5Connect;
module.exports.httpConnect = httpConnect;
module.exports.isLocalTarget = isLocalTarget;
