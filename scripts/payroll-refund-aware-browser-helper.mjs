import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CAPABILITY = 'employee_attributed_remaining_net_refund_v2';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const statusText = {
  current: 'Исходные данные совпадают на момент проверки.',
  stale: 'Исходные данные изменились. Для актуальных сумм нужен новый расчёт.',
  blocked: 'Актуальность расчёта не подтверждена: исходные данные требуют проверки.'
};

// Runner-owned authenticated owner page and isolated fixture only. This helper
// starts no process, creates no run, and performs no financial operation. api is
// a Playwright APIRequestContext, normally page.request. openSaved may reuse the
// caller's existing paced navigation. Invoke separately for old/stale and newly
// calculated/current run IDs after the runner has inserted its late return.
export async function verifyRefundAwareSavedRunBrowser({ page, base, api = page?.request, headers = {}, runId, employeeId,
  expectedFreshness = 'current', snapshotId = null, expectedAmountCents, expectedRefundCents,
  expectedCommissionBaseCents, artifactDir, openSaved } = {}) {
  assert.ok(page && api && typeof api.get === 'function', 'authenticated Playwright page/API context required');
  assert.ok(UUID.test(runId || '') && UUID.test(employeeId || ''), 'real persisted run/employee IDs required');
  assert.ok(Object.hasOwn(statusText, expectedFreshness));
  const origin = new URL(base).origin, runPath = `/api/payroll/calculation-runs/${runId}`, url = `${origin}${runPath}`;
  const directory = artifactDir || fileURLToPath(new URL(`../tmp/payroll-refund-aware-ui-qa/${Date.now()}-${process.pid}/${runId}/`, import.meta.url));
  mkdirSync(directory, { recursive: true });
  const artifacts = [], errors = [], disallowed = [], automaticLifecycleReads = [];
  const oldViewport = page.viewportSize();
  const onError = error => errors.push(error.message);
  const onRequest = request => {
    const target = new URL(request.url());
    if (target.origin !== origin || !target.pathname.startsWith('/api/payroll/')) return;
    const method = request.method();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      if (!(method === 'POST' && [`${runPath}/replay`, `${runPath}/freshness`].includes(target.pathname))) {
        disallowed.push({ method, path: target.pathname });
      } else {
        try { assert.deepEqual(request.postDataJSON(), {}); }
        catch (_) { disallowed.push({ method, path: target.pathname, reason: 'verification_payload_not_empty' }); }
      }
    }
    if (target.pathname === `${runPath}/refund-reviews`) automaticLifecycleReads.push(target.pathname);
  };
  const get = async suffix => {
    const response = await api.get(`${url}${suffix}`, { headers });
    assert.equal(response.status(), 200, `${suffix || 'run'}: ${await response.text()}`);
    const data = await response.json();
    assert.equal(data.runId, runId); assert.equal(data.officialReady, false); assert.equal(data.payoutEligible, false);
    for (const key of ['sourceBundle', 'sourceBundleWatermark', 'calculatorReplay', 'refundQuantityEvidence', 'evidence_payload'])
      assert.equal(JSON.stringify(data).includes(`"${key}"`), false, `private ${key} not exposed`);
    return data;
  };
  const navigate = openSaved || (async () => {
    await page.goto(`${origin}/finance#payroll`, { waitUntil: 'networkidle' });
    const settings = page.getByText('Настройки схем и проверка расчётов', { exact: true });
    if (!(await settings.locator('..').evaluate(node => node.open))) await settings.click();
    await page.locator('button[data-scheme-workspace="saved"]').click();
  });
  const noActions = async detail => {
    const gate = detail.locator('[data-saved-entry-reload]');
    await gate.waitFor({ state: 'visible' });
    assert.equal(await detail.getAttribute('data-saved-run-capability'), CAPABILITY);
    for (const selector of ['[data-saved-run-read-only]', '[data-refund-review-panel]', '[data-refund-review-check]', '[data-refund-review-decide]'])
      assert.equal(await detail.locator(selector).count(), 0, `${selector} absent from supported v2 detail`);
    assert.equal(await detail.locator('[data-correction-content]').count(), 1);
    assert.equal(await detail.locator('[data-saved-run-replay]').count(), 1);
    assert.equal(await detail.locator('[data-saved-run-freshness]').count(), 1);
  };
  page.on('pageerror', onError); page.on('request', onRequest);
  try {
    const before = await get('');
    assert.equal(before.schemaVersion, 1); assert.equal(before.capabilityVersion, CAPABILITY); assert.equal(before.replayAvailable, true);
    if (expectedAmountCents !== undefined) assert.equal(before.amountCents, expectedAmountCents);
    const days = await get(`/employees/${employeeId}`);
    assert.ok(days.days.length > 0, 'fixture has saved employee days');
    snapshotId ||= (days.days.find(day => day.amountCents > 0) || days.days[0]).snapshotId;
    assert.ok(UUID.test(snapshotId) && days.days.some(day => day.snapshotId === snapshotId));
    const lines = await get(`/days/${snapshotId}/lines`);
    assert.ok(lines.items.length > 0, 'select an actual sale day, including retained zero-return lines');
    const returned = lines.items.reduce((sum, line) => sum + line.refundCents, 0);
    const remaining = lines.items.reduce((sum, line) => sum + line.commissionBaseCents, 0);
    if (expectedRefundCents !== undefined) assert.equal(returned, expectedRefundCents);
    if (expectedCommissionBaseCents !== undefined) assert.equal(remaining, expectedCommissionBaseCents);
    await navigate();
    const open = page.locator(`[data-saved-run-open="${runId}"]`);
    // Fixture runs are normally the newest; support bounded actual pagination.
    for (let index = 0; index < 20; index++) {
      await page.locator('[data-saved-run-list]').getByRole('table').waitFor({ state: 'visible' });
      if (await open.count()) break;
      const more = page.locator('[data-saved-run-more]');
      assert.equal(await more.isVisible(), true, 'target v2 run must be present in saved list');
      const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/payroll/calculation-runs' && r.request().method() === 'GET');
      await more.click(); const received = await response; assert.equal(received.status(), 200);
      await received.finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    await open.click();
    const detail = page.locator('[data-saved-run-detail]');
    await noActions(detail);
    const freshnessResponse = page.waitForResponse(r => r.url() === `${url}/freshness` && r.request().method() === 'POST');
    await detail.locator('[data-saved-run-freshness]').click();
    const freshnessHttp = await freshnessResponse;
    assert.equal(freshnessHttp.status(), 200, await freshnessHttp.text());
    const freshness = await freshnessHttp.json();
    assert.equal(freshness.status, expectedFreshness); assert.equal(freshness.runId, runId);
    assert.equal(freshness.officialReady, false); assert.equal(freshness.payoutEligible, false); assert.equal(freshness.persistence, 'none');
    assert.equal(freshness.validity, 'transaction_snapshot_only');
    if (expectedFreshness === 'current') assert.deepEqual([freshness.sourceChanged, freshness.reasons], [false, []]);
    if (expectedFreshness === 'stale') assert.equal(freshness.sourceChanged, true, 'late-refund fixture changes economic source');
    await detail.locator('[data-saved-freshness-status]').filter({ hasText: statusText[expectedFreshness] }).waitFor();
    await noActions(detail);
    const replayResponse = page.waitForResponse(r => r.url() === `${url}/replay` && r.request().method() === 'POST');
    await detail.locator('[data-saved-run-replay]').click();
    const replayHttp = await replayResponse;
    assert.equal(replayHttp.status(), 200, await replayHttp.text());
    const replay = await replayHttp.json();
    assert.equal(replay.verification.status, 'matched'); assert.equal(replay.verification.replayVerified, true);
    assert.equal(replay.payoutEligible, false); assert.equal(replay.officialReady, false); assert.equal(replay.persistence, 'none');
    await detail.locator('[data-saved-replay-status]').filter({ hasText: 'Повторный расчёт совпал с сохранённым. Суммы не изменены.' }).waitFor();
    await detail.locator(`[data-saved-employee="${employeeId}"]`).click();
    await detail.locator(`[data-saved-day="${snapshotId}"]`).click();
    const linesUi = detail.locator(`[data-saved-lines][data-snapshot-id="${snapshotId}"]`);
    await linesUi.getByRole('table').waitFor({ state: 'visible' });
    for (const line of lines.items) await linesUi.getByText(line.menuItemName, { exact: true }).first().waitFor();
    for (const width of [1440, 768, 390, 344]) {
      await page.setViewportSize({ width, height: 1000 });
      await noActions(detail);
      for (const [name, target] of [['gate', detail.locator('[data-saved-entry-status]')],
        ['freshness', detail.locator('[data-saved-freshness-status]')], ['lines', linesUi]]) {
        await target.scrollIntoViewIfNeeded();
        const bounds = await target.evaluate(node => {
          const r = node.getBoundingClientRect();
          return { left: r.left, right: r.right, viewport: innerWidth, bodyWidth: document.documentElement.scrollWidth };
        });
        assert.ok(bounds.left >= -1 && bounds.right <= bounds.viewport + 1, `${name} fits ${width}`);
        assert.ok(bounds.bodyWidth <= bounds.viewport + 1, `no page horizontal overflow at ${width}`);
        const artifact = path.join(directory, `${expectedFreshness}-${name}-${width}.png`);
        await page.screenshot({ path: artifact }); artifacts.push(artifact);
      }
    }
    assert.deepEqual(await get(''), before, 'freshness and replay cannot rewrite saved totals/metadata');
    assert.deepEqual(await get(`/days/${snapshotId}/lines`), lines, 'historical lines unchanged after verification');
    assert.deepEqual(disallowed, [], 'UI never issued a payroll write beyond explicit read-only verification POSTs');
    assert.deepEqual(automaticLifecycleReads, [], 'v2 detail does not invoke legacy line refund-review loader');
    assert.deepEqual(errors, [], 'no page errors during v2 verification');
    console.log(`PASS v2 saved-run read-only UI ${expectedFreshness}, matched replay, four widths; artifacts ${directory}`);
    return { runId, snapshotId, freshness, replay, artifacts };
  } finally {
    page.off('pageerror', onError); page.off('request', onRequest);
    if (oldViewport) await page.setViewportSize(oldViewport);
  }
}
