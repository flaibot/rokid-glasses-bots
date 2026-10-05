<script def>
{
  "navigationBarTitleText": "Claude Bot",
  "description": "Browse and reply to the Claude Code sessions on the user's Mac. Use when the user asks to open Claude Bot or check on Claude Code.",
  "disableScroll": true
}
</script>

<script setup>
import wx from 'wx';
import BarcodeDetector from 'barcode';
import { decodeWebP } from '../../lib/webp.js';
import { loadSettings, saveSettings, isConfigured, settingsFromQr, api, ago } from '../../lib/bridge.js';
import { VERSION } from '../../lib/version.js';
import { listen } from '../../lib/listen.js';
import { buildMessages, pageCount, pageLines, step, listWindow, hardWrap, groupCommands, LIST_ROWS } from '../../lib/ui.js';

// Touchpad first; everything is reachable with swipe + tap:
//   lists (worktrees, sessions): swipe = move one row, tap = open. Back,
//     Refresh and Setup are rows too.
//   transcript: swipe = next/previous page (then message), tap = menu:
//     Reply · Latest · Commands › · Quick replies › · More › (first
//     message, refresh, back to sessions). Commands › holds the everyday
//     ones, Review changes ›, and the worktree's own commands under
//     Built-in › and Skills ›, grouped by plugin/prefix and A–Z. Reply is
//     preselected so tap-tap starts a voice reply. While Claude works:
//     Stop reply · Latest · More ›.
//   sessions list: "+ New session here" speaks the first message.
//   reply: tap = stop listening, then tap = send / swipe = cancel.
//   double tap (Backspace) = back, when the system passes it on.
// Mouse: click any row; the buttons at the bottom do the same as gestures.
//
// Ink quirks: clearTimeout(null) throws (use clear()); scroll-view ignores
// positions set from code (so nothing here scrolls; see lib/ui.js).
// Touchpad keys: a tap is Enter (acted on at key-down), sometimes only
// GlobalHook; a swipe is GlobalHook then two arrow keys.

const SWIPE_DEBOUNCE_MS = 250;
const HOOK_FALLBACK_MS = 800;
const TAP_GUARD_MS = 600; // one physical tap can arrive as Enter and GlobalHook
const RUN_POLL_MS = 1500;
const TRANSCRIPT_LIMIT = 2000; // the bridge's maximum: whole sessions at once

function clear(timer) {
  if (timer) clearTimeout(timer);
}

// One line per row: Ink may not honour white-space: nowrap.
function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function datasetValue(event, name) {
  const target = event?.currentTarget || event?.target || {};
  return target.dataset?.[name] ?? target.attributes?.[`data-${name}`];
}

// Shown first under Commands ›, when the worktree has them (all verified to
// answer in a reply). Everything else is under Built-in › and Skills ›.
const CORE_COMMANDS = [
  { name: 'context', title: 'Context usage' },
  { name: 'usage', title: 'Plan usage' },
  { name: 'compact', title: 'Compact conversation' },
];

// Under Commands › Review changes ›.
const REVIEW_COMMANDS = [
  { name: 'code-review', title: 'Review changes' },
  { name: 'simplify', title: 'Simplify changes' },
  { name: 'verify', title: 'Verify changes' },
  { name: 'security-review', title: 'Security review' },
];

const QUICK_REPLIES = ['Continue', 'Yes, go ahead', "What's left to do?", 'Summarize where we are in a few lines', 'Stop here and wait for me'];

const BUTTONS = {
  list: [{ action: 'up', label: '▲' }, { action: 'down', label: '▼' }, { action: 'ok', label: 'Open' }],
  menu: [{ action: 'up', label: '▲' }, { action: 'down', label: '▼' }, { action: 'ok', label: 'Select' }, { action: 'back', label: 'Close' }],
  read: [{ action: 'up', label: '◀' }, { action: 'down', label: '▶' }, { action: 'ok', label: 'Menu' }, { action: 'back', label: '‹ Back' }],
  listening: [{ action: 'ok', label: 'Stop' }, { action: 'back', label: 'Cancel' }],
  confirm: [{ action: 'ok', label: 'Send' }, { action: 'back', label: 'Cancel' }],
};

