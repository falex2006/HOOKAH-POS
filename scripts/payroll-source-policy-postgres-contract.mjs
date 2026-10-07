import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const { makeService } = require('../payroll-scheme-service.js');
const { makePayrollCalculationRunService: makeRunService } = require('../payroll-calculation-run-service.js');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
const db = new Client({ connectionString: target.url.href });
const schema = `payroll_policy_qa_${process.pid}_${Date.now()}`;
assert.match(schema, /^payroll_policy_qa_\d+_\d+$/);
let created = false, pool;
const policy = { schemaVersion: 1, selectionReason: 'Владелец выбрал зачёт по автору строки',
  saleCredit: { kind: 'line_seller_snapshot' }, discountAllocation: { kind: 'immutable_line_snapshot' },
  refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment',
    paidAdjustment: 'owner_review_variable_pay_only', uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } };
const acknowledgement = { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' };
try {
  await db.connect();
  const identity = (await db.query('SELECT current_database() AS database,inet_server_addr() AS address,inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port));
  await db.query(`CREATE SCHEMA "${schema}"`); created = true;
  await db.query(`SET search_path TO "${schema}",public`);
  await db.query(readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  for (const name of readdirSync(path.join(root, 'migrations')).filter((name) => /^\d{3}.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 87).sort()) await db.query(readFileSync(path.join(root, 'migrations', name), 'utf8'));
  const venueId = (await db.query("INSERT INTO venues(name) VALUES('Source policy QA') RETURNING id")).rows[0].id;
  const ownerId = (await db.query("INSERT INTO users(venue_id,full_name,login,role) VALUES($1,'Policy owner',$2,'owner') RETURNING id", [venueId, `${schema}-owner`])).rows[0].id;
  const employeeId = (await db.query("INSERT INTO users(venue_id,full_name,login,role) VALUES($1,'Policy employee',$2,'bartender') RETURNING id", [venueId, `${schema}-staff`])).rows[0].id;
  const scoped = new URL(target.url); scoped.searchParams.set('options', `-c search_path=${schema},public`);
  pool = new Pool({ connectionString: scoped.href, max: 3 });
  const service = makeService(pool), principal = { venueId, userId: ownerId };
  const definition = { mode: 'stable_percent', currency: 'RUB', effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30',
    roleParameters: { bartender: { perShiftCents: 0, stableRateBps: 1000 } },
    roleAssignments: [{ employeeId, roleId: 'bartender', effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30' }], employeeOverrides: [], itemRules: [] };
  const legacy = await service.createScheme(principal, { name: 'Legacy without policy', definition, payoutRiskAcknowledgement: acknowledgement });
  const legacyVersion = legacy.versions[0];
  assert.equal(legacyVersion.sourcePolicies, undefined);
  const legacyEdited = await service.replaceDraftVersion(principal, legacyVersion.versionId, definition, acknowledgement);
  assert.equal(legacyEdited.payoutRiskAcknowledgement.configDigest, legacyVersion.payoutRiskAcknowledgement.configDigest, 'omitted policies do not alter old digests');
  const selected = await service.createScheme(principal, { name: 'Selected policy', definition: { ...definition, sourcePolicies: policy }, payoutRiskAcknowledgement: acknowledgement });
  const version = selected.versions[0];
  assert.deepEqual(version.sourcePolicies, policy);
  assert.notEqual(version.payoutRiskAcknowledgement.configDigest, legacyVersion.payoutRiskAcknowledgement.configDigest);
  const revisions = await service.listVersionRevisions(principal, version.versionId);
  assert.deepEqual(revisions[0].snapshot.sourcePolicies, policy);
  assert.equal(revisions[0].changedBy, ownerId);
  assert.ok(revisions[0].changedAt);
  await assert.rejects(service.replaceDraftVersion(principal, version.versionId, { ...definition, sourcePolicies: null }, acknowledgement), (error) => error.code === 'payroll_source_policies_invalid');
  await assert.rejects(service.replaceDraftVersion({ venueId, userId: employeeId }, version.versionId, { ...definition, sourcePolicies: policy }, acknowledgement), (error) => error.status === 403);
  const changedPolicy = structuredClone(policy); changedPolicy.saleCredit.kind = 'order_responsible_snapshot'; changedPolicy.selectionReason = 'Владелец выбрал зафиксированного ответственного';
  const changed = await service.replaceDraftVersion(principal, version.versionId, { ...definition, sourcePolicies: changedPolicy }, acknowledgement);
  assert.notEqual(changed.payoutRiskAcknowledgement.configDigest, version.payoutRiskAcknowledgement.configDigest);
  assert.deepEqual((await service.getVersion(principal, version.versionId)).sourcePolicies, changedPolicy);
  const scenario = { periodFrom: '2026-11-01', periodTo: '2026-11-01', employees: [{ id: employeeId }], attendance: [],
    coverage: { kind: 'month_to_date_complete', from: '2026-11-01', through: '2026-11-01', complete: true, watermark: 'scenario' },
    attendanceCoverage: { kind: 'approved_attendance_complete', from: '2026-11-01', through: '2026-11-01', complete: true, watermark: 'scenario' },
    sales: [{ id: 'scenario-sale', employeeId, department: 'bar', date: '2026-11-01', turnoverCents: 10000, commissionBaseCents: 10000 }] };
  const oldPreview = await service.preview(principal, legacyVersion.versionId, scenario), newPreview = await service.preview(principal, version.versionId, scenario);
  assert.equal(newPreview.result.employees[0].commissionCents, oldPreview.result.employees[0].commissionCents, 'selection does not execute attribution or change scenario mathematics');
  assert.equal(newPreview.result.sourcePolicyEvaluation.state, 'selected_not_applied');
  assert.equal(newPreview.result.sourcePolicyEvaluation.officialReady, false);
  assert.ok(newPreview.result.sourcePolicyEvaluation.requiredFacts.includes('explicit_immutable_order_payroll_responsible_identity'));
  assert.equal(oldPreview.result.sourcePolicyEvaluation, undefined);
  // A changed config with a stale acknowledgement cannot activate.
  const stored = (await db.query('SELECT config_json FROM payroll_scheme_versions WHERE id=$1', [version.versionId])).rows[0].config_json;
  const tampered = structuredClone(stored); tampered.sourcePolicies.saleCredit.kind = 'line_seller_snapshot';
  await db.query('UPDATE payroll_scheme_versions SET config_json=$1 WHERE id=$2', [tampered, version.versionId]);
  await assert.rejects(service.activateVersion(principal, version.versionId), (error) => error.status === 409);
  await db.query('UPDATE payroll_scheme_versions SET config_json=$1 WHERE id=$2', [stored, version.versionId]);
  await service.activateVersion(principal, version.versionId);
  await assert.rejects(service.replaceDraftVersion(principal, version.versionId, { ...definition, sourcePolicies: policy }, acknowledgement), (error) => error.code === 'payroll_scheme_version_immutable');
  const run = await makeRunService(pool).createBlockedRun(principal, { schemeVersionId: version.versionId, periodFrom: '2026-11-01', periodTo: '2026-11-01', idempotencyKey: 'source-policy-still-blocked' });
  assert.equal(run.status, 'blocked', 'configured policy does not attest sources');
  const sideEffects = (await db.query('SELECT (SELECT count(*)::int FROM payroll_entries) AS entries,(SELECT count(*)::int FROM expenses) AS expenses,(SELECT count(*)::int FROM payroll_daily_snapshots) AS snapshots')).rows[0];
  assert.deepEqual(sideEffects, { entries: 0, expenses: 0, snapshots: 0 });
  console.log('PAYROLL SOURCE POLICY POSTGRES CONTRACT: PASS (legacy digests, owner revision/reason, persistence, preview intent-only, stale activation and blocked official run)');
} finally {
  await pool?.end();
  if (created) { await db.query('SET search_path TO public'); await db.query(`DROP SCHEMA "${schema}" CASCADE`); assert.equal((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows.length, 0); }
  await db.end();
}
