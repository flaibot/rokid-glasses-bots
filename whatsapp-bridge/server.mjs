#!/usr/bin/env node
// WhatsApp bridge: lets the Rokid "WhatsApp Bot" agent read your recent
// WhatsApp chats and send text replies, through this Mac.
//
// This Mac becomes a linked device of your WhatsApp account (like WhatsApp
// Web), using Baileys, an unofficial WhatsApp Web client. Link it with
// rokid-utils/whatsapp-link. WhatsApp may restrict or ban numbers that use
// unofficial clients: read the risks in whatsapp-bot/README.md first.
//
// Keeps a small store of recent text messages (MAX_CHATS chats ×
// MAX_MESSAGES each) on this Mac only. Media is never downloaded: photos,
// voice notes etc. show as "[photo]", "[voice note]"… Sends text only, and
// only to chats and contacts it already knows.
//
// Listens on 127.0.0.1 only; the tailnet reaches it through
// `tailscale serve --tcp`. Every request needs the bearer token from
// ~/.whatsapp-bridge/config.json (created on first run, mode 600).
//
// Files (all private to your user): ~/.whatsapp-bridge/
//   config.json   token and port
//   auth/         the linked-device session: equivalent to access to your
//                 WhatsApp account. Delete it (and unlink the device on your
//                 phone) to disconnect for good.
//   store.json    recent chats and messages
//   link-qr.txt   WhatsApp's pairing code while linking
//   bridge.log
//
// Set WHATSAPP_BRIDGE_HOME to use another folder (for testing).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  normalizeMessageContent,
  getContentType,
  jidNormalizedUser,
  isJidGroup,
  isLidUser,
  isPnUser,
} from '@whiskeysockets/baileys';
import { matchContacts } from './match.mjs';

// Every file the bridge (and Baileys) writes is readable by you only.
process.umask(0o077);

const STATE_DIR = process.env.WHATSAPP_BRIDGE_HOME || path.join(os.homedir(), '.whatsapp-bridge');
const CONFIG_PATH = path.join(STATE_DIR, 'config.json');
const AUTH_DIR = path.join(STATE_DIR, 'auth');
const STORE_PATH = path.join(STATE_DIR, 'store.json');
const QR_PATH = path.join(STATE_DIR, 'link-qr.txt');
const LOG_PATH = path.join(STATE_DIR, 'bridge.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024;

const MAX_CHATS = 200;
const MAX_MESSAGES = 50; // per chat
const MAX_CONTACTS = 5000;
const MAX_TEXT = 4096; // longest message the bridge sends
const PREVIEW_CHARS = 80;
const SENDS_PER_MINUTE = 10; // a runaway client can't spam from your number
const LINK_WINDOW_MS = 3 * 60 * 1000; // how long a link request shows codes
const SAVE_DELAY_MS = 5000;

// Chats, people and groups only: 123@s.whatsapp.net, 123@lid, 123-456@g.us
// or 1203…@g.us. Status updates, newsletters and broadcasts are left out.
const JID_RE = /^(\d{5,20}(:\d{1,3})?@(s\.whatsapp\.net|lid)|\d{5,20}(-\d{5,15})?@g\.us)$/;

// ---------------------------------------------------------------- config

function loadConfig() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(STATE_DIR, 0o700);
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const defaults = {
    token: crypto.randomBytes(32).toString('hex'),
    port: 8792,
    // Opening a chat on the glasses marks it read on WhatsApp too (blue
    // ticks), as opening it on your phone would. false: only on the glasses.
    sendReadReceipts: true,
    // The name shown in WhatsApp → Linked devices.
    deviceName: 'Rokid Glasses bridge',
  };
  const merged = { ...defaults, ...config };
  if (JSON.stringify(merged) !== JSON.stringify(config)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  }
  fs.chmodSync(CONFIG_PATH, 0o600);
  // An empty token would let unauthenticated requests through.
  if (typeof merged.token !== 'string' || merged.token.length < 32) {
    throw new Error(`${CONFIG_PATH}: "token" must be a string of at least 32 characters`);
  }
  return merged;
}

const config = loadConfig();

let logWrites = 0;

function log(...args) {
  const line = [new Date().toISOString(), ...args].map((a) => (typeof a === 'string' ? a : String(a?.stack || a))).join(' ') + '\n';
  if (logWrites++ % 100 === 0) {
    try {
      if (fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) fs.renameSync(LOG_PATH, LOG_PATH + '.1');
    } catch (e) {}
  }
  try {
    fs.appendFileSync(LOG_PATH, line, { mode: 0o600 });
  } catch (e) {
    process.stdout.write(line);
  }
}

