// Recent exchanges, kept on the glasses (localStorage) so Hermes Bot opens on
// the last one and can browse and resume past conversations without a
// network call. Hermes keeps the full history server-side per conversation
// name; this is only what the glasses show.

const STORAGE_KEY = 'hermes.history';
const MAX_CONVERSATIONS = 10;
const MAX_TURNS = 30;
const MAX_ANSWER = 4000;

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return Array.isArray(data.conversations) ? data.conversations : [];
  } catch (e) {
    return [];
  }
}

function save(conversations) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ conversations }));
  } catch (e) {}
}

// Newest first: [{ id, title, updated, turns: [{ q, a, at }] }]
export function conversations() {
  return load().sort((a, b) => b.updated - a.updated);
}

export function turnsOf(id) {
  return load().find((c) => c.id === id)?.turns || [];
}

export function addTurn(id, q, a) {
  const all = load();
  let conv = all.find((c) => c.id === id);
  if (!conv) {
    conv = { id, title: q.slice(0, 60), updated: 0, turns: [] };
    all.push(conv);
  }
  conv.turns = conv.turns.concat({ q, a: String(a).slice(0, MAX_ANSWER), at: Date.now() }).slice(-MAX_TURNS);
  conv.updated = Date.now();
  save(all.sort((x, y) => y.updated - x.updated).slice(0, MAX_CONVERSATIONS));
}

// "5m", "3h", "2d" since a timestamp.
export function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
