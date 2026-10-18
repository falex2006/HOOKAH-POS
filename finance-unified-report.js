'use strict';
const crypto=require('node:crypto');
const { orderPricingSqlCtes } = require('./pos-order-pricing-sql');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isoDate=value=>{const s=String(value||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const d=new Date(`${s}T00:00:00Z`);return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===s;};
const send=(json,res,status,error)=>{json(res,status,{error});return true;};
const operationalRoles=new Set(['bartender','hookah_master','senior_bartender','senior_hookah_master','cleaner','security','technician','other_staff','staff']);
const SNAPSHOT_PAGE_SIZE=500;
const SNAPSHOT_MAX_ROWS=50000;
const SNAPSHOT_MAX_BYTES=32*1024*1024;
const amountFields={guestAdvanceCashEvents:r=>r.signedCashFlowAmount,pos:r=>r.includedAmountMinor??r.recognizedTotalMinor,posRefundItems:r=>r.returnedItemValueMinor,legacyPos:r=>r.amount,payrollAccruals:r=>r.recognizedInRange,obligations:r=>r.balanceDue,obligationRecognitions:r=>r.amount,obligationRecognitionAdjustments:r=>r.signedAmount,purchaseReceipts:r=>r.acquisitionAmount,otherIncomeRecognition:r=>r.netRecognizedAmount,otherIncomeAdjustments:r=>r.signedAmount,otherIncomeRefunds:r=>r.signedAmount,manualExpenseCorrections:r=>r.signedAmount,payableRecognitionCoverage:r=>r.unrecognizedAmount,financingEvents:r=>r.signedCashFlowAmount,internalTransfers:r=>r.signedAccountMovement,openingBalances:()=>null,openingBalanceAdjustments:()=>null};
const decimalMinor=value=>{if(value===null||value===undefined)return null;const m=/^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));if(!m)return null;let n=BigInt(m[2])*100n+BigInt(((m[3]||'')+'00').slice(0,2));if(((m[3]||'')[2]||'0')>='5')n++;return m[1]==='-'?-n:n;};
const reportSectionSummary=items=>Object.fromEntries(Object.entries(items||{}).map(([key,rows])=>{const known=rows.map(row=>{const raw=amountFields[key]?amountFields[key](row):row.amount;return key==='pos'||key==='posRefundItems'?(raw==null||! /^-?\d+$/.test(String(raw))?null:BigInt(raw)):decimalMinor(raw);}).filter(v=>v!==null);return[key,{count:rows.length,unknownAmountCount:rows.length-known.length,knownTotalMinor:known.reduce((sum,v)=>sum+v,0n).toString()}];}));
const opaqueCursor=(secret,snapshotId,section,offset)=>{const body=Buffer.from(JSON.stringify({snapshotId,section,offset})).toString('base64url');const sig=crypto.createHmac('sha256',Buffer.from(secret,'hex')).update(body).digest('base64url');return `${body}.${sig}`;};
const readCursor=(secret,cursor,snapshotId,section)=>{if(typeof cursor!=='string'||cursor.length>512)return null;const [body,sig,extra]=cursor.split('.');if(!body||!sig||extra!==undefined)return null;const expected=crypto.createHmac('sha256',Buffer.from(secret,'hex')).update(body).digest();let actual;try{actual=Buffer.from(sig,'base64url');}catch(_){return null;}if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))return null;try{const data=JSON.parse(Buffer.from(body,'base64url').toString());return data.snapshotId===snapshotId&&data.section===section&&Number.isInteger(data.offset)&&data.offset>=0?data.offset:null;}catch(_){return null;}};
const guestAdvanceCashSql = `WITH advance_events AS (
 SELECT r.id,r.venue_id,r.guest_id,NULL::uuid AS reservation_id,r.id AS source_id,'guest_deposit_received'::text AS event_type,r.amount,r.amount AS signed_amount,r.payment_method AS method,r.shift_id,r.reason,r.actor_id,r.created_at
 FROM guest_deposit_receipts r WHERE r.venue_id=$1
 UNION ALL SELECT r.id,r.venue_id,r.guest_id,NULL::uuid,r.source_entry_id,'guest_deposit_refunded',r.amount,-r.amount,r.payout_method,r.shift_id,r.reason,r.actor_id,r.created_at
 FROM guest_account_reversals r WHERE r.venue_id=$1 AND r.account_type='deposit' AND r.payout_method IN ('cash','card','qr')
 UNION ALL SELECT r.id,r.venue_id,b.guest_id,r.reservation_id,r.id,'reservation_advance_received',r.amount,r.amount,r.payment_method,r.shift_id,r.reason,r.actor_id,r.created_at
 FROM reservation_pre_payment_receipts r JOIN reservations b ON b.venue_id=r.venue_id AND b.id=r.reservation_id WHERE r.venue_id=$1
 UNION ALL SELECT r.id,r.venue_id,b.guest_id,r.reservation_id,r.receipt_id,'reservation_advance_refunded',r.amount,-r.amount,r.payout_method,r.shift_id,r.reason,r.actor_id,r.created_at
 FROM reservation_pre_payment_receipt_reversals r JOIN reservations b ON b.venue_id=r.venue_id AND b.id=r.reservation_id WHERE r.venue_id=$1
 ), selected_advances AS (
 SELECT e.*,g.full_name AS counterparty_name FROM advance_events e LEFT JOIN guests g ON g.venue_id=e.venue_id AND g.id=e.guest_id
 WHERE e.created_at>=($2::date::timestamp AT TIME ZONE $4) AND e.created_at<(($3::date+1)::timestamp AT TIME ZONE $4)
 AND ($5::text='' OR $5='posted') AND ($6::text='' OR CONCAT_WS(' ',e.id::text,e.source_id::text,e.guest_id::text,e.reservation_id::text,g.full_name,e.reason) ILIKE '%'||$6||'%')
 )`;
