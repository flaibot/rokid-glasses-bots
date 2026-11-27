// The MAIN page wired to /v1/runs, driven through its own code.
//
// pages/index/index.ink is loaded by test/page-harness.mjs, so these tests run
// the real page script: the real send()/cancelRequest()/flipPage()/menu/voice/
// scanner paths, the real lib/hermes-runs.js client and the real lib/status.js
// view, against a local server that speaks the wire contract. fetch and HTTP
// are real; only the host objects (wx, localStorage, recognizer, camera) are
// stubs, as they are on the glasses.
//
//   node --test test/*.test.mjs
//
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadPage,
  makePage,
  installStorage,
  readStore,
  installSpeechRecognition,
  installSpeechSynthesis,
  installScanner,
  startGateway,
  sseHeaders,
  sseFrame,
  responsesFrame,
  runEvent,
  delay,
  waitFor,
  settingsFor,
} from './page-harness.mjs';

const pageDef = await loadPage();
const KEY = 'local-test-key';

function boot(base, { history, patch } = {}) {
  const seed = { 'hermes.settings': settingsFor(base, patch) };
  if (history) seed['hermes.history'] = { conversations: history };
  const store = installStorage(seed);
  installScanner();
  const page = makePage(pageDef);
  page.onLoad({});
  return { page, store };
}

function statusPanel(page) {
  page.openMenu('more');
  const item = page.menu.items.find((entry) => entry.act === 'status');
  assert.ok(item, 'the Status entry exists once a turn has run');
  page.activate(item);
  assert.equal(page.data.state, 'status');
  return page.statusRows.join('\n');
}

const completion = (runId, seq, output, extra = {}) =>
  runEvent(runId, seq, 'run.completed', {
    output,
    usage: { input_tokens: 2410, output_tokens: 6, total_tokens: 2416, cache_read_tokens: 2000, cache_write_tokens: 0 },
    runtime: { provider: 'deepseek', model: 'deepseek-flash', route_source: 'raw_request', requested: { provider: '', model: 'glasses' } },
    completed: true,
    ...extra,
  });

// A gateway that streams one scripted run, then closes the stream.
async function runGateway(runId, script) {
  return startGateway(async (req, res, record) => {
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
        await delay(3);
      }
      res.end(': stream closed\n\n');
      return;
    }
    res.writeHead(404).end('{}');
  });
}

// ---------------------------------------------------------------- happy path

test('swiping in either direction while listening or speaking opens controls', () => {
  for (const state of ['listening', 'speaking']) {
    for (const direction of [-1, 1]) {
      const { page } = boot('http://127.0.0.1:9');
      installSpeechRecognition('');
      page.setState(state);
      page.flipPage(direction);
      assert.equal(page.data.state, 'menu', `${state} direction ${direction}`);
      assert.equal(page.menuName, 'main');
      assert.ok(page.menu.items.some(item => item.act === 'more'));
      page.openMenu('more');
      assert.ok(page.menu.items.some(item => item.act === 'settings'));
    }
  }
});

