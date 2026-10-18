'use strict';

const crypto = require('node:crypto');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const operationalRoles = new Set(['bartender','hookah_master','senior_bartender','senior_hookah_master','cleaner','security','technician','other_staff','staff']);
const dateOnly = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
const amountText = value => {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const minor = BigInt(match[1])*100n+BigInt((match[2]||'').padEnd(2,'0'));
  return minor > 0n ? `${minor/100n}.${String(minor%100n).padStart(2,'0')}` : null;
};
const fields = `o.id,o.expense_id AS "expenseId",o.source_payable_id AS "sourcePayableId",o.destination_payable_id AS "destinationPayableId",o.amount::text,o.offset_date::text AS "offsetDate",o.reason,o.document_reference AS "documentReference",o.reversal_of_id AS "reversalOfId",o.idempotency_key AS "idempotencyKey",o.created_by AS "createdBy",o.created_at AS "recordedAt"`;

async function handleFinancePayableOffsetRoute({req,res,url,pool,venueId,json,readBody,hasPermission,recordAudit}) {
  const match = url.pathname.match(/^\/api\/finance\/payables\/([^/]+)\/offsets(?:\/([^/]+)\/reversals)?$/);
  if (!match) return false;
  const send = (status,payload) => { json(res,status,payload); return true; };
  if ((!hasPermission('finance')&&!hasPermission('finance_read')) || operationalRoles.has(String(req.user?.role||'').toLowerCase())) return send(403,{error:'forbidden'});
  if (req.method!=='GET'&&!hasPermission('finance')) return send(403,{error:'forbidden'});
  if (!uuid.test(match[1]) || (match[2]&&!uuid.test(match[2]))) return send(404,{error:'finance_payable_not_found'});
  if (!pool) return send(503,{error:'finance_database_required'});
  const payableId=match[1].toLowerCase(), reversalId=match[2]?.toLowerCase()||null;
  if (!['GET','POST'].includes(req.method) || (req.method==='GET'&&reversalId)) return send(405,{error:'method_not_allowed'});
  let client;
  try {
    client=await pool.connect();
    if (req.method==='GET') {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const document=(await client.query(`SELECT id,title,counterparty_name AS "counterpartyName",basis,status,total_amount::text AS "totalAmount",finance_payable_settled_amount(venue_id,id)::text AS "settledAmount" FROM finance_payables WHERE venue_id=$1 AND id=$2`,[venueId,payableId])).rows[0];
      if (!document) { await client.query('ROLLBACK'); return send(404,{error:'finance_payable_not_found'}); }
      const history=await client.query(`SELECT ${fields},s.title AS "sourceTitle",d.title AS "destinationTitle",s.counterparty_name AS "sourceCounterpartyName",d.counterparty_name AS "destinationCounterpartyName",COALESCE((SELECT SUM(r.amount) FROM finance_payable_offsets r WHERE r.venue_id=o.venue_id AND r.reversal_of_id=o.id),0)::text AS "reversedAmount"
        FROM finance_payable_offsets o JOIN finance_payables s ON s.venue_id=o.venue_id AND s.id=o.source_payable_id JOIN finance_payables d ON d.venue_id=o.venue_id AND d.id=o.destination_payable_id
        WHERE o.venue_id=$1 AND (o.source_payable_id=$2 OR o.destination_payable_id=$2) ORDER BY o.offset_date,o.created_at,o.id`,[venueId,payableId]);
      const allocations=await client.query(`WITH candidates AS (
        SELECT expense_id FROM finance_payable_payment_links WHERE venue_id=$1 AND payable_id=$2
        UNION SELECT expense_id FROM finance_payable_offsets WHERE venue_id=$1 AND (source_payable_id=$2 OR destination_payable_id=$2))
        SELECT e.id AS "expenseId",l.payable_id AS "originalPayableId",e.amount::text AS "originalAmount",e.expense_date::text AS "paymentDate",finance_payable_expense_allocation($1,e.id,$2)::text AS "availableAmount"
        FROM candidates c JOIN expenses e ON e.venue_id=$1 AND e.id=c.expense_id JOIN finance_payable_payment_links l ON l.venue_id=e.venue_id AND l.expense_id=e.id
        WHERE finance_payable_expense_allocation($1,e.id,$2)>0 ORDER BY e.expense_date,e.created_at,e.id`,[venueId,payableId]);
      await client.query('COMMIT');
      return send(200,{document,items:history.rows,allocations:allocations.rows,cashEffect:'none',recognitionEffect:'none'});
    }
    const body=await readBody(req);
    const amount=amountText(body.amount), offsetDate=String(body.offsetDate||''), reason=String(body.reason||'').trim(), documentReference=String(body.documentReference||'').trim(), key=String(body.idempotencyKey||'');
    if (!amount||!dateOnly(offsetDate)||reason.length<3||reason.length>500||documentReference.length>200||key.length<8||key.length>120) return send(400,{error:'invalid_finance_payable_offset'});
    if (!reversalId&&(!uuid.test(body.expenseId||'')||!uuid.test(body.destinationPayableId||''))) return send(400,{error:'invalid_finance_payable_offset'});
    const payload={payableId,reversalId,expenseId:reversalId?null:body.expenseId.toLowerCase(),destinationPayableId:reversalId?null:body.destinationPayableId.toLowerCase(),amount,offsetDate,reason,documentReference};
    const hash=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await client.query('BEGIN');
    // Serialize the request identity before document locks, including retries after cancellation.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`payable-offset:${venueId}:${key}`]);
    const existing=(await client.query(`SELECT ${fields},o.request_sha256 FROM finance_payable_offsets o WHERE o.venue_id=$1 AND o.idempotency_key=$2`,[venueId,key])).rows[0];
    if (existing) {
      if (existing.request_sha256!==hash) { await client.query('ROLLBACK'); return send(409,{error:'finance_payable_offset_idempotency_conflict'}); }
      delete existing.request_sha256;
      await client.query('COMMIT'); return send(200,{...existing,idempotent:true});
    }
    let expenseId=payload.expenseId,sourceId=payableId,destinationId=payload.destinationPayableId;
    if (reversalId) {
      const original=(await client.query('SELECT * FROM finance_payable_offsets WHERE venue_id=$1 AND id=$2 AND source_payable_id=$3',[venueId,reversalId,payableId])).rows[0];
      if (!original) { await client.query('ROLLBACK'); return send(404,{error:'finance_payable_offset_not_found'}); }
      expenseId=original.expense_id; sourceId=original.destination_payable_id; destinationId=original.source_payable_id;
    }
    const originalLink=(await client.query('SELECT payable_id FROM finance_payable_payment_links WHERE venue_id=$1 AND expense_id=$2',[venueId,expenseId])).rows[0];
    if (!originalLink) { await client.query('ROLLBACK'); return send(404,{error:'finance_payable_offset_payment_not_found'}); }
    const locked=await client.query('SELECT id FROM finance_payables WHERE venue_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[venueId,[originalLink.payable_id,sourceId,destinationId]]);
    if (![sourceId,destinationId].every(id=>locked.rows.some(row=>row.id===id))) { await client.query('ROLLBACK'); return send(404,{error:'finance_payable_not_found'}); }
    const inserted=await client.query(`INSERT INTO finance_payable_offsets AS o(venue_id,expense_id,source_payable_id,destination_payable_id,amount,offset_date,reason,document_reference,reversal_of_id,idempotency_key,request_sha256,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${fields}`,[venueId,expenseId,sourceId,destinationId,amount,offsetDate,reason,documentReference||null,reversalId,key,hash,req.user.id]);
    await client.query('COMMIT');
    recordAudit?.(req,reversalId?'finance.payable_offset_reversed':'finance.payable_offset_created','finance_payable',payableId,null,inserted.rows[0]);
    return send(201,{...inserted.rows[0],idempotent:false});
  } catch(error) {
    if(client) await client.query('ROLLBACK').catch(()=>{});
    const expected=['23514','23505','55000'].includes(error.code);
    return send(expected?409:503,{error:expected&&/^finance_payable_offset_[a-z_]+$/.test(error.message)?error.message:'finance_payable_offset_failed'});
  } finally { client?.release(); }
}

module.exports={handleFinancePayableOffsetRoute};
