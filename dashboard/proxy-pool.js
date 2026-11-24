'use strict';
/**
 * Proxy pool — automatic SOCKS5 discovery, validation and sticky assignment.
 *
 *  · Fetches free SOCKS5 lists from several public sources.
 *  · Validates each candidate by opening a real SOCKS5 tunnel to the Minecraft
 *    server the bots use, and keeps the ones that answer fast.
 *  · Hands each bot a sticky proxy (same IP across reconnects) and never puts
 *    more than `maxPerIp` bots behind one IP.
 *  · Anything that fails twice is dropped and its bots are re-homed.
 *
 * Everything degrades safely: if no proxy is alive, callers fall back to a
 * direct connection so bots always come back online.
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const https = require('https');

const SOURCES = [
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=ipport&format=text',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
  'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt',
  'https://openproxylist.xyz/socks5.txt',
];

const DEFAULTS = {
  enabled: true,
  maxPerIp: 5,
  validateTimeout: 4500,
  validateConcurrency: 50,
  maxCandidates: 700,
  refreshMs: 12 * 60 * 1000,   // full re-discover
  pruneMs: 4 * 60 * 1000,      // re-check what we already have
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

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

/* ── pool ────────────────────────────────────────────────────────────────── */

class ProxyPool {
  constructor() {
    this.opts = Object.assign({}, DEFAULTS);
    this.file = null;
    this.target = { host: '', port: 25565 };
    this.alive = new Map();       // key -> { key, host, port, latency, okAt, fails, source }
    this.assignments = new Map(); // botId -> key
    this.names = new Map();       // botId -> bot name (display only)
    this.lastRefresh = 0;
    this.refreshing = false;
    this.lastError = '';
    this.timers = [];
    this._saveTimer = null;
    this.log = () => {};
  }

  init({ dataDir, target, log }) {
    if (log) this.log = log;
    if (target && target.host) this.target = { host: target.host, port: target.port || 25565 };
    this.file = path.join(dataDir, 'proxies.json');
    this._load();
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
      setInterval(() => this._revalidateCached().catch(() => {}), this.opts.pruneMs),
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
    this.opts.maxPerIp = clamp(Number(n) || 5, 1, 50);
    this._save();
    return this.opts.maxPerIp;
  }

