'use strict';
const { AttendanceError } = require('./staff-attendance-domain');
const { sameOriginMutation } = require('./payroll-scheme-routes');
const service = require('./staff-attendance-service');
const mutations = require('./staff-attendance-mutations');
async function handleAttendanceRoute({ req, res, url, pool, readBody, json }) {
  const base = '/api/staff/attendance';
  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false;
  const reply = (status, data) => { json(res, status, data); return true; };
  if (!req.user) return reply(401, { error: 'authentication_required' });
  if (!pool) return reply(503, { error: 'attendance_unavailable' });
  const principal = { userId: req.user.id, venueId: req.user.venueId };
  const route = url.pathname.slice(base.length);
  try {
    if (req.method === 'GET' && route === '/self') return reply(200, await service.selfStatus(pool, principal));
    if (req.method === 'GET' && route === '/management') return reply(200, await service.management(pool, principal));
    if (!['POST', 'PUT'].includes(req.method)) return reply(405, { error: 'method_not_allowed' });
    const closeRoute = route.match(/^\/sessions\/([0-9a-f-]{36})\/close$/i);
    // Recovery always requires same-origin proof, even with bearer credentials.
    const originRequest = closeRoute ? { ...req, headers: { ...req.headers, authorization: '' } } : req;
    if (!sameOriginMutation(originRequest)) return reply(403, { error: 'attendance_origin_forbidden' });
    const operations = { 'POST /start': mutations.start, 'POST /end': mutations.end,
      'POST /requests': mutations.requestException, 'PUT /policy': mutations.savePolicy, 'PUT /grants': mutations.saveGrant };
    let operation = operations[`${req.method} ${route}`];
    const requestRoute = route.match(/^\/requests\/([0-9a-f-]{36})\/(decision|cancel)$/i);
    if (requestRoute && req.method === 'POST') operation = requestRoute[2] === 'decision' ? mutations.decide : mutations.cancel;
    if (closeRoute && req.method === 'POST') operation = mutations.closeSession;
    if (!operation) return reply(404, { error: 'attendance_route_not_found' });
    const input = await readBody(req);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AttendanceError('attendance_input_invalid');
    const allowed = operation === mutations.start ? ['requestKey', 'reason', 'approvalId']
      : operation === mutations.end ? ['requestKey', 'id', 'version']
      : operation === mutations.closeSession ? ['requestKey', 'version', 'reason']
      : operation === mutations.savePolicy ? ['requestKey', 'version', 'mode', 'preparationMinutes']
      : operation === mutations.saveGrant ? ['requestKey', 'userId', 'version', 'managePolicy', 'approve', 'closeSessions']
      : operation === mutations.requestException ? ['requestKey', 'reason']
      : operation === mutations.decide ? ['requestKey', 'version', 'decision', 'note'] : ['requestKey', 'version'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new AttendanceError('attendance_input_invalid');
    if (requestRoute) input.id = requestRoute[1];
    if (closeRoute) input.id = closeRoute[1];
    return reply(200, await operation(pool, principal, input));
  } catch (error) {
    if (error instanceof AttendanceError) return reply(error.status, { error: error.code });
    // Never expose SQL, identifiers, credentials or another tenant through errors.
    return reply(503, { error: 'attendance_unavailable' });
  }
}
module.exports = { handleAttendanceRoute };
