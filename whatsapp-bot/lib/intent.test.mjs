// Tests for intent.js: node lib/intent.test.mjs
import assert from 'node:assert/strict';
import { parseRequest } from './intent.js';

const send = (q) => parseRequest(q).options?.[0];

assert.deepEqual(parseRequest(''), { kind: 'open' });
assert.deepEqual(parseRequest('open WhatsApp Bot'), { kind: 'open' });
assert.deepEqual(parseRequest('whats app'), { kind: 'open' });

assert.deepEqual(send('send a WhatsApp to Mom saying I’m on my way'), { name: 'Mom', text: "I'm on my way" });
assert.deepEqual(send('Send a whats app message to mum saying running late'), { name: 'mum', text: 'Running late' });
assert.deepEqual(send('message John Tan that the meeting moved to 3'), { name: 'John Tan', text: 'The meeting moved to 3' });
assert.deepEqual(send('text my wife: love you'), { name: 'wife', text: 'Love you' });
assert.deepEqual(send('tell Sarah on WhatsApp that I will call later'), { name: 'Sarah', text: 'I will call later' });
assert.deepEqual(send('hey rokid please whatsapp dad saying happy birthday'), { name: 'dad', text: 'Happy birthday' });
assert.deepEqual(send('reply to the family group with see you soon'), { name: 'family group', text: 'See you soon' });
assert.deepEqual(send('message Mom'), { name: 'Mom', text: '' });
assert.deepEqual(send('send running late to Mom'), { name: 'Mom', text: 'Running late' });

// No split word: one- and two-word names are both offered.
const p = parseRequest('tell john tan I am late');
assert.equal(p.kind, 'send');
assert.deepEqual(p.options, [{ name: 'john', text: 'Tan I am late' }, { name: 'john tan', text: 'I am late' }]);

// From "New message": no verb.
assert.deepEqual(send('Mom, on my way'), { name: 'Mom', text: 'On my way' });

assert.deepEqual(parseRequest('read my WhatsApp messages'), { kind: 'read', name: '' });
assert.deepEqual(parseRequest('any new messages from Mom?'), { kind: 'read', name: 'Mom' });
assert.deepEqual(parseRequest('check whatsapp'), { kind: 'read', name: '' });
console.log('intent.test: ok');
