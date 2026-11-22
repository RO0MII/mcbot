'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   MCBot Control — actions, event wiring, boot
   ══════════════════════════════════════════════════════════════════════════ */

/* ── auth form ──────────────────────────────────────────────────────────── */
async function handleLogin(e) {
  e.preventDefault();
  const input = $('#login-password');
  const err = $('#login-error');
  const btn = $('#login-submit');
  if (!input || !btn) return;
  const password = input.value;
  if (!password) { if (err) err.textContent = 'Enter the dashboard password.'; input.focus(); return; }
  if (err) err.textContent = '';
  btn.disabled = true;
  const idle = btn.innerHTML;
  btn.innerHTML = `${icon('restart', 'ico spin')}<span>Signing in…</span>`;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Wrong password.');
    input.value = '';
    await enterApp();
  } catch (ex) {
    if (err) err.textContent = ex.message || 'Sign in failed.';
    const screen = $('#login-screen');
    if (screen) {
      screen.classList.add('is-shaking');
      setTimeout(() => screen.classList.remove('is-shaking'), 480);
    }
    input.select();
  } finally {
    btn.disabled = false;
    btn.innerHTML = idle;
  }
}

/* ── power ──────────────────────────────────────────────────────────────── */
async function toggleMaster() {
  const s = getStats();
  if (s.total === 0) {
    toast('info', 'No bots yet', 'Add a bot first, then the master switch will control it.');
    openBotModal();
    return;
  }
  const on = !s.masterOn;
  if (!on) {
    const ok = await confirmDialog({
      title: 'Stop every bot?',
      message: `This disconnects all ${s.total} bot(s) and keeps their settings. You can bring them back with the same switch.`,
      confirmLabel: 'Stop everything',
      danger: true,
      iconName: 'power',
    });
    if (!ok) return;
  }
  try {
    await api('/api/master', { method: 'POST', body: JSON.stringify({ on }) });
    toast(on ? 'ok' : 'warn', on ? 'Master power on' : 'Master power off', on ? 'Starting every bot…' : 'All bots disconnected.');
  } catch (e) {
    toast('err', 'Power switch failed', e.message);
  }
}

/* ── bot actions ────────────────────────────────────────────────────────── */
async function toggleBot(id) {
  const bot = findBot(id);
  if (!bot) return;
  const active = isActive(bot);
  try {
    await api(`/api/bots/${id}/${active ? 'stop' : 'start'}`, { method: 'POST' });
    toast(active ? 'warn' : 'ok', active ? 'Bot stopping' : 'Bot starting', `${bot.name} · ${bot.host}`);
  } catch (e) {
    toast('err', 'Could not update bot', e.message);
  }
}

async function restartBot(id) {
  const bot = findBot(id);
  if (!bot) return;
  try {
    await api(`/api/bots/${id}/restart`, { method: 'POST' });
    toast('info', 'Restarting bot', bot.name);
  } catch (e) {
    toast('err', 'Restart failed', e.message);
  }
}

async function deleteBot(id) {
  const bot = findBot(id);
  if (!bot) return;
  const ok = await confirmDialog({
    title: `Delete ${bot.name}?`,
    message: 'This removes the bot and its settings from the dashboard. The Minecraft account itself is not affected.',
    confirmLabel: 'Delete bot',
    danger: true,
    iconName: 'trash',
  });
  if (!ok) return;
  try {
    await api(`/api/bots/${id}`, { method: 'DELETE' });
    toast('ok', 'Bot deleted', bot.name);
  } catch (e) {
    toast('err', 'Delete failed', e.message);
  }
}

async function toggleServer(host, port) {
  const bots = state.bots.filter((b) => b.host === host && Number(b.port) === Number(port));
  if (!bots.length) return;
  const active = bots.some(isActive);
  if (active) {
    const ok = await confirmDialog({
      title: `Stop ${host}?`,
      message: `This disconnects ${bots.filter(isActive).length} bot(s) on this server. Settings are kept.`,
      confirmLabel: 'Stop server bots',
      danger: true,
      iconName: 'power',
    });
    if (!ok) return;
  }
  try {
    await api('/api/bots/bulk', { method: 'POST', body: JSON.stringify({ ids: bots.map((b) => b.id), action: active ? 'stop' : 'start' }) });
    toast(active ? 'warn' : 'ok', active ? 'Server power off' : 'Server power on', `${host}:${port} · ${bots.length} bot(s)`);
  } catch (e) {
    toast('err', 'Server switch failed', e.message);
  }
}

