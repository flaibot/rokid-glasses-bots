<script def>
{
  "navigationBarTitleText": "Hermes Bot",
  "description": "Talk to the user's own Hermes agent. Use for anything the user asks Hermes or Hermes Bot to do or answer.",
  "schema": {
    "data": {
      "type": "object",
      "properties": {
        "prompt": {
          "type": "string",
          "description": "The user's request for Hermes, copied word for word. Leave empty if the user only asked to open Hermes Bot."
        }
      }
    }
  }
}
</script>

<script setup>
import wx from 'wx';
import BarcodeDetector from 'barcode';
import { askHermes, plainText } from '../../lib/hermes.js';
import { speakThen } from '../../lib/speak.js';
import { listen } from '../../lib/listen.js';
import { conversations, turnsOf, addTurn, ago } from '../../lib/history.js';
import { VERSION } from '../../lib/version.js';
import { decodeWebP } from '../../lib/webp.js';
import { loadSettings, saveSettings, isConfigured, settingsFromQr, newConversation } from '../../lib/settings.js';

// Opening the agent starts listening straight away, and it listens again after
// each spoken reply; silence ends the back-and-forth. Enter (temple tap) drives
// every step: listen again, stop listening early, cancel a request, cut a
// spoken reply short, or photograph the setup QR code. Saying "scan" (or
// "setup") reopens the scanner.
const HINT = {
  idle: 'Tap to talk · swipe for menu',
  listening: 'Listening… pause to send · tap = send now · swipe = read',
  thinking: 'Thinking… tap to cancel',
  speaking: 'Speaking… tap to talk',
  error: 'Tap to try again',
  menu: 'Swipe to choose · tap to select',
  scan: 'Look at the setup QR code and tap',
  decoding: 'Reading QR code…',
};

// Replies are shown a page at a time: scroll-view ignores a scroll-top set
// from code on the glasses, so swipes flip pages instead. Text is
// hard-wrapped so one display line is one screen row (20px text).
const LINE_UNITS = 21; // full-width characters per row; ASCII counts 0.55
const PAGE_ROWS = 7;
const SWIPE_DEBOUNCE_MS = 250; // one swipe sends two arrow keys

function hardWrap(text) {
  const out = [];
  let row = '';
  let units = 0;
  for (const ch of text) {
    const w = ch.charCodeAt(0) < 128 ? 0.55 : 1;
    if (units + w > LINE_UNITS) {
      // Break at the last space when there is one.
      const cut = row.lastIndexOf(' ');
      if (cut > row.length / 2) {
        out.push(row.slice(0, cut));
        row = row.slice(cut + 1);
      } else {
        out.push(row);
        row = '';
      }
      units = 0;
      for (const c of row) units += c.charCodeAt(0) < 128 ? 0.55 : 1;
    }
    row += ch;
    units += w;
  }
  out.push(row);
  return out;
}


// The menu: swipe past the last page of a reply (or on a short one) opens
// it; tap stays "talk", the most common action. Back steps out of submenus.
// Hermes ignores slash commands over its API (it answered "/help" in prose,
// in testing), so the menu's actions are done here.
const MENU_ROWS = 4;

// Only asks that answered quickly in testing (fast mode, fresh
// conversation): weather ~12 s, headlines ~14 s. Add your own: calendar or
// email asks only make sense if your agent has those accounts connected
// (without them, one took over 2 minutes looking for a way in), and open
// asks like "brief me on today" made many tool calls (~90 s).
// QUICK_SUFFIX adds the length/time budget.
const QUICK_ASKS = [
  { title: 'Weather today', text: "What's the weather today where I am?" },
  { title: 'Top headlines', text: 'Top 3 news headlines right now.' },
];
const QUICK_SUFFIX = ' Answer in at most three short lines for my glasses display; check only what you need.';

function listWindow(count, sel, start) {
  if (count <= MENU_ROWS) return 0;
  let next = start || 0;
  if (sel < next) next = sel;
  if (sel >= next + MENU_ROWS) next = sel - MENU_ROWS + 1;
  return Math.max(0, Math.min(count - MENU_ROWS, next));
}