// Baileys logs through a pino-style logger. Only its warnings and errors
// are kept, without the objects attached (they can hold message contents).
const quiet = () => {};
const baileysLogger = {
  level: 'warn',
  child() {
    return baileysLogger;
  },
  trace: quiet,
  debug: quiet,
  info: quiet,
  warn: (obj, msg) => log('baileys warn', typeof obj === 'string' ? obj : msg || ''),
  error: (obj, msg) => log('baileys error', typeof obj === 'string' ? obj : msg || obj?.err?.message || ''),
  fatal: (obj, msg) => log('baileys fatal', typeof obj === 'string' ? obj : msg || ''),
};

// ---------------------------------------------------------------- store

// chats: jid → { id, name, t (ms of last message), unread, messages: [
//   { id, fromMe, who, text, t } ] oldest first }
// contacts: jid → { id, name, notify }
const store = { chats: new Map(), contacts: new Map() };
let saveTimer = null;

function loadStore() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    for (const c of data.chats || []) if (JID_RE.test(c.id)) store.chats.set(c.id, c);
    for (const c of data.contacts || []) if (typeof c.id === 'string') store.contacts.set(c.id, c);
  } catch (e) {
    if (e.code !== 'ENOENT') log('store unreadable, starting empty:', e.message);
  }
}

function saveStoreNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const data = JSON.stringify({ chats: [...store.chats.values()], contacts: [...store.contacts.values()] });
  const tmp = STORE_PATH + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}

function saveStore() {
  if (!saveTimer) saveTimer = setTimeout(() => {
    try {
      saveStoreNow();
    } catch (e) {
      log('store save failed:', e.message);
    }
  }, SAVE_DELAY_MS);
}

function trimStore() {
  if (store.chats.size > MAX_CHATS) {
    const keep = [...store.chats.values()].sort((a, b) => b.t - a.t).slice(0, MAX_CHATS);
    store.chats = new Map(keep.map((c) => [c.id, c]));
  }
  if (store.contacts.size > MAX_CONTACTS) {
    store.contacts = new Map([...store.contacts].slice(-MAX_CONTACTS));
  }
}

// Phone-number jids for people; a @lid jid when that's all there is.
function chatJid(jid, alt) {
  if (isLidUser(jid) && alt && isPnUser(alt)) return jidNormalizedUser(alt);
  return jidNormalizedUser(jid);
}

function phoneOf(jid) {
  return isPnUser(jid) ? '+' + jid.split('@')[0] : '';
}

function contactName(jid) {
  const c = store.contacts.get(jid);
  return c?.name || c?.notify || '';
}

function chatName(chat) {
  return chat.name || contactName(chat.id) || phoneOf(chat.id) || (isJidGroup(chat.id) ? 'Group' : 'Unknown');
}

function getChat(jid) {
  let chat = store.chats.get(jid);
  if (!chat) {
    chat = { id: jid, name: '', t: 0, unread: 0, messages: [] };
    store.chats.set(jid, chat);
  }
  return chat;
}

