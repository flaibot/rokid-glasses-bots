// Integration tests for the /v1/runs client (lib/hermes-runs.js).
//
// The REAL client runs; only globalThis.fetch is replaced, so the request
// bodies, the SSE parsing, the reconnect and the stop-on-abort path are the
// ones the glasses will use. Wire shapes are copied from hermes-agent
// (gateway/platforms/api_server_runs.py + api_server._sse_frame):
//
//   id: <seq>\n data: {"event": "...", "run_id": ..., "seq": ...}\n\n
//
//   node --test test/
//
import test from 'node:test';
import assert from 'node:assert/strict';

import { askHermesRuns, askHermesTurn, runStatus, startRun, stopRun } from '../lib/hermes-runs.js';
import { sessionIdFor, rememberSessionId, forgetSessionId, derivedSessionId } from '../lib/session.js';
import { createStatus, applyStreamFrame, applyRunStart, panelLines } from '../lib/status.js';

// ---------------------------------------------------------------- harness

// localStorage shim: session.js and history.js use it, the glasses provide it.
const store = new Map();
if (!globalThis.localStorage) {
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}
function resetStorage() {
  store.clear();
}

const encoder = new TextEncoder();

function bodyStream(text, { chunk = 37, hang = false } = {}) {
  const bytes = encoder.encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk));
      if (!hang) controller.close();
    },
  });
}

function response(body, { ok = true, status = 200, headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok,
    status,
    headers: {
      get: (name) => lower[String(name).toLowerCase()] ?? null,
    },
    body: body instanceof ReadableStream ? body : bodyStream(String(body ?? '')),
    text: async () => String(body ?? ''),
    json: async () => JSON.parse(String(body ?? 'null')),
  };
}

// Persistent SSE streams keyed by url, so a reconnect can return the next one.
function sseResponse(frames, options = {}) {
  const text = frames
    .map(({ seq, data }) => `id: ${seq}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
  return response(bodyStream(text, options), { headers: { 'content-type': 'text/event-stream' } });
}

// A route table: each entry answers one request and records it.
function mockFetch(routes) {
  const calls = [];
  const queue = routes.slice();
  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method || 'GET',
      headers: options.headers || {},
      body: typeof options.body === 'string' ? JSON.parse(options.body) : null,
    });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch: ${options.method || 'GET'} ${url}`);
    return next(String(url), options, calls);
  };
  return { fetchImpl, calls };
}

let seq = 0;
// Mirrors the real payload: the server stamps `seq` into the JSON body too
// (api_server_runs._write_event), and the client resumes from it.
const runFrame = (name, payload = {}) => {
  const n = seq++;
  return { seq: n, data: { event: name, run_id: 'run_test', timestamp: 1764000000, seq: n, ...payload } };
};

const CONFIG = { HERMES_URL: 'http://127.0.0.1:8642', HERMES_KEY: 'test-key', CONVERSATION: 'conv-runs', MODEL: 'glasses' };

function admission(runId = 'run_test') {
  return response(JSON.stringify({ run_id: runId, status: 'started', replayed: false }), { status: 202 });
}

// ---------------------------------------------------------------- admission

test('startRun posts the documented body and returns the run_id', async (t) => {
  resetStorage();
  const { fetchImpl, calls } = mockFetch([() => admission('run_abc')]);
  t.mock.method(globalThis, 'fetch', fetchImpl);

  const ack = await startRun(CONFIG, 'hello', 'conv-runs', undefined);
  assert.equal(ack.run_id, 'run_abc');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8642/v1/runs');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].headers.Authorization, /^Bearer test-key$/);
  assert.equal(calls[0].body.input, 'hello');
  assert.equal(calls[0].body.session_id, 'conv-runs');
  assert.equal(calls[0].body.model, 'glasses');
  assert.deepEqual(calls[0].body.model_options, { reasoning_effort: 'none' });
  assert.ok(calls[0].body.instructions.includes('Rokid'), 'the glasses system prompt still rides along');
});

test('smart mode sends glasses-smart and no reasoning override', async (t) => {
  const { fetchImpl, calls } = mockFetch([() => admission()]);
  t.mock.method(globalThis, 'fetch', fetchImpl);
  await startRun({ ...CONFIG, SMART: true }, 'hello', undefined, undefined);
  assert.equal(calls[0].body.model, 'glasses-smart');
  assert.equal(calls[0].body.model_options, undefined);
  assert.equal(calls[0].body.session_id, undefined, 'no session id is invented');
});