/* ── group actions ──────────────────────────────────────────────────────── */
async function toggleGroup(id) {
  const group = state.groups.find((g) => g.id === id);
  if (!group) return;
  const members = group.botIds.map(findBot).filter(Boolean);
  const active = members.some(isActive);
  if (active) {
    const ok = await confirmDialog({
      title: `Stop “${group.name}”?`,
      message: `This disconnects ${members.filter(isActive).length} bot(s) in this group. Settings are kept.`,
      confirmLabel: 'Stop group',
      danger: true,
      iconName: 'power',
    });
    if (!ok) return;
  }
  try {
    await api(`/api/groups/${id}/${active ? 'stop' : 'start'}`, { method: 'POST' });
    toast(active ? 'warn' : 'ok', active ? 'Group power off' : 'Group power on', `${group.name} · ${members.length} bot(s)`);
  } catch (e) {
    toast('err', 'Group switch failed', e.message);
  }
}

async function deleteGroup(id) {
  const group = state.groups.find((g) => g.id === id);
  if (!group) return;
  const ok = await confirmDialog({
    title: `Delete “${group.name}”?`,
    message: 'The group is removed. Its bots stay exactly as they are — they just become ungrouped.',
    confirmLabel: 'Delete group',
    danger: true,
    iconName: 'trash',
  });
  if (!ok) return;
  try {
    await api(`/api/groups/${id}`, { method: 'DELETE' });
    toast('ok', 'Group deleted', group.name);
  } catch (e) {
    toast('err', 'Delete failed', e.message);
  }
}

/* ── console quick actions ──────────────────────────────────────────────── */
async function consoleAction(action) {
  const id = state.consoleId;
  if (!id) return;
  const bot = findBot(id);
  try {
    await api(`/api/bots/${id}/${action}`, { method: 'POST' });
    if (action === 'login') toast('info', 'Login command sent', bot ? bot.name : '');
    else if (action === 'switch') toast('info', 'Server switch sent', bot ? bot.switchCommand : '');
    else if (action === 'restart') toast('info', 'Restarting bot', bot ? bot.name : '');
    else if (action === 'stop') toast('warn', 'Bot stopped', bot ? bot.name : '');
  } catch (e) {
    toast('err', 'Command failed', e.message);
  }
}

