// Settings and HTTP client for the whatsapp-bridge on the Mac
// (whatsapp-bridge/server.mjs). Settings come from the setup QR code
// (rokid-utils/whatsapp-bot-qr) and live in localStorage.

const STORAGE_KEY = 'whatsapp.settings';

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

// QR payload: {"whatsapp": "<bridge url>", "key": "<token>"}. Null if not ours.
export function settingsFromQr(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (e) {
    return null;
  }
  const url = typeof payload?.whatsapp === 'string' ? payload.whatsapp.trim().replace(/\/+$/, '') : '';
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

// "now", "5m", "3h", "2d" since a timestamp.
export function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// "14:05" today, else "3d".
export function when(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (Date.now() - ms < 86400000 && d.getDate() === new Date().getDate()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return ago(ms);
}
