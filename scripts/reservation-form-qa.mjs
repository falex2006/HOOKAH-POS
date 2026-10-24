import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {createReservationFixture, validDraft, settle, shared} from './ui042-reservation-fixture.mjs';

const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const distPortal = readFileSync(new URL('../dist/portal.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const distIndex = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const distApp = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
for (const [name, html] of [['source', index], ['dist', distIndex]]) {
  for (const id of ['payment-reservation-field', 'payment-reservation-receipt', 'payment-reservation']) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${name} payment UI has exactly one ${id}`);
  assert.match(html, /app\.js\?rev=\d+/, `${name} loads the versioned reservation allocation handler`);
}
const sourceAppRevision = index.match(/app\.js\?rev=(\d+)/)?.[1];
const distAppRevision = distIndex.match(/app\.js\?rev=(\d+)/)?.[1];
assert.equal(distAppRevision, sourceAppRevision, 'source and dist load the same POS app revision');
assert.equal(distApp, app, 'published POS app includes the reservation allocation handler');
assert.ok(distPortal === portal, 'published guest portal includes current loyalty and privacy rules (source/dist byte parity)');
assert.match(app, /method==='reservation'/, 'payment UI can post the reservation tender');
assert.match(app, /reservationPrepaymentReceipts/, 'payment UI renders available booking receipts');
assert.match(portal, /Требуемый депозит, ₽<input id="reservation-deposit"/, 'reservation form identifies the venue requirement, not a collected payment');
assert.match(portal, /Предоплата учитывается отдельно/, 'reservation form explains payment is recorded separately');
assert.match(portal, /status: 'confirmed', tableName: input\.tableId, deposit: 0, depositRequired: deposit, depositPaid: 0/, 'demo reservation preserves the required amount without faking collection');
const historyReservation = portal.slice(portal.indexOf('const reservations = (data.reservations || []).map'), portal.indexOf('const accountEntries =', portal.indexOf('const reservations = (data.reservations || []).map')));
assert.match(portal.slice(portal.indexOf('const reservationHistoryPaymentLabel'), portal.indexOf('\n};', portal.indexOf('const reservationHistoryPaymentLabel'))), /reservation\.depositRequired \?\? reservation\.deposit/, 'guest history keeps reading legacy reservation requirement amounts');
assert.match(portal, /подтверждено квитанциями/, 'guest history labels only receipt-backed prepayment as confirmed');
assert.match(portal, /старая сумма \$\{money\(legacy\)\} · не подтверждена/, 'guest history clearly separates the unverified legacy deposit');
assert.match(historyReservation, /reservationHistoryPaymentLabel\(item\)/, 'guest history does not display legacy deposit as money received');
const historyPaymentHelper = portal.slice(portal.indexOf('const reservationHistoryPaymentLabel'), portal.indexOf('\n};', portal.indexOf('const reservationHistoryPaymentLabel')) + 3);
const renderHistoryPayment = new Function('money', `${historyPaymentHelper}; return reservationHistoryPaymentLabel;`)((value) => `${value} ₽`);
const legacyHistoryLabel = renderHistoryPayment({ depositRequired: 500, depositPaid: 1500, legacyDepositPaid: 1500 });
assert.match(legacyHistoryLabel, /старая сумма 1500 ₽ · не подтверждена/);
assert.doesNotMatch(legacyHistoryLabel, /получено/);
const refundedHistoryLabel = renderHistoryPayment({ depositRequired: 300, verifiedDepositPaid: 0, prepaymentReceipts: [{ amount: 300, refundedAmount: 300, netAmount: 0 }] });
assert.match(refundedHistoryLabel, /предоплата возвращена полностью \(300 ₽\)/);
assert.doesNotMatch(refundedHistoryLabel, /получение не подтверждено/);
assert.match(historyPaymentHelper, /refund/);
assert.match(portal, /canAdjustGuestLoyalty = hasPortalPermission\('finance'\) \|\| hasPortalPermission\('loyalty'\) \|\| hasPortalPermission\('staff_manage'\)/, 'loyalty UI visibility uses scoped permissions rather than role labels');
assert.match(portal, /if \(!hasPortalPermission\('finance'\) && !hasPortalPermission\('loyalty'\) && !hasPortalPermission\('staff_manage'\)\) throw new Error\('forbidden'\)/, 'demo guest-ledger endpoint matches the API permission boundary');
assert.match(portal, /reservationPaymentsVisible: canReadReservationPayments/, 'demo guest history explicitly reports restricted payment fields');
assert.match(portal, /if \(path === '\/api\/clients' && method === 'GET'\).*canReadGuestBalances = hasPortalPermission/, 'demo guest list applies the same balance visibility policy as the API');
assert.match(portal, /const clientProfile = path\.match\(.*?protectedFields = \['discountGroupId','loyaltyPoints','bonusBalance','depositBalance'\].*?guest_balances_require_ledger/, 'demo guest profile update cannot overwrite protected loyalty balances');
assert.match(portal, /const prepaymentReceipts = \(item\.prepaymentReceipts \|\| \[\]\).*refundedAmount = \(item\.prepaymentRefunds \|\| \[\]\)/, 'demo history derives receipt refund summaries for the common UI label');
const reservationListStart = portal.indexOf('const draw = (query = \'\') =>', portal.indexOf("function renderReservations"));
const reservationListEnd = portal.indexOf("document.querySelector('#reservation-form').addEventListener", reservationListStart);
const reservationList = portal.slice(reservationListStart, reservationListEnd);
assert.match(reservationList, /item\.depositRequired \?\? item\.deposit/, 'reservation calendar keeps reading legacy requirement amounts');
assert.match(reservationList, /item\.verifiedDepositPaid \?\? 0/, 'calendar reads receipt-backed payments only');
assert.match(reservationList, /item\.legacyDepositPaid \?\? item\.depositPaid \?\? 0/, 'historical unverified amount remains separate');
assert.match(reservationList, /не подтверждена квитанцией/i, 'legacy amount is visibly flagged for reconciliation');
assert.match(reservationList, /data-reservation-prepayment/, 'calendar exposes safe prepayment action');
assert.match(reservationList, /Остаток требования/, 'prepayment confirmation shows outstanding requirement');
assert.match(reservationList, /reservation-prepayment-warning/, 'cancelled bookings with a receipt show a refund decision warning');
assert.match(reservationList, /deposit-receipts/, 'calendar action calls receipt endpoint');
assert.match(reservationList, /idempotencyKey/, 'payment request carries an idempotency key');
assert.match(portal, /Требуемый депозит:.*Зачёт предоплаты в заказ будет доступен после связывания брони с заказом/, 'reservation form does not promise an unavailable order transfer');
assert.match(portal, /item\.linkedOrderId \? 'Открыть заказ' : 'Начать визит'/, 'reservation list can reopen an already linked order after reload');
const memoryRouteStart = readFileSync(new URL('../server.js', import.meta.url), 'utf8').indexOf('const reservation = reservations.find((entry) => entry.id === reservationPrePaymentPath[1]');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const memoryRouteEnd = server.indexOf("if (pathname.startsWith('/api/reservations/') && req.method === 'POST' && pathname.endsWith('/cancel'))", memoryRouteStart);
const memoryPrepaymentRoute = server.slice(memoryRouteStart, memoryRouteEnd);
assert.ok(memoryRouteStart >= 0 && memoryRouteEnd > memoryRouteStart);
assert.match(memoryPrepaymentRoute, /reservations\.filter\(\(entry\) => entry\.venueId === currentVenueId\)\.flatMap\(\(entry\) => entry\.prepaymentReceipts \|\| \[\]\)/, 'memory idempotency lookup is scoped venue-wide like PostgreSQL');
assert.match(memoryPrepaymentRoute, /prior\.reservationId !== reservation\.id/, 'memory rejects a reused idempotency key on another booking');
const reservationRuntimeStart = portal.indexOf('const openReservationDialog = async');
const reservationRuntimeEnd = portal.indexOf("  api('/api/clients').then((data) => {", reservationRuntimeStart);
assert.ok(reservationRuntimeStart >= 0 && reservationRuntimeEnd > reservationRuntimeStart);
const reservationRuntime = portal.slice(reservationRuntimeStart, reservationRuntimeEnd);
assert.match(reservationRuntime, /reservationForm\.dataset\.submitting === '1'/, 'pending request blocks duplicate reservation opening');
assert.match(reservationRuntime, /ui\.open\(\{/, 'reservation form is mounted through the shared dialog lifecycle');
assert.match(reservationRuntime, /onSubmit: saveReservation/, 'dialog submit delegates to the reservation save operation');
assert.match(reservationRuntime, /reservationForm\.dataset\.submitting = pending \? '1' : '0'/, 'dialog lifecycle owns pending state');
assert.match(reservationRuntime, /reservationForm\.querySelector\('\[type="submit"\]'\)\.textContent = reservationForm\.dataset\.editingId \? 'Сохранение…' : 'Подтверждение…'/, 'pending state names create versus edit correctly');
assert.match(reservationRuntime, /async function saveReservation\(\)/, 'reservation save operation remains explicit and testable');
assert.match(reservationRuntime, /api\(editingId \? `\/api\/reservations\/\$\{encodeURIComponent\(editingId\)\}` : '\/api\/reservations'/, 'save operation uses POST for create and PATCH for edit');
assert.match(reservationRuntime, /finishReservationSave\(result,managementTicket\)/, 'successful save closes through the stable reload path');

const start = portal.indexOf("  api('/api/clients').then((data) => {", reservationRuntimeEnd);
const endMarker = '  }).catch(() => {}); loadTables(); load();';
const end = portal.indexOf(endMarker, start) + endMarker.length;
assert.ok(start >= 0 && end > start);
const guest = { value: '' };
const phone = { value: '' };
const clientId = { value: '' };
const hint = { textContent: '' };
const list = { innerHTML: '' };
let onInput;
guest.addEventListener = (_event, callback) => { onInput = callback; };
const clients = [
  { id: 'a', name: 'Одинаковый', nickname: 'А', phoneNumbers: [{ number: '+70000000001' }] },
  { id: 'b', name: 'Одинаковый', nickname: 'А', phoneNumbers: [{ number: '+70000000002' }] },
  { id: 'c', name: 'Уникальный', nickname: '', phoneNumbers: [{ number: '+70000000003' }] },
  { id: 'd', name: 'Одинаковый — А · +70000000001 · №1', nickname: '', phoneNumbers: [] },
];
vm.runInNewContext(portal.slice(start, end), {
  api: () => Promise.resolve({ items: clients }),
  esc: (value) => String(value),
  loadTables: () => {},
  load: () => {},
  document: { querySelector: (selector) => ({ '#reservation-guests-list': list, '#reservation-guest': guest, '#reservation-phone': phone, '#reservation-client-id': clientId, '#reservation-guest-match-hint': hint })[selector] },
});
await new Promise((resolve) => setImmediate(resolve));
assert.match(list.innerHTML, /Одинаковый — А · \+70000000001 · №1/);
assert.match(list.innerHTML, /Одинаковый — А · \+70000000002 · №2/);
assert.match(list.innerHTML, /Одинаковый — А · \+70000000001 · №1 · №1/, 'generated value cannot collide with a literal guest name');

guest.value = 'Уникальный'; onInput();
assert.equal(clientId.value, 'c');
assert.equal(phone.value, '+70000000003');
guest.value = 'Разовый'; onInput();
assert.equal(clientId.value, '', 'one-off guest must not inherit previous client ID');
assert.equal(phone.value, '', 'one-off guest must not inherit autofilled phone');
guest.value = 'Одинаковый'; onInput();
assert.equal(clientId.value, '', 'ambiguous name must not bind an arbitrary client');
assert.match(hint.textContent, /Несколько гостей/);
guest.value = 'Одинаковый — А · +70000000002 · №2'; onInput();
assert.equal(clientId.value, 'b', 'unique list choice must disambiguate identical names and nicknames');
assert.equal(guest.value, 'Одинаковый', 'submitted guest name must not contain option disambiguator');
assert.equal(phone.value, '+70000000002');
guest.value = 'Одинаковый — А · +70000000001 · №1'; onInput();
assert.equal(clientId.value, 'd', 'literal name matching another generated choice must bind its own ID');
assert.equal(guest.value, clients[3].name);
phone.value = '+79998887766';
guest.value = 'Другой разовый'; onInput();
assert.equal(clientId.value, '');
assert.equal(phone.value, '+79998887766', 'manual phone edit must survive guest name edit');

// Keep a runtime error-path check on the current shared dialog implementation:
// a rejected save must leave the draft open and restore editable controls.
const runtime = createReservationFixture();
validDraft(runtime);
runtime.context.showStep(2);
assert.equal(await runtime.context.openWizard(runtime.trigger), true);
const runtimeHandle = runtime.context.getWindow();
runtimeHandle.form.dispatch('submit');
await settle();
assert.equal(runtimeHandle.pending, true);
assert.equal(runtime.get('guest').disabled, true, 'failed save locks the draft while the request is pending');
assert.equal(runtime.get('phone').disabled, true, 'pending save locks the other editable draft field');
runtime.pending[0].reject(new Error('offline'));
await settle();
assert.equal(runtimeHandle.pending, false, 'failed save releases the shared dialog pending state');
assert.equal(runtimeHandle.element.isConnected, true, 'failed save keeps the reservation dialog open');
assert.equal(runtime.get('guest').disabled, false, 'failed save restores editable controls');
assert.equal(runtime.get('phone').disabled, false, 'failed save restores the other editable draft field');
assert.match(runtimeHandle.element.querySelector('.ui-modal-message').textContent, /сохранить/i);

console.log('RESERVATION FORM QA: PASS (current dialog lifecycle, pending ownership contract, guest identity, autofill cleanup)');
