'use strict';

const crypto = require('node:crypto');
const { calendarPeriod, pricePeriod, policyFor } = require('./finance-recurring-calculation');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isoDate = (value) => { const raw=String(value||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(raw))return false;const parsed=new Date(`${raw}T00:00:00Z`);return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===raw; };
const monthKey = (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));
const moneyCents = (value) => {
  const raw = String(value ?? '').trim().replace(',', '.');
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};
const centsText = (value) => { const cents=Math.trunc(value);const sign=cents<0?'-':'';const absolute=Math.abs(cents);return `${sign}${Math.floor(absolute/100)}.${String(absolute%100).padStart(2,'0')}`; };
const centsNumber = (value) => Number(value || 0);
const accountMethodsByKind = Object.freeze({
  pos_cashbox: ['cash'],
  cash: ['cash'],
  bank: ['bank_transfer','card','other'],
  electronic: ['card','qr','other'],
});

const recurringGenerationPreview = async (client, venueId, rule, from, to, lockExisting = false) => {
  if (lockExisting) await client.query(`SELECT id FROM finance_payables WHERE venue_id=$1 AND recurring_rule_id=$2
    AND period_key BETWEEN $3 AND $4 ORDER BY period_key,id FOR UPDATE`, [venueId,rule.id,from,to]);
  const [versionsResult,payablesResult] = await Promise.all([
    client.query(`SELECT id,version_number AS "versionNumber",effective_from::text AS "effectiveFrom",amount::text,lines,variable_amount AS "variableAmount"
      FROM finance_recurring_rule_versions WHERE venue_id=$1 AND rule_id=$2 AND effective_from<=$3::date ORDER BY effective_from,version_number`, [venueId,rule.id,`${to}-01`]),
    client.query(`SELECT p.id,p.period_key AS "periodKey",p.period_from::text AS "periodFrom",p.period_to::text AS "periodTo",p.due_date::text AS "dueDate",
      p.recurring_version_id AS "recurringVersionId",p.total_amount::text AS "totalAmount",p.status,finance_payable_settled_amount(p.venue_id,p.id)::text AS "settledAmount",COALESCE(pay.paid,0)::numeric(14,2)::text AS "paidAmount",(SELECT COALESCE(SUM(amount),0)::text FROM finance_expense_refunds WHERE venue_id=p.venue_id AND payable_id=p.id) AS "refundedAmount",
      COALESCE(ln.lines,'[]'::jsonb) AS lines FROM finance_payables p
      LEFT JOIN LATERAL(SELECT SUM(applied_amount) AS paid FROM finance_payable_payment_links WHERE venue_id=p.venue_id AND payable_id=p.id) pay ON true
      LEFT JOIN LATERAL(SELECT jsonb_agg(jsonb_build_object('description',description_snapshot,'amount',amount::text) ORDER BY ordinal,id) AS lines
        FROM finance_payable_lines WHERE venue_id=p.venue_id AND payable_id=p.id) ln ON true
      WHERE p.venue_id=$1 AND p.recurring_rule_id=$2 AND p.period_key BETWEEN $3 AND $4 ORDER BY p.period_key,p.id`, [venueId,rule.id,from,to]),
  ]);
  const versions=versionsResult.rows.map((version)=>({...version,effectiveFrom:String(version.effectiveFrom).slice(0,10),amount:String(version.amount)}));
  const existingByPeriod=new Map(payablesResult.rows.map((row)=>[row.periodKey,row]));
  const startsOn=String(rule.starts_on||rule.startsOn).slice(0,10);const endsOn=rule.ends_on||rule.endsOn?String(rule.ends_on||rule.endsOn).slice(0,10):null;
  const periods=[];const snapshotExisting=[];let proposedCents=0;
  const start=new Date(`${from}-01T00:00:00Z`);const stop=new Date(`${to}-01T00:00:00Z`);
  while(start<=stop){
    const key=`${start.getUTCFullYear()}-${String(start.getUTCMonth()+1).padStart(2,'0')}`;
    const window=calendarPeriod(rule,key);const {periodFrom,periodTo}=window;
    let disposition='create_draft';let reason=null;let version=null;const existing=existingByPeriod.get(key)||null;
    if(!window.eligible){disposition='excluded';reason='outside_rule_term';}
    else {
      version=[...versions].reverse().find((candidate)=>candidate.effectiveFrom<=window.calendarFrom)||null;
      if(!version){disposition='excluded';reason='no_effective_version';}
      else if(existing){disposition='already_exists';reason='existing_document';}
    }
    if(existing)snapshotExisting.push({id:existing.id,periodKey:key,periodFrom:existing.periodFrom,periodTo:existing.periodTo,dueDate:existing.dueDate,
      recurringVersionId:existing.recurringVersionId,totalAmount:existing.totalAmount,status:existing.status,paidAmount:existing.paidAmount,refundedAmount:existing.refundedAmount,settledAmount:existing.settledAmount,lines:existing.lines});
    const period={periodKey:key,periodFrom:window.eligible?periodFrom:window.calendarFrom,periodTo:window.eligible?periodTo:window.calendarTo,dueDate:window.dueDate,partialMonthPolicy:window.policy,coveredDays:window.coveredDays,monthDays:window.monthDays,disposition,reason};
    if(version){period.versionId=version.id;period.versionNumber=Number(version.versionNumber);Object.assign(period,pricePeriod(window,version));period.monthlyAmount=String(version.amount);period.variableAmount=Boolean(version.variableAmount);}
    if(existing){period.payableId=existing.id;period.status=existing.status;period.existingAmount=existing.totalAmount;period.paidAmount=existing.paidAmount;period.refundedAmount=existing.refundedAmount||'0.00';period.settledAmount=existing.settledAmount??centsText((moneyCents(existing.paidAmount)||0)-(moneyCents(existing.refundedAmount)||0));period.balanceDue=existing.status==='cancelled'?'0.00':centsText((moneyCents(existing.totalAmount)||0)-(moneyCents(period.settledAmount)||0));}
    if(disposition==='create_draft')proposedCents+=moneyCents(period.amount)||0;
    periods.push(period);start.setUTCMonth(start.getUTCMonth()+1);
  }
  const snapshot={venueId,rule:{id:rule.id,categoryId:rule.category_id||rule.categoryId,categoryName:rule.category_name||rule.categoryName,
    categoryActive:rule.category_active??rule.categoryActive,title:rule.title,counterpartyName:rule.counterparty_name||rule.counterpartyName||'',basis:rule.basis||'',
    dayOfMonth:Number(rule.day_of_month||rule.dayOfMonth),partialMonthPolicy:policyFor(rule),startsOn,endsOn,status:rule.status},from,to,versions,existing:snapshotExisting,periods};
  const previewToken=crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return{ruleId:rule.id,from,to,venueToday:rule.venue_today||rule.venueToday||null,periods,missingCount:periods.filter((period)=>period.disposition==='create_draft').length,
    alreadyExistsCount:periods.filter((period)=>period.disposition==='already_exists').length,excludedCount:periods.filter((period)=>period.disposition==='excluded').length,
    proposedAmount:centsText(proposedCents),previewToken};
};

const recurringEndDateImpact = async (client, venueId, rule, proposedEndsOn, lockPayables = false) => {
  const currentMonthResult = await client.query("SELECT date_trunc('month',now() AT TIME ZONE timezone)::date::text AS month FROM venues WHERE id=$1", [venueId]);
  const currentMonth = String(currentMonthResult.rows[0]?.month || '').slice(0,7);
  const latestVersionResult = await client.query('SELECT id FROM finance_recurring_rule_versions WHERE venue_id=$1 AND rule_id=$2 ORDER BY effective_from DESC,version_number DESC LIMIT 1', [venueId,rule.id]);
  const payablesResult = await client.query(`SELECT p.id,p.title,p.status,p.period_key,p.period_from::text AS period_from,p.period_to::text AS period_to,p.total_amount::text AS total_amount,finance_payable_settled_amount(p.venue_id,p.id)::text AS settled_amount
    FROM finance_payables p WHERE p.venue_id=$1 AND p.recurring_rule_id=$2 ORDER BY p.period_key,p.id${lockPayables?' FOR UPDATE OF p':''}`, [venueId,rule.id]);
  const payableIds=payablesResult.rows.map((row)=>row.id);
  const paymentsResult=payableIds.length?await client.query(`SELECT payable_id,COALESCE(SUM(applied_amount),0)::numeric(14,2)::text AS paid_amount,(SELECT COALESCE(SUM(amount),0)::text FROM finance_expense_refunds r WHERE r.venue_id=$1 AND r.payable_id=finance_payable_payment_links.payable_id) AS refunded_amount
    FROM finance_payable_payment_links WHERE venue_id=$1 AND payable_id=ANY($2::uuid[]) GROUP BY payable_id`,[venueId,payableIds]):{rows:[]};
  const paidByPayable=new Map(paymentsResult.rows.map((row)=>[row.payable_id,row.paid_amount]));
  const refundedByPayable=new Map(paymentsResult.rows.map((row)=>[row.payable_id,row.refunded_amount]));
  const startsOn=String(rule.starts_on).slice(0,10);const currentEndsOn=rule.ends_on?String(rule.ends_on).slice(0,10):null;
  const windowFor=(key,endsOn)=>calendarPeriod({...rule,ends_on:endsOn,endsOn},key);
  const sameCoverage=(before,after)=>before.eligible===after.eligible&&(!before.eligible||(before.periodFrom===after.periodFrom&&before.periodTo===after.periodTo));
  const partialVersions=policyFor(rule)==='calendar_days'?(await client.query('SELECT effective_from::text AS "effectiveFrom",amount::text,lines FROM finance_recurring_rule_versions WHERE venue_id=$1 AND rule_id=$2 ORDER BY effective_from DESC,version_number DESC',[venueId,rule.id])).rows:[];
  const amountFor=window=>{if(!window.eligible)return null;const version=partialVersions.find(item=>item.effectiveFrom<=window.calendarFrom);return version?pricePeriod(window,version).amount:null;};
  const affectedPayables=payablesResult.rows.flatMap((row)=>{
    const previous=windowFor(row.period_key,currentEndsOn),proposed=windowFor(row.period_key,proposedEndsOn);
    if(sameCoverage(previous,proposed))return[];
    const paidCents=moneyCents(paidByPayable.get(row.id)||'0');const totalCents=moneyCents(row.total_amount);
    return[{id:row.id,title:row.title,status:row.status,periodKey:row.period_key,periodFrom:String(row.period_from).slice(0,10),periodTo:String(row.period_to).slice(0,10),totalAmount:centsText(totalCents),paidAmount:centsText(paidCents),refundedAmount:refundedByPayable.get(row.id)||'0.00',settledAmount:row.settled_amount??centsText(paidCents-(moneyCents(refundedByPayable.get(row.id))||0)),balanceDue:row.status==='cancelled'?'0.00':centsText(totalCents-(moneyCents(row.settled_amount)??(paidCents-(moneyCents(refundedByPayable.get(row.id))||0)))),previouslyGeneratable:previous.eligible,proposedGeneratable:proposed.eligible,proposedServiceFrom:proposed.periodFrom,proposedServiceTo:proposed.periodTo,proposedAmount:amountFor(proposed)}];
  });
  const periodChanges=[];const candidateMonths=new Set();
  if(monthKey(currentMonth)){
    const cursor=new Date(currentMonth+'-01T00:00:00Z');
    for(let index=0;index<12;index++){candidateMonths.add(cursor.toISOString().slice(0,7));cursor.setUTCMonth(cursor.getUTCMonth()+1);}
    // Always disclose contract boundaries, even when the end date lies beyond the 12-month horizon.
    for(const date of [startsOn,currentEndsOn,proposedEndsOn])if(date&&date.slice(0,7)>=currentMonth)candidateMonths.add(date.slice(0,7));
    for(const key of [...candidateMonths].sort()){
      const previous=windowFor(key,currentEndsOn),proposed=windowFor(key,proposedEndsOn);
      if(!sameCoverage(previous,proposed))periodChanges.push({periodKey:key,periodFrom:proposed.calendarFrom,periodTo:proposed.calendarTo,availability:previous.eligible&&proposed.eligible?'coverage_changes':proposed.eligible?'becomes_available':'becomes_unavailable',previousAmount:amountFor(previous),proposedAmount:amountFor(proposed),proposedServiceFrom:proposed.periodFrom,proposedServiceTo:proposed.periodTo});
    }
  }
  const impact={venueId,ruleId:rule.id,currentEndsOn,proposedEndsOn,startsOn,partialMonthPolicy:policyFor(rule),status:rule.status,currentMonth,horizonMonths:12,latestVersionId:latestVersionResult.rows[0]?.id||null,periodChanges,affectedPayables};
  const impactToken=crypto.createHash('sha256').update(JSON.stringify(impact)).digest('hex');
  return{...impact,impactToken,willRewriteExisting:false};
};