test('an admission error keeps the status and body, like askHermes', async (t) => {
  const { fetchImpl } = mockFetch([() => response('bad key', { ok: false, status: 401 })]);
  t.mock.method(globalThis, 'fetch', fetchImpl);
  await assert.rejects(() => startRun(CONFIG, 'hi', undefined), /Hermes 401: bad key/);
});

test('an admission without run_id is an error, not a guess', async (t) => {
  const { fetchImpl } = mockFetch([() => response(JSON.stringify({ status: 'started' }), { status: 202 })]);
  t.mock.method(globalThis, 'fetch', fetchImpl);
  await assert.rejects(() => startRun(CONFIG, 'hi', undefined), /no run_id/);
});

// ---------------------------------------------------------------- happy path

test('a full run streams text, tools, delegation and the terminal facts', async (t) => {
  resetStorage();
  const frames = [
    runFrame('tool.started', { tool: 'terminal', preview: 'echo ok' }),
    runFrame('tool.completed', { tool: 'terminal', duration: 0.24, error: false }),
    runFrame('subagent.start', { preview: 'look it up', subagent_id: 'sub_1', task_count: 1, task_index: 0, depth: 1, model: 'm1', status: 'running' }),
    runFrame('subagent.complete', { subagent_id: 'sub_1', status: 'completed', duration_seconds: 12.5, tool_count: 2, input_tokens: 900, output_tokens: 100 }),
    runFrame('message.delta', { delta: 'The ferry ' }),
    runFrame('message.delta', { delta: 'moves to 07:45.' }),
    runFrame('run.completed', {
      output: 'The ferry moves to 07:45.',
      usage: { input_tokens: 2400, output_tokens: 12, total_tokens: 2412, cache_read_tokens: 2000, cache_write_tokens: 0 },
      runtime: { provider: 'anthropic', model: 'claude-haiku-4-5', route_source: 'model_routes', requested: { provider: '', model: 'glasses' } },
      completed: true,
      partial: false,
      interrupted: false,
    }),
  ];
  const { fetchImpl, calls } = mockFetch([
    () => admission(),
    () => sseResponse(frames),
  ]);
  t.mock.method(globalThis, 'fetch', fetchImpl);

  const texts = [];
  const tools = [];
  const events = [];
  let started = null;
  const reply = await askHermesRuns(CONFIG, 'when is the ferry?', {
    onText: (text) => texts.push(text),
    onTool: (name) => tools.push(name),
    onEvent: (frame) => events.push(frame.event),
    onRun: (run) => { started = run; },
  });

  assert.equal(reply, 'The ferry moves to 07:45.');
  assert.deepEqual(tools, ['terminal']);
  assert.equal(started.runId, 'run_test');
  assert.deepEqual(texts, ['The ferry ', 'The ferry moves to 07:45.']);
  assert.deepEqual(events, [
    'tool.started',
    'tool.completed',
    'subagent.start',
    'subagent.complete',
    'message.delta',
    'message.delta',
    'run.completed',
  ]);
  // The event stream request follows the run that was admitted.
  assert.equal(calls[1].url, 'http://127.0.0.1:8642/v1/runs/run_test/events');
  assert.equal(calls[1].method, 'GET');
  assert.match(calls[1].headers.Authorization, /^Bearer test-key$/);
});

test('the same run drives the status panel end to end', async (t) => {
  const frames = [
    runFrame('tool.started', { tool: 'terminal' }),
    runFrame('tool.completed', { tool: 'terminal', duration: 0.82, error: false }),
    runFrame('message.delta', { delta: 'ok.' }),
    runFrame('run.completed', {
      output: 'ok.',
      usage: { input_tokens: 2480, output_tokens: 12, total_tokens: 2492 },
      runtime: { provider: 'anthropic', model: 'claude-haiku-4-5', route_source: 'model_routes' },
    }),
  ];
  const { fetchImpl } = mockFetch([() => admission(), () => sseResponse(frames)]);
  t.mock.method(globalThis, 'fetch', fetchImpl);

  const status = createStatus({ model: 'glasses', reasoning: 'none' }, 0);
  await askHermesRuns(CONFIG, 'run echo ok', {
    onRun: (run) => applyRunStart(status, run),
    onEvent: (frame) => applyStreamFrame(status, frame, { now: 4000 }),
  });
  const lines = panelLines(status, { now: 4000 }).join('\n');
  assert.ok(lines.includes('run        completed'), lines);
  assert.ok(lines.includes('model act  claude-haiku-4-5'), lines);
  assert.ok(lines.includes('provider   anthropic'), lines);
  assert.ok(lines.includes('route      model_routes'), lines);
  assert.ok(lines.includes('tools      1 done'), lines);
  assert.ok(lines.includes('tool       terminal 0.8s'), lines);
  assert.ok(lines.includes('tok in     2.5k'), lines);
});

