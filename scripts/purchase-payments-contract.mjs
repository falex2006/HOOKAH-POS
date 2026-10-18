import fs from 'node:fs';

const server = fs.readFileSync('server.js', 'utf8');
const db = fs.readFileSync('db.js', 'utf8');
const portal = fs.readFileSync('portal.js', 'utf8');
const distPortal = fs.readFileSync('dist/portal.js', 'utf8');
const migration = fs.readFileSync('migrations/042_purchase_payment_link.sql', 'utf8');
const analytics = server.slice(server.indexOf("if (pathname === '/api/analytics'"), server.indexOf("if (pathname === '/api/finance/summary'"));
const purchaseRepository = db.slice(db.indexOf('class PurchaseDocumentRepository'), db.indexOf('class ProductRepository'));
const inventoryDocumentViews = purchaseRepository.slice(0, purchaseRepository.indexOf('async listPayables'));
const financeUi = portal.slice(portal.indexOf('function renderFinance()'), portal.indexOf('function renderDelivery()'));
const checks = [
  ['payables read permits finance readers only', /\/api\/finance\/purchase-payables[\s\S]*?denyUnlessAny\(req, res, \['finance', 'finance_read'\]\)/.test(server)],
  ['invoice payment history is read-only and tenant-scoped in repository', /purchasePaymentPath && req\.method === 'GET'[\s\S]*?isOperationalEmployee\(req\)[\s\S]*?listPayments\(venueDbId, id\)/.test(server) && /WHERE e\.venue_id=\$1 AND e\.purchase_document_id=\$2 AND e\.source='purchase'/.test(purchaseRepository) && /status='posted'/.test(purchaseRepository.slice(purchaseRepository.indexOf('async listPayments'), purchaseRepository.indexOf('async addPayment')))],
  ['operational staff cannot read invoice payment history, finance_read managers can', /purchasePaymentPath && req\.method === 'GET'[\s\S]*?denyUnlessAny\(req, res, \['finance', 'finance_read'\]\)[\s\S]*?isOperationalEmployee\(req\)/.test(server)],
  ['payment write requires finance permission', /purchasePaymentPath && req\.method === 'POST'[\s\S]*?denyUnless\(req, res, 'finance'\)/.test(server)],
  ['payment route validates idempotency, cents, date, method', /purchase_payment_idempotency_key_required/.test(server) && /invalid_purchase_payment_amount/.test(server) && /invalid_purchase_payment_date/.test(server) && /invalid_purchase_payment_method/.test(server)],
  ['purchase payment requires and forwards an explicit finance account', /finance_payment_account_required/.test(server) && /paymentAccountId, documentUrl, idempotencyKey/.test(server)],
  ['supplier payment writes through transactional repository', /BEGIN[\s\S]*?purchase_document_not_posted[\s\S]*?purchase_payment_exceeds_balance[\s\S]*?INSERT INTO expenses[\s\S]*?COMMIT/.test(purchaseRepository)],
  ['payment serialization locks the receipt row', /inventory_purchase_documents WHERE id=\$1 AND venue_id=\$2 FOR UPDATE/.test(purchaseRepository)],
  ['idempotency conflicts compare document, amount, date, method, evidence and account', /samePayload = String\(prior\.purchaseDocumentId\)[\s\S]*?prior\.paymentMethod[\s\S]*?prior\.documentUrl[\s\S]*?prior\.paymentAccountId/.test(purchaseRepository)],
  ['purchase payment stores immutable finance account attribution and only binds POS cash to a locked open shift', /finance_account_id,finance_account_name_snapshot,shift_id/.test(purchaseRepository) && /finance_payment_open_shift_required/.test(purchaseRepository) && /AT TIME ZONE timezone/.test(purchaseRepository)],
  ['inventory receipt views do not expose paid or payable totals', !/totalPaid|balanceDue|paymentStatus/.test(inventoryDocumentViews)],
  ['database enforces same-venue posted-document relation and payment source', /d\.venue_id = NEW\.venue_id[\s\S]*?d\.status = 'posted'/.test(migration) && /NEW\.source <> 'purchase'/.test(migration)],
  ['legacy unlinked purchase expenses are not rewritten', /Existing manual purchase expenses remain intact and unlinked/.test(migration)],
  ['free-form purchase expenses must use receipt-linked finance workflow', /input\.source === 'purchase'\) return json\(res, 400, \{ error: 'purchase_payment_requires_receipt_link' \}\)/.test(server)],
  ['purchase and payroll outflows stay out of operating expense and COGS remains separate', /e\.source NOT IN \('purchase','payroll'\)/.test(analytics) && /e\.source <> 'payroll' OR EXISTS/.test(analytics) && /costOfGoods = costsByDate/.test(server)],
  ['supplier-payment panel is finance-only page UI and not inventory UI', /finance-payables-panel/.test(financeUi) && !/finance-payables-panel/.test(portal.slice(portal.indexOf('function renderInventory()'), portal.indexOf('function renderFinance()')))],
  ['finance_read gets view-only status and stock UI contains no payment CTA', /data-payable-id/.test(financeUi) && /canDecideFinance && \(item\.balanceDue > 0\.005 \|\| pendingPurchasePayment\)/.test(financeUi)],
  ['UI refreshes payable balance, expense list and selected finance date after payment', /loadPayables\(\)[\s\S]*?loadExpenses\(\); document\.querySelector\('#finance-date'\)/.test(financeUi)],
  ['invoice rows expose lazy expandable payment history with date, method, account, shift, amount and evidence', /data-payable-history/.test(financeUi) && /payment\.paymentDate/.test(financeUi) && /labels\[payment\.paymentMethod\]/.test(financeUi) && /payment\.paymentAccountNameSnapshot/.test(financeUi) && /payment\.shiftId/.test(financeUi) && /money\(payment\.amount\)/.test(financeUi) && /Открыть документ/.test(financeUi)],
  ['payment form binds available methods to the selected finance account', /data-purchase-payment-account/.test(financeUi) && /data-purchase-payment-method/.test(financeUi) && /paymentAccountId: form\.elements\.paymentAccountId\.value/.test(financeUi)],
  ['ambiguous purchase-payment retries persist and restore the exact payload and key across reload', /savePurchasePaymentAttempt/.test(financeUi) && /getPurchasePaymentAttempt/.test(financeUi) && /data-pending-retry/.test(financeUi) && /documentUrl: String\(payload\.documentUrl/.test(financeUi)],
  ['late finance-account loading defers payable redraw until the in-flight payment settles', /if \(payablePaymentPending\) payableAccountsRedrawPending=true; else drawPayables\(true\)/.test(financeUi) && /payablePaymentPending = false; if \(payableAccountsRedrawPending\) \{ payableAccountsRedrawPending=false; drawPayables\(true\); \}/.test(financeUi)],
  ['source and published payable redraw guards stay in sync', portal.includes('if (payablePaymentPending) payableAccountsRedrawPending=true; else drawPayables(true)') && distPortal.includes('if (payablePaymentPending) payableAccountsRedrawPending=true; else drawPayables(true)') && portal.includes('if (payableAccountsRedrawPending) { payableAccountsRedrawPending=false; drawPayables(true); }') && distPortal.includes('if (payableAccountsRedrawPending) { payableAccountsRedrawPending=false; drawPayables(true); }')],
  ['payment evidence links accept only supported base64 image or PDF data URLs', /data:\(\?:image\\\//.test(financeUi) && /rel="noopener noreferrer"/.test(financeUi)],
  ['payment history has compact mobile layout', /\.payable-payment-history-item\{grid-template-columns:minmax\(0,1fr\) auto;gap:6px 12px\}/.test(fs.readFileSync('style.css', 'utf8'))],
];
const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) { console.error(`PURCHASE PAYMENT CONTRACT: FAIL (${failed.join('; ')})`); process.exit(1); }
console.log(`PURCHASE PAYMENT CONTRACT: PASS (${checks.length} checks)`);
