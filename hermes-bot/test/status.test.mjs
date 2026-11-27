// Unit tests for the status engine. Pure ESM, no runtime, no network.
//
// Two frame vocabularies are covered: /v1/responses (response.*) and
// /v1/runs (event names inside the payload: tool.started, subagent.start,
// run.completed, ...). The honesty rules are asserted for both.
//
//   node --test test/
//
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UNAVAILABLE,
  BAR_UNITS,
  PANEL_UNITS,
  ANSWER_UNITS,
  applyRunStart,
  applyRunStatus,
  applyStreamFrame,
  barLine,
  charWidth,
  childLines,
  createStatus,
  delegationLabel,
  elapsedMs,
  fit,
  formatCount,
  formatDuration,
  markFailed,
  markStopped,
  panelLines,
  providerLabel,
  requestedFromSettings,
  routeLabel,
  servedModelLabel,
  statusView,
  textWidth,
} from '../lib/status.js';

const frame = (event, payload) => ({ event, data: JSON.stringify(payload) });

test('turn token rate is an end-to-end average only after usage arrives', () => {
  const s = createStatus({model:'glasses', reasoning:'none'}, 1000);
  assert.ok(panelLines(s, {now: 2000}).join('\n').includes('turn tok/s unavailable'));
  applyStreamFrame(s, {event:'', data:JSON.stringify({event:'run.completed', usage:{output_tokens: 100}})}, {now: 5000});
  assert.ok(panelLines(s).join('\n').includes('turn tok/s 25.0'));
});

// A /v1/runs frame: no SSE event name, the name rides inside the payload and
// every payload carries run_id/timestamp/seq (api_server_runs._write_event).
const runFrame = (name, payload = {}) =>
  frame('', { event: name, run_id: 'run_t1', timestamp: 1764000000, seq: 1, ...payload });

const created = (model = 'glasses') =>
  frame('response.created', {
    type: 'response.created',
    response: {
      id: 'resp_t1',
      object: 'response',
      status: 'in_progress',
      created_at: 1764000000,
      model,
      output: [],
    },
    sequence_number: 0,
  });

const completed = (usage = { input_tokens: 900, output_tokens: 40, total_tokens: 940 }) =>
  frame('response.completed', {
    type: 'response.completed',
    response: {
      id: 'resp_t1',
      object: 'response',
      status: 'completed',
      created_at: 1764000000,
      model: 'glasses',
      output: [],
      usage,
    },
    sequence_number: 9,
  });

const RUNTIME = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  route_source: 'model_routes',
  requested: { provider: '', model: 'glasses' },
};

// ---------------------------------------------------------------- width

test('charWidth counts ASCII at 0.55 units and CJK at 1, like the reply page', () => {
  assert.equal(charWidth('a'), 0.55);
  assert.equal(charWidth('中'), 1);
  assert.equal(textWidth('abcd'), 2.2);
  assert.ok(Math.abs(textWidth('每日天气') - 4) < 1e-9);
});

test('fit truncates to the width budget with an ellipsis and never exceeds it', () => {
  const long = 'this line is far too long for twenty one units';
  const out = fit(long, ANSWER_UNITS);
  assert.ok(textWidth(out) <= ANSWER_UNITS, `${out} is too wide`);
  assert.ok(out.endsWith('…'));

  const cjk = fit('每日天气报告每日天气报告每日天气报告', 6);
  assert.ok(textWidth(cjk) <= 6);
  assert.ok(cjk.endsWith('…'));

  assert.equal(fit('short', 30), 'short');
});

test('formatDuration and formatCount stay short and honest', () => {
  assert.equal(formatDuration(4200), '4.2s');
  assert.equal(formatDuration(12000), '12s');
  assert.equal(formatDuration(64000), '1m04');
  assert.equal(formatCount(512), '512');
  assert.equal(formatCount(1234), '1.2k');
  assert.equal(formatCount(62000), '62k');
  assert.equal(formatCount(undefined), UNAVAILABLE);
  assert.equal(formatCount(NaN), UNAVAILABLE);
});

// ---------------------------------------------------------------- state

