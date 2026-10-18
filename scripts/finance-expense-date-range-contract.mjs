import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = server.indexOf("if (pathname === '/api/expenses' && req.method === 'GET')");
const end = server.indexOf("if (pathname === '/api/expenses' && req.method === 'POST')", start);
assert.ok(start >= 0 && end > start, 'expense GET route is present');
const route = server.slice(start, end);

assert.match(route, /const from = url\.searchParams\.get\('from'\) \|\| '1900-01-01'; const to = url\.searchParams\.get\('to'\) \|\| '2999-12-31';/,
  'expense filters retain their documented all-time defaults');
assert.match(route, /!isValidIsoDate\(from\) \|\| !isValidIsoDate\(to\) \|\| to < from/,
  'expense filters reject malformed dates and reversed ranges before database queries');
assert.match(route, /json\(res, 400, \{ error: 'invalid_expense_date_range' \}\)/,
  'invalid expense date range is a client validation error');
assert.ok(route.indexOf('invalid_expense_date_range') < route.indexOf('repositories?.pool'),
  'invalid date ranges never reach PostgreSQL date casts');

console.log('FINANCE EXPENSE DATE RANGE CONTRACT: PASS');
