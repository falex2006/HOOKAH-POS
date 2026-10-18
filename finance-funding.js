'use strict';

const crypto=require('node:crypto');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const jsonError=(json,res,status,error)=>{json(res,status,{error});return true;};
const clean=(value,max)=>String(value??'').trim().slice(0,max);
const hasOnly=(object,keys)=>Object.keys(object||{}).every(key=>keys.includes(key));
const isoDate=value=>{const raw=String(value||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(raw))return false;const date=new Date(`${raw}T00:00:00Z`);return !Number.isNaN(date.getTime())&&date.toISOString().slice(0,10)===raw;};
function money(value){const raw=String(value??'').trim();if(!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(raw))return null;const [whole,fraction='']=raw.split('.');const cents=BigInt(whole)*100n+BigInt((fraction+'00').slice(0,2));if(cents<=0n||cents>99999999999999n)return null;return `${cents/100n}.${String(cents%100n).padStart(2,'0')}`;}
const fingerprint=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const eventTypes=new Set(['owner_contribution_received','loan_principal_received','loan_principal_repaid']);

async function readDocument(pool,venueId,id){
  const {rows}=await pool.query(`SELECT d.id,d.document_type AS "documentType",d.counterparty_name AS "counterpartyName",d.basis,d.document_reference AS "documentReference",
      d.principal_limit::text AS "principalLimit",d.currency,d.status,d.created_by AS "createdBy",d.created_at AS "createdAt",d.updated_at AS "updatedAt",
      COALESCE(SUM(e.amount) FILTER (WHERE e.event_type IN ('owner_contribution_received','loan_principal_received')),0)::numeric(14,2)::text AS "receivedAmount",
      COALESCE(SUM(e.amount) FILTER (WHERE e.event_type='loan_principal_repaid'),0)::numeric(14,2)::text AS "repaidAmount",
      GREATEST(COALESCE(SUM(e.amount) FILTER (WHERE e.event_type='loan_principal_received'),0)-COALESCE(SUM(e.amount) FILTER (WHERE e.event_type='loan_principal_repaid'),0),0)::numeric(14,2)::text AS "principalOutstanding",
      COALESCE(jsonb_agg(jsonb_build_object('id',e.id,'eventType',e.event_type,'amount',e.amount::text,'eventDate',e.event_date::text,'financeAccountId',e.finance_account_id,'financeAccountNameSnapshot',e.finance_account_name_snapshot,'paymentMethod',e.payment_method,'shiftId',e.shift_id,'note',e.note,'createdBy',e.created_by,'createdAt',e.created_at) ORDER BY e.event_date,e.created_at,e.id) FILTER (WHERE e.id IS NOT NULL),'[]'::jsonb) AS events
    FROM finance_funding_documents d LEFT JOIN finance_funding_events e ON e.venue_id=d.venue_id AND e.document_id=d.id
    WHERE d.venue_id=$1 AND ($2::uuid IS NULL OR d.id=$2::uuid)
    GROUP BY d.venue_id,d.id`,[venueId,id||null]);
  return rows[0]||null;
}

async function findDocByKey(pool,venueId,key){return (await pool.query('SELECT id,request_sha256 FROM finance_funding_documents WHERE venue_id=$1 AND idempotency_key=$2',[venueId,key])).rows[0]||null;}
async function findEventByKey(pool,venueId,key){return (await pool.query('SELECT id,document_id,request_sha256 FROM finance_funding_events WHERE venue_id=$1 AND idempotency_key=$2',[venueId,key])).rows[0]||null;}

