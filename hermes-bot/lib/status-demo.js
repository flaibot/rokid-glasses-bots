// Demo fixtures for the status view prototype.
//
// Every frame below is a SYNTHETIC replay shaped exactly like the frames
// hermes-agent 0.21.3 emits from gateway/platforms/api_server_openai_routes.py
// (see docs/PROTOCOL.md for the line references). They exist so the view can
// be exercised with no network, no key and no credentials; they are NOT a
// recording. The page labels them `fixture`.

const frame = (event, payload) => ({ event, data: JSON.stringify(payload) });

const created = (model, id = 'resp_demo0001') =>
  frame('response.created', {
    type: 'response.created',
    response: {
      id,
      object: 'response',
      status: 'in_progress',
      created_at: 1764000000,
      model,
      output: [],
    },
    sequence_number: 0,
  });

const reasoningItem = (id = 'rs_demo0001') => [
  frame('response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 0,
    item: { id, type: 'reasoning', status: 'in_progress', summary: [] },
    sequence_number: 1,
  }),
  frame('response.reasoning_summary_part.added', {
    type: 'response.reasoning_summary_part.added',
    item_id: id,
    output_index: 0,
    summary_index: 0,
    part: { type: 'summary_text', text: '' },
    sequence_number: 2,
  }),
];

const reasoningDelta = (text, seq = 3, id = 'rs_demo0001') =>
  frame('response.reasoning_summary_text.delta', {
    type: 'response.reasoning_summary_text.delta',
    item_id: id,
    output_index: 0,
    summary_index: 0,
    delta: text,
    sequence_number: seq,
  });

const reasoningDone = (text, seq = 4, id = 'rs_demo0001') => [
  frame('response.reasoning_summary_text.done', {
    type: 'response.reasoning_summary_text.done',
    item_id: id,
    output_index: 0,
    summary_index: 0,
    text,
    sequence_number: seq,
  }),
  frame('response.reasoning_summary_part.done', {
    type: 'response.reasoning_summary_part.done',
    item_id: id,
    output_index: 0,
    summary_index: 0,
    part: { type: 'summary_text', text },
    sequence_number: seq + 1,
  }),
  frame('response.output_item.done', {
    type: 'response.output_item.done',
    output_index: 0,
    item: { id, type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text }] },
    sequence_number: seq + 2,
  }),
];

const textDelta = (text, seq, id = 'msg_demo0001') =>
  frame('response.output_text.delta', {
    type: 'response.output_text.delta',
    item_id: id,
    output_index: 2,
    content_index: 0,
    delta: text,
    logprobs: [],
    sequence_number: seq,
  });

const textDone = (text, seq, id = 'msg_demo0001') => [
  frame('response.output_text.done', {
    type: 'response.output_text.done',
    item_id: id,
    output_index: 2,
    content_index: 0,
    text,
    logprobs: [],
    sequence_number: seq,
  }),
  frame('response.output_item.done', {
    type: 'response.output_item.done',
    output_index: 2,
    item: {
      id,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
    sequence_number: seq + 1,
  }),
];

const completed = (model, usage, seq = 40, id = 'resp_demo0001') =>
  frame('response.completed', {
    type: 'response.completed',
    response: {
      id,
      object: 'response',
      status: 'completed',
      created_at: 1764000000,
      model,
      output: [],
      usage: { input_tokens: usage[0], output_tokens: usage[1], total_tokens: usage[2] },
    },
    sequence_number: seq,
  });

const toolCall = (name, seq, callId = 'call_demo0001_1') => [
  frame('response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 1,
    item: {
      id: 'fc_demo0001',
      type: 'function_call',
      status: 'in_progress',
      name,
      call_id: callId,
      arguments: '{}',
    },
    sequence_number: seq,
  }),
  frame('response.output_item.done', {
    type: 'response.output_item.done',
    output_index: 1,
    item: {
      id: 'fc_demo0001',
      type: 'function_call',
      status: 'completed',
      name,
      call_id: callId,
      arguments: '{}',
    },
    sequence_number: seq + 1,
  }),
  frame('response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 2,
    item: {
      id: 'fco_demo0001',
      type: 'function_call_output',
      call_id: callId,
      output: [{ type: 'input_text', text: '[demo tool output]' }],
      status: 'completed',
    },
    sequence_number: seq + 2,
  }),
  frame('response.output_item.done', {
    type: 'response.output_item.done',
    output_index: 2,
    item: {
      id: 'fco_demo0001',
      type: 'function_call_output',
      call_id: callId,
      output: [{ type: 'input_text', text: '[demo tool output]' }],
      status: 'completed',
    },
    sequence_number: seq + 3,
  }),
];