test('main page: a turn runs on /v1/runs, the bar is live, and the panel reports what was served', async (t) => {
  const runId = 'run_main_1';
  const gw = await runGateway(runId, [
    runEvent(runId, 0, 'tool.started', { tool: 'terminal' }),
    runEvent(runId, 1, 'tool.completed', { tool: 'terminal', duration: 0.42, error: false }),
    runEvent(runId, 2, 'message.delta', { delta: 'It is ' }),
    runEvent(runId, 3, 'message.delta', { delta: '07:45.' }),
    completion(runId, 4, 'It is 07:45.'),
  ]);
  t.after(() => gw.close());

  const { page, store } = boot(gw.base);
  const run = page.send('what time is it');

  // While the turn is in flight, the 14px bar is on screen.
  await waitFor(() => page.data.statusBar, { label: 'status bar' });
  assert.equal(page.data.state, 'thinking');
  assert.match(page.data.statusBar, /^glasses · r:none · /);
  assert.ok(page.data.statusBar.endsWith('›'), page.data.statusBar);

  await run;
  assert.equal(page.data.state, 'idle');
  assert.equal(page.data.answer, 'It is 07:45.');
  assert.equal(page.data.statusBar, '', 'the bar goes with the turn, not the reply');
  assert.equal(page.data.tool, '');

  // The request itself is the app's usual one, over the runs endpoint.
  assert.equal(gw.requests[0].path, '/v1/runs');
  assert.equal(gw.requests[0].body.model, 'glasses');
  assert.deepEqual(gw.requests[0].body.model_options, { reasoning_effort: 'none' });
  assert.equal(gw.requests[0].body.session_id, 'rokid-glasses-test');
  assert.equal(typeof gw.requests[0].body.instructions, 'string');
  assert.match(gw.requests[0].body.instructions, /Rokid smart glasses/);
  assert.equal(gw.requests[1].path, `/v1/runs/${runId}/events`);

  // History is written exactly as before.
  const history = readStore(store, 'hermes.history');
  assert.equal(history.conversations[0].turns.length, 1);
  assert.equal(history.conversations[0].turns[0].q, 'what time is it');
  assert.equal(history.conversations[0].turns[0].a, 'It is 07:45.');

  // The panel is opened on purpose and shows served facts only.
  const panel = statusPanel(page);
  assert.ok(panel.includes('run        completed'), panel);
  assert.ok(panel.includes('model req  glasses'), panel);
  assert.ok(panel.includes('model act  deepseek-flash'), panel);
  assert.ok(panel.includes('provider   deepseek'), panel);
  assert.ok(panel.includes('route      raw_request'), panel);
  assert.ok(panel.includes('tool       terminal 0.4s'), panel);
  assert.ok(panel.includes('tok in     2.4k'), panel);
  assert.ok(panel.includes('ctx max    unavailable'), 'no invented context window');
  assert.equal(page.status.endpoint, 'runs');

  // Tap closes the panel and brings the reply back.
  page.primaryAction();
  assert.equal(page.data.state, 'idle');
  assert.equal(page.data.answer, 'It is 07:45.');
  assert.deepEqual(page.data.statusLines, []);
});

test('main page: the bar keeps counting while a run is silent', async (t) => {
  const runId = 'run_tick_1';
  const gw = await startGateway(async (req, res, record) => {
    if (req.method === 'POST' && record.path === '/v1/runs') {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ run_id: runId, status: 'started' }));
      return;
    }
    if (req.method === 'POST' && record.path.endsWith('/stop')) {
      res.writeHead(200).end('{}');
      return;
    }
    if (req.method === 'GET' && record.path === `/v1/runs/${runId}/events`) {
      sseHeaders(res);
      res.write(': open\n\n');
      // No frames: a long tool call with nothing to report.
      const timer = setInterval(() => {
        if (!res.destroyed) res.write(': keepalive\n\n');
      }, 50);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(404).end('{}');
  });
  t.after(() => gw.close());

  const { page } = boot(gw.base);
  const run = page.send('slow question');
  const initial = page.data.statusBar;
  assert.match(initial, /0\.0s/, initial);

  await delay(1300);
  assert.notEqual(page.data.statusBar, initial, 'the elapsed clock is not frozen');
  assert.match(page.data.statusBar, /· [1-9]\d?(\.\d)?s ·/, page.data.statusBar);

  page.cancelRequest();
  await run;
});

test('main page: the Status entry is absent until a turn has run, and the bar never shows when idle', async (t) => {
  // No gateway is needed: nothing is sent in this test.
  const { page } = boot('http://127.0.0.1:9');
  installSpeechRecognition('');
  assert.equal(page.data.statusBar, '');
  page.openMenu('more');
  assert.equal(page.menu.items.some((item) => item.act === 'status'), false, 'no status before any turn');
  page.closeMenu();
  assert.equal(page.data.state, 'idle');

  // Starting a new conversation also drops the old conversation's record.
  page.status = { marker: 'old-turn' };
  page.startNewConversation();
  assert.equal(page.status, null);
  assert.equal(page.data.statusBar, '');
});

// ---------------------------------------------------------------- legacy

