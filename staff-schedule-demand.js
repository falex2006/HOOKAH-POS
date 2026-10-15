'use strict';

const { createHash } = require('node:crypto');
const { ScheduleError, UUID } = require('./staff-schedule-domain');
const { resolveAccess } = require('./staff-schedule-access');
const domain = require('./staff-schedule-demand-domain');
const fail = (code, status = 400) => { throw new ScheduleError(code, status); };
const id = value => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : fail('schedule_demand_id_invalid');
const isoDate = value => value == null ? null : value instanceof Date ? value.toISOString().slice(0,10) : String(value).slice(0,10);
const isoTimestamp = value => value instanceof Date ? value.toISOString() : value;
const dto = row => ({ id: row.id, venueId: row.venue_id, functionId: row.function_id,
  scope: row.weekday == null ? 'date_range' : 'weekly', weekday: row.weekday == null ? null : row.weekday,
  effectiveFrom: isoDate(row.effective_from), effectiveTo: isoDate(row.effective_to),
  startTime: String(row.start_time).slice(0,5), endTime: String(row.end_time).slice(0,5), endDayOffset: row.end_day_offset,
  requiredCount: row.required_count, timezone: row.timezone, active: row.active, version: row.version,
  createdBy: row.created_by, updatedBy: row.updated_by, createdAt: isoTimestamp(row.created_at), updatedAt: isoTimestamp(row.updated_at) });

async function listDemandRules(pool, principal, functionId = null) {
  const access = await resolveAccess(pool, principal);
  if (!access.view) fail('schedule_forbidden', 403);
  const params = [principal.venueId];
  const filter = functionId ? (params.push(id(functionId)), ' AND function_id=$2') : '';
  const rows = await pool.query(`SELECT * FROM staff_schedule_demand_rules WHERE venue_id=$1${filter}
      ORDER BY function_id,weekday NULLS LAST,effective_from,start_time,id`, params);
  return { items: rows.rows.map(dto), timezone: access.timezone };
}

async function saveDemandRule(pool, principal, ruleId, input, expectedVersion = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('schedule_demand_input_invalid');
  if (typeof input.requestKey !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.requestKey)) fail('schedule_request_key_required');
  const fingerprint=createHash('sha256').update(JSON.stringify({ruleId,input,expectedVersion})).digest('hex');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Share the exact venue lock used by draft publish so settings cannot race its final readback.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`schedule:${principal.venueId}`]);
    const access = await resolveAccess(db, principal, true);
    if (!access.manage || !access.canManageSettings) fail('schedule_forbidden', 403);
    const replay=(await db.query('SELECT fingerprint,response FROM staff_schedule_requests WHERE venue_id=$1 AND actor_id=$2 AND request_key=$3',[principal.venueId,principal.userId,input.requestKey])).rows[0];
    if(replay){if(replay.fingerprint!==fingerprint)fail('schedule_request_conflict',409);await db.query('COMMIT');return replay.response;}
    let previous = null;
    if (ruleId) {
      const row = (await db.query(`SELECT * FROM staff_schedule_demand_rules WHERE venue_id=$1 AND id=$2 FOR UPDATE`,
        [principal.venueId, id(ruleId)])).rows[0];
      if (!row) fail('schedule_demand_not_found', 404);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== row.version) fail('schedule_demand_version_conflict', 409);
      previous = dto(row);
    } else if (expectedVersion !== 0) fail('schedule_demand_version_required');
    const value = domain.normalizeRule(input, access.timezone, previous);
    const fn = (await db.query('SELECT id FROM staff_schedule_functions WHERE venue_id=$1 AND id=$2 AND active FOR SHARE',
      [principal.venueId, value.functionId])).rows[0];
    if (!fn) fail('schedule_function_not_found', 404);
    const existing = await db.query(`SELECT id,function_id,weekday,work_date,effective_from::text,effective_to::text,
        to_char(start_time,'HH24:MI') AS start_time,to_char(end_time,'HH24:MI') AS end_time,end_day_offset,required_count,active,timezone
      FROM staff_schedule_demand_rules WHERE venue_id=$1 AND function_id=$2 AND active`, [principal.venueId, value.functionId]);
    const candidates = existing.rows.map(row => ({ id: row.id, functionId: row.function_id,
      scope: row.weekday == null ? 'date_range' : 'weekly', weekday: row.weekday,
      effectiveFrom: row.effective_from, effectiveTo: row.effective_to, startTime: row.start_time,
      endTime: row.end_time, endDayOffset: row.end_day_offset, requiredCount: row.required_count,
      active: row.active, timezone: row.timezone }));
    domain.assertNoOverlap(value, candidates);
    let saved;
    if (previous) {
      saved = (await db.query(`UPDATE staff_schedule_demand_rules SET function_id=$3,weekday=$4,work_date=$5,
        effective_from=$6,effective_to=$7,start_time=$8,end_time=$9,end_day_offset=$10,required_count=$11,
        timezone=$12,active=$13,version=version+1,updated_by=$14,updated_at=now()
        WHERE venue_id=$1 AND id=$2 RETURNING *`, [principal.venueId, previous.id, value.functionId, value.weekday,
        value.effectiveFrom, value.effectiveFrom, value.effectiveTo, value.startTime, value.endTime, value.endDayOffset,
        value.requiredCount, value.timezone, value.active, principal.userId])).rows[0];
    } else {
      saved = (await db.query(`INSERT INTO staff_schedule_demand_rules(venue_id,function_id,weekday,work_date,effective_from,effective_to,
        start_time,end_time,end_day_offset,required_count,timezone,active,version,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,$13)
        RETURNING *`,
      [principal.venueId,value.functionId,value.weekday,value.effectiveFrom,value.effectiveFrom,value.effectiveTo,value.startTime,
        value.endTime,value.endDayOffset,value.requiredCount,value.timezone,value.active,principal.userId])).rows[0];
    }
    const after = dto(saved);
    await db.query(`INSERT INTO staff_schedule_config_events(venue_id,actor_id,entity_type,entity_id,action,before_data,after_data)
      VALUES($1,$2,'demand_rule',$3,$4,$5::jsonb,$6::jsonb)`, [principal.venueId,principal.userId,saved.id,
      previous ? (value.active ? 'update' : 'archive') : 'create',previous ? JSON.stringify(previous) : null,JSON.stringify(after)]);
    await db.query('INSERT INTO staff_schedule_requests(venue_id,actor_id,request_key,fingerprint,response) VALUES($1,$2,$3,$4,$5::jsonb)',[principal.venueId,principal.userId,input.requestKey,fingerprint,JSON.stringify(after)]);
    await db.query('COMMIT');
    return after;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

module.exports = { listDemandRules, saveDemandRule };
