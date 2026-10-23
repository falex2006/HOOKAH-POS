import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const portalFiles = ['../portal.js', '../dist/portal.js'];
const styleFiles = ['../style.css', '../dist/style.css'];
const renderers = portalFiles.map((path) => {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const start = source.indexOf("if (hasPortalPermission('diagnostics') && window.location.hash === '#diagnostics')");
  const end = source.indexOf('\n  const floorEditor =', start);
  assert.ok(start >= 0 && end > start, `diagnostics renderer exists in ${path}`);
  return source.slice(start, end);
});
assert.equal(renderers[0], renderers[1], 'diagnostics renderer is synchronized to dist');
assert.match(renderers[0], /telegramEnabled \? 'is-connected' : 'is-pending'/);
assert.match(renderers[0], /data\.telegram\?\.status === 'planned' \? 'В подготовке' : 'Не подключено'/);
assert.match(renderers[0], /telegramEnabled \? 'circle-check' : 'clock'/);

for (const path of styleFiles) {
  const css = readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.match(css, /#diagnostics \.audit-icon\.is-pending\{background:var\(--ui-raised\);color:var\(--ui-text-secondary\)\}/, path);
  assert.match(css, /#diagnostics \.audit-list\{grid-template-columns:minmax\(0,1fr\)\}/, path);
}
console.log('ADMIN DIAGNOSTICS PRESENTATION CONTRACT: PASS (planned neutral, connected success, single-column list, source/dist parity)');
