import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const portal = read('portal.js');
const distPortal = read('dist/portal.js');
const promptSource = portal.match(/const reservationCancelPrompt = \(reservation\) => \{[\s\S]*?\n\};/)?.[0];
assert.ok(promptSource, 'reservation cancellation prompt helper exists');
const promptDist = distPortal.match(/const reservationCancelPrompt = \(reservation\) => \{[\s\S]*?\n\};/)?.[0];
assert.equal(promptDist, promptSource, 'published bundle has the same reservation warning helper');
const reservationCancelPrompt = new Function('money', `${promptSource}; return reservationCancelPrompt;`)((amount) => `${amount} ₽`);

const legacyOnly = reservationCancelPrompt({ legacyDepositPaid: 1500 });
assert.match(legacyOnly, /старом поле брони указано 1500 ₽/);
assert.match(legacyOnly, /не подтверждение поступления/);
assert.match(legacyOnly, /сумма останется в истории для ручной сверки/);
assert.match(legacyOnly, /не оформляйте возврат без первичного документа/);

const legacyAlias = reservationCancelPrompt({ depositPaid: 750 });
assert.match(legacyAlias, /указано 750 ₽/, 'legacy depositPaid alias also gets a warning');

const verifiedOnly = reservationCancelPrompt({ verifiedDepositPaid: 400 });
assert.match(verifiedOnly, /верните зачёт из открытого заказа/);
assert.match(verifiedOnly, /возврат всей фактически полученной предоплаты/);
assert.doesNotMatch(verifiedOnly, /старом поле/);

const mixed = reservationCancelPrompt({ verifiedDepositPaid: 400, legacyDepositPaid: 1500 });
assert.match(mixed, /фактически полученной предоплаты/);
assert.match(mixed, /не подтверждение поступления/);

const empty = reservationCancelPrompt({ verifiedDepositPaid: 0, legacyDepositPaid: 0 });
assert.equal(empty, 'Бронирование будет отменено, а история останется в журнале.');
assert.match(portal, /portalConfirm\('Отменить бронирование\?', reservationCancelPrompt\(reservation\)/,
  'reservation cancellation asks with the tailored legacy warning');
assert.match(distPortal, /portalConfirm\('Отменить бронирование\?', reservationCancelPrompt\(reservation\)/,
  'published reservation cancellation asks with the tailored legacy warning');

console.log('RESERVATION LEGACY CANCEL WARNING CONTRACT: PASS (legacy-only, verified-only, mixed balances, harmless cancellation, warning helper parity)');
