import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const server = read('server.js');
const app = read('app.js');
const html = read('index.html');
const migration = read('migrations/209_pos_automatic_tender_accounts.sql');
const accountMigration = read('migrations/126_finance_other_income_account_sources.sql');
const finance = read('finance-payables.js');
const uiQa = read('scripts/staff-partial-payment-pending-qa.mjs');

const paymentStart = server.indexOf("const paymentPath = pathname.match(/^\\/api\\/orders\\/([^/]+)\\/payments$/);");
const closeStart = server.indexOf("if (orderPath && req.method === 'POST' && orderPath[2] === 'close')", paymentStart);
assert.ok(paymentStart >= 0 && closeStart > paymentStart, 'split-payment route boundary exists');
const paymentRoute = server.slice(paymentStart, closeStart);
const closeEnd = server.indexOf('const order = orders.find((entry) => entry.id === orderPath[1]);', closeStart);
assert.ok(closeStart >= 0 && closeEnd > closeStart, 'one-step close route boundary exists');
const closeRoute = server.slice(closeStart, closeEnd);

assert.match(migration, /ensure_finance_account_defaults[\s\S]*?main_cashbox[\s\S]*?pos_card_receipts/);
assert.match(migration, /main_cashbox_account_identity_conflict[\s\S]*?pos_card_receipts_account_identity_conflict/);
assert.match(migration, /FROM venues v[\s\S]*?JOIN finance_accounts a ON a\.venue_id=v\.id AND a\.code='main_cashbox'[\s\S]*?FROM venues v[\s\S]*?JOIN finance_accounts a ON a\.venue_id=v\.id AND a\.code='pos_card_receipts'/,
  'system-account preflight validates each venue-scoped identity');
assert.match(accountMigration, /finance_accounts_allowed_methods_v2_check[\s\S]*?\['cash','card','qr','bank_transfer','other'\][\s\S]*?finance_accounts_method_matrix_v2_check[\s\S]*?\['card','qr','other'\]/,
  'migration 126 permits QR for electronic accounts before automatic tender account migration 209');
assert.match(migration, /FOR venue_row IN SELECT id FROM venues LOOP[\s\S]*?ensure_finance_account_defaults/,
  'existing venues receive the system card destination');
assert.match(migration, /CREATE TRIGGER finance_accounts_pos_system_tender_guard[\s\S]*?BEFORE UPDATE OR DELETE/);
assert.match(migration, /OLD\.code IN \('main_cashbox','pos_card_receipts'\)[\s\S]*?finance_system_account_cannot_be_deleted[\s\S]*?finance_system_account_cannot_be_archived/,
  'cashbox and card-clearing system accounts cannot be removed or archived');
assert.match(migration, /pos_card_receipts_account_identity_conflict/,
  'a conflicting user account code fails safely instead of being overwritten');

assert.match(paymentRoute, /const accountCode=method==='cash'\?'main_cashbox':'pos_card_receipts'/);
assert.match(paymentRoute, /WHERE venue_id=\$1 AND code=\$2 FOR UPDATE/);
assert.match(paymentRoute, /prior\.method!==method \|\| Number\(prior\.amount\)!==amount/,
  'idempotent replay checks tender and amount before resolving the current server route');
assert.doesNotMatch(paymentRoute, /prior\.paymentAccountId/,
  'idempotent replay does not depend on a cashier-supplied account ID');
assert.match(paymentRoute, /finance_account_id,finance_account_name_snapshot/,
  'the resolved venue account and immutable name snapshot remain in the payment ledger');
assert.match(paymentRoute, /if \(closed\)[\s\S]*?refreshTableReservationStatus\(client,\s*persisted\.tableId,\s*venueDbId\)/,
  'full payment still closes the order and refreshes its table in the transaction');

assert.match(closeRoute, /const accountCode=paymentMethod==='cash'\?'main_cashbox':'pos_card_receipts'/,
  'direct close uses the same server-side account routing');
assert.doesNotMatch(closeRoute, /input\.paymentAccountId/);
assert.match(closeRoute, /refreshTableReservationStatus\(client,\s*persisted\.tableId,\s*venueDbId\)/);
assert.doesNotMatch(app, /paymentAccountId|payment-(?:card|qr)-account/,
  'the POS does not serialize or display finance account selectors');
assert.doesNotMatch(html, /payment-(?:card|qr)-account/);
assert.doesNotMatch(app, /api\/pos\/payment-accounts/,
  'cashier flows no longer request the account catalogue');
assert.match(app, /paymentMethod:choice\.method/,
  'one-step close sends only the selected tender type');
assert.match(app, /savePaymentIntent\(orderId,frozen\)[\s\S]*?const nextIndex=entryIndex\+1/,
  'mixed cash/card retry retains the existing idempotent progress journal');
assert.match(finance, /code<>'pos_card_receipts'/,
  'system POS clearing account is not offered as a general finance account destination');
assert.match(finance, /finance_system_account_cannot_be_archived/);
assert.match(uiQa, /cash and card|cash\/card|cash,card/i);
assert.match(uiQa, /paymentAccountId/,
  'runtime QA explicitly asserts that tender requests omit cashier-selected account IDs');

console.log('POS AUTOMATIC PAYMENT ROUTING CONTRACT: PASS (cashbox/card clearing auto-routing, no cashier account selector, safe idempotency, mixed tender and close-table invariants)');
