import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const require = createRequire(import.meta.url), { Client } = require('pg');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
assert.match(target.database, /^orders_qa_[a-f0-9]{16}$/);
assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
const db = new Client({ connectionString: target.url.href });
const venue = randomUUID(), run = randomUUID(), version = randomUUID(), user = randomUUID(), org = randomUUID(), scheme = randomUUID();
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const sql = await readFile(new URL('../migrations/194_payroll_run_provenance.sql', import.meta.url), 'utf8');
const payloadFor = (overrides = {}) => ({ schemaVersion: 1, capabilityVersion: 'employee_attributed_merchandise_net_no_refund_v1',
  venueId: venue, runId: run, schemeVersionId: version, period: { from: '2026-10-01', to: '2026-10-31' }, currency: 'RUB',
  venueTimezone: 'UTC', inputWatermark: 'a'.repeat(64), closureWatermark: 'b'.repeat(64), calculationWatermark: 'c'.repeat(64),
  snapshotInputWatermark: 'd'.repeat(64), schemeSnapshot: { versionId: version, currency: 'RUB' }, periodClosure: { schemaVersion: 1, venueId: venue,
    period: { from: '2026-10-01', to: '2026-10-31' }, transactionTimestamp: '2026-11-01T00:01:00Z', venueLocalDate: '2026-11-01', timezone: 'UTC' },
  sourceEvidence: {}, totalAmountCents: 0, ...overrides });
const insertRun = async ({ id = run, engine = 'payroll-verified-no-refund-v1', status = 'ready', checksum = 'a'.repeat(64), watermark = 'a'.repeat(64) } = {}) =>
  db.query(`INSERT INTO payroll_calculation_runs (id,venue_id,scheme_version_id,period_from,period_to,status,source_coverage,
    commission_basis,eligible_line_count,unattributed_line_count,missing_net_line_count,input_watermark,input_checksum,engine_version,
    blocked_reason,idempotency_key,created_by,created_by_name,venue_timezone,currency,milestone_evidence_version)
    VALUES($1,$2,$3,'2026-10-01','2026-10-31',$4,'complete','net_after_discounts_refunds',0,0,0,$5,$6,$7,
    CASE WHEN $4='blocked' THEN 'fixture blocked' ELSE NULL END,$9,$8,'QA owner','UTC','RUB',0)`,
    [id, venue, version, status, watermark, checksum, engine, user, `provenance-${id}`]);
