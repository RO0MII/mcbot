'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   MCBot Control — modals, bot form, group builder, toasts
   ══════════════════════════════════════════════════════════════════════════ */

/* ── toasts ─────────────────────────────────────────────────────────────── */
function toast(kind, title, msg = '') {
  const root = $('#toasts');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  const ic = kind === 'ok' ? 'check' : (kind === 'err' ? 'alert' : (kind === 'warn' ? 'alert' : 'activity'));
  el.innerHTML = `${icon(ic)}<div class="toast__body"><div class="toast__title">${esc(title)}</div>${msg ? `<div class="toast__msg">${esc(msg)}</div>` : ''}</div>`;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 260);
  }, 4000);
}

/* ── modal shell ────────────────────────────────────────────────────────── */
function closeModal() {
  const root = $('#modal-root');
  if (!root) return;
  if (confirmResolver) {
    const resolve = confirmResolver;
    confirmResolver = null;
    resolve(false);
  }
  root.hidden = true;
  root.innerHTML = '';
  formDraft = null;
  syncLock();
}

function confirmDialog(opts) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const danger = !!opts.danger;
    root.hidden = false;
    root.innerHTML = `
      <div class="modal modal--sm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <div class="modal__head">
          <div class="modal__icon ${danger ? 'is-danger' : ''}">${icon(opts.iconName || 'alert')}</div>
          <div class="modal__titles">
            <h2 id="confirm-title">${esc(opts.title)}</h2>
            <p>${esc(opts.message || '')}</p>
          </div>
        </div>
        <div class="modal__foot">
          <span class="modal__spacer"></span>
          <button class="btn btn-ghost" type="button" data-confirm="0">Cancel</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="button" data-confirm="1">${esc(opts.confirmLabel || 'Confirm')}</button>
        </div>
      </div>`;
    confirmResolver = resolve;
    const finish = (v) => {
      const r = confirmResolver;
      confirmResolver = null;
      root.hidden = true;
      root.innerHTML = '';
      syncLock();
      if (r) r(v);
    };
    root.querySelector('[data-confirm="0"]').addEventListener('click', () => finish(false));
    root.querySelector('[data-confirm="1"]').addEventListener('click', () => finish(true));
    root.addEventListener('click', (e) => { if (e.target === root) finish(false); });
    syncLock();
    setTimeout(() => { const b = root.querySelector('[data-confirm="1"]'); if (b) b.focus(); }, 60);
  });
}

function toggleRow(key, title, desc, on) {
  return `
    <div class="toggle-row ${on ? 'is-on' : ''}" data-toggle-row="${key}">
      <div class="toggle-row__text"><b>${esc(title)}</b><small>${esc(desc)}</small></div>
      <button type="button" class="switch ${on ? 'is-on' : ''}" data-toggle="${key}" role="switch" aria-checked="${on}">
        <span class="switch__track"><span class="switch__thumb"></span></span>
        <span class="switch__label">${on ? 'On' : 'Off'}</span>
      </button>
    </div>`;
}

function setFormError(id, message) {
  const el = $(`#${id}`);
  if (el) el.textContent = message || '';
}

function busyButton(btn, busy, label) {
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.idleHtml) btn.dataset.idleHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `${icon('restart', 'ico spin')} Saving…`;
  } else {
    btn.disabled = false;
    btn.innerHTML = btn.dataset.idleHtml || label;
    delete btn.dataset.idleHtml;
  }
}

/* ── bot form ───────────────────────────────────────────────────────────── */
function groupPickHtml() {
  if (!state.groups.length) {
    return '<p class="field__hint">No groups yet — create one in the Groups tab, then assign bots here.</p>';
  }
  return `<div class="pick-chips">${state.groups.map((g) => {
    const on = formDraft.groupIds.has(g.id);
    return `<button type="button" class="pick-chip ${on ? 'is-on' : ''}" data-group-pick="${esc(g.id)}" style="--group:${esc(g.color)}" aria-pressed="${on}">
      <i></i><span>${esc(g.name)}</span>${icon('check', 'ico pick-chip__check')}
    </button>`;
  }).join('')}</div>`;
}

