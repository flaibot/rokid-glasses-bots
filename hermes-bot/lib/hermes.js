// Minimal client for Hermes' OpenAI Responses endpoint (POST /v1/responses,
// stream: true). Hermes keeps the history server-side under `conversation`.

// Splits an SSE byte stream into { event, data } frames. Lines starting with
// ':' are Hermes keepalives and are skipped.
function createSseParser(onFrame) {
  let buffer = '';
  let event = '';
  let data = [];

  function flush() {
    if (data.length) onFrame({ event: event || 'message', data: data.join('\n') });
    event = '';
    data = [];
  }

  return (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line === '') flush();
      else if (line.startsWith(':')) continue;
      else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  };
}

// Added to your Hermes agent's system prompt for every glasses request
// (Hermes treats `instructions` as an ephemeral system prompt), so the
// agent's own settings don't need changing for the glasses.
export const GLASSES_INSTRUCTIONS = [
  "You are replying on the user's Rokid smart glasses: a small monochrome display, and replies are read aloud.",
  'Keep replies VERY short: one to three short sentences. No markdown, lists or tables unless the user asks.',
  "The user's messages are speech-to-text, so expect misheard, missing or cut-off words. Work out the likely meaning.",
  'If you have to assume what the user meant, say so in a few words at the very start (e.g. "Assuming you meant X: ..."). If it is unclear and it matters, ask one short question instead of guessing.',
  'Be quick: as few tool calls as possible, and do not explore.',
].join(' ');

// Sends one user turn and streams the reply.
// handlers: onText(fullTextSoFar), onTool(toolName), returns final reply text.
export async function askHermes(config, input, handlers = {}, signal) {
  const response = await fetch(`${config.HERMES_URL}/v1/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.HERMES_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      // A model_routes alias on the Hermes side: "glasses" (fastest model) or
      // "glasses-smart" (slower, more careful), switched by voice.
      model: config.SMART ? 'glasses-smart' : config.MODEL || 'glasses',
      input,
      conversation: config.CONVERSATION,
      instructions: GLASSES_INSTRUCTIONS,
      stream: true,
      // Fast mode (default) skips the model's thinking step: ~1 s quicker
      // per reply on a fast model in testing, and tools still work.
      ...(config.SMART ? {} : { model_options: { reasoning_effort: 'none' } }),
    }),
    timeout: 10 * 60 * 1000,
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Hermes ${response.status}: ${body.slice(0, 160)}`);
  }

  // Text per output item; the answer is the last non-commentary message.
  const texts = {};
  const commentary = {};
  let lastItem = null;
  let finalText = '';
  let failure = null;

  const parse = createSseParser(({ data }) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return;
    }
    switch (msg.type) {
      case 'response.output_item.added':
        if (msg.item?.type === 'function_call') handlers.onTool?.(msg.item.name || 'tool');
        if (msg.item?.type === 'message' && msg.item.phase === 'commentary') commentary[msg.item.id] = true;
        break;
      case 'response.output_text.delta':
        if (commentary[msg.item_id]) break;
        texts[msg.item_id] = (texts[msg.item_id] || '') + (msg.delta || '');
        lastItem = msg.item_id;
        handlers.onText?.(texts[lastItem]);
        break;
      case 'response.output_text.done':
        if (!commentary[msg.item_id] && typeof msg.text === 'string') {
          texts[msg.item_id] = msg.text;
          lastItem = msg.item_id;
        }
        break;
      case 'response.completed':
        finalText = lastItem ? texts[lastItem] : '';
        break;
      case 'response.failed':
      case 'error':
        failure = msg.response?.error?.message || msg.error?.message || msg.message || 'Hermes failed';
        break;
    }
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  // Abort may not interrupt a pending read on Ink: cancel the reader too,
  // which also closes the stream so Hermes stops the turn.
  const stop = () => reader.cancel().catch(() => {});
  if (signal) {
    if (signal.aborted) stop();
    else if (signal.addEventListener) signal.addEventListener('abort', stop);
  }
  while (true) {
    if (signal?.aborted) throw new Error('Cancelled');
    const { value, done } = await reader.read();
    if (done) break;
    parse(decoder.decode(value, { stream: true }));
  }
  if (signal?.aborted) throw new Error('Cancelled');
  parse(decoder.decode() + '\n\n');

  if (failure) throw new Error(failure);
  return finalText || (lastItem ? texts[lastItem] : '');
}

// Markdown is noise when read aloud or on a tiny display.
export function plainText(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    // Single * or _ only around whole words, so snake_case_names survive.
    .replace(/(^|[\s(])([*_])(\S(?:.*?\S)?)\2(?=[\s.,;:!?)]|$)/gm, '$1$3')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .trim();
}
