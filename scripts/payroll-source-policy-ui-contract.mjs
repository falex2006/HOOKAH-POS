import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { normalizePayrollSourcePolicies, PAYROLL_REMAINING_NET_EARNINGS_POLICY,
  PAYROLL_REFUND_ADJUSTED_VENUE_TURNOVER_POLICY, PAYROLL_FROZEN_SALE_DEPLETION_COST_PAYROLL_POLICY } = createRequire(import.meta.url)('../payroll-source-policies');
const source = fs.readFileSync(new URL('../payroll-scheme-ui.js', import.meta.url), 'utf8');
const start = source.indexOf('  const SOURCE_POLICY_SALES =');
const end = source.indexOf('  const venueLocalToday =', start);
assert.ok(start > 0 && end > start);
const context = vm.createContext({ structuredClone });
vm.runInContext(`${source.slice(start, end)}\nglobalThis.helpers = { applySourcePolicyControls, sourcePolicyControlValues };`, context);
const { applySourcePolicyControls: apply, sourcePolicyControlValues: values } = context.helpers;
const plain = (value) => JSON.parse(JSON.stringify(value));
const old = { mode: 'stable_percent', roleParameters: { bar: { stableRateBps: 1000 } }, future: { preserved: true }, employeeOverrides: [] };
assert.deepEqual(plain(values(old)), { enabled: false, schemaVersion: '1', saleCredit: '', discountAllocation: '', refunds: '', selectionReason: '' });
assert.deepEqual(apply(old, { enabled: false }), old, 'missing policy stays omitted, without auto defaults');
const controls = { enabled: true, schemaVersion: '1', saleCredit: 'order_responsible_snapshot', discountAllocation: 'eligible_gross_proportional_fixed_order',
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
for (const schemaVersion of [undefined, '', 'unknown', '3', 2]) assert.throws(() => apply(old, {...controls,schemaVersion}), /Явно выберите/);
assert.deepEqual(plain(apply(changed,values(changed))),plain(changed),'loading and applying v1 does not upgrade old schemes');
const controlsV2={...controls,schemaVersion:'2',saleCredit:'line_seller_snapshot',discountAllocation:'immutable_line_snapshot',refunds:'recognized_event_date'};
const v2=apply(old,controlsV2);
assert.equal(v2.sourcePolicies.schemaVersion,2);
assert.deepEqual(plain(v2.sourcePolicies.earnings),{refunds:PAYROLL_REMAINING_NET_EARNINGS_POLICY,
  venueTurnover:PAYROLL_REFUND_ADJUSTED_VENUE_TURNOVER_POLICY,marginCost:PAYROLL_FROZEN_SALE_DEPLETION_COST_PAYROLL_POLICY},'UI constants exactly match the server policy contract');
assert.deepEqual(normalizePayrollSourcePolicies(plain(v2.sourcePolicies)),plain(v2.sourcePolicies),'v2 UI output passes actual server normalization');
assert.deepEqual(plain(apply(JSON.parse(JSON.stringify(v2)),values(v2))),plain(v2),'v2 load/save preserves exact settings and reason');
assert.equal(values(v2).schemaVersion,'2');
const downgraded={...plain(v2.sourcePolicies),schemaVersion:1};delete downgraded.earnings;
assert.deepEqual(plain(apply(v2,{...values(v2),schemaVersion:'1'}).sourcePolicies),downgraded,
  'only an explicit downgrade removes earnings');
assert.equal(apply(v2,{enabled:false}).sourcePolicies,undefined,'explicit policy opt-out remains available');
for(const patch of [{saleCredit:'order_responsible_snapshot'},{saleCredit:'explicit_line_allocation'},
  {discountAllocation:'eligible_gross_proportional_fixed_order'},{refunds:'original_sale_period_correction'}]) {
  assert.throws(()=>apply(old,{...controlsV2,...patch}),/Для пересчёта премии выберите/,'v2 never silently rewrites incompatible source selections');
}
const mixed={...old,roleParameters:{bar:{mode:'margin_target',targetCents:5000},hookah:{mode:'stable_percent',stableRateBps:1000}}};
assert.equal(apply(mixed,controls).sourcePolicies.schemaVersion,1,'margin role does not infer an opt-in');
const mixedV2=apply(mixed,controlsV2);
assert.deepEqual(mixedV2.roleParameters,mixed.roleParameters,'version-wide policy does not alter mixed role configuration');
assert.deepEqual(plain(apply(mixedV2,values(mixedV2))),plain(mixedV2));

// Actual controls/rebuild/dirty handlers, including custom-select refresh and
// unsupported future versions, run against simple DOM fields.
const fields=()=>{
  const select=choices=>({value:'',disabled:false,options:choices.map(value=>({value})),refreshes:0,
    _customSelectRefresh(){this.refreshes++;},querySelectorAll(){return this.options.filter(option=>option.dataset?.policyUnknown);},
    append(option){option.remove=()=>{this.options=this.options.filter(row=>row!==option);};this.options.push(option);}});
  const scope={sourcePolicyControlValues:values,sourcePolicyEnabled:{checked:false},sourcePolicyVersion:select(['1','2']),
    sourcePolicySale:select(['','line_seller_snapshot','order_responsible_snapshot','explicit_line_allocation']),
    sourcePolicyDiscount:select(['','immutable_line_snapshot','eligible_gross_proportional_fixed_order']),
    sourcePolicyRefund:select(['','recognized_event_date','original_sale_period_correction']),
    sourcePolicyReason:{value:'',disabled:false},sourcePolicyMessage:{textContent:''},sourcePolicyFieldset:{disabled:false},
    sourcePolicyV2Explanation:{hidden:true},pending:false,editorAction:{kind:'edit'},gridStale:false,sourcePolicyDirty:false,
    payoutRiskAcknowledgementField:{checked:true},document:{createElement:()=>({dataset:{}})}};
  const first=source.indexOf('    const sourcePolicyControls ='),last=source.indexOf("    sourcePolicyFieldset.addEventListener('input'",first);
  assert.ok(first>0&&last>first);
  const sandbox=vm.createContext(scope);
  vm.runInContext(source.slice(first,last)+';globalThis.controlApi={read:sourcePolicyControls,rebuild:rebuildSourcePolicy,refresh:refreshSourcePolicyDisabled,dirty:markSourcePolicyDirty};',sandbox);
  return sandbox;
};
{
  const f=fields();f.controlApi.rebuild(old);
  assert.equal(f.sourcePolicyVersion.value,'1');assert.equal(f.sourcePolicyVersion.disabled,true);assert.equal(f.sourcePolicyV2Explanation.hidden,true);
  f.controlApi.rebuild(changed);assert.equal(f.sourcePolicyVersion.value,'1');assert.equal(f.sourcePolicyV2Explanation.hidden,true);
  f.sourcePolicyVersion.value='2';f.controlApi.dirty();
  assert.equal(f.sourcePolicyDirty,true);assert.equal(f.payoutRiskAcknowledgementField.checked,false);
  assert.equal(f.sourcePolicyV2Explanation.hidden,false);
  assert.equal(f.sourcePolicySale.value,'order_responsible_snapshot','explicit version selection never silently changes other fields');
  assert.throws(()=>apply(changed,f.controlApi.read()),/Для пересчёта премии выберите/);
  f.controlApi.rebuild(v2);assert.equal(f.sourcePolicyVersion.value,'2');assert.equal(f.sourcePolicyV2Explanation.hidden,false);
  assert.equal(f.sourcePolicyDirty,false);assert.deepEqual(plain(apply(v2,f.controlApi.read())),plain(v2));
  f.sourcePolicyEnabled.checked=false;f.controlApi.dirty();assert.equal(f.sourcePolicyV2Explanation.hidden,true);
  assert.equal(f.sourcePolicyVersion.disabled,true);
}
for(const guard of ['pending','gridStale','inspect']) {
  const f=fields();f.controlApi.rebuild(v2);if(guard==='inspect')f.editorAction={kind:'inspect'};else f[guard]=true;
  f.controlApi.refresh();f.controlApi.dirty();assert.equal(f.sourcePolicyVersion.disabled,true);assert.equal(f.sourcePolicyFieldset.disabled,true);
  assert.equal(f.sourcePolicyDirty,false);assert.equal(f.payoutRiskAcknowledgementField.checked,true);
  assert.equal(f.sourcePolicyV2Explanation.hidden,false,'saved v2 explanation remains readable in inspect mode');
}
{
  const f=fields(),future={...v2,sourcePolicies:{...v2.sourcePolicies,schemaVersion:99}};
  f.controlApi.rebuild(future);assert.equal(f.sourcePolicyVersion.value,'99');
  assert.ok(f.sourcePolicyVersion.options.some(option=>option.value==='99'&&option.textContent.includes('Неизвестное')));
  assert.throws(()=>apply(future,f.controlApi.read()),/Явно выберите/,'unknown versions do not silently downgrade');
  f.controlApi.rebuild(changed);assert.equal(f.sourcePolicyVersion.options.some(option=>option.value==='99'),false);
}
assert.match(source,/data-source-policy-version/);
assert.match(source,/Пересчитывать премию после возвратов по исходным датам продаж/);
assert.ok(source.includes('Для расчёта премии используем стоимость первоначального списания. При возврате выручка уменьшается, эта стоимость не восстанавливается; последующие возвраты запасов её не меняют.'));
assert.match(source,/Выбор применяется ко всей версии схемы, включая разные правила оплаты по ролям/);
assert.match(source,/После активации версии расчёт запускается в сохранённых расчётах/);
assert.match(source,/утверждение и выплата выполняются отдельно по состоянию начисления/);
assert.match(source, /Настройка будущего расчёта; данные источников ещё не подтверждены/);
assert.match(source, /не открывшему заказ/);
assert.match(source, /if \(sourcePolicyDirty\) definition = applySourcePolicyControls/);
assert.match(source, /if \(sourcePolicyDirty\) \{ notify/);
assert.match(source, /sourcePolicyFieldset\.disabled = true/);
assert.match(source, /pending \|\| editorAction\?\.kind === 'inspect' \|\| gridStale/);
assert.match(source, /version\.sourcePolicies === undefined \? \{\} : \{ sourcePolicies: structuredClone/);
assert.match(source, /sourcePolicyDirty = true; payoutRiskAcknowledgementField\.checked = false/);
assert.match(source, /rebuildSourcePolicy\(definition\)/);
console.log('PAYROLL SOURCE POLICY UI CONTRACT: PASS (explicit v1/v2 opt-in, no automatic upgrade, actual server constants, exact roundtrip, mixed roles, cost explanation, strict compatible choices and executed editor guards)');
