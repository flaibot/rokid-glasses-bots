import { GLASSES_INSTRUCTIONS } from './hermes.js';
import { sessionIdFor, rememberSessionId, derivedSessionId } from './session.js';
import { turnsOf } from './history.js';
import { extractImages } from './image-bytes.js';

// Only explicit visual requests use the non-streaming path; regular speech keeps runs.
export function wantsImage(text) {
  return /\b(photo|photograph|picture|image|diagram|illustration)\b/i.test(String(text || '')) && /\b(show|see|draw|make|create|generate|display)\b/i.test(String(text || ''));
}

export function safeReply(text) {
  return String(text || '').replace(/!\[[^\]]*\]\(\s*data:image\/[^)]+\)/gi, '[image]')
    .replace(/MEDIA:\s*(?:"[^"]+"|'[^']+'|[^\r\n]+)/gi, '[image unavailable]').trim();
}

export async function askImage(config, input, signal) {
  let session = sessionIdFor(config.CONVERSATION);
  if (!session && turnsOf(config.CONVERSATION).length) throw new Error('This conversation needs a regular reply first to reconnect its history.');
  if (!session) {
    session = derivedSessionId(config.CONVERSATION);
    if (!session) throw new Error('Conversation ID unavailable');
    rememberSessionId(config.CONVERSATION, session);
  }
  const response = await fetch(`${String(config.HERMES_URL).replace(/\/+$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.HERMES_KEY}`, 'content-type': 'application/json', 'X-Hermes-Session-Id': session },
    body: JSON.stringify({ model: config.SMART ? 'glasses-smart' : config.MODEL || 'glasses', stream: false,
      messages: [{ role: 'system', content: GLASSES_INSTRUCTIONS + ' For a requested visual, create or select ONE relevant image and finish with its MEDIA: attachment tag. Prefer PNG or JPEG, under 1.5 MB, suitable for a small display. If unable, say so honestly.' }, { role: 'user', content: input }],
      ...(config.SMART ? {} : { model_options: { reasoning_effort: 'none' } }) }),
    timeout: 10 * 60 * 1000,
    signal,
  });
  if (!response.ok) throw new Error(`Hermes ${response.status}: image request failed`);
  const raw = await response.text();
  if (raw.length > 8 * 1024 * 1024) throw new Error('Image response too large');
  let json;
  try { json = JSON.parse(raw); } catch (_) { throw new Error('Invalid image response'); }
  const choice = json.choices?.[0];
  if (!choice) throw new Error('Image reply incomplete');
  const text = typeof choice.message?.content === 'string' ? choice.message.content : '';
  if (choice.finish_reason && choice.finish_reason !== 'stop') {
    const partial = safeReply(text.replace(/!\[[^\]]*\]\(\s*data:image\/[\s\S]*$/i, '')).trim();
    if (!partial) throw new Error('Image reply incomplete');
    return { text: partial, image: null, reason: 'Image reply incomplete.' };
  }
  const result = extractImages(text);
  const image = result.images.find(i => ['image/png', 'image/jpeg'].includes(i.mime) && i.byteLength <= 1.5 * 1024 * 1024);
  return { text: safeReply(result.cleanedText), image: image || null, reason: image ? '' : 'Image could not be delivered to the glasses.' };
}