function oneLine(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// The text of a message, or a placeholder for media. Null for things that
// aren't messages to show (reactions, edits, protocol messages).
function messageText(message) {
  const content = normalizeMessageContent(message);
  if (!content) return null;
  const type = getContentType(content);
  const m = content[type] || {};
  const caption = m.caption ? ' ' + m.caption : '';
  switch (type) {
    case 'conversation':
      return content.conversation || null;
    case 'extendedTextMessage':
      return m.text || null;
    case 'imageMessage':
      return '[photo]' + caption;
    case 'videoMessage':
      return (m.gifPlayback ? '[GIF]' : '[video]') + caption;
    case 'audioMessage':
      return m.ptt ? '[voice note]' : '[audio]';
    case 'documentMessage':
    case 'documentWithCaptionMessage':
      return `[document${m.fileName ? ': ' + m.fileName : ''}]` + caption;
    case 'stickerMessage':
      return '[sticker]';
    case 'locationMessage':
    case 'liveLocationMessage':
      return '[location]';
    case 'contactMessage':
      return `[contact${m.displayName ? ': ' + m.displayName : ''}]`;
    case 'contactsArrayMessage':
      return '[contacts]';
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return `[poll${m.name ? ': ' + m.name : ''}]`;
    case 'eventMessage':
      return `[event${m.name ? ': ' + m.name : ''}]`;
    default:
      return null;
  }
}

function toSeconds(value) {
  const n = Number(value?.toNumber ? value.toNumber() : value);
  return Number.isFinite(n) ? n : 0;
}

// Adds a WhatsApp message to the store. live: received just now (counts as
// unread when it isn't yours).
function addMessage(msg, live) {
  const key = msg?.key;
  if (!key?.remoteJid || !msg.message) return;
  const jid = chatJid(key.remoteJid, key.remoteJidAlt);
  if (!JID_RE.test(jid)) return;
  const text = messageText(msg.message);
  if (text === null) return;
  const chat = getChat(jid);
  if (chat.messages.some((m) => m.id === key.id)) return;
  const t = toSeconds(msg.messageTimestamp) * 1000 || Date.now();
  let who = '';
  if (!key.fromMe) {
    const sender = isJidGroup(jid) ? chatJid(key.participant || '', key.participantAlt) : jid;
    who = contactName(sender) || msg.pushName || phoneOf(sender) || '';
    // Remember the name people give themselves, for lookups.
    if (msg.pushName && sender && !isJidGroup(sender)) {
      const c = store.contacts.get(sender) || { id: sender };
      if (c.notify !== msg.pushName) store.contacts.set(sender, { ...c, notify: msg.pushName });
    }
  }
  chat.messages.push({ id: key.id, fromMe: Boolean(key.fromMe), who, text: oneLine(text, MAX_TEXT), t });
  chat.messages.sort((a, b) => a.t - b.t);
  if (chat.messages.length > MAX_MESSAGES) chat.messages.splice(0, chat.messages.length - MAX_MESSAGES);
  if (t > chat.t) chat.t = t;
  if (live && !key.fromMe) chat.unread = (chat.unread || 0) + 1;
  if (live && key.fromMe) chat.unread = 0; // you replied on another device
  if (isJidGroup(jid) && !chat.name) fetchGroupName(jid);
}

function addChat(c) {
  const id = c?.id && chatJid(c.id, c.pnJid);
  if (!id || !JID_RE.test(id)) return;
  const chat = getChat(id);
  if (c.name) chat.name = c.name;
  if (typeof c.unreadCount === 'number') chat.unread = Math.max(0, c.unreadCount);
  const t = toSeconds(c.conversationTimestamp) * 1000;
  if (t > chat.t) chat.t = t;
}

function addContact(c) {
  if (!c?.id) return;
  for (const raw of [c.id, c.phoneNumber, c.lid]) {
    if (!raw) continue;
    const id = jidNormalizedUser(raw);
    if (!JID_RE.test(id)) continue;
    const prev = store.contacts.get(id) || { id };
    store.contacts.set(id, {
      id,
      name: c.name || c.verifiedName || prev.name || '',
      notify: c.notify || prev.notify || '',
    });
  }
}

const groupLookups = new Set();

async function fetchGroupName(jid) {
  if (groupLookups.has(jid) || !sock) return;
  groupLookups.add(jid);
  try {
    const meta = await sock.groupMetadata(jid);
    if (meta?.subject) {
      getChat(jid).name = meta.subject;
      saveStore();
    }
  } catch (e) {
    log('group name lookup failed:', e.message);
  }
}

// ---------------------------------------------------------------- WhatsApp

let sock = null;
let state = 'unlinked'; // unlinked | linking | connecting | open | closed
let linked = false;
let me = '';
let linkUntil = 0;
let retryDelay = 2000;
let retryTimer = null;
// Messages sent from here, for WhatsApp's resend requests (getMessage).
const sentMessages = new Map();

function clearQr() {
  fs.rmSync(QR_PATH, { force: true });
}

function scheduleReconnect(ms) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, ms);
}

