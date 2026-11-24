#!/usr/bin/env node
/**
 * MCBot Control — asset build.
 *
 * The dashboard server sends static files with `Cache-Control: no-cache` and
 * no compression, so every visit re-downloads the full CSS + JS. Shrinking
 * those bytes is the cheapest load-time win available without restarting the
 * service (a restart drops every bot for 5–30s).
 *
 *   node tools/build.js
 *
 * Reads   public/styles.css   → writes public/styles.min.css
 * Reads   public/app.js       → writes public/app.min.js  (terser, if present)
 *
 * The readable sources stay the ones you edit. index.html points at the .min
 * files, so RUN THIS AFTER EDITING styles.css OR app.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const write = (f, s) => fs.writeFileSync(path.join(PUB, f), s);
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

/* ── CSS ────────────────────────────────────────────────────────────────────
   Conservative, string-aware: drops comments, collapses whitespace, trims
   space around `{ } ; ,` and after `:`. Never touches calc() operators or
   anything inside quotes, so `calc(100% - 20px)` and `content: "a  b"` are
   preserved byte for byte. */
function minifyCss(src) {
  const parts = []; // { s: true } for quoted runs, { s: false } for everything else
  let plain = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === q) { j += 1; break; }
        j += 1;
      }
      if (plain) { parts.push({ s: false, v: plain }); plain = ''; }
      parts.push({ s: true, v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f') {
      let j = i;
      while (j < n && /\s/.test(src[j])) j += 1;
      plain += ' ';
      i = j;
      continue;
    }
    plain += c;
    i += 1;
  }
  if (plain) parts.push({ s: false, v: plain });

  return parts
    .map((p) => p.s
      ? p.v
      : p.v.replace(/\s*([{};,])\s*/g, '$1').replace(/:\s+/g, ':').replace(/;}/g, '}'))
    .join('')
    .trim();
}

/* ── JS ─────────────────────────────────────────────────────────────────────
   terser if it is installed; otherwise strip comments/blank lines only, so a
   build never fails and never ships something unparsable. */
function minifyJs(src) {
  const tmp = path.join(PUB, '.app.min.tmp.js');
  fs.writeFileSync(tmp, src);
  try {
    execFileSync('terser', [tmp, '-c', '-m', '-o', path.join(PUB, 'app.min.js')], { stdio: 'pipe' });
    fs.unlinkSync(tmp);
    return 'terser';
  } catch (e) {
    fs.unlinkSync(tmp);
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/\s+$/, ''))
      .filter((l, idx, arr) => l.trim() !== '' || (arr[idx - 1] || '').trim() === '')
      .join('\n');
    write('app.min.js', stripped);
    return 'whitespace only (terser not found)';
  }
}

const css = read('styles.css');
const js = read('app.js');

const cssMin = minifyCss(css);
write('styles.min.css', cssMin);

const how = minifyJs(js);
const jsMin = read('app.min.js');

// A build that produces broken output is worse than no build.
execFileSync(process.execPath, ['--check', path.join(PUB, 'app.min.js')]);
if ((cssMin.match(/\{/g) || []).length !== (cssMin.match(/\}/g) || []).length) {
  throw new Error('minified CSS has unbalanced braces — refusing to ship it');
}

console.log('styles.css      ' + kb(Buffer.byteLength(css)) + ' → styles.min.css ' + kb(Buffer.byteLength(cssMin)));
console.log('app.js          ' + kb(Buffer.byteLength(js)) + ' → app.min.js    ' + kb(Buffer.byteLength(jsMin)) + '  (' + how + ')');
console.log('saved           ' + kb(Buffer.byteLength(css) + Buffer.byteLength(js) - Buffer.byteLength(cssMin) - Buffer.byteLength(jsMin)));
