import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const contract = readFileSync(new URL('../shift-close-contract.js', import.meta.url), 'utf8');
const apiStart = source.indexOf('const shiftApi=');
const messageStart = source.indexOf('const shiftCloseFailureMessage=', apiStart);
const refreshStart = source.indexOf('\nconst refreshShift=', messageStart);
const closeActionStart = source.indexOf("document.querySelector('#shift-toggle')?.addEventListener('click'", refreshStart);
const closeActionEnd = source.indexOf("document.querySelectorAll('.actions button')", closeActionStart);
assert.ok(apiStart >= 0 && messageStart > apiStart && refreshStart > messageStart && closeActionStart > refreshStart && closeActionEnd > closeActionStart,
  'shift API, close feedback, and the close action are available');

const apiSource = source.slice(apiStart, messageStart).trim();
const messageSource = source.slice(messageStart, refreshStart).trim();
assert.match(source, /shiftCloseFailureMessage\(error\).*8000/,
  'the shift-close action must retain its specific server error message');
const shiftApi = new Function('staticStaffDemo', 'localStorage', 'staffSessionVerified', 'staffFetchJson', `${apiSource}; return shiftApi;`)(
  () => false, {}, true,
  async () => { const error = new Error('shift_cash_attribution_unresolved'); error.status=409; error.payload={error:'shift_cash_attribution_unresolved',count:3,amount:1234.5}; throw error; },
);
const { shiftCloseFailureMessage: failureMessage, shiftCashCloseDescription, shiftCloseResultMessage } =
  new Function(`${messageSource}; return { shiftCloseFailureMessage, shiftCashCloseDescription, shiftCloseResultMessage };`)();

await assert.rejects(
  shiftApi({ url: '/api/shifts/shift-1/close', method: 'POST' }),
  (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'shift_cash_attribution_unresolved');
    assert.equal(error.payload.count, 3);
    assert.equal(error.payload.amount, 1234.5);
    const message = failureMessage(error);
    assert.match(message, /Смена осталась открытой/);
    assert.match(message, /3/);
    assert.match(message, /1.?234,5/);
    assert.match(message, /Попросите управляющего сверить/);
    return true;
  },
);

assert.equal(failureMessage({ code: 'shift_not_found_or_closed' }), 'Не удалось закрыть смену',
  'other close errors retain the existing generic message');
assert.equal(failureMessage(new Error('HTTP 409')), 'Не удалось закрыть смену',
  'errors without a valid JSON payload retain the existing generic message');
assert.match(shiftCashCloseDescription({ expectedCash: 1270 }), /Ожидаемая наличность по данным системы: 1\s?270,00 ₽/,
  'the close dialog shows the latest provisional expected cash before the actual-cash input');
assert.match(shiftCashCloseDescription({ expectedCash: null, unresolvedLegacyCashCount: 2, unresolvedLegacyCashAmount: 40 }),
  /2 наличных платежа.*40,00 ₽.*будет отклонён/,
  'the close dialog explains when unresolved legacy cash will block closing');
assert.equal(shiftCloseResultMessage({ expectedCash: 1270, closingCash: 1250, cashVariance: -20 }),
  'Смена закрыта. Ожидалось: 1 270,00 ₽; фактически: 1 250,00 ₽; разница: -20,00 ₽.',
  'successful close reports expected, counted, and persisted variance');
const closeAction = source.slice(closeActionStart, closeActionEnd);
assert.match(closeAction, /const latest=await shiftApi\(\)/, 'the UI refreshes expected cash immediately before showing the close dialog');
assert.match(closeAction, /shiftCashCloseDescription\(currentShift\)/, 'the refreshed cash preview is shown before the user enters actual cash');
assert.match(closeAction, /shiftCloseResultMessage\(closeResult\)/, 'the UI reports the server-reconciled result after close');
assert.match(contract, /externalFiscalReportsHandled/);
assert.match(source, /checklistItems\|\|\[\]\)\.map/);
assert.match(source, /const checklist=\{version:window\.HOOKAH_SHIFT_CLOSE\?\.checklistVersion/);
assert.match(source, /action-field-checkbox[\s\S]*type="checkbox"[\s\S]*required/);
assert.match(portal, /checklist:\s*\{ version: window\.HOOKAH_SHIFT_CLOSE/);
assert.match(portal, /checklistFields=\(window\.HOOKAH_SHIFT_CLOSE\?\.checklistItems\|\|\[\]\)\.map/);
assert.match(portal, /внутренний снимок POS; он не является фискальным Z-отчётом/i);
assert.match(source, /не является фискальным Z-отчётом/i, 'the worker UI describes the snapshot boundary');
assert.match(portal, /не является фискальным Z-отчётом/i, 'the dashboard demo describes the snapshot boundary');

console.log('SHIFT CLOSE UI QA: PASS (fresh expected-cash preview, legacy-cash block, actual-vs-expected result, and actionable API errors)');