async function connect() {
  clearTimeout(retryTimer);
  fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(AUTH_DIR, 0o700);
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  // A QR-linked device has `me` set; `registered` is only set by
  // phone-number pairing, so it can't tell on its own.
  linked = Boolean(auth.creds.registered || auth.creds.me?.id);
  // Not linked and nobody asked to link: stay idle rather than keep asking
  // WhatsApp for pairing codes.
  if (!linked && Date.now() > linkUntil) {
    state = 'unlinked';
    clearQr();
    return;
  }
  state = linked ? 'connecting' : 'linking';
  const socket = makeWASocket({
    auth,
    logger: baileysLogger,
    browser: Browsers.macOS(config.deviceName),
    // Don't appear "online" all the time, so your phone still notifies you.
    markOnlineOnConnect: false,
    // Recent history only (what the phone sends by default).
    syncFullHistory: false,
    getMessage: async (key) => sentMessages.get(key.id),
  });
  sock = socket;

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', (update) => {
    if (sock !== socket) return;
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      fs.writeFileSync(QR_PATH, qr, { mode: 0o600 });
      log('pairing code ready: run rokid-utils/whatsapp-link to show it');
    }
    if (connection === 'open') {
      state = 'open';
      linked = true;
      linkUntil = 0;
      retryDelay = 2000;
      me = socket.user?.name || '';
      clearQr();
      log('connected to WhatsApp');
    }
    if (connection === 'close') {
      sock = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        // Unlinked from the phone: forget the session and its messages.
        log('logged out from the phone: removing the linked-device session');
        linked = false;
        state = 'unlinked';
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        store.chats.clear();
        store.contacts.clear();
        saveStoreNow();
        clearQr();
        return;
      }
      state = 'closed';
      if (!linked && Date.now() > linkUntil) {
        state = 'unlinked';
        clearQr();
        return;
      }
      // 515 "restart required" follows a successful link: reconnect now.
      const delay = code === DisconnectReason.restartRequired ? 0 : retryDelay;
      retryDelay = Math.min(retryDelay * 2, 5 * 60 * 1000);
      log('connection closed', code || '', `reconnecting in ${Math.round(delay / 1000)}s`);
      scheduleReconnect(delay);
    }
  });

  socket.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
    for (const c of contacts || []) addContact(c);
    for (const c of chats || []) addChat(c);
    for (const m of messages || []) addMessage(m, false);
    trimStore();
    saveStore();
  });
  socket.ev.on('chats.upsert', (chats) => {
    for (const c of chats) addChat(c);
    saveStore();
  });
  socket.ev.on('chats.update', (updates) => {
    for (const u of updates) {
      const id = u.id && chatJid(u.id);
      const chat = id && store.chats.get(id);
      if (!chat) continue;
      if (u.name) chat.name = u.name;
      // Read on the phone: unreadCount drops to 0.
      if (typeof u.unreadCount === 'number') chat.unread = Math.max(0, u.unreadCount);
    }
    saveStore();
  });
  socket.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) addContact(c);
    saveStore();
  });
  socket.ev.on('contacts.update', (contacts) => {
    for (const c of contacts) if (c.id) addContact({ ...store.contacts.get(jidNormalizedUser(c.id)), ...c });
    saveStore();
  });
  socket.ev.on('messages.upsert', ({ messages, type }) => {
    for (const m of messages) addMessage(m, type === 'notify');
    trimStore();
    saveStore();
  });
}

// ---------------------------------------------------------------- HTTP

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

function authorized(req) {
  const header = req.headers.authorization || '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(config.token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch (e) {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function requireJid(value) {
  if (typeof value !== 'string' || !JID_RE.test(value)) throw Object.assign(new Error('Bad chat id'), { status: 400 });
  return value;
}

function requireOpen() {
  if (state !== 'open' || !sock) {
    const message = linked ? 'Not connected to WhatsApp right now. Try again shortly.' : 'WhatsApp is not linked yet: run rokid-utils/whatsapp-link on the Mac.';
    throw Object.assign(new Error(message), { status: 503 });
  }
}

function chatSummary(chat) {
  const last = chat.messages[chat.messages.length - 1];
  const preview = last ? (last.fromMe ? 'You: ' : isJidGroup(chat.id) && last.who ? `${last.who}: ` : '') + last.text : '';
  return { id: chat.id, name: chatName(chat), group: Boolean(isJidGroup(chat.id)), t: chat.t, unread: chat.unread || 0, preview: oneLine(preview, PREVIEW_CHARS) };
}

const sendTimes = [];

