'use strict';
const { createHash } = require('node:crypto');
const { ScheduleError, normalize, range, version, localDate, UUID } = require('./staff-schedule-domain');
const { resolveAccess } = require('./staff-schedule-access');
const pattern = require('./staff-schedule-pattern');
const { instant } = require('./staff-schedule-copy');
const fail=(code,status=400)=>{throw new ScheduleError(code,status);};
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const name=value=>{if(typeof value!=='string'||!value.trim()||value.trim().length>120)fail('planning_name_invalid');return value.trim();};
const uuid=value=>{if(typeof value!=='string'||!UUID.test(value))fail('planning_id_invalid');return value.toLowerCase();};
const reason=value=>{if(value===undefined)return '';if(typeof value!=='string'||value.length>500)fail('schedule_reason_invalid');return value.trim();};
const scheduleDTO=r=>({id:r.id,userId:r.user_id,workDate:r.work_date,plannedStart:r.planned_start?new Date(r.planned_start).toISOString():null,plannedEnd:r.planned_end?new Date(r.planned_end).toISOString():null,kind:r.kind,status:r.status,breakMinutes:r.break_minutes,note:r.note,version:r.version});
const draftDTO=(r,access)=>({id:r.id,name:r.name,from:r.from_date,to:r.to_date,userIds:r.user_ids,timezone:r.timezone,state:r.state,version:r.version,operations:r.operations,baseItems:r.base_snapshot.filter(x=>x.work_date>=r.from_date&&x.work_date<=r.to_date).map(scheduleDTO),publishedAt:r.published_at,capabilities:{manage:access.manage,canPublish:access.canPublish}});
const templateDTO=r=>({id:r.id,name:r.name,version:r.version,archived:r.archived,definition:r.definition});
async function snapshot(db,p,d) {
  // Include adjacent dates AND actual overlaps: legacy rows can exceed the new 24h limit.
  // The snapshot also detects new rows (phantoms), cancellations and moved intervals.
  const result=await db.query(`SELECT id,user_id,work_date::text,planned_start::text,planned_end::text,kind,status,break_minutes,note,version
    FROM staff_schedules WHERE venue_id=$1 AND user_id=ANY($2::uuid[])
    AND (work_date BETWEEN $3::date-1 AND $4::date+1 OR (
      COALESCE(planned_start,work_date::timestamp AT TIME ZONE $5) < ($4::date+2)::timestamp AT TIME ZONE $5
      AND COALESCE(planned_end,(work_date+1)::timestamp AT TIME ZONE $5) > $3::date::timestamp AT TIME ZONE $5))
    ORDER BY id`,[p.venueId,d.user_ids,d.from_date,d.to_date,d.timezone]);
  return result.rows;
}
async function entity(db,p,type,id) {
  const table=type==='draft'?'staff_schedule_drafts':'staff_schedule_templates';
  const dates=type==='draft'?',from_date::text,to_date::text':'';
  const r=(await db.query(`SELECT *${dates} FROM ${table} WHERE venue_id=$1 AND id=$2 FOR UPDATE`,[p.venueId,uuid(id)])).rows[0];
  if(!r)fail('planning_not_found',404);return r;
}
function open(d,input) {if(d.state!=='open')fail('draft_closed',409);if(version(input.version)!==d.version)fail('draft_version_conflict',409);}
function operations(d,raw) {
  if(!Array.isArray(raw)||raw.length>200)fail('planning_operations_limit');
  const seen=new Set();
  return raw.map(op=>{
    if(!op||!['create','update','cancel'].includes(op.operation))fail('planning_operation_invalid');
    const out={operation:op.operation};
    if(op.operation!=='create') {
      out.sourceId=uuid(op.sourceId);out.sourceVersion=version(op.sourceVersion);
      const before=d.base_snapshot.find(r=>r.id===out.sourceId);
      if(!before||before.work_date<d.from_date||before.work_date>d.to_date)fail('planning_source_not_found',404);
      if(before.version!==out.sourceVersion||before.status!=='planned')fail('planning_source_changed',409);
      if(seen.has(out.sourceId))fail('planning_duplicate_source');seen.add(out.sourceId);
    } else if(op.sourceId!==undefined||op.sourceVersion!==undefined) fail('planning_operation_invalid');
    out.reason=reason(op.reason);
    if(op.operation!=='cancel') {
      out.payload=normalize(op.payload,d.timezone);
      out.payload.userId=out.payload.userId.toLowerCase();
      if(!d.user_ids.includes(out.payload.userId)||out.payload.workDate<d.from_date||out.payload.workDate>d.to_date)fail('planning_scope_invalid');
    }
    return out;
  });
}
async function validateFinal(db,p,d,ops) {
  const changedIds=new Set(ops.filter(o=>o.sourceId).map(o=>o.sourceId));
  const rows=d.base_snapshot.filter(r=>r.status==='planned'&&!changedIds.has(r.id)).map(scheduleDTO);
  ops.forEach((o,i)=>{if(o.operation!=='cancel')rows.push({...o.payload,id:o.sourceId||`new:${i}`,status:'planned'});});
  const ids=[...new Set(ops.filter(o=>o.operation!=='cancel').map(o=>o.payload.userId))].sort();
  const active=ids.length?(await db.query('SELECT id FROM users WHERE venue_id=$1 AND id=ANY($2::uuid[]) AND is_active AND deleted_at IS NULL ORDER BY id FOR SHARE',[p.venueId,ids])).rows:[];
  const conflicts=ids.filter(id=>!active.some(r=>r.id===id)).map(userId=>({code:'schedule_employee_unavailable',userId}));
  const groups=new Map();
  for(const r of rows) {
    if(!ids.includes(r.userId))continue;
    if(!groups.has(r.userId))groups.set(r.userId,[]);
    groups.get(r.userId).push({id:r.id,userId:r.userId,start:Date.parse(r.plannedStart||instant(r.workDate+'T00:00',d.timezone)),end:Date.parse(r.plannedEnd||instant(pattern.addDays(r.workDate,1)+'T00:00',d.timezone))});
  }
  // Only newly created/changed intervals are relevant; inherited legacy conflicts are preserved.
  const touched=new Set(ops.filter(o=>o.operation!=='cancel').map((o)=>o.sourceId).filter(Boolean));
  const changed=r=>r.id.startsWith('new:')||touched.has(r.id);
  for(const intervals of groups.values())for(let i=0;i<intervals.length;i++) {
    const a=intervals[i];if(!changed(a))continue;
    for(let j=0;j<intervals.length;j++) {
      const b=intervals[j];if(i===j||(changed(b)&&j<i))continue;
      if(a.start<b.end&&b.start<a.end)conflicts.push({code:'schedule_overlap',userId:a.userId,ids:[a.id,b.id]});
      if(conflicts.length>=200)return conflicts;
    }
  }
  return conflicts;
}
async function checkBase(db,p,d,access) {
  if(access.timezone!==d.timezone||hash(await snapshot(db,p,d))!==hash(d.base_snapshot))fail('draft_base_changed',409);
}
async function audit(db,p,type,id,action,before,after) {
  await db.query('INSERT INTO staff_schedule_planning_events(venue_id,actor_id,entity_type,entity_id,action,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)',[p.venueId,p.userId,type,id,action,before?JSON.stringify(before):null,JSON.stringify(after)]);
}
async function mutateDraft(db,p,d,access,action,ops,state='open') {
  const row=(await db.query(`UPDATE staff_schedule_drafts SET operations=$3::jsonb,state=$4,version=version+1,updated_at=now(),
    published_by=CASE WHEN $4='published' THEN $5::uuid ELSE published_by END,
    published_at=CASE WHEN $4='published' THEN now() ELSE published_at END
    WHERE venue_id=$1 AND id=$2 RETURNING *,from_date::text,to_date::text`,[p.venueId,d.id,JSON.stringify(ops),state,p.userId])).rows[0];
  await audit(db,p,'draft',d.id,action,d,row);return draftDTO(row,access);
}
async function rangePreview(db,p,d,input,access) {
  open(d,input);range(input.from,input.to);
  if(input.from<d.from_date||input.to>d.to_date)fail('planning_scope_invalid');
  const ids=pattern.users(input.userIds);if(ids.some(id=>!d.user_ids.includes(id)))fail('planning_scope_invalid');
  let definition=input.definition, template=null;
  if(input.templateId!==undefined) {
    if(definition!==undefined)fail('planning_pattern_invalid');
    template=await entity(db,p,'template',input.templateId);
    if(template.archived||version(input.templateVersion)!==template.version)fail('template_version_conflict',409);
    definition=template.definition;
  }
  const added=operations(d,pattern.expand({...input,userIds:ids,definition},d.timezone));
  const combined=operations(d,[...d.operations,...added]);
  await checkBase(db,p,d,access);
  const conflicts=await validateFinal(db,p,d,combined);
  return {draftId:d.id,version:d.version,operations:added,conflicts,fingerprint:hash({type:'range',draft:d.id,version:d.version,added,template:template?{id:template.id,version:template.version}:null})};
}
async function publishPreview(db,p,d,input,access) {
  open(d,input);await checkBase(db,p,d,access);
  const ops=operations(d,d.operations),conflicts=await validateFinal(db,p,d,ops);
  return {draftId:d.id,version:d.version,operations:ops,conflicts,canPublish:access.canPublish,fingerprint:hash({type:'publish',id:d.id,version:d.version,ops,base:d.base_snapshot,timezone:d.timezone})};
}
async function publish(db,p,d,input,access) {
  if(!access.canPublish)fail('schedule_publish_forbidden',403);
  const preview=await publishPreview(db,p,d,input,access);
  if(preview.fingerprint!==input.fingerprint)fail('planning_preview_changed',409);
  if(preview.conflicts.length)fail('planning_conflict',409);
  if(!preview.operations.length)fail('planning_empty');
  const globalReason=reason(input.reason),today=localDate(new Date(),d.timezone);
  // Validate every requirement before touching the live table. Updates below use the final-plan
  // overlap proof, not intermediate save() validation, so swaps are atomic and retain identity.
  for(const op of preview.operations) {
    const before=op.sourceId?d.base_snapshot.find(r=>r.id===op.sourceId):null;
    if(op.operation==='cancel'&&!(op.reason||globalReason))fail('schedule_cancel_reason_required');
    if((before?.work_date<today||op.payload?.workDate<today)&&!(op.reason||globalReason))fail('schedule_past_reason_required');
  }
  for(const op of preview.operations) {
    const before=op.sourceId?(await db.query('SELECT * FROM staff_schedules WHERE venue_id=$1 AND id=$2 FOR UPDATE',[p.venueId,op.sourceId])).rows[0]:null;
    if(before&&before.version!==op.sourceVersion)fail('draft_base_changed',409);
    let after;
    if(op.operation==='cancel') after=(await db.query("UPDATE staff_schedules SET status='cancelled',cancel_reason=$3,version=version+1,updated_by=$4,updated_at=now() WHERE venue_id=$1 AND id=$2 RETURNING *",[p.venueId,op.sourceId,op.reason||globalReason,p.userId])).rows[0];
    else {
      const e=op.payload,values=[p.venueId,e.userId,e.workDate,e.plannedStart,e.plannedEnd,e.kind,e.breakMinutes,e.note,p.userId];
      after=op.operation==='create'?(await db.query(`INSERT INTO staff_schedules(venue_id,user_id,work_date,planned_start,planned_end,kind,break_minutes,note,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,values)).rows[0]
        :(await db.query(`UPDATE staff_schedules SET user_id=$2,work_date=$3,planned_start=$4,planned_end=$5,kind=$6,break_minutes=$7,note=$8,updated_by=$9,updated_at=now(),version=version+1
          WHERE venue_id=$1 AND id=$10 RETURNING *`,[...values,op.sourceId])).rows[0];
    }
    await db.query('INSERT INTO staff_schedule_events(venue_id,schedule_id,actor_id,before_data,after_data,reason) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)',[p.venueId,after.id,p.userId,before?JSON.stringify(before):null,JSON.stringify(after),op.reason||globalReason]);
  }
  return mutateDraft(db,p,d,access,'publish',preview.operations,'published');
}
async function execute(db,p,resource,id,action,method,input,access) {
  if(resource==='templates') {
    if(!id&&method==='GET')return {items:(await db.query('SELECT * FROM staff_schedule_templates WHERE venue_id=$1 ORDER BY created_at,id',[p.venueId])).rows.map(templateDTO)};
    if(!id&&method==='POST') {
      const row=(await db.query('INSERT INTO staff_schedule_templates(venue_id,name,definition,created_by) VALUES($1,$2,$3::jsonb,$4) RETURNING *',[p.venueId,name(input.name),JSON.stringify(pattern.definition(input.definition)),p.userId])).rows[0];
      await audit(db,p,'template',row.id,'create',null,row);return templateDTO(row);
    }
    const row=await entity(db,p,'template',id);
    if(method==='GET')return templateDTO(row);
    if(version(input.version)!==row.version)fail('template_version_conflict',409);
    if(input.archived!==undefined&&typeof input.archived!=='boolean')fail('planning_template_invalid');
    const next=(await db.query('UPDATE staff_schedule_templates SET name=$3,definition=$4::jsonb,archived=$5,version=version+1,updated_at=now() WHERE venue_id=$1 AND id=$2 RETURNING *',[p.venueId,row.id,input.name===undefined?row.name:name(input.name),JSON.stringify(input.definition===undefined?row.definition:pattern.definition(input.definition)),input.archived??row.archived])).rows[0];
    await audit(db,p,'template',row.id,'update',row,next);return templateDTO(next);
  }
  if(!id&&method==='GET')return {items:(await db.query('SELECT *,from_date::text,to_date::text FROM staff_schedule_drafts WHERE venue_id=$1 ORDER BY created_at,id',[p.venueId])).rows.map(r=>draftDTO(r,access))};
  if(!id&&method==='POST') {
    range(input.from,input.to);const ids=pattern.users(input.userIds);
    const employees=await db.query('SELECT id FROM users WHERE venue_id=$1 AND id=ANY($2::uuid[])',[p.venueId,ids]);
    if(employees.rowCount!==ids.length)fail('planning_employee_not_found',404);
    const base=await snapshot(db,p,{user_ids:ids,from_date:input.from,to_date:input.to,timezone:access.timezone});
    const row=(await db.query(`INSERT INTO staff_schedule_drafts(venue_id,name,from_date,to_date,user_ids,timezone,base_snapshot,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *,from_date::text,to_date::text`,[p.venueId,name(input.name),input.from,input.to,ids,access.timezone,JSON.stringify(base),p.userId])).rows[0];
    await audit(db,p,'draft',row.id,'create',null,row);return draftDTO(row,access);
  }
  const d=await entity(db,p,'draft',id);
  if(method==='GET')return draftDTO(d,access);
  if(action==='publish')return publish(db,p,d,input,access);
  if(action==='publish-preview')return publishPreview(db,p,d,input,access);
  if(action==='range-preview'||action==='range-apply') {
    const preview=await rangePreview(db,p,d,input,access);
    if(action==='range-preview')return preview;
    if(input.fingerprint!==preview.fingerprint)fail('planning_preview_changed',409);
    if(preview.conflicts.length)fail('planning_conflict',409);
    return mutateDraft(db,p,d,access,'range-apply',operations(d,[...d.operations,...preview.operations]));
  }
  open(d,input);
  if(action==='discard')return mutateDraft(db,p,d,access,'discard',d.operations,'discarded');
  return mutateDraft(db,p,d,access,'edit',operations(d,input.operations));
}
async function handle(pool,p,resource,id,action,method,input={}) {
  const preview=['publish-preview','range-preview'].includes(action);
  const mutation=method!=='GET'&&!preview;
  if(!input||typeof input!=='object'||Array.isArray(input))fail('planning_input_invalid');
  if(mutation&&!UUID.test(String(input.requestKey||'')))fail('schedule_request_key_required');
  const fingerprint=hash({planning:1,resource,id:id||null,action:action||null,method,input});
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    // Same lock order as live schedule.save/copy: venue, then actor, then entity.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`schedule:${p.venueId}`]);
    const access=await resolveAccess(db,p,true);
    if(!access.manage)fail('schedule_forbidden',403);
    if(action==='publish'&&!access.canPublish)fail('schedule_publish_forbidden',403);
    if(mutation) {
      const replay=(await db.query('SELECT fingerprint,response FROM staff_schedule_requests WHERE venue_id=$1 AND actor_id=$2 AND request_key=$3',[p.venueId,p.userId,input.requestKey])).rows[0];
      if(replay){if(replay.fingerprint!==fingerprint)fail('schedule_request_conflict',409);await db.query('COMMIT');return replay.response;}
    }
    const response=await execute(db,p,resource,id,action,method,input,access);
    if(mutation)await db.query('INSERT INTO staff_schedule_requests(venue_id,actor_id,request_key,fingerprint,response) VALUES($1,$2,$3,$4,$5::jsonb)',[p.venueId,p.userId,input.requestKey,fingerprint,JSON.stringify(response)]);
    await db.query('COMMIT');return response;
  } catch(error){await db.query('ROLLBACK');throw error;} finally {db.release();}
}
module.exports={handle};