const recurringVersionPreview = async (client, venueId, rule, effectiveFrom, proposedCents, normalizedLines, variableAmount, lockPayables = false) => {
  if (lockPayables) await client.query(`SELECT id FROM finance_payables WHERE venue_id=$1 AND recurring_rule_id=$2 AND period_from >= $3::date ORDER BY period_key,id FOR UPDATE`, [venueId,rule.id,effectiveFrom]);
  const [latestResult,priorResult,payablesResult,paymentsResult,linesResult] = await Promise.all([
    client.query(`SELECT id,version_number AS "versionNumber",effective_from::text AS "effectiveFrom",amount::text FROM finance_recurring_rule_versions WHERE venue_id=$1 AND rule_id=$2 ORDER BY effective_from DESC,version_number DESC LIMIT 1`, [venueId,rule.id]),
    client.query(`SELECT id,version_number AS "versionNumber",effective_from::text AS "effectiveFrom",amount::text,lines FROM finance_recurring_rule_versions WHERE venue_id=$1 AND rule_id=$2 AND effective_from<$3::date ORDER BY effective_from DESC,version_number DESC LIMIT 1`, [venueId,rule.id,effectiveFrom]),
    client.query(`SELECT p.id,p.period_key AS "periodKey",p.period_from::text AS "periodFrom",p.period_to::text AS "periodTo",p.due_date::text AS "dueDate",p.recurring_version_id AS "recurringVersionId",p.total_amount::text AS "totalAmount",p.status FROM finance_payables p WHERE p.venue_id=$1 AND p.recurring_rule_id=$2 AND p.period_from >= $3::date ORDER BY p.period_key,p.id`, [venueId,rule.id,effectiveFrom]),
    client.query(`SELECT l.payable_id,COALESCE(SUM(l.applied_amount),0)::numeric(14,2)::text AS "paidAmount" FROM finance_payable_payment_links l JOIN finance_payables p ON p.venue_id=l.venue_id AND p.id=l.payable_id WHERE l.venue_id=$1 AND p.recurring_rule_id=$2 AND p.period_from >= $3::date GROUP BY l.payable_id`, [venueId,rule.id,effectiveFrom]),
    client.query(`SELECT l.payable_id,l.description_snapshot AS description,l.amount::text,l.ordinal FROM finance_payable_lines l JOIN finance_payables p ON p.venue_id=l.venue_id AND p.id=l.payable_id WHERE l.venue_id=$1 AND p.recurring_rule_id=$2 AND p.period_from >= $3::date ORDER BY l.payable_id,l.ordinal,l.id`, [venueId,rule.id,effectiveFrom]),
  ]);
  const latest=latestResult.rows[0]||null;const prior=priorResult.rows[0]||null;
  const paidByPayable=new Map(paymentsResult.rows.map((row)=>[row.payable_id,row.paidAmount]));
  const linesByPayable=new Map();for(const line of linesResult.rows){const key=line.payable_id;const lines=linesByPayable.get(key)||[];lines.push({description:line.description,amount:line.amount});linesByPayable.set(key,lines);}
  const existing=payablesResult.rows.map((row)=>({...row,paidAmount:paidByPayable.get(row.id)||'0.00',lines:linesByPayable.get(row.id)||[]}));
  const existingByPeriod=new Map(existing.map((row)=>[row.periodKey||String(row.periodFrom).slice(0,7),row]));
  const currentAmount=prior?.amount||'0.00';const projectedPeriods=[];const start=new Date(`${effectiveFrom}T00:00:00Z`);
  for(let offset=0;offset<12;offset++){
    const cursor=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+offset,1));const periodKey=`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth()+1).padStart(2,'0')}`;const periodFrom=`${periodKey}-01`;const periodTo=new Date(Date.UTC(cursor.getUTCFullYear(),cursor.getUTCMonth()+1,0)).toISOString().slice(0,10);
    const window=calendarPeriod(rule,periodKey);if(!window.eligible)break;
    const priced=pricePeriod(window,{amount:centsText(proposedCents),lines:normalizedLines.map(line=>({description:line.description,amount:centsText(line.cents)}))});
    const old=existingByPeriod.get(periodKey);
    const previousAmount=old?.totalAmount||pricePeriod(window,{amount:currentAmount,lines:prior?.lines?.length?prior.lines:[{description:'Предыдущая ставка',amount:currentAmount}]}).amount;
    projectedPeriods.push({periodKey,periodFrom:window.periodFrom,periodTo:window.periodTo,coveredDays:window.coveredDays,monthDays:window.monthDays,prorationSnapshot:priced.prorationSnapshot,disposition:old?'preserve_existing':'new_version_on_generation',existingPayableId:old?.id||null,status:old?.status||null,existingAmount:old?String(old.totalAmount):null,previousVersionAmount:String(previousAmount),proposedAmount:priced.amount,deltaFromPreviousVersion:centsText((moneyCents(priced.amount)||0)-(moneyCents(previousAmount)||0)),paidAmount:old?String(old.paidAmount||'0.00'):'0.00'});
    existingByPeriod.delete(periodKey);
  }
  const normalizedCandidate={effectiveFrom,amount:centsText(proposedCents),lines:normalizedLines.map((line)=>({description:line.description,amount:centsText(line.cents)})),variableAmount:Boolean(variableAmount)};
  const state={rule:{id:rule.id,partialMonthPolicy:policyFor(rule),startsOn:String(rule.startsOn||rule.starts_on).slice(0,10),endsOn:rule.endsOn||rule.ends_on?String(rule.endsOn||rule.ends_on).slice(0,10):null,status:rule.status},latestVersion:latest,priorVersion:prior,existing};
  const previewToken=crypto.createHash('sha256').update(JSON.stringify({candidate:normalizedCandidate,state})).digest('hex');
  return{effectiveFrom,horizonMonths:projectedPeriods.length,currentVersionAmount:String(currentAmount),proposedAmount:centsText(proposedCents),willRewriteExisting:false,appliesTo:'newly_generated_periods',projectedPeriods,preservedExistingPeriods:[...existingByPeriod.values()],projectionTruncated:!rule.endsOn&&!rule.ends_on||projectedPeriods.length===12,previewToken};
};

const fail = (json, res, status, error) => { json(res, status, { error }); return true; };
const createRequestHash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const claimCreateIdempotency = async (client, venueId, operation, key, requestHash, actorId) => {
  const inserted = await client.query(`INSERT INTO finance_create_idempotency
    (venue_id,operation,idempotency_key,request_sha256,created_by)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(venue_id,operation,idempotency_key) DO NOTHING RETURNING id`,
  [venueId,operation,key,requestHash,actorId||null]);
  if (inserted.rows[0]) return { owner:true };
  const existing = await client.query(`SELECT request_sha256,entity_id,response
    FROM finance_create_idempotency WHERE venue_id=$1 AND operation=$2 AND idempotency_key=$3 FOR UPDATE`,
  [venueId,operation,key]);
  if (!existing.rows[0]) throw new Error('finance_create_idempotency_claim_missing');
  if (existing.rows[0].request_sha256 !== requestHash) return { conflict:true };
  if (!existing.rows[0].entity_id || !existing.rows[0].response) throw new Error('finance_create_idempotency_incomplete');
  return { replay:true,response:existing.rows[0].response };
};
const completeCreateIdempotency = async (client, venueId, operation, key, entityId, response) => {
  const result=await client.query(`UPDATE finance_create_idempotency SET entity_id=$1,response=$2::jsonb
    WHERE venue_id=$3 AND operation=$4 AND idempotency_key=$5 AND entity_id IS NULL`,
  [entityId,JSON.stringify(response),venueId,operation,key]);
  if(result.rowCount!==1)throw new Error('finance_create_idempotency_completion_failed');
};