/* ── refresh ────────────────────────────────────────────────────────────── */
async function refreshState(btn) {
  const idle = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${icon('restart', 'ico spin')}<span>Refreshing…</span>`;
  }
  try {
    await loadState();
    toast('ok', 'Refreshed', 'Live state is up to date.');
  } catch (e) {
    toast('err', 'Refresh failed', e.message);
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = idle; }
  }
}

/* ── action router ──────────────────────────────────────────────────────── */
async function handleAction(action, el) {
  const id = el.dataset.id;
  try {
    switch (action) {
      case 'add': openBotModal(); break;
      case 'add-to-server': openBotModal(null, { host: el.dataset.host, port: Number(el.dataset.port) || 25565 }); break;
      case 'refresh': await refreshState(el); break;
      case 'console': await openConsole(id); break;
      case 'inventory': await openInventory(id); break;
      case 'edit': openBotModal(id); break;
      case 'delete': await deleteBot(id); break;
      case 'toggle': await toggleBot(id); break;
      case 'restart': await restartBot(id); break;
      case 'server-toggle': await toggleServer(el.dataset.host, Number(el.dataset.port)); break;
      case 'add-group': openGroupModal(null, { ungrouped: el.dataset.ungrouped === '1' }); break;
      case 'edit-group': openGroupModal(id); break;
      case 'delete-group': await deleteGroup(id); break;
      case 'group-toggle': await toggleGroup(id); break;
      case 'view-all-activity': switchView('activity'); break;
      case 'clear-activity':
        state.activity = [];
        state.unread = false;
        renderView();
        renderSidebar();
        toast('info', 'Activity cleared', 'New events will keep streaming in.');
        break;
      case 'clear-filters':
        state.query = '';
        state.filter = 'all';
        state.groupFilter = 'all';
        const search = $('#search-input');
        if (search) search.value = '';
        renderView();
        break;
      case 'close-modal': closeModal(); break;
      case 'close-console': closeConsole(); break;
      case 'console-login': await consoleAction('login'); break;
      case 'console-afk': await sendConsoleMessage('/afk'); break;
      case 'console-autoeat': await toggleAutoEat(); break;
      case 'player': await openPlayer(id); break;
      case 'bot-page': await openBotPage(id); break;
      case 'group-command': openGroupCommand(id); break;
      case 'console-switch': await consoleAction('switch'); break;
      case 'console-restart': await consoleAction('restart'); break;
      case 'console-stop': await consoleAction('stop'); break;
      default: break;
    }
  } catch (e) {
    toast('err', 'Something went wrong', e.message || String(e));
  }
}

async function toggleAutoEat() {
  if (!state.consoleId) return;
  try {
    const data = await api(`/api/bots/${state.consoleId}/auto-eat`, { method: 'POST', body: '{}' });
    const bot = data && data.bot;
    if (bot) {
      const i = state.bots.findIndex((b) => b.id === bot.id);
      if (i >= 0) state.bots[i] = bot;
      const chip = $('#auto-eat-chip');
      if (chip) {
        chip.classList.toggle('is-on', !!bot.autoEat);
        chip.innerHTML = `${icon('food')} Auto-eat ${bot.autoEat ? 'on' : 'off'}`;
      }
      toast(bot.autoEat ? 'ok' : 'info', `Auto-eat ${bot.autoEat ? 'enabled' : 'disabled'}`, bot.name);
    }
  } catch (e) {
    toast('err', 'Could not change auto-eat', e.message || String(e));
  }
}

/* ── terminal helpers ───────────────────────────────────────────────────── */
async function submitTerminal() {
  const input = $('#term-input');
  const target = $('#term-send-target');
  const message = String((input && input.value) || '').trim();
  if (!message) return;
  const wanted = target && target.value === 'all'
    ? state.bots.filter((b) => b.status === 'online')
    : state.bots.filter((b) => b.id === (target && target.value));
  if (!wanted.length) { toast('err', 'Nothing to send to', 'No online bot matches this target.'); return; }
  let sent = 0;
  const skipped = [];
  for (const b of wanted) {
    try {
      await api(`/api/bots/${b.id}/chat`, { method: 'POST', body: JSON.stringify({ message }) });
      sent += 1;
    } catch (_) { skipped.push(b.name); }
  }
  if (input) input.value = '';
  state.termHistory.push(message);
  if (state.termHistory.length > 40) state.termHistory.shift();
  state.termHistoryIndex = state.termHistory.length;
  toast(sent ? 'ok' : 'err', `Sent to ${sent} bot${sent === 1 ? '' : 's'}`, skipped.length ? `Skipped: ${skipped.join(', ')}` : message);
}

function exportTerminal() {
  const lines = termFiltered().map((i) => `${new Date(i.entry.t).toISOString()} [${i.name}] ${i.entry.kind}: ${i.entry.text}`).join('\n');
  const blob = new Blob([lines || ''], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mcbot-terminal-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('ok', 'Terminal exported', `${termFiltered().length} lines downloaded.`);
}

/* ── wiring ─────────────────────────────────────────────────────────────── */
function bindEvents() {
  const loginForm = $('#login-form');
  if (loginForm) loginForm.addEventListener('submit', handleLogin);

  const addBtn = $('#add-bot-btn');
  if (addBtn) addBtn.addEventListener('click', () => openBotModal());
  const master = $('#master-toggle');
  if (master) master.addEventListener('click', toggleMaster);
  const topbarPower = $('#topbar-power');
  if (topbarPower) topbarPower.addEventListener('click', toggleMaster);
  const logout = $('#logout-btn');
  if (logout) logout.addEventListener('click', doLogout);

  const search = $('#search-input');
  if (search) {
    let timer = null;
    search.addEventListener('input', (e) => {
      clearTimeout(timer);
      const value = e.target.value;
      timer = setTimeout(() => {
        state.query = value;
        if (state.view === 'activity') scheduleActivityFeedRender();
        else renderView();
      }, 130);
    });
  }

  const overlay = $('#drawer-overlay');
  if (overlay) overlay.addEventListener('click', () => closeConsole());

  // When a full-body skin loads, hide the gradient initial behind it.
  document.addEventListener('load', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || img.dataset.skin !== '1') return;
    const prev = img.previousElementSibling;
    if (prev && prev.classList && (prev.classList.contains('player-hero__initial') || prev.classList.contains('avatar-initial'))) prev.style.display = 'none';
  }, true);

  // Item textures: the dashboard proxies and caches them; hide any that 404.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    if (img.dataset.skin === '1') {
      img.classList.add('is-missing');
      img.removeAttribute('src');
      return;
    }
    if (img.dataset.fallback !== '1') return;
    img.classList.add('is-missing');
    img.removeAttribute('src');
  }, true);

  // Custom item tooltip (Minecraft-style hover card).
  const itemTip = $('#item-tip');
  document.addEventListener('mouseover', (e) => {
    const slot = e.target.closest('[data-tip]');
    if (!slot || !itemTip) return;
    itemTip.textContent = slot.dataset.tip;
    itemTip.hidden = false;
    const r = slot.getBoundingClientRect();
    const tipW = itemTip.offsetWidth;
    const tipH = itemTip.offsetHeight;
    let left = r.left + r.width / 2 - tipW / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tipW - 8));
    let top = r.top - tipH - 10;
    if (top < 8) top = r.bottom + 10;
    itemTip.style.left = `${left}px`;
    itemTip.style.top = `${top}px`;
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-tip]') && itemTip) itemTip.hidden = true;
  });

  document.addEventListener('click', async (e) => {
    const cmdPreset = e.target.closest('[data-group-cmd]');
    if (cmdPreset) {
      e.preventDefault();
      const input = $('#group-command-input');
      if (input) { input.value = cmdPreset.dataset.groupCmd; input.focus(); }
      return;
    }

    // copy-to-clipboard (UUID, etc.)
    const copyEl = e.target.closest('[data-copy]');
    if (copyEl) {
      e.preventDefault();
      const text = copyEl.dataset.copy || '';
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        toast('ok', 'Copied', text);
      } catch (_) {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          toast('ok', 'Copied', text);
        } catch (err) {
          toast('err', 'Copy failed', String(err));
        }
      }
      return;
    }

    // toggle switches inside forms
    const toggle = e.target.closest('[data-toggle]');
    if (toggle && formDraft) {
      e.preventDefault();
      const key = toggle.dataset.toggle;
      formDraft[key] = !formDraft[key];
      toggle.classList.toggle('is-on', formDraft[key]);
      toggle.setAttribute('aria-checked', String(formDraft[key]));
      const label = toggle.querySelector('.switch__label');
      if (label) label.textContent = formDraft[key] ? 'On' : 'Off';
      const row = toggle.closest('.toggle-row');
      if (row) row.classList.toggle('is-on', formDraft[key]);
      return;
    }

    // group membership chips in the bot form
    const groupPick = e.target.closest('[data-group-pick]');
    if (groupPick && formDraft) {
      e.preventDefault();
      const gid = groupPick.dataset.groupPick;
      if (formDraft.groupIds.has(gid)) formDraft.groupIds.delete(gid);
      else formDraft.groupIds.add(gid);
      const on = formDraft.groupIds.has(gid);
      groupPick.classList.toggle('is-on', on);
      groupPick.setAttribute('aria-pressed', String(on));
      return;
    }

    // member rows in the group form
    const memberPick = e.target.closest('[data-member-pick]');
    if (memberPick && groupDraft) {
      e.preventDefault();
      const bid = memberPick.dataset.memberPick;
      if (groupDraft.botIds.has(bid)) groupDraft.botIds.delete(bid);
      else groupDraft.botIds.add(bid);
      const on = groupDraft.botIds.has(bid);
      memberPick.classList.toggle('is-on', on);
      memberPick.setAttribute('aria-pressed', String(on));
      const count = $('#group-count');
      if (count) count.textContent = groupDraft.botIds.size;
      return;
    }

    // colour swatches
    const swatch = e.target.closest('[data-swatch]');
    if (swatch && groupDraft) {
      e.preventDefault();
      groupDraft.color = swatch.dataset.swatch;
      $$('.swatch').forEach((s) => {
        const on = s === swatch;
        s.classList.toggle('is-on', on);
        s.setAttribute('aria-pressed', String(on));
      });
      const modalIcon = $('.modal__icon');
      if (modalIcon) {
        modalIcon.style.color = groupDraft.color;
        modalIcon.style.background = `color-mix(in srgb, ${groupDraft.color} 13%, transparent)`;
        modalIcon.style.borderColor = `color-mix(in srgb, ${groupDraft.color} 26%, transparent)`;
      }
      return;
    }

    // password reveal
    const reveal = e.target.closest('[data-reveal]');
    if (reveal) {
      e.preventDefault();
      const input = document.getElementById(reveal.dataset.reveal);
      if (input) {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        reveal.innerHTML = icon(show ? 'eye-off' : 'eye');
        reveal.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      }
      return;
    }

    // navigation
    const nav = e.target.closest('[data-view]');
    if (nav) {
      e.preventDefault();
      switchView(nav.dataset.view);
      return;
    }

    // drawer tabs
    const drawerTabBtn = e.target.closest('[data-drawer-tab]');
    if (drawerTabBtn) {
      e.preventDefault();
      setDrawerTab(drawerTabBtn.dataset.drawerTab);
      return;
    }

    // filters
    const filter = e.target.closest('[data-filter]');
    if (filter) {
      e.preventDefault();
      state.filter = filter.dataset.filter;
      renderView();
      return;
    }
    const afilter = e.target.closest('[data-afilter]');
    if (afilter) {
      e.preventDefault();
      state.activityFilter = afilter.dataset.afilter;
      renderView();
      return;
    }
    const gfilter = e.target.closest('[data-group-filter]');
    if (gfilter) {
      e.preventDefault();
      state.groupFilter = gfilter.dataset.groupFilter;
      renderView();
      return;
    }

    // actions
    const action = e.target.closest('[data-action]');
    if (action) {
      e.preventDefault();
      handleAction(action.dataset.action, action);
    }
  });

  // console form (delegated because the drawer is re-rendered)
  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'console-form') return;
    e.preventDefault();
    const input = $('#console-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      await sendConsoleMessage(text);
    } catch (err) {
      input.value = text;
      toast('err', 'Message failed', err.message);
    }
    input.focus();
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    const modalRoot = $('#modal-root');
    if (e.key === 'Escape') {
      if (modalRoot && !modalRoot.hidden) { closeModal(); return; }
      if ($('#console-drawer') && $('#console-drawer').classList.contains('is-open')) { closeConsole(); return; }
      if (document.activeElement && document.activeElement.id === 'search-input') document.activeElement.blur();
      return;
    }
    if (e.key === '/' && state.authed) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
      e.preventDefault();
      const search = $('#search-input');
      if (search) search.focus();
      return;
    }
    if (e.target && e.target.id === 'console-input') {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (consoleHistoryIndex > 0) {
          consoleHistoryIndex -= 1;
          e.target.value = consoleHistory[consoleHistoryIndex] || '';
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (consoleHistoryIndex < consoleHistory.length - 1) {
          consoleHistoryIndex += 1;
          e.target.value = consoleHistory[consoleHistoryIndex] || '';
        } else {
          consoleHistoryIndex = consoleHistory.length;
          e.target.value = '';
        }
      }
    }
  });

  // close modals when clicking the backdrop
  const modalRoot = $('#modal-root');
  if (modalRoot) {
    modalRoot.addEventListener('click', (e) => {
      if (e.target === modalRoot) closeModal();
    });
  }

  // ── terminal page ──
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'term-target') {
      state.termTarget = e.target.value;
      $$('.term-bot').forEach((el) => el.classList.toggle('is-active', el.dataset.termBot === state.termTarget));
      renderTerminalLines();
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'terminal-search') {
      state.termQuery = e.target.value;
      renderTerminalLines();
    }
  });
  document.addEventListener('click', async (e) => {
    const tfilter = e.target.closest('[data-term-filter]');
    if (tfilter) {
      e.preventDefault();
      state.termFilter = tfilter.dataset.termFilter;
      $$('.term-toolbar .chip').forEach((ch) => ch.classList.toggle('is-active', ch === tfilter));
      renderTerminalLines();
      return;
    }
    const tbot = e.target.closest('[data-term-bot]');
    if (tbot) {
      e.preventDefault();
      state.termTarget = tbot.dataset.termBot;
      const sel = $('#term-target');
      if (sel) sel.value = state.termTarget;
      $$('.term-bot').forEach((el) => el.classList.toggle('is-active', el.dataset.termBot === state.termTarget));
      renderTerminalLines();
      return;
    }
    const tcmd = e.target.closest('[data-term-cmd]');
    if (tcmd) {
      e.preventDefault();
      const input = $('#term-input');
      if (input) { input.value = tcmd.dataset.termCmd; input.focus(); }
      return;
    }
    if (e.target.closest('#term-pause')) {
      e.preventDefault();
      state.termPaused = !state.termPaused;
      const btn = $('#term-pause');
      if (btn) {
        btn.classList.toggle('is-on', state.termPaused);
        btn.innerHTML = `${icon(state.termPaused ? 'play' : 'pause')}<span>${state.termPaused ? 'Paused' : 'Pause'}</span>`;
        btn.title = state.termPaused ? 'Resume auto-scroll' : 'Pause auto-scroll';
      }
      renderTerminalLines();
      return;
    }
    if (e.target.closest('#term-clear')) {
      e.preventDefault();
      state.terminalLogs = [];
      state.termLoaded = true;
      renderTerminalLines();
      toast('info', 'Terminal cleared', 'New events will stream in as they arrive.');
      return;
    }
    if (e.target.closest('#term-export')) {
      e.preventDefault();
      exportTerminal();
      return;
    }
    if (e.target.closest('#term-jump')) {
      e.preventDefault();
      const box = $('#term-lines');
      if (box) box.scrollTop = box.scrollHeight;
      return;
    }
  });
  document.addEventListener('click', (e) => {
    const jump = e.target.closest('[data-bp-jump]');
    if (jump) {
      e.preventDefault();
      const el = document.getElementById(jump.dataset.bpJump);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  document.addEventListener('scroll', (e) => {
    if (!e.target || e.target.id !== 'term-lines') return;
    const box = e.target;
    const jump = $('#term-jump');
    if (jump) jump.hidden = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!e.target || e.target.id !== 'term-input') return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (state.termHistory.length) {
        state.termHistoryIndex = Math.max(0, state.termHistoryIndex - 1);
        e.target.value = state.termHistory[state.termHistoryIndex] || '';
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (state.termHistory.length) {
        state.termHistoryIndex = Math.min(state.termHistory.length, state.termHistoryIndex + 1);
        e.target.value = state.termHistory[state.termHistoryIndex] || '';
      }
    }
  });
  document.addEventListener('submit', async (e) => {
    if (e.target && e.target.id === 'term-form') {
      e.preventDefault();
      await submitTerminal();
    }
    if (e.target && e.target.id === 'bot-command-form') {
      e.preventDefault();
      await submitBotCommand(e.target);
    }
  });

  // live search on the activity page
  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'activity-search') {
      state.activityQuery = e.target.value;
      scheduleActivityFeedRender();
    }
  });

  // A sleeping/backgrounded tab can drop the SSE stream. When the user comes
  // back, rebuild it and resync instead of showing stale "online" state.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.authed) return;
    if (Date.now() - state.lastEventAt > 8000) {
      try { if (state.sse) state.sse.close(); } catch (_) {}
      state.sse = null;
      scheduleReconnect(150);
    } else {
      resyncAll();
    }
  });
  window.addEventListener('online', () => scheduleReconnect(200));
}

/* ── boot ───────────────────────────────────────────────────────────────── */
async function init() {
  bindEvents();
  try {
    const res = await fetch('/api/auth', { credentials: 'same-origin' });
    const data = await res.json();
    if (data.authenticated) await enterApp();
    else showLogin();
  } catch (_) {
    showLogin();
    const err = $('#login-error');
    if (err) err.textContent = 'Cannot reach the dashboard server.';
  }
}

document.addEventListener('DOMContentLoaded', init);