test('a streamed answer still wins when the terminal output is empty', async (t) => {
  const frames = [
    runFrame('message.delta', { delta: 'partial ' }),
    runFrame('message.delta', { delta: 'answer' }),
    runFrame('run.completed', { output: '', completed: true }),
  ];
  const { fetchImpl } = mockFetch([() => admission(), () => sseResponse(frames)]);
  t.mock.method(globalThis, 'fetch', fetchImpl);
  assert.equal(await askHermesRuns(CONFIG, 'hi'), 'partial answer');
});

// ---------------------------------------------------------------- failures

test('run.failed throws the server error after the frame is delivered', async (t) => {
  const events = [];
  const frames = [runFrame('run.failed', { error: 'provider returned 502', completed: false })];
  const { fetchImpl } = mockFetch([() => admission(), () => sseResponse(frames)]);
  t.mock.method(globalThis, 'fetch', fetchImpl);
  await assert.rejects(
    () => askHermesRuns(CONFIG, 'hi', { onEvent: (frame) => events.push(frame.event) }),
    /provider returned 502/,
  );
  assert.deepEqual(events, ['run.failed']);
});

test('run.cancelled by someone else resolves without claiming an answer', async (t) => {
  const frames = [runFrame('run.cancelled', { completed: false, interrupted: true })];
  const { fetchImpl } = mockFetch([() => admission(), () => sseResponse(frames)]);
  t.mock.method(globalThis, 'fetch', fetchImpl);
  assert.equal(await askHermesRuns(CONFIG, 'hi'), '');
});

// ---------------------------------------------------------------- reconnect

test('a dropped event stream reconnects from last_seq without duplicating text', async (t) => {
  const first = [
    runFrame('message.delta', { delta: 'one ' }),
    runFrame('message.delta', { delta: 'two ' }),
  ];
  const rest = [
    runFrame('message.delta', { delta: 'three' }),
    runFrame('run.completed', { output: 'one two three', completed: true }),
  ];
  // The server's seq counter is per run and continues across the reconnect.
  const lastSeq = rest[0].seq - 1;
  const { fetchImpl, calls } = mockFetch([
    () => admission(),
    () => sseResponse(first),
    () => sseResponse(rest),
  ]);
  t.mock.method(globalThis, 'fetch', fetchImpl);

  const reply = await askHermesRuns(CONFIG, 'hi');
  assert.equal(reply, 'one two three');
  assert.equal(calls[2].url, `http://127.0.0.1:8642/v1/runs/run_test/events?last_seq=${lastSeq}`);
});

test('when the stream dies and the status says completed, the run still settles', async (t) => {
  const frames = [runFrame('message.delta', { delta: 'hello' })];
  const { fetchImpl, calls } = mockFetch([
    () => admission(),
    () => sseResponse(frames),
    () => sseResponse([]), // reconnect: nothing more on the stream
    () =>
      response(
        JSON.stringify({
          object: 'hermes.run',
          run_id: 'run_test',
          status: 'completed',
          output: 'hello',
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
          runtime: { provider: 'p', model: 'm', route_source: 'global' },
        }),
      ),
  ]);
  t.mock.method(globalThis, 'fetch', fetchImpl);
  assert.equal(await askHermesRuns(CONFIG, 'hi'), 'hello');
  assert.equal(calls[3].method, 'GET');
  assert.equal(calls[3].url, 'http://127.0.0.1:8642/v1/runs/run_test');
});

test('an unknown outcome is reported, never invented', async (t) => {
  let incomplete = null;
  const frames = [runFrame('message.delta', { delta: 'half' })];
  const { fetchImpl } = mockFetch([
    () => admission(),
    () => sseResponse(frames),
    () => sseResponse([]),
    () => response(JSON.stringify({ run_id: 'run_test', status: 'running' })),
  ]);
  t.mock.method(globalThis, 'fetch', fetchImpl);
  // Text that really arrived is returned; the caller is told the run did not
  // settle, so it can say so instead of showing a clean "done".
  const reply = await askHermesRuns(CONFIG, 'hi', { onIncomplete: (info) => { incomplete = info; } });
  assert.equal(reply, 'half');
  assert.equal(incomplete.status.status, 'running');
});

