import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const migrationDir = path.join(root, 'migrations');
const files = fs.readdirSync(migrationDir).filter((file) => file.endsWith('.sql')).sort();
assert.ok(files.length > 0, 'migration directory must contain SQL migrations');

for (const file of files) {
  const source = fs.readFileSync(path.join(migrationDir, file), 'utf8');
  // CREATE TABLE and CREATE INDEX statements are expected to be replay-safe.
  for (const match of source.matchAll(/^\s*CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?!IF\s+NOT\s+EXISTS\b)/gim)) {
    assert.fail(`${file}: ${match[0].trim()} must use IF NOT EXISTS`);
  }
  assert.doesNotMatch(source, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/gim,
    `${file}: transaction boundaries belong to the migration runner, not an individual migration`);
}

const expenses = fs.readFileSync(path.join(migrationDir, '022_expenses.sql'), 'utf8');
const capacity = fs.readFileSync(path.join(migrationDir, '024_table_capacity_range.sql'), 'utf8');
const shifts = fs.readFileSync(path.join(migrationDir, '041_single_open_shift.sql'), 'utf8');
const stockPrecision = fs.readFileSync(path.join(migrationDir, '055_stock_movement_precision.sql'), 'utf8');
const premixLifecycle = fs.readFileSync(path.join(migrationDir, '056_premix_batch_lifecycle.sql'), 'utf8');
const shiftCloseSnapshots = fs.readFileSync(path.join(migrationDir, '093_shift_close_snapshots.sql'), 'utf8');
const otherIncomeReversals = fs.readFileSync(path.join(migrationDir, '107_finance_other_income_reversals.sql'), 'utf8');
const financeAccounts = fs.readFileSync(path.join(migrationDir, '112_finance_accounts_and_payable_payment_sources.sql'), 'utf8');
const otherIncomeAccounts = fs.readFileSync(path.join(migrationDir, '113_finance_other_income_account_sources.sql'), 'utf8');
const posTenderAccounts = fs.readFileSync(path.join(migrationDir, '114_pos_tender_finance_accounts.sql'), 'utf8');
const financeIncomeIntegrity = fs.readFileSync(path.join(migrationDir, '115_finance_pos_income_snapshot_integrity.sql'), 'utf8');
const financeExpenseDrafts = fs.readFileSync(path.join(migrationDir, '116_finance_expense_drafts.sql'), 'utf8');
const financeCreateIdempotency = fs.readFileSync(path.join(migrationDir, '119_finance_create_idempotency.sql'), 'utf8');
const financeExpenseCorrections = fs.readFileSync(path.join(migrationDir, '120_finance_expense_corrections.sql'), 'utf8');
const financePayableVariableConfirmation = fs.readFileSync(path.join(migrationDir, '121_finance_payable_variable_confirmation_ambiguity.sql'), 'utf8');
const financeExpenseCorrectionCategoryRefs = fs.readFileSync(path.join(migrationDir, '122_finance_expense_correction_category_refs.sql'), 'utf8');
const recurringVersionPreviewIdempotency = fs.readFileSync(path.join(migrationDir, '123_finance_recurring_version_preview_idempotency.sql'), 'utf8');
const recurringGenerationIdempotency = fs.readFileSync(path.join(migrationDir, '124_finance_recurring_generation_idempotency.sql'), 'utf8');
const financeExpenseRefunds = fs.readFileSync(path.join(migrationDir, '125_finance_manual_expense_refunds.sql'), 'utf8');
const financeUnifiedReportSnapshots = fs.readFileSync(path.join(migrationDir, '126_finance_unified_report_snapshots.sql'), 'utf8');
const financeFundingEvents = fs.readFileSync(path.join(migrationDir, '127_finance_funding_events.sql'), 'utf8');
const payableRefunds = fs.readFileSync(path.join(migrationDir, '130_finance_payable_payment_refunds.sql'), 'utf8');
const recurringPartialMonth = fs.readFileSync(path.join(migrationDir, '129_finance_recurring_partial_month.sql'), 'utf8');
const financeTransfersOpeningBalances = fs.readFileSync(path.join(migrationDir, '128_finance_transfers_opening_balances.sql'), 'utf8');
assert.match(expenses, /DO\s+\$\$[\s\S]*payroll_entries_expense_fk[\s\S]*END\s*\$\$;/, 'expense FK must be guarded');
assert.match(capacity, /DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+tables_capacity_range_check[\s\S]*DO\s+\$\$[\s\S]*tables_capacity_range_check[\s\S]*END\s*\$\$;/, 'capacity constraint must be replay-safe');
assert.doesNotMatch(expenses, /^ALTER\s+TABLE\s+payroll_entries\s+ADD\s+CONSTRAINT/m, 'expense FK must not be added unconditionally');
assert.doesNotMatch(capacity, /^ALTER\s+TABLE\s+tables\s+ADD\s+CONSTRAINT/m, 'capacity constraint must not be added unconditionally');
assert.match(shifts, /HAVING COUNT\(\*\) > 1[\s\S]*RAISE EXCEPTION[\s\S]*CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open_per_venue_idx/, 'single-open-shift migration must fail safely on duplicate data and enforce the venue invariant');
for (const [table, column] of [
  ['stock_movements', 'quantity'],
  ['recipe_items', 'quantity'],
  ['ingredients', 'pack_multiplier'],
  ['ingredients', 'min_stock'],
  ['inventory_premix_batches', 'output_quantity'],
  ['inventory_purchase_document_lines', 'pack_multiplier'],
  ['inventory_purchase_document_lines', 'stock_quantity'],
]) {
  assert.match(stockPrecision, new RegExp(`ALTER TABLE ${table}\\s+[\\s\\S]*?ALTER COLUMN ${column} TYPE numeric\\(15,6\\)`),
    `${table}.${column} keeps six decimal places and the prior integer range`);
}
assert.match(stockPrecision, /ALTER TABLE inventory_purchase_document_lines\s+[\s\S]*?ALTER COLUMN quantity TYPE numeric\(17,6\)/,
  'purchase line quantity gains six decimal places without reducing its prior integer range');
