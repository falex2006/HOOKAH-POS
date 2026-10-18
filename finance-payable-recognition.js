'use strict';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const dateOnly=(value)=>{const s=String(value||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const d=new Date(`${s}T00:00:00Z`);return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===s;};
const cents=(value)=>{const s=String(value??'').trim().replace(',','.');if(!/^\d{1,12}(?:\.\d{1,2})?$/.test(s))return null;const [whole,fraction='']=s.split('.');return Number(whole)*100+Number(fraction.padEnd(2,'0'));};
const amountText=(value)=>{const n=Math.trunc(value);return `${Math.floor(n/100)}.${String(n%100).padStart(2,'0')}`;};
const fail=(json,res,status,error)=>{json(res,status,{error});return true;};

async function handleFinancePayableRecognitionRoute({req,res,url,pool,venueId,json,readBody,hasPermission,recordAudit}){
  const match=url.pathname.match(/^\/api\/finance\/payables\/([^/]+)\/recognitions(?:\/([^/]+)\/reversals)?$/);
  if(!match)return false;
  const [,rawPayableId,rawRecognitionId]=match;
  if(!uuid.test(rawPayableId)||(rawRecognitionId&&!uuid.test(rawRecognitionId)))return fail(json,res,404,'finance_payable_not_found');
  const payableId=decodeURIComponent(rawPayableId),recognitionId=rawRecognitionId?decodeURIComponent(rawRecognitionId):null;
  if(!hasPermission('finance')&&!hasPermission('finance_read'))return fail(json,res,403,'forbidden');
  if(['bartender','hookah_master','senior_bartender','senior_hookah_master','cleaner','security','technician','other_staff','staff'].includes(String(req.user?.role||'').toLowerCase()))return fail(json,res,403,'forbidden');
  if(req.method!=='GET'&&!hasPermission('finance'))return fail(json,res,403,'forbidden');
  if(!pool)return fail(json,res,503,'finance_database_required');
  if(req.method==='GET'&&!recognitionId){
    try{
      const {rows}=await pool.query(`SELECT r.id,r.payable_id AS "payableId",r.category_id AS "categoryId",r.category_name_snapshot AS "categoryName",r.title_snapshot AS title,r.counterparty_name_snapshot AS "counterpartyName",r.basis_snapshot AS basis,r.service_period_from::text AS "servicePeriodFrom",r.service_period_to::text AS "servicePeriodTo",r.amount::text,r.recognition_date::text AS "recognitionDate",r.document_reference AS "documentReference",r.created_by AS "createdBy",r.created_at AS "recordedAt",COALESCE(x.amount,0)::text AS "reversedAmount",(r.amount-COALESCE(x.amount,0))::text AS "netRecognizedAmount",COALESCE(x.items,'[]'::jsonb) AS reversals
        FROM finance_payable_recognitions r LEFT JOIN LATERAL(SELECT SUM(v.amount)::numeric(14,2) AS amount,jsonb_agg(jsonb_build_object('id',v.id,'amount',v.amount,'reversalDate',v.reversal_date::text,'reason',v.reason,'documentReference',v.document_reference,'createdBy',v.created_by,'recordedAt',v.created_at) ORDER BY v.reversal_date,v.created_at,v.id) AS items FROM finance_payable_recognition_reversals v WHERE v.venue_id=r.venue_id AND v.recognition_id=r.id) x ON true
        WHERE r.venue_id=$1 AND r.payable_id=$2`,[venueId,payableId]);
      return json(res,200,{items:rows});
    }catch(error){return json(res,503,{error:'finance_payable_recognition_unavailable'});}
  }
  if(req.method==='POST'&&!recognitionId){
    const input=await readBody(req);const recognitionDate=String(input.recognitionDate||'');const key=String(input.idempotencyKey||'');const documentReference=String(input.documentReference||'').trim();
    if(!dateOnly(recognitionDate)||key.length<8||key.length>120||documentReference.length>200)return fail(json,res,400,'invalid_finance_payable_recognition');
    const client=await pool.connect();try{
      await client.query('BEGIN');
      const existingKey=await client.query(`SELECT r.id,r.payable_id,r.recognition_date::text AS recognition_date,r.document_reference,r.amount::text FROM finance_payable_recognitions r WHERE r.venue_id=$1 AND r.idempotency_key=$2`,[venueId,key]);
      if(existingKey.rows[0]){const row=existingKey.rows[0];if(row.payable_id===payableId&&row.recognition_date===recognitionDate&&(row.document_reference||'')===(documentReference||'')){await client.query('COMMIT');return json(res,200,{id:row.id,amount:row.amount,idempotent:true});}await client.query('ROLLBACK');return fail(json,res,409,'finance_payable_recognition_idempotency_conflict');}
      const payable=(await client.query(`SELECT id,category_id,category_name_snapshot,title,counterparty_name,basis,period_from::text AS period_from,period_to::text AS period_to,total_amount::text,status FROM finance_payables WHERE venue_id=$1 AND id=$2 FOR UPDATE`,[venueId,payableId])).rows[0];
      if(!payable){await client.query('ROLLBACK');return fail(json,res,404,'finance_payable_not_found');}
      if(payable.status!=='approved'){await client.query('ROLLBACK');return fail(json,res,409,'finance_payable_not_approved');}
      const concurrentKey=await client.query(`SELECT r.id,r.payable_id,r.recognition_date::text AS recognition_date,r.document_reference,r.amount::text FROM finance_payable_recognitions r WHERE r.venue_id=$1 AND r.idempotency_key=$2`,[venueId,key]);
      if(concurrentKey.rows[0]){const row=concurrentKey.rows[0];if(row.payable_id===payableId&&row.recognition_date===recognitionDate&&(row.document_reference||'')===(documentReference||'')){await client.query('COMMIT');return json(res,200,{id:row.id,amount:row.amount,idempotent:true});}await client.query('ROLLBACK');return fail(json,res,409,'finance_payable_recognition_idempotency_conflict');}
      const prior=await client.query(`SELECT id FROM finance_payable_recognitions WHERE venue_id=$1 AND payable_id=$2`,[venueId,payableId]);
      if(prior.rows[0]){await client.query('ROLLBACK');return fail(json,res,409,'finance_payable_already_recognized');}
      const inserted=await client.query(`INSERT INTO finance_payable_recognitions (venue_id,payable_id,category_id,category_name_snapshot,title_snapshot,counterparty_name_snapshot,basis_snapshot,service_period_from,service_period_to,amount,recognition_date,document_reference,idempotency_key,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id,amount::text`,[venueId,payableId,payable.category_id,payable.category_name_snapshot,payable.title,payable.counterparty_name,payable.basis,payable.period_from,payable.period_to,payable.total_amount,recognitionDate,documentReference||null,key,req.user.id]);
      await client.query('COMMIT');recordAudit?.(req,'finance.payable_recognized','finance_payable',payableId,null,{recognitionId:inserted.rows[0].id,amount:inserted.rows[0].amount,recognitionDate});return json(res,201,{id:inserted.rows[0].id,amount:inserted.rows[0].amount,idempotent:false});
    }catch(error){await client.query('ROLLBACK').catch(()=>{});return json(res,['23505','23514'].includes(error.code)?409:503,{error:error.code==='23514'?error.message:'finance_payable_recognition_failed'});}finally{client.release();}
  }
  if(req.method==='POST'&&recognitionId){
    const input=await readBody(req);const amountCents=cents(input.amount);const reversalDate=String(input.reversalDate||'');const reason=String(input.reason||'').trim();const key=String(input.idempotencyKey||'');const documentReference=String(input.documentReference||'').trim();
    if(amountCents===null||amountCents<=0||!dateOnly(reversalDate)||reason.length<1||reason.length>500||key.length<8||key.length>120||documentReference.length>200)return fail(json,res,400,'invalid_finance_payable_recognition_reversal');
    const client=await pool.connect();try{
      await client.query('BEGIN');
      const source=(await client.query(`SELECT p.id AS payable_id,r.id AS recognition_id FROM finance_payables p JOIN finance_payable_recognitions r ON r.venue_id=p.venue_id AND r.payable_id=p.id WHERE p.venue_id=$1 AND p.id=$2 AND r.id=$3 FOR UPDATE OF p`,[venueId,payableId,recognitionId])).rows[0];
      if(!source){await client.query('ROLLBACK');return fail(json,res,404,'finance_payable_recognition_not_found');}
      const existingKey=await client.query(`SELECT id,recognition_id,amount::text,reversal_date::text AS reversal_date,reason,document_reference FROM finance_payable_recognition_reversals WHERE venue_id=$1 AND idempotency_key=$2`,[venueId,key]);
      if(existingKey.rows[0]){const row=existingKey.rows[0];if(row.recognition_id===recognitionId&&Number(cents(row.amount))===amountCents&&row.reversal_date===reversalDate&&row.reason===reason&&(row.document_reference||'')===(documentReference||'')){await client.query('COMMIT');return json(res,200,{id:row.id,amount:amountText(amountCents),idempotent:true});}await client.query('ROLLBACK');return fail(json,res,409,'finance_payable_recognition_reversal_idempotency_conflict');}
      const reversed=(await client.query(`SELECT r.amount::text AS amount,COALESCE(SUM(v.amount),0)::text AS reversed FROM finance_payable_recognitions r LEFT JOIN finance_payable_recognition_reversals v ON v.venue_id=r.venue_id AND v.recognition_id=r.id WHERE r.venue_id=$1 AND r.id=$2 GROUP BY r.venue_id,r.id`,[venueId,recognitionId])).rows[0];
      if(!reversed){await client.query('ROLLBACK');return fail(json,res,404,'finance_payable_recognition_not_found');}
      if(amountCents>cents(reversed.amount)-cents(reversed.reversed)){await client.query('ROLLBACK');return fail(json,res,409,'finance_payable_recognition_reversal_exceeds_balance');}
      const inserted=await client.query(`INSERT INTO finance_payable_recognition_reversals (venue_id,recognition_id,amount,reversal_date,reason,document_reference,idempotency_key,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[venueId,recognitionId,amountText(amountCents),reversalDate,reason,documentReference||null,key,req.user.id]);
      await client.query('COMMIT');recordAudit?.(req,'finance.payable_recognition_reversed','finance_payable',payableId,null,{recognitionId,reversalId:inserted.rows[0].id,amount:amountText(amountCents),reversalDate,reason});return json(res,201,{id:inserted.rows[0].id,amount:amountText(amountCents),signedAmount:`-${amountText(amountCents)}`,idempotent:false});
    }catch(error){await client.query('ROLLBACK').catch(()=>{});return json(res,['23505','23514'].includes(error.code)?409:503,{error:error.code==='23514'?error.message:'finance_payable_recognition_reversal_failed'});}finally{client.release();}
  }
  return fail(json,res,405,'method_not_allowed');
}
module.exports={handleFinancePayableRecognitionRoute};