  /* ── persistence ── */
  _load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (typeof raw.enabled === 'boolean') this.opts.enabled = raw.enabled;
        if (raw.maxPerIp) this.opts.maxPerIp = clamp(Number(raw.maxPerIp) || 5, 1, 50);
        if (raw.assignments && typeof raw.assignments === 'object') {
          Object.keys(raw.assignments).forEach((k) => this.assignments.set(k, raw.assignments[k]));
        }
        if (Array.isArray(raw.alive)) {
          raw.alive.forEach((p) => {
            if (!p || !p.host || !p.port) return;
            const key = p.host + ':' + p.port;
            this.alive.set(key, {
              key, host: p.host, port: Number(p.port),
              latency: Number(p.latency) || 999, okAt: Number(p.okAt) || 0,
              fails: 0, source: p.source || 'cache', checked: false,
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
          .map((p) => ({ host: p.host, port: p.port, latency: p.latency, okAt: p.okAt, source: p.source }));
        const assignments = {};
        this.assignments.forEach((v, k) => { assignments[k] = v; });
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({
          enabled: this.opts.enabled,
          maxPerIp: this.opts.maxPerIp,
          lastRefresh: this.lastRefresh,
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

  _parseLine(line) {
    let s = String(line || '').trim();
    if (!s || s.startsWith('#')) return null;
    s = s.replace(/^socks5h?:\/\//i, '').replace(/^https?:\/\//i, '');
    s = s.split(/[\s,;|]/)[0];
    let user = '', pass = '';
    if (s.includes('@')) {
      const [creds, rest] = s.split('@');
      s = rest;
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
    return { host, port, username: user || undefined, password: pass || undefined };
  }

  async _discover() {
    const lists = await Promise.all(SOURCES.map((u) => this._fetch(u).catch(() => [])));
    const seen = new Set();
    const out = [];
    lists.forEach((lines) => {
      lines.forEach((line) => {
        const p = this._parseLine(line);
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
        const t0 = Date.now();
        try {
          const sock = await socks5Connect(p, this.target.host, this.target.port, this.opts.validateTimeout);
          const latency = Date.now() - t0;
          try { sock.destroy(); } catch (_) {}
          results.push({ ...p, latency, okAt: Date.now(), source: source || p.source || 'list' });
        } catch (_) { /* dead */ }
      }
    });
    await Promise.all(workers);
    return results;
  }

  async refresh(force) {
    if (this.refreshing) return this.status();
    if (!this.opts.enabled) return this.status();
    if (!this.target.host) return this.status();
    if (!force && Date.now() - this.lastRefresh < 60000) return this.status();
    this.refreshing = true;
    const t0 = Date.now();
    try {
      const candidates = await this._discover();
      const fresh = await this._validate(candidates, 'live');
      fresh.forEach((p) => this._upsert(p, true));
      this.lastRefresh = Date.now();
      this.lastError = '';
      this.log(`proxy pool: ${fresh.length}/${candidates.length} alive in ${((Date.now() - t0) / 1000).toFixed(1)}s (${this.alive.size} total)`);
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
    if (!this.alive.size || !this.target.host) return;
    const list = Array.from(this.alive.values()).map((p) => ({ host: p.host, port: p.port, source: p.source }));
    const ok = await this._validate(list, 'cached');
    const nowKey = new Set(ok.map((p) => p.host + ':' + p.port));
    // Anything that failed once keeps its slot until it fails twice.
    list.forEach((p) => {
      const key = p.host + ':' + p.port;
      if (nowKey.has(key)) return;
      const cur = this.alive.get(key);
      if (!cur) return;
      cur.fails = (cur.fails || 0) + 1;
      if (cur.fails >= 2) this.alive.delete(key);
    });
    ok.forEach((p) => this._upsert(p, false));
    this._pruneAssignments();
    this._save();
  }

  _upsert(p, isNew) {
    const key = p.host + ':' + p.port;
    const cur = this.alive.get(key);
    if (cur) {
      cur.latency = Math.min(cur.latency || 99999, p.latency);
      cur.okAt = p.okAt || Date.now();
      cur.fails = 0;
      cur.checked = true;
      return cur;
    }
    const rec = {
      key, host: p.host, port: Number(p.port),
      latency: p.latency, okAt: p.okAt || Date.now(),
      fails: 0, source: p.source || 'list', checked: true,
    };
    this.alive.set(key, rec);
    return rec;
  }

  // If a proxy vanished, its bots must be re-homed for the next connect.
  _pruneAssignments() {
    let changed = false;
    this.assignments.forEach((key, botId) => {
      if (!this.alive.has(key)) { this.assignments.delete(botId); changed = true; }
    });
    if (changed) this._save();
  }

  /* ── assignment ── */
  _counts(exceptKey) {
    const counts = new Map();
    this.assignments.forEach((key, botId) => {
      if (key === exceptKey) return;
      if (!this.alive.has(key)) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return counts;
  }

  /** Sticky proxy for a bot, or null when the pool is empty/disabled. */
  pick(botId, name) {
    if (!this.opts.enabled) return null;
    if (name) this.names.set(botId, name);
    const assigned = this.assignments.get(botId);
    if (assigned) {
      const p = this.alive.get(assigned);
      if (p) return this._public(p);
      this.assignments.delete(botId);
    }
    if (!this.alive.size) return null;
    const counts = this._counts(null);
    // Pack, don't spread: fill the fullest route that still has a free slot, so
    // ten bots land on 5 + 5 rather than ten separate addresses.
    const candidates = Array.from(this.alive.values())
      .filter((p) => (counts.get(p.key) || 0) < this.opts.maxPerIp)
      .sort((a, b) => (counts.get(b.key) || 0) - (counts.get(a.key) || 0) || a.latency - b.latency);
    if (!candidates.length) return null;
    const chosen = candidates[0];
    this.assignments.set(botId, chosen.key);
    this._save();
    return this._public(chosen);
  }

  /** Dial the game server through a proxy, resolving a ready socket. */
  open(proxy, host, port, timeoutMs) {
    if (!proxy) return Promise.reject(new Error('no proxy'));
    return socks5Connect(
      { host: proxy.ip || proxy.host, port: proxy.port, username: proxy.username, password: proxy.password },
      host || this.target.host,
      port || this.target.port,
      timeoutMs || 8000
    );
  }

  reportOk(proxy) {
    if (!proxy) return;
    const key = (proxy.ip || proxy.host) + ':' + proxy.port;
    const p = this.alive.get(key);
    if (p) { p.fails = 0; p.okAt = Date.now(); }
  }

  reportFailure(proxy) {
    if (!proxy) return;
    const key = (proxy.ip || proxy.host) + ':' + proxy.port;
    const p = this.alive.get(key);
    if (!p) return;
    p.fails = (p.fails || 0) + 1;
    p.lastFail = Date.now();
    if (p.fails >= 2) {
      this.alive.delete(key);
      this._pruneAssignments();
      this.log(`proxy pool: dropped ${key} after ${p.fails} failures`);
    }
    this._save();
  }

  release(botId) {
    if (!botId) return;
    this.assignments.delete(botId);
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
    return { enabled: this.opts.enabled, total: this.alive.size, assigned: this.assignments.size };
  }

  status() {
    const botsByKey = new Map();
    this.assignments.forEach((key, botId) => {
      if (!botsByKey.has(key)) botsByKey.set(key, []);
      botsByKey.get(key).push(this.names.get(botId) || botId);
    });
    const proxies = Array.from(this.alive.values())
      .sort((a, b) => a.latency - b.latency)
      .map((p) => ({
        ip: p.host,
        port: p.port,
        key: p.key,
        latency: p.latency,
        okAt: p.okAt,
        fails: p.fails || 0,
        source: p.source,
        bots: botsByKey.get(p.key) || [],
      }));
    return {
      enabled: this.opts.enabled,
      maxPerIp: this.opts.maxPerIp,
      total: this.alive.size,
      assigned: this.assignments.size,
      refreshing: this.refreshing,
      lastRefresh: this.lastRefresh,
      nextRefresh: this.lastRefresh ? this.lastRefresh + this.opts.refreshMs : null,
      target: this.target,
      lastError: this.lastError,
      sources: SOURCES.length,
      proxies,
    };
  }
}

module.exports = new ProxyPool();
module.exports.socks5Connect = socks5Connect;