test('main page: a legacy conversation bridges once on /v1/responses, then resumes on /v1/runs', async (t) => {
  const legacyId = 'rokid-glasses-legacy';
  const runId = 'run_legacy_2';
  const sessionId = 'sess-legacy-9';
  const bridgeFrames = [
    responsesFrame('response.created', {
      type: 'response.created',
      response: { id: 'resp_bridge', status: 'in_progress', model: 'glasses' },
    }),
    responsesFrame('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: 'msg_bridge',
      delta: 'Bridged reply',
    }),
    responsesFrame('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: 'msg_bridge',
      text: 'Bridged reply',
    }),
    responsesFrame('response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_bridge',
        status: 'completed',
        model: 'glasses',
        usage: { input_tokens: 1200, output_tokens: 2, total_tokens: 1202 },
      },
    }),
  ];

  const gw = await startGateway(async (req, res, record) => {
    if (req.method === 'POST' && record.path === '/v1/responses') {
      sseHeaders(res, { 'x-hermes-session-id': sessionId });
      for (const frame of bridgeFrames) {
        res.write(frame);
        await delay(2);
      }
      res.end();
      return;
    }
    if (req.method === 'POST' && record.path === '/v1/runs') {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ run_id: runId, status: 'started' }));
      return;
    }
    if (req.method === 'GET' && record.path === `/v1/runs/${runId}/events`) {
      sseHeaders(res);
      res.write(sseFrame(0, runEvent(runId, 0, 'message.delta', { delta: 'Second reply.' })));
      await delay(2);
      res.write(sseFrame(1, completion(runId, 1, 'Second reply.')));
      await delay(2);
      res.end(': stream closed\n\n');
      return;
    }
    res.writeHead(404).end('{}');
  });
  t.after(() => gw.close());

  const { page, store } = boot(gw.base, {
    patch: { CONVERSATION: legacyId },
    history: [
      {
        id: legacyId,
        title: 'older conversation',
        updated: Date.now() - 60_000,
        turns: [{ q: 'earlier question', a: 'earlier answer', at: Date.now() - 60_000 }],
      },
    ],
  });

  // Turn 1: no session id known, local turns exist -> exactly one bridge turn.
  await page.send('after the upgrade');
  assert.equal(gw.requests[0].path, '/v1/responses');
  assert.equal(gw.requests[0].body.conversation, legacyId);
  assert.equal(page.data.answer, 'Bridged reply');
  const bridgePanel = statusPanel(page);
  assert.ok(bridgePanel.includes('model act  unavailable'), 'this route never reports the served model');
  assert.ok(bridgePanel.includes('run        unavailable'), 'no run record exists on this route');
  assert.ok(bridgePanel.includes('model req  glasses'), bridgePanel);
  assert.equal(page.status.endpoint, 'responses');
  page.primaryAction();

  const sessions = readStore(store, 'hermes.sessions');
  assert.equal(sessions[legacyId].id, sessionId, 'the header was learned and stored');

  // Turn 2: the stored session id keeps the same transcript, now on /v1/runs.
  await page.send('next question');
  const runsRequest = gw.requests.find((r) => r.path === '/v1/runs');
  assert.ok(runsRequest, 'the second turn moved to /v1/runs');
  assert.equal(runsRequest.body.session_id, sessionId);
  assert.equal(page.data.answer, 'Second reply.');

  const panel = statusPanel(page);
  assert.ok(panel.includes('run        completed'), panel);
  assert.ok(panel.includes('model act  deepseek-flash'), panel);
  assert.ok(panel.includes('provider   deepseek'), panel);

  const history = readStore(store, 'hermes.history');
  const turns = history.conversations.find((c) => c.id === legacyId).turns;
  assert.deepEqual(turns.map((turn) => turn.q), ['earlier question', 'after the upgrade', 'next question']);
});

// ---------------------------------------------------------------- cancel

test('main page: swiping while thinking posts /stop and the panel says Hermes accepted it', async (t) => {
  const runId = 'run_cancel_1';
  let stopAccepted = false;
  const gw = await startGateway(async (req, res, record) => {
    if (req.method === 'POST' && record.path === '/v1/runs') {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ run_id: runId, status: 'started' }));
      return;
    }
    if (req.method === 'POST' && record.path === `/v1/runs/${runId}/stop`) {
      stopAccepted = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ run_id: runId, status: 'stopping' }));
      return;
    }
    if (req.method === 'GET' && record.path === `/v1/runs/${runId}/events`) {
      sseHeaders(res);
      res.write(sseFrame(0, runEvent(runId, 0, 'message.delta', { delta: 'partial ' })));
      // Still working: hold the stream open, like a long tool call.
      const timer = setInterval(() => {
        if (!res.destroyed) res.write(': keepalive\n\n');
      }, 20);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(404).end('{}');
  });
  t.after(() => gw.close());

  const { page, store } = boot(gw.base);
  const run = page.send('do something long');
  await waitFor(() => gw.requests.some((r) => r.path === `/v1/runs/${runId}/events`), { label: 'events' });
  await waitFor(() => page.status?.answerChars > 0, { label: 'first delta' });

  // The Q1 gesture: one swipe while thinking cancels.
  page.flipPage(1);
  assert.equal(page.data.state, 'idle');
  assert.equal(page.data.answer, 'partial');
  assert.equal(page.data.hint, 'Cancelled · tap to talk');
  await run;

  await waitFor(() => stopAccepted, { label: 'POST /stop' });
  await waitFor(() => page.status.stoppedReason === 'stop sent', { label: 'stop sent' });

  assert.equal(page.status.phase, 'stopped');
  const panel = statusPanel(page);
  assert.ok(panel.includes('stopped    stop sent'), panel);
  assert.ok(!panel.includes('run        completed'), 'a cancelled turn never claims completion');
  // Nothing was added to the transcript.
  const history = readStore(store, 'hermes.history');
  assert.equal(history, null);
});