function openBotModal(id, prefill = {}) {
  const existing = id ? findBot(id) : null;
  const b = existing ? Object.assign({}, existing) : {
    name: '',
    host: prefill.host || '',
    port: prefill.port || 25565,
    version: '1.20.1',
    password: 'Sandun123',
    autoLogin: true,
    autoSwitch: false,
    switchCommand: '/server oneblock',
    switchDelay: 4000,
    autoReconnect: true,
    antiAfk: true,
    autoEat: true,
    reswitch: false,
    groupIds: [],
  };
  formDraft = {
    autoLogin: b.autoLogin !== false,
    autoSwitch: !!b.autoSwitch,
    autoReconnect: b.autoReconnect !== false,
    antiAfk: b.antiAfk !== false,
    autoEat: b.autoEat !== false,
    reswitch: !!b.reswitch,
    groupIds: new Set(Array.isArray(b.groupIds) ? b.groupIds : []),
  };

  const root = $('#modal-root');
  root.hidden = false;
  root.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="bot-modal-title">
      <div class="modal__head">
        <div class="modal__icon">${icon(existing ? 'edit' : 'plus')}</div>
        <div class="modal__titles">
          <h2 id="bot-modal-title">${existing ? `Edit ${esc(b.name)}` : 'Add a bot'}</h2>
          <p>${existing ? 'Changes to connection details restart the bot automatically.' : 'Unlimited bots — add as many as you need.'}</p>
        </div>
        <button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">${icon('x')}</button>
      </div>
      <div class="modal__body">
        <form id="bot-form" novalidate>
          <div class="modal__error" id="bot-error"></div>

          <div class="form-section">
            <p class="form-section__title">${icon('server')} Connection</p>
            <div class="form-grid">
              <label class="field">
                <span class="field__label">Player name</span>
                <span class="field__control">${icon('users', 'ico field__icon')}
                  <input name="name" value="${esc(b.name)}" maxlength="16" placeholder="SandunBot" required autocomplete="off" spellcheck="false" />
                </span>
                <span class="field__hint">1–16 characters: letters, numbers or underscore.</span>
              </label>
              <label class="field">
                <span class="field__label">Server IP</span>
                <span class="field__control">${icon('server', 'ico field__icon')}
                  <input name="host" value="${esc(b.host)}" placeholder="play.bananasmp.net" required autocomplete="off" spellcheck="false" />
                </span>
                <span class="field__hint">Hostname or IP. Port is separate below.</span>
              </label>
              <label class="field">
                <span class="field__label">Port</span>
                <span class="field__control">
                  <input name="port" type="number" min="1" max="65535" value="${esc(b.port)}" required />
                </span>
              </label>
              <label class="field">
                <span class="field__label">Minecraft version</span>
                <span class="field__control">
                  <input name="version" value="${esc(b.version)}" placeholder="1.20.1 or auto" autocomplete="off" spellcheck="false" />
                </span>
                <span class="field__hint">Use <b>auto</b> to detect the server version.</span>
              </label>
            </div>
          </div>

          <div class="form-section">
            <p class="form-section__title">${icon('shield')} Authentication</p>
            <div class="form-grid">
              <label class="field field--full">
                <span class="field__label">Password</span>
                <span class="field__control">${icon('lock', 'ico field__icon')}
                  <input id="bot-password" name="password" type="password" value="${esc(b.password)}" autocomplete="new-password" spellcheck="false" />
                  <button type="button" class="field__reveal" data-reveal="bot-password" aria-label="Show password">${icon('eye')}</button>
                </span>
                <span class="field__hint">Sent automatically as <b>/login &lt;password&gt;</b> when the server asks. Also used for <b>/register</b>.</span>
              </label>
            </div>
            <div class="toggle-list" style="margin-top:14px">
              ${toggleRow('autoLogin', 'Auto login', 'Detect /login prompts and answer with this password, with retries.', formDraft.autoLogin)}
            </div>
          </div>

          <div class="form-section">
            <p class="form-section__title">${icon('restart')} Server switch</p>
            <div class="toggle-list">
              ${toggleRow('autoSwitch', 'Auto server switch', 'Run the switch command after login so the bot lands on your sub-server.', formDraft.autoSwitch)}
            </div>
            <div class="form-grid" style="margin-top:14px">
              <label class="field">
                <span class="field__label">Switch command</span>
                <span class="field__control">
                  <input name="switchCommand" value="${esc(b.switchCommand)}" placeholder="/server oneblock" autocomplete="off" spellcheck="false" />
                </span>
              </label>
              <label class="field">
                <span class="field__label">Delay after login (ms)</span>
                <span class="field__control">
                  <input name="switchDelay" type="number" min="1000" max="60000" step="500" value="${esc(b.switchDelay)}" />
                </span>
              </label>
            </div>
            <div class="toggle-list" style="margin-top:14px">
              ${toggleRow('reswitch', 'Periodic re-switch', 'Re-send the switch command every 5–10 minutes to survive restarts.', formDraft.reswitch)}
            </div>
          </div>

          <div class="form-section">
            <p class="form-section__title">${icon('group')} Groups</p>
            <div id="bot-groups-picker">${groupPickHtml()}</div>
            <p class="field__hint">A bot can belong to any number of groups. Manage groups in the Groups tab.</p>
          </div>

          <div class="form-section">
            <p class="form-section__title">${icon('sliders')} Behaviour</p>
            <div class="toggle-list">
              ${toggleRow('autoReconnect', 'Auto reconnect', 'Keep retrying when the server is offline or restarts.', formDraft.autoReconnect)}
              ${toggleRow('antiAfk', 'Anti-AFK', 'Small movements every 8 seconds so the bot is never kicked for idling.', formDraft.antiAfk)}
              ${toggleRow('autoEat', 'Auto-eat', 'When hunger drops, the bot picks the best food in its inventory and eats automatically.', formDraft.autoEat)}
            </div>
          </div>
        </form>
      </div>
      <div class="modal__foot">
        <span class="modal__spacer"></span>
        <button class="btn btn-ghost" type="button" data-action="close-modal">Cancel</button>
        <button class="btn btn-primary" type="submit" form="bot-form" id="bot-save">${icon('check')}<span>${existing ? 'Save changes' : 'Create bot'}</span></button>
      </div>
    </div>`;
  syncLock();

  const form = $('#bot-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormError('bot-error', '');
    const fd = new FormData(form);
    const payload = {
      name: String(fd.get('name') || '').trim(),
      host: String(fd.get('host') || '').trim(),
      port: Number(fd.get('port')) || 25565,
      version: String(fd.get('version') || '').trim() || '1.20.1',
      password: String(fd.get('password') || ''),
      switchCommand: String(fd.get('switchCommand') || '').trim() || '/server oneblock',
      switchDelay: Number(fd.get('switchDelay')) || 4000,
      autoLogin: formDraft.autoLogin,
      autoSwitch: formDraft.autoSwitch,
      autoReconnect: formDraft.autoReconnect,
      antiAfk: formDraft.antiAfk,
      autoEat: formDraft.autoEat,
      reswitch: formDraft.reswitch,
      groupIds: Array.from(formDraft.groupIds),
    };
    if (!/^[A-Za-z0-9_]{1,16}$/.test(payload.name)) {
      return setFormError('bot-error', 'Player name must be 1–16 characters: letters, numbers or underscore.');
    }
    if (!payload.host) return setFormError('bot-error', 'Enter the server IP or hostname.');
    if (!payload.password.trim()) return setFormError('bot-error', 'Password cannot be empty.');

    const btn = $('#bot-save');
    busyButton(btn, true);
    try {
      if (existing) await api(`/api/bots/${existing.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/api/bots', { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      toast('ok', existing ? 'Bot updated' : 'Bot added', `${payload.name} → ${payload.host}:${payload.port}`);
      loadState().catch(() => {});
    } catch (err) {
      setFormError('bot-error', err.message || 'Could not save the bot.');
      busyButton(btn, false);
    }
  });

  setTimeout(() => {
    const first = form.querySelector('input[name="name"]');
    if (first) { first.focus(); if (existing) first.select(); }
  }, 80);
}

