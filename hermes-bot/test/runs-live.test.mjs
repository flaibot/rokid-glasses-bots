// End-to-end test of the /v1/runs client over real HTTP.
//
// The client (lib/hermes-runs.js) is unmodified and uses global fetch. What it
// talks to is a local Node server that speaks the same wire contract as
// hermes-agent's api_server:
//
//   POST /v1/runs                  -> 202 {"run_id","status","replayed"}
//   GET  /v1/runs/{id}/events      -> SSE, frames as _sse_frame(payload, id=seq)
//   GET  /v1/runs/{id}             -> pollable status
//   POST /v1/runs/{id}/stop        -> {"run_id","status":"stopping"}
//
// Nothing leaves 127.0.0.1 and no credentials are involved (the test key is a
// literal in this file).
//
//   node --test test/
//
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { askHermesRuns } from '../lib/hermes-runs.js';
import { createStatus, applyStreamFrame, applyRunStart, panelLines } from '../lib/status.js';

const KEY = 'local-test-key';

// api_server._sse_frame(payload, id=seq): id line, then data, then a blank line.
function sseFrame(seq, payload) {
  return `id: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function runEvent(runId, seq, name, fields = {}) {
  return { event: name, run_id: runId, timestamp: 1764000000, seq, ...fields };
}

async function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: null };
    requests.push(record);
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (raw) {
        try {
          record.body = JSON.parse(raw);
        } catch (e) {
          record.body = raw;
        }
      }
      req.on('close', () => { record.closed = true; });
      Promise.resolve(handler(req, res, record)).catch((err) => {
        try {
          res.destroy(err);
        } catch (e) {}
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// askHermesRuns takes the session id the caller resolved (askHermesTurn does
// that from the conversation id); here it is passed explicitly.
const CONFIG = (base) => ({ HERMES_URL: base, HERMES_KEY: KEY, CONVERSATION: 'conv-e2e', SESSION_ID: 'conv-e2e', MODEL: 'glasses' });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sseHeaders(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

// ---------------------------------------------------------------- happy path

test('a real HTTP run streams tools, delegation, text and terminal facts', async (t) => {
  const runId = 'run_e2e_1';
  const script = [
    runEvent(runId, 0, 'tool.started', { tool: 'terminal', preview: 'echo ok' }),
    runEvent(runId, 1, 'tool.completed', { tool: 'terminal', duration: 0.31, error: false, preview: 'ok' }),
    runEvent(runId, 2, 'subagent.start', { preview: 'look it up', subagent_id: 'sub_a', task_index: 0, task_count: 1, depth: 1, model: 'child-model', status: 'running' }),
    runEvent(runId, 3, 'subagent.complete', { subagent_id: 'sub_a', status: 'completed', duration_seconds: 4.25, tool_count: 1, input_tokens: 800, output_tokens: 90 }),
    runEvent(runId, 4, 'message.delta', { delta: 'It moves ' }),
    runEvent(runId, 5, 'message.delta', { delta: 'to 07:45.' }),
    runEvent(runId, 6, 'run.completed', {
      output: 'It moves to 07:45.',
      usage: { input_tokens: 2410, output_tokens: 9, total_tokens: 2419, cache_read_tokens: 2000, cache_write_tokens: 0 },
      runtime: { provider: 'anthropic', model: 'claude-haiku-4-5', route_source: 'model_routes', requested: { provider: '', model: 'glasses' } },
      completed: true,
      partial: false,
      interrupted: false,
    }),
  ];

  const gw = await startServer(async (req, res, record) => {
    if (req.method === 'POST' && record.path === '/v1/runs') {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ run_id: runId, status: 'started', replayed: false }));
      return;
    }
    if (req.method === 'GET' && record.path === `/v1/runs/${runId}/events`) {
      sseHeaders(res);
      res.write(': open\n\n');
      for (const event of script) {
        res.write(sseFrame(event.seq, event));
        await delay(4);
      }
      res.end(': stream closed\n\n');
      return;
    }
    res.writeHead(404).end('{}');
  });
  t.after(() => gw.close());

  const status = createStatus({ model: 'glasses', reasoning: 'none' }, 0);
  const tools = [];
  const reply = await askHermesRuns(CONFIG(gw.base), 'when is the ferry?', {
    onRun: (run) => applyRunStart(status, run),
    onTool: (name) => tools.push(name),
    onEvent: (frame) => applyStreamFrame(status, frame, { now: 5000 }),
  });

  assert.equal(reply, 'It moves to 07:45.');
  assert.deepEqual(tools, ['terminal']);
  assert.equal(gw.requests.length, 2);
  assert.equal(gw.requests[0].path, '/v1/runs');
  assert.equal(gw.requests[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(gw.requests[0].body.session_id, 'conv-e2e');
  assert.equal(gw.requests[1].path, `/v1/runs/${runId}/events`);

  const lines = panelLines(status, { now: 5000 }).join('\n');
  assert.ok(lines.includes('run        completed'), lines);
  assert.ok(lines.includes('model act  claude-haiku-4-5'), lines);
  assert.ok(lines.includes('provider   anthropic'), lines);
  assert.ok(lines.includes('route      model_routes'), lines);
  assert.ok(lines.includes('child 1    completed 4.3s 890'), lines);
  assert.ok(lines.includes('tok in     2.4k'), lines);
  assert.ok(lines.includes('cache rd/wr 2.0k/0'), lines);
});

// ---------------------------------------------------------------- reconnect

test('a socket killed mid-run is resumed from last_seq over real HTTP', async (t) => {
  const runId = 'run_e2e_2';
  const head = [
    runEvent(runId, 0, 'message.delta', { delta: 'one ' }),
    runEvent(runId, 1, 'message.delta', { delta: 'two ' }),
  ];
  const tail = [
    runEvent(runId, 2, 'message.delta', { delta: 'three' }),
    runEvent(runId, 3, 'run.completed', { output: 'one two three', completed: true }),
  ];
  let first = true;

  const gw = await startServer(async (req, res, record) => {
    if (req.method === 'POST' && record.path === '/v1/runs') {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ run_id: runId, status: 'started' }));
      return;
    }
    if (req.method === 'GET' && record.path === `/v1/runs/${runId}/events`) {
      const from = Number(record.query.last_seq ?? -1);
      sseHeaders(res);
      if (first) {
        first = false;
        for (const event of head) res.write(sseFrame(event.seq, event));
        await delay(15);
        // The client sees a broken transport, exactly like a dead tailnet hop.
        res.destroy();
        return;
      }
      for (const event of [...head, ...tail].filter((event) => event.seq > from)) {
        res.write(sseFrame(event.seq, event));
        await delay(2);
      }
      res.end(': stream closed\n\n');
      return;
    }
    res.writeHead(404).end('{}');
  });
  t.after(() => gw.close());

  const texts = [];
  const reply = await askHermesRuns(CONFIG(gw.base), 'hi', { onText: (text) => texts.push(text) });
  assert.equal(reply, 'one two three');
  assert.deepEqual(texts, ['one ', 'one two ', 'one two three'], 'no frame is delivered twice');
  const events = gw.requests.filter((r) => r.path.endsWith('/events'));
  assert.equal(events.length, 2);
  assert.equal(events[1].query.last_seq, '1');
});

// ---------------------------------------------------------------- cancel

test('an abort over real HTTP posts /stop and reports the server accepted', async (t) => {
  const runId = 'run_e2e_3';
  let stopped = false;

  const gw = await startServer(async (req, res, record) => {
    if (req.method === 'POST' && record.path === '/v1/runs') {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ run_id: runId, status: 'started' }));
      return;
    }
    if (req.method === 'POST' && record.path === `/v1/runs/${runId}/stop`) {
      stopped = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ run_id: runId, status: 'stopping' }));
      return;
    }
    if (req.method === 'GET' && record.path === `/v1/runs/${runId}/events`) {
      sseHeaders(res);
      res.write(sseFrame(0, runEvent(runId, 0, 'message.delta', { delta: 'work' })));
      // Keep the run open until the client stops it, like a long tool call.
      const timer = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 20);
      req.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(404).end('{}');
  });
  t.after(() => gw.close());

  const controller = new AbortController();
  const stops = [];
  const run = askHermesRuns(CONFIG(gw.base), 'do something long', {
    onStop: (info) => stops.push(info),
  }, controller.signal);

  await delay(60);
  assert.equal(stopped, false);
  controller.abort();
  await assert.rejects(() => run, /Cancelled/);
  assert.equal(stopped, true, 'the run was actually asked to stop');
  assert.deepEqual(stops, [{ mode: 'server', reason: 'aborted' }]);

  const stopRequest = gw.requests.find((r) => r.path.endsWith('/stop'));
  assert.equal(stopRequest.headers.authorization, `Bearer ${KEY}`);
});

test('closing the event stream alone does not stop a run — only /stop does', async (t) => {
  const runId = 'run_e2e_4';
  let stopPosts = 0;
  const gw = await startServer(async (req, res, record) => {
    if (req.method === 'POST' && record.path === '/v1/runs') {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ run_id: runId, status: 'started' }));
      return;
    }
    if (req.method === 'POST' && record.path.endsWith('/stop')) {
      stopPosts += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ run_id: runId, status: 'stopping' }));
      return;
    }
    if (req.method === 'GET' && record.path.endsWith('/events')) {
      sseHeaders(res);
      // Ends immediately with no terminal event: the run is still going.
      res.end(': stream closed\n\n');
      return;
    }
    if (req.method === 'GET' && record.path === `/v1/runs/${runId}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'hermes.run', run_id: runId, status: 'running' }));
      return;
    }
    res.writeHead(404).end('{}');
  });
  t.after(() => gw.close());

  await assert.rejects(
    () => askHermesRuns(CONFIG(gw.base), 'hi'),
    /outcome unknown/,
  );
  // Initial stream + one reconnect, then the status poll decides the outcome.
  const polls = gw.requests.filter((r) => r.path === `/v1/runs/${runId}`);
  assert.equal(polls.length, 1, 'the status endpoint is consulted');
  assert.equal(stopPosts, 0, 'a dropped stream never posts a stop');
});

