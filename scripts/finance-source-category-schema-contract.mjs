import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync('migrations/105_finance_source_category_links.sql', 'utf8');
const correctionCategoryMigration = fs.readFileSync('migrations/122_finance_expense_correction_category_refs.sql', 'utf8');
const priorPurchaseGuards = fs.readFileSync('migrations/097_purchase_document_reversals.sql', 'utf8');

const functionBody = (name) => {
  const match = migration.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`));
  assert.ok(match, `${name} exists`);
  return match[1];
};

for (const table of ['payroll_entries', 'inventory_purchase_documents']) {
  assert.match(migration, new RegExp(`ALTER TABLE ${table}[\\s\\S]*?ADD COLUMN IF NOT EXISTS finance_category_id uuid`), `${table} category ID is additive`);
  assert.match(migration, new RegExp(`ALTER TABLE ${table}[\\s\\S]*?ADD COLUMN IF NOT EXISTS finance_category_name_snapshot text`), `${table} snapshot is additive`);
  assert.match(migration, new RegExp(`FOREIGN KEY \\(venue_id,finance_category_id\\) REFERENCES finance_categories\\(venue_id,id\\) ON DELETE RESTRICT`), `${table} link is tenant scoped and retained`);
}

const payrollGuard = functionBody('validate_payroll_finance_category');
assert.match(payrollGuard, /OLD\.status <> 'draft'[\s\S]*?finance_category_id IS DISTINCT FROM NEW\.finance_category_id[\s\S]*?finance_category_name_snapshot IS DISTINCT FROM NEW\.finance_category_name_snapshot[\s\S]*?RETURN NEW;/, 'non-draft payroll transitions preserve category snapshot without revalidating active status');
assert.match(payrollGuard, /OLD\.status='draft' AND NEW\.status='cancelled'[\s\S]*?RETURN NEW;[\s\S]*?FROM finance_categories/, 'draft payroll cancellation preserves snapshot and bypasses active-category revalidation');
assert.match(payrollGuard, /OLD\.finance_category_id IS NOT NULL[\s\S]*?NEW\.finance_category_name_snapshot := NULL[\s\S]*?RETURN NEW;/, 'explicitly clearing a draft payroll category also clears its name snapshot');
assert.match(payrollGuard, /NEW\.status <> 'approved'[\s\S]*?RETURN NEW;/, 'unrelated draft payroll edits preserve the assigned snapshot after archive');
assert.match(payrollGuard, /FROM finance_categories WHERE venue_id=NEW\.venue_id AND id=NEW\.finance_category_id FOR SHARE/, 'payroll draft classification and approval use a tenant-scoped shared category lock');
assert.match(payrollGuard, /OLD\.venue_id IS DISTINCT FROM NEW\.venue_id[\s\S]*?finance_category_venue_immutable/, 'classified payroll entries cannot move across venues');
assert.match(payrollGuard, /finance_category_name_snapshot IS NOT NULL[\s\S]*?snapshot_without_id/, 'payroll snapshot cannot exist without stable category ID');
assert.match(migration, /BEFORE INSERT OR UPDATE OF venue_id,status,finance_category_id,finance_category_name_snapshot[\s\S]*?ON payroll_entries/, 'payroll guard runs on draft-to-approved transitions');

const purchaseGuard = functionBody('validate_purchase_document_finance_category');
assert.match(purchaseGuard, /OLD\.status IN \('posted','voided'\)[\s\S]*?finance_category_id IS DISTINCT FROM NEW\.finance_category_id[\s\S]*?finance_category_name_snapshot IS DISTINCT FROM NEW\.finance_category_name_snapshot[\s\S]*?RETURN NEW;/, 'posted/voided purchase lifecycle transitions preserve category snapshot without active revalidation');
assert.match(purchaseGuard, /OLD\.status='draft' AND NEW\.status='voided'[\s\S]*?RETURN NEW;[\s\S]*?FROM finance_categories/, 'draft purchase void preserves snapshot and bypasses active-category revalidation');
assert.match(purchaseGuard, /OLD\.finance_category_id IS NOT NULL[\s\S]*?NEW\.finance_category_name_snapshot := NULL[\s\S]*?RETURN NEW;/, 'explicitly clearing a draft purchase category also clears its name snapshot');
assert.match(purchaseGuard, /NEW\.status <> 'posted'[\s\S]*?RETURN NEW;/, 'unrelated draft purchase edits preserve the assigned snapshot after archive');
assert.match(purchaseGuard, /FROM finance_categories WHERE venue_id=NEW\.venue_id AND id=NEW\.finance_category_id FOR SHARE/, 'purchase draft classification and posting use a tenant-scoped shared category lock');
assert.match(purchaseGuard, /OLD\.venue_id IS DISTINCT FROM NEW\.venue_id[\s\S]*?finance_category_venue_immutable/, 'classified purchase documents cannot move across venues');
assert.match(purchaseGuard, /finance_category_name_snapshot IS NOT NULL[\s\S]*?snapshot_without_id/, 'purchase snapshot cannot exist without stable category ID');
assert.match(migration, /BEFORE INSERT OR UPDATE OF venue_id,status,finance_category_id,finance_category_name_snapshot[\s\S]*?ON inventory_purchase_documents/, 'purchase guard runs on draft-to-posted transitions');

assert.match(payrollGuard, /SELECT name,kind,active INTO category_name,category_kind,category_active[\s\S]*?NEW\.finance_category_name_snapshot := category_name/, 'draft same-ID snapshot spoofing is replaced by authoritative category name');
assert.match(purchaseGuard, /SELECT name,kind,active INTO category_name,category_kind,category_active[\s\S]*?NEW\.finance_category_name_snapshot := category_name/, 'purchase same-ID snapshot spoofing is replaced by authoritative category name');
assert.match(migration, /CREATE OR REPLACE FUNCTION guard_finance_category_source_kind[\s\S]*?NEW\.kind IS DISTINCT FROM OLD\.kind[\s\S]*?payroll_entries pe[\s\S]*?inventory_purchase_documents d[\s\S]*?finance_category_source_kind_immutable/, 'used category direction is protected for both new source links');
assert.match(correctionCategoryMigration, /CREATE OR REPLACE FUNCTION guard_finance_category_source_kind[\s\S]*?finance_expense_corrections c[\s\S]*?before_category_id=OLD\.id OR c\.after_category_id=OLD\.id[\s\S]*?finance_category_source_kind_immutable/, 'correction before/after snapshots preserve category direction');
assert.match(migration, /DROP TRIGGER IF EXISTS finance_category_source_kind_guard[\s\S]*?BEFORE UPDATE OF kind ON finance_categories/, 'kind protection trigger is safely recreated');
assert.doesNotMatch(migration, /CREATE OR REPLACE FUNCTION inventory_purchase_document_immutable_guard/, 'migration does not replace the existing purchase immutable guard');
assert.match(priorPurchaseGuards, /CREATE OR REPLACE FUNCTION inventory_purchase_reversal_document_snapshot_guard[\s\S]*?source_auto_order_status_before IS DISTINCT FROM NEW\.source_auto_order_status_before[\s\S]*?source_auto_order_lines_after IS DISTINCT FROM NEW\.source_auto_order_lines_after/, 'migration 097 reversal snapshot guard remains intact');
assert.match(priorPurchaseGuards, /CREATE TRIGGER inventory_purchase_reversal_document_snapshot_guard[\s\S]*?BEFORE UPDATE ON inventory_purchase_documents/, 'migration 097 purchase snapshot trigger remains installed');
assert.match(migration, /ADD COLUMN IF NOT EXISTS finance_category_id uuid[\s\S]*?ADD COLUMN IF NOT EXISTS finance_category_name_snapshot text/, 'migration preserves existing source rows without backfill');

console.log('FINANCE SOURCE CATEGORY SCHEMA CONTRACT: PASS (additive tenant links, active draft assignment/posting, frozen lifecycle snapshots, no historical backfill, used-category kind protection, existing purchase immutable guard retained)');
