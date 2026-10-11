import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const dist = readFileSync(new URL('../dist/style.css', import.meta.url), 'utf8');
const platformCss = readFileSync(new URL('../platform.css', import.meta.url), 'utf8');
const catalog = readFileSync(new URL('../docs/design/UNIFIED_UI_2026-10-09/COMPONENT_CATALOG.md', import.meta.url), 'utf8');
const exceptions = readFileSync(new URL('../docs/design/UNIFIED_UI_2026-10-09/EXCEPTIONS.md', import.meta.url), 'utf8');

assert.equal(dist, source, 'dist/style.css must mirror style.css byte-for-byte');
assert.match(source, /\.loading::after,\[aria-busy="true"\]::after\s*\{[^}]*animation:territory-spin/);
assert.match(source, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.loading::after,\[aria-busy="true"\]::after\s*\{animation:none\}\s*\}/);
assert.match(source, /\.ui-motion-reduced\s+:is\(\.loading,\[aria-busy="true"\]\)::after\s*\{animation:none\}/);

// Inventory stays a live anchored legacy editor; only remove its sweep after its C11 migration.
assert.match(source, /\.velora-theme \.inventory-item-modal\s*\{[^}]*animation:\s*inventory-modal-border-sweep/);
assert.match(source, /\.velora-theme \.modal\.open :is\(\.action-box,\.payment-box,\.custom-role-editor-box,\.catalog-box\)\s*\{animation:inventory-modal-border-sweep 8s linear infinite\}/);
assert.doesNotMatch(source, /\.velora-theme \.platform-modal:not\(\[hidden\]\) \.platform-modal-panel\s*\{[^}]*animation:/);
assert.match(platformCss, /body\.platform-page \.platform-modal:not\(\[hidden\]\) \.platform-modal-panel\s*\{background:var\(--ui-panel\);animation:none;outline:1px solid var\(--ui-border-control\)\}/);
assert.match(catalog, /UI-08\.3.*reduced-motion/s);
assert.match(catalog, /platform modal не получает animation declaration/);
assert.match(exceptions, /EX-05.*anchored inventory\/legacy modals сохраняют свои состояния.*platform modal анимацию не наследует/s);

console.log('UI-08.3 effects/cascade contract: PASS');