test('main page: tapping while thinking still queues the next question, and cancel drops it', async (t) => {
  const runId = 'run_queue_1';
  const gw = await startGateway(async (req, res, record) => {
    if (req.method === 'POST' && record.path === '/v1/runs') {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ run_id: runId, status: 'started' }));
      return;
    }
    if (req.method === 'POST' && record.path.endsWith('/stop')) {
      res.writeHead(200).end('{}');
      return;
    }
    if (req.method === 'GET' && record.path === `/v1/runs/${runId}/events`) {
      sseHeaders(res);
      const timer = setInterval(() => {
        if (!res.destroyed) res.write(': keepalive\n\n');
      }, 20);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(404).end('{}');
  });
  t.after(() => gw.close());

  const { page } = boot(gw.base);
  const instances = installSpeechRecognition('queued question');
  const run = page.send('first question');
  await waitFor(() => page.data.state === 'thinking', { label: 'thinking' });

  page.primaryAction(); // tap: listen for the next question while this one runs
  assert.equal(page.queueListening, true);
  assert.equal(page.data.hint, 'Listening for another… tap = send · swipe = cancel');
  await waitFor(() => (page.queue || []).length === 1, { label: 'queued question' });
  assert.equal(page.queue[0], 'queued question');
  assert.ok(instances.length >= 1);

  page.cancelRequest();
  assert.equal(page.data.state, 'idle');
  assert.deepEqual(page.queue, []);
  await run;
});

// ---------------------------------------------------------------- failure

test('main page: a failed run surfaces the error and the panel keeps it', async (t) => {
  const runId = 'run_fail_1';
  const gw = await startGateway(async (req, res, record) => {
    if (req.method === 'POST' && record.path === '/v1/runs') {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ run_id: runId, status: 'started' }));
      return;
    }
    if (req.method === 'GET' && record.path === `/v1/runs/${runId}/events`) {
      sseHeaders(res);
      res.write(sseFrame(0, runEvent(runId, 0, 'run.failed', { error: 'provider returned 529', completed: false })));
      await delay(2);
      res.end(': stream closed\n\n');
      return;
    }
    res.writeHead(404).end('{}');
  });
  t.after(() => gw.close());

  const { page } = boot(gw.base);
  await page.send('hi');
  assert.equal(page.data.state, 'error');
  assert.equal(page.data.error, 'provider returned 529');
  assert.equal(page.data.statusBar, '');

  const panel = statusPanel(page);
  assert.ok(panel.includes('run        failed'), panel);
  assert.ok(panel.includes('error      provider returned 529'), panel);
  assert.ok(!panel.includes('run        completed'), panel);
});

test('main page: a rejected key still opens the scanner, and the panel says the turn failed', async (t) => {
  const gw = await startGateway(async (req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
  });
  t.after(() => gw.close());

  const { page } = boot(gw.base);
  await page.send('hi');
  assert.equal(page.data.state, 'scan', 'the existing 401 -> QR scanner behaviour is kept');
  assert.equal(page.data.error, 'Key rejected. Scan the setup QR code again');
  assert.equal(page.status.phase, 'failed');
  assert.match(page.status.error, /^Hermes 401/);
  const panel = statusPanel(page);
  assert.ok(panel.includes('process    failed'), panel);
});

// ---------------------------------------------------------------- sessions