test('a new status claims nothing it has not seen', () => {
  const status = createStatus({}, 1000);
  assert.equal(status.phase, 'sending');
  const bar = barLine(status, { now: 1000 });
  assert.ok(!bar.includes(UNAVAILABLE), 'bar is too narrow for the word; it uses a dash');
  assert.ok(bar.includes('—'));
  assert.ok(bar.includes('r:?'), 'unknown reasoning request is not guessed');

  const lines = panelLines(status, { now: 1000 }).join('\n');
  assert.ok(lines.includes(`run        ${UNAVAILABLE}`), 'no run status before admission');
  assert.ok(lines.includes(`model req  ${UNAVAILABLE}`));
  assert.ok(lines.includes(`model act  ${UNAVAILABLE}`));
  assert.ok(lines.includes(`provider   ${UNAVAILABLE}`));
  assert.ok(lines.includes(`route      ${UNAVAILABLE}`));
  assert.ok(lines.includes(`ctx max    ${UNAVAILABLE}`));
  assert.ok(lines.includes(`tok in     ${UNAVAILABLE}`));
  assert.ok(lines.includes(`delegate   ${UNAVAILABLE}`));
  assert.equal(servedModelLabel(status), UNAVAILABLE);
  assert.equal(providerLabel(status), UNAVAILABLE);
  assert.equal(routeLabel(status), UNAVAILABLE);
});

test('requestedFromSettings mirrors the model expression in lib/hermes.js', () => {
  assert.deepEqual(requestedFromSettings({ MODEL: 'glasses', SMART: false }), {
    model: 'glasses',
    reasoning: 'none',
    mode: 'fast',
    endpoint: 'runs',
  });
  assert.deepEqual(requestedFromSettings({ MODEL: 'glasses', SMART: true }), {
    model: 'glasses-smart',
    reasoning: 'default',
    mode: 'smart',
    endpoint: 'runs',
  });
  // hermes-runs.js: config.SMART ? 'glasses-smart' : config.MODEL || 'glasses'
  assert.equal(requestedFromSettings({ SMART: false }).model, 'glasses');
  assert.equal(requestedFromSettings({ MODEL: 'custom', SMART: false }).model, 'custom');
});

test('on /v1/responses the model echo is never promoted to a served model', () => {
  const status = createStatus({ model: 'glasses' }, 0);
  applyStreamFrame(status, created('glasses'), { now: 10 });
  assert.equal(status.phase, 'thinking');
  applyStreamFrame(status, completed(), { now: 5000 });
  assert.equal(status.phase, 'done');
  assert.equal(status.stream.id, 'resp_t1');
  assert.equal(status.stream.model, 'glasses');
  const lines = panelLines(status, { now: 10 }).join('\n');
  // No runtime field exists on this route: still unavailable after completion.
  assert.match(lines, /model act {2}unavailable/);
  assert.match(lines, /provider {3}unavailable/);
});

test('response.created fills the request slot when the app did not supply one', () => {
  const status = createStatus({}, 0);
  applyStreamFrame(status, created('glasses-smart'), { now: 10 });
  assert.ok(panelLines(status, { now: 10 }).join('\n').includes('model req  glasses-smart'));
});

test('run.completed runtime names the served provider/model and how it was chosen', () => {
  const status = createStatus({ model: 'glasses' }, 0);
  applyStreamFrame(status, runFrame('message.delta', { delta: 'ok.' }), { now: 10 });
  applyStreamFrame(
    status,
    runFrame('run.completed', {
      output: 'ok.',
      usage: { input_tokens: 1200, output_tokens: 5, total_tokens: 1205, cache_read_tokens: 900, cache_write_tokens: 0 },
      runtime: RUNTIME,
      completed: true,
      partial: false,
      interrupted: false,
    }),
    { now: 4000 },
  );
  assert.equal(status.phase, 'done');
  assert.equal(status.run.status, 'completed');
  assert.equal(servedModelLabel(status), 'claude-haiku-4-5');
  assert.equal(providerLabel(status), 'anthropic');
  assert.equal(routeLabel(status), 'model_routes');
  assert.deepEqual(status.usage, {
    input_tokens: 1200,
    output_tokens: 5,
    total_tokens: 1205,
    cache_read_tokens: 900,
    cache_write_tokens: 0,
  });

  const lines = panelLines(status, { now: 4000 }).join('\n');
  assert.ok(lines.includes('model act  claude-haiku-4-5'));
  assert.ok(lines.includes('provider   anthropic'));
  assert.ok(lines.includes('route      model_routes'));
  assert.ok(lines.includes('cache rd/wr 900/0'));
  // Requested alias and served model stay distinguishable.
  assert.ok(lines.includes('model req  glasses'));
});

