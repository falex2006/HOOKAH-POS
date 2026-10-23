import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../payroll-scheme-ui.js', import.meta.url), 'utf8');
const extract = (start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first); return source.slice(first, last);
};
const gate = extract('    const savedRunLifecycleAllowed =', '    const renderSavedEntry =');
const supersessionGate = extract('    const supersessionAllowed =', '    const supersessionError =');
const open = extract('    const openRun =', '    const replayRun =');
const v1 = 'employee_attributed_merchandise_net_no_refund_v1';
const v2 = 'employee_attributed_remaining_net_refund_v2';
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const fixture = capability => {
  const calls = [], detail = { dataset: {}, textContent: '', innerHTML: '', querySelector: () => null };
  const data = { runId: 'run-1', capabilityVersion: capability, scheme: { name: 'Схема', versionNo: 1 },
    period: { from: '2026-10-01', to: '2026-10-31' }, venueTimezone: 'UTC', amountCents: 750, currency: 'RUB',
    replayAvailable: true, officialReady: false, payoutEligible: false,
    employees: [{ employeeId: 'employee-1', employeeName: 'Сотрудник', amountCents: 750, dayCount: 31 }] };
  const context = vm.createContext({ detail, selectedRunId: null, detailToken: 0, correctionContext: {}, correctionPlan: {}, correctionReadToken: 0,
    supersessionPlan: {}, supersessionReadToken: 0,
    alive: () => true, URLSearchParams, escapeHtml: value => String(value), money: value => String(value),
    table: (caption, headers, rows) => `<table><caption>${caption}</caption><thead>${headers.join('|')}</thead><tbody>${rows}</tbody></table>`,
    pageButton: () => '', errorText: error => error.message,
    savedRequest: async path => { calls.push(['read', path]); return data; },
    loadRefundReview: async id => calls.push(['review', id]), loadRunEntries: async id => calls.push(['entries', id]),
    loadEntryCategories: async id => calls.push(['categories', id]) });
  vm.runInContext(`${gate}\n${supersessionGate}\n${open}\nglobalThis.openRunTest=openRun;globalThis.allowed=savedRunLifecycleAllowed;`, context);
  return { context, detail, calls, data };
};
for (const capability of ['unknown_future_capability', undefined, null, '']) {
  const f = fixture(capability); await f.context.openRunTest('run-1');
  check(f.context.allowed('run-1') === false, 'unknown capabilities cannot materialize');
  check(f.detail.innerHTML.includes('data-saved-run-read-only'), 'unsupported lifecycle is explained');
  check(!/data-saved-entry-|data-refund-review-|data-correction-/.test(f.detail.innerHTML), 'unavailable write controls are absent');
  check(/data-saved-run-replay/.test(f.detail.innerHTML) && /data-saved-run-freshness/.test(f.detail.innerHTML), 'read-only verification remains');
  check(/data-saved-employee/.test(f.detail.innerHTML), 'employee explanations remain');
  check(f.calls.length === 1 && f.calls[0][0] === 'read', 'no unsupported entry/review/category load');
  check(f.context.correctionContext === null && f.context.correctionPlan === null, 'previous correction state cleared');
  check(f.detail.innerHTML.includes('data-supersession-preview') === (capability === v2), 'only exact v2 offers explicit cohort preview');
  check(f.context.supersessionPlan === null, 'previous supersession confirmation cleared');
}
for (const capability of [v1,v2]) {
  const f = fixture(capability); await f.context.openRunTest('run-1');
  check(f.context.allowed('run-1') && !f.context.allowed('another-run'), 'known capability gate bound to selected run');
  check(/data-saved-entry-category/.test(f.detail.innerHTML) && /data-correction-content/.test(f.detail.innerHTML), 'known v1/v2 entry and correction controls');
  check(!f.detail.innerHTML.includes('data-saved-run-read-only'), 'run payoutEligible:false is not an entry action denial');
  check(/data-refund-review-check/.test(f.detail.innerHTML)===(capability===v1), 'legacy line-review controls are v1 only');
  check(f.detail.innerHTML.includes('data-supersession-preview')===(capability===v2), 'whole cohort replacement is v2 only');
  assert.deepEqual(f.calls.map(row => row[0]), capability===v1?['read', 'review', 'entries', 'categories']:['read','entries','categories']); checks++;
  f.data.capabilityVersion = 'future'; await f.context.openRunTest('run-1');
  check(!f.context.allowed('run-1') && !/data-saved-entry-/.test(f.detail.innerHTML), 'known to unknown rerender closes gate');
}
{
  const f = fixture(v1), pending = new Map();
  f.context.savedRequest = path => new Promise(resolve => pending.set(path, resolve));
  const first = f.context.openRunTest('old-run');
  check(!f.context.allowed('old-run'), 'loading clears lifecycle capability');
  const second = f.context.openRunTest('new-run');
  pending.get('/api/payroll/calculation-runs/new-run')({ ...f.data, runId: 'new-run', capabilityVersion: v2 });
  await second;
  pending.get('/api/payroll/calculation-runs/old-run')({ ...f.data, runId: 'old-run', capabilityVersion: v1 });
  await first;
  check(f.context.allowed('new-run') && f.detail.dataset.savedRunCapability === v2, 'late v1 response cannot replace v2 capability');
  assert.deepEqual(f.calls.map(row=>row[0]),['entries','categories']);checks++;
}
{
  const f = fixture(v1); f.data.runId = 'foreign-run'; await f.context.openRunTest('run-1');
  check(!f.context.allowed('run-1'), 'mismatched response cannot open lifecycle gate');
}
// Execute the actual handlers with unsupported capabilities. A fabricated old
// button or stale correction object cannot submit a new financial operation.
for (const capability of [undefined, 'future']) {
  const f = fixture(capability); await f.context.openRunTest('run-1');
  let requests = 0;
  f.context.savedRequest = async () => { requests++; throw new Error('unexpected write'); };
  const handlers = [
    ['    const loadRunEntries =', '    const loadEntryCategories =', 'loadRunEntries', ['run-1']],
    ['    const loadEntryCategories =', '    const createRunEntry =', 'loadEntryCategories', ['run-1']],
    ['    const createRunEntry =', '    const incentiveDetails =', 'createRunEntry', [{ dataset: { savedEntryCreate: 'employee-1' } }]],
    ['    const loadCorrectionContext =', '    const previewCorrection =', 'loadCorrectionContext', ['old-entry']],
    ['    const previewCorrection =', '    const sendCorrection =', 'previewCorrection', []],
    ['    const sendCorrection =', '    const today = venueLocalToday()', 'sendCorrection', ['old-entry', true]],
    ['    const mutateRefundReview =', '    const checkFreshness =', 'mutateRefundReview', [{ dataset: {} }, false]]
  ];
  for (const [start, end, name, args] of handlers) {
    // Isolate each declaration because the real page already has these names.
    const handler = vm.runInContext(`(()=>{${extract(start, end)};return ${name};})()`, f.context);
    await handler(...args); check(requests === 0, `${name} remains blocked`);
  }
}
{
  const f=fixture(v2);await f.context.openRunTest('run-1');let requests=0;
  f.context.savedRequest=async()=>{requests++;throw new Error('unexpected legacy review');};
  const load=vm.runInContext(`(()=>{${extract('    const loadRefundReview =','    const mutateRefundReview =')};return loadRefundReview;})()`,f.context);
  const mutate=vm.runInContext(`(()=>{${extract('    const mutateRefundReview =','    const checkFreshness =')};return mutateRefundReview;})()`,f.context);
  await load('run-1');await mutate({dataset:{}},false);check(requests===0,'v2 cannot invoke legacy line refund-review handlers');
}
console.log(`payroll capability UI contract: PASS ${checks} (known v1/v2 lifecycle, v1-only review, unknown closed; VM only)`);
