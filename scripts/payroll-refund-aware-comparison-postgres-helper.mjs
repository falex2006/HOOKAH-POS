import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const { makeService } = require('../payroll-scheme-service');
// Request-time closure evidence may differ between read transactions. Compare
// monetary results and immutable source identities, not incidental as-of data.
const comparableResult = payload => ({
  sharedSource: Object.fromEntries(['timezone', 'recognitionManifestWatermark', 'economicsSourceWatermark', 'eligibilityWatermark']
    .map(key => [key, payload.sharedSource[key]])),
  results: payload.results.map(row => ({ versionId: row.versionId, mode: row.mode, policyFamily: row.policyFamily,
    status: row.status, reasons: row.reasons, amountCents: row.amountCents,
    employees: row.employees, deltaCents: row.deltaCents, employeeDeltas: row.employeeDeltas }))
});

// Hash complete sorted rows, including existing immutable payloads. Counts alone
// would miss a compare accidentally rewriting an old run, claim or source atom.
export async function captureComparisonDatabaseState(pool, venueId) {
  const tables = (await pool.query(`SELECT DISTINCT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='venue_id' AND
      (table_name LIKE 'payroll\\_%' ESCAPE '\\' OR table_name LIKE 'staff\\_%' ESCAPE '\\'
       OR table_name LIKE 'pos\\_%' ESCAPE '\\' OR table_name IN
       ('orders','order_refunds','order_refund_items','order_refund_tenders','stock_movements',
        'order_costs','expenses','products','ingredients','finance_balance_events')) ORDER BY table_name`)).rows;
  const state = {};
  for (const { table_name: table } of tables) {
    assert.match(table, /^[a-z0-9_]+$/);
    const { rows } = await pool.query(`SELECT to_jsonb(t)::text AS payload FROM public."${table}" t
      WHERE venue_id=$1 ORDER BY to_jsonb(t)::text`, [venueId]);
    state[table] = { rows: rows.length, sha256: sha(JSON.stringify(rows.map(row => row.payload))) };
  }
  // These child tables use order_id rather than a direct tenant column.
  for (const table of ['order_items', 'payments']) {
    const { rows } = await pool.query(`SELECT to_jsonb(t)::text AS payload FROM public."${table}" t
      JOIN orders o ON o.id=t.order_id WHERE o.venue_id=$1 ORDER BY to_jsonb(t)::text`, [venueId]);
    state[table] = { rows: rows.length, sha256: sha(JSON.stringify(rows.map(row => row.payload))) };
  }
  return state;
}

// Observe the real service connection without adding a product hook or mutating
// the shared pool. The source capability is registered against this same proxy.
export async function compareWithSqlProof(pool, owner, input, { expectedOrderIds } = {}) {
  const queries = [];
  const record = async (query, values, execute) => {
    const sql = typeof query === 'string' ? query : query.text;
    queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), values: structuredClone(values || query.values || []) });
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i, 'compare SQL must be read-only');
    return execute();
  };
  const wrapped = { query: (...args) => record(args[0], args[1], () => pool.query(...args)),
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, { get(target, key) {
        if (key === 'query') return (...args) => record(args[0], args[1], () => target.query(...args));
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } };
  const result = await makeService(wrapped).compareSourced(owner, input);
  assert.equal(queries.filter(({sql}) => /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/.test(sql)).length, 1);
  assert.equal(queries.filter(({sql}) => /^SAVEPOINT payroll_manifest_/.test(sql)).length, 1,
    'all schemes share exactly one physical recognition manifest collection');
  assert.equal(queries.filter(({sql}) => /FROM pos_payroll_recognition_epochs WHERE venue_id=\$1/.test(sql)).length, 1);
  for (const [family, pattern, params] of [
    ['eligibility revision', /FROM payroll_employment_eligibility_revisions WHERE venue_id=\$1 ORDER BY revision_no DESC LIMIT 1/,
      [owner.venueId]],
    ['department revision', /FROM payroll_product_department_revisions WHERE venue_id=\$1 ORDER BY revision_no DESC LIMIT 1/,
      [owner.venueId]],
    ['attendance approval', /SELECT id FROM payroll_attendance_approvals WHERE venue_id=\$1 AND period_from=\$2::date AND period_to=\$3::date ORDER BY revision DESC LIMIT 1/,
      [owner.venueId,input.periodFrom,input.periodTo]]
  ]) {
    const reads = queries.filter(({sql}) => pattern.test(sql));
    assert.equal(reads.length, 1, `union source family ${family} is physically collected once`);
    assert.deepEqual(reads[0].values, params, `${family} uses the same tenant/period`);
  }
  const costReads = queries.filter(({sql}) => /SELECT e\.payload,e\.watermark,/.test(sql)
    && /FROM orders o LEFT JOIN pos_sale_cost_evidence e/.test(sql));
  assert.ok(costReads.length > 0, 'all-mode comparison collects immutable cost187 producer evidence');
  const orderCounts = new Map();
  for (const {values} of costReads) {
    assert.equal(values[0], owner.venueId);
    assert.equal(values.length, 2);
    orderCounts.set(values[1], (orderCounts.get(values[1]) || 0) + 1);
  }
  assert.ok([...orderCounts.values()].every(count => count === 1), 'each original order cost payload is read once');
  if (expectedOrderIds) assert.deepEqual([...orderCounts.keys()].sort(), [...expectedOrderIds].sort());
  assert.equal(queries.filter(({sql}) => /^COMMIT$/.test(sql)).length, 1);
  return result;
}

