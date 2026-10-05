// Listens across short pauses. The glasses' recognizer ends a segment at the
// first pause, which cuts people off mid-thought. Here a segment that
// ends is followed by a new one, and the text is joined; listening finishes
// only after PAUSE_MS without new words, on stop(), or after MAX_MS.
//
// Shared by Hermes Bot, Claude Bot and WhatsApp Bot (same file in each lib/;
// keep in sync).
// If the host refuses a restart, whatever was heard is used.

export const PAUSE_MS = 3000;
const MAX_MS = 90 * 1000;
// After stop(), how long to wait for the host's "end" event before finishing
// anyway. Never rely on it: on the glasses it did not always arrive, and the
// app then sat on "Listening…" without sending (0.8.0/0.9.0).
const STOP_GRACE_MS = 1200;

function clear(timer) {
  if (timer) clearTimeout(timer);
}

// handlers: onText(textSoFar), onDone(finalText), onError(message).
// Returns { stop(), abort() }: stop() finishes with what was heard, abort()
// drops it.
export function listen(handlers, options = {}) {
  const pauseMs = options.pauseMs || PAUSE_MS;
  const started = Date.now();
  const segments = []; // finished segments
  let current = ''; // text of the running segment
  let recognition = null;
  let pauseTimer = null;
  let maxTimer = null;
  let finished = false;
  let stopping = false;
  let stopTimer = null;

  const text = () => segments.concat(current ? [current] : []).join(' ').replace(/\s+/g, ' ').trim();

  function finish(useText) {
    if (finished) return;
    finished = true;
    clear(pauseTimer);
    clear(maxTimer);
    clear(stopTimer);
    const r = recognition;
    recognition = null;
    if (r) {
      try {
        r.abort();
      } catch (e) {}
    }
    if (useText) handlers.onDone(text());
  }

  // Asks the host to stop (so it can deliver the last words), and finishes
  // when "end" arrives or after STOP_GRACE_MS, whichever comes first.
  function requestStop() {
    if (finished) return;
    stopping = true;
    clear(pauseTimer);
    if (recognition) {
      try {
        recognition.stop();
      } catch (e) {
        finish(true);
        return;
      }
      clear(stopTimer);
      stopTimer = setTimeout(() => finish(true), STOP_GRACE_MS);
      return;
    }
    finish(true);
  }

  // No new words for pauseMs: done (but never before the first words).
  function armPause() {
    clear(pauseTimer);
    pauseTimer = setTimeout(() => {
      pauseTimer = null;
      if (text()) requestStop();
    }, pauseMs);
  }

  function startSegment() {
    if (finished) return;
    const r = new SpeechRecognition();
    // Host defaults otherwise (continuous off): a segment ends at a pause and
    // the restart in onend joins the next one.
    r.interimResults = true;
    recognition = r;
    current = '';
    r.onresult = (event) => {
      if (recognition !== r) return;
      // Join every result of this segment (continuous hosts send several).
      let heard = '';
      for (let i = 0; i < event.results.length; i++) heard += (event.results[i][0]?.transcript || '') + ' ';
      current = heard.trim() || event.results[event.resultIndex]?.[0]?.transcript || current;
      handlers.onText(text());
      armPause();
    };
    r.onerror = (event) => {
      if (recognition !== r) return;
      // "no-speech" after some words just means the pause was long: finish.
      if (text()) finish(true);
      else {
        finished = true;
        clear(pauseTimer);
        clear(maxTimer);
        recognition = null;
        handlers.onError(event.message || event.error || 'Mic error');
      }
    };
    r.onend = () => {
      if (recognition !== r) return;
      recognition = null;
      if (current) segments.push(current);
      current = '';
      // Nothing heard at all: give up as before ("did not catch that").
      if (stopping || !text() || Date.now() - started > MAX_MS) {
        finish(true);
        return;
      }
      // The host ended the segment at a pause: keep listening.
      try {
        startSegment();
      } catch (e) {
        finish(true);
      }
    };
    r.start();
  }

  try {
    startSegment();
  } catch (e) {
    finished = true;
    handlers.onError(e.message || 'Mic error');
  }
  maxTimer = setTimeout(() => {
    maxTimer = null;
    requestStop();
  }, MAX_MS);

  return {
    stop() {
      requestStop();
    },
    abort() {
      finish(false);
    },
  };
}
