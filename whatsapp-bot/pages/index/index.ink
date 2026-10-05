<script def>
{
  "navigationBarTitleText": "WhatsApp Bot",
  "description": "Read and send the user's WhatsApp messages. Use when the user asks to send a WhatsApp message to someone, message or text a contact on WhatsApp, reply on WhatsApp, or read or check their WhatsApp messages or chats.",
  "disableScroll": true,
  "schema": {
    "data": {
      "type": "object",
      "properties": {
        "prompt": {
          "type": "string",
          "description": "The user's request, copied word for word, e.g. \"send a WhatsApp to Mom saying I'm on my way\" or \"read my WhatsApp messages from John\". Leave empty if the user only asked to open WhatsApp Bot."
        }
      }
    }
  }
}
</script>

<script setup>
import wx from 'wx';
import BarcodeDetector from 'barcode';
import { decodeWebP } from '../../lib/webp.js';
import { loadSettings, saveSettings, isConfigured, settingsFromQr, api, ago, when } from '../../lib/bridge.js';
import { VERSION } from '../../lib/version.js';
import { listen } from '../../lib/listen.js';
import { parseRequest } from '../../lib/intent.js';
import { buildBlocks, buildPages, hardWrap, listWindow, LIST_ROWS } from '../../lib/ui.js';

// Touchpad first; everything is reachable with swipe + tap:
//   chats list: swipe = move one row, tap = open. "✎ New message", Refresh
//     and Setup are rows too.
//   chat: swipe = previous/next page (opens on the newest), tap = menu:
//     Reply · Latest · Refresh · Quick replies › · Back to chats. Reply is
//     preselected, so tap-tap starts a voice reply.
//   reply: tap = done speaking; then a confirm screen shows who and what:
//     tap = send, swipe = cancel. Nothing is ever sent without that tap.
//   "Who?" list (a spoken name with several matches): swipe, tap to pick.
//   double tap (Backspace) = back, when the system passes it on.
// Mouse: click any row; the buttons at the bottom do the same as gestures.
//
// Rokid's assistant can open this page with a request ("send a WhatsApp to
// Mom saying I'm on my way"): lib/intent.js reads it, the bridge finds the
// contact, and the confirm screen waits for a tap.
//
// Ink quirks: clearTimeout(null) throws (use clear()); scroll-view ignores
// positions set from code (so nothing here scrolls; see lib/ui.js).
// Touchpad keys: a tap is Enter (acted on at key-down), sometimes only
// GlobalHook; a swipe is GlobalHook then two arrow keys.

const SWIPE_DEBOUNCE_MS = 250;
const HOOK_FALLBACK_MS = 800;
const TAP_GUARD_MS = 600; // one physical tap can arrive as Enter and GlobalHook
const CHAT_POLL_MS = 8000; // new messages while a chat is open
const LIST_POLL_MS = 20000; // the chats list while it's shown
// A spoken name matching one contact this well, clearly ahead of the next,
// goes straight to the confirm screen; otherwise you pick from a list.
const SURE_SCORE = 0.85;
const SURE_GAP = 0.1;

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

const QUICK_REPLIES = ['On my way', 'OK', 'Thanks!', 'Running late, be there soon', 'Can I call you later?', 'Yes', 'No'];

const BUTTONS = {
  list: [{ action: 'up', label: '▲' }, { action: 'down', label: '▼' }, { action: 'ok', label: 'Open' }],
  menu: [{ action: 'up', label: '▲' }, { action: 'down', label: '▼' }, { action: 'ok', label: 'Select' }, { action: 'back', label: 'Close' }],
  read: [{ action: 'up', label: '◀' }, { action: 'down', label: '▶' }, { action: 'ok', label: 'Menu' }, { action: 'back', label: '‹ Chats' }],
  listening: [{ action: 'ok', label: 'Done' }, { action: 'back', label: 'Cancel' }],
  confirm: [{ action: 'ok', label: 'Send' }, { action: 'back', label: 'Cancel' }],
};

