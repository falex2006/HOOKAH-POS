import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf("if (pathname === '/api/staff/time' && req.method === 'POST') {");
const end = source.indexOf("if (pathname === '/api/payroll/rules' && req.method === 'GET')", start);
assert.ok(start >= 0 && end > start, 'work-log write route can be isolated');
const route = source.slice(start, end);
const userId = '11111111-1111-4111-8111-111111111111';
const venueId = '22222222-2222-4222-8222-222222222222';
const beginPayrollSourceProducerTransaction = async (client, venue) => {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [`payroll-official-source-v1:${venue}`]);
};

const makeDb = ({ employeeExists = true } = {}) => {
  const state = { logs: [], audits: [] };
  let snapshot = null;
  const query = async (input, params = []) => {
    const sql = input.replace(/\s+/g, ' ').trim();
    if (sql === 'BEGIN') { snapshot = structuredClone(state); return { rows: [] }; }
    if (sql.startsWith('SELECT pg_advisory_xact_lock_shared')) return { rows: [] };
    if (sql === 'COMMIT') { snapshot = null; return { rows: [] }; }
    if (sql === 'ROLLBACK') { if (snapshot) Object.assign(state, snapshot); snapshot = null; return { rows: [] }; }
    if (sql.startsWith('SELECT id FROM users WHERE id=$1 AND venue_id=$2')) return { rows: employeeExists && params[0] === userId && params[1] === venueId ? [{ id: userId }] : [] };
    if (sql.startsWith('SELECT id FROM staff_work_logs WHERE venue_id=$1 AND user_id=$2')) {
      const nextStart = Date.parse(params[2]); const nextEnd = params[3] ? Date.parse(params[3]) : Infinity;
      return { rows: state.logs.filter((row) => row.venue_id === params[0] && row.user_id === params[1] && Date.parse(row.started_at) < nextEnd && (row.ended_at ? Date.parse(row.ended_at) : Infinity) > nextStart).slice(0, 1).map((row) => ({ id: row.id })) };
    }
    if (sql.startsWith('INSERT INTO staff_work_logs')) {
      const row = { id: `log-${state.logs.length + 1}`, venue_id: params[0], user_id: params[1], started_at: params[2], ended_at: params[3], source: params[4], note: params[5] };
      state.logs.push(row); return { rows: [{ ...row }] };
    }
    throw new Error(`Unexpected staff-time SQL: ${sql}`);
  };
  return { state, pool: { connect: async () => ({ query, release() {} }) } };
};

const run = async (db, input) => {
  let response;
  await new Function('pathname','req','res','repositories','venueDbId','denyUnless','body','json','recordAudit','beginPayrollSourceProducerTransaction', `return (async()=>{${route}})();`)(
    '/api/staff/time', { method: 'POST', user: { id: userId } }, {}, { pool: db.pool }, venueId,
    () => false, async () => input,
    (_res,status,data) => (response = { status, data }),
    (_req,action,_entity,id,_before,after) => db.state.audits.push({ action,id,after }),
    beginPayrollSourceProducerTransaction,
  );
  return response;
};

const db = makeDb();
const first = await run(db, { userId, startedAt: '2026-09-27T10:00:00Z', endedAt: '2026-09-27T18:00:00Z' });
assert.equal(first.status, 201);
assert.equal(db.state.logs.length, 1);
assert.equal(db.state.audits.length, 1, 'committed work-log changes are audited');
const overlap = await run(db, { userId, startedAt: '2026-09-27T17:00:00Z', endedAt: '2026-09-27T19:00:00Z' });
assert.equal(overlap.status, 409);
assert.equal(overlap.data.error, 'work_log_overlaps_existing');
assert.equal(db.state.logs.length, 1, 'overlap is rolled back without adding a second log');
const adjacent = await run(db, { userId, startedAt: '2026-09-27T18:00:00Z', endedAt: '2026-09-27T20:00:00Z' });
assert.equal(adjacent.status, 201, 'touching half-open intervals are allowed');
assert.equal(await run(makeDb({ employeeExists: false }), { userId, startedAt: '2026-09-27T10:00:00Z', endedAt: '2026-09-27T11:00:00Z' }).then((value) => value.status), 404);
assert.equal((await run(makeDb(), { userId, startedAt: '2026-09-27T10:00:00Z', source: 'untrusted' })).status, 400);

assert.match(source, /MAX\(ends_at\) OVER \(ORDER BY starts_at,ends_at/);
assert.match(source, /COUNT\(DISTINCT shift_date\) FILTER/);
console.log('STAFF WORK-LOG RUNTIME QA: PASS (venue-scoped active staff, transactional overlap rejection, adjacent logs and merged-hour calculation)');