async function route(req, res) {
  const url = new URL(req.url, 'http://bridge');
  let parts;
  try {
    parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  } catch (e) {
    return send(res, 400, { error: 'Bad path' });
  }
  if (!authorized(req)) return send(res, 401, { error: 'Bad token' });

  // GET /api/health
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, { ok: true, linked, state, me });
  }
  // POST /api/link: start linking (rokid-utils/whatsapp-link); the pairing
  // code appears in link-qr.txt for LINK_WINDOW_MS.
  if (req.method === 'POST' && url.pathname === '/api/link') {
    if (linked) return send(res, 200, { linked: true, state });
    linkUntil = Date.now() + LINK_WINDOW_MS;
    if (!sock) await connect();
    return send(res, 200, { linked: false, state });
  }
  // GET /api/chats?limit=: recent chats, newest first
  if (req.method === 'GET' && url.pathname === '/api/chats') {
    const limit = Math.max(1, Math.min(MAX_CHATS, Number(url.searchParams.get('limit')) || 50));
    const chats = [...store.chats.values()]
      .filter((c) => c.messages.length || c.t)
      .sort((a, b) => b.t - a.t)
      .slice(0, limit)
      .map(chatSummary);
    return send(res, 200, { chats, linked, state });
  }
  // GET /api/chats/:jid/messages?limit=: oldest first
  if (req.method === 'GET' && parts[1] === 'chats' && parts[3] === 'messages' && parts.length === 4) {
    const jid = requireJid(parts[2]);
    const chat = store.chats.get(jid);
    if (!chat) return send(res, 404, { error: 'No such chat' });
    const limit = Math.max(1, Math.min(MAX_MESSAGES, Number(url.searchParams.get('limit')) || MAX_MESSAGES));
    return send(res, 200, { chat: chatSummary(chat), messages: chat.messages.slice(-limit) });
  }
  // GET /api/contacts?q=: best matches for a spoken name
  if (req.method === 'GET' && url.pathname === '/api/contacts') {
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
    if (!q) return send(res, 400, { error: 'Say a name' });
    const candidates = new Map();
    for (const chat of store.chats.values()) candidates.set(chat.id, { id: chat.id, names: [chat.name, contactName(chat.id)], t: chat.t });
    for (const c of store.contacts.values()) {
      if (!JID_RE.test(c.id)) continue;
      const prev = candidates.get(c.id);
      candidates.set(c.id, { id: c.id, names: [...(prev?.names || []), c.name, c.notify], t: prev?.t || 0 });
    }
    const matches = matchContacts(q, [...candidates.values()]).map((m) => {
      const chat = store.chats.get(m.id);
      return { id: m.id, name: chat ? chatName(chat) : m.name, matched: m.name, score: m.score, group: Boolean(isJidGroup(m.id)), t: chat?.t || 0 };
    });
    return send(res, 200, { matches });
  }
  // POST /api/send { jid, text }: a text message to a known chat or contact
  if (req.method === 'POST' && url.pathname === '/api/send') {
    const body = await readBody(req);
    const jid = requireJid(body.jid);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return send(res, 400, { error: 'Empty message' });
    if (text.length > MAX_TEXT) return send(res, 400, { error: 'Message too long' });
    if (!store.chats.has(jid) && !store.contacts.has(jid)) return send(res, 404, { error: 'Unknown chat. Only chats and contacts already on WhatsApp can be messaged.' });
    requireOpen();
    const now = Date.now();
    while (sendTimes.length && now - sendTimes[0] > 60000) sendTimes.shift();
    if (sendTimes.length >= SENDS_PER_MINUTE) return send(res, 429, { error: 'Too many messages in a minute. Wait a little.' });
    sendTimes.push(now);
    const sent = await sock.sendMessage(jid, { text });
    if (sent?.key?.id) {
      sentMessages.set(sent.key.id, sent.message);
      if (sentMessages.size > 200) sentMessages.delete(sentMessages.keys().next().value);
      addMessage(sent, false);
      const chat = getChat(jid);
      chat.unread = 0;
      saveStore();
    }
    log('sent a message', sent?.key?.id || '');
    return send(res, 200, { ok: true, id: sent?.key?.id || null });
  }
  // POST /api/read { jid }: mark a chat read (on WhatsApp too, if
  // sendReadReceipts)
  if (req.method === 'POST' && url.pathname === '/api/read') {
    const body = await readBody(req);
    const jid = requireJid(body.jid);
    const chat = store.chats.get(jid);
    if (!chat) return send(res, 404, { error: 'No such chat' });
    const unread = chat.unread || 0;
    chat.unread = 0;
    saveStore();
    if (unread && config.sendReadReceipts && state === 'open' && sock) {
      const keys = chat.messages
        .filter((m) => !m.fromMe)
        .slice(-unread)
        .map((m) => ({ remoteJid: jid, id: m.id, fromMe: false }));
      sock.readMessages(keys).catch((e) => log('read receipts failed:', e.message));
    }
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Not found' });
}

loadStore();

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!e.status) log('error', req.method, logPath(req), e.stack || e);
    send(res, e.status || 500, { error: e.status ? e.message : 'Internal error' });
  });
});

// Logged without the query string (it can hold a contact name) or numbers.
function logPath(req) {
  return String(req.url || '').split('?')[0].replace(/\d{5,}/g, '…');
}

server.listen(config.port, '127.0.0.1', () => {
  log(`WhatsApp bridge on http://127.0.0.1:${config.port}`);
  connect().catch((e) => log('connect failed:', e.stack || e));
});

function shutdown() {
  try {
    if (saveTimer) saveStoreNow();
  } catch (e) {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
