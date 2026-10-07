import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const migration=fileURLToPath(new URL('../migrations/089_payroll_milestone_snapshots.sql',import.meta.url));
assert.ok(fs.existsSync(migration),'089 durable milestone storage migration is required');
const sql=fs.readFileSync(migration,'utf8');
for(const table of ['payroll_milestone_day_snapshots','payroll_milestone_decision_snapshots']) {
  assert.match(sql,new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
}
assert.match(sql,/milestone_evidence_version/);
assert.match(sql,/DEFERRABLE INITIALLY DEFERRED/);
assert.match(sql,/BEFORE TRUNCATE/);
assert.match(sql,/FOR UPDATE/);
assert.match(sql,/payroll_attendance_approval_shifts/);
assert.match(sql,/ARRAY\['payroll_calculation_runs','payroll_daily_snapshots','payroll_milestone_day_snapshots','payroll_milestone_decision_snapshots'\]/);
const prior=fs.readFileSync(new URL('../migrations/086_payroll_margin_target.sql',import.meta.url),'utf8');
const pathPattern=source=>source.match(/parameter_path ~ '([^']+)'/)[1];
assert.equal(pathPattern(sql).replace('milestoneEligibility|',''),pathPattern(prior),'retain every previous personal parameter path');
assert.match(fs.readFileSync(new URL('../payroll-scheme-service.js',import.meta.url),'utf8'),/fail\('payroll_milestone_eligibility_schema_required', 409\)/);
assert.doesNotMatch(sql,/(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:orders|payments|payroll_entries|expenses)\b/i);
console.log('PAYROLL MILESTONE MIGRATION: STATIC PASS (runtime PostgreSQL acceptance required separately)');
