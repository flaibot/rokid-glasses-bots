// Strict, bounded visual payloads. Never execute model output or fetch URLs.
// Wire format: <visual>{"type":"formula","tex":"E=mc^2"}</visual>
// or <visual>{"type":"chart","points":[1,2,3]}</visual>.
const MAX_PAYLOAD = 4096;

export function splitVisual(reply) {
  const source = String(reply || '');
  const start = source.indexOf('<visual>');
  if (start < 0) return { text: source, visual: null };
  const end = source.indexOf('</visual>', start + 8);
  // Do not speak or show a partial JSON packet while it streams.
  if (end < 0) return { text: source.slice(0, start).trim(), visual: null };
  const raw = source.slice(start + 8, end);
  const text = (source.slice(0, start) + source.slice(end + 9)).trim();
  if (raw.length > MAX_PAYLOAD) return { text, visual: null };
  try {
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { text, visual: null };
    if (p.type === 'formula' && typeof p.tex === 'string' && p.tex.trim().length > 0 && p.tex.length <= 200) {
      return { text, visual: { type: 'formula', tex: p.tex.trim() } };
    }
    const finite = n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e9;
    if (p.type === 'chart' && Array.isArray(p.points) && p.points.length >= 2 && p.points.length <= 30) {
      const points = p.points.map((point, index) => typeof point === 'number'
        ? { x: index, value: point } : { x: point?.x, value: point?.y });
      if (points.every(point => finite(point.x) && finite(point.value)))
        return { text, visual: { type: 'chart', points, caption: typeof p.caption === 'string' ? p.caption.slice(0, 60) : '' } };
    }
  } catch (_) { /* invalid payload is not displayed */ }
  return { text, visual: null };
}