async function handleFinancePayableRoute({ req, res, url, pool, venueId, json, readBody, hasPermission, recordAudit }) {
  const path = url.pathname;
  const accountsPath = path === '/api/finance/accounts';
  const accountPath = path.match(/^\/api\/finance\/accounts\/([^/]+)$/);
  const listPath = path === '/api/finance/payables';
  const itemPath = path.match(/^\/api\/finance\/payables\/([^/]+)(?:\/(payments))?$/);
  const rulesPath = path === '/api/finance/recurring-rules';
  const rulePath = path.match(/^\/api\/finance\/recurring-rules\/([^/]+)(?:\/(versions(?:\/preview)?|generate(?:-preview)?|end-date-preview))?$/);
  if (!accountsPath && !accountPath && !listPath && !itemPath && !rulesPath && !rulePath) return false;
  if (!hasPermission('finance') && !hasPermission('finance_read')) return fail(json, res, 403, 'forbidden');
  if (req.method === 'GET' && ['bartender','hookah_master','senior_bartender','senior_hookah_master','cleaner','security','technician','other_staff','staff'].includes(String(req.user?.role || '').toLowerCase())) return fail(json,res,403,'forbidden');
  if (req.method !== 'GET' && !hasPermission('finance')) return fail(json, res, 403, 'forbidden');
  if (!pool) return fail(json, res, 503, 'finance_database_required');

  if (accountsPath && req.method === 'GET') {
    try {
      const activeOnly = url.searchParams.get('active') !== 'false';
      const { rows } = await pool.query(`SELECT id,name,kind,allowed_payment_methods AS "allowedPaymentMethods",active,code
        FROM finance_accounts WHERE venue_id=$1 AND code<>'pos_card_receipts' AND ($2::boolean=false OR active=true) ORDER BY active DESC,kind,code,id`, [venueId,activeOnly]);
      return json(res,200,{ items:rows });
    } catch (error) { return json(res,503,{error:'finance_accounts_unavailable',detail:error.message}); }
  }

  if (accountsPath && req.method === 'POST') {
    const input=await readBody(req);const name=String(input.name||'').trim();const kind=String(input.kind||'');
    const allowed=accountMethodsByKind[kind];const requested=Array.isArray(input.allowedPaymentMethods)?[...new Set(input.allowedPaymentMethods.map(String))]:allowed;
    if(name.length<1||name.length>120||!allowed||kind==='pos_cashbox'||!requested.length||requested.some((method)=>!allowed.includes(method)))return fail(json,res,400,'invalid_finance_account');
    const code=`custom_${crypto.randomUUID()}`;
    try{const {rows}=await pool.query(`INSERT INTO finance_accounts(venue_id,code,name,kind,allowed_payment_methods,created_by)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,kind,allowed_payment_methods AS "allowedPaymentMethods",active,code`,[venueId,code,name,kind,requested,req.user?.id||null]);
      recordAudit?.(req,'finance.account_created','finance_account',rows[0].id,null,rows[0]);return json(res,201,rows[0]);
    }catch(error){return json(res,error.code==='23514'?400:503,{error:error.code==='23514'?error.message:'finance_account_create_failed'});}
  }

  if (accountPath && req.method === 'PATCH') {
    const id=decodeURIComponent(accountPath[1]);if(!uuid.test(id))return fail(json,res,404,'finance_account_not_found');
    const input=await readBody(req);if(typeof input.active!=='boolean'&&input.name===undefined)return fail(json,res,400,'invalid_finance_account_update');
    const name=input.name===undefined?null:String(input.name||'').trim();if(name!==null&&(name.length<1||name.length>120))return fail(json,res,400,'invalid_finance_account_name');
    const client=await pool.connect();
    try{await client.query('BEGIN');const current=await client.query('SELECT id,code,name,kind,active FROM finance_accounts WHERE venue_id=$1 AND id=$2 FOR UPDATE',[venueId,id]);
      if(!current.rows[0]){await client.query('ROLLBACK');return fail(json,res,404,'finance_account_not_found');}
      if(current.rows[0].code==='main_cashbox'&&input.active===false){await client.query('ROLLBACK');return fail(json,res,409,'finance_default_cashbox_cannot_be_archived');}
      if(current.rows[0].code==='pos_card_receipts'&&input.active===false){await client.query('ROLLBACK');return fail(json,res,409,'finance_system_account_cannot_be_archived');}
      const {rows}=await client.query(`UPDATE finance_accounts SET name=COALESCE($1,name),active=COALESCE($2,active),updated_at=now()
        WHERE venue_id=$3 AND id=$4 RETURNING id,name,kind,allowed_payment_methods AS "allowedPaymentMethods",active,code`,[name,input.active??null,venueId,id]);
      await client.query('COMMIT');recordAudit?.(req,rows[0].active?'finance.account_updated':'finance.account_archived','finance_account',id,current.rows[0],rows[0]);return json(res,200,rows[0]);
    }catch(error){await client.query('ROLLBACK').catch(()=>{});const status=['23514','55000','23505'].includes(error.code)?409:503;return json(res,status,{error:error.message==='finance_account_used_cannot_be_reactivated'?error.message:'finance_account_update_failed'});}
    finally{client.release();}
  }

  if (listPath && req.method === 'GET') {
    const from = String(url.searchParams.get('from') || '1900-01-01');
    const to = String(url.searchParams.get('to') || '2999-12-31');
    const status = String(url.searchParams.get('status') || '');
    const includeOverdueParam=url.searchParams.get('includeOverdue');const includeOverdue=includeOverdueParam==='true';
    if (!isoDate(from) || !isoDate(to) || from > to || (status && !['draft','approved','cancelled'].includes(status)) || (includeOverdueParam!==null&&!['true','false'].includes(includeOverdueParam))) return fail(json, res, 400, 'invalid_finance_payable_filter');
    let client;
    try {
      client=await pool.connect();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const venueClock=includeOverdue?await client.query('SELECT (now() AT TIME ZONE timezone)::date::text AS date FROM venues WHERE id=$1',[venueId]):{rows:[]};
      const venueToday=venueClock.rows[0]?.date||null;
      const { rows } = await client.query(`SELECT p.id,p.category_id AS "categoryId",p.category_name_snapshot AS "categoryName",p.title,
        p.counterparty_name AS "counterpartyName",p.basis,p.period_from::text AS "periodFrom",p.period_to::text AS "periodTo",p.due_date::text AS "dueDate",
        p.total_amount AS "totalAmount",p.proration_snapshot AS "prorationSnapshot",p.status,p.recurring_rule_id AS "recurringRuleId",p.recurring_version_id AS "recurringVersionId",rv.version_number AS "recurringVersionNumber",p.period_key AS "periodKey",
        $5::date::text AS "venueToday",(p.status='approved' AND p.due_date<$5::date AND p.total_amount>finance_payable_settled_amount(p.venue_id,p.id)) AS "isOverdue",
        COALESCE(rv.variable_amount,false) AS "variableAmount",p.variable_amount_confirmed_at::text AS "variableAmountConfirmedAt",p.variable_amount_confirmed_by AS "variableAmountConfirmedBy",
        finance_payable_settled_amount(p.venue_id,p.id) AS "settledAmount",
        (SELECT COALESCE(SUM(amount),0) FROM finance_payable_offsets WHERE venue_id=p.venue_id AND destination_payable_id=p.id) AS "creditedInAmount",
        (SELECT COALESCE(SUM(amount),0) FROM finance_payable_offsets WHERE venue_id=p.venue_id AND source_payable_id=p.id) AS "creditedOutAmount",
        COALESCE(x.paid,0)::numeric(14,2) AS "paidAmount",COALESCE(x.returned,0)::numeric(14,2) AS "refundedAmount",(COALESCE(x.paid,0)-COALESCE(x.returned,0))::numeric(14,2) AS "netPaidAmount",
        (CASE WHEN p.status='cancelled' THEN 0 ELSE p.total_amount-finance_payable_settled_amount(p.venue_id,p.id) END)::numeric(14,2) AS "balanceDue",
        CASE WHEN r.id IS NULL THEN 'not_recognized' WHEN r.amount-COALESCE(r.reversed,0)=0 THEN 'reversed' WHEN r.reversed>0 THEN 'partially_reversed' ELSE 'recognized' END AS "recognitionStatus",r.id AS "recognitionId",
        CASE WHEN p.status='cancelled' THEN 'not_payable' WHEN finance_payable_settled_amount(p.venue_id,p.id)=0 THEN 'unpaid' WHEN finance_payable_settled_amount(p.venue_id,p.id)<p.total_amount THEN 'partially_paid' ELSE 'paid' END AS "paymentStatus",
        COALESCE(r.amount,0)::numeric(14,2) AS "recognizedAmount",COALESCE(r.reversed,0)::numeric(14,2) AS "reversedRecognitionAmount",
        (COALESCE(r.amount,0)-COALESCE(r.reversed,0))::numeric(14,2) AS "netRecognizedAmount",r.recognition_date::text AS "recognitionDate",r.history AS "recognitionHistory",
        COALESCE(x.payments,'[]'::jsonb) AS payments,
        COALESCE(l.lines,'[]'::jsonb) AS lines
        FROM finance_payables p
        LEFT JOIN LATERAL (SELECT SUM(link.applied_amount) AS paid,SUM(COALESCE(refunds.amount,0)) AS returned,
          jsonb_agg(jsonb_build_object('expenseId',e.id,'amount',e.amount,'refundedAmount',COALESCE(refunds.amount,0),'paymentDate',e.expense_date::text,'paymentMethod',e.payment_method,'paymentAccountId',e.finance_account_id,'paymentAccountNameSnapshot',e.finance_account_name_snapshot,'shiftId',e.shift_id,'accountCoverage',CASE WHEN e.finance_account_id IS NULL THEN 'unknown_legacy' ELSE 'assigned' END,'description',e.description) ORDER BY e.expense_date,e.created_at) AS payments
          FROM finance_payable_payment_links link JOIN expenses e ON e.venue_id=link.venue_id AND e.id=link.expense_id
          LEFT JOIN LATERAL(SELECT SUM(amount) AS amount FROM finance_expense_refunds WHERE venue_id=link.venue_id AND expense_id=link.expense_id) refunds ON true
          WHERE link.venue_id=p.venue_id AND link.payable_id=p.id) x ON true
        LEFT JOIN LATERAL(SELECT source.id,source.amount,source.recognition_date,COALESCE(SUM(reversal.amount),0)::numeric(14,2) AS reversed,
          jsonb_build_object('recognition',jsonb_build_object('date',source.recognition_date::text,'documentReference',source.document_reference,'createdBy',source.created_by,'recordedAt',source.created_at),
            'reversals',COALESCE(jsonb_agg(jsonb_build_object('amount',reversal.amount,'date',reversal.reversal_date::text,'reason',reversal.reason,'documentReference',reversal.document_reference,'createdBy',reversal.created_by,'recordedAt',reversal.created_at) ORDER BY reversal.reversal_date,reversal.created_at,reversal.id) FILTER (WHERE reversal.id IS NOT NULL),'[]'::jsonb)) AS history
          FROM finance_payable_recognitions source LEFT JOIN finance_payable_recognition_reversals reversal ON reversal.venue_id=source.venue_id AND reversal.recognition_id=source.id
          WHERE source.venue_id=p.venue_id AND source.payable_id=p.id GROUP BY source.venue_id,source.id) r ON true
        LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('description',ln.description_snapshot,'amount',ln.amount) ORDER BY ln.ordinal) AS lines
          FROM finance_payable_lines ln WHERE ln.venue_id=p.venue_id AND ln.payable_id=p.id) l ON true
        LEFT JOIN finance_recurring_rule_versions rv ON rv.venue_id=p.venue_id AND rv.rule_id=p.recurring_rule_id AND rv.id=p.recurring_version_id
        WHERE p.venue_id=$1 AND ($4::text='' OR p.status=$4) AND
          (p.due_date BETWEEN $2::date AND $3::date OR ($6::boolean AND ($4::text='' OR $4='approved') AND p.status='approved' AND p.due_date<$5::date AND p.total_amount>finance_payable_settled_amount(p.venue_id,p.id)))
        ORDER BY p.due_date,p.created_at,p.id`, [venueId,from,to,status,venueToday||'2000-01-01',includeOverdue]);
      await client.query('COMMIT');
      if(!includeOverdue)return json(res,200,{items:rows.map(({venueToday:_venueToday,isOverdue:_isOverdue,...item})=>item)});
      const items=rows.filter((item)=>item.dueDate>=from&&item.dueDate<=to);const allOverdue=rows.filter((item)=>item.isOverdue);const overdueItems=allOverdue.filter((item)=>item.dueDate<from||item.dueDate>to);const overdueBalanceCents=allOverdue.reduce((sum,item)=>sum+(moneyCents(item.balanceDue)||0),0);
      return json(res,200,{items,overdue:{asOfDate:venueToday, dateBasis:'venue_local_due_date', items:overdueItems, totalCount:allOverdue.length, totalBalanceDue:centsText(overdueBalanceCents)}});
    } catch (error) { if(client)await client.query('ROLLBACK').catch(()=>{});return json(res, 503, { error: 'finance_payables_unavailable', detail: error.message }); }
    finally{client?.release();}
  }

  if (rulePath && rulePath[2] === 'versions' && req.method === 'GET' && !url.searchParams.has('effectiveFrom')) {
    const id=decodeURIComponent(rulePath[1]);if(!uuid.test(id))return fail(json,res,404,'finance_recurring_rule_not_found');
    try{const rule=await pool.query('SELECT id FROM finance_recurring_rules WHERE venue_id=$1 AND id=$2',[venueId,id]);if(!rule.rows[0])return fail(json,res,404,'finance_recurring_rule_not_found');const versions=await pool.query(`SELECT id,version_number AS "versionNumber",effective_from::text AS "effectiveFrom",amount::text,lines,variable_amount AS "variableAmount",created_by AS "createdBy",created_at AS "createdAt" FROM finance_recurring_rule_versions WHERE venue_id=$1 AND rule_id=$2 ORDER BY effective_from DESC,version_number DESC`,[venueId,id]);return json(res,200,{items:versions.rows});}catch(error){return json(res,503,{error:'finance_recurring_versions_unavailable'});}
  }

  if (listPath && req.method === 'POST') {
    const input = await readBody(req);
    const categoryId = String(input.categoryId || '');
    const title = String(input.title || '').trim();
    const counterparty = String(input.counterpartyName || '').trim();
    const basis = String(input.basis || '').trim();
    const periodFrom = String(input.periodFrom || ''); const periodTo = String(input.periodTo || ''); const dueDate = String(input.dueDate || '');
    const lines = Array.isArray(input.lines) ? input.lines : [];
    const idempotencyKey=String(input.idempotencyKey||'').trim();
    if (!uuid.test(categoryId) || title.length < 1 || title.length > 160 || counterparty.length > 160 || basis.length > 500
      || !isoDate(periodFrom) || !isoDate(periodTo) || !isoDate(dueDate) || periodFrom > periodTo || !lines.length || lines.length > 40
      || idempotencyKey.length<8 || idempotencyKey.length>120) return fail(json, res, 400, 'invalid_finance_payable');
    const normalized = lines.map((line, index) => ({ description: String(line?.description || '').trim(), cents: moneyCents(line?.amount), ordinal: index }));
    if (normalized.some((line) => !line.description || line.description.length > 200 || line.cents === null || line.cents < 0)) return fail(json, res, 400, 'invalid_finance_payable_line');
    const totalCents = normalized.reduce((sum, line) => sum + line.cents, 0);
    if (!totalCents || totalCents > 99999999999999) return fail(json, res, 400, 'invalid_finance_payable_amount');
    const requestHash=createRequestHash({categoryId,title,counterpartyName:counterparty,basis,periodFrom,periodTo,dueDate,lines:normalized.map((line)=>({description:line.description,amount:centsText(line.cents)}))});
    const client = await pool.connect();
    let commitAttempted=false;
    try {
      await client.query('BEGIN');
      const claim=await claimCreateIdempotency(client,venueId,'payable_create',idempotencyKey,requestHash,req.user?.id);
      if(claim.conflict){await client.query('ROLLBACK');return fail(json,res,409,'finance_create_idempotency_conflict');}
      if(claim.replay){commitAttempted=true;await client.query('COMMIT');return json(res,200,claim.response);}
      const category = await client.query("SELECT id,name FROM finance_categories WHERE venue_id=$1 AND id=$2 AND kind='expense' AND active=true FOR KEY SHARE", [venueId,categoryId]);
      if (!category.rows[0]) { await client.query('ROLLBACK'); return fail(json, res, 400, 'invalid_finance_category'); }
      const result = await client.query(`INSERT INTO finance_payables
        (venue_id,category_id,category_name_snapshot,title,counterparty_name,basis,period_from,period_to,due_date,total_amount,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [venueId,categoryId,category.rows[0].name,title,counterparty,basis,periodFrom,periodTo,dueDate,centsText(totalCents),req.user?.id || null]);
      for (const line of normalized) await client.query(`INSERT INTO finance_payable_lines (venue_id,payable_id,description_snapshot,amount,ordinal)
        VALUES ($1,$2,$3,$4,$5)`, [venueId,result.rows[0].id,line.description,centsText(line.cents),line.ordinal]);
      const response={id:result.rows[0].id,status:'draft',totalAmount:centsText(totalCents)};
      await completeCreateIdempotency(client,venueId,'payable_create',idempotencyKey,result.rows[0].id,response);
      commitAttempted=true;
      await client.query('COMMIT');
      recordAudit?.(req,'finance.payable_created','finance_payable',result.rows[0].id,null,{categoryId,title,counterpartyName:counterparty,periodFrom,periodTo,dueDate,totalAmount:centsText(totalCents)});
      return json(res, 201, response);
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, commitAttempted?503:409, { error: commitAttempted?'finance_create_result_unknown':'finance_payable_save_failed' }); }
    finally { client.release(); }
  }

  if (itemPath && !itemPath[2] && req.method === 'PATCH') {
    const id = decodeURIComponent(itemPath[1]); if (!uuid.test(id)) return fail(json, res, 404, 'finance_payable_not_found');
    const input = await readBody(req); const nextStatus = String(input.status || '');
    if (!nextStatus) {
      const categoryId=String(input.categoryId||'');const title=String(input.title||'').trim();const counterparty=String(input.counterpartyName||'').trim();const basis=String(input.basis||'').trim();const periodFrom=String(input.periodFrom||'');const periodTo=String(input.periodTo||'');const dueDate=String(input.dueDate||'');const lines=Array.isArray(input.lines)?input.lines:[];
      const normalized=lines.map((line,index)=>({description:String(line?.description||'').trim(),cents:moneyCents(line?.amount),ordinal:index}));const totalCents=normalized.reduce((sum,line)=>sum+(line.cents||0),0);
      if(!uuid.test(categoryId)||title.length<1||title.length>160||counterparty.length>160||basis.length>500||!isoDate(periodFrom)||!isoDate(periodTo)||!isoDate(dueDate)||periodFrom>periodTo||!normalized.length||normalized.length>40||normalized.some(line=>!line.description||line.description.length>200||line.cents===null||line.cents<0)||!totalCents)return fail(json,res,400,'invalid_finance_payable');
      const client=await pool.connect();try{await client.query('BEGIN');const current=await client.query("SELECT id,status FROM finance_payables WHERE venue_id=$1 AND id=$2 FOR UPDATE",[venueId,id]);if(!current.rows[0]){await client.query('ROLLBACK');return fail(json,res,404,'finance_payable_not_found');}if(current.rows[0].status!=='draft'){await client.query('ROLLBACK');return fail(json,res,409,'finance_payable_not_draft');}const category=await client.query("SELECT id,name FROM finance_categories WHERE venue_id=$1 AND id=$2 AND kind='expense' AND active=true FOR KEY SHARE",[venueId,categoryId]);if(!category.rows[0]){await client.query('ROLLBACK');return fail(json,res,400,'invalid_finance_category');}await client.query(`UPDATE finance_payables SET category_id=$1,category_name_snapshot=$2,title=$3,counterparty_name=$4,basis=$5,period_from=$6,period_to=$7,due_date=$8,total_amount=$9,updated_at=now() WHERE venue_id=$10 AND id=$11`,[categoryId,category.rows[0].name,title,counterparty,basis,periodFrom,periodTo,dueDate,centsText(totalCents),venueId,id]);await client.query('DELETE FROM finance_payable_lines WHERE venue_id=$1 AND payable_id=$2',[venueId,id]);for(const line of normalized)await client.query('INSERT INTO finance_payable_lines (venue_id,payable_id,description_snapshot,amount,ordinal) VALUES ($1,$2,$3,$4,$5)',[venueId,id,line.description,centsText(line.cents),line.ordinal]);await client.query('COMMIT');recordAudit?.(req,'finance.payable_updated','finance_payable',id,null,{categoryId,title,counterpartyName:counterparty,periodFrom,periodTo,dueDate,totalAmount:centsText(totalCents)});return json(res,200,{id,status:'draft',totalAmount:centsText(totalCents)});}catch(error){await client.query('ROLLBACK').catch(()=>{});return json(res,409,{error:'finance_payable_update_failed',detail:error.message});}finally{client.release();}
    }
    if (!['approved','cancelled'].includes(nextStatus)) return fail(json, res, 400, 'invalid_finance_payable_transition');
    if (nextStatus === 'approved') {
      const confirmVariableAmount = input.confirmVariableAmount === true;
      let expectedTotal = null;
      let expectedLines = [];
      if (confirmVariableAmount) {
        expectedTotal = moneyCents(input.expectedTotalAmount);
        const lines = Array.isArray(input.expectedLines) ? input.expectedLines : [];
        expectedLines = lines.map((line) => ({ description:String(line?.description||'').trim(), cents:moneyCents(line?.amount) }));
        if (expectedTotal === null || !expectedLines.length || expectedLines.length > 40
          || expectedLines.some((line) => !line.description || line.description.length > 200 || line.cents === null || line.cents < 0)
          || expectedLines.reduce((sum,line)=>sum+line.cents,0) !== expectedTotal) return fail(json,res,400,'invalid_finance_payable_amount_confirmation');
      }
      if (confirmVariableAmount && !req.user?.id) return fail(json,res,403,'finance_payable_amount_confirmation_actor_required');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const current = await client.query(`SELECT p.status,p.total_amount::text AS "totalAmount",COALESCE(v.variable_amount,false) AS "variableAmount"
          FROM finance_payables p LEFT JOIN finance_recurring_rule_versions v ON v.venue_id=p.venue_id AND v.rule_id=p.recurring_rule_id AND v.id=p.recurring_version_id
          WHERE p.venue_id=$1 AND p.id=$2 FOR UPDATE OF p`,[venueId,id]);
        if (!current.rows[0]) { await client.query('ROLLBACK'); return fail(json,res,404,'finance_payable_not_found_or_not_draft'); }
        if (current.rows[0].status !== 'draft') { await client.query('ROLLBACK'); return fail(json,res,404,'finance_payable_not_found_or_not_draft'); }
        if (current.rows[0].variableAmount) {
          if (!confirmVariableAmount) { await client.query('ROLLBACK'); return fail(json,res,409,'finance_payable_variable_amount_confirmation_required'); }
          const currentLines = await client.query(`SELECT description_snapshot AS description,amount::text AS amount FROM finance_payable_lines
            WHERE venue_id=$1 AND payable_id=$2 ORDER BY ordinal`,[venueId,id]);
          const sameLines = JSON.stringify(currentLines.rows.map((line)=>({description:String(line.description),amount:centsText(moneyCents(line.amount))})))
            === JSON.stringify(expectedLines.map((line)=>({description:line.description,amount:centsText(line.cents)})));
          if (moneyCents(current.rows[0].totalAmount) !== expectedTotal || !sameLines) {
            await client.query('ROLLBACK'); return fail(json,res,409,'finance_payable_amount_changed_retry');
          }
        }
        const { rows } = await client.query(`UPDATE finance_payables SET status='approved',approved_by=$1,approved_at=now(),
          variable_amount_confirmed_by=CASE WHEN $4::boolean THEN $1 ELSE variable_amount_confirmed_by END,
          variable_amount_confirmed_at=CASE WHEN $4::boolean THEN now() ELSE variable_amount_confirmed_at END,updated_at=now()
          WHERE venue_id=$2 AND id=$3 AND status='draft' RETURNING id,status,total_amount AS "totalAmount",
          variable_amount_confirmed_at::text AS "variableAmountConfirmedAt",variable_amount_confirmed_by AS "variableAmountConfirmedBy"`,[req.user?.id||null,venueId,id,Boolean(current.rows[0].variableAmount)]);
        if (!rows[0]) { await client.query('ROLLBACK'); return fail(json,res,404,'finance_payable_not_found_or_not_draft'); }
        await client.query('COMMIT');
        recordAudit?.(req,'finance.payable_approved','finance_payable',id,null,{...rows[0],variableAmountConfirmed:Boolean(current.rows[0].variableAmount)});
        return json(res,200,rows[0]);
      } catch (error) {
        await client.query('ROLLBACK').catch(()=>{});
        return json(res,error.code==='23514'?409:503,{error:error.code==='23514'?error.message:'finance_payable_update_failed',detail:error.message});
      } finally { client.release(); }
    }
    try {
      const { rows } = await pool.query(`UPDATE finance_payables SET status=$1,approved_by=CASE WHEN $1='approved' THEN $2 ELSE approved_by END,
        approved_at=CASE WHEN $1='approved' THEN now() ELSE approved_at END,updated_at=now()
        WHERE venue_id=$3 AND id=$4 AND (status='draft' OR (status='approved' AND $1='cancelled')) RETURNING id,status,total_amount AS "totalAmount"`, [nextStatus,req.user?.id || null,venueId,id]);
      if (!rows[0]) return fail(json, res, 404, 'finance_payable_not_found_or_not_draft');
      recordAudit?.(req,nextStatus==='approved'?'finance.payable_approved':'finance.payable_cancelled','finance_payable',id,null,rows[0]);
      return json(res, 200, rows[0]);
    } catch (error) { return json(res, error.code === '23514' ? 409 : 503, { error: error.code === '23514' ? error.message : 'finance_payable_update_failed', detail: error.message }); }
  }

  if (itemPath && itemPath[2] === 'payments' && req.method === 'GET') {
    const id = decodeURIComponent(itemPath[1]); if (!uuid.test(id)) return fail(json, res, 404, 'finance_payable_not_found');
    try {
      const { rows } = await pool.query(`SELECT e.id,e.amount,(SELECT COALESCE(SUM(amount),0) FROM finance_expense_refunds r WHERE r.venue_id=e.venue_id AND r.expense_id=e.id) AS "refundedAmount",e.expense_date::text AS "paymentDate",e.payment_method AS "paymentMethod",e.finance_account_id AS "paymentAccountId",e.finance_account_name_snapshot AS "paymentAccountNameSnapshot",e.shift_id AS "shiftId",CASE WHEN e.finance_account_id IS NULL THEN 'unknown_legacy' ELSE 'assigned' END AS "accountCoverage",e.document_url AS "documentUrl",e.description
        FROM finance_payable_payment_links l JOIN expenses e ON e.venue_id=l.venue_id AND e.id=l.expense_id
        WHERE l.venue_id=$1 AND l.payable_id=$2 ORDER BY e.expense_date,e.created_at,e.id`, [venueId,id]);
      return json(res, 200, { items: rows });
    } catch (error) { return json(res, 503, { error: 'finance_payable_payments_unavailable', detail: error.message }); }
  }

  if (itemPath && itemPath[2] === 'payments' && req.method === 'POST') {
    const id = decodeURIComponent(itemPath[1]); if (!uuid.test(id)) return fail(json, res, 404, 'finance_payable_not_found');
    const input = await readBody(req); const amountCents = moneyCents(input.amount); const date = String(input.paymentDate || '');
    const key = String(input.idempotencyKey || ''); const method = String(input.paymentMethod || 'bank_transfer');
    const paymentAccountId=String(input.paymentAccountId||'');
    const documentUrl = String(input.documentUrl || ''); const description = String(input.description || '').trim().slice(0,1000);
    if (amountCents === null || amountCents <= 0 || !isoDate(date) || (paymentAccountId&&!uuid.test(paymentAccountId)) || key.length < 8 || key.length > 120 || !['cash','card','bank_transfer','other'].includes(method)
      || (documentUrl && !/^data:(?:image\/(?:png|jpeg|webp)|application\/pdf);base64,[A-Za-z0-9+/=\r\n]+$/i.test(documentUrl))) return fail(json, res, 400, 'invalid_finance_payable_payment');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const prior = await client.query(`SELECT l.payable_id,l.expense_id,e.amount,e.expense_date::text AS expense_date,e.payment_method,e.finance_account_id,e.document_url,e.description,p.title AS payable_title FROM finance_payable_payment_links l
        JOIN expenses e ON e.venue_id=l.venue_id AND e.id=l.expense_id JOIN finance_payables p ON p.venue_id=l.venue_id AND p.id=l.payable_id
        WHERE l.venue_id=$1 AND l.idempotency_key=$2`, [venueId,key]);
      if (prior.rows[0]) {
        const row = prior.rows[0];
        const replayMatches = String(row.payable_id).toLowerCase()===id.toLowerCase() && String(row.expense_date).slice(0,10)===date && Math.round(Number(row.amount)*100)===amountCents
          && row.payment_method===method && (paymentAccountId?String(row.finance_account_id||'').toLowerCase()===paymentAccountId.toLowerCase():row.finance_account_id==null) && (row.document_url || '')===(documentUrl || '')
          && (row.description || '')===(description || `Оплата: ${row.payable_title}`);
        if (row.expense_id && replayMatches) {
          await client.query('COMMIT'); return json(res,200,{ expenseId:row.expense_id, amount:centsText(amountCents), idempotent:true });
        }
        await client.query('ROLLBACK'); return fail(json,res,409,'finance_payable_payment_idempotency_conflict');
      }
      const payable = await client.query(`SELECT id,category_id,category_name_snapshot,title,status,total_amount FROM finance_payables
        WHERE venue_id=$1 AND id=$2 FOR UPDATE`, [venueId,id]);
      if (!payable.rows[0]) { await client.query('ROLLBACK'); return fail(json,res,404,'finance_payable_not_found'); }
      if (payable.rows[0].status !== 'approved') { await client.query('ROLLBACK'); return fail(json,res,409,'finance_payable_not_approved'); }
      // A concurrent request can commit while this one waits on the payable row lock.
      const concurrentPrior = await client.query(`SELECT l.payable_id,l.expense_id,e.amount,e.expense_date::text AS expense_date,e.payment_method,e.finance_account_id,e.document_url,e.description,p.title AS payable_title
        FROM finance_payable_payment_links l JOIN expenses e ON e.venue_id=l.venue_id AND e.id=l.expense_id
        JOIN finance_payables p ON p.venue_id=l.venue_id AND p.id=l.payable_id
        WHERE l.venue_id=$1 AND l.idempotency_key=$2`, [venueId,key]);
      if (concurrentPrior.rows[0]) {
        const row=concurrentPrior.rows[0];
        const replayMatches=String(row.payable_id).toLowerCase()===id.toLowerCase() && String(row.expense_date).slice(0,10)===date && Math.round(Number(row.amount)*100)===amountCents
          && row.payment_method===method && (paymentAccountId?String(row.finance_account_id||'').toLowerCase()===paymentAccountId.toLowerCase():row.finance_account_id==null) && (row.document_url||'')===(documentUrl||'')
          && (row.description||'')===(description||`Оплата: ${row.payable_title}`);
        if(replayMatches){await client.query('COMMIT');return json(res,200,{expenseId:row.expense_id,amount:centsText(amountCents),idempotent:true});}
        await client.query('ROLLBACK');return fail(json,res,409,'finance_payable_payment_idempotency_conflict');
      }
      if(!paymentAccountId){await client.query('ROLLBACK');return fail(json,res,400,'finance_payment_account_required');}
      const account = await client.query(`SELECT id,name,kind,allowed_payment_methods,active FROM finance_accounts WHERE venue_id=$1 AND id=$2 FOR UPDATE`,[venueId,paymentAccountId]);
      if(!account.rows[0]){await client.query('ROLLBACK');return fail(json,res,404,'finance_account_not_found');}
      if(!account.rows[0].active){await client.query('ROLLBACK');return fail(json,res,409,'finance_account_inactive');}
      if(!account.rows[0].allowed_payment_methods.includes(method)){await client.query('ROLLBACK');return fail(json,res,400,'finance_payment_method_account_mismatch');}
      let shiftId=null;
      if(account.rows[0].kind==='pos_cashbox'){
        if(method!=='cash'){await client.query('ROLLBACK');return fail(json,res,400,'finance_payment_method_account_mismatch');}
        const localDate=await client.query("SELECT (now() AT TIME ZONE COALESCE(NULLIF(timezone,''),'Europe/Moscow'))::date::text AS today FROM venues WHERE id=$1",[venueId]);
        if(String(localDate.rows[0]?.today||'')!==date){await client.query('ROLLBACK');return fail(json,res,409,'finance_pos_cash_payment_date_must_be_today');}
        const shift=await client.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL FOR UPDATE',[venueId]);
        if(!shift.rows[0]){await client.query('ROLLBACK');return fail(json,res,409,'open_shift_required');}
        shiftId=shift.rows[0].id;
      }
      const sum = await client.query('SELECT COALESCE(SUM(applied_amount),0)::numeric(14,2) AS gross_paid,(COALESCE(SUM(applied_amount),0)-(SELECT COALESCE(SUM(amount),0) FROM finance_expense_refunds WHERE venue_id=$1 AND payable_id=$2))::numeric(14,2) AS net_paid,finance_payable_settled_amount($1,$2) AS paid FROM finance_payable_payment_links WHERE venue_id=$1 AND payable_id=$2', [venueId,id]);
      const totalCents = Math.round(Number(payable.rows[0].total_amount)*100); const paidCents = Math.round(Number(sum.rows[0].paid)*100);
      if (amountCents + paidCents > totalCents) { await client.query('ROLLBACK'); return fail(json,res,409,'finance_payable_payment_exceeds_balance'); }
      const expense = await client.query(`INSERT INTO expenses (venue_id,category,category_id,amount,expense_date,description,source,document_url,created_by,idempotency_key,payment_method,finance_account_id,finance_account_name_snapshot,shift_id)
        VALUES ($1,$2,$3,$4,$5,$6,'manual',$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [venueId,payable.rows[0].category_name_snapshot,payable.rows[0].category_id,centsText(amountCents),date,description || `Оплата: ${payable.rows[0].title}`,documentUrl || null,req.user?.id || null,key,method,paymentAccountId,account.rows[0].name,shiftId]);
      await client.query(`INSERT INTO finance_payable_payment_links (venue_id,payable_id,expense_id,applied_amount,idempotency_key,created_by)
        VALUES ($1,$2,$3,$4,$5,$6)`, [venueId,id,expense.rows[0].id,centsText(amountCents),key,req.user?.id || null]);
      await client.query('COMMIT');
      recordAudit?.(req,'finance.payable_paid','finance_payable',id,null,{expenseId:expense.rows[0].id,amount:centsText(amountCents),paymentDate:date,paymentMethod:method,paymentAccountId,paymentAccountNameSnapshot:account.rows[0].name,shiftId});
      return json(res,201,{ expenseId:expense.rows[0].id, amount:centsText(amountCents), paidAmount:centsText((moneyCents(sum.rows[0].gross_paid)??paidCents)+amountCents), netPaidAmount:centsText((moneyCents(sum.rows[0].net_paid)??paidCents)+amountCents), settledAmount:centsText(paidCents+amountCents), balanceDue:centsText(totalCents-paidCents-amountCents), idempotent:false });
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res,['23514','23505'].includes(error.code)?409:503,{ error:error.code==='23514'?error.message:error.code==='23505'?'finance_payable_payment_idempotency_conflict':'finance_payable_payment_failed' }); }
    finally { client.release(); }
  }

  if (rulesPath && req.method === 'GET') {
    try {
      const { rows } = await pool.query(`SELECT r.id,r.category_id AS "categoryId",c.name AS "categoryName",r.title,r.counterparty_name AS "counterpartyName",r.basis,r.day_of_month AS "dayOfMonth",r.starts_on::text AS "startsOn",r.ends_on::text AS "endsOn",r.partial_month_policy AS "partialMonthPolicy",r.status,
        v.id AS "versionId",v.version_number AS "versionNumber",v.effective_from::text AS "effectiveFrom",v.amount,v.lines,v.variable_amount AS "variableAmount"
        FROM finance_recurring_rules r JOIN finance_categories c ON c.venue_id=r.venue_id AND c.id=r.category_id
        LEFT JOIN LATERAL (SELECT * FROM finance_recurring_rule_versions x WHERE x.venue_id=r.venue_id AND x.rule_id=r.id ORDER BY x.effective_from DESC,x.version_number DESC LIMIT 1) v ON true
        WHERE r.venue_id=$1 ORDER BY r.status,r.title,r.id`, [venueId]);
      return json(res,200,{ items:rows });
    } catch (error) { return json(res,503,{ error:'finance_recurring_rules_unavailable',detail:error.message }); }
  }

  if (rulesPath && req.method === 'POST') {
    const input = await readBody(req); const categoryId=String(input.categoryId||''); const title=String(input.title||'').trim();
    const counterparty=String(input.counterpartyName||'').trim(); const basis=String(input.basis||'').trim(); const day=Number(input.dayOfMonth);
    const startsOn=String(input.startsOn||''); const endsOn=input.endsOn==null||input.endsOn===''?null:String(input.endsOn); const amount=moneyCents(input.amount); const variable=Boolean(input.variableAmount);
    const partialMonthPolicy=input.partialMonthPolicy===undefined?'full_months_only':String(input.partialMonthPolicy);
    const idempotencyKey=String(input.idempotencyKey||'').trim();
    const lines=Array.isArray(input.lines)&&input.lines.length?input.lines:[{description:title,amount:input.amount}];
    const normalized=lines.map((line,index)=>({description:String(line?.description||'').trim(),cents:moneyCents(line?.amount),ordinal:index}));
    if (!uuid.test(categoryId)||title.length<1||title.length>160||counterparty.length>160||basis.length>500||!Number.isInteger(day)||day<1||day>31||!isoDate(startsOn)||!['full_months_only','calendar_days'].includes(partialMonthPolicy)||normalized.length>40||(endsOn&&(!isoDate(endsOn)||endsOn<startsOn))||amount===null||amount<0||normalized.some(x=>!x.description||x.description.length>200||x.cents===null||x.cents<0)||idempotencyKey.length<8||idempotencyKey.length>120) return fail(json,res,400,'invalid_finance_recurring_rule');
    const lineTotal=normalized.reduce((sum,x)=>sum+x.cents,0); if(lineTotal!==amount)return fail(json,res,400,'finance_recurring_lines_total_mismatch');
    const requestHash=createRequestHash({categoryId,title,counterpartyName:counterparty,basis,dayOfMonth:day,startsOn,endsOn,...(partialMonthPolicy==='full_months_only'?{}:{partialMonthPolicy}),amount:centsText(amount),variableAmount:variable,lines:normalized.map((line)=>({description:line.description,amount:centsText(line.cents)}))});
    const client=await pool.connect();
    let commitAttempted=false;
    try {
      await client.query('BEGIN');
      const claim=await claimCreateIdempotency(client,venueId,'recurring_rule_create',idempotencyKey,requestHash,req.user?.id);
      if(claim.conflict){await client.query('ROLLBACK');return fail(json,res,409,'finance_create_idempotency_conflict');}
      if(claim.replay){commitAttempted=true;await client.query('COMMIT');return json(res,200,claim.response);}
      const cat=await client.query("SELECT id,name FROM finance_categories WHERE venue_id=$1 AND id=$2 AND kind='expense' AND active=true FOR KEY SHARE",[venueId,categoryId]);
      if(!cat.rows[0]){await client.query('ROLLBACK');return fail(json,res,400,'invalid_finance_category');}
      const rule=await client.query(`INSERT INTO finance_recurring_rules (venue_id,category_id,title,counterparty_name,basis,day_of_month,starts_on,ends_on,created_by,partial_month_policy)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,[venueId,categoryId,title,counterparty,basis,day,startsOn,endsOn,req.user?.id||null,partialMonthPolicy]);
      await client.query(`INSERT INTO finance_recurring_rule_versions (venue_id,rule_id,version_number,effective_from,amount,lines,variable_amount,created_by)
        VALUES ($1,$2,1,$3,$4,$5::jsonb,$6,$7)`,[venueId,rule.rows[0].id,startsOn.slice(0,7)+'-01',centsText(amount),JSON.stringify(normalized.map(x=>({description:x.description,amount:centsText(x.cents)}))),variable,req.user?.id||null]);
      const response={id:rule.rows[0].id,status:'active',endsOn,partialMonthPolicy};
      await completeCreateIdempotency(client,venueId,'recurring_rule_create',idempotencyKey,rule.rows[0].id,response);
      commitAttempted=true;
      await client.query('COMMIT');recordAudit?.(req,'finance.recurring_rule_created','finance_recurring_rule',rule.rows[0].id,null,{categoryId,title,counterpartyName:counterparty,startsOn,endsOn,partialMonthPolicy,amount:centsText(amount),variableAmount:variable});return json(res,201,response);
    }catch(error){await client.query('ROLLBACK').catch(()=>{});return json(res,commitAttempted?503:409,{error:commitAttempted?'finance_create_result_unknown':'finance_recurring_rule_save_failed'});}finally{client.release();}
  }

  if(rulePath&&rulePath[2]==='end-date-preview'&&req.method==='GET'){
    const id=decodeURIComponent(rulePath[1]);if(!uuid.test(id))return fail(json,res,404,'finance_recurring_rule_not_found');
    if(!url.searchParams.has('endsOn'))return fail(json,res,400,'invalid_finance_recurring_rule_end_date');
    const rawEndsOn=url.searchParams.get('endsOn');const proposedEndsOn=rawEndsOn==null||rawEndsOn===''?null:String(rawEndsOn);
    if(proposedEndsOn&&!isoDate(proposedEndsOn))return fail(json,res,400,'invalid_finance_recurring_rule_end_date');
    try{
      const ruleResult=await pool.query('SELECT id,starts_on::text AS starts_on,ends_on::text AS ends_on,partial_month_policy,status FROM finance_recurring_rules WHERE venue_id=$1 AND id=$2',[venueId,id]);const rule=ruleResult.rows[0];
      if(!rule)return fail(json,res,404,'finance_recurring_rule_not_found');
      if(rule.status==='ended')return fail(json,res,409,'finance_recurring_rule_already_ended');
      if(proposedEndsOn&&proposedEndsOn<String(rule.starts_on).slice(0,10))return fail(json,res,400,'invalid_finance_recurring_rule_end_date');
      return json(res,200,await recurringEndDateImpact(pool,venueId,rule,proposedEndsOn));
    }catch(error){return json(res,503,{error:'finance_recurring_end_date_preview_failed'});}
  }

  if (rulePath && !rulePath[2] && req.method === 'PATCH') {
    const id=decodeURIComponent(rulePath[1]);if(!uuid.test(id))return fail(json,res,404,'finance_recurring_rule_not_found');
    const input=await readBody(req);
    if(input.action==='set_end_date'){
      const proposedEndsOn=input.endsOn==null||input.endsOn===''?null:String(input.endsOn);const impactToken=String(input.impactToken||'');
      if(!Object.prototype.hasOwnProperty.call(input,'endsOn')||(proposedEndsOn&&!isoDate(proposedEndsOn))||!/^[0-9a-f]{64}$/i.test(impactToken))return fail(json,res,400,'invalid_finance_recurring_rule_end_date');
      const client=await pool.connect();let inTransaction=false;try{
        await client.query('BEGIN');inTransaction=true;
        const currentResult=await client.query('SELECT id,starts_on::text AS starts_on,ends_on::text AS ends_on,partial_month_policy,status FROM finance_recurring_rules WHERE venue_id=$1 AND id=$2 FOR UPDATE',[venueId,id]);const current=currentResult.rows[0];
        if(!current){await client.query('ROLLBACK');inTransaction=false;return fail(json,res,404,'finance_recurring_rule_not_found');}
        if(current.status==='ended'){await client.query('ROLLBACK');inTransaction=false;return fail(json,res,409,'finance_recurring_rule_already_ended');}
        if(proposedEndsOn&&proposedEndsOn<String(current.starts_on).slice(0,10)){await client.query('ROLLBACK');inTransaction=false;return fail(json,res,400,'invalid_finance_recurring_rule_end_date');}
        const impact=await recurringEndDateImpact(client,venueId,current,proposedEndsOn,true);
        if(impact.impactToken!==impactToken){await client.query('ROLLBACK');inTransaction=false;return fail(json,res,409,'finance_recurring_preview_stale');}
        if(impact.currentEndsOn===proposedEndsOn){await client.query('COMMIT');inTransaction=false;return json(res,200,{id,endsOn:impact.currentEndsOn,status:current.status,impactToken,affectedPayablesCount:impact.affectedPayables.length,periodChanges:impact.periodChanges,existingDocumentsUnchanged:true,unchanged:true});}
        const updated=await client.query('UPDATE finance_recurring_rules SET ends_on=$1,updated_at=now() WHERE venue_id=$2 AND id=$3 RETURNING id,ends_on::text AS "endsOn",status',[proposedEndsOn,venueId,id]);
        await client.query('COMMIT');inTransaction=false;
        recordAudit?.(req,'finance.recurring_rule_end_date_changed','finance_recurring_rule',id,null,{previousEndsOn:impact.currentEndsOn,endsOn:proposedEndsOn,impactToken,affectedPayablesCount:impact.affectedPayables.length,periodChanges:impact.periodChanges,existingDocumentsUnchanged:true});
        return json(res,200,{...updated.rows[0],impactToken,affectedPayablesCount:impact.affectedPayables.length,periodChanges:impact.periodChanges,existingDocumentsUnchanged:true});
      }catch(error){if(inTransaction)await client.query('ROLLBACK').catch(()=>{});return json(res,503,{error:'finance_recurring_rule_end_date_update_failed'});}finally{client.release();}
    }
    const status=String(input.status||'');if(!['active','paused','ended'].includes(status))return fail(json,res,400,'invalid_finance_recurring_rule_status');
    const client=await pool.connect();let inTransaction=false;try{
      await client.query('BEGIN');inTransaction=true;
      const current=await client.query('SELECT id,category_id,status FROM finance_recurring_rules WHERE venue_id=$1 AND id=$2 FOR UPDATE',[venueId,id]);
      if(!current.rows[0]){await client.query('ROLLBACK');inTransaction=false;return fail(json,res,404,'finance_recurring_rule_not_found');}
      if(status==='active'){
        const category=await client.query('SELECT active FROM finance_categories WHERE venue_id=$1 AND id=$2 FOR UPDATE',[venueId,current.rows[0].category_id]);
        if(!category.rows[0]?.active){await client.query('ROLLBACK');inTransaction=false;return fail(json,res,409,'finance_recurring_category_archived');}
      }
      const updated=await client.query(`UPDATE finance_recurring_rules SET status=$1,updated_at=now() WHERE venue_id=$2 AND id=$3
        AND ((status='active' AND $1 IN ('paused','ended')) OR (status='paused' AND $1 IN ('active','ended')) OR (status='ended' AND $1='ended'))
        RETURNING id,status`,[status,venueId,id]);
      if(!updated.rows[0]){await client.query('ROLLBACK');inTransaction=false;return fail(json,res,409,'finance_recurring_rule_transition_invalid');}
      await client.query('COMMIT');inTransaction=false;recordAudit?.(req,'finance.recurring_rule_status_changed','finance_recurring_rule',id,null,updated.rows[0]);return json(res,200,updated.rows[0]);
    }catch(error){if(inTransaction)await client.query('ROLLBACK').catch(()=>{});return json(res,503,{error:'finance_recurring_rule_update_failed',detail:error.message});}finally{client.release();}
  }

  if (rulePath && rulePath[2] === 'versions/preview' && req.method === 'POST') {
    const id=decodeURIComponent(rulePath[1]);if(!uuid.test(id))return fail(json,res,404,'finance_recurring_rule_not_found');
    const input=await readBody(req);const effectiveFrom=String(input.effectiveFrom||'');const amount=moneyCents(input.amount);const variable=Boolean(input.variableAmount);const lines=Array.isArray(input.lines)?input.lines:[];
    const normalized=lines.map((line,index)=>({description:String(line?.description||'').trim(),cents:moneyCents(line?.amount),ordinal:index}));
    if(!isoDate(effectiveFrom)||!effectiveFrom.endsWith('-01')||amount===null||amount<=0||!normalized.length||normalized.length>40||normalized.some(x=>!x.description||x.description.length>200||x.cents===null||x.cents<0)||normalized.reduce((sum,x)=>sum+x.cents,0)!==amount)return fail(json,res,400,'invalid_finance_recurring_version');
    const client=await pool.connect();try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const ruleResult=await client.query(`SELECT id,starts_on::text AS "startsOn",ends_on::text AS "endsOn",partial_month_policy,status FROM finance_recurring_rules WHERE venue_id=$1 AND id=$2`,[venueId,id]);const rule=ruleResult.rows[0];if(!rule){await client.query('ROLLBACK');return fail(json,res,404,'finance_recurring_rule_not_found');}if(rule.status==='ended'||effectiveFrom<=String(rule.startsOn).slice(0,10)||!calendarPeriod(rule,effectiveFrom.slice(0,7)).eligible){await client.query('ROLLBACK');return fail(json,res,409,'finance_recurring_version_effective_date_invalid');}const [latest,nextMonth]=await Promise.all([client.query('SELECT effective_from::text AS date FROM finance_recurring_rule_versions WHERE venue_id=$1 AND rule_id=$2 ORDER BY effective_from DESC,version_number DESC LIMIT 1',[venueId,id]),client.query("SELECT (date_trunc('month',now() AT TIME ZONE timezone)+interval '1 month')::date::text AS date FROM venues WHERE id=$1",[venueId])]);if((latest.rows[0]?.date&&effectiveFrom<=latest.rows[0].date)||effectiveFrom<(nextMonth.rows[0]?.date||'')){await client.query('ROLLBACK');return fail(json,res,409,'finance_recurring_version_effective_date_invalid');}const preview=await recurringVersionPreview(client,venueId,rule,effectiveFrom,amount,normalized,variable);await client.query('COMMIT');return json(res,200,preview);
    }catch(error){await client.query('ROLLBACK').catch(()=>{});return json(res,503,{error:'finance_recurring_version_preview_failed'});}finally{client.release();}
  }

  if (rulePath && rulePath[2] === 'versions' && req.method === 'GET') {
    const id=decodeURIComponent(rulePath[1]);const effectiveFrom=String(url.searchParams.get('effectiveFrom')||'');
    if(!uuid.test(id))return fail(json,res,404,'finance_recurring_rule_not_found');
    if(!isoDate(effectiveFrom)||!effectiveFrom.endsWith('-01'))return fail(json,res,400,'invalid_finance_recurring_version_date');
    const proposedCents=moneyCents(url.searchParams.get('amount'));
    if(proposedCents===null||proposedCents<=0)return fail(json,res,400,'invalid_finance_recurring_version_amount');
    const client=await pool.connect();try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const ruleResult=await client.query(`SELECT id,title,starts_on::text AS "startsOn",ends_on::text AS "endsOn",partial_month_policy,status FROM finance_recurring_rules WHERE venue_id=$1 AND id=$2`,[venueId,id]);const rule=ruleResult.rows[0];if(!rule){await client.query('ROLLBACK');return fail(json,res,404,'finance_recurring_rule_not_found');}if(rule.status==='ended'||effectiveFrom<=String(rule.startsOn).slice(0,10)||!calendarPeriod(rule,effectiveFrom.slice(0,7)).eligible){await client.query('ROLLBACK');return fail(json,res,409,'finance_recurring_version_effective_date_invalid');}const [latest,nextMonth]=await Promise.all([client.query('SELECT effective_from::text AS date FROM finance_recurring_rule_versions WHERE venue_id=$1 AND rule_id=$2 ORDER BY effective_from DESC,version_number DESC LIMIT 1',[venueId,id]),client.query("SELECT (date_trunc('month',now() AT TIME ZONE timezone)+interval '1 month')::date::text AS date FROM venues WHERE id=$1",[venueId])]);if((latest.rows[0]?.date&&effectiveFrom<=latest.rows[0].date)||effectiveFrom<(nextMonth.rows[0]?.date||'')){await client.query('ROLLBACK');return fail(json,res,409,'finance_recurring_version_effective_date_invalid');}const legacyLine=[{description:'Новая ставка',cents:proposedCents}];const preview=await recurringVersionPreview(client,venueId,rule,effectiveFrom,proposedCents,legacyLine,false);await client.query('COMMIT');return json(res,200,preview);
    }catch(error){await client.query('ROLLBACK').catch(()=>{});return json(res,503,{error:'finance_recurring_version_preview_failed'});}finally{client.release();}
  }

  if (rulePath && rulePath[2] === 'versions' && req.method === 'POST') {
    const id=decodeURIComponent(rulePath[1]);if(!uuid.test(id))return fail(json,res,404,'finance_recurring_rule_not_found');
    const input=await readBody(req);const effectiveFrom=String(input.effectiveFrom||'');const amount=moneyCents(input.amount);const variable=Boolean(input.variableAmount);const previewToken=String(input.previewToken||'');const idempotencyKey=String(input.idempotencyKey||'').trim();
    const lines=Array.isArray(input.lines)?input.lines:[];const normalized=lines.map((line,index)=>({description:String(line?.description||'').trim(),cents:moneyCents(line?.amount),ordinal:index}));
    if(!isoDate(effectiveFrom)||!effectiveFrom.endsWith('-01')||amount===null||amount<=0||!normalized.length||normalized.length>40||normalized.some(x=>!x.description||x.description.length>200||x.cents===null||x.cents<0)||normalized.reduce((sum,x)=>sum+x.cents,0)!==amount||!/^[0-9a-f]{64}$/i.test(previewToken)||idempotencyKey.length<8||idempotencyKey.length>120)return fail(json,res,400,'invalid_finance_recurring_version');
    const requestHash=createRequestHash({effectiveFrom,amount:centsText(amount),lines:normalized.map((line)=>({description:line.description,amount:centsText(line.cents)})),variableAmount:variable,previewToken});
    const client=await pool.connect();let commitAttempted=false;try{await client.query('BEGIN');const claim=await claimCreateIdempotency(client,venueId,'recurring_rule_version_create',idempotencyKey,requestHash,req.user?.id);if(claim.conflict){await client.query('ROLLBACK');return fail(json,res,409,'finance_create_idempotency_conflict');}if(claim.replay){commitAttempted=true;await client.query('COMMIT');return json(res,200,claim.response);}
      const ruleResult=await client.query('SELECT id,starts_on::text AS "startsOn",ends_on::text AS "endsOn",partial_month_policy,status FROM finance_recurring_rules WHERE venue_id=$1 AND id=$2 FOR UPDATE',[venueId,id]);const rule=ruleResult.rows[0];if(!rule){await client.query('ROLLBACK');return fail(json,res,404,'finance_recurring_rule_not_found');}if(rule.status==='ended'||effectiveFrom<=String(rule.startsOn).slice(0,10)||!calendarPeriod(rule,effectiveFrom.slice(0,7)).eligible){await client.query('ROLLBACK');return fail(json,res,409,'finance_recurring_version_effective_date_invalid');}const nextMonth=await client.query("SELECT (date_trunc('month',now() AT TIME ZONE timezone)+interval '1 month')::date::text AS date FROM venues WHERE id=$1",[venueId]);if(effectiveFrom<(nextMonth.rows[0]?.date||'')){await client.query('ROLLBACK');return fail(json,res,409,'finance_recurring_version_effective_date_invalid');}
      const impact=await recurringVersionPreview(client,venueId,rule,effectiveFrom,amount,normalized,variable,true);if(impact.previewToken!==previewToken){await client.query('ROLLBACK');return fail(json,res,409,'finance_recurring_preview_stale');}
      const next=await client.query('SELECT COALESCE(MAX(version_number),0)+1 AS n FROM finance_recurring_rule_versions WHERE venue_id=$1 AND rule_id=$2',[venueId,id]);const result=await client.query(`INSERT INTO finance_recurring_rule_versions (venue_id,rule_id,version_number,effective_from,amount,lines,variable_amount,created_by) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING id,version_number AS "versionNumber",effective_from::text AS "effectiveFrom",amount::text,lines,variable_amount AS "variableAmount",created_at AS "createdAt",created_by AS "createdBy"`,[venueId,id,next.rows[0].n,effectiveFrom,centsText(amount),JSON.stringify(normalized.map(x=>({description:x.description,amount:centsText(x.cents)}))),variable,req.user?.id||null]);
      const response={id:result.rows[0].id,versionId:result.rows[0].id,versionNumber:result.rows[0].versionNumber,effectiveFrom:result.rows[0].effectiveFrom,amount:result.rows[0].amount,lines:result.rows[0].lines,variableAmount:result.rows[0].variableAmount,createdAt:result.rows[0].createdAt,createdBy:result.rows[0].createdBy};await completeCreateIdempotency(client,venueId,'recurring_rule_version_create',idempotencyKey,result.rows[0].id,response);commitAttempted=true;await client.query('COMMIT');recordAudit?.(req,'finance.recurring_rule_version_added','finance_recurring_rule',id,null,{versionId:result.rows[0].id,versionNumber:result.rows[0].versionNumber,effectiveFrom,amount:centsText(amount),variableAmount:variable});return json(res,201,response);
    }catch(error){await client.query('ROLLBACK').catch(()=>{});return json(res,commitAttempted?503:409,{error:commitAttempted?'finance_create_result_unknown':'finance_recurring_version_save_failed'});}finally{client.release();}
  }

  if (rulePath && rulePath[2] === 'generate-preview' && req.method === 'GET') {
    const id=decodeURIComponent(rulePath[1]);if(!uuid.test(id))return fail(json,res,404,'finance_recurring_rule_not_found');
    const from=String(url.searchParams.get('from')||'');const to=String(url.searchParams.get('to')||'');
    const monthDistance=monthKey(from)&&monthKey(to)?(Number(to.slice(0,4))*12+Number(to.slice(5,7)))-(Number(from.slice(0,4))*12+Number(from.slice(5,7))):-1;
    if(!monthKey(from)||!monthKey(to)||from>to||monthDistance>23)return fail(json,res,400,monthDistance>23?'finance_generation_range_too_large':'invalid_finance_generation_range');
    let client;
    try{
      client=await pool.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result=await client.query(`SELECT r.id,r.category_id,r.title,r.counterparty_name,r.basis,r.day_of_month,r.starts_on::text AS starts_on,
        r.ends_on::text AS ends_on,r.partial_month_policy,r.status,c.name AS category_name,c.active AS category_active
        FROM finance_recurring_rules r JOIN finance_categories c ON c.venue_id=r.venue_id AND c.id=r.category_id
        WHERE r.venue_id=$1 AND r.id=$2`,[venueId,id]);const rule=result.rows[0];
      if(!rule){await client.query('ROLLBACK');return fail(json,res,404,'finance_recurring_rule_not_found');}
      if(rule.status!=='active'){await client.query('ROLLBACK');return fail(json,res,409,'finance_recurring_rule_not_active');}
      if(!rule.category_active){await client.query('ROLLBACK');return fail(json,res,409,'finance_recurring_category_archived');}
      const preview=await recurringGenerationPreview(client,venueId,rule,from,to);await client.query('COMMIT');return json(res,200,preview);
    }catch(error){if(client)await client.query('ROLLBACK').catch(()=>{});return json(res,503,{error:'finance_generation_preview_failed'});}finally{client?.release();}
  }

  if (rulePath && rulePath[2] === 'generate' && req.method === 'POST') {
    const id=decodeURIComponent(rulePath[1]);if(!uuid.test(id))return fail(json,res,404,'finance_recurring_rule_not_found');
    const input=await readBody(req);const from=String(input.from||'');const to=String(input.to||'');const previewToken=String(input.previewToken||'');const idempotencyKey=String(input.idempotencyKey||'').trim();
    if(!monthKey(from)||!monthKey(to)||from>to)return fail(json,res,400,'invalid_finance_generation_range');
    const monthDistance=(Number(to.slice(0,4))*12+Number(to.slice(5,7)))-(Number(from.slice(0,4))*12+Number(from.slice(5,7)));if(monthDistance>23)return fail(json,res,400,'finance_generation_range_too_large');
    if((previewToken||idempotencyKey)&&(!/^[0-9a-f]{64}$/i.test(previewToken)||idempotencyKey.length<8||idempotencyKey.length>120))return fail(json,res,400,'invalid_finance_generation_confirmation');
    const client=await pool.connect();let commitAttempted=false;try{await client.query('BEGIN');const ruleResult=await client.query(`SELECT r.id,r.venue_id,r.category_id,r.title,r.counterparty_name,r.basis,r.day_of_month,r.starts_on::text AS starts_on,r.ends_on::text AS ends_on,r.partial_month_policy,r.status,c.name AS category_name,c.active AS category_active FROM finance_recurring_rules r JOIN finance_categories c ON c.venue_id=r.venue_id AND c.id=r.category_id WHERE r.venue_id=$1 AND r.id=$2 FOR UPDATE OF r`,[venueId,id]);const rule=ruleResult.rows[0];if(!rule){await client.query('ROLLBACK');return fail(json,res,404,'finance_recurring_rule_not_found');}
      let generationRequestHash=null;
      if(previewToken){
        generationRequestHash=createRequestHash({ruleId:id,from,to,previewToken});
        const claim=await claimCreateIdempotency(client,venueId,'recurring_payable_generation',idempotencyKey,generationRequestHash,req.user?.id);
        if(claim.conflict){await client.query('ROLLBACK');return fail(json,res,409,'finance_create_idempotency_conflict');}
        if(claim.replay){commitAttempted=true;await client.query('COMMIT');return json(res,200,claim.response);}
      }
      if(rule.status!=='active'){await client.query('ROLLBACK');return fail(json,res,409,'finance_recurring_rule_not_active');}
      const category=await client.query('SELECT active FROM finance_categories WHERE venue_id=$1 AND id=$2 FOR SHARE',[venueId,rule.category_id]);if(!category.rows[0]?.active){await client.query('ROLLBACK');return fail(json,res,409,'finance_recurring_category_archived');}
      if(policyFor(rule)==='calendar_days'&&!previewToken){await client.query('ROLLBACK');return fail(json,res,409,'finance_generation_preview_required');}
      if(previewToken){const preview=await recurringGenerationPreview(client,venueId,rule,from,to,true);if(preview.previewToken!==previewToken){await client.query('ROLLBACK');return fail(json,res,409,'finance_generation_preview_stale');}}
      const made=[];let cursor=new Date(`${from}-01T00:00:00Z`);const stop=new Date(`${to}-01T00:00:00Z`);while(cursor<=stop){const key=`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth()+1).padStart(2,'0')}`;const periodStart=`${key}-01`;const periodEnd=new Date(Date.UTC(cursor.getUTCFullYear(),cursor.getUTCMonth()+1,0)).toISOString().slice(0,10);const starts=String(rule.starts_on).slice(0,10);const ends=rule.ends_on?String(rule.ends_on).slice(0,10):null;
        const window=calendarPeriod(rule,key);if(window.eligible){const versions=await client.query(`SELECT * FROM finance_recurring_rule_versions WHERE venue_id=$1 AND rule_id=$2 AND effective_from<=$3::date ORDER BY effective_from DESC,version_number DESC LIMIT 1`,[venueId,id,periodStart]);const version=versions.rows[0];if(version){const dueDate=window.dueDate;const priced=pricePeriod(window,version);const lines=priced.lines;const result=await client.query(`INSERT INTO finance_payables (venue_id,category_id,category_name_snapshot,title,counterparty_name,basis,period_from,period_to,due_date,total_amount,status,recurring_rule_id,recurring_version_id,period_key,created_by,proration_snapshot)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11,$12,$13,$14,$15::jsonb) ON CONFLICT (venue_id,recurring_rule_id,period_key) WHERE recurring_rule_id IS NOT NULL DO NOTHING RETURNING id`,[venueId,rule.category_id,rule.category_name,rule.title,rule.counterparty_name,rule.basis,window.periodFrom,window.periodTo,dueDate,priced.amount,id,version.id,key,req.user?.id||null,priced.prorationSnapshot?JSON.stringify(priced.prorationSnapshot):null]);let payableId=result.rows[0]?.id;if(!payableId){const prior=await client.query('SELECT id FROM finance_payables WHERE venue_id=$1 AND recurring_rule_id=$2 AND period_key=$3',[venueId,id,key]);payableId=prior.rows[0]?.id;}else{for(let i=0;i<lines.length;i++)await client.query('INSERT INTO finance_payable_lines (venue_id,payable_id,description_snapshot,amount,ordinal) VALUES ($1,$2,$3,$4,$5)',[venueId,payableId,String(lines[i].description),String(lines[i].amount),i]);}if(payableId)made.push({period:key,id:payableId,created:Boolean(result.rows[0])});}}
        cursor.setUTCMonth(cursor.getUTCMonth()+1);}
      const created=made.filter((item)=>item.created);let response={items:made};
      if(previewToken){
        if(!made.length){await client.query('ROLLBACK');return json(res,200,{items:[],createdCount:0,alreadyExistsCount:0,previewToken});}
        response={items:made,createdCount:created.length,alreadyExistsCount:made.length-created.length,previewToken};
        await completeCreateIdempotency(client,venueId,'recurring_payable_generation',idempotencyKey,made[0].id,response);
      }
      commitAttempted=true;await client.query('COMMIT');if(created.length)recordAudit?.(req,'finance.payables_generated','finance_recurring_rule',id,null,{periods:created.map((item)=>item.period),count:created.length,previewed:Boolean(previewToken)});return json(res,200,response);
    }catch(error){await client.query('ROLLBACK').catch(()=>{});return json(res,commitAttempted?503:409,{error:commitAttempted?'finance_payable_generation_result_unknown':'finance_payable_generation_failed'});}finally{client.release();}
  }
  return fail(json,res,405,'method_not_allowed');
}

module.exports = { handleFinancePayableRoute };