/* ── group form ─────────────────────────────────────────────────────────── */
const GROUP_COLORS = ['#46e08a', '#57d6f5', '#b79cff', '#f6c35b', '#ff8a5c', '#ff6b7d', '#f472b6', '#94a3b8'];

function memberPickerHtml() {
  if (!state.bots.length) return '<p class="field__hint">Add a bot first, then you can put it in groups.</p>';
  return `<div class="member-list">${state.bots.map((b) => {
    const st = statusMeta(b);
    const on = groupDraft.botIds.has(b.id);
    return `<button type="button" class="member-row ${on ? 'is-on' : ''}" data-member-pick="${esc(b.id)}" aria-pressed="${on}">
      <span class="member-row__check">${icon('check')}</span>
      <span class="member-row__name">${esc(b.name)}</span>
      <span class="member-row__host">${esc(b.host)}:${b.port}</span>
      <span class="status-dot ${st.dot}"></span>
    </button>`;
  }).join('')}</div>`;
}

let groupDraft = null;

function openGroupModal(id, opts = {}) {
  const existing = id ? state.groups.find((g) => g.id === id) : null;
  const initialBots = existing
    ? existing.botIds
    : (opts.ungrouped ? state.bots.filter((b) => !(b.groupIds || []).length).map((b) => b.id) : []);
  groupDraft = {
    color: existing ? existing.color : '#46e08a',
    botIds: new Set(initialBots),
  };

  const root = $('#modal-root');
  root.hidden = false;
  root.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="group-modal-title">
      <div class="modal__head">
        <div class="modal__icon" style="color:${esc(groupDraft.color)};background:color-mix(in srgb, ${esc(groupDraft.color)} 13%, transparent);border-color:color-mix(in srgb, ${esc(groupDraft.color)} 26%, transparent)">${icon('group')}</div>
        <div class="modal__titles">
          <h2 id="group-modal-title">${existing ? `Edit ${esc(existing.name)}` : 'New bot group'}</h2>
          <p>Name it, pick an accent colour, and choose the bots that belong to it.</p>
        </div>
        <button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">${icon('x')}</button>
      </div>
      <div class="modal__body">
        <div class="modal__error" id="group-error"></div>
        <div class="form-grid">
          <label class="field field--full">
            <span class="field__label">Group name</span>
            <span class="field__control">${icon('group', 'ico field__icon')}
              <input id="group-name" maxlength="40" value="${existing ? esc(existing.name) : ''}" placeholder="e.g. Farming crew" autocomplete="off" />
            </span>
            <span class="field__hint">Unlimited groups, unlimited bots per group.</span>
          </label>
        </div>

        <div class="form-section">
          <p class="form-section__title">${icon('sliders')} Accent colour</p>
          <div class="color-swatches">
            ${GROUP_COLORS.map((c) => `<button type="button" class="swatch ${c === groupDraft.color ? 'is-on' : ''}" data-swatch="${c}" style="--swatch:${c}" aria-label="Colour ${c}" aria-pressed="${c === groupDraft.color}"></button>`).join('')}
          </div>
        </div>

        <div class="form-section">
          <p class="form-section__title">${icon('users')} Bots in this group <span class="member-count" id="group-count">${groupDraft.botIds.size}</span></p>
          <div id="group-members-picker">${memberPickerHtml()}</div>
        </div>
      </div>
      <div class="modal__foot">
        <span class="modal__spacer"></span>
        <button class="btn btn-ghost" type="button" data-action="close-modal">Cancel</button>
        <button class="btn btn-primary" type="button" id="group-save">${icon('check')}<span>${existing ? 'Save group' : 'Create group'}</span></button>
      </div>
    </div>`;
  syncLock();

  const save = async () => {
    setFormError('group-error', '');
    const name = String($('#group-name').value || '').trim();
    if (!name) { setFormError('group-error', 'Give the group a name.'); $('#group-name').focus(); return; }
    const payload = { name, color: groupDraft.color, botIds: Array.from(groupDraft.botIds) };
    const btn = $('#group-save');
    busyButton(btn, true);
    try {
      if (existing) await api(`/api/groups/${existing.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/api/groups', { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      toast('ok', existing ? 'Group updated' : 'Group created', `${name} · ${payload.botIds.length} bot${payload.botIds.length === 1 ? '' : 's'}`);
      loadState().catch(() => {});
    } catch (err) {
      setFormError('group-error', err.message || 'Could not save the group.');
      busyButton(btn, false);
    }
  };
  $('#group-save').addEventListener('click', save);
  $('#group-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  setTimeout(() => $('#group-name').focus(), 80);
}

