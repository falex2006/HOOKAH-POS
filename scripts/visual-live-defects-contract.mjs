import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const card = readFileSync(new URL('../staff-admin-card.js', import.meta.url), 'utf8');
const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

assert.match(card, /addEventListener\('hashchange',[\s\S]*?\.staff-admin-modal[\s\S]*?\.remove\(\)/,
  'staff profile modal closes when admin hash navigation replaces its page');
assert.match(card, /let navigationEpoch=0/);
assert.match(card, /const requestEpoch=navigationEpoch[\s\S]*?if\(requestEpoch!==navigationEpoch\)return/,
  'late staff-profile responses cannot reopen a modal after navigation');
assert.match(card, /hashchange',\(\)=>\{navigationEpoch\+=1/,
  'hash navigation invalidates pending staff-profile requests');
assert.match(portal, /function updateAdminSectionTitle\(\)[\s\S]*?document\.title\s*=/,
  'admin hash navigation keeps browser document title aligned with visible section');
assert.match(portal, /entry\.ingredientId \? ` \[\$\{entry\.ingredientId\}\]` : ''/,
  'legacy recipe ingredient lines omit an empty bracket token');
assert.match(portal, /className = 'department-editor'/,
  'warehouse department forms use their dedicated responsive layout');
assert.match(portal, /<span>Название цеха<\/span>/);
assert.match(portal, /<span>Родительский цех<\/span>/);
assert.match(css, /\.department-editor input,\.department-editor select\{[^}]*min-height:46px/,
  'warehouse department fields match the shared input height');
assert.match(css, /@media\(max-width:600px\)\{\.department-editor\{grid-template-columns:minmax\(0,1fr\)\}/,
  'warehouse department form collapses to one column on narrow devices');
assert.match(portal, /class="panel wide reservation-panel"><div class="panel-head"><div class="reservation-list-heading"><h2[^>]*>[^<]+<\/h2><small[^>]*>[^<]+<\/small><\/div><div class="reservation-filters"><label for="reservation-filter">Поиск<input[^>]+id="reservation-filter"[^>]*><\/label><label for="reservation-list-date">Дата бронирования<input[^>]+id="reservation-list-date"/,
  'reservation heading and labelled search/date controls keep a predictable semantic order');
assert.match(css, /\.reservation-panel \.panel-head\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/,
  'reservation heading and filters must not compete for one narrow flex row');
assert.match(css, /\.reservation-list>\.empty\{display:flex;flex-direction:column;align-items:center;[^}]*gap:8px/,
  'reservation empty-state text and action must be stacked with clear spacing');
assert.match(css, /@media\(max-width:650px\)\{\.velora-theme \.reservation-panel \.panel-head\{grid-template-columns:minmax\(0,1fr\)\}\}/,
  'reservation filters must stack at phone widths');
assert.ok(portal.includes('<label class="client-filter-field">Период<select id="clients-period"'),
  'guest period control must have a visible label');
for (const caption of ['Поиск', 'Статус', 'Сортировка']) {
  assert.ok(portal.includes(`'${caption}'`), `guest filter must have a visible ${caption} label`);
}
assert.match(css, /body\[data-page="clients"\] \.clients-toolbar\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/,
  'guest search, period, status, and sorting must share one aligned desktop row');
assert.match(css, /@media\(max-width:1100px\)\{body\[data-page="clients"\] \.clients-toolbar\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/,
  'guest filters must use a balanced two-column tablet layout');
assert.match(css, /@media\(max-width:650px\)\{body\[data-page="clients"\] \.clients-toolbar\{grid-template-columns:minmax\(0,1fr\)\}\}/,
  'guest filters must stack on phone widths');

console.log('VISUAL LIVE DEFECTS CONTRACT: PASS (admin overlay/title, legacy recipe refs, department fields, reservation and guest-filter layouts)');
