// Real client for Hermes' durable run API: POST /v1/runs to start a turn,
// GET /v1/runs/{id}/events to follow it, POST /v1/runs/{id}/stop to cancel.
//
// Why this exists (evidence in docs/PROTOCOL-RUNS.md):
//   * /v1/runs reports the provider/model that ACTUALLY served the turn
//     (terminal `runtime`), per-tool timings and errors (`tool.*`) and
//     delegation lifecycle (`subagent.start` / `subagent.complete`).
//   * POST /v1/responses reports none of those.
// The reply path is unchanged in shape: text still streams (`message.delta`)
// and the final answer is `run.completed`'s `output`, which is what askHermes
// returns from the last message item on the older endpoint.
//
// Two behaviours differ from /v1/responses and are not papered over:
//   1. Closing the event stream does NOT stop the run. Cancelling has to call
//      /stop; if that call fails the run keeps going server-side and the
//      caller is told `stopped: local` (see onStop).
//   2. Approval requests park a run in `waiting_for_approval`. This client has
//      no approval UI, so it reports `approval` and lets the caller decide.

import { GLASSES_INSTRUCTIONS, askHermes, createSseParser } from './hermes.js';
import { sessionIdFor, rememberSessionId, derivedSessionId } from './session.js';
import { turnsOf } from './history.js';

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const STOP_TIMEOUT_MS = 6000;
const STATUS_TIMEOUT_MS = 15000;
// One reconnect after a dropped event stream; the stream replays from
// `last_seq`, so a reconnect never loses frames it already sent.
const RECONNECTS = 1;

const TERMINAL_EVENTS = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
]);

export function runsBase(config) {
  return String(config?.HERMES_URL || '').replace(/\/+$/, '');
}

function authHeaders(config) {
  return {
    Authorization: `Bearer ${config.HERMES_KEY}`,
    'content-type': 'application/json',
  };
}

function shortBody(text) {
  return String(text || '').slice(0, 160);
}

// The model string this app asks for. Same expression as lib/hermes.js so the
// two paths request the same alias.
function requestedModel(config) {
  return config?.SMART ? 'glasses-smart' : config?.MODEL || 'glasses';
}

// POST /v1/runs. Returns the admission body ({run_id, status, replayed}).
// The body is never retried: a lost admission response means the run_id is
// unknown, and guessing would risk a second real turn.
export async function startRun(config, input, sessionId, signal) {
  const body = {
    input,
    instructions: GLASSES_INSTRUCTIONS,
    model: requestedModel(config),
    ...(sessionId ? { session_id: sessionId } : {}),
    // Fast mode (default) skips the model's thinking step, exactly as the
    // /v1/responses path does.
    ...(config?.SMART ? {} : { model_options: { reasoning_effort: 'none' } }),
  };
  const response = await fetch(`${runsBase(config)}/v1/runs`, {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify(body),
    timeout: REQUEST_TIMEOUT_MS,
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Hermes ${response.status}: ${shortBody(text)}`);
  }
  const ack = await response.json().catch(() => null);
  if (!ack || typeof ack.run_id !== 'string' || !ack.run_id) {
    throw new Error('Hermes run refused: no run_id in the admission response');
  }
  return ack;
}

// GET /v1/runs/{id} — the pollable status (also the fallback when the event
// stream ends without a terminal frame).
export async function runStatus(config, runId, signal) {
  const response = await fetch(`${runsBase(config)}/v1/runs/${encodeURIComponent(runId)}`, {
    headers: authHeaders(config),
    timeout: STATUS_TIMEOUT_MS,
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Hermes ${response.status}: ${shortBody(text)}`);
  }
  return response.json();
}