test('main page: two turns keep one session id and each turn gets its own status record', async (t) => {
  const scripts = {
    run_multi_1: [
      runEvent('run_multi_1', 0, 'message.delta', { delta: 'one' }),
      completion('run_multi_1', 1, 'one'),
    ],
    run_multi_2: [
      runEvent('run_multi_2', 0, 'message.delta', { delta: 'two' }),
      completion('run_multi_2', 1, 'two'),
    ],
  };
  const gw = await startGateway(async (req, res, record) => {
    if (req.method === 'POST' && record.path === '/v1/runs') {
      const runId = `run_multi_${gw.requests.filter((r) => r.path === '/v1/runs').length}`;
      record.runId = runId;
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ run_id: runId, status: 'started' }));
      return;
    }
    const match = record.path.match(/^\/v1\/runs\/([^/]+)\/events$/);
    if (req.method === 'GET' && match) {
      const script = scripts[match[1]];
      sseHeaders(res);
      for (const event of script) {
        res.write(sseFrame(event.seq, event));
        await delay(2);
      }
      res.end(': stream closed\n\n');
      return;
    }
    res.writeHead(404).end('{}');
  });
  t.after(() => gw.close());

  const { page, store } = boot(gw.base);
  await page.send('first');
  await page.send('second');

  const admissions = gw.requests.filter((r) => r.path === '/v1/runs');
  assert.equal(admissions.length, 2);
  assert.equal(admissions[0].body.session_id, 'rokid-glasses-test');
  assert.equal(admissions[1].body.session_id, 'rokid-glasses-test');
  assert.equal(page.data.answer, 'two');
  assert.equal(page.status.run.id, 'run_multi_2', 'the panel belongs to the newest turn');

  const panel = statusPanel(page);
  assert.ok(panel.includes('run        completed'), panel);
  assert.ok(!panel.includes('run_multi_1'), 'no stale run id is shown');

  const history = readStore(store, 'hermes.history');
  assert.deepEqual(history.conversations[0].turns.map((turn) => turn.a), ['one', 'two']);
  assert.equal(history.conversations[0].turns.length, 2, 'both turns kept, in order');
});

// ---------------------------------------------------------------- voice + QR

test('main page: voice input still sends a turn and the reply lands unchanged', async (t) => {
  const runId = 'run_voice_1';
  const gw = await runGateway(runId, [
    runEvent(runId, 0, 'tool.started', { tool: 'web_search' }),
    runEvent(runId, 1, 'tool.completed', { tool: 'web_search', duration: 0.2 }),
    runEvent(runId, 2, 'message.delta', { delta: 'Sunny.' }),
    completion(runId, 3, 'Sunny.'),
  ]);
  t.after(() => gw.close());

  // onLoad + onShow is what the glasses do when the app opens.
  const { page } = boot(gw.base);
  installSpeechRecognition('what is the weather');
  page.onShow();
  assert.equal(page.data.state, 'listening');

  await waitFor(() => gw.requests.some((r) => r.path === '/v1/runs'), { label: 'voice turn' });
  const admission = gw.requests.find((r) => r.path === '/v1/runs');
  assert.equal(admission.body.input, 'what is the weather');
  assert.equal(admission.body.conversation, undefined, 'runs is addressed by session id');

  await waitFor(() => page.data.state === 'idle', { label: 'idle after reply' });
  assert.equal(page.data.answer, 'Sunny.');
  assert.equal(page.data.question, 'what is the weather');
  assert.ok(page.status, 'the turn has a status record');
  const panel = statusPanel(page);
  assert.ok(panel.includes('tool       web_search 0.2s'), panel);
});

test('main page: the setup QR scanner still connects and saves the new settings', async (t) => {
  const { page, store } = boot('http://127.0.0.1:9');
  installSpeechRecognition(''); // the scanner listens afterwards; hear nothing
  installScanner({
    codes: [{ rawValue: JSON.stringify({ hermes: 'http://127.0.0.1:9', key: 'scanned-key' }) }],
  });

  page.openScanner('Scan the setup QR code to connect');
  assert.equal(page.data.state, 'scan');
  assert.ok(page.cameraCtx);

  await page.scanQr();
  await waitFor(() => page.data.state === 'idle', { label: 'idle after scan' });
  assert.equal(page.data.answer, 'Connected. Ask me anything.');
  const saved = readStore(store, 'hermes.settings');
  assert.equal(saved.HERMES_KEY, 'scanned-key');
  assert.equal(saved.HERMES_URL, 'http://127.0.0.1:9');
});

test('main page: a reply that is spoken keeps the speaking -> talk handoff', async (t) => {
  const runId = 'run_speak_1';
  const gw = await runGateway(runId, [
    runEvent(runId, 0, 'message.delta', { delta: 'Done.' }),
    completion(runId, 1, 'Done.'),
  ]);
  t.after(() => gw.close());

  const { page } = boot(gw.base, { patch: { SPEAK_REPLIES: true, KEEP_LISTENING: false } });
  installSpeechSynthesis();
  installSpeechRecognition('next question');

  await page.send('hi');
  assert.equal(page.data.state, 'speaking');
  assert.equal(typeof page.stopSpeech, 'function');

  page.primaryAction(); // tap while speaking: stop it and talk again
  assert.equal(page.data.state, 'listening');
  assert.equal(page.stopSpeech, null);
  page.stopListening(true);
});
