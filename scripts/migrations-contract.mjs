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
}

const expenses = fs.readFileSync(path.join(migrationDir, '022_expenses.sql'), 'utf8');
const capacity = fs.readFileSync(path.join(migrationDir, '024_table_capacity_range.sql'), 'utf8');
const shifts = fs.readFileSync(path.join(migrationDir, '041_single_open_shift.sql'), 'utf8');
const stockPrecision = fs.readFileSync(path.join(migrationDir, '055_stock_movement_precision.sql'), 'utf8');
const premixLifecycle = fs.readFileSync(path.join(migrationDir, '056_premix_batch_lifecycle.sql'), 'utf8');
const shiftCloseSnapshots = fs.readFileSync(path.join(migrationDir, '093_shift_close_snapshots.sql'), 'utf8');
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
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
assert.match(schema, /CREATE TABLE IF NOT EXISTS shift_close_snapshots[\s\S]*?BEFORE UPDATE OR DELETE ON shift_close_snapshots/, 'base schema includes the same immutable close snapshot contract');

const migrationRunner = fs.readFileSync(path.join(root, 'migrate-vps.sh'), 'utf8');
assert.match(migrationRunner, /migrations\/\*\.sql/);
assert.match(migrationRunner, /ON_ERROR_STOP=1/);
const newVenueInventory = fs.readFileSync(path.join(migrationDir, '101_new_venue_inventory_defaults.sql'), 'utf8');
assert.match(newVenueInventory, /VALUES[\s\S]*'bar',\s*'Бар'[\s\S]*'hookah',\s*'Кальяны'/, 'new venues receive only bar and hookah departments');
assert.match(newVenueInventory, /DROP TRIGGER IF EXISTS venues_seed_inventory_category_defaults/, 'new venues no longer receive default categories automatically');
assert.doesNotMatch(newVenueInventory, /INSERT INTO product_categories|INSERT INTO inventory_subdepartments|UPDATE\s+|DELETE\s+FROM/i, 'forward migration does not seed or rewrite existing category data');
assert.match(newVenueInventory, /ON CONFLICT \(venue_id, code\) DO NOTHING/, 'new department seed is replay safe');
console.log(`MIGRATIONS CONTRACT: PASS (${files.length} replay-safe migration files)`);