assert.match(premixLifecycle, /UPDATE inventory_premix_batches[\s\S]*planned_output_quantity=output_quantity/,
  'legacy batches receive a compatible planned-output snapshot');
assert.match(premixLifecycle, /inventory_premix_batch_movements[\s\S]*quantity_delta numeric\(15,6\)/,
  'per-lot stock allocations use append-only precise quantities');
assert.match(premixLifecycle, /BEFORE UPDATE OR DELETE ON inventory_premix_batch_movements/,
  'lot movement history cannot be rewritten or deleted');
assert.match(shiftCloseSnapshots, /UNIQUE\s*\(venue_id,shift_id\)/, 'each shift has at most one close snapshot');
assert.match(shiftCloseSnapshots, /FOREIGN KEY\s*\(venue_id,shift_id\)\s*REFERENCES shifts\(venue_id,id\) ON DELETE RESTRICT/, 'snapshot is scoped to and retained with its venue shift');
assert.match(shiftCloseSnapshots, /BEFORE UPDATE OR DELETE ON shift_close_snapshots/, 'close snapshots are immutable');
assert.match(otherIncomeReversals, /finance_other_income_correction_exceeds_recognition/, 'other-income corrections are capped at original recognition');
assert.match(otherIncomeReversals, /finance_other_income_refund_exceeds_receipt/, 'other-income refunds are capped at the source receipt');
assert.match(otherIncomeReversals, /FOREIGN KEY \(venue_id,receipt_id\) REFERENCES finance_other_income_receipts\(venue_id,id\)/, 'refunds remain tenant-linked to an original cash receipt');
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
const normalizedSchema = schema.replaceAll(String.fromCharCode(13), '');
let previousFinancePrerequisiteEnd = -1;
for (const file of [
  '021_staff_time_payroll.sql',
  '022_expenses.sql',
  '038_inventory_purchase_documents.sql',
  '039_shift_kpi_attribution.sql',
  '042_purchase_payment_link.sql',
  '044_finance_categories.sql',
]) {
  const migration = fs.readFileSync(path.join(migrationDir, file), 'utf8').replaceAll(String.fromCharCode(13), '').trimEnd();
  const migrationStart = normalizedSchema.indexOf(migration);
  assert.notEqual(migrationStart, -1, `fresh-install schema mirrors finance prerequisite ${file} verbatim`);
  assert.equal(normalizedSchema.lastIndexOf(migration), migrationStart, `fresh-install schema includes prerequisite ${file} exactly once`);
  assert.ok(migrationStart > previousFinancePrerequisiteEnd, `fresh-install schema preserves prerequisite order at ${file}`);
  if (previousFinancePrerequisiteEnd >= 0) {
    assert.match(normalizedSchema.slice(previousFinancePrerequisiteEnd, migrationStart), /^\s*$/, `fresh-install schema keeps prerequisites contiguous before ${file}`);
  }
  previousFinancePrerequisiteEnd = migrationStart + migration.length;
}
let previousFinanceMigrationEnd = -1;
for (let version = 103; version <= 116; version += 1) {
  const prefix = String(version).padStart(3, '0');
  const file = files.find((name) => name.startsWith(`${prefix}_`));
  assert.ok(file, `finance migration ${prefix} exists`);
  const migration = fs.readFileSync(path.join(migrationDir, file), 'utf8').replaceAll(String.fromCharCode(13), '').trimEnd();
  const migrationStart = normalizedSchema.indexOf(migration);
  assert.notEqual(migrationStart, -1, `fresh-install schema mirrors ${file} verbatim`);
  assert.equal(normalizedSchema.lastIndexOf(migration), migrationStart, `fresh-install schema includes ${file} exactly once`);
  assert.ok(migrationStart > previousFinanceMigrationEnd, `fresh-install schema preserves finance migration order at ${file}`);
  if (previousFinanceMigrationEnd >= 0) {
    const separator = normalizedSchema.slice(previousFinanceMigrationEnd, migrationStart);
    assert.match(separator, /^\s*$/, `fresh-install schema keeps finance migrations contiguous before ${file}`);
  }
  previousFinanceMigrationEnd = migrationStart + migration.length;
}
const firstFinanceMigration = fs.readFileSync(path.join(migrationDir, '103_finance_payables.sql'), 'utf8').replaceAll(String.fromCharCode(13), '').trimEnd();
assert.match(normalizedSchema.slice(previousFinancePrerequisiteEnd, normalizedSchema.indexOf(firstFinanceMigration)), /^\s*$/, 'finance prerequisites immediately precede finance migrations');
assert.match(schema, /CREATE TABLE IF NOT EXISTS shift_close_snapshots[\s\S]*?BEFORE UPDATE OR DELETE ON shift_close_snapshots/, 'base schema includes the same immutable close snapshot contract');
assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS users_venue_id_id_uq ON users\s*\(venue_id,\s*id\)/, 'fresh-install schema supports venue-scoped user foreign keys');
assert.match(financeAccounts,/CREATE TABLE IF NOT EXISTS finance_accounts[\s\S]*?UNIQUE \(venue_id,id\)[\s\S]*?allowed_payment_methods/, 'accounts are venue-scoped and carry explicit payment rails');
assert.match(financeAccounts,/venues_seed_finance_accounts[\s\S]*?ensure_finance_account_defaults/, 'existing and new venues receive the default cashbox');
assert.match(financeAccounts,/FOREIGN KEY \(venue_id,finance_account_id\) REFERENCES finance_accounts\(venue_id,id\)/, 'expense account reference is tenant-scoped');
assert.match(financeAccounts,/FOREIGN KEY \(venue_id,shift_id\) REFERENCES shifts\(venue_id,id\)/, 'expense shift reference is tenant-scoped');
assert.match(financeAccounts,/CHECK \(\(finance_account_id IS NULL AND finance_account_name_snapshot IS NULL\)[\s\S]*?finance_account_name_snapshot\)\) BETWEEN 1 AND 120/, 'account identity has a historical snapshot');
assert.match(financeAccounts,/finance_account_event_immutable[\s\S]*?finance_pos_cash_shift_required/, 'expense source assignments are immutable before nullable legacy handling');
assert.doesNotMatch(financeAccounts,/UPDATE expenses[\s\S]*?finance_account_id\s*=.*?payment_method/, 'legacy account/shift attribution is never inferred from payment method');
assert.ok(normalizedSchema.includes(financeAccounts.replaceAll(String.fromCharCode(13), '')), 'base schema includes the existing finance account migration verbatim');
assert.match(otherIncomeAccounts,/finance_other_income_receipts[\s\S]*?finance_account_id uuid[\s\S]*?finance_other_income_refunds[\s\S]*?finance_account_id uuid/,'other-income receipt and refund cash facts retain explicit source accounts');
assert.match(otherIncomeAccounts,/allowed_payment_methods <@ ARRAY\['cash','card','qr','bank_transfer','other'\][\s\S]*?kind='electronic'[\s\S]*?ARRAY\['card','qr','other'\]/,'QR is preserved on electronic accounts while cashbox rails stay explicit');
assert.doesNotMatch(otherIncomeAccounts,/UPDATE finance_other_income_(?:receipts|refunds)[\s\S]*finance_account_id\s*=/,'legacy cash sources are never backfilled by guess');
assert.ok(schema.replaceAll(String.fromCharCode(13), '').includes(otherIncomeAccounts.replaceAll(String.fromCharCode(13), '').trimEnd()), 'base schema retains the finance other-income account migration verbatim');
assert.match(posTenderAccounts,/guard_pos_payment_finance_account/);
assert.match(posTenderAccounts,/guard_pos_refund_tender_finance_account/);
assert.match(posTenderAccounts,/finance_account_used_cannot_be_reactivated/);
assert.match(posTenderAccounts,/OLD\.shift_id IS DISTINCT FROM NEW\.shift_id/,'payment shift attribution cannot be rewritten');
assert.match(posTenderAccounts,/UPDATE OF order_id,method,finance_account_id,finance_account_name_snapshot,shift_id/,'shift edits invoke the payment account guard');
assert.ok(normalizedSchema.includes(financeExpenseCorrections.replaceAll(String.fromCharCode(13), '').trimEnd()), 'base schema mirrors the finance expense-correction migration verbatim');
assert.ok(normalizedSchema.includes(financePayableVariableConfirmation.replaceAll(String.fromCharCode(13), '').trimEnd()), 'base schema mirrors the variable-payable confirmation migration verbatim');
assert.match(financePayableVariableConfirmation,/bool_or\(v\.variable_amount\)[\s\S]*?INTO is_variable_amount[\s\S]*?IF is_variable_amount/,'payable posting trigger avoids ambiguity between its local variable and the table column');
assert.ok(normalizedSchema.includes(recurringVersionPreviewIdempotency.replaceAll(String.fromCharCode(13), '').trimEnd()), 'base schema mirrors preview-bound rate-version idempotency migration verbatim');
assert.match(recurringGenerationIdempotency,/recurring_payable_generation[\s\S]*finance_payables WHERE venue_id=NEW\.venue_id AND id=NEW\.entity_id/,'generation idempotency is limited to payable entities in the same venue');
assert.ok(normalizedSchema.includes(recurringGenerationIdempotency.replaceAll(String.fromCharCode(13), '').trimEnd()), 'base schema retains the recurring-generation idempotency migration verbatim');
assert.ok(normalizedSchema.includes(financeExpenseRefunds.replaceAll(String.fromCharCode(13), '').trimEnd()), 'base schema retains the manual expense refund migration verbatim');
assert.match(financeExpenseRefunds,/finance_expense_refunds_append_only[\s\S]*finance_expense_refund_exceeds_balance[\s\S]*finance_account_snapshot_mismatch/,'refund journal is append-only, capped at the original cash outflow, and protects the account name snapshot');
assert.match(financeExpenseCorrectionCategoryRefs,/before_category_id uuid GENERATED ALWAYS[\s\S]*?after_category_id uuid GENERATED ALWAYS[\s\S]*?FOREIGN KEY \(venue_id,before_category_id\)[\s\S]*?FOREIGN KEY \(venue_id,after_category_id\)/,'correction snapshots expose tenant-scoped stored category references');
assert.match(financeExpenseCorrectionCategoryRefs,/finance_expense_correction_category_legacy_invalid[\s\S]*?kind IS DISTINCT FROM 'expense'/,'existing correction history fails closed when its referenced category is missing or not an expense');
assert.match(financeExpenseCorrectionCategoryRefs,/validate_finance_expense_correction_categories[\s\S]*?finance_expense_correction_category_invalid/,'new correction category references are checked against tenant and expense direction');
assert.match(financeExpenseCorrectionCategoryRefs,/finance_expense_corrections c[\s\S]*?before_category_id=OLD\.id OR c\.after_category_id=OLD\.id[\s\S]*?finance_category_source_kind_immutable/,'correction history protects both old and new categories from direction changes');
assert.match(financeIncomeIntegrity, /BEFORE INSERT OR UPDATE OR DELETE ON pos_order_income_category_snapshots/);
assert.match(financeIncomeIntegrity, /DEFERRABLE INITIALLY DEFERRED[\s\S]*validate_pos_order_income_category_snapshot_at_commit/);
assert.match(financeIncomeIntegrity, /pos_order_income_category_item_allocation_mismatch/);
assert.match(financeIncomeIntegrity, /pos_order_income_category_adjustment_mismatch/);
assert.match(financeIncomeIntegrity, /finance_income_mapping_requires_active_income_category/);
assert.match(financeIncomeIntegrity, /finance_income_mapping_category_name_mismatch/);
assert.match(financeIncomeIntegrity, /pos_order_income_category_snapshot_requires_active_income_category/);
assert.match(financeIncomeIntegrity, /finance_pos_income_snapshot_legacy_building_rows_require_repair/);
assert.match(financeIncomeIntegrity, /LOCK TABLE pos_order_income_category_snapshots IN ACCESS EXCLUSIVE MODE[\s\S]*?finance_pos_income_snapshot_legacy_building_rows_require_repair/,
  'legacy snapshot preflight is serialized against concurrent writes');