test('a terminal event without runtime leaves the served model unavailable', () => {
  const status = createStatus({ model: 'glasses' }, 0);
  applyStreamFrame(status, runFrame('run.completed', { output: 'ok.', completed: true }), { now: 1000 });
  assert.equal(status.phase, 'done');
  assert.equal(servedModelLabel(status), UNAVAILABLE);
  // An all-empty runtime object is not a served model either.
  applyStreamFrame(status, runFrame('run.completed', { runtime: { provider: '', model: '', route_source: '' } }), { now: 2000 });
  assert.equal(servedModelLabel(status), UNAVAILABLE);
});

test('reasoning summary is measured, never rendered', () => {
  const status = createStatus({ model: 'glasses-smart', reasoning: 'on' }, 0);
  applyStreamFrame(status, created('glasses-smart'), { now: 1 });
  applyStreamFrame(
    status,
    frame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'rs_1', type: 'reasoning', status: 'in_progress', summary: [] },
      sequence_number: 1,
    }),
    { now: 2 },
  );
  applyStreamFrame(
    status,
    frame('response.reasoning_summary_text.delta', {
      type: 'response.reasoning_summary_text.delta',
      item_id: 'rs_1',
      delta: 'PRIVATE THOUGHT',
      sequence_number: 2,
    }),
    { now: 3 },
  );
  assert.equal(status.reasoning.seen, true);
  assert.equal(status.reasoning.chars, 'PRIVATE THOUGHT'.length);

  applyStreamFrame(
    status,
    frame('response.reasoning_summary_text.done', {
      type: 'response.reasoning_summary_text.done',
      item_id: 'rs_1',
      text: 'PRIVATE THOUGHT',
      sequence_number: 3,
    }),
    { now: 4 },
  );
  assert.equal(status.reasoning.done, 1);
  assert.equal(status.reasoning.chars, 'PRIVATE THOUGHT'.length, 'done must not double count');

  const rendered = JSON.stringify(statusView(status, { now: 5 }));
  assert.ok(!rendered.includes('PRIVATE THOUGHT'), 'reasoning text must never be rendered');
  assert.ok(rendered.includes(`reason saw ${'PRIVATE THOUGHT'.length} ch`));
});

test('runs reasoning.available is measured, never rendered', () => {
  const status = createStatus({ model: 'glasses-smart', reasoning: 'on' }, 0);
  applyStreamFrame(status, runFrame('reasoning.available', { text: 'SECRET CHAIN OF THOUGHT' }), { now: 10 });
  assert.equal(status.reasoning.seen, true);
  assert.equal(status.reasoning.chars, 'SECRET CHAIN OF THOUGHT'.length);
  const rendered = JSON.stringify(statusView(status, { now: 20 }));
  assert.ok(!rendered.includes('SECRET CHAIN'));
  assert.ok(rendered.includes('reason saw 23 ch'));
});

test('tool items are counted, matched by call_id, and the last one is shown', () => {
  const status = createStatus({ model: 'glasses' }, 0);
  const call = (name, callId, seq) => [
    frame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 1,
      item: { id: `fc_${seq}`, type: 'function_call', status: 'in_progress', name, call_id: callId, arguments: '{}' },
      sequence_number: seq,
    }),
    frame('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 1,
      item: { id: `fc_${seq}`, type: 'function_call', status: 'completed', name, call_id: callId, arguments: '{}' },
      sequence_number: seq + 1,
    }),
  ];

  applyStreamFrame(status, created(), { now: 1 });
  for (const f of call('web_search', 'call_a', 2)) applyStreamFrame(status, f, { now: 2 });
  assert.equal(status.phase, 'tool');
  assert.equal(status.tools.started, 1);
  assert.equal(status.tools.done, 1);
  assert.equal(status.tools.active, null, 'a finished tool is no longer active');
  assert.equal(status.tools.last, 'web_search');

  for (const f of call('web_search', 'call_b', 4)) applyStreamFrame(status, f, { now: 3 });
  const lines = panelLines(status, { now: 4 }).join('\n');
  assert.ok(lines.includes('tools      2 done'));
});

