// Display helpers for WhatsApp Bot: wrapping, chat pages and list windows.
// Plain functions so they can be tested outside the glasses
// (node lib/ui.test.mjs).
//
// Nothing scrolls on the glasses: scroll-view ignores positions set from
// code, so lists show a window of rows around the selection and a chat
// shows one page of lines at a time.

// Full-width characters per row at 17px; ASCII counts 0.55.
export const LINE_UNITS = 24;
// Text rows per chat page.
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

// One block per message: a "Name · 14:05" line, then its wrapped text.
// Messages in a row from the same sender share one name line.
// messages: [{ fromMe, who, text, t }] oldest first; label(m) gives the name
// line's text.
export function buildBlocks(messages, label) {
  const blocks = [];
  let lastWho = null;
  for (const m of messages) {
    const who = m.fromMe ? 'You' : m.who || '';
    const lines = [];
    if (who !== lastWho) lines.push({ cls: m.fromMe ? 'ln who me' : 'ln who', t: label(m) });
    lastWho = who;
    for (const part of String(m.text || '').split('\n')) {
      for (const row of hardWrap(part || ' ')) lines.push({ cls: m.fromMe ? 'ln me' : 'ln', t: row || ' ' });
    }
    blocks.push(lines);
  }
  return blocks;
}

// Pages of PAGE_ROWS lines. A message starts on a new page when it doesn't
// fit in what's left; one longer than a page fills the rest of the current
// page and carries on.
export function buildPages(blocks, rows = PAGE_ROWS) {
  const pages = [];
  let page = [];
  for (const block of blocks) {
    if (page.length && page.length + block.length > rows && block.length <= rows) {
      pages.push(page);
      page = [];
    }
    for (const line of block) {
      if (page.length === rows) {
        pages.push(page);
        page = [];
      }
      page.push(line);
    }
  }
  if (page.length) pages.push(page);
  return pages;
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
