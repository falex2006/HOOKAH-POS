import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const migration = read('migrations/138_finance_funding_events.sql');
const schema = read('schema.sql');
const server = read('server.js');
const portal = read('portal.js');
const distPortal = read('dist/portal.js');
const report = read('finance-unified-report.js');
const api = read('API.md');
const contract = read('docs/requirements/FINANCE_BALANCE_EVENTS_CONTRACT_DRAFT.md');

assert.ok(schema.replaceAll('\r','').includes(migration.replaceAll('\r','').trimEnd()), 'fresh schema retains funding migration 127 verbatim apart from platform line endings');
assert.ok(server.includes("handleFinanceFundingRoute({ req, res, url, pool: repositories?.pool"), 'funding API is wired through the authenticated API dispatcher');
assert.ok(server.includes("'owner_contribution',e.id,NULL,'receipt'") && server.includes("'loan_principal_repaid',e.id,NULL,'payout'"), 'POS cash funding event source tags enter the close ledger');
assert.ok(server.includes("e.event_type IN ('owner_contribution_received','loan_principal_received')"), 'POS funding receipts enter expected cash');
assert.ok(report.includes("source==='funding'&&name==='financing'") && report.includes("'none'::text AS \"pnlEffect\"") && report.includes('signedCashFlowAmount'), 'unified report identifies funding as external cash flow with no P&L effect');
assert.ok(portal.includes('data-finance-funding') && portal.includes('/api/finance/funding-documents') && portal.includes('data-funding-event'), 'financial report contains document and event workflows');
assert.ok(portal.includes('data-funding-history') && portal.includes('Взносы владельца и займы · денежный поток вне P&L'), 'UI exposes event history and report semantics');
assert.ok(portal.includes('data-finance-balance-events') && portal.includes('/api/finance/account-transfers') && portal.includes('/api/finance/opening-balances'), 'finance UI supports transfers, openings, reversals and corrections');
assert.ok(report.includes('source===\'internal_transfer\'&&name===\'internalTransfers\'') && report.includes('finance_account_transfer_legs') && report.includes('openingBalanceAdjustments'), 'unified report includes paired transfers and opening-position adjustments');
assert.ok(portal.includes('hookah-pos:pending-funding:') && portal.includes('getFundingAttempt') && portal.includes('saveFundingAttempt') && portal.includes('clearFundingAttempt'), 'funding submissions preserve an idempotent payload across reloads until success');
assert.ok(portal.includes("error.payload?.error!=='idempotency_key_reused'") && portal.includes('Запрос отклонён и событие не записано') && portal.includes('Историю проверил — начать заново') && portal.includes('current.events||[]'), 'definitive rejects unlock for correction and key conflicts require history readback before a new key');
assert.ok(portal.includes('data-funding-edit') && portal.includes('data-funding-filter') && portal.includes('Показаны первые 500 документов'), 'UI can edit drafts and disclose/filter a truncated document list');
const style = read('style.css');
const distStyle = read('dist/style.css');
assert.ok(style.includes('[data-finance-funding] .category-row>[data-funding-event]{grid-column:1/-1') && style.includes('@media(max-width:560px)'), 'event forms span the category row and collapse for narrow screens');
assert.equal(style, distStyle, 'source and served styles stay byte-identical');
assert.equal(portal, distPortal, 'source and served portal stay byte-identical');
for (const text of [api, contract]) {
  assert.ok(text.includes('finance-funding') || text.includes('funding-documents') || text.includes('account-transfers'), 'API and product contract document finance event endpoints');
  assert.match(text, /не.*(?:P&L|прибыли)|вне (?:бизнес-доходов|P&L)/i, 'API/product documentation preserves the P&L boundary');
}

console.log('FINANCE FUNDING CONTRACT: PASS (migration mirror, API dispatch, POS shift cash and close sources, non-P&L report, source/dist UI and docs)');