async function handleFinanceUnifiedReport({req,res,url,pool,venueId,json,hasPermission,resolveVenues,readBody,readSource,snapshotMode=false}){
  const sourceDocumentPath=url.pathname.match(/^\/api\/finance\/source-documents\/(purchase|payroll|pos)\/([^/]+)$/);
  if(sourceDocumentPath){
    if(req.method!=='GET')return send(json,res,405,'method_not_allowed');
    if(operationalRoles.has(String(req.user?.role||'').toLowerCase())||(!hasPermission('finance')&&!hasPermission('finance_read')))return send(json,res,403,'forbidden');
    const [,kind,id]=sourceDocumentPath;
    const selectedVenueId=String(url.searchParams.get('venueId')||venueId||'');
    if(!uuid.test(id)||!uuid.test(selectedVenueId))return send(json,res,400,'invalid_finance_source_document');
    if(!pool||typeof resolveVenues!=='function'||typeof readSource!=='function')return send(json,res,503,'finance_source_document_unavailable');
    try{
      const selected=(await resolveVenues(req,selectedVenueId)).find(item=>String(item.id)===selectedVenueId);
      const permissions=selected?.permissions||[];
      const sourceAllowed=kind==='purchase'?permissions.includes('inventory')||permissions.includes('inventory_read'):permissions.includes(kind==='payroll'?'finance':'orders');
      if(!selected||!sourceAllowed||(!permissions.includes('finance')&&!permissions.includes('finance_read')))return send(json,res,403,'forbidden');
      const document=await readSource({kind,id,venueId:selected.id});
      if(!document)return send(json,res,404,'finance_source_document_not_found');
      if(String(document.id||document.orderId)!==id)throw new Error('finance_source_id_mismatch');
      json(res,200,{kind,id,venue:{id:selected.id,name:selected.name},basis:'current_source_document',document});return true;
    }catch(_){return send(json,res,503,'finance_source_document_unavailable');}
  }
  if(url.pathname==='/api/finance/report-venues'){
    if(req.method!=='GET')return send(json,res,405,'method_not_allowed');
    if(!hasPermission('finance')&&!hasPermission('finance_read'))return send(json,res,403,'forbidden');
    if(operationalRoles.has(String(req.user?.role||'').toLowerCase()))return send(json,res,403,'forbidden');
    if(!pool)return send(json,res,503,'finance_database_required');
    try{
      const venues=resolveVenues?await resolveVenues(req):[];
      return json(res,200,{items:venues.map(({id,name,timeZone,isCurrent})=>({id,name,timeZone,isCurrent}))});
    }catch(_){return send(json,res,503,'finance_report_venues_unavailable');}
  }
  if(url.pathname==='/api/finance/unified-report/snapshots'){
    if(req.method!=='POST')return send(json,res,405,'method_not_allowed');
    if(!hasPermission('finance')&&!hasPermission('finance_read'))return send(json,res,403,'forbidden');
    if(operationalRoles.has(String(req.user?.role||'').toLowerCase()))return send(json,res,403,'forbidden');
    if(!pool)return send(json,res,503,'finance_database_required');
    if(typeof readBody!=='function')return send(json,res,503,'finance_report_snapshot_unavailable');
    let body;try{body=await readBody(req);}catch(_){return send(json,res,400,'invalid_request_body');}
    if(!body||typeof body!=='object'||Array.isArray(body))return send(json,res,400,'invalid_finance_report_filters');
    const allowed=new Set(['from','to','source','categoryId','q','status','unmappedOnly','venueId']);
    if(Object.keys(body).some(key=>!allowed.has(key)))return send(json,res,400,'invalid_finance_report_filters');
    const key=String(req.headers?.['idempotency-key']||'');
    if(!uuid.test(key))return send(json,res,400,'invalid_idempotency_key');
    if(!uuid.test(String(req.user?.id||'')))return send(json,res,403,'forbidden');
    const normalized={from:String(body.from||''),to:String(body.to||''),source:String(body.source||''),categoryId:String(body.categoryId||''),q:String(body.q||'').trim().slice(0,160),status:String(body.status||''),unmappedOnly:body.unmappedOnly===true,venueId:String(body.venueId||venueId||'')};
    const urlParams=new URLSearchParams();for(const [name,value] of Object.entries(normalized))if(value!==''&&value!==false)urlParams.set(name,String(value));
    let generated;const nestedReq={...req,method:'GET'};const nestedUrl=new URL(`/api/finance/unified-report?${urlParams}&_materialize=1`,'http://local');
    await handleFinanceUnifiedReport({req:nestedReq,res,url:nestedUrl,pool,venueId,json:(_r,status,response)=>{generated={status,response};},hasPermission,resolveVenues,readBody,snapshotMode:true});
    if(!generated||generated.status!==200)return json(res,generated?.status||503,generated?.response||{error:'finance_unified_report_unavailable'}),true;
    const report=generated.response;const fullItems=report.items||{};if(Array.isArray(report.coverage?.payableRecognition?.items)){fullItems.payableRecognitionCoverage=report.coverage.payableRecognition.items;report.coverage.payableRecognition.items=[];}const reportSections=reportSectionSummary(fullItems);report.sections=reportSections;const totalRows=Object.values(fullItems).reduce((sum,rows)=>sum+(Array.isArray(rows)?rows.length:0),0);
    const serialized=JSON.stringify(report);if(totalRows>SNAPSHOT_MAX_ROWS||(report.coverage?.possiblyTruncatedSections||[]).length||Buffer.byteLength(serialized,'utf8')>SNAPSHOT_MAX_BYTES)return send(json,res,413,'finance_report_snapshot_too_large');
    const requestHash=crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');const cursorSecret=crypto.randomBytes(32).toString('hex');
    let saved;try{
      await pool.query('DELETE FROM finance_unified_report_snapshots WHERE expires_at<=clock_timestamp()');
      const inserted=await pool.query(`INSERT INTO finance_unified_report_snapshots(venue_id,created_by,idempotency_key,request_sha256,filters,report,cursor_secret)
        VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) ON CONFLICT(venue_id,created_by,idempotency_key) DO NOTHING RETURNING id,created_at,expires_at`,[report.venue.id,req.user.id,key,requestHash,JSON.stringify(normalized),serialized,cursorSecret]);
      if(inserted.rows[0])saved={...inserted.rows[0],report,cursorSecret};
      else {const prior=await pool.query(`SELECT id,created_at,expires_at,request_sha256,report,cursor_secret FROM finance_unified_report_snapshots WHERE venue_id=$1 AND created_by=$2 AND idempotency_key=$3`,[report.venue.id,req.user.id,key]);if(!prior.rows[0])throw new Error('snapshot_retry_missing');if(prior.rows[0].request_sha256!==requestHash)return send(json,res,409,'idempotency_key_conflict');const priorReport=typeof prior.rows[0].report==='string'?JSON.parse(prior.rows[0].report):prior.rows[0].report;if(priorReport?.payrollIncluded===true&&report.payrollIncluded!==true)return send(json,res,403,'forbidden');saved={...prior.rows[0],report:priorReport,cursorSecret:prior.rows[0].cursor_secret};}
    }catch(_){return send(json,res,503,'finance_report_snapshot_unavailable');}
    const sections=saved.report.sections||reportSectionSummary(saved.report.items);const firstItems={};const nextCursorBySection={};for(const [section,rows] of Object.entries(saved.report.items||{})){firstItems[section]=(rows||[]).slice(0,SNAPSHOT_PAGE_SIZE);if(rows.length>SNAPSHOT_PAGE_SIZE)nextCursorBySection[section]=opaqueCursor(saved.cursorSecret,saved.id,section,SNAPSHOT_PAGE_SIZE);}
    return json(res,201,{snapshot:{id:saved.id,createdAt:saved.created_at,expiresAt:saved.expires_at,pageSize:SNAPSHOT_PAGE_SIZE},sections,nextCursorBySection,items:firstItems,coverage:saved.report.coverage,venue:saved.report.venue});
  }
  const sectionPageMatch=url.pathname.match(/^\/api\/finance\/unified-report\/snapshots\/([0-9a-f-]{36})\/sections\/([A-Za-z][A-Za-z0-9]*)$/i);
  if(sectionPageMatch){
    if(req.method!=='GET')return send(json,res,405,'method_not_allowed');
    if(!hasPermission('finance')&&!hasPermission('finance_read'))return send(json,res,403,'forbidden');
    if(operationalRoles.has(String(req.user?.role||'').toLowerCase()))return send(json,res,403,'forbidden');
    if(!pool)return send(json,res,503,'finance_database_required');
    const [,snapshotId,section]=sectionPageMatch;const requestedVenueId=String(url.searchParams.get('venueId')||venueId||'');
    let targetPermissions=null;if(resolveVenues){try{const venues=await resolveVenues(req,requestedVenueId);const selected=venues.find(item=>String(item.id)===String(requestedVenueId));if(!selected)return send(json,res,404,'finance_report_snapshot_not_found');targetPermissions=Array.isArray(selected.permissions)?selected.permissions:[];}catch(_){return send(json,res,404,'finance_report_snapshot_not_found');}}
    let row;try{const found=await pool.query(`SELECT id,venue_id,created_by,created_at,expires_at,expires_at<=clock_timestamp() AS expired,cursor_secret FROM finance_unified_report_snapshots WHERE id=$1 AND venue_id=$2`,[snapshotId,requestedVenueId]);row=found.rows[0];}catch(_){return send(json,res,503,'finance_report_snapshot_unavailable');}
    if(!row)return send(json,res,404,'finance_report_snapshot_not_found');
    if(row.expired)return json(res,410,{error:'finance_report_snapshot_expired'}),true;
    const canReadTargetPayroll=targetPermissions?targetPermissions.includes('finance'):hasPermission('finance');
    if(['payrollAccruals','cashOutflows','cashAccountCoverage'].includes(section)&&!canReadTargetPayroll){
      try{const sensitive=await pool.query(`SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(report->'items'->$2,'[]'::jsonb)) AS item(value) WHERE item.value->>'source'='payroll') AS payroll_rows,
        COALESCE((report->'payrollIncluded')::boolean,false) AS payroll_included FROM finance_unified_report_snapshots WHERE id=$1 AND venue_id=$3`,[snapshotId,section,requestedVenueId]);
        if(section==='payrollAccruals'||sensitive.rows[0]?.payroll_included||sensitive.rows[0]?.payroll_rows)return send(json,res,403,'forbidden');
      }catch(_){return send(json,res,503,'finance_report_snapshot_unavailable');}
    }
    const cursor=url.searchParams.get('cursor');const offset=cursor?readCursor(row.cursor_secret,cursor,snapshotId,section):0;if(offset===null||offset%SNAPSHOT_PAGE_SIZE!==0)return send(json,res,400,'invalid_finance_report_cursor');
    let page;try{const selected=await pool.query(`SELECT report->'sections'->$3 AS section_meta,jsonb_array_length(COALESCE(report->'items'->$3,'[]'::jsonb))::int AS total_count,
        COALESCE((SELECT jsonb_agg(entry.item ORDER BY entry.ordinality) FROM jsonb_array_elements(COALESCE(report->'items'->$3,'[]'::jsonb)) WITH ORDINALITY AS entry(item,ordinality) WHERE entry.ordinality>$4 AND entry.ordinality<=$5),'[]'::jsonb) AS page_items
      FROM finance_unified_report_snapshots WHERE id=$1 AND venue_id=$2 AND expires_at>clock_timestamp()`,[snapshotId,requestedVenueId,section,offset,offset+SNAPSHOT_PAGE_SIZE]);page=selected.rows[0];}catch(_){return send(json,res,503,'finance_report_snapshot_unavailable');}
    if(!page)return json(res,410,{error:'finance_report_snapshot_expired'}),true;
    if(!page?.section_meta)return send(json,res,404,'finance_report_section_not_found');if(offset>Number(page.total_count||0))return send(json,res,400,'invalid_finance_report_cursor');
    const rows=Array.isArray(page.page_items)?page.page_items:[];const nextOffset=offset+rows.length;const nextCursor=nextOffset<Number(page.total_count||0)?opaqueCursor(row.cursor_secret,snapshotId,section,nextOffset):null;
    return json(res,200,{snapshot:{id:row.id,createdAt:row.created_at,expiresAt:row.expires_at,pageSize:SNAPSHOT_PAGE_SIZE},section,sections:{[section]:page.section_meta},items:{[section]:rows},nextCursor});
  }
  if(url.pathname!=='/api/finance/unified-report')return false;
  const respond=(status,body)=>{json(res,status,body);return true;};
  if(req.method!=='GET')return send(json,res,405,'method_not_allowed');
  if(!hasPermission('finance')&&!hasPermission('finance_read'))return send(json,res,403,'forbidden');
  if(operationalRoles.has(String(req.user?.role||'').toLowerCase()))return send(json,res,403,'forbidden');
  if(!pool)return send(json,res,503,'finance_database_required');
  const rowLimit=snapshotMode?SNAPSHOT_MAX_ROWS+1:SNAPSHOT_PAGE_SIZE;const from=String(url.searchParams.get('from')||'');const to=String(url.searchParams.get('to')||'');
  const source=String(url.searchParams.get('source')||'');const categoryId=String(url.searchParams.get('categoryId')||'');const q=String(url.searchParams.get('q')||'').trim().slice(0,160);const status=String(url.searchParams.get('status')||'');
  const unmappedOnlyRaw=String(url.searchParams.get('unmappedOnly')||'');const unmappedOnly=unmappedOnlyRaw==='true';
  if(!isoDate(from)||!isoDate(to)||from>to)return send(json,res,400,'invalid_finance_report_range');
  if(source&&!['pos','cash_in','cash_out','payroll_accrual','obligation','payable_offset','obligation_recognition','obligation_adjustment','purchase_receipt','refund','expense_refund','manual','manual_correction','purchase','payroll','other','other_income','other_income_recognition','other_income_receipt','other_income_adjustment','other_income_refund','funding','guest_advance','internal_transfer','opening_balance','opening_adjustment'].includes(source))return send(json,res,400,'invalid_finance_report_source');
  if(categoryId&&!uuid.test(categoryId))return send(json,res,400,'invalid_finance_report_category');
  if(unmappedOnlyRaw&&!['true','false'].includes(unmappedOnlyRaw))return send(json,res,400,'invalid_finance_report_unmapped_filter');
  if(unmappedOnly&&source&&source!=='pos')return send(json,res,400,'invalid_finance_report_unmapped_filter');
  if(unmappedOnly&&categoryId)return send(json,res,400,'invalid_finance_report_unmapped_filter');
  if(status&&!['paid','partially_paid','approved','draft','cancelled','posted','confirmed','complete','not_applicable','unmapped','legacy_unclassified','historic_category_snapshot_missing','unattributed','unreceived','partially_received','received','repaid','corrected','overreceived_vs_net'].includes(status))return send(json,res,400,'invalid_finance_report_status');
  let canReadPayroll=hasPermission('finance');let reportClient=null;let reportTransaction=false;
  try{
    if(resolveVenues){
      const selectedVenueId=String(url.searchParams.get('venueId')||venueId||'');
      const venues=await resolveVenues(req,selectedVenueId);
      const selected=venues.find((item)=>String(item.id)===selectedVenueId);
      if(!selected)return send(json,res,403,'forbidden');
      venueId=selected.id;
      canReadPayroll=selected.permissions.includes('finance');
    }
    if(!canReadPayroll&&(source==='payroll_accrual'||source==='payroll'))return send(json,res,403,'forbidden');
    reportClient=await pool.connect();
    await reportClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');reportTransaction=true;
    const venue=(await reportClient.query('SELECT id,name,timezone FROM venues WHERE id=$1',[venueId])).rows[0];
    if(!venue?.timezone)return send(json,res,404,'venue_not_found');
    const timezone=venue.timezone;
    const include=(name)=>!source||source===name||(['manual','purchase','payroll','other'].includes(source)&&name==='cash_out')||(['manual','other','manual_correction'].includes(source)&&name==='manualExpenseCorrections')||(source==='other_income'&&['other_income_recognition','other_income_receipt','other_income_adjustment','other_income_refund'].includes(name))||(source==='funding'&&name==='financing')||(source==='internal_transfer'&&name==='internalTransfers')||(source==='opening_balance'&&name==='openingBalances')||(source==='opening_adjustment'&&name==='openingBalanceAdjustments');
    const queries=[];
    const add=(key,read)=>queries.push([key,read]);
    if(include('pos')){
      add('pos',()=>reportClient.query(`SELECT s.order_id AS "orderId",s.venue_date::text AS "venueDate",s.closed_at AS "closedAt",s.recognized_total_minor::text AS "recognizedTotalMinor",s.unmapped_minor::text AS "unmappedMinor",s.status,
        COALESCE(SUM(a.amount_minor),0)::text AS "includedAmountMinor",COALESCE(json_agg(json_build_object('categoryId',a.category_id,'categoryName',a.category_name_snapshot,'amountMinor',a.amount_minor::text,'kind',a.allocation_kind,'orderItemId',a.order_item_id,'productName',a.source_product_name,'sourceKey',a.source_key,'sourceStation',a.source_station_snapshot) ORDER BY a.category_name_snapshot,a.id),'[]'::json) AS allocations
        FROM pos_order_income_category_snapshots s LEFT JOIN pos_order_income_category_allocations a ON a.venue_id=s.venue_id AND a.income_snapshot_id=s.id
        WHERE s.venue_id=$1 AND s.venue_date BETWEEN $2::date AND $3::date AND (($7::boolean AND a.category_id IS NULL AND a.id IS NOT NULL) OR (NOT $7::boolean AND ($4::uuid IS NULL OR a.category_id=$4::uuid)))
          AND ($5::text='' OR EXISTS(SELECT 1 FROM pos_order_income_category_allocations ax WHERE ax.venue_id=s.venue_id AND ax.income_snapshot_id=s.id AND (ax.source_product_name ILIKE '%'||$5||'%' OR ax.source_menu_category ILIKE '%'||$5||'%' OR ax.category_name_snapshot ILIKE '%'||$5||'%')))
          AND ($6::text='' OR s.status=$6)
        GROUP BY s.venue_id,s.id ORDER BY s.venue_date,s.closed_at,s.order_id LIMIT ${rowLimit}`,[venueId,from,to,categoryId||null,q,status,unmappedOnly]));
      add('legacyPos',()=>reportClient.query(`WITH ${orderPricingSqlCtes}
        SELECT o.id AS "orderId",(o.closed_at AT TIME ZONE $4)::date::text AS "venueDate",o.closed_at AS "closedAt",
          (CASE WHEN s.id IS NULL THEN COALESCE(o.final_total_snapshot,GREATEST(0,GREATEST(COALESCE(o.vip_minimum,0),COALESCE(i.subtotal,0)-COALESCE(d.discount,0)))) ELSE s.final_total_minor::numeric/100 END)::numeric(14,2)::text AS "amount",
          CASE WHEN s.id IS NULL THEN 'legacy_unclassified' ELSE 'historic_category_snapshot_missing' END AS status
        FROM orders o LEFT JOIN pos_order_pricing_snapshots s ON s.venue_id=o.venue_id AND s.order_id=o.id
        LEFT JOIN pos_order_income_category_snapshots income ON income.venue_id=o.venue_id AND income.order_id=o.id
        LEFT JOIN item_totals i ON i.order_id=o.id LEFT JOIN discount_totals d ON d.order_id=o.id
        WHERE o.venue_id=$1 AND o.status='closed' AND (s.id IS NULL OR income.id IS NULL) AND (o.closed_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
          AND $5::uuid IS NULL AND ($6::text='' OR o.id::text ILIKE '%'||$6||'%') AND ($7::text='' OR (CASE WHEN s.id IS NULL THEN 'legacy_unclassified' ELSE 'historic_category_snapshot_missing' END)=$7) ORDER BY o.closed_at,o.id LIMIT ${rowLimit}`,[venueId,from,to,timezone,categoryId||null,q,status]));
    }
    if(include('cash_out'))add('cashOutflows',()=>reportClient.query(`SELECT e.id,e.source,e.category_id AS "categoryId",e.category AS "categoryName",e.amount::text,e.expense_date::text AS "date",e.counterparty_name AS "counterpartyName",e.description,e.payment_method AS "paymentMethod",e.finance_account_id AS "paymentAccountId",e.finance_account_name_snapshot AS "paymentAccountNameSnapshot",e.shift_id AS "shiftId",CASE WHEN e.finance_account_id IS NULL THEN 'unknown_legacy' ELSE 'assigned' END AS "accountCoverage",e.purchase_document_id AS "purchaseDocumentId",pd.document_number AS "purchaseDocumentNumber",pd.supplier_name AS "supplierName",pe.id AS "payrollEntryId",pe.status AS "payrollStatus",pe.period_from::text AS "payrollPeriodFrom",pe.period_to::text AS "payrollPeriodTo",pp.id AS "payableId",pp.title AS "payableTitle"
      FROM expenses e LEFT JOIN inventory_purchase_documents pd ON pd.venue_id=e.venue_id AND pd.id=e.purchase_document_id
      LEFT JOIN LATERAL(SELECT x.id,x.status,x.period_from,x.period_to,COALESCE(u.full_name,u.login,'') AS employee_name FROM payroll_entries x LEFT JOIN users u ON u.venue_id=x.venue_id AND u.id=x.user_id WHERE x.venue_id=e.venue_id AND x.expense_id=e.id ORDER BY x.created_at DESC,x.id DESC LIMIT 1) pe ON true
      LEFT JOIN LATERAL(SELECT p.id,p.title FROM finance_payable_payment_links l JOIN finance_payables p ON p.venue_id=l.venue_id AND p.id=l.payable_id WHERE l.venue_id=e.venue_id AND l.expense_id=e.id LIMIT 1) pp ON true
      WHERE e.venue_id=$1 AND e.expense_date BETWEEN $2::date AND $3::date AND ($4::uuid IS NULL OR e.category_id=$4::uuid) AND ($5::text='' OR e.source=$5) AND ($6::boolean OR e.source<>'payroll')
        AND ($7::text='' OR CONCAT_WS(' ',e.counterparty_name,e.description,e.category,pd.supplier_name,pd.document_number,pe.employee_name,pp.title) ILIKE '%'||$7||'%')
        AND ($8::text='' OR (e.source='payroll' AND pe.status=$8) OR (e.source='purchase' AND pd.status=$8) OR (e.source IN ('manual','other') AND $8='paid'))
      ORDER BY e.expense_date,e.created_at,e.id LIMIT ${rowLimit}`,[venueId,from,to,categoryId||null,['manual','purchase','payroll','other'].includes(source)?source:'',canReadPayroll,q,status]));
    if(include('guest_advance')){
      const params=[venueId,from,to,timezone,status,q];
      add('guestAdvanceCashEvents',()=>reportClient.query(`${guestAdvanceCashSql} SELECT id AS "eventId",event_type AS "eventType",guest_id AS "guestId",reservation_id AS "reservationId",source_id AS "sourceId",counterparty_name AS "counterpartyNameCurrent",amount::text,signed_amount::text AS "signedCashFlowAmount",CASE WHEN signed_amount>0 THEN 'receipt' ELSE 'payout' END AS direction,method AS "paymentMethod",shift_id AS "shiftId",reason,actor_id AS "createdBy",created_at AS "recordedAt",(created_at AT TIME ZONE $4)::date::text AS "eventDate",NULL::uuid AS "financeAccountId",'not_recorded'::text AS "accountCoverage",'none'::text AS "pnlEffect" FROM selected_advances ORDER BY created_at,event_type,id LIMIT ${rowLimit}`,params));
      add('guestAdvanceCashCoverage',()=>reportClient.query(`${guestAdvanceCashSql} SELECT COUNT(*)::int AS "eventCount",COALESCE(SUM(amount),0)::text AS "unassignedGrossAmount",COALESCE(SUM(signed_amount),0)::text AS "netCashAmount" FROM selected_advances`,params));
    }
    if(include('financing'))add('financingEvents',()=>reportClient.query(`SELECT e.id AS "eventId",d.id AS "documentId",d.document_type AS "documentType",e.event_type AS "eventType",
        CASE WHEN e.event_type='loan_principal_repaid' THEN 'payout' ELSE 'receipt' END AS direction,e.amount::text,
        CASE WHEN e.event_type='loan_principal_repaid' THEN -e.amount ELSE e.amount END::numeric(14,2)::text AS "signedCashFlowAmount",e.event_date::text AS "eventDate",
        e.finance_account_id AS "financeAccountId",e.finance_account_name_snapshot AS "financeAccountNameSnapshot",e.payment_method AS "paymentMethod",e.shift_id AS "shiftId",
        d.counterparty_name AS "counterpartyName",d.document_reference AS "documentReference",d.basis,e.note,'none'::text AS "pnlEffect",true AS "externalCashFlow",e.created_by AS "createdBy",e.created_at AS "createdAt"
      FROM finance_funding_events e JOIN finance_funding_documents d ON d.venue_id=e.venue_id AND d.id=e.document_id
      WHERE e.venue_id=$1 AND e.event_date BETWEEN $2::date AND $3::date
        AND ($4::text='' OR e.event_type=$4 OR ($4='received' AND e.event_type IN ('owner_contribution_received','loan_principal_received')) OR ($4='repaid' AND e.event_type='loan_principal_repaid'))
        AND ($5::text='' OR CONCAT_WS(' ',d.counterparty_name,d.document_reference,d.basis,e.note,e.id::text,d.id::text) ILIKE '%'||$5||'%')
      ORDER BY e.event_date,e.created_at,e.id LIMIT ${rowLimit}`,[venueId,from,to,status,q]));
    if(include('internalTransfers'))add('internalTransfers',()=>reportClient.query(`SELECT l.id AS "legId",t.id AS "transferId",t.reversal_of_transfer_id AS "reversalOfTransferId",l.leg_type AS "legType",
        t.transfer_date::text AS "eventDate",l.finance_account_id AS "financeAccountId",l.finance_account_name_snapshot AS "financeAccountNameSnapshot",
        CASE WHEN l.leg_type='debit' THEN t.to_account_id ELSE t.from_account_id END AS "counterpartAccountId",
        CASE WHEN l.leg_type='debit' THEN t.to_account_name_snapshot ELSE t.from_account_name_snapshot END AS "counterpartAccountNameSnapshot",
        CASE WHEN l.leg_type='debit' THEN (-l.amount)::numeric(14,2)::text ELSE l.amount::numeric(14,2)::text END AS "signedAccountMovement",
        t.amount::text,t.from_account_name_snapshot AS "fromAccountNameSnapshot",t.to_account_name_snapshot AS "toAccountNameSnapshot",t.note,l.shift_id AS "shiftId",
        'none'::text AS "pnlEffect",false AS "externalCashFlow",0::numeric(14,2)::text AS "externalCashFlowAmount",t.created_by AS "createdBy",t.created_at AS "createdAt"
      FROM finance_account_transfers t JOIN finance_account_transfer_legs l ON l.venue_id=t.venue_id AND l.transfer_id=t.id
      WHERE t.venue_id=$1 AND t.transfer_date BETWEEN $2::date AND $3::date AND ($4::text='' OR $4='posted')
        AND ($5::text='' OR CONCAT_WS(' ',t.from_account_name_snapshot,t.to_account_name_snapshot,t.note,t.id::text,t.reversal_of_transfer_id::text) ILIKE '%'||$5||'%')
      ORDER BY t.transfer_date,t.created_at,t.id,l.leg_type LIMIT ${rowLimit}`,[venueId,from,to,status,q]));
    if(include('openingBalances'))add('openingBalances',()=>reportClient.query(`SELECT o.id AS "openingBalanceId",o.finance_account_id AS "financeAccountId",o.finance_account_name_snapshot AS "financeAccountNameSnapshot",
        o.amount::text AS "openingAmount",o.effective_date::text AS "effectiveDate",o.evidence_reference AS "evidenceReference",o.basis,o.currency,o.confirmed_by AS "confirmedBy",o.confirmed_at AS "confirmedAt",
        COALESCE((SELECT SUM(a.amount_delta) FROM finance_account_opening_adjustments a WHERE a.venue_id=o.venue_id AND a.opening_balance_id=o.id AND a.adjustment_date<=$2::date),0)::numeric(14,2)::text AS "adjustmentTotalThroughTo"
      FROM finance_account_opening_balances o WHERE o.venue_id=$1 AND o.effective_date<=$2::date
        AND ($3::text='' OR $3='confirmed') AND ($4::text='' OR CONCAT_WS(' ',o.finance_account_name_snapshot,o.evidence_reference,o.basis,o.id::text) ILIKE '%'||$4||'%')
      ORDER BY o.effective_date,o.confirmed_at,o.id LIMIT ${rowLimit}`,[venueId,to,status,q]));
    if(include('openingBalanceAdjustments'))add('openingBalanceAdjustments',()=>reportClient.query(`SELECT a.id AS "adjustmentId",a.opening_balance_id AS "openingBalanceId",a.finance_account_id AS "financeAccountId",o.finance_account_name_snapshot AS "financeAccountNameSnapshot",
        a.amount_delta::text AS "positionDelta",a.adjustment_date::text AS "eventDate",a.reason,a.evidence_reference AS "evidenceReference",a.created_by AS "createdBy",a.created_at AS "createdAt",
        'none'::text AS "pnlEffect",false AS "externalCashFlow"
      FROM finance_account_opening_adjustments a JOIN finance_account_opening_balances o ON o.venue_id=a.venue_id AND o.id=a.opening_balance_id
      WHERE a.venue_id=$1 AND a.adjustment_date BETWEEN $2::date AND $3::date AND ($4::text='' OR $4='posted')
        AND ($5::text='' OR CONCAT_WS(' ',o.finance_account_name_snapshot,a.reason,a.evidence_reference,a.id::text) ILIKE '%'||$5||'%')
      ORDER BY a.adjustment_date,a.created_at,a.id LIMIT ${rowLimit}`,[venueId,from,to,status,q]));
    if(include('expense_refund'))add('expenseRefunds',()=>reportClient.query(`SELECT r.id,r.expense_id AS "sourceExpenseId",e.expense_date::text AS "sourceExpenseDate",CASE WHEN r.payable_id IS NULL THEN e.source ELSE 'payable_payment' END AS "sourceExpenseKind",r.payable_id AS "payableId",r.amount::text,r.refund_date::text AS "refundDate",r.payment_method AS "paymentMethod",r.finance_account_id AS "paymentAccountId",r.finance_account_name_snapshot AS "paymentAccountNameSnapshot",r.shift_id AS "shiftId",r.document_reference AS "documentReference",r.reason,r.created_by AS "createdBy",r.created_at AS "createdAt",r.pnl_effect AS "pnlEffect"
      FROM finance_expense_refunds r JOIN expenses e ON e.venue_id=r.venue_id AND e.id=r.expense_id
      WHERE r.venue_id=$1 AND r.refund_date BETWEEN $2::date AND $3::date AND ($4::text='' OR $4='posted')
        AND ($6::uuid IS NULL OR r.payable_id IS NULL OR e.category_id=$6::uuid) AND ($5::text='' OR CONCAT_WS(' ',r.id::text,r.expense_id::text,e.counterparty_name,e.description,r.reason,r.document_reference) ILIKE '%'||$5||'%')
      ORDER BY r.refund_date,r.created_at,r.id LIMIT ${rowLimit}`,[venueId,from,to,status,q,categoryId||null]));
    if(include('manualExpenseCorrections'))add('manualExpenseCorrections',()=>reportClient.query(`WITH correction_lines AS (
        SELECT c.id AS correction_id,c.sequence,c.expense_id,e.expense_date,e.source,e.finance_account_id,e.finance_account_name_snapshot,e.shift_id,
          (c.before_snapshot->>'categoryId')::uuid AS category_id,c.before_snapshot->>'categoryName' AS category_name,
          CASE WHEN (c.before_snapshot->>'categoryId') IS DISTINCT FROM (c.after_snapshot->>'categoryId') THEN -((c.before_snapshot->>'amount')::numeric) ELSE c.amount_delta END AS signed_amount,
          c.before_snapshot,c.after_snapshot,c.reason,c.created_by,c.created_at,'before'::text AS leg
        FROM finance_expense_corrections c JOIN expenses e ON e.venue_id=c.venue_id AND e.id=c.expense_id
        WHERE c.venue_id=$1 AND e.expense_date BETWEEN $2::date AND $3::date AND e.source IN ('manual','other')
          AND (c.before_snapshot->>'categoryId') IS DISTINCT FROM (c.after_snapshot->>'categoryId')
        UNION ALL
        SELECT c.id,c.sequence,c.expense_id,e.expense_date,e.source,e.finance_account_id,e.finance_account_name_snapshot,e.shift_id,
          (c.after_snapshot->>'categoryId')::uuid,c.after_snapshot->>'categoryName',
          (c.after_snapshot->>'amount')::numeric,c.before_snapshot,c.after_snapshot,c.reason,c.created_by,c.created_at,'after'::text
        FROM finance_expense_corrections c JOIN expenses e ON e.venue_id=c.venue_id AND e.id=c.expense_id
        WHERE c.venue_id=$1 AND e.expense_date BETWEEN $2::date AND $3::date AND e.source IN ('manual','other')
          AND (c.before_snapshot->>'categoryId') IS DISTINCT FROM (c.after_snapshot->>'categoryId')
        UNION ALL
        SELECT c.id,c.sequence,c.expense_id,e.expense_date,e.source,e.finance_account_id,e.finance_account_name_snapshot,e.shift_id,
          (c.after_snapshot->>'categoryId')::uuid,c.after_snapshot->>'categoryName',c.amount_delta,c.before_snapshot,c.after_snapshot,c.reason,c.created_by,c.created_at,'amount'::text
        FROM finance_expense_corrections c JOIN expenses e ON e.venue_id=c.venue_id AND e.id=c.expense_id
        WHERE c.venue_id=$1 AND e.expense_date BETWEEN $2::date AND $3::date AND e.source IN ('manual','other')
          AND (c.before_snapshot->>'categoryId') IS NOT DISTINCT FROM (c.after_snapshot->>'categoryId') AND c.amount_delta<>0
      ) SELECT correction_id AS "correctionId",expense_id AS "expenseId",sequence,expense_date::text AS "originalDate",source,finance_account_id AS "paymentAccountId",
          finance_account_name_snapshot AS "paymentAccountNameSnapshot",shift_id AS "shiftId",category_id AS "categoryId",category_name AS "categoryName",
          signed_amount::numeric(14,2)::text AS "signedAmount",before_snapshot AS "before",after_snapshot AS "after",reason,created_by AS "createdBy",created_at AS "recordedAt",leg
        FROM correction_lines WHERE ($4::uuid IS NULL OR category_id=$4::uuid) AND ($5::text='' OR $5='corrected')
          AND ($6::text='' OR CONCAT_WS(' ',expense_id::text,correction_id::text,reason,before_snapshot->>'categoryName',after_snapshot->>'categoryName') ILIKE '%'||$6||'%')
        ORDER BY expense_date,correction_id,leg LIMIT ${rowLimit}`,[venueId,from,to,categoryId||null,status,q]));
    if(include('cash_out')||include('cash_in')||include('refund')||include('expense_refund')||source==='other_income'||source==='other_income_receipt'||source==='other_income_refund')add('cashAccountCoverage',()=>reportClient.query(`SELECT
      (SELECT COUNT(*) FROM expenses WHERE venue_id=$1 AND expense_date BETWEEN $2::date AND $3::date AND finance_account_id IS NULL AND ($5::boolean OR source<>'payroll'))::int AS "unassignedLegacyCount",
      (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE venue_id=$1 AND expense_date BETWEEN $2::date AND $3::date AND finance_account_id IS NULL AND ($5::boolean OR source<>'payroll'))::numeric(14,2)::text AS "unassignedLegacyAmount",
      (SELECT COUNT(*) FROM finance_other_income_receipts WHERE venue_id=$1 AND receipt_date BETWEEN $2::date AND $3::date AND finance_account_id IS NULL)::int AS "unassignedOtherIncomeReceiptCount",
      (SELECT COALESCE(SUM(amount),0) FROM finance_other_income_receipts WHERE venue_id=$1 AND receipt_date BETWEEN $2::date AND $3::date AND finance_account_id IS NULL)::numeric(14,2)::text AS "unassignedOtherIncomeReceiptAmount",
      (SELECT COUNT(*) FROM finance_other_income_refunds WHERE venue_id=$1 AND refund_date BETWEEN $2::date AND $3::date AND finance_account_id IS NULL)::int AS "unassignedOtherIncomeRefundCount",
      (SELECT COALESCE(SUM(amount),0) FROM finance_other_income_refunds WHERE venue_id=$1 AND refund_date BETWEEN $2::date AND $3::date AND finance_account_id IS NULL)::numeric(14,2)::text AS "unassignedOtherIncomeRefundAmount",
      (SELECT COUNT(*) FROM finance_expense_refunds WHERE venue_id=$1 AND refund_date BETWEEN $2::date AND $3::date AND finance_account_id IS NULL)::int AS "unassignedManualExpenseRefundCount",
      (SELECT COALESCE(SUM(amount),0) FROM finance_expense_refunds WHERE venue_id=$1 AND refund_date BETWEEN $2::date AND $3::date AND finance_account_id IS NULL)::numeric(14,2)::text AS "unassignedManualExpenseRefundAmount",
      (SELECT COUNT(*) FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=$1 AND p.method IN ('cash','card','qr') AND p.status IN ('paid','partially_paid') AND (p.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date AND p.finance_account_id IS NULL)::int AS "unassignedPosPaymentCount",
      (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=$1 AND p.method IN ('cash','card','qr') AND p.status IN ('paid','partially_paid') AND (p.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date AND p.finance_account_id IS NULL)::numeric(14,2)::text AS "unassignedPosPaymentAmount",
      (SELECT COUNT(*) FROM order_refund_tenders t WHERE t.venue_id=$1 AND t.payout_method IN ('cash','card','qr') AND (t.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date AND t.finance_account_id IS NULL)::int AS "unassignedPosRefundCount",
      (SELECT COALESCE(SUM(t.amount),0) FROM order_refund_tenders t WHERE t.venue_id=$1 AND t.payout_method IN ('cash','card','qr') AND (t.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date AND t.finance_account_id IS NULL)::numeric(14,2)::text AS "unassignedPosRefundAmount"`,[venueId,from,to,timezone,canReadPayroll]));
    if(include('cash_in'))add('cashInflows',()=>reportClient.query(`SELECT p.id AS "paymentId",p.order_id AS "orderId",p.method,p.status,p.amount::text,p.finance_account_id AS "paymentAccountId",p.finance_account_name_snapshot AS "paymentAccountNameSnapshot",p.shift_id AS "shiftId",CASE WHEN p.finance_account_id IS NULL THEN 'unknown_legacy' ELSE 'assigned' END AS "accountCoverage",p.created_at AS "paidAt",(p.created_at AT TIME ZONE $4)::date::text AS "venueDate",true AS "cashEquivalent"
      FROM payments p JOIN orders o ON o.id=p.order_id AND o.venue_id=$1
      WHERE p.method IN ('cash','card','qr') AND p.status IN ('paid','partially_paid') AND (p.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date AND ($5::text='' OR p.status::text=$5) AND ($6::text='' OR CONCAT_WS(' ',p.order_id::text,p.id::text,p.method) ILIKE '%'||$6||'%') AND $7::uuid IS NULL
      ORDER BY p.created_at,p.id LIMIT ${rowLimit}`,[venueId,from,to,timezone,status,q,categoryId||null]));
    if(include('other_income_recognition'))add('otherIncomeRecognition',()=>reportClient.query(`SELECT d.id AS "documentId",d.category_id AS "categoryId",d.category_name_snapshot AS "categoryName",d.title,d.counterparty_name AS "counterpartyName",d.basis,d.document_reference AS "documentReference",d.recognition_date::text AS "recognitionDate",d.total_amount::text AS "recognizedAmount",COALESCE(c.amount,0)::text AS "correctionAmount",(d.total_amount-COALESCE(c.amount,0))::text AS "netRecognizedAmount",COALESCE(SUM(r.amount),0)::text AS "receivedAmount",COALESCE(f.amount,0)::text AS "refundedAmount",(COALESCE(SUM(r.amount),0)-COALESCE(f.amount,0))::text AS "netReceivedAmount",GREATEST(d.total_amount-COALESCE(c.amount,0)-(COALESCE(SUM(r.amount),0)-COALESCE(f.amount,0)),0)::text AS "unreceivedRecognition",GREATEST((COALESCE(SUM(r.amount),0)-COALESCE(f.amount,0))-(d.total_amount-COALESCE(c.amount,0)),0)::text AS "cashReceivedBeyondNetRecognition",d.status,d.posted_at AS "postedAt"
      FROM finance_other_income_documents d LEFT JOIN finance_other_income_receipts r ON r.venue_id=d.venue_id AND r.document_id=d.id LEFT JOIN LATERAL(SELECT SUM(x.amount)::numeric(14,2) AS amount FROM finance_other_income_corrections x WHERE x.venue_id=d.venue_id AND x.document_id=d.id) c ON true LEFT JOIN LATERAL(SELECT SUM(x.amount)::numeric(14,2) AS amount FROM finance_other_income_refunds x WHERE x.venue_id=d.venue_id AND x.document_id=d.id) f ON true
      WHERE d.venue_id=$1 AND d.status='posted' AND d.recognition_date BETWEEN $2::date AND $3::date AND ($4::uuid IS NULL OR d.category_id=$4::uuid) AND ($5::text='' OR $5='posted' OR ($5='unreceived' AND (COALESCE((SELECT SUM(rx.amount) FROM finance_other_income_receipts rx WHERE rx.venue_id=d.venue_id AND rx.document_id=d.id),0)-COALESCE((SELECT SUM(fx.amount) FROM finance_other_income_refunds fx WHERE fx.venue_id=d.venue_id AND fx.document_id=d.id),0))=0 AND d.total_amount-COALESCE(c.amount,0)>0) OR ($5='partially_received' AND (COALESCE((SELECT SUM(rx.amount) FROM finance_other_income_receipts rx WHERE rx.venue_id=d.venue_id AND rx.document_id=d.id),0)-COALESCE((SELECT SUM(fx.amount) FROM finance_other_income_refunds fx WHERE fx.venue_id=d.venue_id AND fx.document_id=d.id),0))>0 AND (COALESCE((SELECT SUM(rx.amount) FROM finance_other_income_receipts rx WHERE rx.venue_id=d.venue_id AND rx.document_id=d.id),0)-COALESCE((SELECT SUM(fx.amount) FROM finance_other_income_refunds fx WHERE fx.venue_id=d.venue_id AND fx.document_id=d.id),0))<(d.total_amount-COALESCE(c.amount,0))) OR ($5='received' AND (COALESCE((SELECT SUM(rx.amount) FROM finance_other_income_receipts rx WHERE rx.venue_id=d.venue_id AND rx.document_id=d.id),0)-COALESCE((SELECT SUM(fx.amount) FROM finance_other_income_refunds fx WHERE fx.venue_id=d.venue_id AND fx.document_id=d.id),0))>=(d.total_amount-COALESCE(c.amount,0)) AND d.total_amount-COALESCE(c.amount,0)>0) OR ($5='corrected' AND COALESCE(c.amount,0)>0) OR ($5='overreceived_vs_net' AND (COALESCE((SELECT SUM(rx.amount) FROM finance_other_income_receipts rx WHERE rx.venue_id=d.venue_id AND rx.document_id=d.id),0)-COALESCE((SELECT SUM(fx.amount) FROM finance_other_income_refunds fx WHERE fx.venue_id=d.venue_id AND fx.document_id=d.id),0))>d.total_amount-COALESCE(c.amount,0))) AND ($6::text='' OR CONCAT_WS(' ',d.title,d.counterparty_name,d.basis,d.document_reference,d.category_name_snapshot,d.id::text) ILIKE '%'||$6||'%')
      GROUP BY d.venue_id,d.id,c.amount,f.amount ORDER BY d.recognition_date,d.posted_at,d.id LIMIT ${rowLimit}`,[venueId,from,to,categoryId||null,status,q]));
    if(include('other_income_receipt'))add('otherIncomeReceipts',()=>reportClient.query(`SELECT r.id AS "receiptId",r.document_id AS "documentId",d.category_id AS "categoryId",d.category_name_snapshot AS "categoryName",d.title,d.counterparty_name AS "counterpartyName",r.amount::text,COALESCE(rf.amount,0)::text AS "refundedAmount",(r.amount-COALESCE(rf.amount,0))::text AS "netAmount",r.receipt_date::text AS "receiptDate",r.payment_method AS "paymentMethod",r.finance_account_id AS "paymentAccountId",r.finance_account_name_snapshot AS "paymentAccountNameSnapshot",r.shift_id AS "shiftId",CASE WHEN r.finance_account_id IS NULL THEN 'unknown_legacy' ELSE 'assigned' END AS "accountCoverage",(r.payment_method IN ('cash','card','qr','bank_transfer')) AS "cashEquivalent",r.note,r.created_at AS "recordedAt"
      FROM finance_other_income_receipts r JOIN finance_other_income_documents d ON d.venue_id=r.venue_id AND d.id=r.document_id LEFT JOIN LATERAL(SELECT SUM(x.amount)::numeric(14,2) AS amount FROM finance_other_income_refunds x WHERE x.venue_id=r.venue_id AND x.receipt_id=r.id) rf ON true
      LEFT JOIN LATERAL(SELECT COALESCE(SUM(x.amount),0)::numeric(14,2) AS amount FROM finance_other_income_receipts x WHERE x.venue_id=d.venue_id AND x.document_id=d.id) dr ON true LEFT JOIN LATERAL(SELECT COALESCE(SUM(x.amount),0)::numeric(14,2) AS amount FROM finance_other_income_refunds x WHERE x.venue_id=d.venue_id AND x.document_id=d.id) df ON true LEFT JOIN LATERAL(SELECT COALESCE(SUM(x.amount),0)::numeric(14,2) AS amount FROM finance_other_income_corrections x WHERE x.venue_id=d.venue_id AND x.document_id=d.id) dc ON true
      WHERE r.venue_id=$1 AND d.status='posted' AND r.receipt_date BETWEEN $2::date AND $3::date AND ($4::uuid IS NULL OR d.category_id=$4::uuid) AND ($5::text='' OR $5='posted' OR ($5='unreceived' AND dr.amount-df.amount=0 AND d.total_amount-dc.amount>0) OR ($5='partially_received' AND dr.amount-df.amount>0 AND dr.amount-df.amount<d.total_amount-dc.amount) OR ($5='received' AND dr.amount-df.amount>=d.total_amount-dc.amount AND d.total_amount-dc.amount>0)) AND ($6::text='' OR CONCAT_WS(' ',d.title,d.counterparty_name,d.basis,d.document_reference,d.category_name_snapshot,d.id::text,r.id::text,r.payment_method,r.note) ILIKE '%'||$6||'%')
      ORDER BY r.receipt_date,r.created_at,r.id LIMIT ${rowLimit}`,[venueId,from,to,categoryId||null,status,q]));
    if(include('other_income_adjustment'))add('otherIncomeAdjustments',()=>reportClient.query(`SELECT c.id AS "correctionId",c.document_id AS "documentId",d.category_id AS "categoryId",d.category_name_snapshot AS "categoryName",d.title,c.amount::text AS "amount",(-c.amount)::text AS "signedAmount",c.correction_date::text AS "correctionDate",c.reason,c.document_reference AS "documentReference",c.created_by AS "createdBy",c.created_at AS "recordedAt"
      FROM finance_other_income_corrections c JOIN finance_other_income_documents d ON d.venue_id=c.venue_id AND d.id=c.document_id
      WHERE c.venue_id=$1 AND c.correction_date BETWEEN $2::date AND $3::date AND ($4::uuid IS NULL OR d.category_id=$4::uuid) AND ($5::text='' OR $5 IN ('posted','corrected')) AND ($6::text='' OR CONCAT_WS(' ',d.title,c.reason,c.document_reference,c.id::text) ILIKE '%'||$6||'%') ORDER BY c.correction_date,c.created_at,c.id LIMIT ${rowLimit}`,[venueId,from,to,categoryId||null,status,q]));
    if(include('other_income_refund'))add('otherIncomeRefunds',()=>reportClient.query(`SELECT x.id AS "refundId",x.document_id AS "documentId",x.receipt_id AS "receiptId",d.category_id AS "categoryId",d.category_name_snapshot AS "categoryName",d.title,x.amount::text,(-x.amount)::text AS "signedAmount",x.refund_date::text AS "refundDate",x.payout_method AS "payoutMethod",x.finance_account_id AS "paymentAccountId",x.finance_account_name_snapshot AS "paymentAccountNameSnapshot",x.shift_id AS "shiftId",CASE WHEN x.finance_account_id IS NULL THEN 'unknown_legacy' ELSE 'assigned' END AS "accountCoverage",x.reason,x.created_by AS "createdBy",x.created_at AS "recordedAt"
      FROM finance_other_income_refunds x JOIN finance_other_income_documents d ON d.venue_id=x.venue_id AND d.id=x.document_id
      WHERE x.venue_id=$1 AND x.refund_date BETWEEN $2::date AND $3::date AND ($4::uuid IS NULL OR d.category_id=$4::uuid) AND ($5::text='' OR $5='posted') AND ($6::text='' OR CONCAT_WS(' ',d.title,x.reason,x.payout_method,x.id::text) ILIKE '%'||$6||'%') ORDER BY x.refund_date,x.created_at,x.id LIMIT ${rowLimit}`,[venueId,from,to,categoryId||null,status,q]));
    if(include('refund'))add('refundTenders',()=>reportClient.query(`SELECT t.id AS "tenderId",t.refund_id AS "refundId",t.order_id AS "orderId",t.payout_method AS "paymentMethod",t.amount::text,t.finance_account_id AS "paymentAccountId",t.finance_account_name_snapshot AS "paymentAccountNameSnapshot",t.shift_id AS "shiftId",CASE WHEN t.finance_account_id IS NULL THEN 'unknown_legacy' ELSE 'assigned' END AS "accountCoverage",t.created_at AS "paidAt",(t.created_at AT TIME ZONE $4)::date::text AS "venueDate",r.reason,r.item_attribution_status AS "itemAttributionStatus"
      FROM order_refund_tenders t JOIN order_refunds r ON r.venue_id=t.venue_id AND r.id=t.refund_id AND r.order_id=t.order_id
      WHERE t.venue_id=$1 AND (t.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date AND ($5::text='' OR r.item_attribution_status=$5) AND ($6::text='' OR CONCAT_WS(' ',t.order_id::text,t.refund_id::text,r.reason) ILIKE '%'||$6||'%') AND $7::uuid IS NULL
      ORDER BY t.created_at,t.id LIMIT ${rowLimit}`,[venueId,from,to,timezone,status,q,categoryId||null]));
    if(!source||source==='refund')add('posRefundItems',()=>reportClient.query(`SELECT r.id AS "refundId",r.order_id AS "orderId",CASE WHEN $7::uuid IS NULL THEN r.amount::text ELSE NULL END AS "payoutAmount",r.created_at AS "paidAt",(r.created_at AT TIME ZONE $4)::date::text AS "venueDate",r.reason,r.item_attribution_status AS "itemAttributionStatus",
        CASE WHEN r.item_attribution_status='unattributed' THEN NULL ELSE COALESCE((SELECT SUM(ri.returned_item_value_minor) FROM order_refund_items ri
          LEFT JOIN pos_order_income_category_snapshots income ON income.venue_id=ri.venue_id AND income.order_id=ri.order_id
          LEFT JOIN pos_order_income_category_allocations a ON a.venue_id=ri.venue_id AND a.income_snapshot_id=income.id AND a.order_item_id=ri.order_item_id AND a.allocation_kind='item'
          WHERE ri.venue_id=r.venue_id AND ri.refund_id=r.id AND ($7::uuid IS NULL OR a.category_id=$7::uuid)),0)::text END AS "returnedItemValueMinor",
        COALESCE((SELECT json_agg(json_build_object('orderItemId',ri.order_item_id,'productName',sl.product_facts->>'productName','quantity',ri.returned_quantity::text,'itemValueMinor',ri.returned_item_value_minor::text,'categoryId',a.category_id,'categoryName',COALESCE(a.category_name_snapshot,'Не распределено'),'producerSequence',ri.producer_sequence,'previousReturnedQuantity',ri.previous_returned_quantity::text,'cumulativeReturnedQuantity',ri.cumulative_returned_quantity::text,'previousReturnedItemValueMinor',ri.previous_returned_item_value_minor::text,'cumulativeReturnedItemValueMinor',ri.cumulative_returned_item_value_minor::text,'sequenceScope',CASE WHEN ri.producer_sequence IS NULL THEN 'legacy_unsequenced' ELSE 'per_source_post_092' END) ORDER BY ri.order_item_id)
          FROM order_refund_items ri JOIN pos_order_pricing_snapshot_lines sl ON sl.venue_id=ri.venue_id AND sl.snapshot_id=ri.snapshot_id AND sl.order_id=ri.order_id AND sl.order_item_id=ri.order_item_id
          LEFT JOIN pos_order_income_category_snapshots income ON income.venue_id=ri.venue_id AND income.order_id=ri.order_id
          LEFT JOIN pos_order_income_category_allocations a ON a.venue_id=ri.venue_id AND a.income_snapshot_id=income.id AND a.order_item_id=ri.order_item_id AND a.allocation_kind='item'
          WHERE ri.venue_id=r.venue_id AND ri.refund_id=r.id AND ($7::uuid IS NULL OR a.category_id=$7::uuid)),'[]'::json) AS "itemReturns"
      FROM order_refunds r
      WHERE r.venue_id=$1 AND (r.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date AND ($5::text='' OR r.item_attribution_status=$5) AND ($6::text='' OR CONCAT_WS(' ',r.order_id::text,r.id::text,r.reason) ILIKE '%'||$6||'%') AND ($7::uuid IS NULL OR (r.item_attribution_status='complete' AND EXISTS (
        SELECT 1 FROM order_refund_items ri JOIN pos_order_income_category_snapshots income ON income.venue_id=ri.venue_id AND income.order_id=ri.order_id
        JOIN pos_order_income_category_allocations a ON a.venue_id=ri.venue_id AND a.income_snapshot_id=income.id AND a.order_item_id=ri.order_item_id AND a.allocation_kind='item'
        WHERE ri.venue_id=r.venue_id AND ri.refund_id=r.id AND a.category_id=$7::uuid)))
      ORDER BY r.created_at,r.id LIMIT ${rowLimit}`,[venueId,from,to,timezone,status,q,categoryId||null]));
    if(canReadPayroll&&include('payroll_accrual'))add('payrollAccruals',()=>reportClient.query(`SELECT pe.id AS "payrollEntryId",pe.user_id AS "employeeId",COALESCE(u.full_name,u.login,'Сотрудник') AS "employeeName",pe.period_from::text AS "periodFrom",pe.period_to::text AS "periodTo",pe.status,pe.amount::text AS "periodAmount",
        round(pe.amount*((LEAST(pe.period_to,$3::date)-GREATEST(pe.period_from,$2::date)+1)::numeric/(pe.period_to-pe.period_from+1)),2)::text AS "recognizedInRange",GREATEST(pe.period_from,$2::date)::text AS "overlapFrom",LEAST(pe.period_to,$3::date)::text AS "overlapTo",pe.expense_id AS "expenseId",pe.finance_category_id AS "categoryId",pe.finance_category_name_snapshot AS "categoryName"
      FROM payroll_entries pe JOIN users u ON u.venue_id=pe.venue_id AND u.id=pe.user_id
      WHERE pe.venue_id=$1 AND pe.status IN ('approved','paid') AND pe.period_to >= $2::date AND pe.period_from <= $3::date AND ($4::uuid IS NULL OR pe.finance_category_id=$4::uuid) AND ($5::text='' OR pe.status=$5) AND ($6::text='' OR CONCAT_WS(' ',pe.id::text,u.full_name,u.login) ILIKE '%'||$6||'%')
      ORDER BY pe.period_from,pe.id LIMIT ${rowLimit}`,[venueId,from,to,categoryId||null,status,q]));
    if(include('payable_offset'))add('payableOffsets',()=>reportClient.query(`SELECT o.id,o.expense_id AS "expenseId",o.source_payable_id AS "sourcePayableId",o.destination_payable_id AS "destinationPayableId",s.title AS "sourceTitle",d.title AS "destinationTitle",s.counterparty_name AS "sourceCounterpartyName",d.counterparty_name AS "destinationCounterpartyName",o.amount::text,o.offset_date::text AS "offsetDate",o.reversal_of_id AS "reversalOfId",o.reason,o.document_reference AS "documentReference",o.created_by AS "createdBy",o.created_at AS "recordedAt",'none'::text AS "cashEffect",'none'::text AS "recognitionEffect"
      FROM finance_payable_offsets o JOIN finance_payables s ON s.venue_id=o.venue_id AND s.id=o.source_payable_id JOIN finance_payables d ON d.venue_id=o.venue_id AND d.id=o.destination_payable_id
      WHERE o.venue_id=$1 AND o.offset_date BETWEEN $2::date AND $3::date AND ($4::text='' OR $4='posted') AND ($5::uuid IS NULL OR s.category_id=$5 OR d.category_id=$5)
      AND ($6::text='' OR CONCAT_WS(' ',o.id::text,o.expense_id::text,s.title,d.title,s.counterparty_name,d.counterparty_name,o.reason,o.document_reference) ILIKE '%'||$6||'%')
      ORDER BY o.offset_date,o.created_at,o.id LIMIT ${rowLimit}`,[venueId,from,to,status,categoryId||null,q]));
    if(include('obligation'))add('obligations',()=>reportClient.query(`SELECT p.id,finance_payable_settled_amount(p.venue_id,p.id)::text AS "settledAmount",(SELECT COALESCE(SUM(amount),0)::text FROM finance_payable_offsets WHERE venue_id=p.venue_id AND destination_payable_id=p.id) AS "creditedInAmount",(SELECT COALESCE(SUM(amount),0)::text FROM finance_payable_offsets WHERE venue_id=p.venue_id AND source_payable_id=p.id) AS "creditedOutAmount",p.category_id AS "categoryId",p.category_name_snapshot AS "categoryName",p.title,p.counterparty_name AS "counterpartyName",p.basis,p.period_from::text AS "periodFrom",p.period_to::text AS "periodTo",p.due_date::text AS "dueDate",p.status,p.total_amount::text AS "totalAmount",COALESCE(SUM(l.applied_amount),0)::text AS "paidAmount",(SELECT COALESCE(SUM(amount),0) FROM finance_expense_refunds WHERE venue_id=p.venue_id AND payable_id=p.id)::text AS "refundedAmount",(COALESCE(SUM(l.applied_amount),0)-(SELECT COALESCE(SUM(amount),0) FROM finance_expense_refunds WHERE venue_id=p.venue_id AND payable_id=p.id))::text AS "netPaidAmount",(CASE WHEN p.status='cancelled' THEN 0 ELSE p.total_amount-finance_payable_settled_amount(p.venue_id,p.id) END)::text AS "balanceDue"
      FROM finance_payables p LEFT JOIN finance_payable_payment_links l ON l.venue_id=p.venue_id AND l.payable_id=p.id
      WHERE p.venue_id=$1 AND p.due_date BETWEEN $2::date AND $3::date AND ($4::uuid IS NULL OR p.category_id=$4::uuid) AND ($5::text='' OR p.status=$5) AND ($6::text='' OR CONCAT_WS(' ',p.title,p.counterparty_name,p.basis) ILIKE '%'||$6||'%')
      GROUP BY p.venue_id,p.id ORDER BY p.due_date,p.id LIMIT ${rowLimit}`,[venueId,from,to,categoryId||null,status,q]));
    if(include('obligation_recognition'))add('obligationRecognitions',()=>reportClient.query(`SELECT r.id AS "recognitionId",r.payable_id AS "payableId",r.category_id AS "categoryId",r.category_name_snapshot AS "categoryName",r.title_snapshot AS title,r.counterparty_name_snapshot AS "counterpartyName",r.basis_snapshot AS basis,r.service_period_from::text AS "servicePeriodFrom",r.service_period_to::text AS "servicePeriodTo",r.amount::text,r.amount::text AS "signedAmount",r.recognition_date::text AS "recognitionDate",r.document_reference AS "documentReference",r.created_by AS "createdBy",r.created_at AS "recordedAt"
      FROM finance_payable_recognitions r WHERE r.venue_id=$1 AND r.recognition_date BETWEEN $2::date AND $3::date AND ($4::uuid IS NULL OR r.category_id=$4::uuid) AND ($5::text='' OR $5='approved') AND ($6::text='' OR CONCAT_WS(' ',r.title_snapshot,r.counterparty_name_snapshot,r.basis_snapshot,r.document_reference,r.payable_id::text) ILIKE '%'||$6||'%') ORDER BY r.recognition_date,r.created_at,r.id LIMIT ${rowLimit}`,[venueId,from,to,categoryId||null,status,q]));
    if(include('obligation_adjustment'))add('obligationRecognitionAdjustments',()=>reportClient.query(`SELECT x.id AS "adjustmentId",x.recognition_id AS "recognitionId",r.payable_id AS "payableId",r.category_id AS "categoryId",r.category_name_snapshot AS "categoryName",r.title_snapshot AS title,r.counterparty_name_snapshot AS "counterpartyName",x.amount::text,(-x.amount)::text AS "signedAmount",x.reversal_date::text AS "reversalDate",x.reason,x.document_reference AS "documentReference",x.created_by AS "createdBy",x.created_at AS "recordedAt"
      FROM finance_payable_recognition_reversals x JOIN finance_payable_recognitions r ON r.venue_id=x.venue_id AND r.id=x.recognition_id
      WHERE x.venue_id=$1 AND x.reversal_date BETWEEN $2::date AND $3::date AND ($4::uuid IS NULL OR r.category_id=$4::uuid) AND ($5::text='' OR $5='approved') AND ($6::text='' OR CONCAT_WS(' ',r.title_snapshot,r.counterparty_name_snapshot,x.reason,x.document_reference,r.payable_id::text) ILIKE '%'||$6||'%') ORDER BY x.reversal_date,x.created_at,x.id LIMIT ${rowLimit}`,[venueId,from,to,categoryId||null,status,q]));
    if(include('purchase_receipt'))add('purchaseReceipts',()=>reportClient.query(`SELECT d.id AS "documentId",d.supplier_name AS "supplierName",d.document_number AS "documentNumber",d.document_date::text AS "documentDate",d.posted_at AS "postedAt",(d.posted_at AT TIME ZONE $4)::date::text AS "venueDate",d.status,COALESCE(SUM(l.line_total),0)::text AS "acquisitionAmount",COUNT(l.id)::int AS "lineCount",COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.venue_id=d.venue_id AND e.purchase_document_id=d.id AND e.source='purchase'),0)::text AS "cashPaid",d.finance_category_id AS "categoryId",d.finance_category_name_snapshot AS "categoryName"
      FROM inventory_purchase_documents d LEFT JOIN inventory_purchase_document_lines l ON l.document_id=d.id AND l.venue_id=d.venue_id
      WHERE d.venue_id=$1 AND d.status='posted' AND (d.posted_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date AND ($5::uuid IS NULL OR d.finance_category_id=$5::uuid) AND ($6::text='' OR CONCAT_WS(' ',d.supplier_name,d.document_number,d.id::text) ILIKE '%'||$6||'%') AND ($7::text='' OR $7='posted')
      GROUP BY d.venue_id,d.id ORDER BY d.posted_at,d.id LIMIT ${rowLimit}`,[venueId,from,to,timezone,categoryId||null,q,status]));
    const result={from,to,venue:{id:venue.id,name:venue.name,timeZone:timezone},payrollIncluded:canReadPayroll,dateBasis:{guestAdvanceCash:'venue_local_created_at_of_existing_receipt_or_external_reversal',posRecognition:'venue_local_close_date',cash:'venue_local_event_date',manualExpenseRefund:'actual_refund_date',payrollAccrual:'payroll_period_prorated_by_calendar_days',obligations:'due_date',obligationRecognition:'explicit_recognition_date',obligationRecognitionAdjustment:'reversal_date',purchaseReceipt:'venue_local_posted_at',otherIncomeRecognition:'explicit_recognition_date',otherIncomeCash:'receipt_date; refunds use actual refund_date',otherIncomeCorrection:'correction_date',manualExpenseCorrection:'original_expense_date',financing:'actual_event_date',internalTransfer:'transfer_date',openingBalance:'opening_position_at_start_of_venue_local_date',openingBalanceAdjustment:'explicit_adjustment_date'},dimensions:{cashInflows:'POS payment tenders remain attached to orders; other-income receipts are gross inflows, refunds are separate cash events, and manual-expense refunds are positive cash receipts that are not business income or P&L recognition',cashOutflows:'expenses cash facts; purchase payments, payroll payments, and payable payments are not duplicated as P&L',pos:'closed-check recognized revenue; refund tenders are separate cash outflows; returned item values are informational detail and POS refund P&L recognition remains unconnected',payroll:'approved/paid payroll accrual separate from expense payment',purchase:'posted receipt value is procurement/acquisition, not a second cash expense or asserted P&L charge',obligations:'plan/status/balance; payment facts are already listed under cash outflows',obligationRecognition:'explicit gross recognition and signed reversal are separate P&L events; linked payment expenses remain cash-only',otherIncome:'original recognition and signed corrections are separate recognition events; receipts and refunds are separate cash events. Corrections affect recognition, refunds affect cash only; derive net values without rewriting source facts',manualExpenseCorrection:'signed accounting reclassification of manual expense on original date/account; does not create a second cash event or alter a closed shift snapshot',manualExpenseRefund:'positive receipt against one exact expense; payableId identifies contractual-payment returns, whose recognition and reversals remain separate. Unlinked manual/other refund P&L effect is not calculated',financing:'owner contribution and loan principal receipt/repayment; external cash movement only; never P&L',internalTransfer:'two equal opposite account legs; zero external cash movement; excluded from business income, expense, and P&L',openingBalance:'confirmed starting position only; not a receipt, current balance, income, expense, or P&L',openingBalanceAdjustment:'signed correction of starting position; not cash movement or P&L'},coverage:{categoryIdFilterAppliedTo:'category-bearing sources only; POS lines, expenses, obligations, payroll accrual, purchase receipt and other-income documents/adjustments/receipts/refunds; legacy sources without an explicit category ID remain unclassified. Manual-expense refunds are not category-filtered.',payrollAccruals:canReadPayroll?'available':'finance_permission_required',payableRecognition:{status:'available',basis:'approved service-period overlap; not automatically backfilled'},posIncomeClassification:{status:'available',basis:'unclassified order-level and allocation-level amounts remain explicit'},manualExpenseRefunds:{status:'available',count:0,amount:'0.00',pnlEffect:'not_calculated',basis:'cash receipt only; P&L recognition policy is unresolved'},cashAccounts:{status:'incomplete',unassignedLegacyCount:null,unassignedLegacyAmount:null,basis:'expense events with no explicit account; no method/category/source backfill'},accountBalances:{status:'incomplete',basis:'source coverage across existing payment, expense, refund, payroll, purchase and legacy journals is not yet reconciled; do not infer a complete current balance from these events'},refundRecognition:'not_connected',posRefundItemDetail:'informational_only; not_revenue_reversal',otherIncomeRefunds:'connected_as_cash_events; POS cashbox and shift reconciliation connected',legacyPOS:'unclassified_without_pricing_or_income_category_snapshot',limitPerSection:500,possiblyTruncatedSections:[]},items:{}};
    for(const [key,read] of queries){const value=await read();result.items[key]=value.rows;if(value.rows.length===rowLimit)result.coverage.possiblyTruncatedSections.push(key);}
    if(!source||source==='expense_refund'){const {rows}=await reportClient.query(`SELECT COUNT(*)::int AS count,COALESCE(SUM(r.amount),0)::numeric(14,2)::text AS amount FROM finance_expense_refunds r JOIN expenses e ON e.venue_id=r.venue_id AND e.id=r.expense_id WHERE r.venue_id=$1 AND r.pnl_effect='not_calculated' AND r.refund_date BETWEEN $2::date AND $3::date AND ($4::text='' OR $4='posted') AND ($5::text='' OR CONCAT_WS(' ',r.id::text,r.expense_id::text,e.counterparty_name,e.description,r.reason,r.document_reference) ILIKE '%'||$5||'%')`,[venueId,from,to,status,q]);const count=Number(rows[0]?.count||0);result.coverage.manualExpenseRefunds={status:count?'incomplete':'complete',count,amount:rows[0]?.amount||'0.00',pnlEffect:'not_calculated',dateBasis:'actual_refund_date',categoryFilterApplied:false,basis:'cash receipt only; no business income, expense, supplier, payable, payroll or inventory effect'};}
    if(result.items.cashAccountCoverage?.[0]){const coverage=result.items.cashAccountCoverage[0];const unassignedLegacyCount=Number(coverage.unassignedLegacyCount||0)+Number(coverage.unassignedOtherIncomeReceiptCount||0)+Number(coverage.unassignedOtherIncomeRefundCount||0)+Number(coverage.unassignedManualExpenseRefundCount||0)+Number(coverage.unassignedPosPaymentCount||0)+Number(coverage.unassignedPosRefundCount||0);const unassignedLegacyAmount=(Number(coverage.unassignedLegacyAmount||0)+Number(coverage.unassignedOtherIncomeReceiptAmount||0)+Number(coverage.unassignedOtherIncomeRefundAmount||0)+Number(coverage.unassignedManualExpenseRefundAmount||0)+Number(coverage.unassignedPosPaymentAmount||0)+Number(coverage.unassignedPosRefundAmount||0)).toFixed(2);result.coverage.cashAccounts={status:'incomplete',unassignedLegacyCount,unassignedLegacyAmount,unassignedExpenses:{count:Number(coverage.unassignedLegacyCount||0),amount:coverage.unassignedLegacyAmount},unassignedOtherIncomeReceipts:{count:Number(coverage.unassignedOtherIncomeReceiptCount||0),amount:coverage.unassignedOtherIncomeReceiptAmount},unassignedOtherIncomeRefunds:{count:Number(coverage.unassignedOtherIncomeRefundCount||0),amount:coverage.unassignedOtherIncomeRefundAmount},unassignedManualExpenseRefunds:{count:Number(coverage.unassignedManualExpenseRefundCount||0),amount:coverage.unassignedManualExpenseRefundAmount},unassignedPosPayments:{count:Number(coverage.unassignedPosPaymentCount||0),amount:coverage.unassignedPosPaymentAmount},unassignedPosRefunds:{count:Number(coverage.unassignedPosRefundCount||0),amount:coverage.unassignedPosRefundAmount},basis:'legacy expense, POS tender, and other-income cash events without explicit account in the selected event-date range; payroll and purchase payment writers remain not fully connected; never inferred from method, category or source'};}
    if(result.items.guestAdvanceCashCoverage?.[0]){
      const advance=result.items.guestAdvanceCashCoverage[0], count=Number(advance.eventCount||0);
      result.coverage.guestAdvances={status:'available',eventCount:count,netCashAmount:advance.netCashAmount,accountAttribution:count?'not_recorded':'no_events',categoryFilterApplied:false,basis:'existing receipt and external reversal ledgers only; wallet/bonus/prepayment application is not a second cash event; legacy balance fields are not receipts'};
      if(count)result.coverage.cashAccounts={...result.coverage.cashAccounts,status:'incomplete',unassignedGuestAdvanceCount:count,unassignedGuestAdvanceGrossAmount:advance.unassignedGrossAmount,basis:'includes guest/reservation cash ledgers without explicit account IDs; never infer an account from method or shift'};
    }
    delete result.items.guestAdvanceCashCoverage;

    if(!source||source==='pos'){
      const {rows}=await reportClient.query(`WITH ${orderPricingSqlCtes}
        SELECT COUNT(DISTINCT o.id)::int AS count,COALESCE(SUM(CASE WHEN income.id IS NOT NULL THEN income.unmapped_minor::numeric/100
          WHEN pricing.id IS NULL THEN COALESCE(o.final_total_snapshot,GREATEST(0,GREATEST(COALESCE(o.vip_minimum,0),COALESCE(i.subtotal,0)-COALESCE(d.discount,0))))
          ELSE pricing.final_total_minor::numeric/100 END),0)::numeric(14,2)::text AS amount
        FROM orders o JOIN venues v ON v.id=o.venue_id
        LEFT JOIN pos_order_pricing_snapshots pricing ON pricing.venue_id=o.venue_id AND pricing.order_id=o.id
        LEFT JOIN pos_order_income_category_snapshots income ON income.venue_id=o.venue_id AND income.order_id=o.id
        LEFT JOIN item_totals i ON i.order_id=o.id LEFT JOIN discount_totals d ON d.order_id=o.id
        WHERE o.venue_id=$1 AND o.status='closed' AND (income.id IS NULL OR income.status='unmapped')
          AND (o.closed_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date`,[venueId,from,to,timezone]);
      result.coverage.posIncomeClassification={status:Number(rows[0]?.count||0)?'incomplete':'complete',unclassifiedRevenueCount:Number(rows[0]?.count||0),unclassifiedRevenueAmount:rows[0]?.amount||'0.00',basis:'orders_without_category_snapshot_or_with_unmapped_allocations'};
    }
    if(!source||['obligation','payable_offset','obligation_recognition','obligation_adjustment'].includes(source)){
      const {rows}=await reportClient.query(`SELECT p.id AS "payableId",p.category_id AS "categoryId",p.category_name_snapshot AS "categoryName",p.title,p.counterparty_name AS "counterpartyName",p.period_from::text AS "servicePeriodFrom",p.period_to::text AS "servicePeriodTo",p.total_amount::text AS "unrecognizedAmount"
        FROM finance_payables p LEFT JOIN finance_payable_recognitions r ON r.venue_id=p.venue_id AND r.payable_id=p.id
        WHERE p.venue_id=$1 AND p.status='approved' AND ((p.period_from<=$3::date AND p.period_to>=$2::date) OR EXISTS (SELECT 1 FROM finance_payable_payment_links pl JOIN expenses e ON e.venue_id=pl.venue_id AND e.id=pl.expense_id WHERE pl.venue_id=p.venue_id AND pl.payable_id=p.id AND e.expense_date BETWEEN $2::date AND $3::date)) AND r.id IS NULL AND ($4::uuid IS NULL OR p.category_id=$4::uuid)
          AND ($5::text='' OR CONCAT_WS(' ',p.title,p.counterparty_name,p.basis) ILIKE '%'||$5||'%')
        ORDER BY p.period_from,p.id LIMIT ${rowLimit}`,[venueId,from,to,categoryId||null,q]);
      const {rows:totals}=await reportClient.query(`SELECT COUNT(*)::int AS count,COALESCE(SUM(p.total_amount),0)::text AS amount FROM finance_payables p LEFT JOIN finance_payable_recognitions r ON r.venue_id=p.venue_id AND r.payable_id=p.id WHERE p.venue_id=$1 AND p.status='approved' AND ((p.period_from<=$3::date AND p.period_to>=$2::date) OR EXISTS (SELECT 1 FROM finance_payable_payment_links pl JOIN expenses e ON e.venue_id=pl.venue_id AND e.id=pl.expense_id WHERE pl.venue_id=p.venue_id AND pl.payable_id=p.id AND e.expense_date BETWEEN $2::date AND $3::date)) AND r.id IS NULL AND ($4::uuid IS NULL OR p.category_id=$4::uuid) AND ($5::text='' OR CONCAT_WS(' ',p.title,p.counterparty_name,p.basis) ILIKE '%'||$5||'%')`,[venueId,from,to,categoryId||null,q]);
      result.coverage.payableRecognition={status:Number(totals[0]?.count||0)?'incomplete':'complete',unrecognizedCount:Number(totals[0]?.count||0),unrecognizedAmount:totals[0]?.amount||'0.00',items:rows};
      if(rows.length===rowLimit)result.coverage.possiblyTruncatedSections.push('payableRecognitionCoverage');
    }
    await reportClient.query('COMMIT');reportTransaction=false;
    return respond(200,result);
  }catch(error){return respond(503,{error:'finance_unified_report_unavailable'});}finally{
    if(reportTransaction&&reportClient){try{await reportClient.query('ROLLBACK');}catch(rollbackError){reportClient.release(rollbackError);reportClient=null;}}
    if(reportClient)reportClient.release();
  }
}
module.exports={handleFinanceUnifiedReport};
