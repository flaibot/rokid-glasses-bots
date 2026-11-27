// Which Hermes session a local conversation maps to.
//
// The glasses keep their own conversation list (lib/history.js), keyed by an
// id like `rokid-glasses-1758`. Hermes keeps the transcript server-side under
// a *session id*. Two different id spaces, so the mapping is stored here.
//
// Why a map and not a naming convention: a conversation created before this
// client existed was addressed on /v1/responses by its `conversation` name,
// and Hermes minted a session id for it that the glasses were never told.
// That id can only be learned from a live response (see rememberSessionId in
// lib/hermes-runs.js), so it has to be stored rather than derived.

const STORAGE_KEY = 'hermes.sessions';
// Sessions are cheap; this only bounds a localStorage entry.
const MAX_ENTRIES = 40;

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    return {};
  }
}

function save(map) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (e) {}
}

// The session id Hermes confirmed for this conversation, or null.
export function sessionIdFor(conversation) {
  const id = String(conversation || '').trim();
  if (!id) return null;
  const entry = load()[id];
  const sessionId = entry && typeof entry.id === 'string' ? entry.id.trim() : '';
  return sessionId || null;
}

export function rememberSessionId(conversation, sessionId) {
  const id = String(conversation || '').trim();
  const session = String(sessionId || '').trim();
  if (!id || !session) return null;
  const map = load();
  map[id] = { id: session, at: Date.now() };
  const entries = Object.entries(map).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0));
  save(Object.fromEntries(entries.slice(0, MAX_ENTRIES)));
  return session;
}

export function forgetSessionId(conversation) {
  const id = String(conversation || '').trim();
  if (!id) return;
  const map = load();
  if (id in map) {
    delete map[id];
    save(map);
  }
}

// A brand-new conversation has nothing server-side yet, so the client can
// name the session itself — the documented way for an external UI to
// correlate runs with its own conversation ids. Deterministic, so losing the
// map entry for a conversation this client created still resumes it.
export function derivedSessionId(conversation) {
  const id = String(conversation || '').trim();
  if (!id) return null;
  // Conservative: an id Hermes might treat as unsafe (path/header charset)
  // is slugged instead of being passed through.
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(id)) return id;
  return `rokid-${id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)}`;
}