export function assertRefundAwareComparison(payload, { ids, period, versions, expectedByMode, stage, baselineVersionId }) {
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.comparisonKind, 'sourced_candidate_v2');
  for (const key of ['candidateOnly', 'nonPayable', 'nonAccrual']) assert.equal(payload[key], true, key);
  for (const key of ['officialReady', 'payoutEligible']) assert.equal(payload[key], false, key);
  assert.equal(payload.persistence, 'none');
  assert.equal(payload.venueId, ids.venue);
  assert.equal(payload.currency, 'RUB');
  assert.equal(payload.period.from, period.from); assert.equal(payload.period.to, period.to);
  assert.equal(payload.baselineVersionId, baselineVersionId);
  assert.match(payload.sharedSourceWatermark, hashPattern);
  assert.match(payload.sharedSource.recognitionManifestWatermark, hashPattern);
  assert.match(payload.sharedSource.economicsSourceWatermark, hashPattern);
  assert.match(payload.sharedSource.eligibilityWatermark, hashPattern);
  assert.equal(payload.results.length, versions.size);
  assert.deepEqual([...new Set(payload.results.map(row => row.versionId))].sort(), [...versions.values()].sort());
  const baselineMode = [...versions].find(([, id]) => id === baselineVersionId)[0];
  const baseline = expectedByMode(baselineMode, stage);
  for (const [mode, versionId] of versions) {
    const row = payload.results.find(row => row.versionId === versionId), expected = expectedByMode(mode, stage);
    assert.equal(row.mode, mode); assert.equal(row.status, 'ready', `${mode}/${stage}: ${JSON.stringify(row.reasons)}`);
    assert.equal(row.policyFamily, 'refund_aware_v2'); assert.deepEqual(row.reasons, []);
    assert.equal(row.amountCents, expected[0] + expected[1]);
    assert.match(row.inputWatermark, hashPattern);
    assert.ok(row.sourceWatermarks && typeof row.sourceWatermarks === 'object');
    assert.deepEqual([ids.employee, ids.zeroEmployee].map(id => row.employees.find(e => e.employeeId === id)?.amountCents), expected);
    assert.equal(row.deltaCents, row.amountCents - baseline[0] - baseline[1]);
    assert.equal(row.employeeDeltas.length, 2);
    for (const [index, employeeId] of [ids.employee, ids.zeroEmployee].entries()) {
      const delta = row.employeeDeltas.find(e => e.employeeId === employeeId);
      assert.equal(delta.status, 'comparable'); assert.equal(delta.amountCents, expected[index]);
      assert.equal(delta.baselineAmountCents, baseline[index]); assert.equal(delta.deltaCents, expected[index] - baseline[index]);
    }
    const evidence = row.candidateEvidence;
    assert.equal(evidence.schemaVersion, 2); assert.equal(evidence.venueId, ids.venue);
    assert.equal(evidence.schemeVersionId, versionId); assert.equal(evidence.currency, 'RUB');
    assert.equal(evidence.period.from, period.from); assert.equal(evidence.period.to, period.to);
    assert.equal(evidence.sharedSourceWatermark, payload.sharedSourceWatermark);
    assert.equal(evidence.amountCents, row.amountCents); assert.equal(evidence.inputWatermark, row.inputWatermark);
    assert.match(evidence.calculationWatermark, hashPattern);
    assert.equal(evidence.officialReady, false); assert.equal(evidence.payoutEligible, false);
    assert.equal(evidence.sourceAttested, false);
    for (const key of ['candidateOnly', 'nonPayable', 'nonAccrual']) assert.equal(evidence[key], true, key);
    assert.equal(evidence.persistence, 'none');
  }
}

