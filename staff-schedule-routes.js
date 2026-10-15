'use strict';
const { resolveAccess, setGrant } = require('./staff-schedule-access');
const { ScheduleError } = require('./staff-schedule-domain');
const schedule = require('./staff-schedule-service');
const copy = require('./staff-schedule-copy');
const planning = require('./staff-schedule-planning');
const settings = require('./staff-schedule-settings');
const venuePolicy = require('./staff-schedule-venue-policy');
const demand = require('./staff-schedule-demand');
const series = require('./staff-schedule-series');
const defaults = require('./staff-schedule-defaults');
const bindings = require('./staff-schedule-bindings');
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
        COALESCE(g.access,'none') AS access,COALESCE(g.version,0) AS version,
        COALESCE(g.can_publish,false) AS "canPublish",COALESCE(g.can_manage_settings,false) AS "canManageSettings"
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
    const employeeDefaultsRoute = url.pathname.match(/^\/api\/staff\/schedule\/employees\/([0-9a-f-]{36})\/defaults$/i);
    if (employeeDefaultsRoute) {
      if (req.method === 'GET') return reply(200, await defaults.listEmployeeDefaults(pool, principal, employeeDefaultsRoute[1]));
      if (req.method === 'PUT') return reply(200, await defaults.putEmployeeDefault(pool, principal, employeeDefaultsRoute[1], await readBody(req)));
      return reply(405, { error: 'method_not_allowed' });
    }
    const employeeFunctionsRoute = url.pathname.match(/^\/api\/staff\/schedule\/employees\/([0-9a-f-]{36})\/functions$/i);
    if (employeeFunctionsRoute) {
      if (req.method === 'GET') return reply(200, await settings.employeeFunctions(pool, principal, employeeFunctionsRoute[1]));
      if (req.method === 'PUT') return reply(200, await settings.setEmployeeFunctions(pool, principal, employeeFunctionsRoute[1], await readBody(req)));
      return reply(405, { error: 'method_not_allowed' });
    }
    const employeeAvailabilityRoute = url.pathname.match(/^\/api\/staff\/schedule\/employees\/([0-9a-f-]{36})\/availability$/i);
    if (employeeAvailabilityRoute) {
      if (req.method === 'GET') return reply(200, await settings.employeeAvailability(pool, principal, employeeAvailabilityRoute[1]));
      if (req.method === 'PUT') return reply(200, await settings.setEmployeeAvailability(pool, principal, employeeAvailabilityRoute[1], await readBody(req)));
      return reply(405, { error: 'method_not_allowed' });
    }
    if (url.pathname === `${base}/venue-policy`) {
      if (req.method === 'GET') return reply(200, await venuePolicy.getVenuePolicy(pool, principal));
      if (req.method === 'PUT') return reply(200, await venuePolicy.saveVenuePolicy(pool, principal, await readBody(req)));
      return reply(405, { error: 'method_not_allowed' });
    }
    const demandRoute=url.pathname.match(/^\/api\/staff\/schedule\/demand-rules(?:\/([0-9a-f-]{36}))?$/i);
    if(demandRoute){
      const ruleId=demandRoute[1]||null;
      if(req.method==='GET')return reply(200,await demand.listDemandRules(pool,principal,url.searchParams.get('functionId')));
      if(!access.canManageSettings)return reply(403,{error:'schedule_settings_forbidden'});
      const body=await readBody(req);
      if(req.method==='POST'&&!ruleId)return reply(201,await demand.saveDemandRule(pool,principal,null,body,0));
      if(req.method==='PATCH'&&ruleId)return reply(200,await demand.saveDemandRule(pool,principal,ruleId,body,body.version));
      return reply(405,{error:'method_not_allowed'});
    }
    const seriesRoute=url.pathname.match(/^\/api\/staff\/schedule\/series(?:\/([0-9a-f-]{36}))?$/i);
    if(seriesRoute){
      const seriesId=seriesRoute[1]||null;
      if(req.method==='GET')return reply(200,await series.readSeries(pool,principal,seriesId));
      if(!access.manage)return reply(403,{error:'schedule_forbidden'});
      if(!access.canManageSettings)return reply(403,{error:'schedule_settings_forbidden'});
      if(req.method==='POST'&&!seriesId)return reply(201,await series.saveSeries(pool,principal,null,await readBody(req),'POST'));
      if(req.method==='PATCH'&&seriesId)return reply(200,await series.saveSeries(pool,principal,seriesId,await readBody(req),'PATCH'));
      return reply(405,{error:'method_not_allowed'});
    }
    const functionRoute = url.pathname.match(/^\/api\/staff\/schedule\/functions(?:\/([0-9a-f-]{36}))?$/i);
    if (functionRoute) {
      const functionId = functionRoute[1] || null;
      if (!functionId && req.method === 'GET') return reply(200, await settings.listFunctions(pool, principal));
      if (functionId && req.method === 'GET') {
        const result = await pool.query(`SELECT id,name,active,sort_order AS "sortOrder",version
          FROM staff_schedule_functions WHERE venue_id=$1 AND id=$2`, [principal.venueId, functionId]);
        return reply(result.rowCount ? 200 : 404, result.rows[0] || { error: 'schedule_function_not_found' });
      }
      if (!functionId && req.method === 'POST') return reply(201, await settings.saveFunction(pool, principal, null, 'POST', await readBody(req)));
      if (functionId && req.method === 'PATCH') return reply(200, await settings.saveFunction(pool, principal, functionId, 'PATCH', await readBody(req)));
      return reply(405, { error: 'method_not_allowed' });
    }
    const bindingRoute = url.pathname.match(/^\/api\/staff\/schedule\/template-bindings(?:\/([0-9a-f-]{36}))?$/i);
    if (bindingRoute) {
      const bindingId = bindingRoute[1] || null;
      if (!bindingId && req.method === 'GET') return reply(200, await bindings.listBindings(pool, principal, {
        includeInactive: url.searchParams.get('includeInactive') === 'true',
        includeArchived: url.searchParams.get('includeArchived') === 'true'
      }));
      if (!bindingId && req.method === 'POST') return reply(201, await bindings.saveBinding(pool, principal, null, 'POST', await readBody(req)));
      if (bindingId && req.method === 'PATCH') return reply(200, await bindings.saveBinding(pool, principal, bindingId, 'PATCH', await readBody(req)));
      return reply(405, { error: 'method_not_allowed' });
    }
    if (url.pathname === `${base}/template-suggestions`) {
      if (req.method !== 'GET') return reply(405, { error: 'method_not_allowed' });
      return reply(200, await bindings.suggestTemplates(pool, principal, {
        employeeId: url.searchParams.get('employeeId'),
        functionId: url.searchParams.get('functionId'),
        explicitTemplateId: url.searchParams.get('explicitTemplateId')
      }));
    }
    if (url.pathname === `${base}/role-options`) {
      if (req.method !== 'GET') return reply(405, { error: 'method_not_allowed' });
      if (!access.canManageSettings) return reply(403, { error: 'schedule_settings_forbidden' });
      const custom = await pool.query(`SELECT id,name FROM custom_staff_roles
        WHERE venue_id=$1 AND is_active ORDER BY lower(name),id`, [principal.venueId]);
      const labels = { owner:'Владелец', admin:'Администратор', manager:'Управляющий', developer:'Разработчик',
        senior_bartender:'Старший бармен', senior_hookah_master:'Старший кальянный мастер',
        bartender:'Бармен', hookah_master:'Кальянный мастер', cleaner:'Уборка', security:'Охрана',
        technician:'Техник', other_staff:'Другая должность' };
      return reply(200, { items: [
        ...[...bindings.systemRoles].map(role => ({ key:`system:${role}`, name:labels[role] || role, kind:'system' })),
        ...custom.rows.map(role => ({ key:`custom:${role.id}`, name:role.name, kind:'custom' }))
      ] });
    }
    const planned = url.pathname.match(/^\/api\/staff\/schedule\/(drafts|templates)(?:\/([0-9a-fA-F-]{36}))?(?:\/(publish-preview|publish|discard|range-preview|range-apply))?$/);
    if (planned) {
      const [, resource, id, action] = planned;
      const allowed = action ? resource === 'drafts' && id && req.method === 'POST'
        : id ? ['GET','PATCH'].includes(req.method) : ['GET','POST'].includes(req.method);
      if (!allowed) return reply(405, { error: 'method_not_allowed' });
      if (!access.manage) return reply(403, { error: 'schedule_forbidden' });
      if (resource === 'templates' && req.method !== 'GET' && !access.canManageSettings) return reply(403, { error: 'schedule_settings_forbidden' });
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
