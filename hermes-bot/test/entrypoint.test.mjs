import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('only the real conversation page is exposed to AIUI', () => {
  const manifest = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.pages, ['pages/index/index']);
  const page = readFileSync(new URL('../pages/index/index.ink', import.meta.url), 'utf8');
  assert.match(page, /v\$\{VERSION\}-V5N/);
  assert.match(page, /askHermesTurn/);
  assert.match(page, /statusView/);
  assert.doesNotMatch(page, /<text class="statusbar"/);
  assert.match(page, /<canvas[^>]+ink:if="\{\{visualType === 'image'/);
});
