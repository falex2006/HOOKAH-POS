import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyCorrectionApplication, verifyZeroSourceOwnReturn } from './payroll-correction-application-browser-helper.mjs';
const require = createRequire(import.meta.url);
const { makeService } = require('../payroll-scheme-service');

// Called inside the guarded real historical-source/browser fixture. No source,
// calculator, proof, authorization, or SQL constraint is replaced here.
export async function verifyCalculationEntryLifecycle({ page, pool, base, headers, ids, period, versionId }) {
  const artifactDir = fileURLToPath(new URL(`../tmp/payroll-lifecycle-ui-qa/${Date.now()}-${process.pid}/`, import.meta.url));
  mkdirSync(artifactDir, { recursive: true });
  const capture = async (row, name) => {
    for (const width of [1440, 768, 390, 344]) {
      await page.setViewportSize({ width, height: 1000 });
      await row.scrollIntoViewIfNeeded();
      const bounds = await row.evaluate(node => {
        const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, viewport: innerWidth };
      });
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport + 1, `${name} row fits ${width}`);
      if (width <= 390) {
        const buttons = await row.locator('.payroll-entry-actions > .button').evaluateAll(nodes => nodes.map(node => {
          const rect = node.getBoundingClientRect(), parent = node.parentElement.getBoundingClientRect();
          return { text: node.textContent, width: rect.width, parentWidth: parent.width,
            wordBreak: getComputedStyle(node).wordBreak, overflowWrap: getComputedStyle(node).overflowWrap };
        }));
        for (const button of buttons) {
          assert.ok(button.width >= button.parentWidth - 2, `${button.text} occupies a readable full mobile row`);
          assert.equal(button.wordBreak, 'normal');
          assert.equal(button.overflowWrap, 'normal');
        }
      }
      await row.screenshot({ path: `${artifactDir}${name}-${width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  };
  const actor = { venueId: ids.venue, userId: ids.owner }, service = makeService(pool);
  const run = await service.createVerifiedRun(actor, { schemeVersionId: versionId,
    periodFrom: period.from, periodTo: period.to, idempotencyKey: 'lifecycle-real-source-run' });
  assert.equal(run.status, 'ready');
  const materialized = await service.materializeCalculationEntry(actor, run.runId, {
    employeeId: ids.employee, financeCategoryId: null, idempotencyKey: 'lifecycle-real-source-entry' });
  const entryId = materialized.entry.id, url = `${base}/api/payroll/calculation-entries/${entryId}`;
  const readState = async () => {
    const response = await page.request.get(`${url}/state`);
    assert.equal(response.status(), 200, await response.text()); return response.json();
  };
  const intent = (action, state, key) => ({ action, expectedStateHash: state.stateHash, idempotencyKey: key,
    paymentDate: action === 'pay' ? period.to : null, paymentAccountId: action === 'pay' ? ids.account : null,
    paymentMethod: action === 'pay' ? 'card' : null, reason: null });
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM expenses WHERE venue_id=$1) expenses,
    (SELECT count(*)::int FROM payroll_calculation_entry_transitions WHERE venue_id=$1) transitions,
    (SELECT count(*)::int FROM payroll_calculation_entry_transition_requests WHERE venue_id=$1) requests,
    (SELECT status FROM payroll_entries WHERE venue_id=$1 AND id=$2) status`, [ids.venue, entryId])).rows[0];
  const openRegistry = async id => {
    await page.goto(`${base}/finance#payroll`, { waitUntil: 'networkidle' });
    await page.locator('#payroll-filter-from').fill(period.from);
    await page.locator('#payroll-filter-to').fill(period.to);
    await page.locator('#payroll-reload').click();
    const row = page.locator(`[data-payroll-entry="${id}"]`);
    await row.waitFor({ state: 'visible' });
    return row;
  };
  let current = await readState();
  assert.equal(current.sourceStatus, 'current');
  assert.deepEqual(current.allowedActions, ['approve', 'cancel']);
  assert.equal(current.entry.grossCents, 1000); assert.equal(current.entry.amountCents, 1000);
  // Real writes followed by a server-side fault must all roll back together.
  for (const action of ['approve', 'pay']) {
    const stages = action === 'pay' ? ['INSERT INTO expenses', 'INSERT INTO payroll_calculation_entry_transitions',
      'UPDATE payroll_entries', 'INSERT INTO payroll_calculation_entry_transition_requests']
      : ['INSERT INTO payroll_calculation_entry_transitions', 'UPDATE payroll_entries', 'INSERT INTO payroll_calculation_entry_transition_requests'];
    for (const [index, prefix] of stages.entries()) {
      let injected = false;
      const failing = makeService({ query: (...args) => pool.query(...args), connect: async () => {
        const client = await pool.connect();
        return { query: async (sql, values) => {
          const result = await client.query(sql, values);
          if (!injected && String(sql).startsWith(prefix)) { injected = true; await client.query('SELECT 1/0'); }
          return result;
        }, release: error => client.release(error) };
      } });
      const before = await counts();
      await assert.rejects(failing.transitionCalculationEntry(actor, entryId, intent(action, current, `fault-${action}-${index}`)));
      assert.equal(injected, true, `real ${action} must reach ${prefix}`);
      assert.deepEqual(await counts(), before, `${action}/${prefix} rolled back all financial writes`);
    }
    if (action === 'approve') {
      const row = await openRegistry(entryId);
      await row.locator('[data-payroll-linked-check]').click();
      const responsePromise = page.waitForResponse(r => r.url() === `${url}/transition` && r.request().method() === 'POST');
      await row.locator('[data-payroll-action="approve"]').click();
      const response = await responsePromise, command = response.request().postDataJSON();
      assert.equal(response.status(), 200, await response.text());
      const saved = await response.json(); assert.equal(saved.entry.status, 'approved');
      const retry = await page.request.post(`${url}/transition`, { headers, data: command });
      assert.equal(retry.status(), 200, await retry.text());
      assert.equal((await retry.json()).transitionId, saved.transitionId);
      current = await readState(); assert.deepEqual(current.allowedActions, ['pay', 'cancel']);
    }
  }
  // A real UI payment commits, but its response is lost. Reload preserves the
  // exact request; neither that retry nor concurrent retries can pay twice.
  const paymentRow = await openRegistry(entryId);
  await paymentRow.locator('[data-payroll-linked-check]').click();
  await paymentRow.locator('[data-payroll-payment-date]').fill(period.to);
  await capture(paymentRow, 'positive-before-pay');
  let payCommand, committedPay;
  await page.route(`${url}/transition`, async route => {
    payCommand = route.request().postDataJSON();
    const response = await route.fetch();
    assert.equal(response.status(), 200, await response.text());
    committedPay = await response.json();
    await route.abort('failed');
  }, { times: 1 });
  await paymentRow.locator('[data-payroll-action="pay"]').click();
  await page.locator('#payroll-message').filter({ hasText: 'Ответ не подтверждён' }).waitFor();
  assert.ok(payCommand?.idempotencyKey && committedPay?.entry?.expenseId);
  await page.reload({ waitUntil: 'networkidle' });
  const uiRetryPromise = page.waitForResponse(r => r.url() === `${url}/transition` && r.request().method() === 'POST');
  await page.locator(`[data-payroll-linked-recovery] [data-payroll-linked-retry="${entryId}"]`).click();
  const uiRetry = await uiRetryPromise;
  assert.equal(uiRetry.status(), 200, await uiRetry.text());
  assert.deepEqual(uiRetry.request().postDataJSON(), payCommand);
  assert.equal((await uiRetry.json()).entry.expenseId, committedPay.entry.expenseId);
  const responses = await Promise.all([1, 2].map(() => page.request.post(`${url}/transition`, { headers, data: payCommand })));
  for (const response of responses) assert.equal(response.status(), 200, await response.text());
  const paid = await Promise.all(responses.map(response => response.json()));
  assert.equal(paid[0].transitionId, paid[1].transitionId);
  assert.equal(paid.filter(response => response.replayed).length, 2);
  assert.equal(paid[0].entry.status, 'paid'); assert.equal(paid[0].entry.paymentDate, period.to);
  const expenseId = paid[0].entry.expenseId;
  const expense = (await pool.query(`SELECT id,amount::text,expense_date::text AS date,source,
    payroll_calculation_entry_id FROM expenses WHERE venue_id=$1 AND id=$2`, [ids.venue, expenseId])).rows[0];
  assert.deepEqual(expense, { id: expenseId, amount: '10.00', date: period.to, source: 'payroll', payroll_calculation_entry_id: entryId });
  assert.equal((await pool.query('SELECT count(*)::int n FROM expenses WHERE payroll_calculation_entry_id=$1', [entryId])).rows[0].n, 1);
  current = await readState(); assert.deepEqual(current.allowedActions, []);
  const conflict = await page.request.post(`${url}/transition`, { headers, data: { ...payCommand, paymentDate: period.from } });
  assert.equal(conflict.status(), 409);
  const report = await page.request.get(`${base}/api/finance/unified-report?from=${period.from}&to=${period.to}`);
  assert.equal(report.status(), 200, await report.text());
  const finance = await report.json();
  const accruals = finance.items.payrollAccruals.filter(row => row.payrollEntryId === entryId);
  const cash = finance.items.cashOutflows.filter(row => row.id === expenseId);
  assert.equal(accruals.length, 1); assert.equal(Number(accruals[0].recognizedInRange), 10);
  assert.equal(cash.length, 1); assert.equal(Number(cash[0].amount), 10);
  assert.equal(finance.dateBasis.payrollAccrual, 'payroll_period_prorated_by_calendar_days');
  const zeroEntry = await service.materializeCalculationEntry(actor, run.runId, {
    employeeId: ids.zeroEmployee, financeCategoryId: null, idempotencyKey: 'lifecycle-zero-source-entry' });
  const zeroState = await service.getCalculationEntryState(actor, zeroEntry.entry.id);
  assert.equal(zeroState.entry.amountCents, 0);
  await service.transitionCalculationEntry(actor, zeroEntry.entry.id, intent('approve', zeroState, 'lifecycle-zero-source-approve'));
  const zeroApproved = await service.getCalculationEntryState(actor, zeroEntry.entry.id);
  assert.deepEqual(zeroApproved.allowedActions, ['pay', 'cancel']);
  const zeroRow = await openRegistry(zeroEntry.entry.id);
  await zeroRow.locator('[data-payroll-linked-check]').click();
  await zeroRow.locator('[data-payroll-action="pay"]').waitFor();
  assert.equal(await zeroRow.locator('[data-payroll-payment-account],[data-payroll-payment-method]').count(), 0);
  await zeroRow.locator('[data-payroll-payment-date]').fill(period.to);
  await capture(zeroRow, 'zero-before-completion');
  const zeroResponsePromise = page.waitForResponse(r => r.url() === `${base}/api/payroll/calculation-entries/${zeroEntry.entry.id}/transition`);
  await zeroRow.locator('[data-payroll-action="pay"]').click();
  const zeroResponse = await zeroResponsePromise;
  assert.equal(zeroResponse.status(), 200, await zeroResponse.text());
  const zeroPaid = await zeroResponse.json(); assert.equal(zeroPaid.entry.status, 'paid'); assert.equal(zeroPaid.entry.expenseId, null);
  assert.equal((await counts()).expenses, 1, 'real zero settlement creates no expense');
  const zeroReloaded = await openRegistry(zeroEntry.entry.id);
  assert.match(await zeroReloaded.innerText(), /Завершено без выплаты/);
  assert.doesNotMatch(await zeroReloaded.innerText(), /счёт не указан/);
  await capture(zeroReloaded, 'zero-completed');
  const zeroContextResponse = await page.request.get(`${base}/api/payroll/calculation-entries/${zeroEntry.entry.id}/corrections`);
  assert.equal(zeroContextResponse.status(), 200, await zeroContextResponse.text());
  const zeroContext = await zeroContextResponse.json();
  assert.equal(zeroContext.original.expense, null);
  assert.equal(zeroContext.original.settlement.kind, 'zero');
  assert.equal(zeroContext.original.settlement.grossCents, 0);
  assert.equal(zeroContext.remainingCents, 0);
  const zeroPreviewResponse = await page.request.post(`${base}/api/payroll/reviewed-corrections/preview`, {
    headers, data: { operation: 'waive', originalEntryId: zeroEntry.entry.id, targetEntryId: null }
  });
  assert.equal(zeroPreviewResponse.status(), 200, await zeroPreviewResponse.text());
  const zeroPreview = await zeroPreviewResponse.json();
  assert.equal(zeroPreview.waiveCents, 0);
  assert.equal(zeroPreview.originalSettlementTransitionId, zeroContext.original.settlement.transitionId);
  const zeroAttempt = await page.request.post(`${base}/api/payroll/reviewed-corrections`, { headers,
    data: { operation: 'waive', originalEntryId: zeroEntry.entry.id, targetEntryId: null,
      expectedPlanHash: zeroPreview.planHash, reason: 'No invented debt for zero earning', idempotencyKey: 'zero-no-phantom-claim' } });
  assert.equal(zeroAttempt.status(), 409, await zeroAttempt.text());
  assert.equal((await zeroAttempt.json()).error, 'payroll_correction_nothing_to_dispose');
  assert.equal((await counts()).expenses, 1);
  console.log('PASS actual source→draft→approve→paid UI/HTTP: real proof, rollback at 7 write stages, lost response/reload/exact concurrent retries, positive/zero settlements, one marked expense, calendar date, one accrual/cashflow');
  console.log(`Lifecycle UI artifacts ${artifactDir}`);
  return { entryId, runId: run.runId, payCommand, transitionUrl: `${url}/transition`, expenseId };
}