async function handleFinanceFundingRoute({req,res,url,pool,venueId,json,readBody,hasPermission,recordAudit}){
  const base='/api/finance/funding-documents';if(!url.pathname.startsWith(base))return false;
  const operationalRoles=new Set(['bartender','hookah_master','senior_bartender','senior_hookah_master','cleaner','security','technician','other_staff','staff']);
  const canRead=(hasPermission('finance_read')||hasPermission('finance'))&&!operationalRoles.has(String(req.user?.role||'').toLowerCase());
  const canWrite=hasPermission('finance')&&!operationalRoles.has(String(req.user?.role||'').toLowerCase());
  if(!canRead)return jsonError(json,res,403,'forbidden');if(!pool)return jsonError(json,res,503,'finance_database_required');
  const actorId=String(req.user?.id||'');const detail=url.pathname.match(/^\/api\/finance\/funding-documents\/([0-9a-f-]{36})$/i);
  const eventRoute=url.pathname.match(/^\/api\/finance\/funding-documents\/([0-9a-f-]{36})\/events$/i);
  const cancelRoute=url.pathname.match(/^\/api\/finance\/funding-documents\/([0-9a-f-]{36})\/cancel$/i);
  if(url.pathname===base&&req.method==='GET'){
    const from=url.searchParams.get('from')||'';const to=url.searchParams.get('to')||'';const kind=url.searchParams.get('kind')||'';const q=(url.searchParams.get('q')||'').trim();
    if((from&&!isoDate(from))||(to&&!isoDate(to))||(from&&to&&from>to)||(kind&&!['owner_contribution','loan'].includes(kind))||q.length>160)return jsonError(json,res,400,'invalid_funding_filter');
    try{const {rows}=await pool.query(`SELECT d.id,d.document_type AS "documentType",d.counterparty_name AS "counterpartyName",d.basis,d.document_reference AS "documentReference",d.principal_limit::text AS "principalLimit",d.currency,d.status,d.created_at AS "createdAt",
        COALESCE(SUM(e.amount) FILTER (WHERE e.event_type IN ('owner_contribution_received','loan_principal_received')),0)::numeric(14,2)::text AS "receivedAmount",
        COALESCE(SUM(e.amount) FILTER (WHERE e.event_type='loan_principal_repaid'),0)::numeric(14,2)::text AS "repaidAmount",
        GREATEST(COALESCE(SUM(e.amount) FILTER (WHERE e.event_type='loan_principal_received'),0)-COALESCE(SUM(e.amount) FILTER (WHERE e.event_type='loan_principal_repaid'),0),0)::numeric(14,2)::text AS "principalOutstanding",
        COUNT(e.id)::int AS "eventCount"
      FROM finance_funding_documents d LEFT JOIN finance_funding_events e ON e.venue_id=d.venue_id AND e.document_id=d.id
      WHERE d.venue_id=$1 AND ($2::text='' OR d.document_type=$2)
        AND (($3::date IS NULL AND $4::date IS NULL) OR EXISTS(SELECT 1 FROM finance_funding_events x WHERE x.venue_id=d.venue_id AND x.document_id=d.id AND ($3::date IS NULL OR x.event_date >= $3::date) AND ($4::date IS NULL OR x.event_date <= $4::date)))
        AND ($5::text='' OR CONCAT_WS(' ',d.counterparty_name,d.basis,d.document_reference,d.id::text) ILIKE '%'||$5||'%')
      GROUP BY d.venue_id,d.id ORDER BY d.created_at DESC,d.id DESC LIMIT 501`,[venueId,kind,from||null,to||null,q]);return json(res,200,{items:rows.slice(0,500),possiblyTruncated:rows.length>500});
    }catch(_){return jsonError(json,res,503,'finance_funding_unavailable');}
  }
  if(detail&&req.method==='GET'){
    try{const item=await readDocument(pool,venueId,detail[1]);return item?json(res,200,item):jsonError(json,res,404,'funding_document_not_found');}catch(_){return jsonError(json,res,503,'finance_funding_unavailable');}
  }
  if(url.pathname===base&&req.method==='POST'){
    if(!canWrite)return jsonError(json,res,403,'forbidden');if(!uuid.test(actorId))return jsonError(json,res,403,'forbidden');
    let input;try{input=await readBody(req);}catch(_){return jsonError(json,res,400,'invalid_funding_document');}
    if(!input||typeof input!=='object'||Array.isArray(input)||!hasOnly(input,['documentType','counterpartyName','basis','documentReference','principalLimit','idempotencyKey']))return jsonError(json,res,400,'invalid_funding_document');
    const documentType=String(input.documentType||'');const counterpartyName=clean(input.counterpartyName,160);const basis=clean(input.basis,500);const documentReference=clean(input.documentReference,160);const principalLimit=documentType==='loan'?money(input.principalLimit):null;const idempotencyKey=String(input.idempotencyKey||'').toLowerCase();
    if(!['owner_contribution','loan'].includes(documentType)||!counterpartyName||!basis||(documentType==='loan'&&!principalLimit)||(documentType==='owner_contribution'&&input.principalLimit!=null&&String(input.principalLimit)!=='')||!uuid.test(idempotencyKey)||String(input.counterpartyName||'').trim().length>160||String(input.basis||'').trim().length>500||String(input.documentReference||'').trim().length>160)return jsonError(json,res,400,'invalid_funding_document');
    const normalized={documentType,counterpartyName,basis,documentReference,principalLimit};const requestHash=fingerprint(normalized);
    try{const prior=await findDocByKey(pool,venueId,idempotencyKey);if(prior){if(prior.request_sha256!==requestHash)return jsonError(json,res,409,'idempotency_key_reused');return json(res,200,{...(await readDocument(pool,venueId,prior.id)),idempotent:true});}
      const {rows}=await pool.query(`INSERT INTO finance_funding_documents(venue_id,document_type,counterparty_name,basis,document_reference,principal_limit,idempotency_key,request_sha256,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(venue_id,idempotency_key) DO NOTHING RETURNING id`,[venueId,documentType,counterpartyName,basis,documentReference,principalLimit,idempotencyKey,requestHash,actorId]);
      const id=rows[0]?.id;if(!id){const raced=await findDocByKey(pool,venueId,idempotencyKey);if(!raced)return jsonError(json,res,503,'finance_funding_create_result_unknown');if(raced.request_sha256!==requestHash)return jsonError(json,res,409,'idempotency_key_reused');return json(res,200,{...(await readDocument(pool,venueId,raced.id)),idempotent:true});}
      const item=await readDocument(pool,venueId,id);recordAudit?.(req,'finance.funding_document_created','finance_funding_document',id,null,item);return json(res,201,item);
    }catch(_){return jsonError(json,res,503,'finance_funding_save_failed');}
  }
  if(detail&&req.method==='PATCH'){
    if(!canWrite)return jsonError(json,res,403,'forbidden');let input;try{input=await readBody(req);}catch(_){return jsonError(json,res,400,'invalid_funding_document');}
    if(!input||typeof input!=='object'||Array.isArray(input)||!hasOnly(input,['counterpartyName','basis','documentReference','principalLimit']))return jsonError(json,res,400,'invalid_funding_document');
    const client=await pool.connect();try{await client.query('BEGIN');const current=(await client.query('SELECT * FROM finance_funding_documents WHERE venue_id=$1 AND id=$2 FOR UPDATE',[venueId,detail[1]])).rows[0];if(!current){await client.query('ROLLBACK');return jsonError(json,res,404,'funding_document_not_found');}const count=(await client.query('SELECT EXISTS(SELECT 1 FROM finance_funding_events WHERE venue_id=$1 AND document_id=$2) AS has_events',[venueId,detail[1]])).rows[0].has_events;if(current.status!=='draft'||count){await client.query('ROLLBACK');return jsonError(json,res,409,'funding_document_immutable');}
      const counterpartyName=input.counterpartyName===undefined?current.counterparty_name:clean(input.counterpartyName,160);const basis=input.basis===undefined?current.basis:clean(input.basis,500);const documentReference=input.documentReference===undefined?current.document_reference:clean(input.documentReference,160);const principalLimit=input.principalLimit===undefined?current.principal_limit:current.document_type==='loan'?money(input.principalLimit):null;
      const rawCounterparty=input.counterpartyName===undefined?current.counterparty_name:String(input.counterpartyName??'').trim();const rawBasis=input.basis===undefined?current.basis:String(input.basis??'').trim();const rawReference=input.documentReference===undefined?current.document_reference:String(input.documentReference??'').trim();
      if(!counterpartyName||!basis||(current.document_type==='loan'&&!principalLimit)||(current.document_type==='owner_contribution'&&input.principalLimit!=null&&String(input.principalLimit)!=='')||rawCounterparty.length>160||rawBasis.length>500||rawReference.length>160) {await client.query('ROLLBACK');return jsonError(json,res,400,'invalid_funding_document');}
      await client.query('UPDATE finance_funding_documents SET counterparty_name=$3,basis=$4,document_reference=$5,principal_limit=$6 WHERE venue_id=$1 AND id=$2',[venueId,detail[1],counterpartyName,basis,documentReference,principalLimit]);await client.query('COMMIT');const item=await readDocument(pool,venueId,detail[1]);recordAudit?.(req,'finance.funding_document_updated','finance_funding_document',detail[1],current,item);return json(res,200,item);
    }catch(_){await client.query('ROLLBACK').catch(()=>{});return jsonError(json,res,503,'finance_funding_save_failed');}finally{client.release();}
  }
  if(cancelRoute&&req.method==='POST'){
    if(!canWrite)return jsonError(json,res,403,'forbidden');try{const {rows}=await pool.query("UPDATE finance_funding_documents SET status='cancelled' WHERE venue_id=$1 AND id=$2 AND status='draft' RETURNING id",[venueId,cancelRoute[1]]);if(!rows[0]){const item=await readDocument(pool,venueId,cancelRoute[1]);return item?.status==='cancelled'?json(res,200,{...item,idempotent:true}):jsonError(json,res,item?409:404,item?'funding_document_not_draft':'funding_document_not_found');}const item=await readDocument(pool,venueId,cancelRoute[1]);recordAudit?.(req,'finance.funding_document_cancelled','finance_funding_document',cancelRoute[1],null,item);return json(res,200,item);}catch(_){return jsonError(json,res,503,'finance_funding_save_failed');}
  }
  if(eventRoute&&req.method==='POST'){
    if(!canWrite)return jsonError(json,res,403,'forbidden');if(!uuid.test(actorId))return jsonError(json,res,403,'forbidden');let input;try{input=await readBody(req);}catch(_){return jsonError(json,res,400,'invalid_funding_event');}
    if(!input||typeof input!=='object'||Array.isArray(input)||!hasOnly(input,['eventType','amount','eventDate','financeAccountId','paymentMethod','note','idempotencyKey']))return jsonError(json,res,400,'invalid_funding_event');
    const eventType=String(input.eventType||'');const amount=money(input.amount);const eventDate=String(input.eventDate||'');const accountId=String(input.financeAccountId||'').toLowerCase();const paymentMethod=String(input.paymentMethod||'');const note=String(input.note||'').trim();const idempotencyKey=String(input.idempotencyKey||'').toLowerCase();
    if(!eventTypes.has(eventType)||!amount||!isoDate(eventDate)||!uuid.test(accountId)||!['cash','card','qr','bank_transfer','other'].includes(paymentMethod)||note.length>500||!uuid.test(idempotencyKey))return jsonError(json,res,400,'invalid_funding_event');
    const normalized={documentId:eventRoute[1].toLowerCase(),eventType,amount,eventDate,financeAccountId:accountId,paymentMethod,note};const requestHash=fingerprint(normalized);
    const matches=async(row)=>{if(row.document_id!==eventRoute[1].toLowerCase()||row.request_sha256!==requestHash)return false;return true;};
    const replay=async()=>{const prior=await findEventByKey(pool,venueId,idempotencyKey);if(!prior)return null;if(!(await matches(prior)))return false;return {...(await readDocument(pool,venueId,prior.document_id)),createdEventId:prior.id};};
    const existing=await replay();if(existing===false)return jsonError(json,res,409,'idempotency_key_reused');if(existing)return json(res,200,{...existing,idempotent:true});
    const client=await pool.connect();try{await client.query('BEGIN');const doc=(await client.query('SELECT id,status FROM finance_funding_documents WHERE venue_id=$1 AND id=$2 FOR UPDATE',[venueId,eventRoute[1]])).rows[0];if(!doc){await client.query('ROLLBACK');return jsonError(json,res,404,'funding_document_not_found');}if(doc.status==='cancelled'){await client.query('ROLLBACK');return jsonError(json,res,409,'funding_document_not_open');}
      const account=(await client.query('SELECT id,name,kind,active,allowed_payment_methods AS "allowedPaymentMethods" FROM finance_accounts WHERE venue_id=$1 AND id=$2 FOR UPDATE',[venueId,accountId])).rows[0];if(!account){await client.query('ROLLBACK');return jsonError(json,res,404,'finance_account_not_found');}if(!account.active){await client.query('ROLLBACK');return jsonError(json,res,409,'finance_account_inactive');}if(!(account.allowedPaymentMethods||[]).includes(paymentMethod)){await client.query('ROLLBACK');return jsonError(json,res,400,'finance_payment_method_account_mismatch');}
      let shiftId=null;if(account.kind==='pos_cashbox'){if(paymentMethod!=='cash'){await client.query('ROLLBACK');return jsonError(json,res,400,'finance_payment_method_account_mismatch');}const localDate=(await client.query("SELECT (now() AT TIME ZONE COALESCE(NULLIF(timezone,''),'Europe/Moscow'))::date::text AS today FROM venues WHERE id=$1",[venueId])).rows[0]?.today;if(String(localDate||'')!==eventDate){await client.query('ROLLBACK');return jsonError(json,res,409,'finance_pos_cash_payment_date_must_be_today');}const shifts=(await client.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL FOR UPDATE',[venueId])).rows;if(shifts.length!==1){await client.query('ROLLBACK');return jsonError(json,res,409,'finance_payment_open_shift_required');}shiftId=shifts[0].id;}
      const {rows}=await client.query(`INSERT INTO finance_funding_events(venue_id,document_id,event_type,amount,event_date,finance_account_id,finance_account_name_snapshot,payment_method,shift_id,note,idempotency_key,request_sha256,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,[venueId,eventRoute[1],eventType,amount,eventDate,accountId,account.name,paymentMethod,shiftId,note,idempotencyKey,requestHash,actorId]);
      if(doc.status==='draft')await client.query("UPDATE finance_funding_documents SET status='active' WHERE venue_id=$1 AND id=$2",[venueId,eventRoute[1]]);await client.query('COMMIT');const item=await readDocument(pool,venueId,eventRoute[1]);recordAudit?.(req,'finance.funding_event_created','finance_funding_event',rows[0].id,null,{documentId:eventRoute[1],eventType,amount,eventDate,financeAccountId:accountId,shiftId});return json(res,201,{...item,createdEventId:rows[0].id});
    }catch(error){await client.query('ROLLBACK').catch(()=>{});if(error.code==='23505'){const raced=await replay();if(raced===false)return jsonError(json,res,409,'idempotency_key_reused');if(raced)return json(res,200,{...raced,idempotent:true});}const errors={finance_funding_document_not_open:'funding_document_not_open',finance_funding_event_document_type_mismatch:'funding_event_document_type_mismatch',finance_loan_principal_limit_exceeded:'loan_principal_limit_exceeded',finance_loan_repayment_exceeds_principal:'loan_repayment_exceeds_principal',finance_account_inactive:'finance_account_inactive',finance_account_snapshot_mismatch:'finance_account_snapshot_mismatch',finance_payment_method_account_mismatch:'finance_payment_method_account_mismatch',finance_pos_cash_payment_date_must_be_today:'finance_pos_cash_payment_date_must_be_today',finance_payment_open_shift_required:'finance_payment_open_shift_required',finance_funding_non_pos_shift_invalid:'funding_non_pos_shift_invalid'};const known=errors[error.message];return jsonError(json,res,known?409:error.code==='23514'?409:503,known||'finance_funding_save_failed');}finally{client.release();}
  }
  return jsonError(json,res,405,'method_not_allowed');
}

module.exports={handleFinanceFundingRoute};
