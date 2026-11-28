'use strict';

/* ── a slow field of pixels behind the hero ─────────────────────────────── */
(function field() {
  const canvas = document.getElementById('field');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w = 0, h = 0, dpr = 1, dots = [], raf = 0, px = 0, py = 0, tx = 0, ty = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    make();
  }
  function make() {
    const count = Math.min(90, Math.max(28, Math.round((w * h) / 22000)));
    dots = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      s: Math.random() < 0.14 ? 2.6 : 1.6,
      v: 0.12 + Math.random() * 0.32,
      drift: (Math.random() - 0.5) * 0.16,
      hue: Math.random() < 0.22 ? 'cy' : (Math.random() < 0.6 ? 'gr' : 'wh'),
      a: 0.1 + Math.random() * 0.4,
    }));
  }
  function paint() {
    ctx.clearRect(0, 0, w, h);
    for (const d of dots) {
      ctx.fillStyle = d.hue === 'cy' ? `rgba(85,201,245,${d.a})` : d.hue === 'gr' ? `rgba(47,224,143,${d.a})` : `rgba(210,240,228,${d.a * 0.65})`;
      const x = d.x + px, y = d.y + py;
      ctx.fillRect(Math.round(x), Math.round(y), d.s, d.s);
    }
  }
  function frame() {
    if (!document.hidden && !reduce) {
      for (const d of dots) {
        d.y -= d.v;
        d.x += d.drift;
        if (d.y < -6) { d.y = h + 6; d.x = Math.random() * w; }
        if (d.x < -6) d.x = w + 6;
        if (d.x > w + 6) d.x = -6;
      }
      px += (tx - px) * 0.04; py += (ty - py) * 0.04;
    }
    paint();
    raf = requestAnimationFrame(frame);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', (e) => {
    tx = (e.clientX / w - 0.5) * 18;
    ty = (e.clientY / h - 0.5) * 12;
  }, { passive: true });
  resize();
  if (reduce) { paint(); return; }
  frame();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
    else if (!raf) frame();
  });
})();

/* ── the group-command moment ───────────────────────────────────────────── */
(function moment() {
  const box = document.getElementById('moment');
  const typed = document.getElementById('typed');
  const state = box && box.querySelector('.moment__state');
  const replay = document.getElementById('replay');
  if (!box || !typed) return;
  const cmd = '/afk';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let timer = null, running = false, played = false;

  function finish() {
    running = false;
    box.classList.add('is-live');
    if (state) state.textContent = 'sent';
  }
  function play() {
    if (running) return;
    running = true;
    clearInterval(timer);
    box.classList.remove('is-live');
    void box.offsetWidth;
    if (state) state.textContent = 'running';
    if (reduce) { typed.textContent = cmd; finish(); return; }
    typed.textContent = '';
    let i = 0;
    timer = setInterval(() => {
      i += 1;
      typed.textContent = cmd.slice(0, i);
      if (i >= cmd.length) {
        clearInterval(timer);
        setTimeout(finish, 260);
      }
    }, 92);
  }
  if (replay) replay.addEventListener('click', play);
  if (reduce) { typed.textContent = cmd; finish(); return; }
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && !played) { played = true; play(); }
      });
    }, { threshold: 0.45 });
    io.observe(box);
  } else {
    play();
  }
})();

/* ── copy the start command ─────────────────────────────────────────────── */
(function copy() {
  const btn = document.getElementById('copy');
  const code = document.getElementById('code');
  if (!btn || !code) return;
  btn.addEventListener('click', async () => {
    const text = code.innerText.replace(/\u00a0/g, ' ');
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (_) {}
      ta.remove();
    }
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = old; }, 1500);
  });
})();

/* ── calm anchor scrolling ──────────────────────────────────────────────── */
(function anchors() {
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      if (!id || id.length < 2) return;
      const el = document.querySelector(id);
      if (!el) return;
      e.preventDefault();
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
})();
