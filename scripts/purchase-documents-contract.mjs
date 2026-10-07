import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(new URL('../migrations/038_inventory_purchase_documents.sql', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const repository = fs.readFileSync(new URL('../db.js', import.meta.url), 'utf8');
const portal = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');

for (const field of [
  'OLD.document_id IS DISTINCT FROM NEW.document_id',
  'OLD.venue_id IS DISTINCT FROM NEW.venue_id',
  'OLD.receipt_unit_cost IS DISTINCT FROM NEW.receipt_unit_cost',
  'OLD.source_movement_id IS DISTINCT FROM NEW.source_movement_id'
]) assert.match(migration, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

assert.match(migration, /source_movement_id uuid UNIQUE REFERENCES stock_movements\(id\) ON DELETE RESTRICT/);
assert.match(migration, /inventory_purchase_line_scope_guard/);
assert.match(migration, /inventory_purchase_line_lifecycle_guard/);
assert.match(migration, /BEFORE INSERT OR UPDATE OF source_auto_order_id, venue_id ON inventory_purchase_documents/);
assert.match(migration, /WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.document_id ELSE NEW.document_id END\s+FOR UPDATE/,
  'line writes must lock their parent document and serialize with posting');
assert.match(migration, /BEFORE INSERT OR UPDATE OR DELETE ON inventory_purchase_document_lines/,
  'every line mutation must be rejected after posting');
assert.doesNotMatch(migration, /OLD\.status = 'posted' AND NEW\.status = 'voided'/,
  'posted receipts cannot be voided until reversing movements exist');
for (const route of [
  "'/api/inventory/purchase-documents' && req.method === 'GET'",
  "'/api/inventory/purchase-documents' && req.method === 'POST'",
  "purchaseDocumentPath && req.method === 'PATCH'",
  "purchaseDocumentPostPath && req.method === 'POST'",
  "purchaseDocumentVoidPath && req.method === 'POST'"
]) assert.match(server, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(repository, /async voidDraft\(venueId, id\)[\s\S]*?FOR UPDATE[\s\S]*?purchase_document_not_voidable[\s\S]*?status='voided'/,
  'only a locked draft may be voided, without creating stock movements');
const postMethod = repository.match(/async post\(venueId, id, actorId\) \{([\s\S]*?)\r?\n  \}\r?\n  async/);
assert.ok(postMethod, 'purchase post method must remain discoverable for critical guards');
assert.match(postMethod[1], /is_marked AS ingredient_active[\s\S]*?FOR UPDATE OF l,i[\s\S]*?ingredient_active !== true[\s\S]*?purchase_ingredient_archived[\s\S]*?INSERT INTO stock_movements/,
  'archived ingredient must fail closed while locked before any receipt movement');
assert.match(server, /'purchase_ingredient_archived'[\s\S]{0,320}\? error\.message : 'purchase_document_post_failed'/,
  'post route must preserve the stable archived-ingredient conflict instead of masking it');
assert.match(portal, /purchase_ingredient_archived[\s\S]{0,220}Позиция в черновике архивирована/,
  'operator receives a clear no-stock-change message for an archived draft line');
assert.match(portal, /Архивная позиция:[\s\S]{0,100}line\.ingredientName/,
  'draft editor preserves the archived line snapshot so it can be replaced deliberately');
for (const contract of ['purchase_document_not_postable', 'purchase_document_empty', 'source_movement_id', 'stock_movements', 'receipt_unit_cost', 'inventory.purchase_document_posted', 'invalid_source_auto_order', 'FOR UPDATE OF l,i', 'purchase_document_required', 'purchase_item_not_in_auto_order', 'purchase_quantity_exceeds_auto_order', 'partially_received', 'receivedQuantity', 'auto_order_has_draft_receipts', 'has_drafts']) assert.match(`${server}\n${repository}`, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(repository, /assertAutoOrderAllocation\(client, sourceOrder, input\.venueId/,
  'draft receipts must reserve only the quantity still expected in their auto-order');
assert.match(repository, /UPDATE inventory_auto_orders SET status=\$1,lines=\$2::jsonb/,
  'posting a linked receipt must update received quantities and auto-order status transactionally');
assert.match(portal, /item\.cost = Number\(\(after > 0[\s\S]{0,240}line\.receiptUnitCost\)\.toFixed\(4\)\)/,
  'demo receipt valuation must preserve the same four-decimal weighted unit-cost precision as PostgreSQL');
assert.match(server, /SELECT id,status,lines FROM inventory_auto_orders WHERE id=\$1 AND venue_id=\$2 FOR UPDATE[\s\S]*?SELECT EXISTS\(SELECT 1 FROM inventory_purchase_documents WHERE source_auto_order_id=\$1 AND venue_id=\$2 AND status='draft'\)/,
  'cancelling an auto-order must serialize with draft creation/posting and reject linked drafts');
console.log('PURCHASE DOCUMENTS CONTRACT: PASS');
