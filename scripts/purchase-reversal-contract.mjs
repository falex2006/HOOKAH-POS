import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const migration = read('migrations/097_purchase_document_reversals.sql');
const repository = read('db.js');
const server = read('server.js');
const portal = read('portal.js');
const distPortal = read('dist/portal.js');
const assertHas = (source, pattern, message) => assert.match(source, pattern, message);

assertHas(migration, /stock_movement_version_bump[\s\S]*?AFTER INSERT ON stock_movements/, 'movement lineage version advances for each later stock movement');
assertHas(migration, /inventory_purchase_reversal_policies[\s\S]*?UNIQUE \(venue_id, version\)/, 'venue policy is append-only and versioned');
assertHas(migration, /CREATE INDEX IF NOT EXISTS expenses_unlinked_purchase_venue_idx[\s\S]*?purchase_document_id IS NULL[\s\S]*?expenses_purchase_payment_receipt_required/, 'legacy unlinked purchase expenses are indexed and future unlinked payments are blocked');
assertHas(migration, /inventory_purchase_documents_venue_id_id_uq[\s\S]*?ON inventory_purchase_documents\(venue_id,id\)/, 'tenant-composite parent key exists before scoped foreign keys');
assertHas(migration, /source_movement_version[\s\S]*?inventory_purchase_reversal_movement_scope_guard/, 'reversal lines and movements retain source lineage');
assertHas(repository, /async updateReversalPolicy[\s\S]*?INSERT INTO audit_events[\s\S]*?inventory\.purchase_reversal_policy_changed/, 'policy changes append a version and audit in one transaction');
const post = repository.match(/async post\(venueId, id, actorId\) \{([\s\S]*?)\n  \}\n  async reverse/);
assert.ok(post, 'receipt posting method remains bounded and discoverable');
assertHas(post[1], /on_hand_before_snapshot[\s\S]*?movement_version_after_snapshot/, 'posting captures exact valuation and movement version snapshots');
assertHas(post[1], /source_auto_order_status_before[\s\S]*?source_auto_order_status_after/, 'posting captures exact auto-order rollback snapshots');
const reverse = repository.match(/async reverse\(input\) \{([\s\S]*?)\n  \}\n\}/);
assert.ok(reverse, 'reversal transaction method remains bounded and discoverable');
for (const pattern of [
  /AND v\.organization_id=\$3[\s\S]*?FOR UPDATE OF d,v/,
  /inventory_purchase_reversal_idempotency_conflict|purchase_document_reversal_idempotency_conflict/,
  /openShifts\.rowCount !== 1/,
  /WHERE venue_id=\$1 AND purchase_document_id=\$2 AND source='purchase'[\s\S]*?rowCount\) throw new Error\('purchase_document_reversal_paid'\)/,
  /source='purchase' AND purchase_document_id IS NULL LIMIT 1 FOR KEY SHARE[\s\S]*?purchase_document_reversal_payment_coverage_unavailable/,
  /Number\(line\.currentMovementVersion\) !== Number\(line\.versionAfter\)/,
  /status='draft'[\s\S]*?purchase_document_reversal_auto_order_changed/,
  /\$1::text=\$2::text AND \$3::jsonb=\$4::jsonb/,
  /UPDATE inventory_auto_orders SET status=\$1,lines=\$2::jsonb/,
  /inventory\.purchase_document_reversed/,
  /await client\.query\('COMMIT'\)/,
]) assertHas(reverse[1], pattern, `required reversal guard missing: ${pattern}`);
assert.doesNotMatch(reverse[1], /DELETE FROM expenses|UPDATE expenses|UPDATE order_costs/, 'reversal never edits expense or historical COGS facts');
assertHas(server, /purchaseDocumentReversePath && req\.method === 'POST'[\s\S]*?permissions\.includes\('inventory'\)[\s\S]*?permissions\.includes\('finance'\)[\s\S]*?sameOriginMutation\(req\)/, 'HTTP reversal requires authenticated dual permission and origin protection');
assertHas(server, /pathname === '\/api\/venue\/purchase-reversal-policy'[\s\S]*?req\.user\.role[\s\S]*?expectedVersion/, 'versioned policy settings are restricted and concurrency checked');
assertHas(server, /purchase_document_reversal_payment_coverage_unavailable:\s*409/, 'legacy payment coverage refusal is a conflict response');
assertHas(portal, /purchase-reversal-enabled[\s\S]*?loadReversalPolicy[\s\S]*?data-purchase-reverse[\s\S]*?purchase-reversal:[\s\S]*?sessionStorage\.removeItem/, 'venue settings and retry-safe reversal action are present in the UI source');
assert.equal(crypto.createHash('sha256').update(portal).digest('hex'), crypto.createHash('sha256').update(distPortal).digest('hex'), 'portal.js and dist/portal.js are byte-identical');
console.log('PURCHASE REVERSAL CONTRACT: PASS (migration, immutable evidence, tenant/RBAC, UI wiring, source/dist parity)');
