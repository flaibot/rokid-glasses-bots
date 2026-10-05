// Tests for match.mjs: node match.test.mjs
import assert from 'node:assert/strict';
import { matchContacts, nameScore, normalize } from './match.mjs';

const now = Date.now();
const people = [
  { id: '1@s.whatsapp.net', names: ['Mom'], t: now - 86400000 },
  { id: '2@s.whatsapp.net', names: ['John Tan'], t: now - 3 * 86400000 },
  { id: '3@s.whatsapp.net', names: ['Jonathan Lee'], t: now - 200 * 86400000 },
  { id: '4@s.whatsapp.net', names: ['Sarah', 'Sarah W'], t: 0 },
  { id: '5@g.us', names: ['Family group'], t: now },
  { id: '6@s.whatsapp.net', names: ['Dr. Müller'], t: 0 },
];
const top = (q) => matchContacts(q, people)[0]?.id;

assert.equal(normalize('Dr. Müller'), 'dr muller');
assert.equal(top('mom'), '1@s.whatsapp.net');
assert.equal(top('mum'), '1@s.whatsapp.net', 'alias');
assert.equal(top('Mother'), '1@s.whatsapp.net', 'alias');
assert.equal(top('john'), '2@s.whatsapp.net');
assert.deepEqual(matchContacts('jon', people).map((m) => m.id).sort(), ['2@s.whatsapp.net', '3@s.whatsapp.net'], 'ambiguous: both offered');
assert.equal(top('jhon tan'), '2@s.whatsapp.net', 'misheard');
assert.equal(top('jonathan'), '3@s.whatsapp.net');
assert.equal(top('sara'), '4@s.whatsapp.net', 'one letter off');
assert.equal(top('family'), '5@g.us');
assert.equal(top('muller'), '6@s.whatsapp.net');
assert.equal(matchContacts('zebra', people).length, 0, 'no match');
assert.ok(nameScore('john tan', 'John Tan') === 1);
console.log('match.test: ok');