// ---------------------------------------------------------------- errors

test('HTTP failures surface as errors with the status code', async (t) => {
  const gw = await startServer(async (req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
  });
  t.after(() => gw.close());
  await assert.rejects(() => askHermesRuns(CONFIG(gw.base), 'hi'), /Hermes 401/);
});

test('a failed run over real HTTP keeps the terminal frame and the error', async (t) => {
  const runId = 'run_e2e_5';
  const gw = await startServer(async (req, res, record) => {
    if (req.method === 'POST' && record.path === '/v1/runs') {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ run_id: runId, status: 'started' }));
      return;
    }
    if (req.method === 'GET' && record.path.endsWith('/events')) {
      sseHeaders(res);
      res.write(sseFrame(0, runEvent(runId, 0, 'run.failed', {
        error: 'provider returned 529',
        usage: { input_tokens: 40, output_tokens: 0, total_tokens: 40 },
        completed: false,
      })));
      await delay(2);
      res.end(': stream closed\n\n');
      return;
    }
    res.writeHead(404).end('{}');
  });
  t.after(() => gw.close());

  const status = createStatus({ model: 'glasses' }, 0);
  await assert.rejects(
    () => askHermesRuns(CONFIG(gw.base), 'hi', { onEvent: (frame) => applyStreamFrame(status, frame, { now: 1000 }) }),
    /provider returned 529/,
  );
  const lines = panelLines(status, { now: 1000 }).join('\n');
  assert.ok(lines.includes('error      provider returned 529'), lines);
  assert.ok(lines.includes('tok in     40'), lines);
});
