// Fuzzy contact matching for "message Mom …": spoken names come from
// speech-to-text, so "mum", "jon" or "sara" should still find
// "Mom", "John" and "Sarah". Plain functions so they can be tested
// (node match.test.mjs).

// Lowercase, no accents, no punctuation, single spaces.
export function normalize(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Edit distance where swapping two neighbouring letters ("jhon") counts as one.
export function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Close enough for a misheard word: up to a third of its letters off
// (at least one), and the first letter the same or close.
function wordScore(query, word) {
  if (word === query) return 1;
  if (query.length >= 2 && word.startsWith(query)) return 0.85;
  const dist = editDistance(query, word);
  const allowed = Math.max(1, Math.floor(Math.max(query.length, word.length) / 3));
  if (dist > allowed) return 0;
  return 0.75 * (1 - dist / Math.max(query.length, word.length));
}

// Score 0..1 of a spoken query against one name.
export function nameScore(query, name) {
  const q = normalize(query);
  const n = normalize(name);
  if (!q || !n) return 0;
  if (q === n) return 1;
  if (n.startsWith(q + ' ') || n.startsWith(q)) return 0.9;
  const qWords = q.split(' ');
  const nWords = n.split(' ');
  // Every spoken word must match some word of the name.
  let total = 0;
  for (const qw of qWords) {
    let best = 0;
    for (const nw of nWords) best = Math.max(best, wordScore(qw, nw));
    if (!best) return n.includes(q) ? 0.6 : 0;
    total += best;
  }
  // A one-word query matching the first name ranks above a later word.
  const firstBonus = wordScore(qWords[0], nWords[0]) ? 0.05 : 0;
  return Math.min(0.89, (total / qWords.length) * 0.85 + firstBonus);
}

// Common spoken stand-ins for how people are saved in contacts.
const ALIASES = {
  mom: ['mum', 'mommy', 'mummy', 'mother', 'ma', 'mama', 'mamma'],
  dad: ['daddy', 'father', 'papa', 'pa'],
  wife: ['wifey'],
  husband: ['hubby'],
};

function aliasesOf(query) {
  const q = normalize(query);
  for (const [key, list] of Object.entries(ALIASES)) {
    if (q === key || list.includes(q)) return [key, ...list].filter((a) => a !== q);
  }
  return [];
}

// candidates: [{ id, names: [string], t (last chat, ms) }]. Returns the best
// matches, best first: [{ id, name, score }], name being the matching name.
export function matchContacts(query, candidates, limit = 5) {
  const queries = [query, ...aliasesOf(query)];
  const now = Date.now();
  const scored = [];
  for (const c of candidates) {
    let best = 0;
    let bestName = '';
    for (const name of c.names) {
      if (!name) continue;
      for (const [i, q] of queries.entries()) {
        // An alias ("mum" for "Mom") counts slightly less than the words said.
        const s = nameScore(q, name) * (i ? 0.95 : 1);
        if (s > best) {
          best = s;
          bestName = name;
        }
      }
    }
    if (best < 0.4) continue;
    // Recent chats break near-ties: up to +0.05 for this week.
    const days = c.t ? (now - c.t) / 86400000 : 365;
    const recency = Math.max(0, 0.05 * (1 - days / 7));
    scored.push({ id: c.id, name: bestName, score: Math.round((best + recency) * 1000) / 1000 });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
