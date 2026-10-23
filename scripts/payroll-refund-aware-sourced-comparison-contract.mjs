import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { buildPayrollRefundAwareSourcedComparison } = require('../payroll-refund-aware-sourced-comparison.js');
const { buildPayrollModeAvailability } = require('../payroll-mode-availability.js');
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = value => sha(canonical(value));
const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'];
const venueId = '20000000-0000-4000-8000-000000000001';
const period = { from: '2026-10-01', to: '2026-10-31' };
const commonSource = { schemaVersion: 2, venueId, currency: 'RUB', period, timezone: 'Asia/Yekaterinburg',
  recognitionManifestWatermark: sha('manifest'), economicsSourceWatermark: sha('economics'), eligibilityWatermark: sha('eligibility'),
  optionalRawWatermarks: { approvedAttendance: sha('attendance'), departmentMapping: null, frozenDepletionCost: null } };
const sourcePolicies = schemaVersion => schemaVersion === 2 ? { schemaVersion: 2, selectionReason: 'explicit v2',
  saleCredit: { kind: 'line_seller_snapshot' }, discountAllocation: { kind: 'immutable_line_snapshot' },
  refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment',
    paidAdjustment: 'owner_review_variable_pay_only', uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' },
  earnings: { refunds: 'remaining_merchandise_original_sale_date_v1', venueTurnover: 'canonical_total_less_merchandise_returns_v1',
    marginCost: 'frozen_sale_depletion_cost_payroll_v1' } }
  : { schemaVersion: 1, selectionReason: 'explicit v1', saleCredit: { kind: 'line_seller_snapshot' },
    discountAllocation: { kind: 'immutable_line_snapshot' }, refunds: { recognition: 'recognized_event_date',
      closedRunTreatment: 'next_open_run_adjustment', paidAdjustment: 'owner_review_variable_pay_only',
      uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } };
const versions = ids.map((versionId, i) => ({ id: `30000000-0000-4000-8000-00000000000${i + 1}`,
  versionId, name: `Mode ${i + 1}`, versionNo: i + 1, mode: 'percent_only', currency: 'RUB' }));
const calc = (version, amount, employees, tweak = {}) => {
  const sourceWatermark = sha(`calc source ${version.versionId}`);
  const input = { periodFrom: period.from, periodTo: period.to, scheme: version,
    sourceEvidence: { recognitionManifest: { sourceWatermark: commonSource.recognitionManifestWatermark },
      remainingMerchandise: { sourceWatermark: commonSource.economicsSourceWatermark },
      employmentEligibility: { sourceWatermark: commonSource.eligibilityWatermark },
      roleCoverage: { sourceWatermark }, approvedAttendance: { sourceWatermark: commonSource.optionalRawWatermarks.approvedAttendance },
      department: { sourceWatermark }, frozenDepletionCost: { sourceWatermark, accountingScope: 'payroll_incentive_only' } },
    personalRevenueSource: { sourceWatermark } };
  const result = { employees: employees.map(([employeeId, amountCents]) => ({ employeeId, amountCents })) };
  const expectedFacts = buildPayrollModeAvailability({}, {}, version, period)[version.mode]?.requiredFacts || [];
  const payload = { schemaVersion: 2, status: 'refund_aware_calculated', officialReady: false, payoutEligible: false,
    sourceAttested: false, persistence: 'none', amountCents: amount, venueId, schemeVersionId: version.versionId,
    currency: 'RUB', period, requiredFacts: expectedFacts, input, inputWatermark: digest(input), engineResult: result,
    economics: { sourceWatermark: commonSource.economicsSourceWatermark },
    department: { sourceWatermark: sourceWatermark, coverage: { mappingSourceWatermark: commonSource.optionalRawWatermarks.departmentMappingRevision } },
    costs: { sourceWatermark, coverage: { producerWatermarks: [] } },
    team: { departmentShiftAllocation: { sourceWatermark }, teamMembershipAndWeights: { sourceWatermark } },
    periodClosure: { schemaVersion: 1, venueId, period, timezone: commonSource.timezone } };
  return { ...payload, calculationWatermark: digest(payload), ...tweak };
};
const build = (vs, policies, calculations, baselineVersionId = vs[0].versionId, source = commonSource, candidateRawBindings = []) =>
  buildPayrollRefundAwareSourcedComparison({ venueId, currency: 'RUB', period, baselineVersionId, versions: vs,
    policies, calculations, candidateRawBindings, commonSource: source });
