'use strict';
const { resolveAccess, setGrant } = require('./staff-schedule-access');
const { ScheduleError } = require('./staff-schedule-domain');
const schedule = require('./staff-schedule-service');
const copy = require('./staff-schedule-copy');
const planning = require('./staff-schedule-planning');
const { sameOriginMutation } = require('./payroll-scheme-routes');
async function handleScheduleAccessRoute({ req, res, url, pool, readBody, json }) {
  const base = '/api/staff/schedule';
  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false;
  const reply = (status, value) => { json(res, status, value); return true; };
  if (!req.user) return reply(401, { error: 'authentication_required' });
  if (!pool) return reply(503, { error: 'schedule_postgres_required' });
  const principal = { userId: req.user.id, venueId: req.user.venueId };
  try {
    const access = await resolveAccess(pool, principal);
    if (url.pathname === `${base}/access` && req.method === 'GET') return reply(200, access);
    const grantRoute = url.pathname === `${base}/grants`;
    if (grantRoute && !access.grant) return reply(403, { error: 'schedule_forbidden' });
    if (grantRoute && req.method === 'GET') {
      const result = await pool.query(`SELECT u.id AS "userId",u.full_name AS name,u.role,
        COALESCE(g.access,'none') AS access,COALESCE(g.version,0) AS version,COALESCE(g.can_publish,false) AS "canPublish"
        FROM users u LEFT JOIN staff_schedule_grants g ON g.user_id=u.id AND g.venue_id=u.venue_id
        WHERE u.venue_id=$1 AND u.is_active AND u.deleted_at IS NULL AND u.role IN ('admin','manager')
        ORDER BY u.full_name,u.id`, [principal.venueId]);
      return reply(200, { items: result.rows });
    }
    if (grantRoute && req.method === 'PUT') {
      if (!sameOriginMutation(req)) return reply(403, { error: 'schedule_origin_forbidden' });
      return reply(200, await setGrant(pool, principal, await readBody(req)));
    }
    if (grantRoute) return reply(405, { error: 'method_not_allowed' });
    if (!access.view || (req.method !== 'GET' && !access.manage)) return reply(403, { error: 'schedule_forbidden' });
    if (req.method !== 'GET' && !sameOriginMutation(req)) return reply(403, { error: 'schedule_origin_forbidden' });
    const planned = url.pathname.match(/^\/api\/staff\/schedule\/(drafts|templates)(?:\/([0-9a-fA-F-]{36}))?(?:\/(publish-preview|publish|discard|range-preview|range-apply))?$/);
    if (planned) {
      const [, resource, id, action] = planned;
      const allowed = action ? resource === 'drafts' && id && req.method === 'POST'
        : id ? ['GET','PATCH'].includes(req.method) : ['GET','POST'].includes(req.method);
      if (!allowed) return reply(405, { error: 'method_not_allowed' });
      if (!access.manage) return reply(403, { error: 'schedule_forbidden' });
      const value = await planning.handle(pool, principal, resource, id, action, req.method, req.method === 'GET' ? {} : await readBody(req));
      return reply(!id && req.method === 'POST' ? 201 : 200, value);
    }
    if (url.pathname === `${base}/copy/preview` && req.method === 'POST') return reply(200, await copy.preview(pool, principal, await readBody(req)));
    if (url.pathname === `${base}/copy/apply` && req.method === 'POST') return reply(200, await copy.apply(pool, principal, await readBody(req)));
    if (url.pathname === `${base}/employees` && req.method === 'GET') {
      const result = await pool.query(`SELECT u.id,u.full_name AS name,u.role,(u.is_active AND u.deleted_at IS NULL) AS active FROM users u
        WHERE u.venue_id=$1 AND (u.deleted_at IS NULL OR EXISTS(SELECT 1 FROM staff_schedules s WHERE s.user_id=u.id AND s.venue_id=u.venue_id)
        OR EXISTS(SELECT 1 FROM staff_work_logs w WHERE w.user_id=u.id AND w.venue_id=u.venue_id)) ORDER BY u.full_name,u.id`, [principal.venueId]);
      return reply(200, { items: result.rows });
    }
    if (url.pathname === base && req.method === 'GET') return reply(200, await schedule.list(pool, principal, url.searchParams.get('from'), url.searchParams.get('to')));
    const history = url.pathname.match(/^\/api\/staff\/schedule\/([0-9a-f-]{36})\/history$/i);
    if (history && req.method === 'GET') {
      const record = await pool.query('SELECT id FROM staff_schedules WHERE id=$1 AND venue_id=$2', [history[1], principal.venueId]);
      if (!record.rowCount) return reply(404, { error: 'schedule_not_found' });
      const events = await pool.query(`SELECT e.id,e.created_at AS "createdAt",u.full_name AS actor,e.reason,
        e.after_data->>'version' AS version,e.after_data->>'status' AS status,
        e.after_data->>'planned_start' AS "plannedStart",e.after_data->>'planned_end' AS "plannedEnd",
        e.after_data->>'break_minutes' AS "breakMinutes",e.after_data->>'kind' AS kind
        FROM staff_schedule_events e JOIN users u ON u.id=e.actor_id
        WHERE e.venue_id=$1 AND e.schedule_id=$2 ORDER BY e.id DESC LIMIT 100`, [principal.venueId, history[1]]);
      return reply(200, { items: events.rows });
    }
    if (url.pathname === base && req.method === 'POST') return reply(201, await schedule.save(pool, principal, await readBody(req)));
    const record = url.pathname.match(/^\/api\/staff\/schedule\/([0-9a-f-]+)$/i);
    if (record && req.method === 'GET') return reply(200, await schedule.get(pool, principal, record[1]));
    if (record && req.method === 'PATCH') return reply(200, await schedule.save(pool, principal, await readBody(req), record[1]));
    return reply(404, { error: 'schedule_route_not_found' });
  } catch (error) {
    return reply(error instanceof ScheduleError ? error.status : 503,
      { error: error instanceof ScheduleError ? error.code : 'schedule_unavailable' });
  }
}
module.exports = { handleScheduleAccessRoute };
