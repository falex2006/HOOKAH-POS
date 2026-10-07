import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isValidIsoDate } = require('../payroll.js');
const isValidIsoTimestamp = (value) => {
  if (typeof value !== 'string' || !value.trim()) return false;
  const text = value.trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return false;
  const [, year, month, day, hour, minute, second = '00', , offset] = match;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59))) return false;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return calendar.getUTCFullYear() === Number(year) && calendar.getUTCMonth() === Number(month) - 1 && calendar.getUTCDate() === Number(day) && !Number.isNaN(Date.parse(text));
};
const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf("  if (pathname === '/api/staff/schedule' && req.method === 'POST')");
const end = source.indexOf("  if (pathname === '/api/staff/time' && req.method === 'GET')", start);
assert.ok(start >= 0 && end > start, 'actual schedule POST handler must exist');
const handler = source.slice(start, end);
const employeeId = '12345678-1234-4234-8234-123456789012';
const venueId = '22345678-1234-4234-8234-123456789012';
const actorId = '32345678-1234-4234-8234-123456789012';
const base = { userId: employeeId, workDate: '2026-10-01' };
let checks = 0;

async function execute(input, { allowed = true, employeeFound = true } = {}) {
  let response;
  const queries = [];
  let bodyReads = 0;
  const context = {
    pathname: '/api/staff/schedule', req: { method: 'POST', user: { id: actorId } }, res: {}, venueDbId: venueId,
    isValidIsoDate, isValidIsoTimestamp,
    body: async () => { bodyReads++; return input; },
    json: (_, status, data) => { response = { status, data }; },
    denyUnless: (_, res, permission) => {
      assert.equal(permission, 'staff_manage', 'schedule creation remains staff_manage only');
      if (allowed) return false;
      response = { status: 403, data: { error: 'forbidden', permission } }; return true;
    },
    repositories: { pool: { query: async (sql, parameters) => {
      queries.push({ sql, parameters });
      if (/^SELECT id FROM users/.test(sql)) {
        assert.match(sql, /venue_id=\$2 AND is_active=true AND deleted_at IS NULL/, 'employee lookup stays tenant scoped and excludes inactive/deleted');
        assert.deepEqual(Array.from(parameters), [employeeId, venueId]);
        return { rows: employeeFound ? [{ id: employeeId }] : [] };
      }
      assert.match(sql, /^INSERT INTO staff_schedules/);
      assert.match(sql, /ON CONFLICT \(venue_id,user_id,work_date\) DO UPDATE/, 'one row per employee and working day');
      assert.deepEqual(Array.from(parameters).slice(0, 3), [venueId, employeeId, input.workDate]);
      assert.equal(parameters[6], actorId, 'author identity is preserved');
      return { rows: [{ id: 'synthetic-schedule', planned_start: parameters[3], planned_end: parameters[4] }] };
    } } },
  };
  await vm.runInNewContext(`(async () => { ${handler} })()`, context, { timeout: 1000 });
  assert.ok(response, 'actual handler returns a response');
  return { ...response, queries, bodyReads };
}

async function reject(input, error, label) {
  const result = await execute(input);
  assert.equal(result.status, 400, `${label}: invalid data must fail before SQL`);
  assert.equal(result.data.error, error, label);
  assert.deepEqual(Object.keys(result.data), ['error'], `${label}: no SQL detail or sensitive response fields`);
  assert.equal(result.queries.length, 0, `${label}: invalid data must not call PostgreSQL`);
  checks++;
}

for (const workDate of ['2026-02-31', '2025-02-29', '2026-13-01', '2026-00-01', '01.10.2026', '2026-10-1', '']) {
  await reject({ ...base, workDate }, 'invalid_schedule_entry', 'invalid real working date');
}
await reject({ ...base, userId: '' }, 'invalid_schedule_entry', 'employee is mandatory');
await reject({ ...base, userId: 'another-tenant-uuid-not-valid' }, 'invalid_schedule_employee', 'invalid employee UUID');

const invalidTimes = ['12:00', '2026-10-01T12:00', '2026-02-31T12:00:00Z', '2026-10-01T24:00:00Z', '2026-10-01T12:60:00Z', '2026-10-01T12:00:60Z', '2026-10-01T12:00:00+25:00', '2026-10-01T12:00:00+05:60', 'nonsense', 0, false, true, [], {}];
for (const value of invalidTimes) {
  await reject({ ...base, plannedStart: value }, 'invalid_schedule_time', 'invalid planned start');
  await reject({ ...base, plannedEnd: value }, 'invalid_schedule_time', 'invalid planned end');
}
for (const [plannedStart, plannedEnd] of [
  ['2026-10-01T12:00:00Z', '2026-10-01T11:00:00Z'],
  ['2026-10-01T12:00:00Z', '2026-10-01T12:00:00Z'],
  ['2026-10-01T17:00:00+05:00', '2026-10-01T12:00:00Z'],
]) await reject({ ...base, plannedStart, plannedEnd }, 'invalid_schedule_time', 'end must be strictly later by instant');

for (const [plannedStart, plannedEnd] of [
  ['2026-10-01T12:00:00Z', '2026-10-01T20:00:00Z'],
  ['2026-10-01T20:00:00+05:00', '2026-10-02T04:00:00+05:00'],
  ['2026-10-01T12:00Z', '2026-10-01T17:30+05:00'],
  ['2026-10-01T12:00:00.123Z', '2026-10-01T12:00:00.124Z'],
  [undefined, undefined], [null, null], ['', ''], ['2026-10-01T12:00:00Z', null], [null, '2026-10-01T20:00:00Z'],
]) {
  const result = await execute({ ...base, plannedStart, plannedEnd, note: 'Synthetic QA' });
  assert.equal(result.status, 201, 'valid timestamps or nullable plans must save');
  assert.equal(result.queries.length, 2, 'one employee lookup and one upsert');
  assert.equal(result.data.planned_start, plannedStart || null);
  assert.equal(result.data.planned_end, plannedEnd || null);
  checks++;
}

const foreign = await execute(base, { employeeFound: false });
assert.equal(foreign.status, 404);
assert.equal(foreign.data.error, 'staff_member_not_found');
assert.equal(foreign.queries.length, 1, 'foreign/inactive/deleted employee never inserts a schedule');
checks++;
const denied = await execute(base, { allowed: false });
assert.equal(denied.status, 403);
assert.equal(denied.queries.length, 0);
assert.equal(denied.bodyReads, 0, 'authorization runs before parsing the submitted data');
checks++;

console.log(`LOCAL SCHEDULE VALIDATION QA: PASS (${checks} actual handler VM scenarios; invalid input rejected before SQL; UTC/offset/overnight/nullable plans; tenant employee lookup and denied writes)`);
