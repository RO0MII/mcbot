#!/usr/bin/env node
'use strict';

/*
 * `npm start` → bring the MCBot Control panel online on port 80.
 *
 * - If the systemd service exists, start it when needed and wait for port 80.
 * - Otherwise run the dashboard directly in the foreground.
 * No prompts: one command, panel online.
 */

const { spawnSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVICE = 'mcbot-dashboard.service';
const PORT = parseInt(process.env.PORT || '80', 10);
const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'dashboard', 'server.js');

function lanUrl() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return `http://${net.address}/`;
    }
  }
  return `http://localhost${PORT === 80 ? '' : `:${PORT}`}/`;
}

function serviceExists() {
  return spawnSync('systemctl', ['cat', SERVICE], { stdio: 'ignore' }).status === 0;
}
function serviceActive() {
  return spawnSync('systemctl', ['is-active', '--quiet', SERVICE], { stdio: 'ignore' }).status === 0;
}
function startService() {
  const r = spawnSync('systemctl', ['start', SERVICE], { stdio: 'inherit' });
  if (r.status === 0) return true;
  if (typeof process.getuid === 'function' && process.getuid() === 0) return false;
  return spawnSync('sudo', ['-n', 'systemctl', 'start', SERVICE], { stdio: 'inherit' }).status === 0;
}

function ping(attempt = 0) {
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
    if (await ping(i)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

(async () => {
  if (fs.existsSync('/run/systemd/system') && serviceExists()) {
    if (!serviceActive()) {
      console.log(`\n  Starting ${SERVICE}…\n`);
      if (!startService()) {
        console.error(`\n  Could not start the service. Run:\n    sudo systemctl start ${SERVICE}\n`);
        process.exit(1);
      }
    }
    const up = await waitForPanel();
    if (up) {
      console.log(`\n  MCBot Control is online on port ${PORT}\n  → ${lanUrl()}\n`);
      process.exit(0);
    }
    console.error(`\n  Service is running but port ${PORT} is not responding.`);
    console.error(`  Check logs: journalctl -u ${SERVICE} -n 60 --no-pager\n`);
    process.exit(1);
  }

  // No systemd: run the panel directly.
  if (typeof process.getuid === 'function' && process.getuid() !== 0 && PORT < 1024) {
    console.error(`\n  Port ${PORT} needs root. Run with sudo, or use PORT=8080 npm start.\n`);
    process.exit(1);
  }
  process.env.PORT = String(PORT);
  console.log(`\n  Starting MCBot Control on port ${PORT}…\n  → ${lanUrl()}\n`);
  require(SERVER);
})();