export default {
  data: {
    version: `v${VERSION}`,
    view: 'worktrees', // scan | worktrees | sessions | session
    mode: 'read', // in a session: read | menu | listening | confirm | running
    header: 'Claude Bot',
    pos: '',
    rows: [],
    who: '',
    lines: [],
    hint: '',
    error: '',
    buttons: [],
    keyInfo: '',
  },

  onLoad() {
    this.settings = loadSettings();
    this.worktrees = [];
    this.sessions = [];
    this.worktree = null;
    this.session = null;
    this.list = { items: [], sel: 0, start: 0 };
    this.items = [];
    this.liveItems = [];
    this.messages = [];
    this.cur = { msg: 0, page: 0 };
    this.draft = '';
    this.recognition = null;
    this.hookTimer = null;
    this.lastSwipe = 0;
    this.lastTap = 0;
    this.runId = null;
    this.runNext = 0;
    this.pollTimer = null;
    this.pollGen = 0;
    // Bumped on every navigation; a load that finishes after the user moved
    // on is dropped.
    this.nav = 0;
    this.cameraCtx = null;
    if (isConfigured(this.settings)) this.openWorktrees();
    else this.openScanner('Scan the Claude Bot setup QR code');
  },

  onShow() {
    if (this.data.view === 'scan') this.cameraCtx = wx.media.createCameraContext();
  },

  onHide() {
    this.abortListening();
    this.cameraCtx = null;
  },

  onUnload() {
    this.abortListening();
    this.stopPolling();
    clear(this.hookTimer);
    this.hookTimer = null;
  },

  // ---------------------------------------------------------------- input

  swipeDir(event) {
    const c = event.code || event.key || '';
    if (c === 'ArrowDown' || c === 'ArrowRight' || c === 'PageDown') return 1;
    if (c === 'ArrowUp' || c === 'ArrowLeft' || c === 'PageUp') return -1;
    return 0;
  },

  cancelHook() {
    clear(this.hookTimer);
    this.hookTimer = null;
  },

  noteKey(phase, event) {
    // Shown on the setup screen to see what the touchpad sends.
    this.keyLog = (this.keyLog || []).concat(`${phase}:${event.code || event.key || '?'}`).slice(-4);
    if (this.data.view === 'scan') this.setData({ keyInfo: `keys ${this.keyLog.join(' ')}` });
  },

  onKeyDown(event) {
    this.noteKey('down', event);
    // Defaults run on key-up, so they are stopped there.
    if (event.code === 'Enter') {
      this.cancelHook();
      this.primaryAction();
      return;
    }
    const dir = this.swipeDir(event);
    if (!dir) return;
    this.cancelHook();
    const now = Date.now();
    if (now - this.lastSwipe < SWIPE_DEBOUNCE_MS) return;
    this.lastSwipe = now;
    this.move(dir);
  },

  onKeyUp(event) {
    this.noteKey('up', event);
    if (this.swipeDir(event)) {
      event.preventDefault();
      return;
    }
    if (event.code === 'GlobalHook') {
      // Some firmware sends only this for a tap. Skip it when a tap (Enter)
      // or swipe was just handled, and fire only if none follows.
      this.cancelHook();
      const at = Date.now();
      if (at - this.lastTap < 1000 || at - this.lastSwipe < 1000) return;
      this.hookTimer = setTimeout(() => {
        this.hookTimer = null;
        if (this.lastTap < at && this.lastSwipe < at) this.primaryAction();
      }, HOOK_FALLBACK_MS);
      return;
    }
    if (event.code === 'Backspace') {
      this.cancelHook();
      if (this.data.view === 'worktrees' || (this.data.view === 'scan' && !isConfigured(this.settings))) return; // system: close
      event.preventDefault();
      this.back();
      return;
    }
    if (event.code === 'Enter') {
      // Handled on key-down; stop the system's default here.
      event.preventDefault();
      this.cancelHook();
    }
  },

  onRowTap(event) {
    const index = Number(datasetValue(event, 'index'));
    if (!Number.isFinite(index)) return;
    this.list.sel = this.list.start + index;
    this.renderList();
    this.lastTap = 0; // a click is a deliberate tap
    this.primaryAction();
  },

  onButton(event) {
    const action = datasetValue(event, 'action');
    if (action === 'up') this.move(-1);
    else if (action === 'down') this.move(1);
    else if (action === 'back') this.back();
    else if (action === 'shoot') this.scanQr();
    else if (action === 'ok') {
      this.lastTap = 0;
      this.primaryAction();
    }
  },

  isListShown() {
    const { view, mode } = this.data;
    return view === 'worktrees' || view === 'sessions' || (view === 'session' && mode === 'menu');
  },

  move(dir) {
    const { view, mode } = this.data;
    if (this.isListShown()) this.moveSelection(dir);
    else if (view === 'session') {
      if (mode === 'listening') this.abortListening();
      else if (mode === 'confirm') this.cancelDraft();
      else this.flip(dir);
    }
  },

  primaryAction() {
    const now = Date.now();
    if (now - this.lastTap < TAP_GUARD_MS) return;
    this.lastTap = now;
    const { view, mode } = this.data;
    if (view === 'scan') this.scanQr();
    else if (this.isListShown()) this.activate(this.list.items[this.list.sel]);
    else if (view === 'session') {
      if (mode === 'read' || mode === 'running') this.openMenu();
      else if (mode === 'listening') this.stopListening();
      else if (mode === 'confirm') this.sendDraft();
    }
  },

  back() {
    const { view, mode } = this.data;
    if (view === 'session' && mode === 'menu') {
      if (this.menuParent) this.openMenu(this.menuParent.name, this.menuParent.arg);
      else this.closeMenu();
    }
    else if (view === 'session' && mode === 'listening') this.abortListening();
    else if (view === 'session' && mode === 'confirm') this.cancelDraft();
    else if (view === 'session') this.leaveSession();
    else if (view === 'sessions') this.openWorktrees(true);
    else if (view === 'scan' && isConfigured(this.settings)) this.openWorktrees();
  },

  fail(error) {
    if (error?.status === 401) {
      this.openScanner('Key rejected. Scan the Claude Bot setup QR code again');
      return;
    }
    this.setData({ error: error?.message || String(error) });
  },

  // ---------------------------------------------------------------- lists

  // items: [{ title, sub, act }]; act is what a tap on the row does.
  setList(items, sel) {
    const safe = Math.max(0, Math.min(items.length - 1, sel));
    this.list = { items, sel: safe, start: listWindow(items.length, safe, 0) };
    this.renderList();
  },

  renderList() {
    const { items, sel } = this.list;
    this.list.start = listWindow(items.length, sel, this.list.start);
    const rows = items.slice(this.list.start, this.list.start + LIST_ROWS).map((item, i) => ({
      id: `r${this.list.start + i}`,
      index: String(i),
      cls: this.list.start + i === sel ? 'row sel' : 'row',
      title: clip(item.title, 40),
      sub: clip(item.sub || '', 56),
    }));
    this.setData({ rows, pos: items.length ? `${sel + 1}/${items.length}` : '' });
  },

  moveSelection(dir) {
    const count = this.list.items.length;
    if (!count) return;
    const next = Math.max(0, Math.min(count - 1, this.list.sel + dir));
    if (next === this.list.sel) {
      this.setData({ hint: dir > 0 ? 'End of the list' : 'Top of the list' });
      return;
    }
    this.list.sel = next;
    this.renderList();
  },

  activate(item) {
    if (!item) return;
    const act = item.act;
    if (act.type === 'worktree') this.openSessions(this.worktrees[act.index]);
    else if (act.type === 'session') this.openSession(this.sessions[act.index]);
    else if (act.type === 'back') this.back();
    else if (act.type === 'leave') this.leaveSession();
    else if (act.type === 'refresh') this.refresh();
    else if (act.type === 'setup') this.openScanner('');
    else if (act.type === 'reply') this.startListening('');
    else if (act.type === 'menu') this.openMenu(act.name, act.arg);
    else if (act.type === 'send') this.confirmDraft(act.text);
    else if (act.type === 'speak') this.startListening(act.prefix);
    else if (act.type === 'stop') this.stopRun();
    else if (act.type === 'new') this.startNewSession();
    else if (act.type === 'latest') this.jump('latest');
    else if (act.type === 'first') this.jump('first');
  },

  refresh() {
    const { view } = this.data;
    if (view === 'worktrees') this.openWorktrees(true);
    else if (view === 'sessions') this.openSessions(this.worktree, true);
    else if (view === 'session') this.openSession(this.session);
  },

  showListView(view, header, items, sel, hint) {
    this.setData({ view, mode: 'read', header, lines: [], who: '', hint, error: '', buttons: BUTTONS.list });
    this.setList(items, sel);
  },

  async openWorktrees(keepSelection) {
    const nav = ++this.nav;
    const previous = keepSelection && this.worktree ? this.worktree.id : null;
    this.setData({ hint: 'Loading worktrees…', error: '' });
    try {
      const { worktrees } = await api(this.settings, 'GET', '/api/worktrees');
      if (nav !== this.nav) return;
      this.worktrees = worktrees;
      const items = worktrees.map((w, index) => ({
        title: `${w.active ? '● ' : ''}${w.name}`,
        sub: [w.branch, `${w.sessions} session${w.sessions === 1 ? '' : 's'}`, ago(w.updated), w.exists ? '' : 'folder gone'].filter(Boolean).join(' · '),
        act: { type: 'worktree', index },
      }));
      items.push({ title: '○ Refresh', act: { type: 'refresh' } });
      items.push({ title: '○ Scan setup QR code', act: { type: 'setup' } });
      const sel = previous ? Math.max(0, worktrees.findIndex((w) => w.id === previous)) : 0;
      this.showListView('worktrees', 'Worktrees', items, sel, 'Swipe to move · tap to open');
    } catch (e) {
      if (nav !== this.nav) return;
      this.showListView('worktrees', 'Claude Bot', [
        { title: '○ Retry', act: { type: 'refresh' } },
        { title: '○ Scan setup QR code', act: { type: 'setup' } },
      ], 0, '');
      this.fail(e);
    }
  },

  async openSessions(worktree, keepSelection) {
    if (!worktree) return;
    const nav = ++this.nav;
    const previous = keepSelection && this.session ? this.session.id : null;
    this.worktree = worktree;
    this.setData({ hint: 'Loading sessions…', error: '' });
    try {
      const { sessions } = await api(this.settings, 'GET', `/api/worktrees/${encodeURIComponent(worktree.id)}/sessions`);
      if (nav !== this.nav) return;
      this.sessions = sessions;
      const items = [
        { title: '‹ Back to worktrees', act: { type: 'back' } },
        { title: '+ New session here', sub: 'Speak the first message', act: { type: 'new' } },
      ].concat(
        sessions.map((s, index) => ({
          title: `${s.running ? '◆ ' : s.active ? '● ' : ''}${s.title}`,
          sub: [ago(s.updated), s.running ? 'replying' : s.active ? 'busy on Mac' : '', s.lastText].filter(Boolean).join(' · '),
          act: { type: 'session', index },
        })),
      );
      const found = previous ? sessions.findIndex((s) => s.id === previous) : -1;
      // Start on the newest session, not the Back row.
      this.showListView('sessions', worktree.name, items, found >= 0 ? found + 2 : Math.min(2, items.length - 1), 'Swipe to move · tap to open');
    } catch (e) {
      if (nav === this.nav) this.fail(e);
    }
  },

  // ---------------------------------------------------------------- transcript

  async openSession(session) {
    if (!session) return;
    const nav = ++this.nav;
    this.stopPolling();
    this.session = session;
    this.liveItems = [];
    this.setData({ hint: 'Loading…', error: '' });
    try {
      const path = `/api/sessions/${encodeURIComponent(this.worktree.id)}/${encodeURIComponent(session.id)}?limit=${TRANSCRIPT_LIMIT}`;
      const data = await api(this.settings, 'GET', path);
      if (nav !== this.nav) return;
      this.items = data.items;
      this.session = { ...session, replyMode: data.replyMode, active: data.active, start: data.start };
      this.setData({ view: 'session', header: data.title, rows: [] });
      this.setData({ mode: data.run ? 'running' : 'read' });
      this.rebuild();
      this.jump('latest', true);
      // Events up to runNext are already in the transcript.
      if (data.run) this.followRun(data.run, data.runNext || 0);
      else this.setReadMode();
    } catch (e) {
      if (nav !== this.nav) return;
      // Never leave a session stuck in "running" without Reply/Refresh.
      if (this.data.view === 'session' && this.data.mode !== 'read') this.setReadMode();
      this.fail(e);
    }
  },

  leaveSession() {
    // A running reply keeps going on the Mac; the session list shows it.
    this.stopPolling();
    this.nav += 1;
    this.openSessions(this.worktree, true);
  },

  rebuild() {
    this.messages = buildMessages(this.items.concat(this.liveItems));
  },

  // latest: Claude's last message from its first page; first: the first one.
  jump(where, quiet) {
    // Leave the menu first so a running reply stays in running mode.
    if (this.data.mode === 'menu') this.closeMenu();
    const n = this.messages.length;
    if (!n) {
      this.cur = { msg: 0, page: 0 };
    } else if (where === 'first') {
      this.cur = { msg: 0, page: 0 };
    } else {
      // The last message, unless that is yours right after a Claude reply
      // still to come (then Claude's reply before it).
      let msg = n - 1;
      if (this.messages[msg].who === 'you' && n > 1 && this.messages[n - 2].who === 'claude' && this.data.mode !== 'running' && !this.stopRequested) msg = n - 2;
      this.cur = { msg, page: 0 };
    }
    this.showMessage();
    if (!quiet && where === 'first' && this.session?.start) this.setData({ hint: `Oldest ${this.session.start} messages not loaded` });
  },

  showMessage() {
    const msg = this.messages[this.cur.msg];
    if (!msg) {
      this.setData({ who: '', lines: [{ id: 'empty', cls: 'ln tool', t: 'No messages yet' }], pos: '' });
      return;
    }
    const pages = pageCount(msg);
    const lines = pageLines(msg, this.cur.page).map((l, i) => ({ id: `m${this.cur.msg}_${this.cur.page}_${i}`, cls: l.cls, t: l.t }));
    this.setData({
      who: msg.who === 'you' ? 'You' : 'Claude',
      lines,
      pos: `${this.cur.msg + 1}/${this.messages.length}${pages > 1 ? ` · p${this.cur.page + 1}/${pages}` : ''}`,
    });
  },

  flip(dir) {
    const next = step(this.messages, this.cur, dir);
    if (!next) {
      this.setData({ hint: dir > 0 ? 'Latest message · tap for menu' : 'First message · tap for menu' });
      return;
    }
    this.cur = next;
    this.showMessage();
  },

  readHint() {
    if (this.data.mode === 'running') return 'Claude is working… swipe to read · tap for menu';
    if (this.session?.active) return 'Busy on the Mac · swipe to read · tap for menu';
    return 'Swipe to read · tap for menu';
  },

  setReadMode(hint) {
    this.setData({ rows: [], mode: 'read', buttons: BUTTONS.read, hint: hint || this.readHint() });
    this.showMessage();
  },

  // ---------------------------------------------------------------- menu

  // name: main | more | commands | review | tree | command | quick.
  // arg: for tree, the path to a command group ("skills/2/0"); for
  // command, the command picked. Each submenu's Back row (and double tap)
  // goes to its parent.
  async openMenu(name = 'main', arg) {
    if (this.data.mode !== 'menu') this.menuWasRunning = this.data.mode === 'running';
    const running = this.menuWasRunning && this.runId;
    let parent = { name: 'main' };
    let items = [];
    let hint = 'Swipe to choose · tap to select';
    const cmdRow = (cmd, title, sub) => ({ title: title || `/${cmd}`, sub, act: { type: 'menu', name: 'command', arg: cmd } });
    if (name === 'main') {
      parent = null;
      if (running) {
        items.push({ title: '■ Stop reply', sub: 'Stops Claude on the Mac', act: { type: 'stop' } });
      } else {
        const mode = this.session?.replyMode ? ` (${this.session.replyMode})` : '';
        items.push({ title: `● Reply by voice${mode}`, sub: this.session?.active ? 'Busy on the Mac right now' : '', act: { type: 'reply' } });
      }
      items.push({ title: '▼ Latest reply', act: { type: 'latest' } });
      if (!running) {
        items.push({ title: '/ Commands ›', sub: 'Context, usage, compact, review…', act: { type: 'menu', name: 'commands' } });
        items.push({ title: '✓ Quick replies ›', sub: 'Continue, yes go ahead…', act: { type: 'menu', name: 'quick' } });
      }
      items.push({ title: '⋯ More ›', sub: 'First message, refresh, sessions', act: { type: 'menu', name: 'more' } });
    } else if (name === 'more') {
      items.push({ title: '▲ First message', act: { type: 'first' } });
      if (!running) items.push({ title: '○ Refresh', act: { type: 'refresh' } });
      items.push({ title: '‹ Back to sessions', act: { type: 'leave' } });
    } else if (name === 'commands') {
      const cmds = await this.loadCommands();
      if (this.data.view !== 'session') return;
      const has = (c) => cmds.all.includes(c);
      for (const c of CORE_COMMANDS) if (has(c.name)) items.push(cmdRow(c.name, c.title, `/${c.name}`));
      if (REVIEW_COMMANDS.some((c) => has(c.name))) items.push({ title: 'Review changes ›', sub: 'Review, simplify, verify…', act: { type: 'menu', name: 'review' } });
      if (cmds.builtin.length) items.push({ title: `Built-in (${cmds.builtin.length}) ›`, sub: 'Model, effort, recap…', act: { type: 'menu', name: 'tree', arg: 'builtin' } });
      if (cmds.skills.length) items.push({ title: `Skills (${cmds.skills.length}) ›`, act: { type: 'menu', name: 'tree', arg: 'skills' } });
      if (!cmds.all.length) hint = 'No commands found · double tap = back';
    } else if (name === 'review') {
      const cmds = await this.loadCommands();
      if (this.data.view !== 'session') return;
      parent = { name: 'commands' };
      for (const c of REVIEW_COMMANDS) if (cmds.all.includes(c.name)) items.push(cmdRow(c.name, c.title, `/${c.name}`));
    } else if (name === 'tree') {
      const cmds = await this.loadCommands();
      if (this.data.view !== 'session') return;
      const path = String(arg).split('/');
      let entries = cmds.trees[path[0]] || [];
      let title = path[0] === 'skills' ? 'Skills' : 'Built-in';
      for (const i of path.slice(1)) {
        const group = entries[Number(i)];
        if (!group?.items) break;
        title = group.group;
        entries = group.items;
      }
      parent = path.length > 1 ? { name: 'tree', arg: path.slice(0, -1).join('/') } : { name: 'commands' };
      items = entries.map((e, i) => (e.items
        ? { title: `${e.group} (${e.count}) ›`, act: { type: 'menu', name: 'tree', arg: `${arg}/${i}` } }
        : cmdRow(e.cmd, `/${e.label}`)));
      hint = `${title} · swipe to choose · tap to select`;
    } else if (name === 'command') {
      parent = this.menuName && this.menuName !== 'command' ? { name: this.menuName, arg: this.menuArg } : { name: 'commands' };
      items = [
        { title: `Send /${arg}`, act: { type: 'send', text: `/${arg}` } },
        { title: `Send /${arg} + details by voice`, sub: 'e.g. a PR number or what to focus on', act: { type: 'speak', prefix: `/${arg}` } },
      ];
      hint = `/${arg} · tap to choose`;
    } else if (name === 'quick') {
      items = QUICK_REPLIES.map((text) => ({ title: text, act: { type: 'send', text } }));
    }
    // Every submenu starts with a Back row for the mouse and for systems
    // that keep double tap for themselves; selection starts below it.
    if (parent) items.unshift({ title: '‹ Back', act: { type: 'menu', name: parent.name, arg: parent.arg } });
    this.menuName = name;
    this.menuArg = arg;
    this.menuParent = parent;
    this.setData({ mode: 'menu', who: '', lines: [], buttons: BUTTONS.menu, hint, error: '' });
    this.setList(items, parent ? Math.min(1, items.length - 1) : 0);
  },

  // The current worktree's slash commands: all, the built-in ones and the
  // skills, plus menu trees for both (cached per worktree).
  async loadCommands() {
    const project = this.worktree?.id;
    this.commands = this.commands || {};
    if (this.commands[project]) return this.commands[project];
    this.setData({ hint: 'Loading commands…' });
    try {
      const { commands, skills = [] } = await api(this.settings, 'GET', `/api/commands?project=${encodeURIComponent(project)}`);
      const isSkill = new Set(skills);
      const builtin = commands.filter((c) => !isSkill.has(c));
      const skillList = commands.filter((c) => isSkill.has(c));
      this.commands[project] = {
        all: commands,
        builtin,
        skills: skillList,
        trees: { builtin: groupCommands(builtin), skills: groupCommands(skillList) },
      };
    } catch (e) {
      this.setData({ error: e.message });
      return { all: [], builtin: [], skills: [], trees: {} };
    }
    return this.commands[project];
  },

  async stopRun() {
    const runId = this.runId;
    this.closeMenu();
    if (!runId) return;
    this.stopRequested = true;
    this.setData({ hint: 'Stopping…' });
    try {
      await api(this.settings, 'POST', `/api/runs/${runId}/stop`);
    } catch (e) {
      this.fail(e);
    }
  },

  // A new session in the current worktree: speak the first message; the
  // session opens once Claude reports its id.
  startNewSession() {
    this.stopPolling();
    this.nav += 1;
    this.session = null;
    this.items = [];
    this.liveItems = [];
    this.rebuild();
    this.setData({ view: 'session', header: `New session · ${this.worktree?.name || ''}`, rows: [], pos: '' });
    this.startListening('');
  },

  closeMenu() {
    this.menuName = '';
    this.setData({ rows: [] });
    if (this.menuWasRunning && this.runId) {
      this.setData({ mode: 'running', buttons: BUTTONS.read, hint: this.readHint() });
      this.showMessage();
    } else this.setReadMode();
  },

  // ---------------------------------------------------------------- reply

  showDraft(label, text) {
    const lines = [];
    String(text || '').split('\n').forEach((line) => hardWrap(line || ' ').forEach((t) => lines.push(t)));
    this.setData({ who: label, lines: lines.slice(-8).map((t, i) => ({ id: `d${i}`, cls: 'ln you', t: t || ' ' })), pos: '' });
  },

  // prefix: a slash command the spoken words are added to.
  startListening(prefix) {
    if (this.data.view !== 'session') return;
    this.menuName = '';
    const label = prefix ? `${prefix} (speaking)` : 'You (speaking)';
    this.setData({ rows: [], mode: 'listening', buttons: BUTTONS.listening, hint: 'Listening… pause to finish · tap = done · swipe = cancel', error: '' });
    this.showDraft(label, '…');
    // Keeps listening across short pauses (lib/listen.js). Callbacks can run
    // before listen() returns (a mic error), hence mine().
    let handle = null;
    const mine = () => !handle || this.recognition === handle;
    const failMic = (message) => {
      if (this.session) this.setReadMode();
      else this.leaveSession();
      this.setData({ error: `Mic: ${message}` });
    };
    handle = listen({
      onText: (heard) => {
        if (mine()) this.showDraft(label, heard);
      },
      onError: (message) => {
        if (!mine()) return;
        this.recognition = null;
        handle = undefined;
        failMic(message);
      },
      onDone: (heard) => {
        if (!mine()) return;
        this.recognition = null;
        const text = heard.trim();
        if (!text) {
          if (this.session) this.setReadMode('Did not catch that · tap for menu');
          else this.leaveSession();
          return;
        }
        this.confirmDraft(prefix ? `${prefix} ${text}` : text);
      },
    });
    if (this.data.mode === 'listening') this.recognition = handle;
  },

  confirmDraft(text) {
    this.menuName = '';
    this.draft = text;
    this.setData({ rows: [], mode: 'confirm', buttons: BUTTONS.confirm, hint: 'Tap = send · swipe = cancel' });
    this.showDraft(this.session ? 'Send to Claude?' : 'Start a new session with:', text);
  },

  stopListening() {
    if (this.recognition) this.recognition.stop(); // onDone moves to confirm
  },

  abortListening() {
    const recognition = this.recognition;
    if (!recognition) return;
    this.recognition = null;
    recognition.abort();
    if (this.data.view !== 'session') return;
    if (!this.session) this.leaveSession();
    else this.setReadMode('Cancelled');
  },

  cancelDraft() {
    this.draft = '';
    if (!this.session) {
      this.leaveSession();
      return;
    }
    this.setReadMode('Cancelled');
  },

  async sendDraft() {
    const text = this.draft;
    if (!text || this.data.mode !== 'confirm') return;
    this.draft = '';
    this.liveItems = [{ role: 'user', text }];
    this.setData({ mode: 'running', buttons: BUTTONS.read, hint: 'Sending…' });
    this.rebuild();
    this.jump('latest', true);
    const nav = this.nav;
    try {
      const { run, mode } = this.session
        ? await api(this.settings, 'POST', '/api/reply', { project: this.worktree.id, session: this.session.id, text })
        : await api(this.settings, 'POST', '/api/new', { project: this.worktree.id, text });
      this.newTitle = text;
      // Left the session meanwhile: the reply runs on; the list shows it.
      if (nav !== this.nav) return;
      this.setData({ hint: `Claude is working (${mode})… tap for menu` });
      this.followRun(run, 0);
    } catch (e) {
      if (nav !== this.nav) return;
      this.liveItems = [];
      this.rebuild();
      this.jump('latest', true);
      if (!this.session) {
        this.leaveSession();
        this.fail(e);
        return;
      }
      this.setReadMode();
      this.fail(e);
    }
  },

  stopPolling() {
    this.pollGen += 1;
    this.runId = null;
    clear(this.pollTimer);
    this.pollTimer = null;
  },

  followRun(runId, after) {
    this.stopPolling();
    this.runId = runId;
    this.runNext = after;
    if (this.data.mode !== 'menu') this.setData({ mode: 'running', buttons: BUTTONS.read, hint: this.readHint() });
    this.pollRun(this.pollGen);
  },

  async pollRun(gen) {
    if (gen !== this.pollGen || !this.runId) return;
    try {
      const data = await api(this.settings, 'GET', `/api/runs/${this.runId}?after=${this.runNext}`);
      if (gen !== this.pollGen) return;
      this.runNext = data.next;
      if (!this.session && data.sessionId) {
        this.session = { id: data.sessionId, title: String(this.newTitle || 'New session').slice(0, 60) };
        this.setData({ header: this.session.title });
      }
      if (data.events.length) {
        this.liveItems = this.liveItems.concat(data.events.map((e) => ({ role: e.kind === 'output' ? 'assistant' : e.kind, text: e.text, output: e.kind === 'output' })));
        this.rebuild();
        // Follow the newest text unless the user is in the menu.
        if (this.data.mode === 'running') {
          const last = this.messages.length - 1;
          this.cur = { msg: last, page: last >= 0 ? pageCount(this.messages[last]) - 1 : 0 };
          this.showMessage();
        }
      }
      if (data.done) {
        this.stopPolling();
        this.setData({ mode: 'read' });
        const error = data.error;
        if (!this.session) {
          this.leaveSession();
          this.setData({ error: error || 'The new session did not start' });
          return;
        }
        // Slash-command output isn't in the session file: keep it on screen.
        const outputs = this.liveItems.filter((item) => item.output);
        const stopped = this.stopRequested;
        this.stopRequested = false;
        await this.openSession(this.session);
        if (outputs.length) {
          this.liveItems = outputs;
          this.rebuild();
          this.jump('latest', true);
        }
        if (error) this.setData({ error });
        else this.setData({ hint: stopped ? 'Stopped · tap for menu' : 'Done · tap for menu to reply again' });
        return;
      }
    } catch (e) {
      if (gen !== this.pollGen) return;
      if (e.status === 404) {
        this.stopPolling();
        this.openSession(this.session);
        return;
      }
      this.setData({ error: e.message });
    }
    if (gen === this.pollGen) this.pollTimer = setTimeout(() => this.pollRun(gen), RUN_POLL_MS);
  },

  // ---------------------------------------------------------------- setup QR

  openScanner(message) {
    this.abortListening();
    this.stopPolling();
    this.cameraCtx = wx.media.createCameraContext();
    this.setData({
      view: 'scan',
      mode: 'read',
      header: 'Claude Bot setup',
      pos: '',
      rows: [],
      lines: [],
      who: '',
      error: message,
      hint: 'Look at the setup QR code and tap',
      buttons: [{ action: 'shoot', label: 'Scan' }].concat(isConfigured(this.settings) ? [{ action: 'back', label: '‹ Back' }] : []),
    });
  },

  async scanQr() {
    this.setData({ hint: 'Reading QR code…', error: '' });
    try {
      if (!this.cameraCtx) this.cameraCtx = wx.media.createCameraContext();
      const photo = await this.cameraCtx.takePhoto({ quality: 'high' });
      if (!String(photo?.mimeType || '').toLowerCase().includes('webp')) {
        throw new Error(`Unsupported photo format: ${photo?.mimeType || 'unknown'}`);
      }
      const image = await decodeWebP(photo.data, { output: 'gray' });
      const codes = await new BarcodeDetector().detect({ data: image.gray, width: image.width, height: image.height });
      const next = (codes || []).map((code) => settingsFromQr(String(code.rawValue || ''))).find(Boolean);
      if (!next) {
        this.setData({ hint: 'Look at the setup QR code and tap', error: codes?.length ? 'That is not a Claude Bot setup code' : 'No QR code found. Move closer and tap again' });
        return;
      }
      this.settings = next;
      saveSettings(next);
      this.cameraCtx = null;
      this.openWorktrees();
    } catch (e) {
      this.setData({ hint: 'Look at the setup QR code and tap', error: e.message || 'Could not read the QR code' });
    }
  },
};
</script>