const SCAN_COMMAND = /^\s*(scan|set ?up)( (the )?(qr|code|qr code))?[.!]?\s*$/i;
const SMART_COMMAND = /^\s*(smart|careful|think harder|thinking)( mode| model)?[.!]?\s*$|^\s*use (the )?smart(er)? model[.!]?\s*$/i;
const FAST_COMMAND = /^\s*(fast|quick|speed)( mode| model)?[.!]?\s*$|^\s*use (the )?fast(er)? model[.!]?\s*$/i;
const NEW_COMMAND = /^\s*(new|fresh|start a new|start (a )?fresh|reset( the)?) ?(conversation|chat|session)?[.!]?\s*$|^\s*start over[.!]?\s*$/i;

// True when the text is only the phrase that opened the agent ("Open Hermes
// Bot", "Hi Rokid, open Hermes-bot", "打开 Hermes"). Sent as a request, the
// agent once spent a minute trying to "open" something.
function isLaunchPhrase(text) {
  const rest = String(text || '')
    .toLowerCase()
    .replace(/^\s*((hi|hey|ok)\s*)?(rokid|乐奇)[\s,，.。!！]*/, '')
    .replace(/^\s*(please\s+)?(open|start|launch|run|use|打开|启动|开启|打开一下)\s*(the\s+)?/, '')
    .replace(/hermes|赫尔墨斯/g, '')
    .replace(/[\s\-_]*(bot|机器人|助手)?/g, '')
    .replace(/[\s,，.。!！?？]/g, '');
  return rest === '';
}

