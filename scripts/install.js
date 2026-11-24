#!/usr/bin/env node
'use strict';

/*
 * Fast panel install.
 *
 *   npm run setup
 *
 * Installs only the panel's dependencies (mineflayer + what it needs — no
 * Discord bot, no dev tools), rebuilds the minified assets, installs the
 * systemd unit and brings the panel up on port 80. Safe to run again: nothing
 * is downloaded when the dependencies are already present.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DASH = path.join(ROOT, 'dashboard');
const SERVICE = 'mcbot-dashboard.service';
const UNIT = path.join('/etc/systemd/system', SERVICE);
const PORT = parseInt(process.env.PORT || '80', 10);
const started = Date.now();

function say(msg) { console.log(msg); }
function secs() { return ((Date.now() - started) / 1000).toFixed(1); }
function isRoot() { return typeof process.getuid !== 'function' || process.getuid() === 0; }

function run(cmd, args, quiet) {
  const r = spawnSync(cmd, args, { stdio: quiet ? 'ignore' : 'inherit' });
  return r.status === 0;
}
function priv(cmd, args, quiet) {
  if (isRoot()) return run(cmd, args, quiet);
  return run('sudo', ['-n', cmd, ...args], quiet);
}
function hasMineflayer() {
  try { require.resolve('mineflayer', { paths: [DASH] }); return true; }
  catch (_) { return false; }
}
function lanUrl() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return `http://${net.address}/`;
    }
  }
  return `http://localhost${PORT === 80 ? '' : `:${PORT}`}/`;
}
function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/auth', timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode > 0);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}
async function waitForPanel() {
  for (let i = 0; i < 20; i += 1) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

(async () => {
  say('\n  MCBot Control — fast setup\n');

  if (parseInt(process.versions.node, 10) < 18) {
    console.error('  Node.js 18+ is required.');
    process.exit(1);
  }

  if (hasMineflayer()) {
    say('  ✓ Panel dependencies already installed');
  } else {
    say('  → Installing panel dependencies (mineflayer only)…');
    const flags = ['--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'];
    let ok = run('npm', ['ci', '--prefix', DASH, ...flags], true);
    if (!ok) ok = run('npm', ['install', '--prefix', DASH, ...flags], true);
    if (!ok || !hasMineflayer()) {
      console.error('  Dependency install failed. Check your network and run: npm install');
      process.exit(1);
    }
    say('  ✓ Dependencies installed');
  }

  for (const dir of ['data', 'data/icons', 'data/skins']) {
    fs.mkdirSync(path.join(DASH, dir), { recursive: true });
  }

  const nodeBin = process.execPath;
  const unit = [
    '[Unit]',
    'Description=MCBot Control — multi-bot dashboard',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${DASH}`,
    `Environment=PORT=${PORT}`,
    `ExecStart=${nodeBin} ${path.join(DASH, 'server.js')}`,
    'Restart=always',
    'RestartSec=3',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=10',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');

  if (fs.existsSync('/run/systemd/system')) {
    const tmp = path.join(os.tmpdir(), `mcbot-dashboard.${process.pid}.service`);
    fs.writeFileSync(tmp, unit);
    const installed = priv('install', ['-m', '644', tmp, UNIT], true);
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (installed) {
      priv('systemctl', ['daemon-reload'], true);
      priv('systemctl', ['enable', '--now', SERVICE], true);
      say('  ✓ Systemd service enabled');
    } else if (!isRoot()) {
      say('  ! Run this with sudo (or as root) to install the systemd service.');
    }
  }

  if (await waitForPanel()) {
    say(`\n  Panel online on port ${PORT} in ${secs()}s`);
    say(`  → ${lanUrl()}\n`);
  } else {
    say('\n  Setup finished, but the panel is not answering yet.');
    say('  Start it with: npm start\n');
  }
})().catch((err) => {
  console.error('  Setup failed:', err && err.message ? err.message : err);
  process.exit(1);
});
