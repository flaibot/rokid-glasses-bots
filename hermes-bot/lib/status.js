// Status view for the Hermes Bot glasses app (prototype).
//
// Pure data + formatting only: no `wx`, no DOM, no fetch. A page feeds it
// stream frames from lib/hermes.js (/v1/responses) or lib/hermes-runs.js
// (/v1/runs) and renders what it returns, so every rule here is unit-testable
// in Node.
//
// Protocol honesty rules — this module deliberately never guesses:
//   1. Only fields the server actually emits are read, and each row names the
//      endpoint fact it came from. docs/PROTOCOL-RUNS.md cites the source.
//   2. Anything the stream does not carry is reported as
//      `UNAVAILABLE` ('unavailable'), never as 0, never as a plausible guess.
//   3. "requested" (what the app asked for) and "served" (what actually
//      answered) are separate rows. `response.model` on /v1/responses is an
//      echo of the request, so `model act` is `unavailable` there. On
//      /v1/runs the terminal `runtime` event names the provider/model that
//      really served the turn, so it is shown, with `route` saying how it was
//      chosen (`model_routes`, `raw_request`, `global`).
//   4. Reasoning TEXT is never rendered — only how many characters of it
//      arrived. It is private model output and the answer path discards it.
//   5. Token counts are what Hermes billed for this turn (input summed over
//      the turn's model calls). They are never turned into a context-window
//      percentage: no field reports the window size or the occupancy.

export const UNAVAILABLE = 'unavailable';
// The one-line bar is 14px (the app's existing .tool/.hint size), so it holds
// about 30 display units; the answer text is 20px and holds 21.
export const BAR_UNITS = 30;
export const PANEL_UNITS = 30;
export const ANSWER_UNITS = 21;

// The only tool name in hermes-agent that starts a child agent
// (agent/context_breakdown.py: _SUBAGENT_TOOL_NAMES = frozenset({"delegate_task"})).
const DELEGATE_TOOL = 'delegate_task';

