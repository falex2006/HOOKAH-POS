import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../payroll-scheme-ui.js', import.meta.url), 'utf8');
const start = source.indexOf('  const SOURCE_POLICY_SALES =');
const end = source.indexOf('  const venueLocalToday =', start);
assert.ok(start > 0 && end > start);
const context = vm.createContext({ structuredClone });
vm.runInContext(`${source.slice(start, end)}\nglobalThis.helpers = { applySourcePolicyControls, sourcePolicyControlValues };`, context);
const { applySourcePolicyControls: apply, sourcePolicyControlValues: values } = context.helpers;
const plain = (value) => JSON.parse(JSON.stringify(value));
const old = { mode: 'stable_percent', roleParameters: { bar: { stableRateBps: 1000 } }, future: { preserved: true }, employeeOverrides: [] };
assert.deepEqual(plain(values(old)), { enabled: false, saleCredit: '', discountAllocation: '', refunds: '', selectionReason: '' });
assert.deepEqual(apply(old, { enabled: false }), old, 'missing policy stays omitted, without auto defaults');
const controls = { enabled: true, saleCredit: 'order_responsible_snapshot', discountAllocation: 'eligible_gross_proportional_fixed_order',
  refunds: 'recognized_event_date', selectionReason: ' Решение владельца ' };
const changed = apply(old, controls);
assert.deepEqual(plain(changed.sourcePolicies), { schemaVersion: 1, selectionReason: 'Решение владельца', saleCredit: { kind: 'order_responsible_snapshot' },
  discountAllocation: { kind: 'eligible_gross_proportional_fixed_order', rounding: 'largest_remainder_code_unit_v1', eligibility: 'pricing_source_snapshot' },
  refunds: { recognition: 'recognized_event_date', closedRunTreatment: 'next_open_run_adjustment', paidAdjustment: 'owner_review_variable_pay_only',
    uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } });
assert.deepEqual(changed.future, old.future); assert.deepEqual(changed.roleParameters, old.roleParameters);
assert.equal(Object.hasOwn(old, 'sourcePolicies'), false, 'pure model does not mutate input');
assert.equal(apply(changed, { enabled: false }).sourcePolicies, undefined, 'explicit opt-out removes policy');
for (const saleCredit of ['line_seller_snapshot', 'order_responsible_snapshot', 'explicit_line_allocation']) {
  for (const refunds of ['recognized_event_date', 'original_sale_period_correction']) {
    const policy = apply(old, { ...controls, saleCredit, refunds, discountAllocation: 'immutable_line_snapshot' }).sourcePolicies;
    assert.deepEqual(plain(policy.discountAllocation), { kind: 'immutable_line_snapshot' });
    assert.equal(policy.refunds.recognition, refunds); assert.equal(policy.saleCredit.kind, saleCredit);
  }
}
for (const field of ['saleCredit', 'discountAllocation', 'refunds']) for (const bad of ['', 'unknown']) {
  assert.throws(() => apply(old, { ...controls, [field]: bad }), /выберите/);
}
for (const selectionReason of ['', '12', 'x'.repeat(1001)]) assert.throws(() => apply(old, { ...controls, selectionReason }), /причину/);
assert.match(source, /Настройка будущего расчёта; данные источников ещё не подтверждены/);
assert.match(source, /не открывшему заказ/);
assert.match(source, /if \(sourcePolicyDirty\) definition = applySourcePolicyControls/);
assert.match(source, /if \(sourcePolicyDirty\) \{ notify/);
assert.match(source, /sourcePolicyFieldset\.disabled = true/);
assert.match(source, /pending \|\| editorAction\?\.kind === 'inspect' \|\| gridStale/);
assert.match(source, /version\.sourcePolicies === undefined \? \{\} : \{ sourcePolicies: structuredClone/);
assert.match(source, /sourcePolicyDirty = true; payoutRiskAcknowledgementField\.checked = false/);
assert.match(source, /rebuildSourcePolicy\(definition\)/);
console.log('PAYROLL SOURCE POLICY UI CONTRACT: PASS (explicit choices, omission, immutable responsibility, fixed safe settings and editor integration)');
