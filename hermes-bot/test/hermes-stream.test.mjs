// Integration tests for the SSE reader + the optional onEvent hook it feeds.
//
// These exercise the REAL lib/hermes.js, with only global fetch replaced, so
// they also prove the status hook did not change what the app already does:
// the same deltas, the same tool callbacks, the same final text.
//
//   node --test test/
//
import test from 'node:test';
import assert from 'node:assert/strict';

import { askHermes, plainText } from '../lib/hermes.js';
import { createStatus, applyStreamFrame, panelLines, barLine } from '../lib/status.js';

const encoder = new TextEncoder();

function sseBody(frames) {
  return frames.map(({ event, data }) => `event: ${event}\ndata: ${data}\n\n`).join('');
}

// A Response-alike whose body arrives in awkward chunks, to exercise the
// parser's frame splitting as much as the events themselves.
function fakeResponse(body, { ok = true, status = 200 } = {}) {
  const bytes = encoder.encode(body);
  const stream = new ReadableStream({
    start(controller) {
      const step = 41;
      for (let i = 0; i < bytes.length; i += step) controller.enqueue(bytes.slice(i, i + step));
      controller.close();
    },
  });
  return {
    ok,
    status,
    body: stream,
    text: async () => body,
  };
}

const CONFIG = { HERMES_URL: 'http://127.0.0.1:8642', HERMES_KEY: 'test-key', CONVERSATION: 'conv-test' };

const frame = (event, payload) => ({ event, data: JSON.stringify(payload) });

function streamFixture() {
  return [
    frame('response.created', {
      type: 'response.created',
      response: {
        id: 'resp_it1',
        object: 'response',
        status: 'in_progress',
        created_at: 1764000000,
        model: 'glasses',
        output: [],
      },
      sequence_number: 0,
    }),
    frame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'rs_it1', type: 'reasoning', status: 'in_progress', summary: [] },
      sequence_number: 1,
    }),
    frame('response.reasoning_summary_text.delta', {
      type: 'response.reasoning_summary_text.delta',
      item_id: 'rs_it1',
      output_index: 0,
      summary_index: 0,
      delta: 'thinking quietly',
      sequence_number: 2,
    }),
    { event: 'hermes.status', data: JSON.stringify({ kind: 'lifecycle', text: 'Waiting for provider...' }) },
    frame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 1,
      item: { id: 'fc_it1', type: 'function_call', status: 'in_progress', name: 'web_search', call_id: 'call_it1', arguments: '{}' },
      sequence_number: 3,
    }),
    frame('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 1,
      item: { id: 'fc_it1', type: 'function_call', status: 'completed', name: 'web_search', call_id: 'call_it1', arguments: '{}' },
      sequence_number: 4,
    }),
    frame('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: 'msg_it1',
      output_index: 2,
      content_index: 0,
      delta: 'Hello',
      logprobs: [],
      sequence_number: 5,
    }),
    frame('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: 'msg_it1',
      output_index: 2,
      content_index: 0,
      delta: ' there',
      logprobs: [],
      sequence_number: 6,
    }),
    frame('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: 'msg_it1',
      output_index: 2,
      content_index: 0,
      text: 'Hello there',
      logprobs: [],
      sequence_number: 7,
    }),
    frame('response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_it1',
        object: 'response',
        status: 'completed',
        created_at: 1764000000,
        model: 'glasses',
        output: [],
        usage: { input_tokens: 1200, output_tokens: 3, total_tokens: 1203 },
      },
      sequence_number: 8,
    }),
  ];
}

test('askHermes behaviour is unchanged: same text stream, tools and final reply', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse(sseBody(streamFixture())));
  const seen = [];
  const tools = [];
  const reply = await askHermes(CONFIG, 'hello', {
    onText: (text) => seen.push(text),
    onTool: (name) => tools.push(name),
  });
  assert.equal(reply, 'Hello there');
  assert.deepEqual(seen, ['Hello', 'Hello there']);
  assert.deepEqual(tools, ['web_search']);
  assert.equal(plainText(reply), 'Hello there');
});

test('the onEvent hook receives every frame, names and raw data intact', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse(sseBody(streamFixture())));
  const frames = [];
  await askHermes(CONFIG, 'hello', { onEvent: (f) => frames.push(f) });
  assert.equal(frames.length, 10);
  assert.equal(frames[0].event, 'response.created');
  assert.equal(typeof frames[0].data, 'string');
  assert.equal(frames[3].event, 'hermes.status', 'custom event names survive the parser');
  assert.equal(frames[9].event, 'response.completed');
  // Every frame is valid JSON for the status engine to parse.
  for (const f of frames) assert.doesNotThrow(() => JSON.parse(f.data));
});

test('a throwing observer cannot break the reply', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse(sseBody(streamFixture())));
  const reply = await askHermes(CONFIG, 'hello', {
    onEvent: () => {
      throw new Error('observer bug');
    },
  });
  assert.equal(reply, 'Hello there');
});

test('a status view built from the real stream reports only emitted facts', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse(sseBody(streamFixture())));
  const status = createStatus({ model: 'glasses', reasoning: 'none' }, 0);
  const reply = await askHermes(CONFIG, 'hello', {
    onEvent: (f) => applyStreamFrame(status, f, { now: 4000 }),
  });

  assert.equal(reply, 'Hello there');
  assert.equal(status.phase, 'done');
  assert.equal(status.stream.id, 'resp_it1');
  assert.equal(status.reasoning.seen, true);
  assert.equal(status.reasoning.chars, 'thinking quietly'.length);
  assert.equal(status.tools.last, 'web_search');
  assert.deepEqual(status.usage, { input_tokens: 1200, output_tokens: 3, total_tokens: 1203 });
  assert.deepEqual(status.notice, { kind: 'lifecycle', text: 'Waiting for provider...' });

  const lines = panelLines(status, { now: 4000 }).join('\n');
  assert.ok(lines.includes('model req  glasses'));
  assert.ok(lines.includes('model act  unavailable'));
  assert.ok(lines.includes('ctx max    unavailable'));
  assert.ok(lines.includes('reason saw 16 ch'));
  assert.ok(lines.includes('delegate   unavailable'));
  assert.ok(lines.includes('notice     lifecycle: Waiting for provider...'));
  assert.ok(lines.includes('tok in     1.2k'));
  assert.ok(!lines.includes('thinking quietly'), 'reasoning text never surfaces');
  assert.ok(!lines.includes('Hello there'), 'the answer is not a status field');

  const bar = barLine(status, { now: 4000 });
  assert.ok(bar.startsWith('glasses'), `unexpected bar: ${bar}`);
});

test('a non-2xx response still throws the same error and emits no frames', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse('nope', { ok: false, status: 401 }));
  const frames = [];
  await assert.rejects(
    () => askHermes(CONFIG, 'hello', { onEvent: (f) => frames.push(f) }),
    /Hermes 401: nope/,
  );
  assert.equal(frames.length, 0);
});
