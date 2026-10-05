// Tests for ui.js: node lib/ui.test.mjs
import assert from 'node:assert/strict';
import { buildBlocks, buildPages, hardWrap, listWindow } from './ui.js';

const label = (m) => (m.fromMe ? 'You' : m.who);
const msgs = [
  { fromMe: false, who: 'Mom', text: 'Where are you?' },
  { fromMe: false, who: 'Mom', text: 'Dinner at 7' },
  { fromMe: true, text: 'On my way' },
];
const blocks = buildBlocks(msgs, label);
assert.equal(blocks[0][0].t, 'Mom');
assert.equal(blocks[1].length, 1, 'same sender: no second name line');
assert.equal(blocks[2][0].cls, 'ln who me');

// A block that doesn't fit moves to the next page; one longer than a page
// fills the rest of the current page and carries on.
const pages = buildPages([[1, 2, 3], [4, 5, 6], [7, 8, 9, 10, 11, 12, 13]].map((b) => b.map((t) => ({ t }))), 5);
assert.deepEqual(pages.map((p) => p.map((l) => l.t)), [[1, 2, 3], [4, 5, 6, 7, 8], [9, 10, 11, 12, 13]]);

assert.ok(hardWrap('word '.repeat(30)).every((row) => row.length <= 44));
assert.equal(listWindow(10, 6, 0), 3);
console.log('ui.test: ok');