test('a tool call still open is reported as active, not as done', () => {
  const status = createStatus({ model: 'glasses' }, 0);
  applyStreamFrame(
    status,
    frame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 1,
      item: { id: 'fc_x', type: 'function_call', status: 'in_progress', name: 'terminal', call_id: 'call_x', arguments: '{}' },
      sequence_number: 2,
    }),
    { now: 1 },
  );
  assert.equal(status.phase, 'tool');
  assert.ok(panelLines(status, { now: 2 }).join('\n').includes('tools      using terminal'));
});

test('runs tool.start/completed carries a real duration and error flag', () => {
  const status = createStatus({ model: 'glasses' }, 0);
  applyStreamFrame(status, runFrame('tool.started', { tool: 'terminal', preview: 'echo ok' }), { now: 10 });
  assert.equal(status.phase, 'tool');
  assert.equal(status.tools.active, 'terminal');
  applyStreamFrame(
    status,
    runFrame('tool.completed', { tool: 'terminal', duration: 0.82, error: true, preview: 'killed' }),
    { now: 830 },
  );
  assert.equal(status.tools.failed, 1);
  assert.equal(status.tools.lastDuration, 820);
  const lines = panelLines(status, { now: 900 }).join('\n');
  assert.ok(lines.includes('tools      1 done, 1 failed'), lines);
  assert.ok(lines.includes('tool       terminal 0.8s failed'), lines);
});

test('delegations are counted only from delegate_task, and nothing else is claimed', () => {
  const status = createStatus({ model: 'glasses-smart', reasoning: 'on' }, 0);
  assert.equal(delegationLabel(status), UNAVAILABLE, 'no evidence means unavailable, not 0');

  applyStreamFrame(status, created('glasses-smart'), { now: 1 });
  applyStreamFrame(
    status,
    frame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 1,
      item: { id: 'fc_d', type: 'function_call', status: 'in_progress', name: 'delegate_task', call_id: 'call_d', arguments: '{}' },
      sequence_number: 2,
    }),
    { now: 2 },
  );
  assert.equal(status.delegations.started, 1);
  assert.equal(delegationLabel(status), '1 tool call, 1 open');

  applyStreamFrame(
    status,
    frame('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 1,
      item: { id: 'fc_d', type: 'function_call', status: 'completed', name: 'delegate_task', call_id: 'call_d', arguments: '{}' },
      sequence_number: 3,
    }),
    { now: 3 },
  );
  assert.equal(status.delegations.done, 1);
  assert.equal(delegationLabel(status), '1 tool call, 0 open');

  // A non-delegation tool must never be counted as one.
  applyStreamFrame(
    status,
    frame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 2,
      item: { id: 'fc_w', type: 'function_call', status: 'in_progress', name: 'web_search', call_id: 'call_w', arguments: '{}' },
      sequence_number: 4,
    }),
    { now: 4 },
  );
  assert.equal(status.delegations.started, 1);
});

test('subagent.start/complete give real per-child progress', () => {
  const status = createStatus({ model: 'glasses-smart', reasoning: 'on' }, 0);
  applyStreamFrame(
    status,
    runFrame('subagent.start', {
      preview: 'scan the timetable',
      subagent_id: 'sub_1',
      delegation_id: 'del_1',
      task_index: 0,
      task_count: 2,
      depth: 1,
      model: 'claude-haiku-4-5',
      status: 'running',
    }),
    { now: 1000 },
  );
  assert.equal(status.subagents.length, 1);
  assert.equal(status.subagents[0].goal, 'scan the timetable');
  assert.equal(status.subagents[0].depth, 1);
  assert.equal(status.subagents[0].taskCount, 2);
  assert.equal(delegationLabel(status), '1 started, 1 open');
  assert.ok(panelLines(status, { now: 2000 }).join('\n').includes('child 1    running'));

  // tool_count rides on the child's own progress, which the run stream does
  // not forward; a completion fills it in.
  applyStreamFrame(
    status,
    runFrame('subagent.complete', {
      subagent_id: 'sub_1',
      delegation_id: 'del_1',
      status: 'completed',
      duration_seconds: 41.3,
      tool_count: 3,
      input_tokens: 1804,
      output_tokens: 320,
    }),
    { now: 42000 },
  );
  assert.equal(delegationLabel(status), '1 started, 0 open');
  assert.equal(status.subagents[0].toolCount, 3);
  const child = childLines(status).join('\n');
  assert.ok(child.includes('completed 41s 2.1k'), child);
  // The child's model is reported, not assumed.
  assert.equal(status.subagents[0].model, 'claude-haiku-4-5');
});

