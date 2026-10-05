// Display helpers for Claude Bot: wrapping, message grouping, paging and list
// windows. Plain functions so they can be tested outside the glasses.
//
// Nothing scrolls on the glasses: scroll-view ignores positions set from code
// so lists show a window of rows around the selection and
// transcripts show one page of one message at a time.

import { plainText } from './bridge.js';

// Full-width characters per row at 17px; ASCII counts 0.55.
export const LINE_UNITS = 24;
// Text rows per transcript page (the speaker label is extra).
export const PAGE_ROWS = 8;
// List rows visible at once.
export const LIST_ROWS = 4;

function charUnits(ch) {
  return ch.charCodeAt(0) < 128 ? 0.55 : 1;
}

export function hardWrap(text, units = LINE_UNITS) {
  const out = [];
  let row = '';
  let width = 0;
  for (const ch of text) {
    const w = charUnits(ch);
    if (width + w > units) {
      // Break at the last space when there is one.
      const cut = row.lastIndexOf(' ');
      if (cut > row.length / 2) {
        out.push(row.slice(0, cut));
        row = row.slice(cut + 1);
      } else {
        out.push(row);
        row = '';
      }
      width = 0;
      for (const c of row) width += charUnits(c);
    }
    row += ch;
    width += w;
  }
  out.push(row);
  return out;
}

function wrapBlock(text, cls, out) {
  for (const line of String(text).split('\n')) {
    for (const row of hardWrap(line || ' ')) out.push({ cls, t: row || ' ' });
  }
}

function stepsLine(names) {
  const unique = [...new Set(names)];
  const shown = unique.slice(0, 3).join(', ') + (unique.length > 3 ? '…' : '');
  return `▸ ${names.length} step${names.length === 1 ? '' : 's'}: ${shown}`;
}

// Groups transcript items (user / assistant / tool / error, oldest first) into
// turns: each "you" message, then one "claude" message holding its text with
// runs of tool calls folded into a single "▸ N steps" line.
export function buildMessages(items) {
  const messages = [];
  let claude = null;
  let steps = [];

  const flushSteps = () => {
    if (!steps.length) return;
    claude.lines.push({ cls: 'ln tool', t: stepsLine(steps) });
    steps = [];
  };

  for (const item of items) {
    if (item.role === 'user') {
      if (claude) flushSteps();
      claude = null;
      const msg = { who: 'you', lines: [] };
      wrapBlock(plainText(item.text), 'ln you', msg.lines);
      messages.push(msg);
      continue;
    }
    if (!claude) {
      claude = { who: 'claude', lines: [] };
      messages.push(claude);
    }
    if (item.role === 'tool') {
      // "▸ Bash: list files" → "Bash"
      steps.push(String(item.text).replace(/^▸\s*/, '').split(':')[0]);
    } else {
      flushSteps();
      wrapBlock(item.role === 'error' ? item.text : plainText(item.text), item.role === 'error' ? 'ln err' : 'ln', claude.lines);
    }
  }
  if (claude) flushSteps();
  return messages.filter((m) => m.lines.length);
}

export function pageCount(message) {
  return Math.max(1, Math.ceil(message.lines.length / PAGE_ROWS));
}

export function pageLines(message, page) {
  return message.lines.slice(page * PAGE_ROWS, (page + 1) * PAGE_ROWS);
}

// Moves one page through the transcript. Forward: next page, then the next
// message's first page. Back: previous page, then the previous message's
// first page (skimming backwards reads each message from its start).
export function step(messages, pos, dir) {
  const msg = messages[pos.msg];
  if (!msg) return null;
  if (dir > 0) {
    if (pos.page + 1 < pageCount(msg)) return { msg: pos.msg, page: pos.page + 1 };
    if (pos.msg + 1 < messages.length) return { msg: pos.msg + 1, page: 0 };
    return null;
  }
  if (pos.page > 0) return { msg: pos.msg, page: pos.page - 1 };
  if (pos.msg > 0) return { msg: pos.msg - 1, page: 0 };
  return null;
}

// First row index of the visible window that keeps `sel` in view, moving
// only when the selection leaves it.
export function listWindow(count, sel, start, size = LIST_ROWS) {
  if (count <= size) return 0;
  let next = start || 0;
  if (sel < next) next = sel;
  if (sel >= next + size) next = sel - size + 1;
  return Math.max(0, Math.min(count - size, next));
}

// Longest list a command submenu shows before splitting it into A–Z ranges
// (only LIST_ROWS rows show at once, so long lists mean a lot of swiping).
export const MENU_MAX = 10;

// Groups slash command names into a menu tree. An entry is
// { cmd, label } or { group, count, items: [entries] }. "plugin:name"
// commands group by plugin; three or more sharing a first word
// ("deploy-app", "deploy-db"…) group by that word; longer lists split into
// A–Z ranges. Inside a group, `label` drops the shared prefix.
export function groupCommands(names) {
  const byKey = new Map();
  const keyOf = (name) => {
    const colon = name.indexOf(':');
    if (colon > 0) return name.slice(0, colon);
    const dash = name.indexOf('-');
    return dash > 0 ? name.slice(0, dash) : '';
  };
  for (const name of names) {
    const key = keyOf(name);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(name);
  }
  const entries = [];
  for (const [key, list] of byKey) {
    const plugin = list.some((n) => n.includes(':'));
    if (key && (plugin || list.length >= 3) && list.length > 1) {
      const items = list.map((cmd) => ({ cmd, label: cmd.startsWith(key) && cmd.length > key.length + 1 ? cmd.slice(key.length + 1) : cmd }));
      entries.push({ group: key, count: list.length, items: splitRanges(items) });
    } else list.forEach((cmd) => entries.push({ cmd, label: cmd }));
  }
  return splitRanges(entries);
}

function entryName(e) {
  return e.group || e.label;
}

function splitRanges(entries) {
  entries.sort((a, b) => (entryName(a) < entryName(b) ? -1 : 1));
  if (entries.length <= MENU_MAX) return entries;
  const chunks = [];
  const size = Math.ceil(entries.length / Math.ceil(entries.length / MENU_MAX));
  for (let i = 0; i < entries.length; i += size) {
    const part = entries.slice(i, i + size);
    const first = entryName(part[0])[0].toUpperCase();
    const last = entryName(part[part.length - 1])[0].toUpperCase();
    const count = part.reduce((n, e) => n + (e.count || 1), 0);
    chunks.push({ group: first === last ? first : `${first} – ${last}`, count, items: part });
  }
  return chunks;
}
