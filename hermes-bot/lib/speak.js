// Reads text aloud and calls onDone once playback has finished, so the page
// can start listening again without the mic hearing the reply. AIUI exposes no
// end event for speechSynthesis.speak(), so this plays through a
// SpeechAudioPlayer and polls its state, with a length-based timer as backup.
// Returns stop(), which ends playback early without calling onDone.

const POLL_MS = 250;

// Generous upper bound on reading time, by script: Latin text reads at about
// 13 characters a second, Chinese/Japanese/Korean at about 4. Used until the
// player reports the real duration.
function maxDurationMs(text) {
  let seconds = 0;
  for (const ch of text) seconds += ch.charCodeAt(0) < 0x2e80 ? 1 / 13 : 1 / 4;
  return Math.max(4000, seconds * 1000 * 1.25 + 3000);
}

export function speakThen(text, onDone) {
  let finished = false;
  let player = null;
  let poll = null;
  let backup = null;

  function finish(callDone) {
    if (finished) return;
    finished = true;
    // Ink throws on clearInterval/clearTimeout(null).
    if (poll) clearInterval(poll);
    if (backup) clearTimeout(backup);
    if (player) {
      try {
        player.stop();
        player.destroy();
      } catch (e) {}
    }
    if (callDone) onDone();
  }

  backup = setTimeout(() => finish(true), maxDurationMs(text));

  (async () => {
    try {
      const task = await speechSynthesis.synthesize(new SpeechSynthesisUtterance(text));
      if (finished) return;
      let generated = false;
      task.onend = () => {
        generated = true;
      };
      task.onerror = () => finish(true);
      player = new SpeechAudioPlayer(task);
      player.play();

      let started = false;
      let rearmed = false;
      poll = setInterval(() => {
        const position = player.currentTime || 0;
        const length = player.duration || 0;
        // Once the real length is known, the backup timer follows it.
        if (!rearmed && generated && length > 0) {
          rearmed = true;
          if (backup) clearTimeout(backup);
          backup = setTimeout(() => finish(true), Math.max(0, (length - position) * 1000) + 3000);
        }
        if (!player.paused || position > 0) started = true;
        const atEnd = length > 0 && position >= length - 0.15;
        if (started && generated && (player.paused || atEnd)) finish(true);
      }, POLL_MS);
    } catch (e) {
      // No independent player here: fall back to the shared one and the timer.
      if (finished) return;
      speechSynthesis.speak(new SpeechSynthesisUtterance(text), 'immediate');
    }
  })();

  return () => finish(false);
}
