'use strict';
const { beginPayrollSourceProducerTransaction } = require('./payroll-source-fence');

const {createHash,randomUUID}=require('node:crypto');
const {ScheduleError,UUID}=require('./staff-schedule-domain');
const {resolveAccess}=require('./staff-schedule-access');
const domain=require('./staff-schedule-series-domain');
const fail=(code,status=400)=>{throw new ScheduleError(code,status);};
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const uuid=value=>typeof value==='string'&&UUID.test(value)?value.toLowerCase():fail('schedule_series_id_invalid');
const version=value=>Number.isSafeInteger(value)&&value>=1?value:fail('schedule_version_required');
const rowDTO=row=>({id:row.id,venueId:row.venue_id,name:row.name,userId:row.user_id,functionId:row.function_id||null,
  anchorDate:row.anchor_date,untilDate:row.until_date,timezone:row.timezone,recurrence:row.recurrence,exceptions:row.exceptions||[],
  state:row.state,version:row.version,createdBy:row.created_by,createdAt:row.created_at,updatedAt:row.updated_at});

async function get(db,venueId,id,lock=false){
  const row=(await db.query(`SELECT *,anchor_date::text,until_date::text FROM staff_schedule_series WHERE venue_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[venueId,id])).rows[0];
  if(!row)fail('schedule_series_not_found',404);
  const exceptions=(await db.query(`SELECT occurrence_date::text AS "occurrenceDate",occurrence_key AS "occurrenceKey",
      exception_kind,payload,reason,version
    FROM staff_schedule_series_exceptions WHERE venue_id=$1 AND series_id=$2 AND active ORDER BY occurrence_date,occurrence_key`,[venueId,id])).rows;
  row.exceptions=exceptions.map(item=>({occurrenceDate:item.occurrenceDate,occurrenceKey:item.occurrenceKey,kind:item.exception_kind,
    ...(item.exception_kind==='manual'?{schedule:item.payload}:{...(item.exception_kind==='replace'?{slot:item.payload}:{})}),reason:item.reason,version:item.version}));
  row.userId=row.user_id;row.functionId=row.function_id||null;
  return row;
}
async function audit(db,p,entityId,action,before,after){
  await db.query(`INSERT INTO staff_schedule_config_events(venue_id,actor_id,entity_type,entity_id,action,before_data,after_data)
    VALUES($1,$2,'series',$3,$4,$5::jsonb,$6::jsonb)`,[p.venueId,p.userId,entityId,action,before?JSON.stringify(rowDTO(before)):null,JSON.stringify(rowDTO(after))]);
}
async function markManualOccurrence(db,p,before,after,reason){
  if(!before?.series_id)return null;
  if(typeof reason!=='string'||!reason.trim())fail('schedule_series_reason_required');
  const series=(await db.query('SELECT * FROM staff_schedule_series WHERE venue_id=$1 AND id=$2 FOR UPDATE',[p.venueId,before.series_id])).rows[0];
  if(!series)fail('schedule_series_not_found',404);
  const occurrenceDate=before.series_occurrence_date,occurrenceKey=before.series_occurrence_key;
  const old=(await db.query(`SELECT * FROM staff_schedule_series_exceptions WHERE venue_id=$1 AND series_id=$2 AND occurrence_date=$3 AND occurrence_key=$4 AND active FOR UPDATE`,
    [p.venueId,series.id,occurrenceDate,occurrenceKey])).rows[0];
  const payload={scheduleId:after.id,status:after.status,workDate:after.work_date instanceof Date?after.work_date.toISOString().slice(0,10):String(after.work_date).slice(0,10),plannedStart:after.planned_start,plannedEnd:after.planned_end,
    kind:after.kind,breakMinutes:after.break_minutes,preparationMinutes:after.preparation_minutes??null,functionId:after.function_id||null,note:after.note,version:after.version};
  const row=old
    ? (await db.query(`UPDATE staff_schedule_series_exceptions SET exception_kind='manual',payload=$5::jsonb,reason=$6,version=version+1,actor_id=$7,updated_at=now()
        WHERE venue_id=$1 AND series_id=$2 AND occurrence_date=$3 AND occurrence_key=$4 AND active RETURNING *`,
      [p.venueId,series.id,occurrenceDate,occurrenceKey,JSON.stringify(payload),reason.trim(),p.userId])).rows[0]
    : (await db.query(`INSERT INTO staff_schedule_series_exceptions(venue_id,series_id,occurrence_date,occurrence_key,exception_kind,payload,reason,actor_id)
        VALUES($1,$2,$3,$4,'manual',$5::jsonb,$6,$7) RETURNING *`,
      [p.venueId,series.id,occurrenceDate,occurrenceKey,JSON.stringify(payload),reason.trim(),p.userId])).rows[0];
  await db.query('UPDATE staff_schedule_series SET version=version+1,updated_at=now() WHERE venue_id=$1 AND id=$2',[p.venueId,series.id]);
  await db.query(`INSERT INTO staff_schedule_config_events(venue_id,actor_id,entity_type,entity_id,action,before_data,after_data)
    VALUES($1,$2,'series_exception',$3,'manual-override',$4::jsonb,$5::jsonb)`,[p.venueId,p.userId,row.id,old?JSON.stringify(old):JSON.stringify(before),JSON.stringify(row)]);
  return row;
}
async function readSeries(pool,p,id=null){
  const access=await resolveAccess(pool,p);if(!access.view)fail('schedule_forbidden',403);
  if(id)return rowDTO(await get(pool,p.venueId,uuid(id)));
  const rows=(await pool.query('SELECT id FROM staff_schedule_series WHERE venue_id=$1 ORDER BY anchor_date DESC,created_at DESC,id',[p.venueId])).rows;
  return {items:await Promise.all(rows.map(async item=>rowDTO(await get(pool,p.venueId,item.id))))};
}
async function saveSeries(pool,p,id,input,method){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('schedule_series_input_invalid');
  if(!UUID.test(String(input.requestKey||'')))fail('schedule_request_key_required');
  const requestKey=input.requestKey.toLowerCase(),db=await pool.connect();
  try{
    await beginPayrollSourceProducerTransaction(db, p.venueId);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`schedule:${p.venueId}`]);
    const access=await resolveAccess(db,p,true);if(!access.manage)fail('schedule_forbidden',403);
    const fingerprint=hash({...input,requestKey:undefined});
    const replay=(await db.query('SELECT fingerprint,response FROM staff_schedule_requests WHERE venue_id=$1 AND actor_id=$2 AND request_key=$3',[p.venueId,p.userId,requestKey])).rows[0];
    if(replay){if(replay.fingerprint!==fingerprint)fail('schedule_request_conflict',409);await db.query('COMMIT');return replay.response;}
    const before=id?await get(db,p.venueId,uuid(id),true):null;
    if(method==='PATCH'&&!before)fail('schedule_series_not_found',404);
    if(before&&version(input.version)!==before.version)fail('schedule_series_version_conflict',409);
    if(!before&&method!=='POST')fail('schedule_series_not_found',404);
    // Series slots have stable keys, unlike template slots. Resolve omitted
    // overrides before normalization; explicit null and zero always win.
    let nextInput=input;
    if(before&&Array.isArray(input.recurrence?.slots)){
      const slots=input.recurrence.slots.map((slot,index)=>{
        if(!slot||slot.preparationMinutes!==undefined||(slot.kind||'shift')!=='shift')return slot;
        const incomingKey=input.recurrence.slotKeys?.[index];
        const oldIndex=before.recurrence.slotKeys.indexOf(typeof incomingKey==='string'?incomingKey.toLowerCase():incomingKey);
        if(oldIndex<0){
          if(before.recurrence.slots.some(old=>old.preparationMinutes!=null))fail('schedule_preparation_slot_ambiguous');
          return slot;
        }
        const old=before.recurrence.slots[oldIndex];
        return old.preparationMinutes===undefined?slot:{...slot,preparationMinutes:old.preparationMinutes};
      });
      nextInput={...input,recurrence:{...input.recurrence,slots}};
    }
    if(before&&Array.isArray(input.exceptions))nextInput={...nextInput,exceptions:input.exceptions.map(item=>{
      if(!item||item.kind!=='replace'||!item.slot||item.slot.preparationMinutes!==undefined||(item.slot.kind||'shift')!=='shift')return item;
      const old=before.exceptions.find(ex=>ex.kind==='replace'&&ex.occurrenceDate===item.occurrenceDate&&ex.occurrenceKey===String(item.occurrenceKey).toLowerCase());
      return old?.slot?.preparationMinutes===undefined?item:{...item,slot:{...item.slot,preparationMinutes:old.slot.preparationMinutes}};
    })};
    const value=domain.normalizeSeries(nextInput,access.timezone,before);
    const person=(await db.query('SELECT id FROM users WHERE venue_id=$1 AND id=$2 AND is_active AND deleted_at IS NULL FOR SHARE',[p.venueId,value.userId])).rows[0];
    if(!person)fail('planning_employee_not_found',404);
    if(value.functionId){
      const qualified=(await db.query(`SELECT 1 FROM staff_schedule_employee_functions ef JOIN staff_schedule_functions f ON f.venue_id=ef.venue_id AND f.id=ef.function_id
        WHERE ef.venue_id=$1 AND ef.user_id=$2 AND ef.function_id=$3 AND ef.active AND f.active`,[p.venueId,value.userId,value.functionId])).rowCount;
      if(!qualified)fail('schedule_employee_function_required',409);
    }
    if(value.timezone!==access.timezone)fail('schedule_timezone_changed',409);
    let saved;
    if(before){
      if(value.userId!==before.user_id)fail('schedule_series_employee_immutable',409);
      saved=(await db.query(`UPDATE staff_schedule_series SET name=$3,function_id=$4,anchor_date=$5,until_date=$6,timezone=$7,recurrence=$8::jsonb,
        overrides='{}'::jsonb,state=$9,version=version+1,updated_at=now() WHERE venue_id=$1 AND id=$2 RETURNING *,anchor_date::text,until_date::text`,
      [p.venueId,before.id,value.name,value.functionId,value.anchorDate,value.untilDate,value.timezone,JSON.stringify(value.recurrence),value.state])).rows[0];
      await db.query(`UPDATE staff_schedule_series_exceptions SET active=false,version=version+1,updated_at=now()
        WHERE venue_id=$1 AND series_id=$2 AND active AND exception_kind<>'manual'`,[p.venueId,before.id]);
    }else{
      saved=(await db.query(`INSERT INTO staff_schedule_series(venue_id,name,user_id,function_id,anchor_date,until_date,timezone,recurrence,overrides,state,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'{}'::jsonb,$9,$10) RETURNING *,anchor_date::text,until_date::text`,
      [p.venueId,value.name,value.userId,value.functionId,value.anchorDate,value.untilDate,value.timezone,JSON.stringify(value.recurrence),value.state,p.userId])).rows[0];
    }
    for(const exception of value.exceptions){
      const old=(await db.query(`SELECT * FROM staff_schedule_series_exceptions WHERE venue_id=$1 AND series_id=$2 AND occurrence_date=$3 AND occurrence_key=$4
        ORDER BY version DESC LIMIT 1 FOR UPDATE`,[p.venueId,saved.id,exception.occurrenceDate,exception.occurrenceKey])).rows[0];
      const exceptionId=old?.id||randomUUID(),exceptionVersion=(old?.version||0)+1;
      const row=(await db.query(`INSERT INTO staff_schedule_series_exceptions(id,venue_id,series_id,occurrence_date,occurrence_key,exception_kind,payload,reason,active,version,actor_id)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,true,$9,$10)
        ON CONFLICT(id) DO UPDATE SET exception_kind=EXCLUDED.exception_kind,payload=EXCLUDED.payload,reason=EXCLUDED.reason,active=true,version=EXCLUDED.version,actor_id=EXCLUDED.actor_id,updated_at=now()
        RETURNING *`,[exceptionId,p.venueId,saved.id,exception.occurrenceDate,exception.occurrenceKey,exception.kind,exception.slot?JSON.stringify(exception.slot):null,exception.reason||value.reason||'Исключение серии',exceptionVersion,p.userId])).rows[0];
      await db.query(`INSERT INTO staff_schedule_config_events(venue_id,actor_id,entity_type,entity_id,action,before_data,after_data)
        VALUES($1,$2,'series_exception',$3,$4,$5::jsonb,$6::jsonb)`,[p.venueId,p.userId,row.id,old?'replace':'create',old?JSON.stringify(old):null,JSON.stringify(row)]);
    }
    const after=await get(db,p.venueId,saved.id);
    await audit(db,p,saved.id,before?'update':'create',before,after);
    const response=rowDTO(after);
    await db.query('INSERT INTO staff_schedule_requests(venue_id,actor_id,request_key,fingerprint,response) VALUES($1,$2,$3,$4,$5::jsonb)',[p.venueId,p.userId,requestKey,fingerprint,JSON.stringify(response)]);
    await db.query('COMMIT');return response;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

module.exports={readSeries,saveSeries,get,rowDTO,markManualOccurrence};