test('no text and no terminal event is an error, not an empty reply', async (t) => {
  const { fetchImpl } = mockFetch([
    () => admission(),
    () => sseResponse([]),
    () => sseResponse([]),
    () => response(JSON.stringify({ run_id: 'run_test', status: 'running' })),
  ]);
  t.mock.method(globalThis, 'fetch', fetchImpl);
  await assert.rejects(() => askHermesRuns(CONFIG, 'hi'), /outcome unknown/);
});

// ---------------------------------------------------------------- cancel

test('aborting asks Hermes to stop the run and reports that it accepted', async (t) => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`id: 0\ndata: ${JSON.stringify(runFrame('message.delta', { delta: 'wo' }).data)}\n\n`));
      // stays open: the real stream would keep running
    },
  });
  const { fetchImpl, calls } = mockFetch([
    () => admission(),
    () => response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    () => response(JSON.stringify({ run_id: 'run_test', status: 'stopping' })),
  ]);
  t.mock.method(globalThis, 'fetch', fetchImpl);

  const controller = new AbortController();
  const stops = [];
  const run = askHermesRuns(CONFIG, 'hi', { onStop: (info) => stops.push(info) }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(() => run, /Cancelled/);

  assert.equal(calls[2].url, 'http://127.0.0.1:8642/v1/runs/run_test/stop');
  assert.equal(calls[2].method, 'POST');
  assert.deepEqual(stops, [{ mode: 'server', reason: 'aborted' }]);
});

test('a refused stop is reported as local, not as cancelled', async (t) => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`id: 0\ndata: ${JSON.stringify(runFrame('message.delta', { delta: 'wo' }).data)}\n\n`));
    },
  });
  const { fetchImpl } = mockFetch([
    () => admission(),
    () => response(stream),
    () => response('not active', { ok: false, status: 409 }),
  ]);
  t.mock.method(globalThis, 'fetch', fetchImpl);

  const controller = new AbortController();
  const stops = [];
  const run = askHermesRuns(CONFIG, 'hi', { onStop: (info) => stops.push(info) }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(() => run, /Cancelled/);
  assert.deepEqual(stops, [{ mode: 'local', reason: 'aborted' }]);
});

test('a signal already aborted before the stream starts still requests a stop', async (t) => {
  const { fetchImpl, calls } = mockFetch([
    () => admission(),
    () => response(JSON.stringify({ run_id: 'run_test', status: 'stopping' })),
  ]);
  t.mock.method(globalThis, 'fetch', fetchImpl);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => askHermesRuns(CONFIG, 'hi', {}, controller.signal), /Cancelled/);
  assert.equal(calls[1].url, 'http://127.0.0.1:8642/v1/runs/run_test/stop');
});

// ---------------------------------------------------------------- helpers

test('runStatus and stopRun speak the documented endpoints', async (t) => {
  const { fetchImpl, calls } = mockFetch([
    () => response(JSON.stringify({ object: 'hermes.run', run_id: 'r1', status: 'running' })),
    () => response(JSON.stringify({ run_id: 'r1', status: 'stopping' })),
  ]);
  t.mock.method(globalThis, 'fetch', fetchImpl);
  const status = await runStatus(CONFIG, 'r1');
  assert.equal(status.status, 'running');
  assert.equal(calls[0].url, 'http://127.0.0.1:8642/v1/runs/r1');
  assert.equal(await stopRun(CONFIG, 'r1'), 'server');
  assert.equal(calls[1].url, 'http://127.0.0.1:8642/v1/runs/r1/stop');
});

// ---------------------------------------------------------------- paths

test('session ids map to conversations and are never invented from thin air', () => {
  resetStorage();
  assert.equal(sessionIdFor('conv-a'), null);
  assert.equal(rememberSessionId('conv-a', 'sess-1'), 'sess-1');
  assert.equal(sessionIdFor('conv-a'), 'sess-1');
  forgetSessionId('conv-a');
  assert.equal(sessionIdFor('conv-a'), null);
  assert.equal(derivedSessionId('rokid-glasses-1758'), 'rokid-glasses-1758');
  assert.equal(derivedSessionId(''), null);
  assert.equal(derivedSessionId('a b/c?'), 'rokid-a-b-c');
});