assert.match(financeIncomeIntegrity, /finance_income_category_mappings[\s\S]*?category_id=OLD\.id/,
  'POS income mappings preserve category direction');
assert.match(financeIncomeIntegrity, /venue_timezone_snapshot[\s\S]*?snapshot_date_mismatch/,
  'income recognition date is checked against the close timestamp and frozen venue timezone');
assert.match(financeIncomeIntegrity, /JOIN finance_categories c[\s\S]*?c\.kind='income'/,
  'sealed mapped allocations retain an income-kind category');
assert.match(financeExpenseDrafts,/CREATE TABLE IF NOT EXISTS finance_expense_drafts[\s\S]*?version integer[\s\S]*?create_idempotency_key/,'manual expense drafts persist with optimistic versions and idempotent creation');
assert.match(financeExpenseDrafts,/FOREIGN KEY \(venue_id,category_id\) REFERENCES finance_categories\(venue_id,id\)/,'expense draft categories remain tenant-scoped');
assert.match(financeExpenseDrafts,/BEFORE UPDATE OR DELETE ON finance_expense_drafts/,'posted and cancelled expense drafts cannot be rewritten');
assert.match(financeExpenseDrafts,/posted_expense_draft_source_guard[\s\S]*?BEFORE UPDATE OR DELETE ON expenses/,'posted draft source expenses are immutable');
assert.match(financeExpenseDrafts,/finance_payables p[\s\S]*?finance_recurring_rules r[\s\S]*?finance_expense_drafts d/,'category direction is protected after payable, recurring, and draft references');
assert.match(financeCreateIdempotency,/request_sha256[\s\S]*?entity_id uuid[\s\S]*?response jsonb[\s\S]*?UNIQUE \(venue_id,operation,idempotency_key\)/,'manual payable and recurring-rule create retries are tenant scoped and retain original responses');
assert.match(financeCreateIdempotency,/finance_create_idempotency_immutable[\s\S]*?finance_create_idempotency_entity_invalid[\s\S]*?BEFORE INSERT OR UPDATE OR DELETE ON finance_create_idempotency/,'create-idempotency claims are immutable and reference an entity in the same venue');
assert.match(financeExpenseCorrections,/sequence integer NOT NULL[\s\S]*?expected_version integer NOT NULL[\s\S]*?before_snapshot jsonb NOT NULL[\s\S]*?after_snapshot jsonb NOT NULL[\s\S]*?amount_delta numeric\(14,2\)[\s\S]*?idempotency_key text NOT NULL[\s\S]*?response_json jsonb NOT NULL[\s\S]*?created_by uuid NOT NULL[\s\S]*?created_at timestamptz NOT NULL/,'expense corrections preserve ordered snapshots, signed delta, idempotency, exact replay response, actor, and time');
assert.match(financeExpenseCorrections,/UNIQUE \(venue_id,expense_id,sequence\)[\s\S]*?UNIQUE \(venue_id,idempotency_key\)[\s\S]*?FOREIGN KEY \(venue_id,expense_id\) REFERENCES expenses\(venue_id,id\)[\s\S]*?FOREIGN KEY \(venue_id,created_by\) REFERENCES users\(venue_id,id\)/,'expense corrections enforce tenant-scoped source, actor, sequence, and idempotency identity');
assert.match(financeExpenseCorrections,/source_expense\.source NOT IN \('manual','other'\)[\s\S]*?purchase_document_id IS NOT NULL[\s\S]*?finance_payable_payment_links[\s\S]*?payroll_entries/,'corrections reject ineligible expenses and expenses already owned by purchase, payable, or payroll subledgers');
assert.match(financeExpenseCorrections,/FOR UPDATE[\s\S]*?MAX\(sequence\)[\s\S]*?expected_version<>current_version[\s\S]*?finance_expense_correction_version_conflict/,'correction sequence uses a source expense lock and rejects stale expected versions');
assert.match(financeExpenseCorrections,/TG_OP<>'INSERT'[\s\S]*?finance_expense_corrections_append_only[\s\S]*?BEFORE INSERT OR UPDATE OR DELETE ON finance_expense_corrections/,'correction events cannot be updated or deleted');
assert.match(recurringVersionPreviewIdempotency,/recurring_rule_version_create[\s\S]*?finance_recurring_rule_versions WHERE venue_id=NEW\.venue_id AND id=NEW\.entity_id/,'rate-version idempotency is restricted to a same-venue immutable version entity');
assert.ok(normalizedSchema.includes(recurringVersionPreviewIdempotency.replaceAll(String.fromCharCode(13), '').trimEnd()),'fresh-install schema mirrors preview-bound rate-version idempotency migration');
assert.ok(normalizedSchema.includes(financeFundingEvents.replaceAll(String.fromCharCode(13), '').trimEnd()),'fresh-install schema mirrors the funding-events migration verbatim');
assert.ok(normalizedSchema.includes(financeFundingEvents.replaceAll(String.fromCharCode(13), '').trimEnd()),'fresh-install schema retains the funding-events migration');
assert.ok(normalizedSchema.includes(financeTransfersOpeningBalances.replaceAll(String.fromCharCode(13), '').trimEnd()),'fresh-install schema retains transfers/opening-balances migration');
assert.ok(normalizedSchema.includes(recurringPartialMonth.replaceAll(String.fromCharCode(13), '').trimEnd()),'fresh-install schema includes the partial-month migration');
assert.ok(normalizedSchema.includes(payableRefunds.replaceAll(String.fromCharCode(13), '').trimEnd()),'fresh-install schema retains payable refunds migration');
assert.ok(normalizedSchema.trimEnd().endsWith(fs.readFileSync(path.join(migrationDir, '131_finance_payable_offsets.sql'), 'utf8').replaceAll(String.fromCharCode(13), '').trimEnd()),'fresh-install schema ends with payable offsets migration');
assert.match(financeTransfersOpeningBalances,/finance_account_transfer_legs[\s\S]*?UNIQUE \(venue_id,transfer_id,leg_type\)[\s\S]*?finance_account_transfers_create_legs[\s\S]*?AFTER INSERT ON finance_account_transfers/,'one immutable transfer creates a unique debit/credit pair inside its transaction');
assert.match(financeTransfersOpeningBalances,/guard_finance_account_transfer_leg[\s\S]*?finance_account_transfer_legs_append_only[\s\S]*?BEFORE INSERT OR UPDATE OR DELETE ON finance_account_transfer_legs/,'transfer legs reject mutation and must match their source transfer');
assert.match(financeTransfersOpeningBalances,/finance_transfer_reversal_exceeds_original[\s\S]*?finance_opening_pos_cashbox_forbidden[\s\S]*?finance_opening_adjustment_before_cutoff/,'transfer reversal caps and opening-balance cutoff/POS safeguards are enforced');
assert.match(financeUnifiedReportSnapshots,/request_sha256[\s\S]*?UNIQUE \(venue_id,created_by,idempotency_key\)[\s\S]*?FOREIGN KEY \(venue_id,created_by\) REFERENCES users\(venue_id,id\)/,'report snapshots are venue and creator scoped, idempotent, and actor-linked');
assert.match(financeUnifiedReportSnapshots,/created_at timestamptz NOT NULL[\s\S]*?expires_at timestamptz NOT NULL[\s\S]*?CHECK \(expires_at=created_at\+interval '15 minutes'\)/,'report snapshot expiry is a persisted exact 15-minute interval');
assert.match(financeUnifiedReportSnapshots,/NEW\.expires_at:=NEW\.created_at\+interval '15 minutes'[\s\S]*?OLD\.expires_at>clock_timestamp\(\)[\s\S]*?BEFORE INSERT OR UPDATE OR DELETE ON finance_unified_report_snapshots/,'report snapshots receive an exact 15-minute TTL, reject mutation, and only permit expiry cleanup');
assert.match(financeFundingEvents,/FOREIGN KEY \(venue_id,document_id\)[\s\S]*?REFERENCES finance_funding_documents\(venue_id,id\)[\s\S]*?FOREIGN KEY \(venue_id,finance_account_id\)[\s\S]*?REFERENCES finance_accounts\(venue_id,id\)/,'funding events enforce venue-scoped document and account references');
assert.match(financeFundingEvents,/SELECT \* INTO document_row[\s\S]*?FOR UPDATE[\s\S]*?finance_loan_principal_limit_exceeded[\s\S]*?finance_loan_repayment_exceeds_principal/,'loan principal draws and repayments serialize against the loan document and enforce both caps');
assert.match(financeFundingEvents,/finance_account_name_snapshot IS DISTINCT FROM account_row\.name[\s\S]*?finance_payment_method_account_mismatch[\s\S]*?finance_pos_cash_payment_date_must_be_today[\s\S]*?finance_payment_open_shift_required/,'funding events validate current account identity and POS shift/cash constraints');
assert.match(financeFundingEvents,/finance_funding_events_append_only[\s\S]*?BEFORE INSERT OR UPDATE OR DELETE ON finance_funding_events[\s\S]*?BEFORE TRUNCATE ON finance_funding_events/,'funding events reject row mutation and truncation');

const migrationRunner = fs.readFileSync(path.join(root, 'migrate-vps.sh'), 'utf8');
assert.match(migrationRunner, /migrations\/\*\.sql/);
assert.match(migrationRunner, /ON_ERROR_STOP=1/);
const jsMigrationRunner = fs.readFileSync(path.join(root, 'scripts/migrate.js'), 'utf8');
assert.match(jsMigrationRunner, /await client\.query\('BEGIN'\)[\s\S]*for \(const file of files\)[\s\S]*await client\.query\('COMMIT'\)/,
  'JavaScript migration runner owns the all-migrations transaction');
console.log(`MIGRATIONS CONTRACT: PASS (${files.length} replay-safe migration files)`);
