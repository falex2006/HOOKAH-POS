import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = portal.indexOf("const draw = (query = '') => { const rows = document.querySelector('#inventory-rows');");
const end = portal.indexOf('; };', start);
assert.ok(start >= 0 && end > start, 'stock row renderer must be discoverable');
const rendererSource = portal.slice(start, end + 4);
const rows = { innerHTML: '' };
const document = { querySelector: (selector) => selector === '#inventory-rows' ? rows : null };
const items = [
  { id: 'untracked-empty', name: 'Вода', category: 'Напитки', department: 'Бар', unit: 'л', onHand: 0, minLevel: 0, cost: 0 },
  { id: 'tracked-empty', name: 'Сироп', category: 'Сиропы', department: 'Бар', unit: 'л', onHand: 0, minLevel: 2, cost: 0 },
  { id: 'tracked-ok', name: 'Лёд', category: 'Заготовки', department: 'Кухня', unit: 'кг', onHand: 5, minLevel: 2, cost: 0 },
];
new Function('allItems', 'canWriteInventory', 'document', 'normalizeInventorySearch', 'esc', 'displayName', 'money', 'alcoholProfileById', 'alcoholItemLabel', `${rendererSource}; draw(); return document.querySelector('#inventory-rows').innerHTML;`)(items, false, document, (value) => String(value || '').toLocaleLowerCase('ru-RU'), String, String, (value) => `${Number(value || 0)} ₽`, () => null, () => '');
assert.match(rows.innerHTML, /Порог не задан/, 'zero minimum explains that no replenishment threshold is configured');
assert.match(rows.innerHTML, /data-label="Порог пополнения"/, 'mobile row label matches the threshold column heading');
assert.match(rows.innerHTML, /Нужно пополнить/, 'positive minimum plus low stock must request replenishment');
assert.match(rows.innerHTML, /В норме/, 'positive minimum plus sufficient stock must remain normal');

const lowStockMatcher = server.match(/const isBelowInventoryMinimum = ([^;]+);/);
assert.ok(lowStockMatcher, 'server must share an explicit stock-monitoring rule');
const isBelowMinimum = new Function(`return (${lowStockMatcher[1]})`)();
assert.equal(isBelowMinimum({ onHand: 0, minLevel: 0 }), false, 'disabled monitoring must not count as low stock');
assert.equal(isBelowMinimum({ onHand: 0, minLevel: 1 }), true, 'tracked empty stock must count as low stock');
assert.equal(isBelowMinimum({ onHand: 2, minLevel: 2 }), true, 'stock at the threshold must prompt replenishment');
assert.match(server, /i\.min_stock > 0 AND COALESCE\(b\.on_hand,0\) <= i\.min_stock/, 'PostgreSQL dashboard metrics must derive stock from the movement ledger and compare the persisted minimum');
assert.match(server, /FROM stock_movements WHERE venue_id=\$1 GROUP BY venue_id,ingredient_id/, 'PostgreSQL dashboard metric must aggregate only the selected venue stock ledger');
assert.match(portal, /Number\(x\.minLevel \|\| 0\) > 0 && Number\(x\.onHand \|\| 0\) <= Number\(x\.minLevel \|\| 0\)/, 'demo dashboard metric must exclude disabled monitoring');

console.log('INVENTORY STOCK STATUS QA: PASS (row label, API/KPI rule, zero minimum, threshold and sufficient stock)');