export async function verifyPaidCorrectionWaiver({ page, pool, base, headers, ids, lifecycle, openSaved, correctionTarget }) {
  const application = await verifyCorrectionApplication({page,pool,base,headers,ids,lifecycle,openSaved,correctionTarget});
  const actor = { venueId: ids.venue, userId: ids.owner };
  const contextUrl = `${base}/api/payroll/calculation-entries/${lifecycle.entryId}/corrections`;
  const previewUrl = `${base}/api/payroll/reviewed-corrections/preview`;
  const commitUrl = `${base}/api/payroll/reviewed-corrections`;
  const response = await page.request.get(contextUrl);
  assert.equal(response.status(), 200, await response.text());
  const context = await response.json();
  assert.equal(context.original.expense.id, lifecycle.expenseId);
  assert.equal(context.remainingCents, 500);
  assert.deepEqual(context.targets, []);
  const previewResponse = await page.request.post(previewUrl, { headers,
    data: { operation: 'waive', originalEntryId: lifecycle.entryId, targetEntryId: null } });
  assert.equal(previewResponse.status(), 200, await previewResponse.text());
  const plan = await previewResponse.json();
  assert.equal(plan.waiveCents, 500);
  let command = { operation: 'waive', originalEntryId: lifecycle.entryId, targetEntryId: null,
    expectedPlanHash: plan.planHash, reason: 'Owner waiver <script>escaped</script>', idempotencyKey: 'real-source-waiver-once' };
  const state = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM payroll_correction_claims WHERE venue_id=$1) claims,
    (SELECT count(*)::int FROM payroll_correction_batches WHERE venue_id=$1) batches,
    (SELECT count(*)::int FROM payroll_correction_events WHERE venue_id=$1) events,
    (SELECT count(*)::int FROM payroll_correction_requests WHERE venue_id=$1) requests,
    (SELECT count(*)::int FROM expenses WHERE venue_id=$1) expenses,
    (SELECT row_to_json(p)::text FROM payroll_entries p WHERE venue_id=$1 AND id=$2) paid`,
  [ids.venue, lifecycle.entryId])).rows[0];
  const before = await state();
  for (const prefix of ['INSERT INTO payroll_correction_batches',
    'INSERT INTO payroll_correction_events', 'INSERT INTO payroll_correction_requests']) {
    let injected = false;
    const failing = makeService({ query: (...args) => pool.query(...args), connect: async () => {
      const client = await pool.connect();
      return { query: async (sql, values) => {
        const result = await client.query(sql, values);
        if (!injected && String(sql).startsWith(prefix)) { injected = true; await client.query('SELECT 1/0'); }
        return result;
      }, release: error => client.release(error) };
    } });
    await assert.rejects(failing.applyReviewedCorrection(actor, command));
    assert.equal(injected, true, `actual waiver reaches ${prefix}`);
    assert.deepEqual(await state(), before, `waiver rollback at ${prefix}`);
  }
  await openSaved();
  await page.locator(`[data-saved-run-open="${lifecycle.runId}"]`).click();
  const select = async (selector, value) => {
    const input = page.locator(selector), wrapper = input.locator('..');
    const trigger = wrapper.locator('.custom-select-trigger');
    if (await trigger.count()) { await trigger.click(); await wrapper.locator(`[data-value="${value}"]`).click(); }
    else await input.selectOption(value);
  };
  await page.locator(`[data-correction-original] option[value="${lifecycle.entryId}"]`).waitFor({ state: 'attached' });
  await select('[data-correction-original]', lifecycle.entryId);
  await page.locator('[data-correction-operation]').waitFor({ state: 'attached' });
  await select('[data-correction-operation]', 'waive');
  await page.locator('[data-correction-preview]').click();
  await page.locator('[data-correction-reason]').fill(command.reason);
  const artifactDir = fileURLToPath(new URL(`../tmp/payroll-correction-ui-qa/${Date.now()}-${process.pid}/`, import.meta.url));
  mkdirSync(artifactDir, { recursive: true });
  for (const width of [1440, 768, 390, 344]) {
    await page.setViewportSize({ width, height: 1000 });
    const panel = page.locator('[data-correction-content]');
    await panel.scrollIntoViewIfNeeded();
    const bounds = await panel.evaluate(node => { const r=node.getBoundingClientRect(); return { left:r.left,right:r.right,viewport:innerWidth }; });
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport + 1);
    await panel.screenshot({ path: `${artifactDir}waiver-preview-${width}.png` });
    await page.locator('[data-correction-commit]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${artifactDir}waiver-confirm-viewport-${width}.png` });
  }
  let committed;
  await page.route(commitUrl, async route => {
    command = route.request().postDataJSON();
    const response = await route.fetch();
    assert.equal(response.status(), 201, await response.text()); committed = await response.json();
    await route.abort('failed');
  }, { times: 1 });
  await page.locator('[data-correction-commit]').click();
  await page.locator('[data-saved-run-status]').filter({ hasText: 'Результат запроса не подтверждён' }).waitFor();
  assert.ok(committed?.batchId);
  await openSaved();
  const retryPromise = page.waitForResponse(r => r.url() === commitUrl && r.request().method() === 'POST');
  await page.locator(`[data-correction-pending] [data-correction-retry="${lifecycle.entryId}"]`).click();
  const retried = await retryPromise;
  assert.equal(retried.status(), 200, await retried.text());
  assert.deepEqual(retried.request().postDataJSON(), command);
  assert.equal((await retried.json()).batchId, committed.batchId);
  const results = await Promise.all([1, 2].map(() => page.request.post(commitUrl, { headers, data: command })));
  assert.deepEqual(results.map(result => result.status()), [200, 200], await Promise.all(results.map(result => result.text())));
  const receipts = await Promise.all(results.map(result => result.json()));
  assert.deepEqual(receipts.map(receipt => receipt.replayed), [true, true]);
  assert.equal(receipts[0].batchId, receipts[1].batchId);
  assert.equal(receipts[0].totalCents, 500);
  const after = await state();
  assert.equal(after.claims, before.claims); assert.equal(after.batches, before.batches + 1);
  assert.equal(after.events, before.events + 1); assert.equal(after.requests, before.requests + 1);
  assert.equal(after.expenses, before.expenses); assert.equal(after.paid, before.paid);
  const reread = await page.request.get(contextUrl);
  assert.equal(reread.status(), 200, await reread.text());
  const live = await reread.json();
  assert.equal(live.remainingCents, 0); assert.equal(live.history.length, 4);
  assert.equal(live.history.at(-1).kind, 'waive'); assert.equal(live.history.at(-1).reason, command.reason);
  assert.ok(live.history.at(-1).createdByName); assert.ok(live.history.at(-1).createdAt);
  await page.locator(`[data-saved-run-open="${lifecycle.runId}"]`).click();
  await select('[data-correction-original]', lifecycle.entryId);
  await page.locator('[data-correction-context]').getByText(command.reason, { exact: false }).waitFor({ state: 'attached' });
  assert.equal(await page.locator('[data-correction-content] script').count(), 0);
  const stale = await page.request.post(commitUrl, { headers, data: { ...command, idempotencyKey: 'waiver-stale-new-key' } });
  assert.equal(stale.status(), 409);
  await verifyZeroSourceOwnReturn({pool,ids,correctionTarget,settledTarget:application.target});
  console.log(`PASS actual paid-source correction waiver UI/HTTP/DB: 3 rollback stages, lost response/reload/concurrent exact retry, immutable paid/expense, audited escaped history, stale plan; artifacts ${artifactDir}`);
  return command;
}