/* ── run one command on every bot in a group ─────────────────────────────── */
function openGroupCommand(id) {
  const group = state.groups.find((g) => g.id === id);
  if (!group) return;
  const members = (group.botIds || []).map(findBot).filter(Boolean);
  const online = members.filter((b) => b.status === 'online');
  const root = $('#modal-root');
  root.hidden = false;
  root.innerHTML = `
    <div class="modal modal--sm" role="dialog" aria-modal="true" aria-labelledby="group-cmd-title">
      <div class="modal__head">
        <div class="modal__icon" style="color:${esc(group.color)};background:color-mix(in srgb, ${esc(group.color)} 13%, transparent);border-color:color-mix(in srgb, ${esc(group.color)} 26%, transparent)">${icon('terminal')}</div>
        <div class="modal__titles">
          <h2 id="group-cmd-title">Run on ${esc(group.name)}</h2>
          <p>One command, sent to every online bot in this group.</p>
        </div>
        <button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">${icon('x')}</button>
      </div>
      <div class="modal__body">
        <div class="modal__error" id="group-cmd-error"></div>
        <label class="field field--full">
          <span class="field__label">Command or message</span>
          <span class="field__control">${icon('terminal', 'ico field__icon')}
            <input id="group-command-input" maxlength="250" placeholder="/afk, /login Sandun123, /server oneblock, or a message" autocomplete="off" spellcheck="false" />
          </span>
          <span class="field__hint">${online.length} of ${members.length} bots online — offline bots are skipped.</span>
        </label>
        <div class="cmd-presets">
          ${['/afk', '/login Sandun123', '/server oneblock', 'Hello everyone'].map((c) => `<button type="button" class="cmd-preset" data-group-cmd="${esc(c)}">${esc(c)}</button>`).join('')}
        </div>
      </div>
      <div class="modal__foot">
        <span class="modal__spacer"></span>
        <button class="btn btn-ghost" type="button" data-action="close-modal">Cancel</button>
        <button class="btn btn-primary" type="button" id="group-cmd-send" ${online.length ? '' : 'disabled'}>${icon('send')}<span>Send to ${online.length} bot${online.length === 1 ? '' : 's'}</span></button>
      </div>
    </div>`;
  syncLock();

  const send = async () => {
    const input = $('#group-command-input');
    const message = String((input && input.value) || '').trim();
    const err = $('#group-cmd-error');
    if (!message) { if (err) err.textContent = 'Type a command or message first.'; if (input) input.focus(); return; }
    const btn = $('#group-cmd-send');
    if (btn) btn.disabled = true;
    try {
      const res = await api(`/api/groups/${id}/command`, { method: 'POST', body: JSON.stringify({ message }) });
      const skipped = Array.isArray(res.skipped) && res.skipped.length ? `Skipped: ${res.skipped.join(', ')}` : message;
      toast('ok', `Sent to ${res.sent} bot${res.sent === 1 ? '' : 's'}`, skipped);
      closeModal();
    } catch (e) {
      if (err) err.textContent = e.message || String(e);
      if (btn) btn.disabled = false;
    }
  };

  const sendBtn = $('#group-cmd-send');
  if (sendBtn) sendBtn.addEventListener('click', send);
  const input = $('#group-command-input');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
    });
    setTimeout(() => input.focus(), 120);
  }
}
