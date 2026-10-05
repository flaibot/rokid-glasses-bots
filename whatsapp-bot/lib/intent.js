// Understands what the user asked for, from Rokid's assistant ("send a
// WhatsApp to Mom saying I'm on my way") or from "New message" ("Mom, I'm
// on my way"). Words come from speech-to-text, so it is forgiving:
// "whats app", "what's up" for WhatsApp, "mum" for Mom (the bridge matches
// names loosely). Nothing is ever sent from here: the page shows who and
// what, and sends only on a tap. Test: node lib/intent.test.mjs
//
// parseRequest(text) returns one of:
//   { kind: 'open' }                       just open the app
//   { kind: 'read', name }                 read messages (from name, if said)
//   { kind: 'send', options: [{ name, text }] }
//       who to message and what; several options when the words could be
//       split more than one way ("tell john tan I'm late"), best guess first.
//       text may be '' ("message Mom"): then the page asks for it.

const APP = '(?:whats ?app|what ?s ?app|whatsapp|watsapp|whatsap|what ?s ?up)';

function clean(text) {
  return String(text || '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function tidyText(text) {
  const t = clean(text).replace(/^[,:;.\-\s]+/, '');
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

function tidyName(name) {
  return clean(name)
    .replace(new RegExp(`\\s+(?:on|via|through|in|using|by) ${APP}$`, 'i'), '')
    .replace(/^(?:my|the)\s+/i, '')
    .replace(/[,:;.!?]+$/, '')
    .trim();
}

// Lead-ins that come before the request itself.
const LEAD_IN = /^(?:(?:hey|hi|ok|okay) rokid[,\s]*)?(?:(?:please|can you|could you|would you|i want to|i'd like to|go ahead and)\s+)*/i;

const SEND_VERB = new RegExp(
  '^(?:send\\s+(?:a\\s+|an\\s+)?(?:' + APP + '\\s+)?(?:message|text|msg|note|reply)?\\s*to|' +
  APP + '(?:\\s+to)?|message|text|tell|reply\\s+to|write\\s+to|send)\\s+',
  'i',
);

// Words that end the name and start the message.
const SPLIT = /\s*[,:]\s*|\s+(?:saying|that says|which says|to say|and say|and tell (?:him|her|them)|say|telling (?:him|her|them)|that|with)\s+/i;

const READ = new RegExp(
  '^(?:read|check|show|open|any|get|what(?:\\s+are|\\s*\'?s)?|do i have|have i got|see)\\b.*\\b(?:messages?|chats?|' + APP + '|texts?)\\b',
  'i',
);

const OPEN_ONLY = new RegExp(`^(?:open|start|launch|use)?\\s*${APP}(?:\\s+bot)?[.!]?$`, 'i');

export function parseRequest(raw) {
  const text = clean(raw).replace(LEAD_IN, '');
  if (!text || OPEN_ONLY.test(text)) return { kind: 'open' };

  if (READ.test(text) && !SEND_VERB.test(text)) {
    const from = text.match(/\b(?:from|with|by)\s+(.+?)(?:\s+(?:on|in) \S+)?[.?!]?$/i);
    return { kind: 'read', name: from ? tidyName(from[1]) : '' };
  }

  // "send I'm late to Mom"
  const sendTo = text.match(new RegExp(`^send\\s+(.+?)\\s+to\\s+(\\S+(?:\\s\\S+)?)(?:\\s+(?:on|via) ${APP})?[.!]?$`, 'i'));
  const verb = text.match(SEND_VERB);
  if (!verb) {
    // No verb: "Mom, I'm on my way" (what "New message" expects).
    return splitNameAndText(text);
  }
  const rest = text.slice(verb[0].length);
  const result = splitNameAndText(rest);
  if (sendTo && !/^(?:a|an)\s/i.test(sendTo[1]) && !SPLIT.test(rest)) {
    result.options.unshift({ name: tidyName(sendTo[2]), text: tidyText(sendTo[1]) });
  }
  return result;
}

// "mom saying I'm late" → name "mom", text "I'm late". Without a split word
// ("john tan I'm late") the name is one or two words: both are offered.
function splitNameAndText(rest) {
  const m = rest.match(SPLIT);
  if (m) {
    const name = tidyName(rest.slice(0, m.index));
    const text = tidyText(rest.slice(m.index + m[0].length));
    if (name) return { kind: 'send', options: [{ name, text }] };
  }
  const words = rest.split(' ').filter(Boolean);
  const options = [];
  if (words.length) options.push({ name: tidyName(words[0]), text: tidyText(words.slice(1).join(' ')) });
  if (words.length > 2) options.push({ name: tidyName(words.slice(0, 2).join(' ')), text: tidyText(words.slice(2).join(' ')) });
  return { kind: 'send', options: options.filter((o) => o.name) };
}
