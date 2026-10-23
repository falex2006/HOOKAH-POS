import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { randomBytes, scryptSync, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCalculationEntryLifecycle, verifyPaidCorrectionWaiver } from './payroll-calculation-entry-source-browser-helper.mjs';
import { verifyRefundAwareSavedRunBrowser } from './payroll-refund-aware-browser-helper.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));

// Called only by the guarded, runner-owned historical PostgreSQL fixture.
export const verifySavedRunBrowser = async ({ pool, target, ids, period, versionId, runId, snapshotId, insertLateRefundFixture, correctionTarget, sourcePolicyVersionId, refundAwareRuns, supersessionSourcePolicies, publicV2Only = false }) => {
  assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
  const password = randomBytes(18).toString('hex'), salt = randomBytes(16).toString('hex');
  const hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=ANY($2::uuid[])', [hash, [ids.owner, ids.employee]]);
  await pool.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'active') ON CONFLICT(organization_id) DO UPDATE SET status='active'", [ids.org]);
  let server, browser;
  try {
    server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true,
      env: { ...process.env, DATABASE_URL: target.url.href, VENUE_ID: ids.venue, AUTH_REQUIRED: 'true',
        DEMO_MODE: 'false', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const base = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Saved-run isolated server startup timed out')), 20000);
      server.once('error', error => { clearTimeout(timeout); reject(error); });
      server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Saved-run server exited ${code}`)); });
      server.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}`); }
      });
      server.stderr.on('data', () => {}); // Do not print server/configuration secrets.
    });
    const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
    // Repeated full reloads generate hundreds of normal dashboard reads.
    // Pace browser traffic within the unchanged real shared-IP budget; keep
    // page.request concurrency probes and exact monetary recovery unchanged.
    let nextBrowserRequestAt = 0;
    await page.route(`${base}/api/**`, async route => {
      const now = Date.now(), scheduled = Math.max(now, nextBrowserRequestAt);
      nextBrowserRequestAt = scheduled + 150;
      if (scheduled > now) await new Promise(resolve => setTimeout(resolve, scheduled - now));
      await route.continue();
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const failedReads = [];
    page.on('response', response => {
      if (response.request().method() === 'GET' && response.status() >= 400 && response.url().startsWith(`${base}/api/`)) {
        failedReads.push({ path: new URL(response.url()).pathname, status: response.status(),
          retryAfter: Number(response.headers()['retry-after'] || 0), at: Date.now() });
      }
    });
    await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
    await page.locator('#login-username').fill(`verified-${ids.owner}`);
    await page.locator('#login-password').fill(password);
    await page.locator('#login-form button[type="submit"]').click();
    await page.waitForURL(url => !url.pathname.includes('/login'));
    const headers = { origin: base };
    if(publicV2Only) {
      const {seedUnpaidSupersessionFixture}=await import('./payroll-unpaid-supersession-fixture.mjs');
      const {verifyRefundAwarePublicBrowser}=await import('./payroll-refund-aware-public-browser-helper.mjs');
      const paidPeriod=(await pool.query(`SELECT (date_trunc('month',CURRENT_DATE)-interval '2 months')::date::text AS "from",
        (date_trunc('month',CURRENT_DATE)-interval '1 month'-interval '1 day')::date::text AS "to"`)).rows[0];
      const fixture=await seedUnpaidSupersessionFixture({pool,period:paidPeriod,sourcePolicies:supersessionSourcePolicies,withTarget:true});
      await pool.query('UPDATE users SET password_hash=$1 WHERE venue_id=$2',[hash,fixture.ids.venue]);
      await pool.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'active') ON CONFLICT(organization_id) DO UPDATE SET status='active'",[fixture.ids.org]);
      const deniedTokens=[];
      for(const [userId,organizationId] of [[fixture.ids.employee,fixture.ids.org],[ids.owner,ids.org]]) {
        const login=await fetch(`${base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({username:`verified-${userId}`,password})});assert.equal(login.status,200);
        const session=await login.json();deniedTokens.push({origin:base,authorization:`Bearer ${session.token}`,'X-Organization-Id':organizationId});
      }
      const ownerPage=await browser.newPage({viewport:{width:1440,height:1000},locale:'ru-RU'});
      try {
        await ownerPage.route(`${base}/api/**`,async route=>{
          const now=Date.now(),scheduled=Math.max(now,nextBrowserRequestAt);nextBrowserRequestAt=scheduled+150;
          if(scheduled>now)await new Promise(resolve=>setTimeout(resolve,scheduled-now));await route.continue();
        });
        await ownerPage.goto(`${base}/login`,{waitUntil:'networkidle'});
        await ownerPage.locator('#login-username').fill(`verified-${fixture.ids.owner}`);
        await ownerPage.locator('#login-password').fill(password);await ownerPage.locator('#login-form button[type="submit"]').click();
        await ownerPage.waitForURL(url=>!url.pathname.includes('/login'));
        await verifyRefundAwarePublicBrowser({page:ownerPage,base,pool,fixture,headers,staffHeaders:deniedTokens[0],foreignHeaders:deniedTokens[1]});
      } finally {await ownerPage.close();}
      return;
    }
    assert.equal((await page.request.get(`${base}/api/payroll/calculation-runs/${runId}`)).status(), 200);
    assert.equal((await page.request.get(`${base}/api/payroll/calculation-runs/${runId}/days/${snapshotId}/lines`)).status(), 200);
    assert.equal((await page.request.get(`${base}/api/payroll/calculation-runs?venueId=${ids.venue}`)).status(), 400);
    const forged = await page.request.post(`${base}/api/payroll/calculation-runs`, { headers, data: {
      schemeVersionId: versionId, periodFrom: period.from, periodTo: period.to,
      idempotencyKey: 'browser-forged-input', sourceBundle: {}
    } });
    assert.equal(forged.status(), 400, 'HTTP cannot inject prepared source');
    const firstDay = (await pool.query("SELECT date_trunc('month',CURRENT_DATE)::date::text AS day")).rows[0].day;
    // Current period is outside this historical version: 409 is a real window denial.
    assert.equal((await page.request.post(`${base}/api/payroll/calculation-runs`, { headers, data: {
      schemeVersionId: versionId, periodFrom: firstDay, periodTo: firstDay, idempotencyKey: 'browser-current-period'
    } })).status(), 409);
    const openSaved = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
      const readStart = failedReads.length;
      await page.goto(`${base}/finance#payroll`, { waitUntil: 'networkidle' });
      await page.reload({ waitUntil: 'networkidle' });
      const settings = page.getByText('Настройки схем и проверка расчётов', { exact: true });
      if (!(await settings.locator('..').evaluate(node => node.open))) await settings.click();
      await page.locator('button[data-scheme-workspace="saved"]').click();
      try {
        await page.locator(`[data-saved-run-version] option[value="${versionId}"]`).waitFor({ state: 'attached' });
        return;
      } catch (error) {
        const failures = failedReads.slice(readStart);
        const limited = failures.findLast(item => item.status === 429 && item.retryAfter > 0 && item.retryAfter <= 60);
        if (!limited || attempt) throw new Error(`Saved-run versions unavailable: ${JSON.stringify(failures)}`, { cause: error });
        // The repeated reload/recovery exercise shares the real IP budget.
        // Respect Retry-After for reads; never retry a monetary command here.
        console.log(`QA read pacing: observed429 ${limited.path}; respecting Retry-After`);
        await new Promise(resolve => setTimeout(resolve, Math.max(0, limited.at + limited.retryAfter * 1000 - Date.now()) + 100));
      }
      }
    };
    const fillRun = async () => {
      const select = page.locator('[data-saved-run-version]');
      const trigger = select.locator('..').locator('.custom-select-trigger');
      if (await trigger.count()) {
        await trigger.click();
        await select.locator('..').locator(`[data-value="${versionId}"]`).click();
      } else await select.selectOption(versionId);
      await page.locator('[data-saved-run-from]').fill(period.from);
      await page.locator('[data-saved-run-to]').fill(period.to);
    };
    await openSaved();
    if (sourcePolicyVersionId) {
      await page.getByRole('button', { name: 'Схемы', exact: true }).click();
      await page.locator(`[data-scheme-open-version="${sourcePolicyVersionId}"]`).click();
      await page.getByText('Правила источников — расширенная настройка', { exact: true }).click();
      const choice=page.locator('[data-source-policy-version]'), explanation=page.locator('[data-source-policy-v2-explanation]');
      await explanation.waitFor({ state:'visible' });
      assert.equal(await choice.inputValue(),'2'); assert.equal(await choice.isDisabled(),true,'active source policy is immutable');
      assert.ok((await explanation.textContent()).includes('стоимость первоначального списания'));
      const policyArtifacts=path.join(root,'tmp','payroll-policy-v2-ui-qa',`${Date.now()}-${process.pid}`);
      mkdirSync(policyArtifacts,{recursive:true});
      for(const width of [1440,768,390,344]) {
        await page.setViewportSize({width,height:1000}); await explanation.scrollIntoViewIfNeeded();
        const bounds=await explanation.evaluate(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,viewport:innerWidth};});
        assert.ok(bounds.left>=0&&bounds.right<=bounds.viewport+1,'policy explanation stays in viewport');
        await page.screenshot({path:path.join(policyArtifacts,`policy-${width}.png`)});
      }
      await page.setViewportSize({width:1440,height:1000});
      console.log(`PASS actual immutable v2 policy UI readback and four-width disclosure; artifacts ${policyArtifacts}`);
      await openSaved();
    }
    await page.locator(`[data-saved-run-open="${runId}"]`).click();
    const checkFreshness = async (id, expected, text) => {
      const response = page.waitForResponse(r => r.url() === `${base}/api/payroll/calculation-runs/${id}/freshness`);
      await page.locator('[data-saved-run-freshness]').click();
      const received = await response;
      assert.equal(received.status(), 200);
      const data = await received.json();
      assert.equal(data.status, expected, JSON.stringify(data));
      assert.equal(data.payoutEligible, false);
      assert.equal(data.officialReady, false);
      assert.equal(data.persistence, 'none');
      assert.equal(Object.hasOwn(data, 'evidence'), false);
      await page.locator('[data-saved-freshness-status]').filter({ hasText: text }).waitFor();
      return data;
    };
    await checkFreshness(runId, 'stale', 'Исходные данные изменились');
    const forgedFreshness = await page.request.post(`${base}/api/payroll/calculation-runs/${runId}/freshness`, {
      headers, data: { sourceChanged: false }
    });
    assert.equal(forgedFreshness.status(), 400);
    const checkResponse = page.waitForResponse(response => response.url() === `${base}/api/payroll/calculation-runs/${runId}/replay`);
    await page.locator('[data-saved-run-replay]').click();
    assert.equal((await checkResponse).status(), 200);
    await page.locator('[data-saved-replay-status]').filter({ hasText: 'Повторный расчёт совпал' }).waitFor();
    const rejectedReplay = await page.request.post(`${base}/api/payroll/calculation-runs/${runId}/replay`, {
      headers, data: { input: {} }
    });
    assert.equal(rejectedReplay.status(), 400, 'cannot substitute calculator input for saved evidence');
    await page.locator(`[data-saved-employee="${ids.employee}"]`).click();
    await page.locator(`[data-saved-day="${snapshotId}"]`).click();
    await page.locator('[data-saved-lines]').getByText('Historical tea', { exact: true }).waitFor();
    assert.match(await page.locator('[data-saved-run-detail]').innerText(), /Verified employee/);
    await fillRun();
    const runCount = async () => (await pool.query('SELECT count(*)::int n FROM payroll_calculation_runs WHERE venue_id=$1', [ids.venue])).rows[0].n;
    const before = await runCount();
    let committedBody, intent;
    await page.route('**/api/payroll/calculation-runs', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      intent = route.request().postDataJSON();
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      committedBody = await response.json();
      await route.abort('failed'); // Commit succeeds but the browser loses the response.
    }, { times: 1 });
    await page.locator('[data-saved-run-create]').click();
    await page.locator('[data-saved-run-status]').filter({ hasText: 'тот же ключ' }).waitFor();
    assert.equal(await runCount(), before + 1);
    assert.ok(intent?.idempotencyKey && committedBody?.runId);
    await openSaved(); await fillRun();
    const replayResponse = page.waitForResponse(response => response.url() === `${base}/api/payroll/calculation-runs` && response.request().method() === 'POST');
    await page.locator('[data-saved-run-create]').click();
    const replay = await replayResponse;
    assert.equal(replay.status(), 200);
    assert.equal(replay.request().postDataJSON().idempotencyKey, intent.idempotencyKey);
    assert.equal((await replay.json()).runId, committedBody.runId);
    await page.locator('[data-saved-run-detail]').getByText('Расчёт сохранён. Для каждого сотрудника можно создать черновик начисления по сохранённой сумме.', { exact: true }).waitFor();
    assert.equal(await runCount(), before + 1, 'reload retry does not duplicate the unknown committed request');
    await checkFreshness(committedBody.runId, 'current', 'Исходные данные совпадают');
    await checkFreshness(committedBody.runId, 'current', 'Исходные данные совпадают');
    let unblockInspection, inspectionFetched, inspectionFailed;
    const inspectionGate = new Promise(resolve => { unblockInspection = resolve; });
    const inspectionAtGate = new Promise((resolve, reject) => { inspectionFetched = resolve; inspectionFailed = reject; });
    const delayedUrl = `${base}/api/payroll/calculation-runs/${committedBody.runId}/freshness`;
    await page.route(delayedUrl, async route => {
      try {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        inspectionFetched(); await inspectionGate;
        await route.fulfill({ response });
      } catch (error) { inspectionFailed(error); await route.abort().catch(() => {}); }
    });
    try {
      const delayedResponse = page.waitForResponse(response => response.url() === delayedUrl);
      await page.locator('[data-saved-run-freshness]').click();
      let inspectionTimeout;
      try {
        await Promise.race([inspectionAtGate, new Promise((_, reject) => {
          inspectionTimeout = setTimeout(() => reject(new Error('Delayed freshness request did not reach its response gate')), 20000);
        })]);
      } finally { clearTimeout(inspectionTimeout); }
      await page.locator(`[data-saved-run-open="${runId}"]`).click();
      await page.locator('[data-saved-freshness-status]').filter({ hasText: 'ещё не проверена' }).waitFor();
      unblockInspection();
      await (await delayedResponse).finished();
      // Wait for the page to consume the already-delivered response.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.match(await page.locator('[data-saved-freshness-status]').innerText(), /ещё не проверена/,
        'delayed current result for another run cannot replace this run state');
    } finally { unblockInspection(); await page.unroute(delayedUrl); }
    // A completed inspection is never cached as permission after navigation.
    await openSaved();
    await page.locator(`[data-saved-run-open="${committedBody.runId}"]`).click();
    await page.locator('[data-saved-freshness-status]').filter({ hasText: 'ещё не проверена' }).waitFor();
    await page.locator(`[data-saved-employee="${ids.employee}"]`).click();
    const dayResponse = await page.request.get(`${base}/api/payroll/calculation-runs/${committedBody.runId}/employees/${ids.employee}`);
    const dayId = (await dayResponse.json()).days.find(day => day.amountCents === 1000).snapshotId;
    await page.locator(`[data-saved-day="${dayId}"]`).click();
    await page.locator('[data-saved-lines]').getByText('Historical tea', { exact: true }).waitFor();
    const detailBeforeRefund = await page.locator('[data-saved-lines]').innerText();
    const checkRefunds = async () => {
      const response = page.waitForResponse(r => r.url() === `${base}/api/payroll/calculation-runs/${committedBody.runId}/refund-reviews` && r.request().method() === 'POST');
      await page.locator('[data-refund-review-check]').click();
      const received = await response;
      assert.equal(received.status(), 201, await received.text());
      const data = await received.json();
      await page.locator('[data-refund-review-content]').getByText('Оценка изменения зарплаты:', { exact: false }).waitFor();
      return data;
    };
    const beforeReturnReview = await checkRefunds();
    assert.equal(beforeReturnReview.latestAssessment.payload.impactCents, 0);
    // Materialization uses the real saved run, current sources and transaction.
    // Inject faults after actual SQL writes, never bypass source or DB guards.
    const { makeService } = require('../payroll-scheme-service');
    const bridgeUrl = `${base}/api/payroll/calculation-runs/${committedBody.runId}/entries`;
    const bridgeCounts = async () => (await pool.query(`SELECT
      (SELECT count(*)::int FROM payroll_entries WHERE venue_id=$1) entries,
      (SELECT count(*)::int FROM payroll_calculation_entry_requests WHERE venue_id=$1) requests,
      (SELECT count(*)::int FROM expenses WHERE venue_id=$1) expenses`, [ids.venue])).rows[0];
    const beforeBridge = await bridgeCounts();
    for (const table of ['payroll_entries', 'payroll_calculation_entry_requests']) {
      let injected = false;
      const failing = makeService({ query: (...args) => pool.query(...args), connect: async () => {
        const client = await pool.connect();
        return { query: async (sql, values) => {
          const result = await client.query(sql, values);
          if (!injected && String(sql).startsWith(`INSERT INTO ${table}`)) {
            injected = true; await client.query('SELECT 1/0');
          }
          return result;
        }, release: error => client.release(error) };
      } });
      await assert.rejects(failing.materializeCalculationEntry({ userId: ids.owner, venueId: ids.venue }, committedBody.runId,
        { employeeId: ids.employee, financeCategoryId: null, idempotencyKey: `bridge-fault-${table}` }), e => e.code === '22012');
      assert.equal(injected, true);
      assert.deepEqual(await bridgeCounts(), beforeBridge, 'entry and request journal roll back together');
    }
    const staleBridge = await page.request.post(`${base}/api/payroll/calculation-runs/${runId}/entries`, { headers,
      data: { employeeId: ids.employee, financeCategoryId: null, idempotencyKey: 'browser-stale-entry' } });
    assert.equal(staleBridge.status(), 409);
    assert.equal((await staleBridge.json()).error, 'payroll_entry_calculation_sources_changed');
    assert.equal((await page.request.post(bridgeUrl, { headers, data: {
      employeeId: ids.employee, financeCategoryId: null, idempotencyKey: 'browser-forged-entry', amount: 1
    } })).status(), 400);
    let entryIntent, entryCreated;
    await page.route(bridgeUrl, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      entryIntent = route.request().postDataJSON();
      const response = await route.fetch();
      assert.equal(response.status(), 201, await response.text());
      entryCreated = await response.json();
      await route.abort('failed');
    }, { times: 1 });
    await page.locator(`[data-saved-entry-create="${ids.employee}"]`).click();
    await page.locator('[data-saved-entry-status]').filter({ hasText: /повтор|ключ/i }).waitFor();
    assert.ok(entryCreated?.entry?.id && entryIntent?.idempotencyKey);
    assert.equal(entryCreated.entry.amountCents, 1000);
    assert.deepEqual(await bridgeCounts(), { entries: beforeBridge.entries + 1, requests: beforeBridge.requests + 1, expenses: beforeBridge.expenses });
    // The ordinary API must reject linked approval/payment before financial writes.
    const entryUrl = `${base}/api/payroll/entries/${entryCreated.entry.id}`;
    for (const action of ['approve', 'pay']) {
      const denied = await page.request.patch(entryUrl, { headers, data: { action, paymentDate: period.to,
        paymentAccountId: ids.account, paymentMethod: 'card' } });
      assert.equal(denied.status(), 409);
      assert.equal((await denied.json()).error, 'payroll_calculation_entry_owner_transition_required');
    }
    const entryRetry = await page.request.post(bridgeUrl, { headers, data: entryIntent });
    assert.equal(entryRetry.status(), 200);
    const retriedEntry = await entryRetry.json();
    assert.deepEqual(retriedEntry, { ...entryCreated, replayed: true });
    await openSaved();
    await page.locator(`[data-saved-run-open="${committedBody.runId}"]`).click();
    await page.locator(`[data-saved-entry-employee="${ids.employee}"]`).filter({ hasText: /черновик/i }).waitFor();
    assert.equal(await page.locator(`[data-saved-entry-create="${ids.employee}"]`).count(), 0, 'reload discovers the committed entry');
    const registerEntry = await page.request.get(entryUrl);
    const registered = await registerEntry.json();
    assert.equal(registered.calculationRunId, committedBody.runId);
    assert.equal(registered.userName, entryCreated.entry.employeeName, 'register uses frozen employee name');
    assert.equal(registered.hours, null, 'current attendance is not presented as saved evidence');
    assert.deepEqual(registered.allowedActions, []);
    assert.equal(registered.transitionStateRequired, true);
    // Follow the actual UI link into the existing register and cancel there.
    await page.locator(`[data-saved-entry-register="${entryCreated.entry.id}"]`).click();
    const registerRow = page.locator(`[data-payroll-entry="${entryCreated.entry.id}"]`);
    await registerRow.waitFor({ state: 'visible' });
    assert.equal(await registerRow.locator('[data-payroll-action="approve"],[data-payroll-action="pay"]').count(), 0);
    assert.match(await registerRow.innerText(), /По сохранённому расчёту/);
    assert.doesNotMatch(await registerRow.innerText(), /Отработано:/);
    const stateResponse = page.waitForResponse(r => r.url() === `${base}/api/payroll/calculation-entries/${entryCreated.entry.id}/state`);
    await registerRow.locator('[data-payroll-linked-check]').click();
    assert.equal((await stateResponse).status(), 200);
    await registerRow.locator('[data-payroll-cancel-open]').click();
    await registerRow.locator('[data-payroll-cancel-reason]').fill('Owner cancels QA draft');
    const cancelledResponse = page.waitForResponse(r => r.url() === `${base}/api/payroll/calculation-entries/${entryCreated.entry.id}/transition` && r.request().method() === 'POST');
    await registerRow.locator('[data-payroll-action="cancel"]').click();
    assert.equal((await cancelledResponse).status(), 200);
    const cancelledReplay = await page.request.post(bridgeUrl, { headers, data: entryIntent });
    const cancelledResult = await cancelledReplay.json();
    assert.equal(cancelledResult.entry.status, 'draft', 'original response stays historical');
    assert.equal(cancelledResult.currentEntry.status, 'cancelled', 'current state is explicit');
    assert.deepEqual(cancelledResult.currentEntry.allowedActions, []);
    const otherKey = await page.request.post(bridgeUrl, { headers, data: { ...entryIntent, idempotencyKey: 'browser-existing-cancelled' } });
    assert.equal(otherKey.status(), 200);
    assert.equal((await otherKey.json()).entry.status, 'cancelled');
    const lifecycle = await verifyCalculationEntryLifecycle({ page, pool, base, headers, ids, period, versionId });
    await openSaved();
    await page.locator(`[data-saved-run-open="${committedBody.runId}"]`).click();
    await page.locator(`[data-saved-entry-employee="${ids.employee}"]`).filter({ hasText: /отмен/i }).waitFor();
    await page.locator(`[data-saved-employee="${ids.employee}"]`).click();
    await page.locator(`[data-saved-day="${dayId}"]`).click();
    await page.locator('[data-saved-lines]').getByText('Historical tea', { exact: true }).waitFor();
    await insertLateRefundFixture();
    if (refundAwareRuns) {
      assert.equal(typeof refundAwareRuns, 'function', 'v2 run IDs resolve after the late-return fixture completes');
      const cases = await refundAwareRuns();
      assert.ok(Array.isArray(cases) && cases.length > 0, 'explicit persisted v2 browser cases required');
      for (const planned of cases) await verifyRefundAwareSavedRunBrowser({ ...planned,
        page, api: page.request, base, headers, employeeId: ids.employee, openSaved });
      // Preserve the existing v1 paid/review sequence and its historical sale
      // selection after the independent read-only v2 browser checks.
      await openSaved();
      await page.locator(`[data-saved-run-open="${committedBody.runId}"]`).click();
      await page.locator(`[data-saved-entry-employee="${ids.employee}"]`).filter({ hasText: /отмен/i }).waitFor();
      await page.locator(`[data-saved-employee="${ids.employee}"]`).click();
      await page.locator(`[data-saved-day="${dayId}"]`).click();
      await page.locator('[data-saved-lines]').getByText('Historical tea', { exact: true }).waitFor();
    }
    const paidReplay = await page.request.post(lifecycle.transitionUrl, { headers, data: lifecycle.payCommand });
    assert.equal(paidReplay.status(), 200, await paidReplay.text());
    assert.equal((await paidReplay.json()).entry.expenseId, lifecycle.expenseId, 'retry after later refund preserves paid settlement');
    const staleDecision = await page.request.post(`${base}/api/payroll/refund-reviews/${beforeReturnReview.caseId}/decisions`, {
      headers, data: { decision: 'acknowledge_no_effect', reason: 'Stale zero cannot be accepted',
        expectedAssessmentHash: beforeReturnReview.latestAssessment.assessmentHash, idempotencyKey: 'browser-review-stale-zero' }
    });
    assert.equal(staleDecision.status(), 409);
    const afterReturnReview = await checkRefunds();
    assert.equal(afterReturnReview.latestAssessment.payload.impactCents, -1000, JSON.stringify(afterReturnReview.latestAssessment.payload));
    assert.equal(afterReturnReview.latestAssessment.payload.lines[0].merchandiseDeltaCents, -10000);
    assert.equal(await page.locator('[data-refund-review-decision] option[value="acknowledge_no_effect"]').count(), 0);
    const reviewReason = 'Owner checks <script>no execution</script> return impact';
    await page.locator('[data-refund-review-reason]').fill(reviewReason);
    const decisionUrl = `${base}/api/payroll/refund-reviews/${afterReturnReview.caseId}/decisions`;
    const heldResponse = page.waitForResponse(r => r.url() === decisionUrl && r.request().method() === 'POST');
    await page.locator('[data-refund-review-decide]').click();
    const heldReceived = await heldResponse;
    assert.equal(heldReceived.status(), 201, await heldReceived.text());
    const heldRequest = heldReceived.request().postDataJSON();
    const heldBody = await heldReceived.json();
    assert.equal(heldBody.status, 'hold_for_review');
    const replayedDecision = await page.request.post(decisionUrl, { headers, data: heldRequest });
    assert.equal(replayedDecision.status(), 200);
    assert.deepEqual(await replayedDecision.json(), { ...heldBody, replayed: true });
    await openSaved();
    await page.locator(`[data-saved-run-open="${committedBody.runId}"]`).click();
    await page.locator('[data-refund-review-content]').getByText(reviewReason, { exact: false }).waitFor({ state: 'attached' });
    assert.equal(await page.locator('[data-refund-review-content] script').count(), 0);
    const storedReview = (await pool.query(`SELECT d.reason,a.impact_cents::text FROM payroll_refund_review_decisions d
      JOIN payroll_refund_review_assessments a ON a.venue_id=d.venue_id AND a.id=d.assessment_id WHERE d.venue_id=$1 AND d.case_id=$2`,
    [ids.venue, afterReturnReview.caseId])).rows;
    assert.deepEqual(storedReview, [{ reason: reviewReason, impact_cents: '-1000' }]);
    // Restore day detail for the existing viewport/readability checks.
    await page.locator(`[data-saved-employee="${ids.employee}"]`).click();
    await page.locator(`[data-saved-day="${dayId}"]`).click();
    await page.locator('[data-saved-lines]').getByText('Historical tea', { exact: true }).waitFor();
    await checkFreshness(committedBody.runId, 'blocked', 'исходные данные требуют проверки');
    await page.locator('[data-saved-freshness-status]').filter({ hasText: 'возвраты' }).waitFor();
    assert.equal(await page.locator('[data-saved-lines]').innerText(), detailBeforeRefund, 'saved sale evidence remains unchanged after refund');
    const artifacts = path.join(root, 'tmp', 'payroll-saved-runs-qa', `${Date.now()}-${process.pid}`);
    mkdirSync(artifacts, { recursive: true });
    for (const width of [1440, 768, 390, 344]) {
      await page.setViewportSize({ width, height: 1000 });
      const dimensions = await page.locator('[data-scheme-pane="saved"]').evaluate(node => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, viewport: innerWidth };
      });
      assert.ok(dimensions.left >= 0 && dimensions.right <= dimensions.viewport + 1, `saved pane stays in viewport ${width}`);
      await page.locator('[data-scheme-pane="saved"]').evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.screenshot({ path: path.join(artifacts, `saved-${width}.png`) });
      await page.locator('[data-saved-run-freshness]').evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
      const freshnessDimensions = await page.locator('[data-saved-run-freshness]').evaluate(node => {
        const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, viewport: innerWidth };
      });
      assert.ok(freshnessDimensions.left >= 0 && freshnessDimensions.right <= freshnessDimensions.viewport + 1);
      await page.screenshot({ path: path.join(artifacts, `freshness-${width}.png`) });
      await page.locator('[data-refund-review-panel]').evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.screenshot({ path: path.join(artifacts, `refund-review-${width}.png`) });
      const reviewBounds = await page.locator('[data-refund-review-panel]').evaluate(node => {
        const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, viewport: innerWidth };
      });
      assert.ok(reviewBounds.left >= 0 && reviewBounds.right <= reviewBounds.viewport + 1, `review panel width ${width}`);
      await page.locator('[data-saved-lines]').evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.screenshot({ path: path.join(artifacts, `lines-${width}.png`) });
      assert.ok(await page.locator('[data-saved-run-table]').first().evaluate(node => node.getBoundingClientRect().width >= 560),
        'tables retain readable columns inside their own horizontal scroll region');
    }
    const decisionSelect = page.locator('[data-refund-review-decision]');
    const decisionTrigger = decisionSelect.locator('..').locator('.custom-select-trigger');
    if (await decisionTrigger.count()) {
      await decisionTrigger.click();
      await decisionSelect.locator('..').locator('[data-value="close_without_payroll_change"]').click();
    } else await decisionSelect.selectOption('close_without_payroll_change');
    await page.locator('[data-refund-review-reason]').fill('Owner closes comparison without changing salary');
    const closedResponse = page.waitForResponse(r => r.url() === decisionUrl && r.request().method() === 'POST');
    await page.locator('[data-refund-review-decide]').click();
    const closedReceived = await closedResponse;
    assert.equal(closedReceived.status(), 201, await closedReceived.text());
    await page.locator('[data-refund-review-content]').getByText('Решение по этой проверке записано.', { exact: false }).waitFor();
    await openSaved();
    await page.locator(`[data-saved-run-open="${committedBody.runId}"]`).click();
    await page.locator('[data-refund-review-content]').getByText('Решение по этой проверке записано.', { exact: false }).waitFor();
    assert.equal(await page.locator('[data-refund-review-decide]').count(), 0, 'terminal decision survives reload');
    const correctionCommand = await verifyPaidCorrectionWaiver({ page, pool, base, headers, ids, lifecycle, openSaved, correctionTarget });
    assert.deepEqual(errors, [], 'browser has no JS errors');
    const foreignVenue = randomUUID(), foreignOwner = randomUUID();
    await pool.query("INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,'Foreign saved-run QA','UTC')", [foreignVenue, ids.org]);
    await pool.query("INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role) VALUES($1,$2,$3,'Foreign owner',$4,$5,'owner')",
      [foreignOwner, foreignVenue, ids.org, `verified-${foreignOwner}`, hash]);
    await pool.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active')", [ids.org, foreignOwner]);
    for (const [userId, expected] of [[ids.employee, 403], [foreignOwner, 404]]) {
      const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: `verified-${userId}`, password }) });
      assert.equal(login.status, 200);
      const session = await login.json();
      const response = await fetch(`${base}/api/payroll/calculation-runs/${runId}`, {
        headers: { authorization: `Bearer ${session.token}`, 'X-Organization-Id': ids.org }
      });
      assert.equal(response.status, expected, 'staff and other tenant cannot read saved payroll');
      const deniedReplay = await fetch(`${base}/api/payroll/calculation-runs/${runId}/replay`, {
        method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'X-Organization-Id': ids.org,
          'content-type': 'application/json' }, body: '{}'
      });
      assert.equal(deniedReplay.status, expected, 'staff and other tenant cannot replay saved payroll');
      const deniedFreshness = await fetch(`${base}/api/payroll/calculation-runs/${runId}/freshness`, {
        method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'X-Organization-Id': ids.org,
          'content-type': 'application/json' }, body: '{}'
      });
      assert.equal(deniedFreshness.status, expected, 'staff and other tenant cannot inspect source freshness');
      for (const [path, method, data] of [
        [`/api/payroll/calculation-entries/${lifecycle.entryId}/state`, 'GET', null],
        [`/api/payroll/calculation-entries/${lifecycle.entryId}/transition`, 'POST', lifecycle.payCommand],
        [`/api/payroll/calculation-entries/${lifecycle.entryId}/corrections`, 'GET', null],
        ['/api/payroll/reviewed-corrections/preview', 'POST', { operation: 'waive', originalEntryId: lifecycle.entryId, targetEntryId: null }],
        ['/api/payroll/reviewed-corrections', 'POST', correctionCommand],
        [`/api/payroll/calculation-runs/${runId}/entries`, 'GET', null],
        [`/api/payroll/calculation-runs/${runId}/entries`, 'POST', { employeeId: ids.employee, financeCategoryId: null, idempotencyKey: 'browser-forbidden-entry' }],
        [`/api/payroll/refund-reviews/${afterReturnReview.caseId}`, 'GET', null],
        [`/api/payroll/calculation-runs/${runId}/refund-reviews`, 'POST', { idempotencyKey: 'browser-forbidden-review' }],
        [`/api/payroll/refund-reviews/${afterReturnReview.caseId}/decisions`, 'POST', heldRequest]
      ]) {
        const denied = await fetch(base + path, { method, headers: { authorization: `Bearer ${session.token}`,
          'X-Organization-Id': ids.org, 'content-type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
        assert.equal(denied.status, expected, 'staff/foreign tenant cannot access saved-run writes/reads');
      }
    }
    if (supersessionSourcePolicies) {
      const { seedUnpaidSupersessionFixture } = await import('./payroll-unpaid-supersession-fixture.mjs');
      const { verifyUnpaidSupersessionBrowser } = await import('./payroll-unpaid-supersession-browser-helper.mjs');
      const paidPeriod = (await pool.query(`SELECT (date_trunc('month',CURRENT_DATE)-interval '2 months')::date::text AS "from",
        (date_trunc('month',CURRENT_DATE)-interval '1 month'-interval '1 day')::date::text AS "to"`)).rows[0];
      for (const mode of ['supersession', 'paid']) {
      const fixture = await seedUnpaidSupersessionFixture({ pool, period: mode === 'paid' ? paidPeriod : period,
        sourcePolicies: supersessionSourcePolicies, withTarget: mode === 'paid' });
      await pool.query('UPDATE users SET password_hash=$1 WHERE venue_id=$2', [hash, fixture.ids.venue]);
      await pool.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'active') ON CONFLICT(organization_id) DO UPDATE SET status='active'", [fixture.ids.org]);
      const supersessionPage = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
      try {
        await supersessionPage.route(`${base}/api/**`, async route => {
          const now = Date.now(), scheduled = Math.max(now, nextBrowserRequestAt);
          nextBrowserRequestAt = scheduled + 150;
          if (scheduled > now) await new Promise(resolve => setTimeout(resolve, scheduled - now));
          await route.continue();
        });
        await supersessionPage.goto(`${base}/login`, { waitUntil: 'networkidle' });
        await supersessionPage.locator('#login-username').fill(`verified-${fixture.ids.owner}`);
        await supersessionPage.locator('#login-password').fill(password);
        await supersessionPage.locator('#login-form button[type="submit"]').click();
        await supersessionPage.waitForURL(url => !url.pathname.includes('/login'));
        if (mode === 'supersession') await verifyUnpaidSupersessionBrowser({ page: supersessionPage, base, pool, fixture, headers });
        else {
          const { verifyRefundAwarePublicBrowser } = await import('./payroll-refund-aware-public-browser-helper.mjs');
          const deniedTokens=[];
          for(const userId of [fixture.ids.employee,foreignOwner]) {
            const login=await fetch(`${base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({username:`verified-${userId}`,password})});assert.equal(login.status,200);
            const session=await login.json();deniedTokens.push({origin:base,authorization:`Bearer ${session.token}`,'X-Organization-Id':ids.org});
          }
          // Staff belongs to the new fixture's organization; the foreign owner
          // deliberately stays in the original browser fixture's organization.
          deniedTokens[0]['X-Organization-Id']=fixture.ids.org;
          await verifyRefundAwarePublicBrowser({ page: supersessionPage, base, pool, fixture, headers,
            staffHeaders:deniedTokens[0],foreignHeaders:deniedTokens[1] });
        }
      } finally { await supersessionPage.close(); }
      }
    }
    console.log(`PASS saved-run authenticated HTTP/browser: real run→draft, lost response/reload, cancellation/replay, owner lifecycle approval/pay with generic-path rejection, atomic rollback; refund check→owner hold/close→DB→reload, stale and exact replay, escaped reasons, roles/tenant, four widths; artifacts ${artifacts}`);
  } finally {
    await browser?.close();
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit'); server.kill(); await exited;
    }
  }
};
