// Fixture sanity: the demo scenarios must stay shaped like real server frames
// and must render without leaking undefined/NaN/JSON junk onto the display.
//
//   node --test test/
//
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEMOS, demoById } from '../lib/status-demo.js';
import {
  applyStreamFrame,
  barLine,
  createStatus,
  panelLines,
  requestedFromSettings,
  textWidth,
  PANEL_UNITS,
  BAR_UNITS,
} from '../lib/status.js';

// /v1/runs frames carry their name inside the payload and no SSE event name.
function frameEvent(frame) {
  if (typeof frame.event === 'string' && frame.event) return frame.event;
  const payload = JSON.parse(frame.data);
  return typeof payload.event === 'string' ? payload.event : '';
}

test('there is at least one fixture per interesting case', () => {
  const ids = DEMOS.map((demo) => demo.id);
  for (const expected of [
    'fast',
    'smart',
    'tool',
    'delegate',
    'notice',
    'failed',
    'run-tool',
    'run-delegate',
  ]) {
    assert.ok(ids.includes(expected), `missing fixture: ${expected}`);
  }
  assert.equal(demoById('nope').id, DEMOS[0].id, 'unknown ids fall back to the first fixture');
});

test('every fixture frame is well-formed JSON with an event name', () => {
  for (const demo of DEMOS) {
    assert.ok(demo.title && demo.note, `${demo.id} needs a title and a note`);
    const frames = demo.build();
    assert.ok(frames.length >= 2, `${demo.id} is too short to be useful`);
    for (const frame of frames) {
      assert.equal(typeof frame.event, 'string');
      assert.ok(frameEvent(frame).length > 0, `${demo.id}: frame with no event name`);
      assert.doesNotThrow(() => JSON.parse(frame.data), `${demo.id}: bad JSON frame`);
    }
  }
});

test('the runs fixtures carry the wire fields the client relies on', () => {
  for (const id of ['run-tool', 'run-delegate']) {
    for (const frame of demoById(id).build()) {
      const payload = JSON.parse(frame.data);
      assert.equal(typeof payload.run_id, 'string', `${id}: no run_id`);
      assert.equal(typeof payload.timestamp, 'number', `${id}: no timestamp`);
      assert.equal(typeof payload.seq, 'number', `${id}: no seq`);
    }
  }
  const completed = demoById('run-tool')
    .build()
    .map((frame) => JSON.parse(frame.data))
    .find((payload) => payload.event === 'run.completed');
  assert.deepEqual(Object.keys(completed.runtime).sort(), ['model', 'provider', 'requested', 'route_source']);
  assert.ok(completed.usage.total_tokens > 0);
});

test('every fixture renders to legal display lines and ends in a real phase', () => {
  for (const demo of DEMOS) {
    const smart = demo.id === 'smart' || demo.id === 'delegate' || demo.id === 'run-delegate';
    const status = createStatus(requestedFromSettings({ MODEL: 'glasses', SMART: smart }), 0);
    let now = 0;
    for (const frame of demo.build()) {
      applyStreamFrame(status, frame, { now: (now += 250) });
    }

    assert.ok(
      ['done', 'failed'].includes(status.phase),
      `${demo.id} ended in ${status.phase}`,
    );

    if (demo.id === 'failed') {
      assert.equal(status.phase, 'failed');
      assert.match(status.error, /503/);
    } else {
      assert.equal(status.phase, 'done');
      assert.ok(status.usage && status.usage.total_tokens > 0, `${demo.id} lost its usage`);
      assert.ok(status.answerChars > 0, `${demo.id} streamed no answer text`);
    }

    const bar = barLine(status, { now, width: BAR_UNITS });
    assert.ok(textWidth(bar) <= BAR_UNITS, `${demo.id}: bar too wide "${bar}"`);
    assert.ok(!/undefined|NaN/.test(bar), `${demo.id}: bar leaked "${bar}"`);

    const lines = panelLines(status, { now, width: PANEL_UNITS });
    for (const line of lines) {
      assert.ok(textWidth(line) <= PANEL_UNITS, `${demo.id}: line too wide "${line}"`);
      assert.ok(!/undefined|NaN|\[object/.test(line), `${demo.id}: leaked "${line}"`);
    }
    const rendered = lines.join('\n');
    assert.ok(rendered.includes('ctx max    unavailable'), `${demo.id}: context window must stay unavailable`);
    assert.ok(rendered.includes('model req  '), `${demo.id}: no requested model row`);
    // Only the /v1/responses fixtures lack a runtime, so only they must say
    // the served model is unknown.
    if (demo.id.startsWith('run-')) {
      assert.ok(rendered.includes('model act  claude-haiku-4-5'), `${demo.id}: served model missing`);
      assert.ok(rendered.includes('provider   anthropic'), `${demo.id}: provider missing`);
      assert.ok(rendered.includes('route      model_routes'), `${demo.id}: route missing`);
    } else {
      assert.ok(rendered.includes('model act  unavailable'), `${demo.id}: claimed a served model`);
    }
  }
});

test('the responses delegation fixture counts exactly one child-agent tool call', () => {
  const demo = demoById('delegate');
  const status = createStatus(requestedFromSettings({ MODEL: 'glasses', SMART: true }), 0);
  let now = 0;
  for (const frame of demo.build()) applyStreamFrame(status, frame, { now: (now += 100) });
  assert.equal(status.delegations.started, 1);
  assert.equal(status.delegations.done, 1);
  assert.ok(panelLines(status, { now }).join('\n').includes('delegate   1 tool call, 0 open'));
});

test('the runs delegation fixture tracks two children by id', () => {
  const status = createStatus(requestedFromSettings({ MODEL: 'glasses', SMART: true }), 0);
  let now = 0;
  for (const frame of demoById('run-delegate').build()) applyStreamFrame(status, frame, { now: (now += 100) });
  assert.equal(status.subagents.length, 2);
  assert.equal(status.subagents[0].status, 'completed');
  assert.equal(status.subagents[1].status, 'running', 'the second child never reported completion');
  const rendered = panelLines(status, { now }).join('\n');
  assert.ok(rendered.includes('delegate   2 started, 1 open'), rendered);
  assert.ok(rendered.includes('child 1    completed 41s 2.1k'), rendered);
  // Still open when the run ended: reported as unreported, never as success.
  assert.ok(rendered.includes('child 2    running run ended'), rendered);
});