export default {
  data: {
    version: `v${VERSION}`,
    state: 'idle',
    hint: HINT.idle,
    question: '',
    answer: '',
    tool: '',
    error: '',
    answerLines: [],
    rows: [],
    menuPos: '',
    page: '',
  },

  onLoad(query) {
    // A request passed in by the Rokid assistant or an AI Shortcut is sent
    // straight away instead of listening first.
    this.pendingPrompt = typeof query?.prompt === 'string' ? query.prompt.trim() : '';
    if (isLaunchPhrase(this.pendingPrompt)) this.pendingPrompt = '';
    this.recognition = null;
    this.controller = null;
    this.cameraCtx = null;
    this.stopSpeech = null;
    this.settings = loadSettings();
    if (!isConfigured(this.settings)) {
      this.openScanner('Scan the setup QR code to connect');
      return;
    }
    // Open on the last exchange of this conversation (lib/history.js).
    this.turns = turnsOf(this.settings.CONVERSATION);
    this.viewTurn = null;
    if (this.turns.length) this.showTurn(this.turns.length - 1);
  },

  // Shows a stored exchange; swipes step through the others.
  showTurn(i) {
    const turn = this.turns[i];
    if (!turn) return;
    this.viewTurn = i;
    this.setState('idle', {
      question: turn.q,
      answer: turn.a,
      tool: '',
      hint: `${i + 1}/${this.turns.length} · ${ago(turn.at)} · tap to talk`,
    });
  },

  onShow() {
    if (this.data.state === 'scan') this.cameraCtx = wx.media.createCameraContext();
    else if (this.data.state !== 'idle') return;
    else if (this.pendingPrompt) {
      const prompt = this.pendingPrompt;
      this.pendingPrompt = '';
      this.send(prompt);
    } else this.startListening();
  },

  onHide() {
    this.stopListening(true);
    this.endSpeech();
    this.cameraCtx = null;
  },

  onUnload() {
    this.stopListening(true);
    this.endSpeech();
    this.cancelRequest();
  },

  setState(state, extra = {}) {
    this.setData({ state, hint: HINT[state], ...this.paged(extra) });
  },

  // When `extra` sets the answer, also sets its pages. `follow` shows the
  // last page (while a reply streams in); otherwise the first.
  paged(extra, follow) {
    if (!('answer' in extra)) return extra;
    this.answerRows = [];
    String(extra.answer || '').split('\n').forEach((line) => {
      hardWrap(line || ' ').forEach((row) => this.answerRows.push(row));
    });
    if (!extra.answer) this.answerRows = [];
    const last = Math.max(0, Math.ceil(this.answerRows.length / PAGE_ROWS) - 1);
    this.pageIndex = follow ? last : 0;
    return { ...extra, ...this.pageData() };
  },

  pageData() {
    const rows = this.answerRows || [];
    const pages = Math.ceil(rows.length / PAGE_ROWS);
    const lines = rows.slice(this.pageIndex * PAGE_ROWS, (this.pageIndex + 1) * PAGE_ROWS).map((r, i) => ({ id: `a${this.pageIndex}_${i}`, t: r || ' ' }));
    return { answerLines: lines, page: pages > 1 ? `${this.pageIndex + 1}/${pages}` : '' };
  },

  fail(message) {
    this.setState('error', { error: message, tool: '' });
  },

  onKeyDown(event) {
    if (event.code === 'Enter') this.primaryAction();
    else if (event.code === 'ArrowDown' || event.code === 'ArrowRight') this.flipPage(1);
    else if (event.code === 'ArrowUp' || event.code === 'ArrowLeft') this.flipPage(-1);
  },

  onKeyUp(event) {
    // We handle these ourselves; Backspace keeps its default (back / close)
    // except in the menu, where it steps back.
    if (['Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) event.preventDefault();
    if (event.code === 'Backspace' && this.data.state === 'menu') {
      event.preventDefault();
      if (this.menuName !== 'main') this.openMenu(this.menuName === 'settings' ? 'more' : 'main');
      else this.closeMenu();
    }
  },

  onRowTap(event) {
    const target = event?.currentTarget || event?.target || {};
    const index = Number(target.dataset?.index ?? target.attributes?.['data-index']);
    if (!Number.isFinite(index) || this.data.state !== 'menu') return;
    this.menu.sel = this.menu.start + index;
    this.activate(this.menu.items[this.menu.sel]);
  },

  primaryAction() {
    const { state } = this.data;
    if (state === 'menu') this.activate(this.menu.items[this.menu.sel]);
    else if (state === 'listening') this.stopListening(false);
    else if (state === 'thinking') this.cancelRequest();
    else if (state === 'speaking') {
      this.endSpeech();
      this.startListening();
    }
    else if (state === 'scan') this.scanQr();
    else if (state === 'decoding') return;
    else if (!isConfigured(this.settings)) this.openScanner('');
    else this.startListening();
  },

  flipPage(dir) {
    const now = Date.now();
    if (now - (this.lastSwipe || 0) < SWIPE_DEBOUNCE_MS) return;
    this.lastSwipe = now;
    const { state } = this.data;
    if (state === 'menu') {
      this.moveMenu(dir);
      return;
    }
    // It listens as soon as it opens; a swipe means "let me read first":
    // stop listening (nothing is sent) and browse from the shown exchange.
    if (state === 'listening') {
      this.stopListening(true);
      if (dir > 0) this.openMenu('main');
      else if ((this.turns || []).length) this.showTurn(Math.max(0, (this.viewTurn ?? this.turns.length - 1) - 1));
      return;
    }
    // The reader took over: stop jumping to the newest page while streaming.
    this.userFlipped = true;
    const pages = Math.ceil((this.answerRows || []).length / PAGE_ROWS);
    const next = Math.max(0, Math.min(pages - 1, (this.pageIndex || 0) + dir));
    if (next === (this.pageIndex || 0)) {
      if (!(state === 'idle' || state === 'error') || !isConfigured(this.settings)) return;
      const turns = this.turns || [];
      const at = this.viewTurn ?? turns.length - 1;
      // Before page 1: the previous exchange. Past the last page: the next
      // one, and after the newest, the menu.
      if (dir < 0 && at > 0) this.showTurn(at - 1);
      else if (dir > 0 && this.viewTurn != null && at < turns.length - 1) this.showTurn(at + 1);
      else if (dir > 0) this.openMenu('main');
      return;
    }
    this.pageIndex = next;
    this.setData(this.pageData());
  },

  // ---------------------------------------------------------------- voice

  startListening() {
    if (!isConfigured(this.settings)) return;
    this.setState('listening', { error: '', tool: '', hint: 'Listening… pause to send · tap = send now · swipe = read' });
    // Callbacks can run before listen() returns (a mic error), so the
    // handle check allows that case.
    let handle = null;
    const mine = () => !handle || this.recognition === handle;
    handle = listen({
      onText: (heard) => {
        if (mine()) this.setData({ question: heard });
      },
      onError: (message) => {
        if (!mine()) return;
        this.recognition = null;
        handle = undefined;
        // Not interactive yet (still opening): wait for a tap, as before.
        if (/interactive|InvalidState/i.test(message)) this.setState('idle');
        else this.fail(`Mic: ${message}`);
      },
      onDone: (heard) => {
        if (!mine()) return;
        this.recognition = null;
        const text = heard.trim();
        if (SCAN_COMMAND.test(text)) this.openScanner('');
        else if (NEW_COMMAND.test(text)) this.startNewConversation();
        else if (SMART_COMMAND.test(text)) this.setSmart(true);
        else if (FAST_COMMAND.test(text)) this.setSmart(false);
        else if (text && isLaunchPhrase(text)) this.setState('idle', { question: '', hint: 'Only heard the launch phrase · tap to talk' });
        else if (text) this.send(text);
        else this.setState('idle', { question: '' });
      },
    });
    // A synchronous error already ended it.
    if (this.data.state === 'listening') this.recognition = handle;
  },

  // discard: drop what was heard (page hidden or closing); otherwise send it.
  stopListening(discard) {
    const handle = this.recognition;
    if (!handle) return;
    if (discard) {
      this.recognition = null;
      handle.abort();
      if (this.data.state === 'listening') this.setState('idle');
    } else {
      handle.stop(); // onDone sends what was heard
    }
  },

  // ---------------------------------------------------------------- Hermes

  // Stops the request and returns to idle right away; send() ignores
  // anything that arrives for the cancelled request.
  cancelRequest() {
    const controller = this.controller;
    if (!controller) return;
    this.controller = null;
    try {
      controller.abort();
    } catch (e) {}
    this.setState('idle', { tool: '', answer: this.data.answer || '(cancelled)', hint: 'Cancelled · tap to talk' });
  },

  setSmart(smart) {
    this.settings = { ...this.settings, SMART: smart };
    saveSettings(this.settings);
    this.setState('idle', {
      question: '',
      tool: '',
      answer: smart ? 'Smart mode: slower, more careful replies. Say "fast mode" to switch back.' : 'Fast mode: quickest replies. Say "smart mode" for harder questions.',
    });
    this.startListening();
  },

  // ---------------------------------------------------------------- menu

  // name: main | more | earlier | past | quick | settings
  openMenu(name = 'main') {
    this.endSpeech();
    const s = this.settings;
    const back = { title: '‹ Back', act: 'main' };
    let items = [];
    // Main holds the everyday choices; the rest is under More ›.
    if (name === 'main') {
      items.push({ title: '● Talk', act: 'talk' });
      if ((this.turns || []).length) items.push({ title: '☰ Earlier replies ›', sub: `${this.turns.length} in this conversation`, act: 'earlier' });
      items.push({ title: '+ New conversation', sub: 'Shorter history, faster replies', act: 'new' });
      if (conversations().length) items.push({ title: '☰ Past conversations ›', sub: 'Resume an earlier one', act: 'past' });
      items.push({ title: '✓ Quick asks ›', sub: 'Weather, headlines', act: 'quick' });
      items.push({ title: '⋯ More ›', sub: 'Repeat, mode, settings, close', act: 'more' });
    } else if (name === 'more') {
      items.push(back);
      if (this.data.answer) items.push({ title: '↺ Repeat last reply', act: 'repeat' });
      if (this.lastQuestion) items.push({ title: '↻ Ask again', sub: this.lastQuestion, act: 'retry' });
      items.push({ title: s.SMART ? 'Mode: Smart → switch to Fast' : 'Mode: Fast → switch to Smart', sub: s.SMART ? 'Fast: quickest replies' : 'Smart: slower, more careful', act: 'mode' });
      items.push({ title: '○ Settings ›', sub: 'Voice, listening, setup QR', act: 'settings' });
      items.push({ title: '✕ Close Hermes Bot', act: 'close' });
    } else if (name === 'earlier') {
      // Newest first; picking one shows it, and swipes step from there.
      const turns = this.turns || [];
      items = [back].concat(turns.map((t, i) => ({ title: t.q || '(no question)', sub: ago(t.at), act: 'turn', index: i })).reverse());
    } else if (name === 'quick') {
      items = [back].concat(QUICK_ASKS.map((q) => ({ title: q.title, act: 'ask', text: q.text + QUICK_SUFFIX })));
    } else if (name === 'past') {
      items = [back].concat(
        conversations().map((c) => ({
          title: `${c.id === s.CONVERSATION ? '● ' : ''}${c.title}`,
          sub: `${c.turns.length} exchange${c.turns.length === 1 ? '' : 's'} · ${ago(c.updated)}`,
          act: 'resume',
          id: c.id,
        })),
      );
    } else if (name === 'settings') {
      items = [
        { title: '‹ Back', act: 'more' },
        { title: `Speak replies: ${s.SPEAK_REPLIES ? 'On' : 'Off'}`, act: 'toggleSpeak' },
        { title: `Keep listening: ${s.KEEP_LISTENING ? 'On' : 'Off'}`, sub: 'Listen again after each reply', act: 'toggleListen' },
        { title: 'Scan setup QR code', act: 'scan' },
      ];
    }
    this.menuName = name;
    const sel = name === 'main' ? 0 : 1;
    this.menu = { items, sel, start: 0 };
    this.setState('menu', { tool: '', error: '' });
    this.renderMenu();
  },

  renderMenu() {
    const { items, sel } = this.menu;
    this.menu.start = listWindow(items.length, sel, this.menu.start);
    const rows = items.slice(this.menu.start, this.menu.start + MENU_ROWS).map((item, i) => ({
      id: `m${this.menuName}${this.menu.start + i}`,
      index: String(i),
      cls: this.menu.start + i === sel ? 'row sel' : 'row',
      title: item.title.length > 38 ? item.title.slice(0, 37) + '…' : item.title,
      sub: item.sub ? (item.sub.length > 50 ? item.sub.slice(0, 49) + '…' : item.sub) : '',
    }));
    this.setData({ rows, menuPos: `${sel + 1}/${items.length}` });
  },

  moveMenu(dir) {
    const next = Math.max(0, Math.min(this.menu.items.length - 1, this.menu.sel + dir));
    if (next === this.menu.sel) return;
    this.menu.sel = next;
    this.renderMenu();
  },

  closeMenu() {
    this.menuName = '';
    this.setState('idle', { rows: [] });
    // Back to the reply that was showing.
    this.setData(this.pageData());
  },

  activate(item) {
    if (!item) return;
    const s = this.settings;
    const save = (patch) => {
      this.settings = { ...s, ...patch };
      saveSettings(this.settings);
    };
    switch (item.act) {
      case 'resume':
        save({ CONVERSATION: item.id });
        this.turns = turnsOf(item.id);
        this.menuName = '';
        if (this.turns.length) this.showTurn(this.turns.length - 1);
        else this.closeMenu();
        break;
      case 'turn':
        this.closeMenu();
        this.showTurn(item.index);
        break;
      case 'main':
      case 'more':
      case 'earlier':
      case 'quick':
      case 'past':
      case 'settings':
        this.openMenu(item.act);
        break;
      case 'talk':
        this.closeMenu();
        this.startListening();
        break;
      case 'repeat':
        this.closeMenu();
        this.setState('speaking');
        this.stopSpeech = speakThen(this.data.answer, () => {
          this.stopSpeech = null;
          if (this.data.state === 'speaking') this.setState('idle');
        });
        break;
      case 'retry':
        this.closeMenu();
        this.send(this.lastQuestion);
        break;
      case 'ask':
        this.closeMenu();
        this.send(item.text);
        break;
      case 'new':
        this.closeMenu();
        this.startNewConversation();
        break;
      case 'mode':
        this.closeMenu();
        this.setSmart(!s.SMART);
        break;
      case 'toggleSpeak':
        save({ SPEAK_REPLIES: !s.SPEAK_REPLIES });
        this.openMenu('settings');
        this.menu.sel = 1;
        this.renderMenu();
        break;
      case 'toggleListen':
        save({ KEEP_LISTENING: !s.KEEP_LISTENING });
        this.openMenu('settings');
        this.menu.sel = 2;
        this.renderMenu();
        break;
      case 'scan':
        this.openScanner('');
        break;
      case 'close':
        try {
          wx.exitMiniProgram();
        } catch (e) {
          this.closeMenu();
        }
        break;
    }
  },

  startNewConversation() {
    this.settings = { ...this.settings, CONVERSATION: newConversation() };
    saveSettings(this.settings);
    this.turns = [];
    this.viewTurn = null;
    this.setState('idle', { question: '', answer: 'New conversation started. Ask me anything.', tool: '' });
    this.startListening();
  },

  async send(question) {
    this.lastQuestion = question;
    this.viewTurn = null;
    const controller = new AbortController();
    this.controller = controller;
    this.userFlipped = false;
    this.setState('thinking', { question, answer: '', tool: '' });

    try {
      const reply = await askHermes(
        this.settings,
        question,
        {
          onText: (text) => {
            // paged() resets to page 1 or the last page; keep the reader's
            // page once they have swiped.
            const keep = this.userFlipped ? this.pageIndex : null;
            const update = this.paged({ answer: plainText(text), tool: '' }, !this.userFlipped);
            if (keep != null) {
              this.pageIndex = Math.min(keep, Math.max(0, Math.ceil(this.answerRows.length / PAGE_ROWS) - 1));
              Object.assign(update, this.pageData());
            }
            this.setData(update);
          },
          onTool: (name) => this.setData({ tool: `Using ${name}…` }),
        },
        controller.signal,
      );
      if (this.controller !== controller) return;
      this.controller = null;
      const answer = plainText(reply) || '(no reply)';
      addTurn(this.settings.CONVERSATION, question, answer);
      this.turns = turnsOf(this.settings.CONVERSATION);
      this.viewTurn = this.turns.length - 1;
      if (this.settings.SPEAK_REPLIES && reply) {
        this.setState('speaking', { answer, tool: '' });
        this.stopSpeech = speakThen(answer, () => {
          this.stopSpeech = null;
          if (this.data.state !== 'speaking') return;
          if (this.settings.KEEP_LISTENING) this.startListening();
          else this.setState('idle');
        });
      } else {
        this.setState('idle', { answer, tool: '' });
        if (this.settings.KEEP_LISTENING) this.startListening();
      }
    } catch (e) {
      // Cancelled by the user: cancelRequest() already updated the screen.
      if (this.controller !== controller) return;
      this.controller = null;
      const message = e.message || 'Could not reach Hermes';
      if (/^Hermes 401/.test(message)) this.openScanner('Key rejected. Scan the setup QR code again');
      else this.fail(message);
    }
  },

  endSpeech() {
    if (!this.stopSpeech) return;
    this.stopSpeech();
    this.stopSpeech = null;
  },

  // ---------------------------------------------------------------- setup QR

  openScanner(message) {
    this.stopListening(true);
    this.cameraCtx = wx.media.createCameraContext();
    this.setState('scan', { error: message, answer: '', question: '', tool: '' });
  },

  async scanQr() {
    this.setState('decoding', { error: '' });
    try {
      if (!this.cameraCtx) this.cameraCtx = wx.media.createCameraContext();
      const photo = await this.cameraCtx.takePhoto({ quality: 'high' });
      if (!String(photo?.mimeType || '').toLowerCase().includes('webp')) {
        throw new Error(`Unsupported photo format: ${photo?.mimeType || 'unknown'}`);
      }
      const image = await decodeWebP(photo.data, { output: 'gray' });
      const codes = await new BarcodeDetector().detect({
        data: image.gray,
        width: image.width,
        height: image.height,
      });
      if (!codes || codes.length === 0) {
        this.setState('scan', { error: 'No QR code found. Move closer and tap again' });
        return;
      }
      const next = codes
        .map((code) => settingsFromQr(String(code.rawValue || ''), this.settings))
        .find(Boolean);
      if (!next) {
        this.setState('scan', { error: 'That is not a Hermes setup code' });
        return;
      }
      this.settings = next;
      saveSettings(next);
      this.cameraCtx = null;
      this.setState('idle', { error: '', answer: 'Connected. Ask me anything.' });
      this.startListening();
    } catch (e) {
      this.setState('scan', { error: e.message || 'Could not read the QR code' });
    }
  },
};
</script>

<page>
  <view class="page">
    <camera class="camera" ink:if="{{state === 'scan' || state === 'decoding'}}"></camera>
    <block ink:else>
      <text class="question" ink:if="{{question}}">› {{question}}</text>
      <view class="answer-box" ink:if="{{state === 'menu'}}">
        <view ink:for="{{rows}}" ink:key="id" class="{{item.cls}}" bindtap="onRowTap" data-index="{{item.index}}">
          <text class="title">{{item.title}}</text>
          <text class="sub" ink:if="{{item.sub}}">{{item.sub}}</text>
        </view>
      </view>
      <view class="answer-box" ink:else>
        <text ink:for="{{answerLines}}" ink:key="id" class="answer">{{item.t}}</text>
      </view>
      <text class="tool" ink:if="{{state === 'menu'}}">{{menuPos}}</text>
      <text class="tool" ink:elif="{{page}}">page {{page}} · swipe for more</text>
      <text class="tool" ink:if="{{tool}}">{{tool}}</text>
    </block>
    <text class="error" ink:if="{{error}}">{{error}}</text>
    <view class="footrow">
      <text class="hint {{state}}">{{hint}}</text>
      <text class="ver">{{version}}</text>
    </view>
  </view>
</page>

<style>
.page {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px;
  box-sizing: border-box;
  background: #000000;
  font-family: sans-serif;
}

.camera {
  flex: 1;
  width: 100%;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid rgba(64, 255, 94, 0.24);
}

.question {
  font-size: 16px;
  color: rgba(64, 255, 94, 0.48);
  margin-bottom: 8px;
}

.answer-box {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.answer {
  font-size: 20px;
  line-height: 28px;
  color: rgba(64, 255, 94, 0.72);
}

.row {
  display: flex;
  flex-direction: column;
  padding: 4px 8px;
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
}

.sub {
  font-size: 13px;
  color: rgba(64, 255, 94, 0.48);
}

.tool,
.error {
  font-size: 14px;
  margin-top: 6px;
  color: rgba(64, 255, 94, 0.48);
}

.error {
  color: #40ff5e;
}

.footrow {
  display: flex;
  flex-direction: row;
  align-items: flex-end;
}

.ver {
  font-size: 10px;
  margin-left: 8px;
  color: rgba(64, 255, 94, 0.24);
}

.hint {
  flex: 1;
  font-size: 14px;
  margin-top: 8px;
  color: rgba(64, 255, 94, 0.48);
}

.hint.listening,
.hint.thinking,
.hint.speaking,
.hint.scan {
  color: #40ff5e;
}
</style>