<page>
  <view class="page">
    <view class="headrow">
      <text class="header">{{header}}</text>
      <text class="ver" ink:if="{{view === 'worktrees'}}">{{version}}</text>
      <text class="pageno">{{pos}}</text>
    </view>

    <camera class="camera" ink:if="{{view === 'scan'}}"></camera>

    <view class="body listview" ink:if="{{view === 'worktrees' || view === 'sessions' || (view === 'session' && mode === 'menu')}}">
      <view ink:for="{{rows}}" ink:key="id" class="{{item.cls}}" bindtap="onRowTap" data-index="{{item.index}}">
        <text class="title">{{item.title}}</text>
        <text class="sub" ink:if="{{item.sub}}">{{item.sub}}</text>
      </view>
    </view>

    <view class="body pageview" ink:if="{{view === 'session' && mode !== 'menu'}}">
      <text class="who" ink:if="{{who}}">{{who}}</text>
      <text ink:for="{{lines}}" ink:key="id" class="{{item.cls}}">{{item.t}}</text>
    </view>

    <text class="error" ink:if="{{error}}">{{error}}</text>
    <text class="hint">{{hint}}</text>
    <text class="hint" ink:if="{{view === 'scan' && keyInfo}}">{{keyInfo}}</text>
    <view class="buttons" ink:if="{{buttons.length}}">
      <text ink:for="{{buttons}}" ink:key="action" class="btn" bindtap="onButton" data-action="{{item.action}}">{{item.label}}</text>
    </view>
  </view>