export default {
  data: {
    version: `v${VERSION}`,
    view: 'chats', // scan | chats | pick | chat
    mode: 'read', // in a chat: read | menu | listening | confirm | sending
    header: 'WhatsApp',
    pos: '',
    rows: [],
    who: '',
    lines: [],
    hint: '',
    error: '',
    buttons: [],
    keyInfo: '',
  },

  onLoad(query) {
    this.settings = loadSettings();
    this.chats = [];
    this.chat = null; // { id, name, group }
    this.messages = [];
    this.pages = [];
    this.page = 0;
    this.list = { items: [], sel: 0, start: 0 };
    this.draft = '';
    this.recognition = null;
    this.hookTimer = null;
    this.pollTimer = null;
    this.lastSwipe = 0;
    this.lastTap = 0;
    // Bumped on every navigation; a load that finishes after the user moved
    // on is dropped.
    this.nav = 0;
    this.cameraCtx = null;
    // A request passed in by Rokid's assistant, handled once connected.
    this.pendingPrompt = typeof query?.prompt === 'string' ? query.prompt.trim() : '';
    if (!isConfigured(this.settings)) {
      this.openScanner('Scan the WhatsApp Bot setup QR code');
      return;
    }
    this.start();
  },

  // Opens the chats list, or acts on a request from Rokid's assistant.
  start() {
    const prompt = this.pendingPrompt;
    this.pendingPrompt = '';
    if (prompt) this.handleRequest(prompt);
    else this.openChats();
  },

  onShow() {
    if (this.data.view === 'scan') this.cameraCtx = wx.media.createCameraContext();
  },

  onHide() {
    this.abortListening();
    this.stopPolling();
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
      if (this.data.view === 'chats' || (this.data.view === 'scan' && !isConfigured(this.settings))) return; // system: close
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
    return view === 'chats' || view === 'pick' || (view === 'chat' && mode === 'menu');
  },

  move(dir) {
    const { view, mode } = this.data;
    if (view === 'pick' && this.recognition) this.abortListening();
    else if (this.isListShown()) this.moveSelection(dir);
    else if (view === 'chat') {
      if (mode === 'listening') this.abortListening();
      else if (mode === 'confirm') this.cancelDraft();
      else if (mode === 'read') this.flip(dir);
    }
  },

  primaryAction() {
    const now = Date.now();
    if (now - this.lastTap < TAP_GUARD_MS) return;
    this.lastTap = now;
    const { view, mode } = this.data;
    if (view === 'scan') this.scanQr();
    else if (view === 'pick' && this.recognition) this.stopListening();
    else if (this.isListShown()) this.activate(this.list.items[this.list.sel]);
    else if (view === 'chat') {
      if (mode === 'read') this.openMenu();
      else if (mode === 'listening') this.stopListening();
      else if (mode === 'confirm') this.sendDraft();
    }
  },

  back() {
    const { view, mode } = this.data;
    if (view === 'chat' && mode === 'menu') {
      if (this.menuName && this.menuName !== 'main') this.openMenu('main');
      else this.closeMenu();
    } else if (view === 'chat' && mode === 'listening') this.abortListening();
    else if (view === 'chat' && mode === 'confirm') this.cancelDraft();
    else if (view === 'chat' && mode === 'read') this.openChats(true);
    else if (view === 'pick' && this.recognition) this.abortListening();
    else if (view === 'pick') this.openChats();
    else if (view === 'scan' && isConfigured(this.settings)) this.openChats();
  },

  fail(error) {
    if (error?.status === 401) {
      this.openScanner('Key rejected. Scan the WhatsApp Bot setup QR code again');
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
    if (act.type === 'chat') this.openChat(act.chat);
    else if (act.type === 'pick') this.openChat(act.chat, act.text);
    else if (act.type === 'compose') this.startCompose();
    else if (act.type === 'chats') this.openChats();
    else if (act.type === 'refresh') this.refresh();
    else if (act.type === 'setup') this.openScanner('');
    else if (act.type === 'reply') this.startListening();
    else if (act.type === 'menu') this.openMenu(act.name);
    else if (act.type === 'send') this.confirmDraft(act.text);
    else if (act.type === 'latest') this.closeMenu(true);
  },

  refresh() {
    const { view } = this.data;
    if (view === 'chats') this.openChats(true);
    else if (view === 'chat') this.openChat(this.chat);
  },

  showListView(view, header, items, sel, hint) {
    this.setData({ view, mode: 'read', header, lines: [], who: '', hint, error: '', buttons: BUTTONS.list });
    this.setList(items, sel);
  },

  stopPolling() {
    clear(this.pollTimer);
    this.pollTimer = null;
  },

  // Refreshes the open list or chat every so often, quietly.
  schedulePoll() {
    this.stopPolling();
    const { view } = this.data;
    if (view !== 'chats' && view !== 'chat') return;
    const nav = this.nav;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (nav !== this.nav) return;
      if (this.data.view === 'chats') this.openChats(true, true);
      else if (this.data.view === 'chat' && this.data.mode === 'read') this.loadMessages(true);
      else this.schedulePoll();
    }, view === 'chat' ? CHAT_POLL_MS : LIST_POLL_MS);
  },

  async openChats(keepSelection, quiet) {
    const nav = ++this.nav;
    if (!quiet) this.heardName = '';
    this.stopPolling();
    // The selected chat (a background refresh), or the chat just left.
    const previous = !keepSelection ? null : quiet ? this.list.items[this.list.sel]?.act?.chat?.id : this.chat?.id;
    if (!quiet) this.setData({ hint: 'Loading chats…', error: '' });
    try {
      const { chats, linked, state } = await api(this.settings, 'GET', '/api/chats');
      if (nav !== this.nav) return;
      this.chats = chats;
      const items = [{ title: '✎ New message', sub: 'Say who and what, e.g. "Mom, on my way"', act: { type: 'compose' } }].concat(
        chats.map((c) => ({
          title: `${c.unread ? '● ' : ''}${c.name}${c.unread ? ` (${c.unread})` : ''}`,
          sub: [ago(c.t), c.preview].filter(Boolean).join(' · '),
          act: { type: 'chat', chat: c },
        })),
      );
      items.push({ title: '○ Refresh', act: { type: 'refresh' } });
      items.push({ title: '○ Scan setup QR code', act: { type: 'setup' } });
      const found = previous ? chats.findIndex((c) => c.id === previous) : -1;
      const sel = found >= 0 ? found + 1 : keepSelection && quiet ? this.list.sel : Math.min(1, items.length - 1);
      let hint = 'Swipe to move · tap to open';
      if (!linked) hint = 'WhatsApp is not linked yet: run rokid-utils/whatsapp-link on the Mac';
      else if (state !== 'open') hint = 'Reconnecting to WhatsApp on the Mac…';
      else if (!chats.length) hint = 'No chats yet: they arrive a minute or two after linking';
      if (quiet && this.data.view === 'chats') {
        // Keep the selection where the user left it.
        this.list.items = items;
        this.list.sel = Math.min(sel, items.length - 1);
        this.renderList();
        this.setData({ hint });
      } else this.showListView('chats', 'WhatsApp', items, sel, hint);
    } catch (e) {
      if (nav !== this.nav) return;
      if (!quiet) {
        this.showListView('chats', 'WhatsApp Bot', [
          { title: '○ Retry', act: { type: 'refresh' } },
          { title: '○ Scan setup QR code', act: { type: 'setup' } },
        ], 0, '');
        this.fail(e);
      }
    }
    if (nav === this.nav) this.schedulePoll();
  },

  // ---------------------------------------------------------------- chat

  // chat: { id, name, group }. draft: text to confirm straight away
  // (from a request or a pick); '' to start a voice reply; undefined to read.
  async openChat(chat, draft) {
    if (!chat) return;
    this.nav += 1;
    this.stopPolling();
    this.chat = chat;
    this.messages = [];
    this.pages = [];
    this.page = 0;
    this.setData({ view: 'chat', mode: 'read', header: chat.name, rows: [], who: '', lines: [], pos: '', buttons: BUTTONS.read, error: '', hint: 'Loading…' });
    await this.loadMessages(false);
    if (this.data.view !== 'chat' || this.chat !== chat) return;
    if (typeof draft === 'string') {
      if (draft) this.confirmDraft(draft);
      else this.startListening();
    }
  },

  // quiet: a background refresh; stays on the page being read unless it
  // was the newest.
  async loadMessages(quiet) {
    const nav = this.nav;
    const chat = this.chat;
    try {
      const data = await api(this.settings, 'GET', `/api/chats/${encodeURIComponent(chat.id)}/messages`);
      if (nav !== this.nav || this.data.view !== 'chat') return;
      const changed = data.messages.length !== this.messages.length || data.messages[data.messages.length - 1]?.id !== this.messages[this.messages.length - 1]?.id;
      const atNewest = this.page >= this.pages.length - 1;
      this.messages = data.messages;
      if (!quiet || changed) {
        this.rebuild();
        if (!quiet || atNewest) this.page = Math.max(0, this.pages.length - 1);
        if (this.data.mode === 'read') this.showPage();
      }
      // Seen: mark it read (on WhatsApp too, if the bridge sends receipts).
      if (data.chat.unread && (!quiet || atNewest)) {
        api(this.settings, 'POST', '/api/read', { jid: chat.id }).catch(() => {});
      }
      if (!quiet && this.data.mode === 'read') this.setData({ hint: this.messages.length ? 'Swipe to read · tap for menu' : 'No messages yet · tap for menu' });
    } catch (e) {
      if (nav !== this.nav) return;
      if (e.status === 404) {
        // A contact you haven't chatted with yet (or not since linking).
        this.messages = [];
        this.rebuild();
        this.showPage();
        if (!quiet) this.setData({ hint: 'No messages yet · tap for menu' });
      } else if (!quiet) this.fail(e);
    }
    if (nav === this.nav) this.schedulePoll();
  },

  rebuild() {
    const group = this.chat?.group;
    const label = (m) => `${m.fromMe ? 'You' : group ? m.who || 'Someone' : this.chat.name} · ${when(m.t)}`;
    this.pages = buildPages(buildBlocks(this.messages, label));
  },

  showPage() {
    const page = this.pages[this.page];
    if (!page) {
      this.setData({ who: '', lines: [{ id: 'empty', cls: 'ln who', t: 'No messages yet' }], pos: '' });
      return;
    }
    this.setData({
      who: '',
      lines: page.map((l, i) => ({ id: `p${this.page}_${i}`, cls: l.cls, t: l.t })),
      pos: `${this.page + 1}/${this.pages.length}`,
    });
  },

  flip(dir) {
    const next = this.page + dir;
    if (next < 0 || next >= this.pages.length) {
      this.setData({ hint: dir > 0 ? 'Newest message · tap for menu' : `Oldest loaded message · tap for menu` });
      return;
    }
    this.page = next;
    this.showPage();
    this.setData({ hint: 'Swipe to read · tap for menu' });
  },

  // ---------------------------------------------------------------- menu

  // name: main | quick
  openMenu(name = 'main') {
    let items;
    if (name === 'quick') {
      items = [{ title: '‹ Back', act: { type: 'menu', name: 'main' } }].concat(QUICK_REPLIES.map((text) => ({ title: text, act: { type: 'send', text } })));
    } else {
      items = [
        { title: '● Reply by voice', sub: `To ${this.chat.name}`, act: { type: 'reply' } },
        { title: '▼ Latest', act: { type: 'latest' } },
        { title: '○ Refresh', act: { type: 'refresh' } },
        { title: '✓ Quick replies ›', sub: 'On my way, OK, thanks…', act: { type: 'menu', name: 'quick' } },
        { title: '‹ Back to chats', act: { type: 'chats' } },
      ];
    }
    this.menuName = name;
    this.setData({ mode: 'menu', who: '', lines: [], buttons: BUTTONS.menu, hint: 'Swipe to choose · tap to select', error: '' });
    // Open on the first real choice, not the Back row.
    this.setList(items, name === 'main' ? 0 : 1);
  },

  closeMenu(latest) {
    this.menuName = '';
    if (latest) this.page = Math.max(0, this.pages.length - 1);
    this.setData({ rows: [], mode: 'read', buttons: BUTTONS.read, hint: 'Swipe to read · tap for menu' });
    this.showPage();
    this.schedulePoll();
  },

  // ---------------------------------------------------------------- reply

  showDraft(label, text) {
    const lines = [];
    String(text || '').split('\n').forEach((line) => hardWrap(line || ' ').forEach((t) => lines.push(t)));
    this.setData({ who: label, lines: lines.slice(-8).map((t, i) => ({ id: `d${i}`, cls: 'ln me', t: t || ' ' })), pos: '' });
  },

  startListening() {
    if (this.data.view !== 'chat') return;
    this.menuName = '';
    this.stopPolling();
    const label = `To ${this.chat.name} (speaking)`;
    this.setData({ rows: [], mode: 'listening', buttons: BUTTONS.listening, hint: 'Listening… pause to finish · tap = done · swipe = cancel', error: '' });
    this.showDraft(label, '…');
    // Keeps listening across short pauses (lib/listen.js). Callbacks can run
    // before listen() returns (a mic error), hence mine().
    let handle = null;
    const mine = () => !handle || this.recognition === handle;
    handle = listen({
      onText: (heard) => {
        if (mine()) this.showDraft(label, heard);
      },
      onError: (message) => {
        if (!mine()) return;
        this.recognition = null;
        handle = undefined;
        this.closeMenu();
        this.setData({ error: `Mic: ${message}` });
      },
      onDone: (heard) => {
        if (!mine()) return;
        this.recognition = null;
        const text = heard.trim();
        if (!text) {
          this.closeMenu();
          this.setData({ hint: 'Did not catch that · tap for menu' });
          return;
        }
        this.confirmDraft(text[0].toUpperCase() + text.slice(1));
      },
    });
    if (this.data.mode === 'listening') this.recognition = handle;
  },

  confirmDraft(text) {
    this.menuName = '';
    this.stopPolling();
    this.draft = text;
    this.setData({ rows: [], mode: 'confirm', buttons: BUTTONS.confirm, hint: 'Tap = send · swipe = cancel', error: '' });
    const heard = this.heardName && this.heardName.toLowerCase() !== this.chat.name.toLowerCase() ? ` (heard "${this.heardName}")` : '';
    this.heardName = '';
    this.showDraft(`Send to ${this.chat.name}${heard}?`, text);
  },

  stopListening() {
    if (this.recognition) this.recognition.stop(); // onDone moves to confirm
  },

  abortListening() {
    const recognition = this.recognition;
    if (!recognition) return;
    this.recognition = null;
    recognition.abort();
    if (this.data.view === 'chat') {
      this.closeMenu();
      this.setData({ hint: 'Cancelled · tap for menu' });
    } else if (this.data.view === 'pick') this.openChats();
  },

  cancelDraft() {
    this.draft = '';
    this.closeMenu();
    this.setData({ hint: 'Not sent · tap for menu' });
  },

  async sendDraft() {
    const text = this.draft;
    if (!text || this.data.mode !== 'confirm') return;
    this.draft = '';
    const chat = this.chat;
    this.setData({ mode: 'sending', buttons: [], hint: 'Sending…' });
    try {
      await api(this.settings, 'POST', '/api/send', { jid: chat.id, text });
      if (this.chat !== chat) return;
      this.setData({ mode: 'read', buttons: BUTTONS.read });
      await this.loadMessages(false);
      this.setData({ hint: `Sent to ${chat.name} · tap for menu` });
    } catch (e) {
      if (this.chat !== chat) return;
      // Keep the words: tap tries again.
      this.draft = text;
      this.setData({ mode: 'confirm', buttons: BUTTONS.confirm, hint: 'Not sent · tap = try again · swipe = cancel' });
      this.fail(e);
    }
  },

  // ---------------------------------------------------------------- requests

  // "✎ New message": say who and what ("Mom, I'm on my way").
  startCompose() {
    this.nav += 1;
    this.stopPolling();
    this.list = { items: [], sel: 0, start: 0 };
    this.setData({ view: 'pick', mode: 'read', header: 'New message', rows: [], pos: '', buttons: BUTTONS.listening, error: '', hint: 'Say who and what, e.g. "Mom, on my way" · tap = done · swipe = cancel' });
    let handle = null;
    const mine = () => !handle || this.recognition === handle;
    handle = listen({
      onText: (heard) => {
        if (mine()) this.setData({ rows: [{ id: 'h', index: '0', cls: 'row', title: clip(heard, 40), sub: 'Listening…' }] });
      },
      onError: (message) => {
        if (!mine()) return;
        this.recognition = null;
        handle = undefined;
        this.openChats();
        this.setData({ error: `Mic: ${message}` });
      },
      onDone: (heard) => {
        if (!mine()) return;
        this.recognition = null;
        if (!heard.trim()) {
          this.openChats();
          return;
        }
        const request = parseRequest(heard);
        this.handleRequest(request.kind === 'send' ? heard : `message ${heard}`);
      },
    });
    this.recognition = handle;
  },

  // A request in words, from Rokid's assistant or "New message".
  async handleRequest(words) {
    const request = parseRequest(words);
    if (request.kind === 'open') return this.openChats();
    if (request.kind === 'read') {
      if (!request.name) return this.openChats();
      return this.resolve([{ name: request.name, text: undefined }]);
    }
    return this.resolve(request.options);
  },

  // Finds who's meant. options: [{ name, text }] best guess first; text
  // undefined = just open the chat, '' = ask for the message.
  async resolve(options) {
    const nav = ++this.nav;
    this.stopPolling();
    this.setData({ view: 'pick', mode: 'read', header: 'Who?', rows: [], pos: '', buttons: BUTTONS.list, error: '', hint: `Looking up "${options[0]?.name || ''}"…` });
    let best = null;
    try {
      for (const option of options) {
        const { matches } = await api(this.settings, 'GET', `/api/contacts?q=${encodeURIComponent(option.name)}`);
        if (nav !== this.nav) return;
        if (matches.length && (!best || matches[0].score > best.matches[0].score)) best = { option, matches };
      }
    } catch (e) {
      if (nav !== this.nav) return;
      this.openChats();
      this.fail(e);
      return;
    }
    if (!best) {
      this.openChats();
      this.setData({ error: `No chat or contact matches "${options[0]?.name || ''}"` });
      return;
    }
    const { option, matches } = best;
    const [first, second] = matches;
    const toChat = (m) => ({ id: m.id, name: m.name, group: m.group, unread: 0 });
    // Shown on the confirm screen when it differs from the contact's name.
    this.heardName = option.text === undefined ? '' : option.name;
    if (first.score >= SURE_SCORE && (!second || first.score - second.score >= SURE_GAP)) {
      this.openChat(toChat(first), option.text);
      return;
    }
    const items = matches.map((m) => ({
      title: m.name,
      sub: [m.group ? 'group' : '', m.matched !== m.name ? m.matched : '', m.t ? `last chat ${ago(m.t)}` : ''].filter(Boolean).join(' · '),
      act: { type: 'pick', chat: toChat(m), text: option.text },
    }));
    items.push({ title: '‹ Cancel', act: { type: 'chats' } });
    this.showListView('pick', `Who is "${option.name}"?`, items, 0, option.text ? `Message: ${clip(option.text, 40)}` : 'Swipe to choose · tap to pick');
  },

  // ---------------------------------------------------------------- setup QR

  openScanner(message) {
    this.abortListening();
    this.stopPolling();
    this.nav += 1;
    this.cameraCtx = wx.media.createCameraContext();
    this.setData({
      view: 'scan',
      mode: 'read',
      header: 'WhatsApp Bot setup',
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
        this.setData({ hint: 'Look at the setup QR code and tap', error: codes?.length ? 'That is not a WhatsApp Bot setup code' : 'No QR code found. Move closer and tap again' });
        return;
      }
      this.settings = next;
      saveSettings(next);
      this.cameraCtx = null;
      this.start();
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
      <text class="ver" ink:if="{{view === 'chats'}}">{{version}}</text>
      <text class="pageno">{{pos}}</text>
    </view>

    <camera class="camera" ink:if="{{view === 'scan'}}"></camera>

    <view class="body listview" ink:if="{{view === 'chats' || view === 'pick' || (view === 'chat' && mode === 'menu')}}">
      <view ink:for="{{rows}}" ink:key="id" class="{{item.cls}}" bindtap="onRowTap" data-index="{{item.index}}">
        <text class="title">{{item.title}}</text>
        <text class="sub" ink:if="{{item.sub}}">{{item.sub}}</text>
      </view>
    </view>

    <view class="body pageview" ink:if="{{view === 'chat' && mode !== 'menu'}}">
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

.ln.me {
  color: #40ff5e;
}

.ln.who {
  font-size: 13px;
  line-height: 20px;
  color: rgba(64, 255, 94, 0.48);
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