test('a completion without a matching start still records the child', () => {
  const status = createStatus({}, 0);
  applyStreamFrame(
    status,
    runFrame('subagent.complete', { subagent_id: 'sub_x', status: 'timeout', duration_seconds: 120 }),
    { now: 1000 },
  );
  assert.equal(status.subagents.length, 1);
  assert.equal(status.subagents[0].status, 'timeout');
  assert.ok(childLines(status).join('\n').includes('timeout 2m00'));
});

test('a child still open when the run ends is reported as unreported, not as success', () => {
  const status = createStatus({}, 0);
  applyStreamFrame(status, runFrame('subagent.start', { subagent_id: 'sub_1', status: 'running' }), { now: 10 });
  applyStreamFrame(status, runFrame('run.completed', { output: 'done', completed: true }), { now: 5000 });
  assert.equal(delegationLabel(status), '1 started, 1 open');
  assert.equal(childLines(status)[0].includes('run ended'), true, childLines(status)[0]);
});

test('usage arrives only with the terminal event, and is not invented before it', () => {
  const status = createStatus({ model: 'glasses' }, 0);
  applyStreamFrame(status, created(), { now: 1 });
  assert.equal(status.usage, null);
  assert.ok(panelLines(status, { now: 2 }).join('\n').includes(`tok in     ${UNAVAILABLE}`));

  applyStreamFrame(status, completed(), { now: 5000 });
  assert.deepEqual(status.usage, { input_tokens: 900, output_tokens: 40, total_tokens: 940 });
  assert.equal(status.phase, 'done');
  assert.equal(status.endedAt, 5000);
  const lines = panelLines(status, { now: 9000 }).join('\n');
  assert.ok(lines.includes('tok in     900'));
  assert.ok(lines.includes('tok out    40'));
  // Elapsed freezes at the terminal event rather than growing forever.
  assert.equal(elapsedMs(status, 9000), 5000);
  assert.ok(lines.includes('process    done 5.0s'));
});

test('a completed event without usage leaves tokens unavailable instead of 0', () => {
  const status = createStatus({ model: 'glasses' }, 0);
  applyStreamFrame(
    status,
    frame('response.completed', {
      type: 'response.completed',
      response: { id: 'resp_t2', status: 'completed', model: 'glasses', output: [] },
      sequence_number: 3,
    }),
    { now: 1000 },
  );
  assert.equal(status.usage, null);
  assert.ok(panelLines(status, { now: 1000 }).join('\n').includes(`tok in     ${UNAVAILABLE}`));
});

test('response.failed surfaces the error and freezes the clock', () => {
  const status = createStatus({ model: 'glasses' }, 0);
  applyStreamFrame(
    status,
    frame('response.failed', {
      type: 'response.failed',
      response: {
        id: 'resp_t3',
        status: 'failed',
        model: 'glasses',
        output: [],
        error: { message: 'provider returned 503', type: 'server_error' },
        usage: { input_tokens: 700, output_tokens: 0, total_tokens: 700 },
      },
      sequence_number: 4,
    }),
    { now: 2000 },
  );
  assert.equal(status.phase, 'failed');
  assert.equal(status.error, 'provider returned 503');
  const lines = panelLines(status, { now: 9000 }).join('\n');
  assert.ok(lines.includes('error      provider returned 503'));
  assert.ok(lines.includes('tok in     700'));
  assert.equal(lines.includes('tok out    0'), true, 'a real reported 0 is not hidden');
  assert.ok(lines.includes('process    failed 2.0s'));
});

