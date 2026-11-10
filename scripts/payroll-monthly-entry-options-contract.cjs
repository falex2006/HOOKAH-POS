'use strict';
const assert = require('node:assert/strict');
const { explainMonthlyEntries } = require('../payroll-monthly-entry-options');
const evidence = require('./fixtures/payroll-replay-a0c94872/v2.json');
const { venueId, runId } = evidence;
const employeeId = evidence.calculatorReplay.result.employees[0].employeeId;
const detail = { capabilityVersion: evidence.capabilityVersion, period: evidence.period,
  venueTimezone: evidence.venueTimezone, employees: [{ employeeId }] };
const reads = { loadEvidence: async () => ({ evidence }), checkFreshness: async () => ({status:'current'}),
  readH1: async () => [{status:'draft_pending', usableForH2:false}] };
async function options(state, {slots=[], h2=true}={}, overrides={}) {
  const db = {query: async (sql, args) => {
    if (sql.includes('to_regclass')) return {rows:[{h1:true,h2}]};
    assert.equal(args[0],venueId);
    if (sql.includes('FROM unnest')) return {rows:[{employee_id:employeeId,...state}]};
    assert.match(sql,/FROM payroll_h2_claim_slots/);
    assert.match(sql,/c.id=s.claim_id/);
    assert.deepEqual(args,[venueId,evidence.period.from,[employeeId]]);
    return {rows:slots};
  }};
  return (await explainMonthlyEntries(db,{venueId},runId,detail,{...reads,...overrides})).employees[0];
}
(async () => {
  assert.deepEqual(await options({has_claim:false,zero_first_half:false}),{employeeId});
  const pending = await options({has_claim:true});
  assert.equal(pending.h2Required,true);
  assert.equal(pending.h2EntryAvailable,false);
  assert.equal(pending.h2EntryBlockReason,'payroll_half_month_h1_not_finalized');
  const reserved = await options({has_claim:false,zero_first_half:true},{slots:[{employee_id:employeeId}]});
  assert.equal(reserved.h2Required,true);
  assert.equal(reserved.h2EntryAvailable,false);
  const optional = await options({has_claim:false,zero_first_half:true},{},{checkFreshness:async()=>({status:'stale'})});
  assert.equal(optional.h2Required,false);
  assert.equal(optional.h2EntryAvailable,false);
  assert.equal((await options({has_claim:true},{h2:false})).h2EntryBlockReason,'payroll_half_month_settlement_schema_required');
  for(const other of [{...detail,capabilityVersion:'v1'},{...detail,period:{from:'2026-10-01',to:'2026-10-14'}}]) {
    assert.equal(await explainMonthlyEntries(null,{venueId},runId,other,{}),other);
  }
  console.log('PASS monthly payroll choices: REGULAR, pending H1, existing active H2, verified-zero route, historical schema and period isolation');
})().catch(error => { console.error(error); process.exitCode=1; });