const rehash = candidate => {
  candidate.inputWatermark = digest(candidate.input);
  const copy = { ...candidate }; delete copy.calculationWatermark;
  candidate.calculationWatermark = digest(copy);
  return candidate;
};

const modes = ['progressive_daily', 'stable_percent', 'percent_only', 'final_month_threshold', 'personal_target', 'team_fund', 'margin_target'];
const sevenModeVersions = modes.map((mode, index) => ({ ...versions[index % 2], mode,
  versionId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` }));
const sevenModeResults = build(sevenModeVersions.slice(0, 2), [sourcePolicies(2), sourcePolicies(2)],
  [calc(sevenModeVersions[0], 1000, [[ids[0], 1000]]), calc(sevenModeVersions[1], 1250, [[ids[0], 1250]])]);
assert.equal(sevenModeResults.results[1].deltaCents, 250);
for (const mode of modes) {
  const version = { ...versions[0], versionId: `50000000-0000-4000-8000-${String(modes.indexOf(mode) + 1).padStart(12, '0')}`, mode };
  const other = { ...version, id: versions[1].id, versionId: `60000000-0000-4000-8000-${String(modes.indexOf(mode) + 1).padStart(12, '0')}` };
  const candidates = [calc(version, 0, [[ids[0], 0]]), calc(other, 0, [[ids[0], 0]])];
  let modeSource = commonSource, bindings = [];
  if (mode === 'margin_target') {
    const dept = sha('mode department'), cost = sha('mode cost'), order = '81000000-0000-4000-8000-000000000001';
    modeSource = { ...commonSource, optionalRawWatermarks: { ...commonSource.optionalRawWatermarks,
      departmentMappingRevision: dept, frozenDepletionCost: sha('mode frozen raw cost'), frozenSaleCostByOrder: { [order]: cost } } };
    for (const candidate of candidates) {
      candidate.department.coverage.mappingSourceWatermark = dept;
      candidate.costs.coverage.producerWatermarks = [{ orderId: order, watermark: cost }];
      rehash(candidate);
    }
    bindings = candidates.map(() => ({ departmentMappingRevision: dept, frozenSaleCostByOrder: { [order]: cost } }));
  }
  const result = build([version, other], [sourcePolicies(2), sourcePolicies(2)], candidates, version.versionId, modeSource, bindings);
  assert.equal(result.results[0].status, 'ready', `${mode} accepts known zero employee result`);
}

const mixedVersion = { ...versions[1], versionId: '70000000-0000-4000-8000-000000000001' };
const mixedCalc = calc(mixedVersion, 900, [[ids[0], 900]]);
const blockedV1 = { status: 'blocked', reasons: ['refunds_not_supported'], amountCents: null };
const blockedBaseline = build([versions[0], mixedVersion], [sourcePolicies(1), sourcePolicies(2)], [blockedV1, mixedCalc], versions[0].versionId);
assert.equal(blockedBaseline.results[1].status, 'ready');
assert.equal(blockedBaseline.results[1].amountCents, 900);
assert.equal(blockedBaseline.results[1].deltaCents, null);
assert.equal(blockedBaseline.results[1].employeeDeltas, null);

const v1Candidate = { status: 'scenario_ready', candidateOnly: true, officialReady: false, payoutEligible: false,
  nonPayable: true, nonAccrual: true, amountCents: 800, inputWatermark: sha('v1-input'),
  employees: [{ employeeId: ids[0], amountCents: 800 }] };
const v1Preview = { candidateCalculation: v1Candidate, candidateSnapshot: { schemaVersion: 1,
  snapshotKind: 'candidate_preview', candidateOnly: true, officialReady: false, payoutEligible: false,
  nonPayable: true, nonAccrual: true, persistence: 'none', venueId, schemeVersionId: versions[0].versionId,
  currency: 'RUB', period: { ...period, timezone: commonSource.timezone }, snapshotWatermark: sha('v1-snapshot') },
  sources: { readiness: { components: { recognitionManifest: { sourceWatermark: commonSource.recognitionManifestWatermark } } } } };
const crossFamily = build([versions[0], mixedVersion], [sourcePolicies(1), sourcePolicies(2)],
  [{ legacyPreview: v1Preview }, mixedCalc], versions[0].versionId);
assert.equal(crossFamily.results[1].status, 'ready');
assert.equal(crossFamily.results[1].deltaCents, null, 'cross-policy family comparison has no money delta');

const sameFamily = build([mixedVersion, { ...mixedVersion, versionId: '70000000-0000-4000-8000-000000000002' }],
  [sourcePolicies(2), sourcePolicies(2)], [calc(mixedVersion, 500, [[ids[0], 500]]),
    calc({ ...mixedVersion, versionId: '70000000-0000-4000-8000-000000000002' }, 700, [[ids[0], 700]])]);
assert.equal(sameFamily.results[1].deltaCents, 200);
assert.equal(sameFamily.results[0].deltaCents, 0, 'ready baseline has a zero self delta');
assert.deepEqual(sameFamily.results[1].employeeDeltas, [{ employeeId: ids[0], status: 'comparable', amountCents: 700,
  baselineAmountCents: 500, deltaCents: 200 }]);
assert.deepEqual(sameFamily.results[0].employeeDeltas, [{ employeeId: ids[0], status: 'comparable', amountCents: 500,
  baselineAmountCents: 500, deltaCents: 0 }]);

const differentCohort = build([mixedVersion, { ...mixedVersion, versionId: '70000000-0000-4000-8000-000000000003' }],
  [sourcePolicies(2), sourcePolicies(2)], [calc(mixedVersion, 500, [[ids[0], 500]]),
    calc({ ...mixedVersion, versionId: '70000000-0000-4000-8000-000000000003' }, 700, [[ids[1], 700]])]);
assert.equal(differentCohort.results[1].deltaCents, 200);
assert.deepEqual(differentCohort.results[1].employeeDeltas, [
  { employeeId: ids[0], status: 'identity_uncovered', amountCents: null, baselineAmountCents: 500, deltaCents: null },
  { employeeId: ids[1], status: 'identity_uncovered', amountCents: 700, baselineAmountCents: null, deltaCents: null }
]);

const malformed = calc(mixedVersion, 500, [[ids[0], 499]]);
const rejected = build([mixedVersion, { ...mixedVersion, versionId: '70000000-0000-4000-8000-000000000004' }],
  [sourcePolicies(2), sourcePolicies(2)], [malformed, calc({ ...mixedVersion, versionId: '70000000-0000-4000-8000-000000000004' }, 700, [[ids[0], 700]])]);
assert.equal(rejected.results[0].status, 'blocked', 'employee totals must reconcile to candidate amount');
assert.equal(rejected.results[1].deltaCents, null);

const tamperedInput = calc(mixedVersion, 500, [[ids[0], 500]]);
tamperedInput.input.sourceEvidence.recognitionManifest.sourceWatermark = sha('forged-manifest');
const tampered = build([mixedVersion, { ...mixedVersion, versionId: '70000000-0000-4000-8000-000000000005' }],
  [sourcePolicies(2), sourcePolicies(2)], [tamperedInput, calc({ ...mixedVersion, versionId: '70000000-0000-4000-8000-000000000005' }, 700, [[ids[0], 700]])]);
assert.equal(tampered.results[0].status, 'blocked', 'common source and input evidence must bind');
assert.equal(tampered.results[1].deltaCents, null);

const rawDeptA = sha('valid raw department revision A'), rawDeptB = sha('valid raw department revision B');
const rawCostA = sha('valid raw cost A'), rawCostB = sha('valid raw cost B');
const costOrder = '80000000-0000-4000-8000-000000000001';
const rawBoundSource = { ...commonSource, optionalRawWatermarks: { ...commonSource.optionalRawWatermarks,
  departmentMappingRevision: rawDeptA, frozenSaleCostByOrder: { [costOrder]: rawCostA } } };
const withRaw = (version, { department = rawDeptA, cost = rawCostA } = {}) => {
  const candidate = calc(version, 500, [[ids[0], 500]]);
  candidate.requiredFacts = buildPayrollModeAvailability({}, {}, version, period)[version.mode].requiredFacts;
  candidate.input.sourceEvidence.department = { sourceWatermark: sha('derived dept') };
  candidate.input.sourceEvidence.frozenDepletionCost = { sourceWatermark: sha('derived cost'), accountingScope: 'payroll_incentive_only' };
  candidate.department = { sourceWatermark: sha('derived dept'), coverage: { mappingSourceWatermark: department } };
  candidate.costs = { sourceWatermark: sha('derived cost'), coverage: { producerWatermarks: [{ orderId: costOrder, watermark: cost }] } };
  return rehash(candidate);
};
const rawBindings = (department, cost) => ({ departmentMappingRevision: department,
  frozenSaleCostByOrder: { [costOrder]: cost } });
const rawModeVersion = { ...mixedVersion, mode: 'margin_target' };
const rawModeVersion2 = { ...rawModeVersion, versionId: '70000000-0000-4000-8000-000000000006' };
const departmentSwap = build([rawModeVersion, rawModeVersion2],
  [sourcePolicies(2), sourcePolicies(2)], [withRaw(rawModeVersion, { department: rawDeptB }),
    withRaw(rawModeVersion2, { department: rawDeptB })],
  rawModeVersion.versionId, rawBoundSource, [rawBindings(rawDeptB, rawCostA), rawBindings(rawDeptB, rawCostA)]);
assert.equal(departmentSwap.results[0].status, 'blocked', 'a rehashed alternate valid raw department revision cannot inherit the common watermark');
const rawModeVersion3 = { ...rawModeVersion, versionId: '70000000-0000-4000-8000-000000000007' };
const costSwap = build([rawModeVersion, rawModeVersion3],
  [sourcePolicies(2), sourcePolicies(2)], [withRaw(rawModeVersion, { cost: rawCostB }),
    withRaw(rawModeVersion3, { cost: rawCostB })],
  rawModeVersion.versionId, rawBoundSource, [rawBindings(rawDeptA, rawCostB), rawBindings(rawDeptA, rawCostB)]);
assert.equal(costSwap.results[0].status, 'blocked', 'a rehashed alternate valid raw frozen-cost producer cannot inherit the common watermark');

const droppedRequired = calc(mixedVersion, 500, [[ids[0], 500]]);
droppedRequired.requiredFacts = ['recognitionManifest'];
rehash(droppedRequired);
const dropped = build([mixedVersion, { ...mixedVersion, versionId: '70000000-0000-4000-8000-000000000008' }],
  [sourcePolicies(2), sourcePolicies(2)], [droppedRequired,
    calc({ ...mixedVersion, versionId: '70000000-0000-4000-8000-000000000008' }, 700, [[ids[0], 700]])]);
assert.equal(dropped.results[0].status, 'blocked', 'rehashing a candidate after deleting mode-required source facts must not make it ready');

// Run the original single-scheme collector from its actual CommonJS source.
// Comparison added a pure cost builder import; dropping the existing transaction
// reader import must not leave the old margin-run branch failing at runtime.
{
  const source=readFileSync(new URL('../payroll-refund-aware-source.js',import.meta.url),'utf8');
  const calls=[];
  let costUnavailable=false;
  const actor={venueId,userId:ids[0]},singlePeriod={...period};
  const recognitionEvidence={manifest:{watermark:sha('single manifest')}};
  const projection={id:'single economic projection'};
  const employmentEligibility={id:'single employment source'};
  const departmentMapping={component:{status:'available'},revision:{id:'single department revision'}};
  const approvedAttendanceSource={id:'single approved attendance'};
  const costEvidence=[{id:'single frozen producer evidence'}];
  const fakeDb={query:async(sql,params)=>{
    calls.push(['query',params]);
    if(sql.includes("u.role='owner'"))return{rows:[{id:actor.userId}]};
    if(sql.includes('FROM venues'))return{rows:[{transactionTimestamp:'2026-10-01T00:00:00Z',venueLocalDate:'2026-10-01',timezone:'UTC'}]};
    throw new Error('unexpected original collector query');
  }};
  const deps={
    './payroll-source-fence':{hasPayrollVerifiedSourceSnapshot:(db,id)=>db===fakeDb&&id===venueId},
    './payroll-recognition-manifest':{readPayrollRecognitionEvidenceInTransaction:async(db,options)=>{
      assert.equal(db,fakeDb);assert.equal(options.venueId,venueId);calls.push(['recognition']);return recognitionEvidence;}},
    './payroll-refund-economic-source':{buildPayrollRefundEconomicSource:evidence=>{assert.equal(evidence,recognitionEvidence);return{projection};}},
    './payroll-employment-eligibility':{loadLatestEligibilitySourceInTransaction:async()=>employmentEligibility},
    './payroll-product-department-source':{loadLatestProductDepartmentMappingInTransaction:async()=>departmentMapping},
    './payroll-refund-frozen-cost-source':{readPayrollRefundFrozenCostSourceInTransaction:async(db,options)=>{
      assert.equal(db,fakeDb);assert.equal(options.venueId,venueId);assert.equal(options.projection,projection);
      calls.push(['frozen cost transaction reader']);
      return costUnavailable?{status:'incomplete',reasons:['actual_frozen_cost_missing']}:{status:'available',evidenceByOrder:costEvidence};}},
    './payroll-mode-availability':{buildPayrollModeAvailability:()=>({margin_target:{requiredFacts:['approvedAttendance','immutableDepartmentAttribution','marginCosts']}})},
    './payroll-source-policies':{normalizePayrollSourcePolicies:policy=>policy}
  };
  const sourceRequire=createRequire(new URL('../payroll-refund-aware-source.js',import.meta.url));
  const sourceContext=vm.createContext({module:{exports:{}},require:name=>deps[name]||sourceRequire(name)});
  vm.runInContext(source,sourceContext);
  const loader=sourceContext.module.exports.readPayrollRefundAwareSourceArgsInTransaction;
  const scheme={mode:'margin_target',currency:'RUB',sourcePolicies:{schemaVersion:2}};
  const attendance={loadVerifiedApprovedAttendanceSourceInTransaction:async()=>approvedAttendanceSource};
  const result=await loader(fakeDb,actor,scheme,singlePeriod,attendance);
  assert.equal(result.status,'source_arguments_collected');
  assert.equal(result.sourceArgs.costEvidenceByOrder,costEvidence);
  assert.equal(result.sourceArgs.departmentMapping,departmentMapping);
  assert.equal(result.sourceArgs.approvedAttendanceSource,approvedAttendanceSource);
  assert.equal(result.sourceArgs.employmentEligibility,employmentEligibility);
  assert.equal(calls.filter(([name])=>name==='frozen cost transaction reader').length,1);
  costUnavailable=true;
  const unavailable=await loader(fakeDb,actor,scheme,singlePeriod,attendance);
  assert.equal(unavailable.status,'blocked');
  assert.deepEqual(Array.from(unavailable.reasons),['actual_frozen_cost_missing']);

  // Exercise the actual union collector with a missing optional cost schema.
  // Only margin depends on it; a percent candidate on the same mandatory
  // sources must remain ready, rather than inheriting a global failure.
  recognitionEvidence.manifest.watermark=commonSource.recognitionManifestWatermark;
  employmentEligibility.component={status:'available',sourceWatermark:commonSource.eligibilityWatermark};
  approvedAttendanceSource.sourceAttendanceApproval={sourceWatermark:commonSource.optionalRawWatermarks.approvedAttendance};
  const originalQuery=fakeDb.query;
  fakeDb.query=async(sql,params)=>{
    assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE)\b/i);
    if(sql.includes('FROM venues'))return{rows:[{transactionTimestamp:'2026-10-01T00:00:00Z',
      venueLocalDate:'2026-10-01',timezone:commonSource.timezone}]};
    if(sql.includes('unnest($1::text[])'))return{rows:[{count:0}]};
    return originalQuery(sql,params);
  };
  const unavailableMargin={...versions[0],mode:'margin_target',sourcePolicies:sourcePolicies(2)};
  const readyPercent={...versions[1],sourcePolicies:sourcePolicies(2)};
  const builtModes=[];
  const comparisonDeps={...deps,
    './payroll-refund-economic-source':{buildPayrollRefundEconomicSource:()=>({projection,sourceWatermark:commonSource.economicsSourceWatermark})},
    './payroll-mode-availability':{buildPayrollModeAvailability},
    './payroll-refund-aware-calculation':{buildPayrollRefundAwareCalculation:args=>{
      builtModes.push(args.scheme.mode);assert.equal(args.recognitionEvidence,recognitionEvidence);
      return calc(args.scheme,500,[[ids[0],500]]);
    }}
  };
  const comparisonContext=vm.createContext({module:{exports:{}},require:name=>comparisonDeps[name]||sourceRequire(name)});
  vm.runInContext(source,comparisonContext);
  const collected=await comparisonContext.module.exports.collectPayrollRefundAwareComparisonInTransaction(fakeDb,actor,
    [unavailableMargin,readyPercent],singlePeriod,attendance,{baselineVersionId:readyPercent.versionId});
  assert.equal(collected.results[0].status,'blocked');
  assert.equal(collected.results[0].amountCents,null);
  assert.ok(collected.results[0].reasons.includes('payroll_margin_cost_source_schema_missing'));
  assert.equal(collected.results[1].status,'ready');assert.equal(collected.results[1].amountCents,500);
  assert.equal(collected.results[1].deltaCents,0);
  assert.deepEqual(builtModes,['percent_only'],'missing cost never invokes the margin calculator or blocks percent');
}
console.log('payroll-refund-aware-sourced-comparison-contract: PASS (single-run margin imports and independent optional-cost collector blocking)');