test('run.failed reads the error from the run payload and keeps the usage', () => {
  const status = createStatus({ model: 'glasses' }, 0);
  applyStreamFrame(
    status,
    runFrame('run.failed', { error: 'provider returned 502', usage: { input_tokens: 66, output_tokens: 0, total_tokens: 66 } }),
    { now: 3000 },
  );
  assert.equal(status.phase, 'failed');
  assert.equal(status.error, 'provider returned 502');
  assert.equal(status.run.status, 'failed');
  assert.ok(panelLines(status, { now: 9000 }).join('\n').includes('tok in     66'));
});

test('run.cancelled and run.interrupted are reported as stopped, with the reason', () => {
  for (const [name, reason] of [['run.cancelled', 'cancelled'], ['run.interrupted', 'interrupted']]) {
    const status = createStatus({}, 0);
    applyStreamFrame(status, runFrame(name, { completed: false, interrupted: reason === 'interrupted' }), { now: 2000 });
    assert.equal(status.phase, 'stopped', name);
    assert.equal(status.stoppedReason, reason, name);
    assert.equal(status.endedAt, 2000, name);
    assert.ok(panelLines(status, { now: 3000 }).join('\n').includes(`stopped    ${reason}`), name);
  }
});

test('an approval request parks the phase and says so', () => {
  const status = createStatus({}, 0);
  applyStreamFrame(
    status,
    runFrame('approval.request', { request_id: 'apr_1', tool: 'terminal', command: 'rm -rf /tmp/x', choices: ['once', 'deny'] }),
    { now: 1000 },
  );
  assert.equal(status.phase, 'approval');
  assert.equal(status.approval.tool, 'terminal');
  const lines = panelLines(status, { now: 2000 }).join('\n');
  assert.ok(lines.includes('approval   waiting terminal'), lines);
  assert.ok(!lines.includes('rm -rf'), 'the command is not a status field');
});

test('applyRunStart and applyRunStatus only carry what the server said', () => {
  const status = createStatus({ model: 'glasses' }, 0);
  applyRunStart(status, { runId: 'run_abc', sessionId: 'conv-1' }, 10);
  assert.equal(status.run.id, 'run_abc');
  assert.equal(status.run.status, 'started');
  assert.equal(status.phase, 'queued');

  applyRunStatus(
    status,
    {
      object: 'hermes.run',
      run_id: 'run_abc',
      status: 'completed',
      session_id: 'conv-1',
      model: 'glasses',
      output: 'hello',
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      runtime: RUNTIME,
    },
    2000,
  );
  assert.equal(status.run.status, 'completed');
  assert.equal(status.phase, 'done');
  assert.equal(servedModelLabel(status), 'claude-haiku-4-5');
  assert.equal(status.answerChars, 5);

  const other = createStatus({}, 0);
  applyRunStatus(other, { status: 'waiting_for_approval' }, 10);
  assert.equal(other.phase, 'approval');
  applyRunStatus(other, { status: 'running' }, 20);
  assert.equal(other.phase, 'approval', 'a non-terminal status does not un-park the phase');
});

test('hermes.status frames (kind/text, no type, no sequence_number) become a notice', () => {
  const status = createStatus({ model: 'glasses' }, 0);
  applyStreamFrame(
    status,
    { event: 'hermes.status', data: JSON.stringify({ kind: 'lifecycle', text: 'Waiting for provider...' }) },
    { now: 1 },
  );
  assert.deepEqual(status.notice, { kind: 'lifecycle', text: 'Waiting for provider...' });
  assert.ok(panelLines(status, { now: 2 }).join('\n').includes('notice     lifecycle: Waiting for provider...'));
});

test('a truncated replay is surfaced rather than silently skipped', () => {
  const status = createStatus({}, 0);
  applyStreamFrame(status, runFrame('replay.truncated', { oldest_retained_seq: 40 }), { now: 10 });
  assert.equal(status.notice.kind, 'replay');
  assert.ok(panelLines(status, { now: 20 }).join('\n').includes('notice     replay: event history truncated'));
});