</page>

<style>
.page {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 10px 12px;
  box-sizing: border-box;
  background: #000000;
  font-family: sans-serif;
}

.headrow {
  display: flex;
  flex-direction: row;
  margin-bottom: 6px;
}

.header {
  flex: 1;
  font-size: 15px;
  color: rgba(64, 255, 94, 0.72);
}

.ver {
  font-size: 10px;
  margin: 0 8px;
  color: rgba(64, 255, 94, 0.24);
}

.pageno {
  font-size: 13px;
  color: rgba(64, 255, 94, 0.48);
}

.camera {
  flex: 1;
  width: 100%;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid rgba(64, 255, 94, 0.24);
}

.body {
  flex: 1;
}

.pageview,
.listview {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.who {
  font-size: 13px;
  color: rgba(64, 255, 94, 0.48);
  margin-bottom: 2px;
}

.row {
  display: flex;
  flex-direction: column;
  padding: 5px 8px;
  margin-bottom: 4px;
  border: 1px solid rgba(64, 255, 94, 0.12);
  border-radius: 8px;
}

.row.sel {
  border: 1px solid #40ff5e;
  background-color: rgba(64, 255, 94, 0.12);
}

.title {
  font-size: 17px;
  color: rgba(64, 255, 94, 0.72);
  overflow: hidden;
  white-space: nowrap;
}

.sub {
  font-size: 13px;
  color: rgba(64, 255, 94, 0.48);
  overflow: hidden;
  white-space: nowrap;
}

.ln {
  font-size: 17px;
  line-height: 24px;
  color: rgba(64, 255, 94, 0.72);
}

.ln.you {
  color: #40ff5e;
}

.ln.tool {
  font-size: 14px;
  color: rgba(64, 255, 94, 0.48);
}

.ln.err {
  color: #40ff5e;
}

.gap {
  font-size: 8px;
  line-height: 8px;
}

.error {
  font-size: 13px;
  margin-top: 4px;
  color: #40ff5e;
}

.hint {
  font-size: 13px;
  margin-top: 4px;
  color: rgba(64, 255, 94, 0.48);
}

.buttons {
  display: flex;
  flex-direction: row;
  gap: 8px;
  margin-top: 4px;
}

.btn {
  font-size: 13px;
  padding: 2px 10px;
  border: 1px solid rgba(64, 255, 94, 0.48);
  border-radius: 999px;
  color: rgba(64, 255, 94, 0.72);
}
</style>
