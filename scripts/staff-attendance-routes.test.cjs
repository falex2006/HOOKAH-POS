'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handleAttendanceRoute } = require('../staff-attendance-routes');
async function call({ path = '/api/staff/attendance/start', method = 'POST', user = { id: 'self', venueId: 'venue' }, headers = { host: 'localhost', origin: 'http://localhost' }, input = {}, pool = {} } = {}) {
  let response;
  const handled = await handleAttendanceRoute({ req: { method, user, headers }, res: {}, url: new URL(path, 'http://localhost'), pool,
    readBody: async () => input, json: (res, status, data) => { response = { status, data }; } });
  return { handled, ...response };
}
test('anonymous denied before DB; missing backend fails explicitly', async () => {
  assert.equal((await call({ user: null })).status, 401);
  assert.equal((await call({ pool: null })).status, 503);
});
test('cross origin mutations denied', async () => {
  assert.equal((await call({ headers: { host: 'localhost', origin: 'https://evil.test' } })).status, 403);
});
test('client time, identity, mode cannot override start decision', async () => {
  for (const field of ['userId', 'startedAt', 'mode', 'venueId', 'approved']) {
    const result = await call({ input: { requestKey: '10000000-0000-4000-8000-000000000001', [field]: 'spoof' } });
    assert.equal(result.status, 400);
    assert.equal(result.data.error, 'attendance_input_invalid');
  }
});
test('unsupported route/method cannot mutate and unrelated APIs bypass', async () => {
  assert.equal((await call({ method: 'DELETE' })).status, 405);
  assert.equal((await call({ path: '/api/staff/attendance/unknown' })).status, 404);
  assert.equal((await call({ path: '/api/shifts' })).handled, false);
});
test('internal failures do not leak details', async () => {
  const result = await call({ method: 'GET', path: '/api/staff/attendance/self', user: { id: '10000000-0000-4000-8000-000000000001', venueId: '20000000-0000-4000-8000-000000000001' }, pool: { query: async () => { throw new Error('private SQL'); } } });
  assert.equal(result.status, 503);
  assert.deepEqual(result.data, { error: 'attendance_unavailable' });
});