test('a new conversation goes straight to /v1/runs under its own session id', async (t) => {
  resetStorage();
  const { fetchImpl, calls } = mockFetch([
    () => admission(),
    () => sseResponse([runFrame('run.completed', { output: 'hi', completed: true })]),
  ]);
  t.mock.method(globalThis, 'fetch', fetchImpl);

  const paths = [];
  await askHermesTurn({ ...CONFIG, CONVERSATION: 'rokid-glasses-new' }, 'hello', { onPath: (p) => paths.push(p) });
  assert.deepEqual(paths, ['runs']);
  assert.equal(calls[0].url, 'http://127.0.0.1:8642/v1/runs');
  assert.equal(calls[0].body.session_id, 'rokid-glasses-new');
  assert.equal(sessionIdFor('rokid-glasses-new'), 'rokid-glasses-new');
});

test('a legacy conversation bridges once, learns its session id, then uses /v1/runs', async (t) => {
  resetStorage();
  // A conversation that already has local turns but no session id: this is
  // what an install that predates this client looks like.
  globalThis.localStorage.setItem(
    'hermes.history',
    JSON.stringify({ conversations: [{ id: 'rokid-glasses-old', title: 'q', updated: 1, turns: [{ q: 'q', a: 'a', at: 1 }] }] }),
  );

  const responsesFrames = [
    { event: 'response.created', data: JSON.stringify({ type: 'response.created', response: { id: 'resp_1', model: 'glasses', status: 'in_progress', output: [] } }) },
    { event: 'response.output_text.delta', data: JSON.stringify({ type: 'response.output_text.delta', item_id: 'm1', delta: 'hello' }) },
    { event: 'response.completed', data: JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', model: 'glasses', output: [], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } }) },
  ];
  const sseText = responsesFrames.map((f) => `event: ${f.event}\ndata: ${f.data}\n\n`).join('');

  const { fetchImpl, calls } = mockFetch([
    // 1. bridge turn on the old endpoint, carrying the session id header
    () => response(sseText, { headers: { 'X-Hermes-Session-Id': 'sess-legacy-1' } }),
    // 2. the next turn on /v1/runs
    () => admission(),
    () => sseResponse([runFrame('run.completed', { output: 'second', completed: true })]),
  ]);
  t.mock.method(globalThis, 'fetch', fetchImpl);

  const paths = [];
  const first = await askHermesTurn({ ...CONFIG, CONVERSATION: 'rokid-glasses-old' }, 'one', { onPath: (p) => paths.push(p) });
  assert.equal(first, 'hello');
  assert.equal(calls[0].url, 'http://127.0.0.1:8642/v1/responses');
  assert.equal(calls[0].body.conversation, 'rokid-glasses-old', 'the legacy conversation name is still used');
  assert.equal(sessionIdFor('rokid-glasses-old'), 'sess-legacy-1');

  const second = await askHermesTurn({ ...CONFIG, CONVERSATION: 'rokid-glasses-old' }, 'two', { onPath: (p) => paths.push(p) });
  assert.equal(second, 'second');
  assert.deepEqual(paths, ['bridge', 'runs']);
  assert.equal(calls[1].url, 'http://127.0.0.1:8642/v1/runs');
  assert.equal(calls[1].body.session_id, 'sess-legacy-1', 'the transcript the glasses could not name is now addressed directly');
});

test('without the session header the bridge stays on the old endpoint', async (t) => {
  resetStorage();
  globalThis.localStorage.setItem(
    'hermes.history',
    JSON.stringify({ conversations: [{ id: 'legacy-2', title: 'q', updated: 1, turns: [{ q: 'q', a: 'a', at: 1 }] }] }),
  );
  const sseText = `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`;
  const { fetchImpl, calls } = mockFetch([() => response(sseText), () => response(sseText)]);
  t.mock.method(globalThis, 'fetch', fetchImpl);

  await askHermesTurn({ ...CONFIG, CONVERSATION: 'legacy-2' }, 'one');
  assert.equal(sessionIdFor('legacy-2'), null);
  await askHermesTurn({ ...CONFIG, CONVERSATION: 'legacy-2' }, 'two');
  assert.equal(calls[1].url, 'http://127.0.0.1:8642/v1/responses', 'never silently resets the transcript');
});