const statusNotice = (kind, message, seq = 5) =>
  frame('hermes.status', { kind, text: message });

// /v1/runs frames have no SSE `event:` line: the name rides inside the JSON
// payload as `event`, and every payload carries run_id/timestamp/seq
// (api_server_runs._write_event -> _sse_frame(payload, id=seq)).
let runSeq = 0;
const runFrame = (name, payload = {}) => {
  runSeq += 1;
  return {
    event: '',
    data: JSON.stringify({
      event: name,
      run_id: 'run_demo0001',
      timestamp: 1764000000,
      seq: runSeq,
      ...payload,
    }),
  };
};

const runUsage = (input, output, cacheRead = 0) => ({
  input_tokens: input,
  output_tokens: output,
  total_tokens: input + output,
  cache_read_tokens: cacheRead,
  cache_write_tokens: 0,
});

// The terminal `runtime` object: the provider/model that actually served the
// turn, plus how the runtime was chosen (_sanitize_runtime_metadata).
const servedRuntime = (provider, model, routeSource = 'model_routes') => ({
  provider,
  model,
  route_source: routeSource,
  requested: { provider: '', model: 'glasses' },
});


export const DEMOS = [
  {
    id: 'fast',
    title: 'Fast reply',
    note: 'no reasoning requested, no tools: what a plain look like',
    build: () => [
      created('glasses'),
      textDelta('It is 18', 10),
      textDelta(' and clear', 11),
      textDelta(' in Sheung Shui.', 12),
      ...textDone('It is 18 and clear in Sheung Shui.', 13),
      completed('glasses', [812, 41, 853], 20),
    ],
  },
  {
    id: 'smart',
    title: 'Smart mode with reasoning',
    note: 'reasoning summary arrives as its own item; only its size is shown',
    build: () => [
      created('glasses-smart'),
      ...reasoningItem(),
      reasoningDelta('User asks about the weather; need the current  ', 3),
      reasoningDelta('conditions for their location, then one sentence.', 4),
      ...reasoningDone(
        'User asks about the weather; need the current conditions for their location, then one sentence.',
        5,
      ),
      textDelta('Assuming you mean Sheung Shui: 18 and clear.', 20),
      ...textDone('Assuming you mean Sheung Shui: 18 and clear.', 21),
      completed('glasses-smart', [1904, 96, 2000], 30),
    ],
  },
  {
    id: 'tool',
    title: 'One tool call',
    note: 'function_call items carry the tool name; the view counts them',
    build: () => [
      created('glasses'),
      ...toolCall('web_search', 10),
      textDelta('Top story: the ferry', 20),
      textDelta(' timetable changes Monday.', 21),
      ...textDone('Top story: the ferry timetable changes Monday.', 22),
      completed('glasses', [2470, 58, 2528], 30),
    ],
  },
  {
    id: 'delegate',
    title: 'Delegation',
    note: 'delegate_task is the only child-agent signal on this endpoint',
    build: () => [
      created('glasses-smart'),
      ...reasoningItem('rs_demo0002'),
      reasoningDelta('This needs a subagent for the long scan.', 3, 'rs_demo0002'),
      ...reasoningDone('This needs a subagent for the long scan.', 4, 'rs_demo0002'),
      ...toolCall('delegate_task', 10, 'call_demo0002_1'),
      textDelta('Delegated: I will report back', 20),
      textDelta(' when the scan finishes.', 21),
      ...textDone('Delegated: I will report back when the scan finishes.', 22),
      completed('glasses-smart', [5120, 120, 5240], 30),
    ],
  },
  {
    id: 'notice',
    title: 'Provider wait notice',
    note: 'hermes.status frames explain a silent stream',
    build: () => [
      created('glasses'),
      statusNotice('lifecycle', 'Waiting for provider...', 2),
      textDelta('Slow provider, but here.', 10),
      ...textDone('Slow provider, but here.', 11),
      completed('glasses', [640, 12, 652], 20),
    ],
  },
  {
    id: 'failed',
    title: 'Failure',
    note: 'response.failed carries the error message and usage',
    build: () => [
      created('glasses'),
      frame('response.failed', {
        type: 'response.failed',
        response: {
          id: 'resp_demo0001',
          object: 'response',
          status: 'failed',
          created_at: 1764000000,
          model: 'glasses',
          output: [],
          error: { message: 'provider returned 503', type: 'server_error' },
          usage: { input_tokens: 700, output_tokens: 0, total_tokens: 700 },
        },
        sequence_number: 10,
      }),
    ],
  },
  {
    id: 'run-tool',
    title: 'Run: tool + served model',
    note: '/v1/runs: real tool timing, and the provider/model that answered',
    build: () => [
      runFrame('tool.started', { tool: 'terminal', preview: 'echo ok' }),
      runFrame('tool.completed', { tool: 'terminal', duration: 0.82, error: false, preview: 'ok\n' }),
      runFrame('message.delta', { delta: 'The command printed ' }),
      runFrame('message.delta', { delta: 'ok.' }),
      runFrame('run.completed', {
        output: 'The command printed ok.',
        usage: runUsage(2480, 12, 1904),
        runtime: servedRuntime('anthropic', 'claude-haiku-4-5', 'model_routes'),
        completed: true,
        partial: false,
        interrupted: false,
      }),
    ],
  },
  {
    id: 'run-delegate',
    title: 'Run: delegation',
    note: '/v1/runs: subagent.start/complete name the child and its outcome',
    build: () => [
      runFrame('tool.started', { tool: 'delegate_task', preview: 'scan the ferry timetable' }),
      runFrame('subagent.start', {
        preview: 'scan the ferry timetable',
        goal: 'scan the ferry timetable',
        subagent_id: 'sa-0-demo1',
        delegation_id: 'deleg_demo1',
        child_session_id: '20261126_040549_demo1',
        task_index: 0,
        task_count: 2,
        depth: 0,
        tool_count: 0,
        model: 'claude-haiku-4-5',
        status: 'running',
      }),
      runFrame('subagent.start', {
        preview: 'check sunday sailings',
        goal: 'check sunday sailings',
        subagent_id: 'sa-1-demo2',
        delegation_id: 'deleg_demo1',
        child_session_id: '20261126_040549_demo2',
        task_index: 1,
        task_count: 2,
        depth: 0,
        tool_count: 0,
        model: 'claude-haiku-4-5',
        status: 'running',
      }),
      runFrame('subagent.complete', {
        subagent_id: 'sa-0-demo1',
        delegation_id: 'deleg_demo1',
        task_index: 0,
        status: 'completed',
        duration_seconds: 41.3,
        tool_count: 3,
        input_tokens: 1804,
        output_tokens: 320,
        api_calls: 4,
      }),
      runFrame('tool.completed', { tool: 'delegate_task', duration: 41.9, error: false }),
      runFrame('run.completed', {
        output: 'Two results: the 07:30 sailing moves to 07:45; Sunday is unchanged.',
        usage: runUsage(6210, 96, 4980),
        runtime: servedRuntime('anthropic', 'claude-haiku-4-5', 'model_routes'),
        completed: true,
        partial: false,
        interrupted: false,
      }),
    ],
  },
];

export function demoById(id) {
  return DEMOS.find((demo) => demo.id === id) || DEMOS[0];
}