const insertSidecar = async (body = payloadFor(), { id = run, total = 0, hash = null } = {}) => {
  const text = JSON.stringify(body), digest = hash || sha(text);
  await db.query(`INSERT INTO payroll_run_provenance VALUES($1,$2,1,'employee_attributed_merchandise_net_no_refund_v1',$3,$4,$5)`,
    [venue, id, text, digest, total]);
};
const expectCommitFailure = async (action, code = '23514', messagePart = null) => {
  await db.query('BEGIN');
  try { await assert.rejects(async () => { await action(); await db.query('COMMIT'); }, error => error.code === code
    && (!messagePart || String(error.message).includes(messagePart))); }
  finally { await db.query('ROLLBACK').catch(() => {}); }
};
try {
  await db.connect();
  assertQaDatabaseIdentity((await db.query('SELECT current_database() database,inet_server_addr() address,inet_server_port() port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser')).rows[0], target.database, Number(target.url.port), 'Payroll provenance QA');
  await db.query(sql); await db.query(sql);
  await db.query(`INSERT INTO organizations(id,name,slug,timezone) VALUES($1,'Payroll provenance QA',$2,'UTC')`, [org, `payroll-prov-${process.pid}`]);
  await db.query(`INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,'Payroll provenance QA','UTC')`, [venue, org]);
  await db.query(`INSERT INTO users(id,organization_id,venue_id,full_name,login,role) VALUES($1,$2,$3,'QA owner',$4,'owner')`, [user, org, venue, `payroll-prov-${process.pid}`]);
  await db.query(`INSERT INTO payroll_schemes(id,venue_id,name,created_by,created_by_name) VALUES($1,$2,'QA',$3,'QA owner')`, [scheme, venue, user]);
  await db.query(`INSERT INTO payroll_scheme_versions(id,venue_id,scheme_id,version_no,mode,currency,effective_from,effective_to,created_by,created_by_name)
    VALUES($1,$2,$3,1,'stable_percent','RUB','2026-10-01','2026-10-31',$4,'QA owner')`, [version, venue, scheme, user]);
  await db.query("UPDATE payroll_scheme_versions SET status='active',status_changed_by=$1,status_changed_by_name='QA owner',status_changed_at=now() WHERE venue_id=$2 AND id=$3", [user, venue, version]);
  await expectCommitFailure(() => insertRun(), '23514', 'verified payroll run requires provenance');
  const validText = JSON.stringify(payloadFor()), validHash = sha(validText);
  await db.query('BEGIN'); await insertRun({ checksum: validHash }); await insertSidecar(payloadFor({ totalAmountCents: 0 })); await db.query('COMMIT');
  assert.equal((await db.query('SELECT count(*)::int n FROM payroll_run_provenance WHERE venue_id=$1', [venue])).rows[0].n, 1);

  const cases = [
    ['payload hash mismatch', async () => { const id = randomUUID(); await insertRun({ id, checksum: 'e'.repeat(64) }); await insertSidecar(payloadFor({ runId: id }), { id, hash: 'e'.repeat(64) }); }],
    ['tenant mismatch', async () => { const id = randomUUID(), body = payloadFor({ venueId: randomUUID(), runId: id }), hash = sha(JSON.stringify(body)); await insertRun({ id, checksum: hash }); await insertSidecar(body, { id }); }],
    ['period mismatch', async () => { const id = randomUUID(), body = payloadFor({ runId: id, period: { from: '2026-10-02', to: '2026-10-31' } }), hash = sha(JSON.stringify(body)); await insertRun({ id, checksum: hash }); await insertSidecar(body, { id }); }],
    ['missing period start', async () => { const id = randomUUID(), body = payloadFor({ runId: id, period: { to: '2026-10-31' } }), hash = sha(JSON.stringify(body)); await insertRun({ id, checksum: hash }); await insertSidecar(body, { id }); }],
    ['missing watermark', async () => { const id = randomUUID(), body = payloadFor({ runId: id, inputWatermark: undefined }), hash = sha(JSON.stringify(body)); await insertRun({ id, checksum: hash }); await insertSidecar(body, { id }); }],
    ['closure tenant mismatch', async () => { const id = randomUUID(), body = payloadFor({ runId: id, periodClosure: { ...payloadFor().periodClosure, venueId: randomUUID() } }), hash = sha(JSON.stringify(body)); await insertRun({ id, checksum: hash }); await insertSidecar(body, { id }); }],
    ['closure mismatch', async () => { const id = randomUUID(), body = payloadFor({ runId: id, periodClosure: { ...payloadFor().periodClosure,
      transactionTimestamp: '2026-10-31T23:00:00Z', venueLocalDate: '2026-10-31' } }), hash = sha(JSON.stringify(body)); await insertRun({ id, checksum: hash }); await insertSidecar(body, { id }); }],
    ['total mismatch', async () => { const id = randomUUID(), body = payloadFor({ runId: id, totalAmountCents: 999 }), hash = sha(JSON.stringify(body)); await insertRun({ id, checksum: hash }); await insertSidecar(body, { id, total: 999 }); }]
  ];
  for (const [label, action] of cases) await expectCommitFailure(action, '23514', label === 'closure mismatch'
    ? 'payroll provenance does not match verified ready run' : label === 'total mismatch' ? 'payroll provenance total mismatch' : null);
  const nonzeroId = randomUUID();
  const nonzeroBody = payloadFor({ runId: nonzeroId, totalAmountCents: 1234,
    periodClosure: { ...payloadFor().periodClosure, transactionTimestamp: '2026-11-01 00:01:00.123456+00' } });
  await db.query('BEGIN');
  await insertRun({ id: nonzeroId, checksum: sha(JSON.stringify(nonzeroBody)) });
  await insertSidecar(nonzeroBody, { id: nonzeroId, total: 1234 });
  await db.query(`INSERT INTO payroll_daily_snapshots
    (venue_id,run_id,employee_id,employee_name_snapshot,role_key_snapshot,local_date,base_pay,amount_before_cap,final_amount)
    VALUES($1,$2,$3,'QA owner','bar','2026-10-01',12.34,12.34,12.34)`, [venue, nonzeroId, user]);
  await db.query('COMMIT');
  assert.equal((await db.query('SELECT total_amount_cents::text AS total FROM payroll_run_provenance WHERE run_id=$1',
    [nonzeroId])).rows[0].total, '1234', 'nonzero daily totals and native PostgreSQL timestamp offset survive commit');
  await expectCommitFailure(() => db.query(`INSERT INTO payroll_daily_snapshots
    (venue_id,run_id,employee_id,employee_name_snapshot,role_key_snapshot,local_date,base_pay,amount_before_cap,final_amount)
    VALUES($1,$2,$3,'QA owner','bar','2026-10-02',1,1,1)`, [venue, nonzeroId, user]),
    '23514', 'payroll provenance total mismatch');
  await assert.rejects(() => db.query('UPDATE payroll_run_provenance SET evidence_payload=evidence_payload WHERE run_id=$1', [run]), error => error.code === '55000');
  await assert.rejects(() => db.query('DELETE FROM payroll_run_provenance WHERE run_id=$1', [run]), error => error.code === '55000');
  await assert.rejects(() => db.query('TRUNCATE payroll_run_provenance'), error => error.code === '55000');

  const oldRun = randomUUID(); await db.query('BEGIN'); await insertRun({ id: oldRun, engine: 'synthetic-qa', checksum: 'f'.repeat(64), watermark: 'old', status: 'ready' }); await db.query('COMMIT');
  const blockedRun = randomUUID(); await db.query('BEGIN'); await insertRun({ id: blockedRun, engine: 'payroll-verified-no-refund-v1', checksum: null, watermark: 'old', status: 'blocked' }); await db.query('COMMIT');
  assert.equal((await db.query('SELECT count(*)::int n FROM payroll_run_provenance WHERE venue_id=$1', [venue])).rows[0].n, 2, 'old and blocked runs need no provenance');
  console.log('PASS payroll-run-provenance-postgres-qa: deferred requirement, valid sidecar, integrity rejection, immutability, legacy and blocked compatibility, replay');
} finally { await db.query('ROLLBACK').catch(() => {}); await db.end(); }
