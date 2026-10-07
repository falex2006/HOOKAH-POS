'use strict';

const { createHash } = require('node:crypto');
const { requiredPayrollSourceFacts } = require('./payroll-source-policies');
const { readCanonicalPayrollPricingInTransaction } = require('./payroll-canonical-pricing-source');
const { readPayrollItemReturnEvidenceInTransaction } = require('./payroll-item-return-source');
const fail = code => { throw Object.assign(new TypeError(code), { code, status:400 }); };
const parsePayrollReadinessPeriod = input => {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key=>!['from','to'].includes(key))) fail('invalid_payroll_source_readiness_period');
  const valid = value => typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
  if (!valid(input.from) || !valid(input.to) || input.from>input.to || input.from!==input.from.slice(0,7)+'-01'
    || input.from.slice(0,7)!==input.to.slice(0,7)) fail('invalid_payroll_source_readiness_period');
  return {from:input.from,to:input.to};
};
const unsupported = reason => ({status:'unsupported',reasons:[reason]});
const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const count = value => { const result=Number(value); if(!Number.isSafeInteger(result)||result<0) throw new Error('payroll_readiness_count_overflow'); return result; };

// Observations describe existing mutable headers/lines, never canonical source coverage.
const readPayrollSourceReadinessInTransaction = async (db, actor, scheme, period, attendanceManifest) => {
  const venue=(await db.query('SELECT timezone FROM venues WHERE id=$1',[actor.venueId])).rows[0];
  if (!venue || typeof venue.timezone!=='string' || !venue.timezone) throw new Error('payroll_readiness_timezone_missing');
  const timezone=venue.timezone, params=[actor.venueId,period.from,period.to,timezone];
  const capability=(await db.query(`SELECT to_regclass('order_refunds') IS NOT NULL AS refunds,
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('order_items') AND attname='sales_employee_id' AND NOT attisdropped)
    AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('order_items') AND attname='sold_at' AND NOT attisdropped) AS attribution`)).rows[0];
  const headers=(await db.query(`SELECT id::text,closed_at::text,pricing_locked_at::text,pricing_version,
    subtotal_snapshot::text,discount_total_snapshot::text,minimum_adjustment_snapshot::text,final_total_snapshot::text
    FROM orders WHERE venue_id=$1 AND status='closed'
    AND closed_at>=($2::date::timestamp AT TIME ZONE $4)
    AND closed_at<(($3::date+1)::timestamp AT TIME ZONE $4) ORDER BY id`,params)).rows;
  const missing=count((await db.query("SELECT count(*)::text AS n FROM orders WHERE venue_id=$1 AND status='closed' AND closed_at IS NULL",[actor.venueId])).rows[0].n);
  const lines=(await db.query(`SELECT oi.id::text,oi.order_id::text,oi.quantity::text,oi.unit_price::text,
    ${capability.attribution?'oi.sales_employee_id::text,oi.sold_at::text':'NULL::text AS sales_employee_id,NULL::text AS sold_at'}
    FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.venue_id=$1 AND o.status='closed'
    AND o.closed_at>=($2::date::timestamp AT TIME ZONE $4)
    AND o.closed_at<(($3::date+1)::timestamp AT TIME ZONE $4) ORDER BY oi.id`,params)).rows;
  const missingHeader=headers.filter(row=>!row.pricing_locked_at || !(row.pricing_version>0)
    || ['subtotal_snapshot','discount_total_snapshot','minimum_adjustment_snapshot','final_total_snapshot'].some(key=>row[key]===null)).length;
  const orderObservations={status:missing||missingHeader?'incomplete':'available',reasons:[],closedOrderCount:headers.length,
    lockedOrderCount:headers.filter(row=>row.pricing_locked_at!==null).length,missingLockedHeaderCount:missingHeader,
    observedLineCount:lines.length,missingClosedAtCountVenueWide:missing,
    salesAttributionStatus:capability.attribution?'available':'unsupported',
    missingSalesAttributionLineCount:capability.attribution?lines.filter(row=>row.sales_employee_id===null||row.sold_at===null).length:null,
    watermarkScope:'observed_order_headers_and_current_lines',sourceWatermark:digest({venueId:actor.venueId,timezone,period,missingClosedAtCountVenueWide:missing,headers,lines})};
  if(missing)orderObservations.reasons.push('closed_order_date_missing_venue_wide');
  if(missingHeader)orderObservations.reasons.push('locked_order_header_missing');
  if(!capability.attribution)orderObservations.reasons.push('order_item_sales_attribution_schema_missing');
  let refundObservations={...unsupported('refund_event_schema_missing'),eventCount:null,unattributedEventCount:null,
    linkedToInspectedOrdersCount:null,linkedUnattributedCount:null,sourceWatermark:null,watermarkScope:'recorded_refund_events'};
  if(capability.refunds){
    const rows=(await db.query(`SELECT r.id::text,r.order_id::text,r.amount::text,r.created_at::text,r.item_attribution_status,
      (r.created_at>=($2::date::timestamp AT TIME ZONE $4) AND r.created_at<(($3::date+1)::timestamp AT TIME ZONE $4)) AS in_window,
      (o.status='closed' AND o.closed_at>=($2::date::timestamp AT TIME ZONE $4) AND o.closed_at<(($3::date+1)::timestamp AT TIME ZONE $4)) AS linked
      FROM order_refunds r JOIN orders o ON o.id=r.order_id AND o.venue_id=r.venue_id WHERE r.venue_id=$1 AND
      ((r.created_at>=($2::date::timestamp AT TIME ZONE $4) AND r.created_at<(($3::date+1)::timestamp AT TIME ZONE $4))
      OR (o.status='closed' AND o.closed_at>=($2::date::timestamp AT TIME ZONE $4) AND o.closed_at<(($3::date+1)::timestamp AT TIME ZONE $4))) ORDER BY r.id`,params)).rows;
    const unattributed=rows.some(row=>row.item_attribution_status==='unattributed');
    refundObservations={status:unattributed?'incomplete':'available',reasons:unattributed?['recorded_refund_item_attribution_incomplete']:[],eventCount:rows.filter(row=>row.in_window).length,
      unattributedEventCount:rows.filter(row=>row.in_window&&row.item_attribution_status==='unattributed').length,
      linkedToInspectedOrdersCount:rows.filter(row=>row.linked).length,
      linkedUnattributedCount:rows.filter(row=>row.linked&&row.item_attribution_status==='unattributed').length,
      watermarkScope:'recorded_refund_events',sourceWatermark:digest({venueId:actor.venueId,timezone,period,rows})};
  }
  let approvedAttendance;
  try {
    const result=await attendanceManifest.loadVerifiedApprovedAttendanceSourceInTransaction(db,actor,{periodFrom:period.from,periodTo:period.to});
    approvedAttendance={status:'available',reasons:[],approvalId:result.sourceAttendanceApproval.approvalId,
      sourceWatermark:result.sourceAttendanceApproval.sourceWatermark,shiftCount:result.attendance.length};
  } catch(error){
    if(!['payroll_attendance_source_incomplete','payroll_attendance_approval_required','payroll_attendance_approval_stale','payroll_attendance_snapshot_invalid'].includes(error.code))throw error;
    approvedAttendance={status:'incomplete',reasons:[error.code]};
  }
  const canonicalPricing = await readCanonicalPayrollPricingInTransaction(db, {venueId:actor.venueId,currency:scheme.currency,
    from:period.from,to:period.to,timezone});
  const itemReturnEvidence = await readPayrollItemReturnEvidenceInTransaction(db, {venueId:actor.venueId,currency:scheme.currency,
    from:period.from,to:period.to,timezone});
  return {schemaVersion:1,versionId:scheme.versionId,period:{...period,timezone},officialReady:false,
    requiredSourceFacts:requiredPayrollSourceFacts(scheme.sourcePolicies),components:{
      sourcePolicies:scheme.sourcePolicies?{status:'available',reasons:[]}:unsupported('explicit_owner_source_policy_selection_required'),
      approvedAttendance,orderObservations,refundObservations,
      canonicalLinePricing:{...canonicalPricing.component,attribution:canonicalPricing.attribution},
      itemReturnEvidence,
      payrollSaleCredit:unsupported('immutable_payroll_sale_credit_not_implemented'),
      recognizedLineRefunds:unsupported('recognized_line_refund_lineage_not_implemented'),
      fullEmployeeNetRevenue:unsupported('full_employee_net_revenue_source_not_implemented'),
      marginCosts:unsupported('immutable_margin_cost_source_not_implemented'),
      departmentShiftAllocation:unsupported('department_shift_allocation_source_not_implemented')}};
};
module.exports={parsePayrollReadinessPeriod,readPayrollSourceReadinessInTransaction};
