// Connection settings live on the glasses (localStorage), set by scanning the
// QR code from rokid-utils/hermes-bot-qr, so no key is packed in the .aix.

const STORAGE_KEY = 'hermes.settings';

const DEFAULTS = {
  HERMES_URL: '',
  HERMES_KEY: '',
  CONVERSATION: 'rokid-glasses',
  MODEL: 'glasses',
  // "smart mode" by voice: slower, more careful model with thinking on.
  SMART: false,
  SPEAK_REPLIES: true,
  // Listen again as soon as a reply has been read out.
  KEEP_LISTENING: true,
};

// Bump to start every pair of glasses on a fresh Hermes conversation.
const SETTINGS_VERSION = 2;

export function newConversation() {
  return `rokid-glasses-${Date.now()}`;
}

export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch (e) {}
  const settings = { ...DEFAULTS, ...saved };
  if (saved.v !== SETTINGS_VERSION) {
    // v1 kept one conversation forever, which grew long and slow.
    settings.CONVERSATION = newConversation();
    settings.v = SETTINGS_VERSION;
    if (saved.HERMES_KEY) {
      try {
        saveSettings(settings);
      } catch (e) {}
    }
  }
  return settings;
}

export function saveSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function isConfigured(settings) {
  return Boolean(settings.HERMES_URL && settings.HERMES_KEY);
}

// QR payload: {"hermes": "<base url>", "key": "<API_SERVER_KEY>"}.
// Returns new settings, or null when the code isn't a Hermes setup code.
export function settingsFromQr(text, current) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (e) {
    return null;
  }
  const url = typeof payload?.hermes === 'string' ? payload.hermes.trim().replace(/\/+$/, '') : '';
  const key = typeof payload?.key === 'string' ? payload.key.trim() : '';
  if (!/^https?:\/\//.test(url) || !key) return null;
  return {
    ...current,
    HERMES_URL: url,
    HERMES_KEY: key,
    CONVERSATION: typeof payload.conversation === 'string' ? payload.conversation : current.CONVERSATION,
    MODEL: typeof payload.model === 'string' ? payload.model : current.MODEL,
  };
}
