import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Static migration regression only. The parent's disposable PostgreSQL suite
// exercises DDL replay, deferred transaction guards and actual source fixtures.
const read = name => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sql = read('207_payroll_unpaid_run_supersession.sql');
const old = read('205_payroll_calculation_entry_lifecycle.sql');
let checks = 0;
const has = (pattern, message) => { assert.match(sql, pattern, message); checks++; };
const absent = (pattern, message) => { assert.doesNotMatch(sql, pattern, message); checks++; };
has(/CREATE TABLE IF NOT EXISTS payroll_run_supersession_requests/);
for (const column of ['id', 'venue_id', 'original_run_id', 'replacement_run_id', 'idempotency_key', 'request_hash',
  'plan_hash', 'plan_payload', 'response_payload', 'response_sha256', 'created_by', 'created_by_name', 'reason', 'created_at']) {
  has(new RegExp(`^  ${column} `, 'm'), `${column} is persisted`);
}
for (const key of ['original_run_id', 'replacement_run_id', 'idempotency_key']) has(new RegExp(`UNIQUE\\(venue_id,${key}\\)`));
for (const key of ['original_run_id', 'replacement_run_id']) has(new RegExp(`FOREIGN KEY\\(venue_id,${key}\\) REFERENCES payroll_calculation_runs\\(venue_id,id\\) ON DELETE RESTRICT`));
has(/FOREIGN KEY\(venue_id,created_by\) REFERENCES users\(venue_id,id\) ON DELETE RESTRICT/);
has(/encode\(sha256\(convert_to\(plan_payload,'UTF8'\)\),'hex'\)=plan_hash/);
has(/encode\(sha256\(convert_to\(response_payload,'UTF8'\)\),'hex'\)=response_sha256/);
has(/BEFORE UPDATE OR DELETE ON payroll_run_supersession_requests/);
has(/BEFORE TRUNCATE ON payroll_run_supersession_requests/);
has(/payroll_supersession_history_immutable.*ERRCODE='55000'/);
has(/CREATE UNIQUE INDEX IF NOT EXISTS payroll_v2_single_replacement_uq[\s\S]*WHERE engine_version='payroll-verified-remaining-net-v2' AND supersedes_run_id IS NOT NULL/);
has(/NOT idx.indisunique OR NOT idx.indisvalid OR NOT idx.indisready/);
has(/payroll_supersession_branch_index_invalid/);
for (const column of ['scheme_version_id', 'period_from', 'period_to', 'venue_timezone', 'currency']) {
  has(new RegExp(`old_run\\.${column} IS DISTINCT FROM new_run\\.${column}`));
}
has(/old_run\.engine_version<>'payroll-verified-remaining-net-v2' OR new_run\.engine_version<>'payroll-verified-remaining-net-v2'/);
has(/new_run\.supersedes_run_id IS DISTINCT FROM old_run\.id/);
has(/role=''owner'' AND is_active=true AND deleted_at IS NULL FOR SHARE/);
has(/new_run\.created_by IS DISTINCT FROM j\.created_by/);
has(/new_run\.recalculation_reason IS DISTINCT FROM j\.reason/);
has(/old_proof\.schema_version<>2 OR new_proof\.schema_version<>2/);
has(/old_proof\.evidence_sha256 IS DISTINCT FROM old_run\.input_checksum/);
has(/new_proof\.evidence_sha256 IS DISTINCT FROM new_run\.input_checksum/);
has(/old_evidence->'schemeSnapshot' IS DISTINCT FROM new_evidence->'schemeSnapshot'/);
has(/plan->>'replacementInputWatermark' IS DISTINCT FROM new_run\.input_watermark/);
absent(/replacementSnapshotInputWatermark/, 'candidate UUID-dependent snapshot checksum cannot enter preview plan');
for (const suffix of ['cohort_invalid', 'cohort_changed', 'original_cohort_incomplete', 'amounts_changed',
  'original_not_unpaid_cancelled', 'original_entries_changed', 'cancellation_context_invalid',
  'cancellation_receipt_required', 'correction_release_required', 'replacement_not_draft',
  'replacement_cohort_incomplete', 'finance_category_changed', 'response_invalid', 'response_entries_invalid']) {
  has(new RegExp(`payroll_supersession_${suffix}`));
}
has(/t\.transaction_id<>txid_current\(\)/);
has(/t\.net_cents::numeric IS DISTINCT FROM \(p->>''amountCents''\)::numeric/);
has(/t\.ledger_hash::text IS DISTINCT FROM p->>''ledgerHash''/);
has(/NOT EXISTS\(SELECT 1 FROM %I\.payroll_correction_events r WHERE r\.venue_id=a\.venue_id AND r\.reverses_event_id=a\.id\)/);
has(/payroll_unpaid_supersession_commit AFTER INSERT ON payroll_run_supersession_requests\s+DEFERRABLE INITIALLY DEFERRED/);
has(/payroll_run_unpaid_supersession_commit AFTER INSERT ON payroll_calculation_runs\s+DEFERRABLE INITIALLY DEFERRED/);
has(/payroll_supersession_journal_required/);
has(/payroll_v2_money_transition_block BEFORE INSERT ON payroll_calculation_entry_transitions/);
has(/IF NEW.action IN \('approve','pay'\)/);
has(/IF is_v2 AND NEW.status IN \('approved','paid'\)/);
has(/IF replaced THEN RAISE EXCEPTION 'payroll_supersession_original_replaced'/);
absent(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:expenses|finance_accounts|finance_transactions)\b/i);

// Recover the entire 205 guard by removing just the new capability dispatch.
// This protects every legacy cancellation, immutable-history and money branch.
const marker = 'CREATE OR REPLACE FUNCTION payroll_validate_calculation_entry() RETURNS trigger LANGUAGE plpgsql AS $$';
let restored = sql.slice(sql.indexOf(marker)).trim();
restored = restored.replace('next_action text; is_v2 boolean; replaced boolean;', 'next_action text;');
restored = restored.replace(/  -- New v2 runs support only draft materialization and cancellation\.[\s\S]*?(?=  IF NEW.status IN \('draft','approved','paid'\))/, '');
restored = restored.replace('p.evidence_payload,p.evidence_sha256,p.schema_version AS provenance_schema_version,p.capability_version AS provenance_capability_version FROM', 'p.evidence_payload,p.evidence_sha256 FROM');
restored = restored.replace(/NOT \(\(r\.engine_version='payroll-verified-no-refund-v1' AND r\.provenance_schema_version=1 AND r\.provenance_capability_version='employee_attributed_merchandise_net_no_refund_v1'\)\s+OR \(r\.engine_version='payroll-verified-remaining-net-v2' AND r\.provenance_schema_version=2 AND r\.provenance_capability_version='employee_attributed_remaining_net_refund_v2'\)\)/,
  "r.engine_version<>'payroll-verified-no-refund-v1'");
assert.equal(restored, old.slice(old.indexOf(marker)).trim(), 'complete legacy guard is preserved'); checks++;
assert.equal((sql.match(/CREATE OR REPLACE FUNCTION payroll_validate_calculation_entry/g) || []).length, 1); checks++;
assert.equal((sql.match(/\$\$/g) || []).length % 2, 0, 'balanced SQL dollar quoting'); checks++;
console.log(`PASS payroll unpaid run supersession migration contract: ${checks} assertions (static; no PostgreSQL)`);
