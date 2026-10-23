'use strict';

const { buildPayrollMarginCostSource } = require('./payroll-margin-cost-source');
const { readSaleCostEvidence } = require('./pos-sale-cost-evidence');

const { createHash } = require('node:crypto');
const { requiredPayrollSourceFacts } = require('./payroll-source-policies');
const { readCanonicalPayrollPricingInTransaction } = require('./payroll-canonical-pricing-source');
const { buildPayrollSaleCreditComponent } = require('./payroll-sale-credit-source');
const { readPayrollItemReturnEvidenceInTransaction } = require('./payroll-item-return-source');
const { readPayrollRecognitionManifestInTransaction } = require('./payroll-recognition-manifest');
const { buildPayrollRecognitionPreview } = require('./payroll-recognition-preview');
const { buildPayrollFullEmployeeNetRevenueSource } = require('./payroll-full-employee-net-revenue-source');
const { loadLatestEligibilitySourceInTransaction, buildEligibleEmployees } = require('./payroll-employment-eligibility');
const { buildPayrollEmployeeRoleCoverage } = require('./payroll-employee-role-coverage');
const { buildPayrollProductDepartmentSource, loadLatestProductDepartmentMappingInTransaction } = require('./payroll-product-department-source');
const { buildPayrollModeAvailability } = require('./payroll-mode-availability');
const { buildPayrollCalculatorSales, buildPayrollTeamFundSource } = require('./payroll-team-fund-source');
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
const readPayrollSourceReadinessEvidenceInTransaction = async (db, actor, scheme, period, attendanceManifest,
  { recognitionManifest: sharedRecognitionManifest, sharedSources = null } = {}) => {
  if (sharedSources !== null) {
    if (!sharedSources || sharedSources.commonSource?.venueId !== actor.venueId
        || sharedSources.commonSource?.currency !== scheme.currency
        || sharedSources.commonSource?.period?.from !== period.from || sharedSources.commonSource?.period?.to !== period.to
        || sharedSources.closure?.timezone !== sharedSources.commonSource?.timezone
        || sharedSources.recognitionManifest?.venueId !== actor.venueId
        || sharedSources.recognitionManifest?.currency !== scheme.currency
        || sharedSources.recognitionManifest?.period?.from !== period.from
        || sharedSources.recognitionManifest?.period?.to !== period.to) fail('payroll_readiness_shared_source_context_invalid');
  }
  const venue=(await db.query('SELECT timezone FROM venues WHERE id=$1',[actor.venueId])).rows[0];
  if (!venue || typeof venue.timezone!=='string' || !venue.timezone) throw new Error('payroll_readiness_timezone_missing');
  const timezone=venue.timezone, params=[actor.venueId,period.from,period.to,timezone];
  if (sharedSources && sharedSources.commonSource.timezone !== timezone) fail('payroll_readiness_shared_source_timezone_invalid');
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
  let approvedAttendanceSource = null;
  try {
    const result=sharedSources?.approvedAttendanceError ? (()=>{ throw Object.assign(new Error(sharedSources.approvedAttendanceError),{code:sharedSources.approvedAttendanceError}); })()
      : sharedSources ? sharedSources.approvedAttendanceSource
      : await attendanceManifest.loadVerifiedApprovedAttendanceSourceInTransaction(db,actor,{periodFrom:period.from,periodTo:period.to});
    if (!result) throw Object.assign(new Error('payroll_attendance_source_incomplete'), { code: 'payroll_attendance_source_incomplete' });
    if (sharedSources && result.sourceAttendanceApproval?.sourceWatermark !== sharedSources.commonSource.optionalRawWatermarks?.approvedAttendance)
      fail('payroll_readiness_shared_attendance_binding_invalid');
    approvedAttendanceSource = { attendance: result.attendance, attendanceCoverage: result.attendanceCoverage,
      sourceAttendanceApproval: result.sourceAttendanceApproval };
    approvedAttendance={status:'available',reasons:[],approvalId:result.sourceAttendanceApproval.approvalId,
      sourceWatermark:result.sourceAttendanceApproval.sourceWatermark,watermarkScope:'owner_approved_attendance_snapshot',shiftCount:result.attendance.length};
  } catch(error){
    if(!['payroll_attendance_source_incomplete','payroll_attendance_approval_required','payroll_attendance_approval_stale','payroll_attendance_snapshot_invalid','payroll_attendance_function_context_schema_required'].includes(error.code))throw error;
    approvedAttendance={status:'incomplete',reasons:[error.code]};
  }
  const canonicalPricing = await readCanonicalPayrollPricingInTransaction(db, {venueId:actor.venueId,currency:scheme.currency,
    from:period.from,to:period.to,timezone});
  const itemReturnEvidence = await readPayrollItemReturnEvidenceInTransaction(db, {venueId:actor.venueId,currency:scheme.currency,
    from:period.from,to:period.to,timezone});
  let recognitionManifest = sharedRecognitionManifest;
  if (recognitionManifest !== undefined) {
    if (!recognitionManifest || recognitionManifest.venueId !== actor.venueId || recognitionManifest.currency !== scheme.currency
        || recognitionManifest.period?.from !== period.from || recognitionManifest.period?.to !== period.to
        || recognitionManifest.schemaVersion !== 1 || !Array.isArray(recognitionManifest.saleLines)
        || !Array.isArray(recognitionManifest.refundEvents)) throw Object.assign(new TypeError('payroll_readiness_shared_manifest_context_invalid'),
      { code: 'payroll_readiness_shared_manifest_context_invalid' });
  } else {
    recognitionManifest = await readPayrollRecognitionManifestInTransaction(db, {venueId:actor.venueId,currency:scheme.currency,
      from:period.from,to:period.to});
  }
  const recognitionProjection = buildPayrollRecognitionPreview(recognitionManifest, scheme.sourcePolicies);
  const fullEmployeeNetRevenueSource = buildPayrollFullEmployeeNetRevenueSource(recognitionManifest, scheme.sourcePolicies);
  const recognizedLineRefunds = { status: recognitionProjection.sourceStatus,
    reasons: recognitionProjection.sourceReasons,
    sourceWatermark: recognitionProjection.projectionWatermark || null,
    watermarkScope: 'immutable_recognized_sale_and_refund_candidate_projection' };
  const recognizedManifestEvidence = {status:recognitionManifest.status,reasons:recognitionManifest.reasons,
    recognizedSaleEventCount:recognitionManifest.saleEvents.length,recognizedSaleLineCount:recognitionManifest.saleLines.length,
    recognizedRefundEventCount:recognitionManifest.refundEvents.length,
    recognizedRefundLineCount:recognitionManifest.refundEvents.reduce((sum,event)=>sum+event.lines.length,0),
    sourceWatermark:recognitionManifest.watermark,watermarkScope:recognitionManifest.watermarkScope};
  const employmentEligibilitySource = sharedSources ? sharedSources.employmentEligibility
    : await loadLatestEligibilitySourceInTransaction(db, actor.venueId);
  if (!employmentEligibilitySource) fail('payroll_readiness_shared_eligibility_missing');
  if (sharedSources && (employmentEligibilitySource.component?.sourceWatermark || null) !== sharedSources.commonSource.eligibilityWatermark)
    fail('payroll_readiness_shared_eligibility_binding_invalid');
  const roleCoverageEmployees = employmentEligibilitySource.component.status === 'available' && employmentEligibilitySource.revision
    ? buildEligibleEmployees(employmentEligibilitySource.periods.map(({ employeeId, effectiveFrom, effectiveTo }) =>
      ({ employeeId, effectiveFrom, effectiveTo })), period.from, period.to)
    : null;
  const employeeRoleCoverage = buildPayrollEmployeeRoleCoverage({ venueId: actor.venueId, scheme,
    period: { from: period.from, to: period.to }, eligibilitySource: employmentEligibilitySource, employees: roleCoverageEmployees });
  const components = {
      sourcePolicies:scheme.sourcePolicies?{status:'available',reasons:[]}:unsupported('explicit_owner_source_policy_selection_required'),
      approvedAttendance,orderObservations,refundObservations,
      canonicalLinePricing:{...canonicalPricing.component,attribution:canonicalPricing.attribution},
      itemReturnEvidence,
      payrollSaleCredit:buildPayrollSaleCreditComponent(canonicalPricing, {
        sourcePolicies:scheme.sourcePolicies,venueId:actor.venueId,currency:scheme.currency,
        from:period.from,to:period.to,timezone
      }),
      recognitionManifest:recognizedManifestEvidence,
      employeeEligibility: employmentEligibilitySource.component,
      employeeRoleCoverage: { ...employeeRoleCoverage, venueId: actor.venueId, currency: scheme.currency,
        period: { from: period.from, to: period.to } },
      recognizedLineRefunds,
      fullEmployeeNetRevenue: { status: fullEmployeeNetRevenueSource.status, reasons: fullEmployeeNetRevenueSource.reasons,
        sourceWatermark: fullEmployeeNetRevenueSource.sourceWatermark, watermarkScope: fullEmployeeNetRevenueSource.watermarkScope },
      marginCosts:unsupported('immutable_margin_cost_source_not_implemented'),
      departmentShiftAllocation:unsupported('department_shift_allocation_source_not_implemented'),
      teamMembershipAndWeights:unsupported('team_membership_and_weights_source_not_implemented')};
  const departmentRequired = buildPayrollModeAvailability(components, {}, scheme, period)[scheme.mode].requiredFacts
    .includes('immutableDepartmentAttribution');
  let departmentMappingSource = null;
  if (departmentRequired) {
    const loaded = sharedSources?.departmentMappingError ? { component: { status: 'incomplete',
      reasons: [sharedSources.departmentMappingError] }, revision: null, mappings: [] }
      : sharedSources ? sharedSources.departmentMapping
      : await loadLatestProductDepartmentMappingInTransaction(db, actor.venueId);
    if (!loaded) fail('payroll_readiness_shared_department_missing');
    if (sharedSources && (loaded.component?.sourceWatermark || null) !== sharedSources.commonSource.optionalRawWatermarks?.departmentMappingRevision)
      fail('payroll_readiness_shared_department_binding_invalid');
    departmentMappingSource = loaded.revision
      ? buildPayrollProductDepartmentSource({ venueId: actor.venueId, period, timezone, recognitionManifest,
        revision: loaded.revision, mappings: loaded.mappings })
      : { schemaVersion: 1, status: loaded.component.status, reasons: loaded.component.reasons, rows: [], refunds: [],
        coverage: null, mappingRevision: null, sourceWatermark: null, watermarkScope: 'payroll_owner_attested_product_department_classification' };
    if (loaded.component.status !== 'available') {
      departmentMappingSource.status = loaded.component.status;
      departmentMappingSource.reasons = [...new Set([...(departmentMappingSource.reasons || []), ...loaded.component.reasons])].sort();
    }
    components.immutableDepartmentAttribution = { status: departmentMappingSource.status, reasons: departmentMappingSource.reasons,
      sourceWatermark: departmentMappingSource.sourceWatermark, watermarkScope: departmentMappingSource.watermarkScope,
      venueId: actor.venueId, currency: scheme.currency, period: { from: period.from, to: period.to } };
  } else {
    components.immutableDepartmentAttribution = { status: 'not_required', reasons: [], sourceWatermark: null,
      watermarkScope: 'payroll_owner_attested_product_department_classification' };
  }
  const selectedModeFacts = buildPayrollModeAvailability(components, {}, scheme, period)[scheme.mode].requiredFacts;
  let marginCostSource = null, marginCostEvidenceByOrder = null;
  if (selectedModeFacts.includes('marginCosts')) {
    const columns = ['pos_sale_cost_evidence.venue_id','pos_sale_cost_evidence.order_id','pos_sale_cost_evidence.payload',
      'pos_sale_cost_evidence.watermark','pos_sale_cost_epochs.venue_id','pos_sale_cost_epochs.activated_at'];
    const capability = sharedSources?.legacyCostSchemaAvailable === true ? { rows: [{ count: columns.length }] }
      : sharedSources?.legacyCostSchemaAvailable === false ? { rows: [{ count: 0 }] }
      : await db.query(`SELECT count(*)::int AS count FROM unnest($1::text[]) AS required(name)
      WHERE EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(split_part(required.name,'.',1))
      AND attname=split_part(required.name,'.',2) AND NOT attisdropped)`, [columns]);
    if (capability.rows[0]?.count !== columns.length) components.marginCosts = unsupported('payroll_margin_cost_source_schema_missing');
    else {
      marginCostEvidenceByOrder = sharedSources?.legacyCostEvidenceByOrder || [];
      if (!sharedSources) for (const orderId of [...new Set((recognitionManifest.sales || []).map(row => row.orderId))].sort())
        marginCostEvidenceByOrder.push(await readSaleCostEvidence(db, { venueId: actor.venueId, orderId }));
      if (sharedSources) {
        const expectedOrders=[...new Set((recognitionManifest.sales||[]).map(row=>row.orderId))].sort();
        const actual=Object.fromEntries(marginCostEvidenceByOrder.map(row=>[row.orderId,row.watermark]));
        const raw=sharedSources.commonSource.optionalRawWatermarks?.frozenSaleCostByOrder || {};
        if (Object.keys(actual).sort().join('|')!==expectedOrders.join('|')
            || expectedOrders.some(orderId=>actual[orderId]!==raw[orderId])) fail('payroll_readiness_shared_cost_binding_invalid');
      }
      marginCostSource = buildPayrollMarginCostSource({ venueId: actor.venueId, currency: scheme.currency,
        period, recognitionManifest, evidenceByOrder: marginCostEvidenceByOrder });
      components.marginCosts = { status: marginCostSource.status, reasons: marginCostSource.reasons,
        sourceWatermark: marginCostSource.sourceWatermark, watermarkScope: marginCostSource.watermarkScope,
        venueId: actor.venueId, currency: scheme.currency, period: { from: period.from, to: period.to } };
    }
  }
  const calculatorSales = buildPayrollCalculatorSales({ currency: scheme.currency, recognitionManifest,
    recognitionProjection, departmentAttribution: departmentMappingSource, marginCostSource });
  let teamFundEvidence = null;
  if (selectedModeFacts.includes('departmentShiftAllocation') || selectedModeFacts.includes('teamMembershipAndWeights')) {
    teamFundEvidence = buildPayrollTeamFundSource({ venueId: actor.venueId, scheme, period: { ...period, timezone },
      currency: scheme.currency, employees: roleCoverageEmployees, roleAssignments: scheme.roleAssignments || [],
      sales: calculatorSales, attendance: approvedAttendanceSource?.attendance || null,
      attendanceCoverage: approvedAttendanceSource?.attendanceCoverage || null,
      departmentAttribution: departmentMappingSource, employmentEligibility: employmentEligibilitySource });
    for (const key of ['departmentShiftAllocation', 'teamMembershipAndWeights']) {
      const evidence = teamFundEvidence[key];
      components[key] = { status: evidence.status, reasons: evidence.reasons,
        sourceWatermark: evidence.sourceWatermark, watermarkScope: evidence.watermarkScope,
        venueId: actor.venueId, currency: scheme.currency, period: { from: period.from, to: period.to } };
    }
  }
  const readiness = {schemaVersion:1,versionId:scheme.versionId,period:{...period,timezone},officialReady:false,
    requiredSourceFacts:requiredPayrollSourceFacts(scheme.sourcePolicies),components};
  return { readiness, recognitionManifest, recognitionProjection, fullEmployeeNetRevenueSource,
    approvedAttendanceSource, employmentEligibilitySource, departmentMappingSource, calculatorSales, teamFundEvidence, marginCostSource, marginCostEvidenceByOrder };
};
const readPayrollSourceReadinessInTransaction = async (...args) =>
  (await readPayrollSourceReadinessEvidenceInTransaction(...args)).readiness;
module.exports={parsePayrollReadinessPeriod,readPayrollSourceReadinessInTransaction,readPayrollSourceReadinessEvidenceInTransaction};
