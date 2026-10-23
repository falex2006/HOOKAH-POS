import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [portal, styles, visualRules] = await Promise.all([
  readFile(new URL('../portal.js', import.meta.url), 'utf8'),
  readFile(new URL('../style.css', import.meta.url), 'utf8'),
  readFile(new URL('../VISUAL_PAGE_RULES.md', import.meta.url), 'utf8'),
]);

assert.match(portal, /<nav class="settings-category-grid" aria-label="Категории настроек">/u, 'settings links retain a named navigation landmark');
assert.match(portal, /href="#company" data-settings-role="owner-admin"/u, 'company destination and owner/admin restriction remain');
assert.match(portal, /href="#audit" data-settings-role="owner-admin"/u, 'audit destination and owner/admin restriction remain');
assert.match(portal, /href="\/network" data-settings-role="owner-admin"/u, 'network remains a separate route');
assert.match(portal, /if \(link\.getAttribute\('href'\) === window\.location\.hash\) link\.setAttribute\('aria-current', 'page'\)/u, 'current settings subsection receives aria-current');
assert.match(portal, /setDashboardPanelVisibility\('\.settings-hub', focusedView !== '#lock-security'\)/u, 'security subsection keeps existing hidden-navigation behavior');

assert.match(styles, /#page-content \.settings-hub-head\{display:none\}/u, 'repeated settings intro is hidden');
assert.match(styles, /#page-content \.settings-category-card\{[^}]*min-height:44px/u, 'compact links retain 44px touch targets');
assert.match(styles, /#page-content \.settings-category-card small\{display:none\}/u, 'repeated card descriptions are hidden');
assert.match(styles, /#page-content \.settings-category-card\[aria-current="page"\]/u, 'active link has a distinct visual state');
assert.match(styles, /@media\(max-width:700px\)\{#page-content \.settings-category-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/u, 'narrow settings use a two-column grid');
assert.match(styles, /@media\(max-width:360px\)\{#page-content \.settings-category-grid\{grid-template-columns:minmax\(0,1fr\)\}\}/u, 'very narrow settings use a readable single column');
assert.match(visualRules, /внутренняя навигация разделов настроек остаётся компактной/iu, 'visual contract documents the shared settings navigation');

console.log('SETTINGS HUB NAVIGATION CONTRACT: PASS (routes, role gates, active state, compact responsive layout)');