const PHASE_LABELS = {
  sending: 'sending',
  queued: 'queued',
  thinking: 'thinking',
  tool: 'using tool',
  approval: 'approval',
  answering: 'answering',
  stopping: 'stopping',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

// Terminal statuses of a child agent (tools/delegate_tool_child_run.py, as
// published in apps/shared/src/gateway-contract.openrpc.json SubagentStatus).
const CHILD_TERMINAL = new Set(['completed', 'failed', 'error', 'timeout', 'interrupted']);

// ---------------------------------------------------------------- width

export function charWidth(ch) {
  return ch.charCodeAt(0) < 128 ? 0.55 : 1;
}

export function textWidth(text) {
  let units = 0;
  for (const ch of String(text ?? '')) units += charWidth(ch);
  return units;
}

// Truncates to `width` display units, ending with '…'.
export function fit(text, width = ANSWER_UNITS) {
  const value = String(text ?? '');
  if (textWidth(value) <= width) return value;
  let out = '';
  let units = 0;
  for (const ch of value) {
    const w = charWidth(ch);
    if (units + w > width - 1) break;
    out += ch;
    units += w;
  }
  return `${out.trimEnd()}…`;
}

export function pad(text, width = 12) {
  const value = String(text ?? '');
  const missing = Math.floor(width - textWidth(value));
  return missing > 0 ? value + ' '.repeat(missing) : value;
}

// Column padding for the panel: labels are ASCII, so alignment has to be in
// characters — pad() measures display units and would misalign them.
export function col(label, width = 10) {
  const value = String(label ?? '');
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

// ---------------------------------------------------------------- numbers

export function formatDuration(ms) {
  const seconds = Math.max(0, Number(ms) || 0) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  // Round first, then split, so 3599.5s reads 60m00 and never 59m60.
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}m${String(total % 60).padStart(2, '0')}`;
}

export function formatCount(n) {
  if (!Number.isFinite(n)) return UNAVAILABLE;
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function text(value) {
  return typeof value === 'string' && value ? value : '';
}

function int(value) {
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------- state

// options: { model, reasoning, mode, endpoint }
//   model     the model string the app will send (settings.MODEL or the
//             glasses-smart alias) — what we REQUESTED
//   reasoning 'none' | 'on' — what the app requested (fast mode sends
//             model_options.reasoning_effort: "none")
//   mode      'fast' | 'smart' — the app's own switch, shown for humans
//   endpoint  'runs' | 'responses' — which API served the turn, so a view can
//             say plainly when `model act` is knowable at all
export function createStatus(options = {}, now = Date.now()) {
  const requestedReasoning =
    options.reasoning === 'none' || options.reasoning === 'off'
      ? 'none'
      : options.reasoning === 'default' || options.reasoning === 'on'
        ? 'default'
        : null;
  return {
    requested: {
      model: text(options.model) || null,
      reasoning: requestedReasoning,
      mode: options.mode === 'fast' || options.mode === 'smart' ? options.mode : null,
    },
    endpoint: options.endpoint === 'runs' || options.endpoint === 'responses' ? options.endpoint : null,
    phase: 'sending',
    startedAt: now,
    endedAt: null,
    // Everything below is filled only from emitted stream fields.
    stream: { id: null, status: null, model: null },
    run: { id: null, status: null, sessionId: null, lastEvent: null },
    // runtime: {provider, model, route_source, requested} — the pair that
    // actually served the turn. null until a terminal event carries it.
    served: null,
    reasoning: { itemId: null, chars: 0, seen: false, done: 0 },
    tools: { started: 0, done: 0, failed: 0, active: null, last: null, lastDuration: null, lastError: false, names: {} },
    delegations: { started: 0, done: 0 },
    subagents: [],
    notice: null,
    approval: null,
    usage: null,
    error: null,
    answerChars: 0,
    interimChars: 0,
    calls: {},      // call_id -> tool name, so function_call_output can be matched
    commentary: {}, // item_id -> true for phase:"commentary" message items
  };
}

// Mirrors the model expression in lib/hermes.js so a caller holding settings
// does not have to repeat it. Keep in sync if that expression changes.
export function requestedFromSettings(settings = {}) {
  return {
    model: settings.SMART ? 'glasses-smart' : settings.MODEL || 'glasses',
    reasoning: settings.SMART ? 'default' : 'none',
    mode: settings.SMART ? 'smart' : 'fast',
    endpoint: 'runs',
  };
}

function parseData(data) {
  if (data && typeof data === 'object') return data;
  if (typeof data !== 'string') return null;
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    return null;
  }
}

function usageOf(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const read = (key) => (Number.isFinite(usage[key]) ? usage[key] : null);
  const input = read('input_tokens');
  const output = read('output_tokens');
  const total = read('total_tokens');
  const cacheRead = read('cache_read_tokens');
  const cacheWrite = read('cache_write_tokens');
  if (input == null && output == null && total == null && cacheRead == null && cacheWrite == null) return null;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    ...(cacheRead == null ? {} : { cache_read_tokens: cacheRead }),
    ...(cacheWrite == null ? {} : { cache_write_tokens: cacheWrite }),
  };
}

// The `runtime` object as the server publishes it
// (api_server._sanitize_runtime_metadata): {provider, model, route_source,
// requested?: {provider, model}, model_lock?}. Empty strings are real
// ("unknown to the server"), so they are normalised to null, not invented.
function servedOf(runtime) {
  if (!runtime || typeof runtime !== 'object') return null;
  const provider = text(runtime.provider) || null;
  const model = text(runtime.model) || null;
  const routeSource = text(runtime.route_source) || null;
  const requested = runtime.requested && typeof runtime.requested === 'object'
    ? { provider: text(runtime.requested.provider) || null, model: text(runtime.requested.model) || null }
    : null;
  if (!provider && !model && !routeSource) return null;
  return { provider, model, routeSource, requested };
}

function childFromEvent(msg, eventName) {
  return {
    id: text(msg.subagent_id) || null,
    delegationId: text(msg.delegation_id) || null,
    parentId: text(msg.parent_id) || null,
    childSessionId: text(msg.child_session_id) || null,
    goal: text(msg.goal) || text(msg.preview) || null,
    model: text(msg.model) || null,
    depth: int(msg.depth),
    taskIndex: int(msg.task_index),
    taskCount: int(msg.task_count),
    toolCount: int(msg.tool_count),
    durationSeconds: int(msg.duration_seconds),
    inputTokens: int(msg.input_tokens),
    outputTokens: int(msg.output_tokens),
    reasoningTokens: int(msg.reasoning_tokens),
    apiCalls: int(msg.api_calls),
    costUsd: int(msg.cost_usd),
    filesRead: int(Array.isArray(msg.files_read) ? msg.files_read.length : null),
    filesWritten: int(Array.isArray(msg.files_written) ? msg.files_written.length : null),
    status: text(msg.status) || (eventName === 'subagent.complete' ? 'complete' : 'running'),
    event: eventName,
  };
}

function findChild(state, child) {
  const children = state.subagents;
  if (child.id) {
    const byId = children.find((c) => c.id === child.id);
    if (byId) return byId;
  }
  // Older emitters omit identity fields: fall back to the oldest child that is
  // still running and matches on whatever identity we do have.
  return children.find((c) => {
    if (CHILD_TERMINAL.has(c.status)) return false;
    if (child.delegationId && c.delegationId && child.delegationId !== c.delegationId) return false;
    if (child.taskIndex != null && c.taskIndex != null && child.taskIndex !== c.taskIndex) return false;
    return true;
  }) || null;
}

// Feeds one SSE frame ({ event, data }) into the state. Mutates `state` and
// returns it. Never throws: malformed or unknown frames are ignored, because a
// status display must not break the reply it is watching.
export function applyStreamFrame(state, frame, options = {}) {
  if (!state || !frame) return state;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const eventName = typeof frame.event === 'string' ? frame.event : '';
  const msg = parseData(frame.data);
  if (!msg) return state;

  // hermes.status (/v1/responses): emitted with `event: hermes.status` and a
  // body of {kind, text} — no `type`, no sequence_number.
  if (eventName === 'hermes.status' || msg.type === 'hermes.status') {
    const kind = text(msg.kind);
    const body = text(msg.text);
    if (kind || body) state.notice = { kind: kind || UNAVAILABLE, text: body || UNAVAILABLE };
    return state;
  }

  // /v1/runs frames carry their name inside the payload (`event`), because the
  // writer sends no SSE `event:` line (api_server_runs._handle_run_events ->
  // _sse_frame(payload, id=seq)).
  const type = text(msg.event) || (eventName && eventName !== 'message' ? eventName : text(msg.type));

  switch (type) {
    // ---------------------------------------------------------- /v1/runs
    case 'replay.truncated': {
      // The server kept fewer events than we asked to replay: frames were
      // dropped, so anything missing here was never seen.
      state.notice = { kind: 'replay', text: 'event history truncated' };
      break;
    }

    case 'message.delta': {
      const delta = text(msg.delta);
      if (delta) {
        state.answerChars += delta.length;
        state.phase = 'answering';
      }
      break;
    }

    case 'message.interim': {
      // Mid-turn commentary. Never the answer, never rendered here; only its
      // size is counted, and only when it did not already arrive as a delta.
      const body = text(msg.text);
      if (body && !msg.already_streamed) state.interimChars += body.length;
      break;
    }

    case 'tool.started': {
      const name = text(msg.tool);
      state.tools.started += 1;
      state.tools.active = name || state.tools.active;
      state.tools.last = name || state.tools.last;
      if (name) state.tools.names[name] = (state.tools.names[name] || 0) + 1;
      if (name === DELEGATE_TOOL) state.delegations.started += 1;
      state.phase = 'tool';
      break;
    }

    case 'tool.completed': {
      const name = text(msg.tool) || state.tools.last || '';
      state.tools.done += 1;
      if (msg.error) state.tools.failed += 1;
      if (state.tools.active && state.tools.active === name) state.tools.active = null;
      state.tools.last = name || state.tools.last;
      state.tools.lastDuration = Number.isFinite(msg.duration) ? Math.round(msg.duration * 1000) : null;
      state.tools.lastError = Boolean(msg.error);
      if (name === DELEGATE_TOOL) state.delegations.done += 1;
      break;
    }

    case 'reasoning.available': {
      // Text becomes available; measured and discarded (rule 4).
      const body = text(msg.text);
      if (body) {
        state.reasoning.seen = true;
        state.reasoning.chars = Math.max(state.reasoning.chars, body.length);
        state.reasoning.done += 1;
      }
      break;
    }

    case 'subagent.start': {
      const child = childFromEvent(msg, type);
      const existing = findChild(state, child);
      if (existing) Object.assign(existing, child, { status: child.status || 'running', event: type });
      else state.subagents.push(child);
      break;
    }

    case 'subagent.complete': {
      const child = childFromEvent(msg, type);
      const existing = findChild(state, child);
      if (existing) {
        // Only overwrite with fields the completion actually carried.
        for (const [key, value] of Object.entries(child)) {
          if (value !== null && value !== undefined && value !== '') existing[key] = value;
        }
        existing.event = type;
      } else {
        state.subagents.push(child);
      }
      break;
    }

    case 'approval.request': {
      // The run is parked until someone answers POST /v1/runs/{id}/approval.
      state.phase = 'approval';
      state.approval = {
        requestId: text(msg.request_id) || null,
        tool: text(msg.tool) || text(msg.name) || null,
        // The server redacts the command before it leaves the process.
        command: text(msg.command) || null,
        choices: Array.isArray(msg.choices) ? msg.choices.map(String) : null,
      };
      break;
    }

    case 'run.stopping': {
      state.run.status = 'stopping';
      state.phase = 'stopping';
      break;
    }

    case 'run.steered': {
      state.notice = { kind: 'steer', text: 'guidance accepted' };
      break;
    }

    case 'run.completed':
    case 'run.failed':
    case 'run.cancelled':
    case 'run.interrupted': {
      const terminal = type.slice(4); // 'completed' | 'failed' | ...
      state.run.status = terminal;
      state.run.lastEvent = type;
      state.served = servedOf(msg.runtime) || state.served;
      state.usage = usageOf(msg.usage) || state.usage;
      if (typeof msg.output === 'string') state.answerChars = msg.output.length;
      state.endedAt = now;
      if (terminal === 'completed') {
        state.phase = 'done';
      } else if (terminal === 'failed') {
        state.phase = 'failed';
        state.error = text(msg.error) || 'Hermes run failed';
      } else {
        // cancelled / interrupted: stopped by someone other than this page.
        state.phase = 'stopped';
        state.stoppedReason = terminal;
        if (text(msg.error)) state.error = text(msg.error);
      }
      break;
    }

    // ---------------------------------------------------- /v1/responses
    case 'response.created': {
      const response = msg.response || {};
      state.stream.id = text(response.id) || state.stream.id;
      state.stream.status = text(response.status) || state.stream.status;
      // Echo of the requested model, not the served one (see header note 3).
      state.stream.model = text(response.model) || state.stream.model;
      if (state.phase === 'sending') state.phase = 'thinking';
      break;
    }

    case 'response.output_item.added': {
      const item = msg.item || {};
      const itemType = text(item.type);
      if (itemType === 'reasoning') {
        state.reasoning.itemId = text(item.id) || null;
        state.phase = 'thinking';
      } else if (itemType === 'function_call') {
        const name = text(item.name);
        const callId = text(item.call_id);
        state.tools.started += 1;
        state.tools.active = name || state.tools.active;
        state.tools.last = name || state.tools.last;
        if (name) state.tools.names[name] = (state.tools.names[name] || 0) + 1;
        if (callId && name) state.calls[callId] = name;
        if (name === DELEGATE_TOOL) state.delegations.started += 1;
        state.phase = 'tool';
      } else if (itemType === 'message') {
        const id = text(item.id);
        if (id && item.phase === 'commentary') state.commentary[id] = true;
      }
      break;
    }

    case 'response.output_item.done': {
      const item = msg.item || {};
      if (text(item.type) === 'function_call') {
        const name = text(item.name) || state.calls[text(item.call_id)] || '';
        state.tools.done += 1;
        if (state.tools.active && state.tools.active === name) state.tools.active = null;
        if (name === DELEGATE_TOOL) state.delegations.done += 1;
      }
      break;
    }

    case 'response.reasoning_summary_text.delta': {
      const delta = text(msg.delta);
      if (delta) {
        state.reasoning.seen = true;
        state.reasoning.chars += delta.length;
      }
      break;
    }

    case 'response.reasoning_summary_text.done': {
      // Authoritative length for the burst; text itself is never kept.
      const body = text(msg.text);
      state.reasoning.seen = true;
      state.reasoning.chars += Math.max(0, body.length - state.reasoning.chars);
      state.reasoning.done += 1;
      break;
    }

    case 'response.output_text.delta': {
      if (state.commentary[text(msg.item_id)]) break;
      const delta = text(msg.delta);
      if (delta) {
        state.answerChars += delta.length;
        state.phase = 'answering';
      }
      break;
    }

    case 'response.output_text.done': {
      if (state.commentary[text(msg.item_id)]) break;
      const body = text(msg.text);
      if (body) {
        state.answerChars = body.length;
        state.phase = 'answering';
      }
      break;
    }

    case 'response.completed': {
      const response = msg.response || {};
      state.phase = 'done';
      state.endedAt = now;
      state.stream.status = text(response.status) || 'completed';
      state.stream.model = text(response.model) || state.stream.model;
      state.usage = usageOf(response.usage) || state.usage;
      // No `runtime` field is emitted by this route: `served` stays null and
      // the view keeps saying `unavailable`.
      state.served = servedOf(response.runtime) || state.served;
      break;
    }

    case 'response.failed': {
      const response = msg.response || {};
      state.phase = 'failed';
      state.endedAt = now;
      state.stream.status = text(response.status) || 'failed';
      state.usage = usageOf(response.usage) || state.usage;
      state.error = text(response.error?.message) || text(msg.message) || 'Hermes failed';
      break;
    }

    case 'error': {
      state.phase = 'failed';
      state.endedAt = now;
      state.error = text(msg.error?.message) || text(msg.message) || 'Hermes failed';
      break;
    }

    default:
      // Unknown or unrelated frame (commentary item churn, keepalives that
      // survived parsing): ignored on purpose.
      break;
  }
  return state;
}

// The admission response of POST /v1/runs: client-known facts, no guessing.
export function applyRunStart(state, run, now = Date.now()) {
  if (!state) return state;
  const id = text(run?.runId);
  if (id) state.run.id = id;
  if (text(run?.sessionId)) state.run.sessionId = text(run.sessionId);
  state.run.status = run?.replayed ? 'replayed' : 'started';
  state.endpoint = 'runs';
  if (state.phase === 'sending') state.phase = 'queued';
  return state;
}

// GET /v1/runs/{id} — fold a polled status record into the same state. Used
// when the event stream is gone; it carries the same fields by contract.
export function applyRunStatus(state, status, now = Date.now()) {
  if (!state || !status || typeof status !== 'object') return state;
  const name = text(status.status);
  if (name) {
    state.run.status = name;
    state.run.lastEvent = text(status.last_event) || state.run.lastEvent;
  }
  if (text(status.session_id)) state.run.sessionId = text(status.session_id);
  state.served = servedOf(status.runtime) || state.served;
  state.usage = usageOf(status.usage) || state.usage;
  if (typeof status.output === 'string' && status.output) state.answerChars = status.output.length;
  if (name === 'completed') {
    state.phase = 'done';
    state.endedAt = now;
  } else if (name === 'failed') {
    state.phase = 'failed';
    state.endedAt = now;
    state.error = text(status.error) || state.error || 'Hermes run failed';
  } else if (name === 'cancelled' || name === 'interrupted' || name === 'stopping') {
    if (name === 'stopping') {
      state.phase = 'stopping';
    } else {
      state.phase = 'stopped';
      state.stoppedReason = name;
    }
    if (name !== 'stopping') state.endedAt = now;
  } else if (name === 'waiting_for_approval') {
    state.phase = 'approval';
  }
  return state;
}

// Client-side facts the app knows for certain (it did the aborting), kept
// separate from anything the stream reports. `mode` says whether Hermes
// accepted the stop request: 'server' means the run was asked to stop,
// 'local' means only this page stopped reading and the run may still be going.
export function markStopped(state, reason, now = Date.now()) {
  if (!state) return state;
  if (state.phase !== 'done' && state.phase !== 'failed') state.phase = 'stopped';
  state.endedAt = now;
  if (text(reason)) state.error = null;
  state.stoppedReason = text(reason) || 'cancelled';
  return state;
}

// A failure the client itself observed before any terminal run event (auth
// rejection, transport error, refused admission, unknown outcome). Kept
// separate from markStopped so a failed turn never reads as "stopped" — the
// reason is this client's own, and it is attributed as such.
export function markFailed(state, message, now = Date.now()) {
  if (!state) return state;
  if (state.phase !== 'done') state.phase = 'failed';
  if (!Number.isFinite(state.endedAt)) state.endedAt = now;
  state.error = text(message) || state.error || 'Hermes failed';
  return state;
}

// ---------------------------------------------------------------- render

export function elapsedMs(state, now = Date.now()) {
  if (!state) return 0;
  const end = Number.isFinite(state.endedAt) ? state.endedAt : now;
  const start = Number.isFinite(state.startedAt) ? state.startedAt : end;
  return Math.max(0, end - start);
}

export function phaseLabel(state) {
  return PHASE_LABELS[state?.phase] || UNAVAILABLE;
}

// The alias we asked for. Falls back to the stream's echo (same meaning) and
// only then to `unavailable`.
export function requestedModelLabel(state) {
  return text(state?.requested?.model) || text(state?.stream?.model) || UNAVAILABLE;
}

// The model that ACTUALLY answered. Only a terminal `runtime` says this.
export function servedModelLabel(state) {
  return text(state?.served?.model) || UNAVAILABLE;
}

export function providerLabel(state) {
  return text(state?.served?.provider) || UNAVAILABLE;
}

export function routeLabel(state) {
  return text(state?.served?.routeSource) || UNAVAILABLE;
}

export function reasoningRequestLabel(state) {
  const value = state?.requested?.reasoning;
  return value === 'none' || value === 'default' ? value : UNAVAILABLE;
}

// Characters of reasoning text received. A count of what arrived, not proof
// of how hard the model worked.
export function reasoningSeenLabel(state) {
  const reasoning = state?.reasoning;
  if (!reasoning?.seen) return 'none';
  return `${formatCount(reasoning.chars)} ch`;
}

export function toolsLabel(state) {
  const tools = state?.tools;
  if (!tools) return UNAVAILABLE;
  if (tools.active) return `using ${tools.active}`;
  if (tools.started || tools.done) {
    const failed = tools.failed ? `, ${tools.failed} failed` : '';
    if (tools.started === tools.done || tools.done) return `${tools.done} done${failed}`;
    return `${tools.started} started${failed}`;
  }
  return 'none';
}

export function lastToolLabel(state) {
  const tools = state?.tools;
  if (!tools?.last || !tools.done) return null;
  const duration = Number.isFinite(tools.lastDuration) ? ` ${formatDuration(tools.lastDuration)}` : '';
  const failed = tools.lastError ? ' failed' : '';
  return `${tools.last}${duration}${failed}`;
}

// Delegation progress. On /v1/runs this counts real subagent lifecycle
// events; on /v1/responses the only evidence is a `delegate_task` call, so
// the count is of tool calls and nothing more.
export function delegationLabel(state) {
  const children = state?.subagents || [];
  if (children.length) {
    const open = children.filter((child) => !CHILD_TERMINAL.has(child.status)).length;
    return `${children.length} started, ${open} open`;
  }
  const delegations = state?.delegations;
  if (!delegations?.started) return UNAVAILABLE;
  const running = Math.max(0, delegations.started - delegations.done);
  return `${delegations.started} tool call, ${running} open`;
}

// One row per child agent, from its own lifecycle events.
export function childLines(state) {
  const children = state?.subagents || [];
  const lines = [];
  children.slice(0, 4).forEach((child, index) => {
    const label = `child ${index + 1}`;
    const bits = [];
    const terminal = CHILD_TERMINAL.has(child.status);
    bits.push(child.status || 'running');
    if (terminal && Number.isFinite(child.durationSeconds)) bits.push(formatDuration(child.durationSeconds * 1000));
    if (!terminal && Number.isFinite(child.toolCount) && child.toolCount > 0) bits.push(`${child.toolCount} tools`);
    if (terminal && child.inputTokens != null && child.outputTokens != null) {
      bits.push(formatCount(child.inputTokens + child.outputTokens));
    }
    // A run that ends while a child is still open leaves its outcome
    // unreported on this stream — say so instead of implying success.
    if (!terminal && state?.phase === 'done') bits.push('run ended');
    lines.push(`${col(label, 10)} ${bits.join(' ')}`);
  });
  return lines;
}

function usageRow(label, value) {
  return `${col(label, 10)} ${value == null ? UNAVAILABLE : formatCount(value)}`;
}

// One-line summary for the always-visible bar.
export function barLine(state, options = {}) {
  if (!state) return fit(`model ${UNAVAILABLE}`);
  const width = Number.isFinite(options.width) ? options.width : BAR_UNITS;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const model = requestedModelLabel(state) === UNAVAILABLE ? '—' : fit(requestedModelLabel(state), 14);
  const reasoning = reasoningRequestLabel(state) === UNAVAILABLE ? 'r:?' : `r:${reasoningRequestLabel(state)}`;
  const time = formatDuration(elapsedMs(state, now));
  const caret = options.expanded ? '⌄' : '›';
  return fit([model, reasoning, time, caret].join(' · '), width);
}

// Expanded panel: one short row per fact, paged by the caller. Every value is
// either an emitted field or `unavailable`.
export function panelLines(state, options = {}) {
  const width = Number.isFinite(options.width) ? options.width : PANEL_UNITS;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  if (!state) return [fit(`model act  ${UNAVAILABLE}`, width)];

  const usage = state.usage;
  const rows = [
    `${col('run', 10)} ${state.run?.status || UNAVAILABLE}`,
    `${col('model req', 10)} ${requestedModelLabel(state)}`,
    // /v1/responses never reports which model/provider served the turn.
    `${col('model act', 10)} ${servedModelLabel(state)}`,
    `${col('provider', 10)} ${providerLabel(state)}`,
    `${col('route', 10)} ${routeLabel(state)}`,
    usageRow('tok in', usage ? usage.input_tokens : null),
    usageRow('tok out', usage ? usage.output_tokens : null),
    `${col('turn tok/s', 10)} ${Number.isFinite(state.endedAt) && usage?.output_tokens != null && elapsedMs(state, now) > 0 ? (usage.output_tokens * 1000 / elapsedMs(state, now)).toFixed(1) : UNAVAILABLE}`,
  ];
  if (usage && (usage.cache_read_tokens != null || usage.cache_write_tokens != null)) {
    const read = usage.cache_read_tokens == null ? UNAVAILABLE : formatCount(usage.cache_read_tokens);
    const write = usage.cache_write_tokens == null ? UNAVAILABLE : formatCount(usage.cache_write_tokens);
    rows.push(`${col('cache rd/wr', 10)} ${read}/${write}`);
  }
  rows.push(
    // No endpoint of this API reports the model's context window or the
    // occupancy of it, so neither is shown or derived.
    `${col('ctx max', 10)} ${UNAVAILABLE}`,
    `${col('reason req', 10)} ${reasoningRequestLabel(state)}`,
    `${col('reason saw', 10)} ${reasoningSeenLabel(state)}`,
  );
  const lastTool = lastToolLabel(state);
  rows.push(
    `${col('process', 10)} ${phaseLabel(state)} ${formatDuration(elapsedMs(state, now))}`,
    `${col('tools', 10)} ${toolsLabel(state)}`,
  );
  if (lastTool) rows.push(`${col('tool', 10)} ${lastTool}`);
  rows.push(`${col('delegate', 10)} ${delegationLabel(state)}`);
  rows.push(...childLines(state));
  if (state.approval) {
    const what = state.approval.tool ? ` ${state.approval.tool}` : '';
    rows.push(`${col('approval', 10)} waiting${what}`);
  }
  if (state.notice) {
    const kind = state.notice.kind === UNAVAILABLE ? '' : `${state.notice.kind}: `;
    rows.push(`${col('notice', 10)} ${kind}${state.notice.text}`);
  }
  if (state.stoppedReason) rows.push(`${col('stopped', 10)} ${state.stoppedReason}`);
  if (state.error) rows.push(`${col('error', 10)} ${state.error}`);
  return rows.map((row) => fit(row, width));
}

export function statusView(state, options = {}) {
  return {
    bar: barLine(state, options),
    lines: panelLines(state, options),
    phase: phaseLabel(state),
    children: (state?.subagents || []).slice(),
    expanded: Boolean(options.expanded),
  };
}
