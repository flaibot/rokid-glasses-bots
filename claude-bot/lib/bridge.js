// Settings and HTTP client for the claude-bridge on the Mac
// (claude-bridge/server.mjs). Settings come from the setup QR code
// (rokid-utils/claude-bot-qr) and live in localStorage.

const STORAGE_KEY = 'claude.settings';

export function loadSettings() {
  try {
    return { url: '', key: '', ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
  } catch (e) {
    return { url: '', key: '' };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function isConfigured(settings) {
  return Boolean(settings.url && settings.key);
}

// QR payload: {"claude": "<bridge url>", "key": "<token>"}. Null if not ours.
export function settingsFromQr(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (e) {
    return null;
  }
  const url = typeof payload?.claude === 'string' ? payload.claude.trim().replace(/\/+$/, '') : '';
  const key = typeof payload?.key === 'string' ? payload.key.trim() : '';
  if (!/^https?:\/\//.test(url) || !key) return null;
  return { url, key };
}

export async function api(settings, method, path, body) {
  const response = await fetch(settings.url + path, {
    method,
    headers: {
      Authorization: `Bearer ${settings.key}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    timeout: 20000,
  });
  let data = null;
  try {
    data = await response.json();
  } catch (e) {}
  if (!response.ok) {
    const error = new Error(data?.error || `Bridge ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

// "5m", "3h", "2d" since a timestamp.
export function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Markdown is noise on a small monochrome display.
export function plainText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .trim();
}