// Reuse the parent's actual all-mode tenant and its original/returned sales.
// Only authentication is prepared here; no business fixture or monetary row is seeded.
export async function createRefundAwareComparisonProbe({ pool, target, fixture, period, versions, legacyVersionId, legacyVersions, expectedByMode }) {
  assert.ok(target?.url, 'parent passes its owned disposable database target');
  assert.equal(target.database, process.env.LOCAL_FULL_PG_OWNED_DATABASE);
  const { ids, owner } = fixture;
  const password = randomBytes(18).toString('hex'), salt = randomBytes(16).toString('hex');
  const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=ANY($2::uuid[])', [passwordHash, [ids.owner, ids.employee]]);
  await pool.query(`INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'active')
    ON CONFLICT(organization_id) DO UPDATE SET status='active'`, [ids.org]);
  // Dedicated authentication-only tenant: never change another fixture owner's
  // password or seed orders, schemes, attendance, entries or expenses here.
  const foreign={org:randomUUID(),venue:randomUUID(),owner:randomUUID()};
  const foreignLogin=`comparison-foreign-${foreign.owner}`;
  await pool.query(`INSERT INTO organizations(id,name,slug,plan) VALUES($1,'Compare isolation auth QA',$2,'network')`,
    [foreign.org,`compare-auth-${foreign.org}`]);
  await pool.query(`INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,'Compare isolation auth QA','UTC')`,
    [foreign.venue,foreign.org]);
  await pool.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,role,password_hash)
    VALUES($1,$2,$3,'Compare foreign owner',$4,'owner',$5)`,
    [foreign.owner,foreign.venue,foreign.org,foreignLogin,passwordHash]);
  await pool.query(`INSERT INTO organization_memberships(organization_id,user_id,membership_role,status)
    VALUES($1,$2,'owner','active')`,[foreign.org,foreign.owner]);
  await pool.query(`INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'active')`,[foreign.org]);
  let server, browser, page, base, staffHeaders,foreignHeaders;
  const errors = [], stages = [], sourceWatermarks = [];
  const artifactDir = path.join(root, 'tmp', 'payroll-refund-aware-comparison', ids.venue);
  mkdirSync(artifactDir, { recursive: true });
  const close = async () => {
    try { if (browser) await browser.close(); }
    finally {
      if (server && server.exitCode === null && server.signalCode === null) {
        const exited = once(server, 'exit'); server.kill(); await exited;
      }
    }
  };
  try {
    server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true,
      env: { ...process.env, DATABASE_URL: target.url.href, VENUE_ID: ids.venue, AUTH_REQUIRED: 'true',
        DEMO_MODE: 'false', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Compare isolated server startup timed out')), 20000);
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(new Error(`Compare isolated server exited ${code}`)); });
      let output = '';
      server.stdout.on('data', chunk => { output += chunk; const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
      server.stderr.on('data', () => {});
    });
    const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
    let nextRequest = 0;
    await page.route(`${base}/api/**`, async route => {
      const now = Date.now(), scheduled = Math.max(now, nextRequest); nextRequest = scheduled + 150;
      if (scheduled > now) await new Promise(resolve => setTimeout(resolve, scheduled - now));
      await route.continue();
    });
    page.on('pageerror', error => errors.push(error.message));
    const staffLogin = await page.request.post(`${base}/api/login`, { headers: { origin: base },
      data: { username: `verified-${ids.employee}`, password } });
    assert.equal(staffLogin.status(), 200);
    staffHeaders = { origin: base, authorization: `Bearer ${(await staffLogin.json()).token}`, 'X-Organization-Id': ids.org };
    const foreignAuth=await page.request.post(`${base}/api/login`,{headers:{origin:base},data:{username:foreignLogin,password}});
    assert.equal(foreignAuth.status(),200);
    foreignHeaders={origin:base,authorization:`Bearer ${(await foreignAuth.json()).token}`,'X-Organization-Id':foreign.org};
    await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
    await page.locator('#login-username').fill(`verified-${ids.owner}`);
    await page.locator('#login-password').fill(password);
    await page.locator('#login-form button[type="submit"]').click();
    await page.waitForURL(url => !url.pathname.includes('/login'));
  } catch (error) { await close(); throw error; }

  return {
    async verifyStage(stage) {
      const baselineVersionId = versions.get('percent_only');
      const input = { versionIds: [...versions.values()], baselineVersionId, periodFrom: period.from, periodTo: period.to };
      const args = { ids, period, versions, expectedByMode, stage, baselineVersionId };
      const before = await captureComparisonDatabaseState(pool, ids.venue);
      const foreignBefore=await captureComparisonDatabaseState(pool,foreign.venue);
      assert.equal(foreignBefore.payroll_entries.rows,0);
      assert.equal(foreignBefore.expenses.rows,0);
      const direct = await compareWithSqlProof(pool, owner, input, { expectedOrderIds: [ids.order] });
      assertRefundAwareComparison(direct, args);
      const response = await page.request.post(`${base}/api/payroll/compare/sourced`, { headers: { origin: base }, data: input });
      assert.equal(response.status(), 200); const payload = await response.json();
      assertRefundAwareComparison(payload, args);
      assert.deepEqual(comparableResult(payload), comparableResult(direct), 'same immutable sources give identical service/HTTP economics');
      const retry = await page.request.post(`${base}/api/payroll/compare/sourced`, { headers: { origin: base }, data: input });
      assert.equal(retry.status(), 200); const repeated = await retry.json();
      assertRefundAwareComparison(repeated, args);
      assert.deepEqual(comparableResult(repeated), comparableResult(payload));
      const alternateBaseline = versions.get('team_fund');
      const alternate = await page.request.post(`${base}/api/payroll/compare/sourced`, { headers: { origin: base },
        data: { ...input, baselineVersionId: alternateBaseline, versionIds: [...input.versionIds].reverse() } });
      assert.equal(alternate.status(), 200);
      assertRefundAwareComparison(await alternate.json(), { ...args, baselineVersionId: alternateBaseline });
      const mixedResponse = await page.request.post(`${base}/api/payroll/compare/sourced`, { headers: { origin: base },
        data: { ...input, versionIds: [legacyVersionId, ...input.versionIds], baselineVersionId: legacyVersionId } });
      assert.equal(mixedResponse.status(), 200); const mixed = await mixedResponse.json();
      const mixedDirect = await compareWithSqlProof(pool, owner,
        { ...input, versionIds: [legacyVersionId, ...input.versionIds], baselineVersionId: legacyVersionId },
        { expectedOrderIds: [ids.order] });
      assert.deepEqual(comparableResult(mixed), comparableResult(mixedDirect));
      const legacy = mixed.results.find(row => row.versionId === legacyVersionId);
      assert.equal(legacy.policyFamily, 'legacy_v1');
      if (stage === 'initial') {
        assert.equal(legacy.status, 'ready', JSON.stringify(legacy.reasons));
        assert.equal(legacy.amountCents, 2000); assert.equal(legacy.deltaCents, 0);
      } else {
        assert.equal(legacy.status, 'blocked'); assert.equal(legacy.amountCents, null);
        assert.equal(legacy.candidateEvidence, null); assert.equal(legacy.deltaCents, null);
        assert.ok(legacy.reasons.length > 0);
      }
      for (const [mode, versionId] of versions) {
        const row = mixed.results.find(row => row.versionId === versionId);
        assert.equal(row.status, 'ready', JSON.stringify(row.reasons));
        assert.equal(row.amountCents, expectedByMode(mode, stage).reduce((a,b)=>a+b,0));
        assert.equal(row.deltaCents, null, 'different policy families have no implied monetary delta');
        assert.equal(row.employeeDeltas, null);
      }
      // Unlike the legacy percent control, these legacy candidates really use
      // department/team and immutable cost inputs. This catches a legacy branch
      // that silently rereads optional families or loses a previously ready path.
      const optionalModes = ['margin_target','team_fund'];
      const optionalInput = { ...input, versionIds: [
        ...optionalModes.map(mode => legacyVersions.get(mode)),
        ...optionalModes.map(mode => versions.get(mode)), baselineVersionId
      ] };
      const optionalDirect = await compareWithSqlProof(pool, owner, optionalInput, { expectedOrderIds:[ids.order] });
      const optionalResponse = await page.request.post(`${base}/api/payroll/compare/sourced`,
        { headers:{origin:base},data:optionalInput });
      assert.equal(optionalResponse.status(),200); const optionalMixed = await optionalResponse.json();
      assert.deepEqual(comparableResult(optionalMixed),comparableResult(optionalDirect));
      assert.equal(optionalMixed.results.length,5);
      for (const mode of optionalModes) {
        const legacyRow = optionalMixed.results.find(row => row.versionId === legacyVersions.get(mode));
        assert.equal(legacyRow.policyFamily,'legacy_v1');
        assert.equal(legacyRow.deltaCents,null); assert.equal(legacyRow.employeeDeltas,null);
        if (stage === 'initial') {
          assert.equal(legacyRow.status,'ready',`legacy ${mode} no-refund optional source regression: ${JSON.stringify(legacyRow.reasons)}`);
          assert.equal(legacyRow.amountCents,expectedByMode(mode,stage).reduce((sum,value)=>sum+value,0));
          assert.deepEqual([ids.employee,ids.zeroEmployee].map(id=>legacyRow.employees.find(row=>row.employeeId===id)?.amountCents),
            expectedByMode(mode,stage));
        } else {
          assert.equal(legacyRow.status,'blocked'); assert.equal(legacyRow.amountCents,null);
          assert.equal(legacyRow.candidateEvidence,null);
          assert.ok(legacyRow.reasons.some(reason=>/no_refund|signed_refund|refund/.test(reason)),
            `legacy ${mode} must be blocked by actual refund evidence: ${JSON.stringify(legacyRow.reasons)}`);
        }
        const v2Row = optionalMixed.results.find(row=>row.versionId===versions.get(mode));
        assert.equal(v2Row.status,'ready',JSON.stringify(v2Row.reasons));
        assert.equal(v2Row.amountCents,expectedByMode(mode,stage).reduce((sum,value)=>sum+value,0));
        assert.equal(v2Row.deltaCents,v2Row.amountCents-expectedByMode('percent_only',stage).reduce((sum,value)=>sum+value,0));
      }
      const denied = await page.request.post(`${base}/api/payroll/compare/sourced`, { headers: staffHeaders, data: input });
      assert.equal(denied.status(), 403);
      const foreignDenied=await page.request.post(`${base}/api/payroll/compare/sourced`,{headers:foreignHeaders,data:input});
      assert.equal(foreignDenied.status(),404,'foreign owner cannot load these saved versions for comparison');
      const foreignBody=await foreignDenied.json();
      assert.equal(Object.hasOwn(foreignBody,'results'),false,'tenant denial never exposes comparison data');
      const wrongOrigin = await page.request.post(`${base}/api/payroll/compare/sourced`, { headers: { origin: 'https://foreign.invalid' }, data: input });
      assert.equal(wrongOrigin.status(), 403);
      await page.goto(`${base}/finance#payroll`, { waitUntil: 'networkidle' });
      const settings = page.getByText('Настройки схем и проверка расчётов', { exact: true });
      if (!(await settings.locator('..').evaluate(node => node.open))) await settings.click();
      await page.locator('[data-scheme-workspace="list"]').first().click();
      await page.locator('[data-scheme-compare-version]').first().waitFor();
      for (const versionId of versions.values()) await page.locator(`[data-scheme-compare-version="${versionId}"]`).check();
      await page.locator('[data-scheme-workspace="checks"]').first().click();
      const disclosure = page.locator('[data-source-readiness-from]').locator('xpath=ancestor::details[1]');
      if (!(await disclosure.evaluate(node => node.open))) await disclosure.locator(':scope > summary').click();
      await page.locator('[data-source-readiness-from]').fill(period.from);
      await page.locator('[data-source-readiness-to]').fill(period.to);
      const baselineSelect = page.locator('[data-source-comparison-baseline]');
      const baselineWrapper = baselineSelect.locator('..');
      const baselineTrigger = baselineWrapper.locator('.custom-select-trigger');
      if (await baselineTrigger.count() && await baselineTrigger.isVisible()) {
        // Opening a menu at the viewport edge can scroll its focused option and
        // move the trigger offscreen. Bring the control into the working area
        // before opening; select only through the actual visible option button.
        await baselineTrigger.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
        await baselineTrigger.click();
        const option = baselineWrapper.locator(`[data-value="${baselineVersionId}"]`);
        try {
          await option.waitFor({ state: 'visible', timeout: 3000 });
          assert.equal(await baselineTrigger.getAttribute('aria-expanded'), 'true');
          await option.click();
        } catch (error) {
          const geometry = await baselineWrapper.evaluate(wrapper => {
            const rect = node => { const r = node.getBoundingClientRect(); return { top:r.top,bottom:r.bottom,left:r.left,right:r.right }; };
            const menu = wrapper.querySelector('.custom-select-menu');
            return { open:wrapper.classList.contains('is-open'),viewport:{width:innerWidth,height:innerHeight},
              wrapper:rect(wrapper),menu:rect(menu),display:getComputedStyle(menu).display,
              position:getComputedStyle(menu).position,maxHeight:getComputedStyle(menu).maxHeight,
              scrollHeight:menu.scrollHeight,scrollTop:menu.scrollTop };
          });
          console.log(`Comparison baseline menu failure geometry: ${JSON.stringify(geometry)}`);
          await page.screenshot({ path:path.join(artifactDir,`${stage}-baseline-menu-failure.png`),fullPage:true });
          throw error;
        }
      } else await baselineSelect.selectOption(baselineVersionId);
      const pending = page.waitForResponse(response => response.url().endsWith('/api/payroll/compare/sourced') && response.request().method() === 'POST');
      await page.locator('[data-source-comparison-run]').click();
      const uiResponse = await pending; assert.equal(uiResponse.status(), 200);
      assertRefundAwareComparison(await uiResponse.json(), args);
      await page.locator('[data-sourced-comparison-heading]').waitFor();
      assert.match(await page.locator('[data-sourced-comparison-candidate-only]').innerText(), /не создаёт (?:ведомость|начисление), расход или выплату/);
      if (stage === 'partial') for (const width of [1440, 768, 390, 344]) {
        await page.setViewportSize({ width, height: 1000 });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        assert.equal(overflow, false, `comparison viewport ${width}`);
        await page.screenshot({ path: path.join(artifactDir, `partial-${width}.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      assert.deepEqual(await captureComparisonDatabaseState(pool, ids.venue), before,
        `${stage}: compare cannot insert or rewrite payroll, Finance, attendance or immutable POS source rows`);
      assert.deepEqual(await captureComparisonDatabaseState(pool,foreign.venue),foreignBefore,
        `${stage}: rejected foreign-owner comparison cannot insert or rewrite tenant data`);
      assert.deepEqual(errors, []);
      if (sourceWatermarks.length) {
        assert.notEqual(payload.sharedSource.recognitionManifestWatermark, sourceWatermarks.at(-1).recognitionManifestWatermark,
          'actual return changes the immutable recognition manifest');
        assert.notEqual(payload.sharedSource.economicsSourceWatermark, sourceWatermarks.at(-1).economicsSourceWatermark,
          'actual return changes remaining merchandise economics');
      }
      sourceWatermarks.push(payload.sharedSource); stages.push(stage);
      console.log(`PASS refund-aware comparison ${stage}: seven actual-source modes, HTTP/UI, exact retry, source/ledger hashes unchanged`);
    },
    summary: () => ({ status: stages.length === 3 ? 'passed' : 'incomplete', stages: [...stages],
      outputs: stages.length * versions.size, costCase: 'actual_non_stock_known_zero', browserWidths: [1440, 768, 390, 344] }),
    close
  };
}