test('commentary deltas never count as the answer', () => {
  const status = createStatus({ model: 'glasses' }, 0);
  applyStreamFrame(
    status,
    frame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'msg_c', type: 'message', status: 'completed', phase: 'commentary', role: 'assistant', content: [] },
      sequence_number: 1,
    }),
    { now: 1 },
  );
  applyStreamFrame(
    status,
    frame('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: 'msg_c',
      output_index: 0,
      delta: 'checking that now',
      sequence_number: 2,
    }),
    { now: 2 },
  );
  assert.equal(status.answerChars, 0);
  assert.notEqual(status.phase, 'answering');
});

test('runs commentary: interim text is counted but never becomes the answer', () => {
  const status = createStatus({ model: 'glasses' }, 0);
  applyStreamFrame(status, runFrame('message.interim', { text: 'one moment', already_streamed: false }), { now: 10 });
  assert.equal(status.answerChars, 0);
  assert.equal(status.interimChars, 'one moment'.length);
  // Already-streamed commentary must not be counted twice.
  applyStreamFrame(status, runFrame('message.interim', { text: 'one moment', already_streamed: true }), { now: 20 });
  assert.equal(status.interimChars, 'one moment'.length);
  applyStreamFrame(status, runFrame('message.delta', { delta: 'here it is' }), { now: 30 });
  assert.equal(status.answerChars, 'here it is'.length);
  assert.equal(status.phase, 'answering');
});

test('malformed, unknown and empty frames are ignored without throwing', () => {
  const status = createStatus({ model: 'glasses' }, 0);
  const junk = [
    null,
    undefined,
    {},
    { event: 'message', data: 'not json' },
    { event: 'message', data: 'null' },
    { event: 'message', data: '123' },
    { event: 'response.something_new', data: '{"type":"response.something_new"}' },
    { event: 'response.output_text.delta', data: '{"type":"response.output_text.delta"}' },
    { event: '', data: '{"type":""}' },
    { event: 'message', data: '{"type":"hermes.status","kind":"","text":""}' },
    { event: '', data: '{"event":"run.something_new","run_id":"r"}' },
    { event: '', data: '{"event":"subagent.start"}' },
    { event: '', data: '{"event":"tool.completed"}' },
  ];
  for (const f of junk) {
    assert.doesNotThrow(() => applyStreamFrame(status, f, { now: 1 }));
  }
  assert.equal(status.phase, 'sending', 'garbage does not advance the phase');
  assert.equal(status.error, null);
});

test('markStopped is a client-side fact and stops the clock', () => {
  const status = createStatus({ model: 'glasses' }, 100);
  applyStreamFrame(status, created(), { now: 200 });
  markStopped(status, 'cancelled', 1200);
  assert.equal(status.phase, 'stopped');
  assert.equal(elapsedMs(status, 99999), 1100);
  assert.ok(panelLines(status, { now: 99999 }).join('\n').includes('stopped    cancelled'));
  // A terminal phase is not overwritten by a late abort.
  applyStreamFrame(status, completed(), { now: 1300 });
  markStopped(status, 'cancelled', 1400);
  assert.equal(status.phase, 'done');
});

test('markStopped keeps "stop sent" distinct from "stopped locally"', () => {
  for (const reason of ['stop sent', 'stopped locally']) {
    const status = createStatus({}, 0);
    markStopped(status, reason, 500);
    assert.equal(status.stoppedReason, reason);
    assert.ok(panelLines(status, { now: 600 }).join('\n').includes(`stopped    ${reason}`));
  }
});

test('markFailed records a client-observed failure as failed, not as stopped', () => {
  const status = createStatus({ model: 'glasses' }, 100);
  applyStreamFrame(status, created(), { now: 200 });
  markFailed(status, 'Hermes 401: {"error":"invalid api key"}', 900);
  assert.equal(status.phase, 'failed');
  assert.equal(status.endedAt, 900);
  assert.equal(elapsedMs(status, 99999), 800);
  assert.equal(status.stoppedReason, undefined, 'a failure is never reported as a stop');
  const lines = panelLines(status, { now: 99999 }).join('\n');
  assert.ok(lines.includes('process    failed'), lines);
  assert.ok(lines.includes('error      Hermes 401'), lines);
  assert.ok(lines.includes('run        unavailable'), 'no run was admitted, so none is claimed');

  // A completed turn keeps its phase if a late failure is recorded.
  applyStreamFrame(status, completed(), { now: 1000 });
  markFailed(status, 'late transport error', 1100);
  assert.equal(status.phase, 'done');
});

