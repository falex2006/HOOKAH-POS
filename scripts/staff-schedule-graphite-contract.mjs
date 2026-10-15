import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../staff-schedule-ui.css', import.meta.url), 'utf8');
const dist = readFileSync(new URL('../dist/staff-schedule-ui.css', import.meta.url), 'utf8');
assert.equal(source, dist, 'source/dist parity');
const block = source.split('/* Graphite preview:')[1]?.split('@media print{')[0];
const rounded = source.split('/* Shared rounded calendar language;')[1]?.split('/* Graphite preview:')[0];
assert.ok(rounded?.includes('@media screen{'), 'rounded geometry is screen-only');
assert.match(rounded, /\.schedule-week table\{border-spacing:4px\}/);
assert.match(rounded, /\.schedule-days>\.schedule-day-card\{[^}]*border-radius:10px/);
assert.doesNotMatch(rounded, /overflow\s*:\s*hidden|position\s*:/, 'do not clip or reset sticky scroll containers');
assert.ok(block?.includes('@media screen{'), 'screen-only palette');
for (const line of block.split('\n').filter(line => line.startsWith('body.'))) {
  assert.ok(line.startsWith('body.portal.schedule-route:not(.light-theme) .schedule-page'), 'dark calendar only');
  assert.doesNotMatch(line, /portal-sidebar|portal-header/, 'shell untouched');
}
assert.match(block, /\.schedule-kind-shift:not\(\.is-cancelled\)/);
assert.match(block, /\.schedule-entry:hover\{background:color-mix\(in srgb,var\(--ui-text-primary\) 8%,var\(--schedule-raised\)\)/);
assert.match(block, /\.is-cancelled \.schedule-entry-time\{color:var\(--ui-text-muted\)/);
console.log('GRAPHITE CONTRACT: PASS (dark/screen scope, neutral status hover, cancelled text, source/dist).');
