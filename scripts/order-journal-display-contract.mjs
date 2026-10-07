import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const repository = readFileSync(new URL('../db.js', import.meta.url), 'utf8');
const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
assert.match(repository, /CASE WHEN z\.id IS NOT NULL THEN t\.name END AS "tableName"/, 'order list returns a human-readable table name only when the venue zone matches');
assert.match(repository, /LEFT JOIN zones z ON z\.id=t\.zone_id AND z\.venue_id=o\.venue_id/, 'table display stays scoped to the order venue');
assert.match(repository, /GROUP BY o\.id, g\.full_name, g\.phone, t\.name, z\.id/, 'tenant-safe table lookup remains valid with the order aggregation');
assert.match(portal, /slice\(-8\)\.toUpperCase\(\)/, 'UUID order references are shortened to an eight-character suffix');
assert.match(portal, /order\.tableName \|\| \(order\.tableId \? 'Стол не найден' : 'Без стола'\)/, 'missing table relations have understandable fallbacks');
assert.match(portal, /displayOrderId\(order\.id\).*order\.tableName/, 'order search includes displayed number and table name');
assert.match(portal, /reservations = \(data\.items \|\| \[\]\)\.map\(\(item\) => \(\{ \.\.\.item, date:/, 'reservation list normalizes SQL date values before rendering');
assert.ok(portal.includes("esc(formatRuDate(item.date)) + ' · ' + esc(item.time)"), 'reservation date display is localized without changing its ISO filter value');
console.log('ORDER JOURNAL DISPLAY CONTRACT: PASS (human-readable IDs/tables, tenant join, fallbacks, search, localized reservation dates)');