test('markFailed never leaves an empty error', () => {
  const status = createStatus({}, 0);
  markFailed(status, '', 10);
  assert.equal(status.error, 'Hermes failed');
});

// ---------------------------------------------------------------- render

test('every rendered line fits its display width', () => {
  const status = createStatus({ model: 'glasses-smart', reasoning: 'on' }, 0);
  applyStreamFrame(status, created('glasses-smart'), { now: 1 });
  applyStreamFrame(
    status,
    frame('hermes.status', { kind: 'lifecycle', text: 'Waiting for provider. This can take a while, hold on.' }),
    { now: 2 },
  );
  applyStreamFrame(status, completed(), { now: 9000 });

  const bar = barLine(status, { now: 9000, width: BAR_UNITS });
  assert.ok(textWidth(bar) <= BAR_UNITS, `bar too wide: ${bar}`);
  assert.ok(bar.includes('glasses-smart'), 'a 13-char alias still fits at 14px');
  assert.ok(bar.endsWith('›'));

  const expanded = barLine(status, { now: 9000, width: BAR_UNITS, expanded: true });
  assert.ok(expanded.endsWith('⌄'));

  for (const line of panelLines(status, { now: 9000, width: PANEL_UNITS })) {
    assert.equal(typeof line, 'string');
    assert.ok(textWidth(line) <= PANEL_UNITS, `line too wide: ${line}`);
    assert.ok(!/undefined|NaN|null/.test(line), `placeholder leaked: ${line}`);
  }
});

test('a fully populated runs state still fits 30 units on every row', () => {
  const status = createStatus({ model: 'glasses-smart', reasoning: 'on' }, 0);
  applyRunStart(status, { runId: 'run_verylongidentifier0123456789', sessionId: 'conv' }, 1);
  const frames = [
    runFrame('tool.started', { tool: 'delegate_task', preview: 'a very long preview of arguments goes here' }),
    runFrame('subagent.start', {
      preview: 'a long goal description that would not fit on the glasses display',
      subagent_id: 'sub_verylongidentifier',
      status: 'running',
      task_index: 0,
      task_count: 3,
      depth: 1,
      model: 'claude-haiku-4-5-20251001',
    }),
    runFrame('subagent.complete', {
      subagent_id: 'sub_verylongidentifier',
      status: 'completed',
      duration_seconds: 3599.5,
      input_tokens: 120034,
      output_tokens: 88021,
      tool_count: 12,
    }),
    runFrame('tool.completed', { tool: 'delegate_task', duration: 3600.5, error: true }),
    runFrame('message.delta', { delta: 'x'.repeat(400) }),
    runFrame('run.completed', {
      output: 'y'.repeat(400),
      usage: { input_tokens: 1234567, output_tokens: 98765, total_tokens: 1333332, cache_read_tokens: 999999, cache_write_tokens: 12345 },
      runtime: { provider: 'some-very-long-provider-slug', model: 'a-very-long-model-identifier-2026', route_source: 'model_routes' },
      completed: true,
    }),
  ];
  let now = 0;
  for (const f of frames) applyStreamFrame(status, f, { now: (now += 1000) });
  for (const line of panelLines(status, { now, width: PANEL_UNITS })) {
    assert.ok(textWidth(line) <= PANEL_UNITS, `line too wide (${textWidth(line)}): ${line}`);
    assert.ok(!/undefined|NaN|null|\[object/.test(line), `placeholder leaked: ${line}`);
  }
});

test('statusView returns a plain render model', () => {
  const status = createStatus({ model: 'glasses' }, 0);
  const view = statusView(status, { now: 1000, expanded: true });
  assert.deepEqual(Object.keys(view).sort(), ['bar', 'children', 'expanded', 'lines', 'phase']);
  assert.equal(view.expanded, true);
  assert.equal(view.phase, 'sending');
  assert.ok(Array.isArray(view.lines) && view.lines.length >= 10);
  assert.deepEqual(view.children, []);
});