// POST /v1/runs/{id}/stop. Returns 'server' when Hermes accepted the stop
// request, 'local' when it did not (the caller must then say so).
export async function stopRun(config, runId) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), STOP_TIMEOUT_MS) : null;
  try {
    const response = await fetch(`${runsBase(config)}/v1/runs/${encodeURIComponent(runId)}/stop`, {
      method: 'POST',
      headers: authHeaders(config),
      body: '{}',
      signal: controller ? controller.signal : undefined,
    });
    return response.ok ? 'server' : 'local';
  } catch (e) {
    return 'local';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseJson(data) {
  try {
    const msg = JSON.parse(data);
    return msg && typeof msg === 'object' ? msg : null;
  } catch (e) {
    return null;
  }
}

// Follows one run to its terminal event. Returns
// { text, terminal, failure, lastSeq, incomplete }.
async function followRun(config, runId, signal, onFrame) {
  let lastSeq = -1;
  let terminal = null;
  let failure = null;
  let text = '';
  let reconnects = 0;

  while (true) {
    const query = lastSeq >= 0 ? `?last_seq=${lastSeq}` : '';
    const response = await fetch(
      `${runsBase(config)}/v1/runs/${encodeURIComponent(runId)}/events${query}`,
      {
        headers: authHeaders(config),
        timeout: REQUEST_TIMEOUT_MS,
        signal,
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Hermes ${response.status}: ${shortBody(body)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    // Abort may not interrupt a pending read on Ink: cancel the reader too.
    const stopReading = () => reader.cancel().catch(() => {});
    const onAbort = () => stopReading();
    if (signal) {
      if (signal.aborted) stopReading();
      else if (signal.addEventListener) signal.addEventListener('abort', onAbort);
    }

    try {
      const parse = createSseParser((frame) => {
        const msg = parseJson(frame.data);
        if (!msg) return;
        if (Number.isFinite(msg.seq)) lastSeq = msg.seq;
        const name = typeof msg.event === 'string' ? msg.event : frame.event;
        if (!name) return;
        onFrame?.(name, msg);
        if (TERMINAL_EVENTS.has(name)) {
          terminal = name;
          if (name === 'run.failed') {
            failure = typeof msg.error === 'string' && msg.error ? msg.error : 'Hermes run failed';
          }
          if (typeof msg.output === 'string' && msg.output) text = msg.output;
        }
      });
      while (true) {
        if (signal?.aborted) throw new Error('Cancelled');
        const { value, done } = await reader.read();
        if (done) break;
        parse(decoder.decode(value, { stream: true }));
      }
      parse(decoder.decode() + '\n\n');
    } catch (err) {
      // An abort is the caller's own doing; a transport error is not a run
      // outcome, so it falls through to the reconnect/poll path below.
      if (signal?.aborted) throw err;
    } finally {
      if (signal?.addEventListener) signal.removeEventListener?.('abort', onAbort);
    }

    if (terminal) return { text, terminal, failure, lastSeq, incomplete: false };
    if (signal?.aborted) throw new Error('Cancelled');

    // The stream closed (cleanly or not) without a terminal event: the run
    // outlived the transport, or the buffer expired. Reconnect once, then
    // fall back to polling the status.
    if (reconnects < RECONNECTS) {
      reconnects += 1;
      continue;
    }
    break;
  }

  // Fallback: the pollable status, which is authoritative for the outcome.
  const status = await runStatus(config, runId, signal).catch(() => null);
  const state = typeof status?.status === 'string' ? status.status : '';
  if (TERMINAL_EVENTS.has(`run.${state}`)) {
    return {
      text: typeof status.output === 'string' && status.output ? status.output : text,
      terminal: `run.${state}`,
      failure: state === 'failed' ? String(status.error || 'Hermes run failed') : null,
      lastSeq,
      incomplete: false,
      status,
    };
  }
  return { text, terminal: null, failure: null, lastSeq, incomplete: true, status };
}

// Runs one turn on /v1/runs and streams it.
// handlers: onText(fullTextSoFar), onTool(name), onEvent({event, data}),
//           onRun({runId, sessionId}), onStop({mode, reason}),
//           onIncomplete({status})
// Returns the final reply text. Throws on a failed run or on cancel, like
// askHermes does.
export async function askHermesRuns(config, input, handlers = {}, signal) {
  const sessionId = config?.SESSION_ID || null;
  const ack = await startRun(config, input, sessionId, signal);
  const runId = ack.run_id;
  try {
    handlers.onRun?.({ runId, sessionId: sessionId || null, replayed: Boolean(ack.replayed) });
  } catch (e) {}

  let stopRequested = null;
  const requestStop = (reason) => {
    if (stopRequested) return stopRequested;
    stopRequested = stopRun(config, runId).then((mode) => {
      try {
        handlers.onStop?.({ mode, reason });
      } catch (e) {}
      return mode;
    });
    return stopRequested;
  };
  const onAbort = () => {
    requestStop('aborted');
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else if (signal.addEventListener) signal.addEventListener('abort', onAbort);
  }

  let streamed = '';
  let sawDelta = false;

  try {
    const outcome = await followRun(config, runId, signal, (name, msg) => {
      if (name === 'message.delta' && typeof msg.delta === 'string' && msg.delta) {
        streamed += msg.delta;
        sawDelta = true;
        try {
          handlers.onText?.(streamed);
        } catch (e) {}
      } else if (name === 'tool.started' && typeof msg.tool === 'string') {
        try {
          handlers.onTool?.(msg.tool);
        } catch (e) {}
      }
      try {
        handlers.onEvent?.({ event: name, data: JSON.stringify(msg) });
      } catch (e) {}
    });

    if (signal?.aborted) {
      await requestStop('aborted');
      throw new Error('Cancelled');
    }
    if (outcome.failure) throw new Error(outcome.failure);
    if (outcome.incomplete) {
      try {
        handlers.onIncomplete?.({ status: outcome.status || null });
      } catch (e) {}
      // The text really was streamed; returning it would be a guess about
      // whether the run finished, so an empty reply stays empty and the
      // caller is told the outcome is unknown.
      if (!sawDelta) throw new Error('Hermes run outcome unknown: the stream closed and the run is not terminal');
      return outcome.text || streamed;
    }
    return outcome.text || streamed;
  } catch (err) {
    if (signal?.aborted) {
      await requestStop('aborted');
      throw new Error('Cancelled');
    }
    throw err;
  } finally {
    if (signal?.addEventListener) signal.removeEventListener?.('abort', onAbort);
  }
}

function hasLocalTurns(conversation) {
  try {
    return turnsOf(conversation).length > 0;
  } catch (e) {
    return false;
  }
}

// One user turn over whichever endpoint can keep this conversation's context.
//
//   1. a session id is already known for the conversation -> /v1/runs.
//   2. the conversation has local turns but no session id: it was created on
//      /v1/responses under a `conversation` name, and its server transcript
//      lives in a session id only a live response reveals. One turn on the
//      old endpoint (`bridge`) reads `X-Hermes-Session-Id` and stores it, so
//      the next turn moves to /v1/runs with the transcript intact.
//      If that header never arrives, this stays on /v1/responses for ever —
//      the pre-existing behaviour, never a silent reset.
//   3. a brand-new conversation: name the session ourselves and use /v1/runs
//      immediately (there is nothing to preserve).
export async function askHermesTurn(config, input, handlers = {}, signal) {
  const conversation = config?.CONVERSATION;
  const known = sessionIdFor(conversation);
  if (known) {
    try {
      handlers.onPath?.('runs');
    } catch (e) {}
    return askHermesRuns({ ...config, SESSION_ID: known }, input, handlers, signal);
  }
  if (hasLocalTurns(conversation)) {
    try {
      handlers.onPath?.('bridge');
    } catch (e) {}
    return askHermes(
      config,
      input,
      {
        ...handlers,
        onResponse: (response) => {
          let sessionId = '';
          try {
            sessionId = response?.headers?.get?.('x-hermes-session-id') || '';
          } catch (e) {}
          if (sessionId) rememberSessionId(conversation, sessionId);
        },
      },
      signal,
    );
  }
  const fresh = derivedSessionId(conversation);
  if (fresh) rememberSessionId(conversation, fresh);
  try {
    handlers.onPath?.('runs');
  } catch (e) {}
  return askHermesRuns({ ...config, SESSION_ID: fresh }, input, handlers, signal);
}
