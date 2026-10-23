// Called only by the guarded disposable worktime PostgreSQL harness.
// Real UI writes; only transport responses are fault-injected. Never runs standalone.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function planningWriteJourney({ browser, db, base, ids, logins, password, artifacts, check, errors }) {
  const http = [];
  const capture = async (response, stage) => { http.push({ stage, status: response.status(), payload: await response.json() }); fs.writeFileSync(path.join(artifacts, 'planning-write-http.json'), JSON.stringify(http, null, 2)); };
  const bounded = async (promise, label) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} did not start within 10 seconds`)), 10000); })]); } finally { clearTimeout(timer); } };
  const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const login = async (page, username) => { await page.goto(base + '/login'); await page.locator('#login-username').fill(username); await page.locator('#login-password').fill(password); await page.locator('#login-form button[type=submit]').click(); await page.waitForURL(url => url.pathname !== '/login'); };
  const geometry = async page => {
    const boxes = await page.locator('dialog[open]').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, overflow: node.scrollWidth > node.clientWidth + 1 }; }));
    check(boxes.length > 0 && boxes.every(box => box.left >= -1 && box.right <= page.viewportSize().width + 1 && !box.overflow), 'actual planning dialogs fit without hidden horizontal clipping');
  };
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'ru-RU', reducedMotion: 'reduce' });
    let releasePatch, releasePublish;
    try {
      const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
      await login(page, logins.owner); await page.goto(base + '/admin#staff-schedule'); await page.locator('[data-planning]').click(); await page.locator('[data-new-draft]').click();
      const create = page.locator('dialog[open]').filter({ has: page.locator('[name=periodPreset]') });
      const now = new Date(), day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, width === 390 ? 4 : 5)).toISOString().slice(0, 10);
      const name = `Проверка публикации ${width} ${ids.venue.slice(0, 8)}`, note = `Сохранить отметку ${width}`;
      await create.locator('[name=name]').fill(name); await create.locator('[name=from]').fill(day); await create.locator('[name=to]').fill(day); await create.locator(`[name=person][value="${ids.manager}"]`).check();
      const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/staff/schedule/drafts' && response.request().method() === 'POST');
      await create.locator('[data-submit]').click(); const created = await createdResponse; await capture(created, `create-${width}`);
      check(created.status() === 201, 'real draft creation follows documented route201');
      const createdRows = (await db.query('SELECT id,version,state,operations FROM staff_schedule_drafts WHERE venue_id=$1 AND name=$2', [ids.venue, name])).rows;
      check(createdRows.length === 1 && createdRows[0].state === 'open' && createdRows[0].operations.length === 0, 'one empty draft created by UI'); const draftId = createdRows[0].id, endpoint = `/api/staff/schedule/drafts/${draftId}`;
      const detail = () => page.locator('dialog[open]').filter({ has: page.locator('[data-draft-content]') });
      const editor = () => page.locator('dialog[open]').filter({ has: page.locator('[name=workDate]') });
      const publication = () => page.locator('dialog[open]').filter({ has: page.locator('[data-publish-content]') });
      await detail().locator('[data-new-op]').click(); await editor().locator('[name=userId]').selectOption(ids.manager); await editor().locator('[name=kind]').selectOption('day_off'); await editor().locator('[name=note]').fill(note);
      const patches = []; let firstPatch = true, failRead = false, patchStarted;
      const patchGate = new Promise(resolve => { releasePatch = resolve; }); const patchBegan = new Promise(resolve => { patchStarted = resolve; });
      const patchRoute = async route => {
        const request = route.request(), pathname = new URL(request.url()).pathname;
        if (pathname !== endpoint) return route.continue();
        if (request.method() === 'GET' && failRead) { failRead = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'schedule_unavailable' }) }); }
        if (request.method() !== 'PATCH') return route.continue();
        patches.push(request.postDataJSON());
        if (firstPatch) { firstPatch = false; patchStarted(); await patchGate; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'schedule_unavailable' }) }); }
        const response = await route.fetch({ timeout: 10000 }); await capture(response, `save-retry-${width}`); failRead = response.status() === 200; return route.fulfill({ response });
      };
      await page.route('**/api/staff/schedule/drafts/*', patchRoute);
      await editor().locator('[data-submit]').click(); await bounded(patchBegan, 'draft PATCH');
      await editor().locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await frames(page);
      check(patches.length === 1 && await editor().locator('[name=note]').isDisabled(), 'real draft save is singleflight with locked text');
      check((await db.query('SELECT operations FROM staff_schedule_drafts WHERE id=$1', [draftId])).rows[0].operations.length === 0, 'held failed save has not reached SQL');
      releasePatch(); await editor().locator('[data-error]').filter({ hasText: 'Сервис графика временно недоступен' }).waitFor();
      check(await editor().locator('[name=note]').inputValue() === note, 'real editor retains note after pre-request503');
      await editor().locator('[data-submit]').click(); await editor().waitFor({ state: 'detached' }); await detail().locator('[data-draft-retry]').waitFor();
      assert.deepEqual(patches[1], patches[0], 'same draft body/key on real retry');
      const saved = (await db.query('SELECT operations,version,state FROM staff_schedule_drafts WHERE id=$1', [draftId])).rows[0];
      check(saved.state === 'open' && saved.version === createdRows[0].version + 1 && saved.operations.length === 1 && saved.operations[0].payload.note === note, 'one exact draft operation persisted');
      check((await db.query('SELECT count(*)::int count FROM staff_schedules WHERE venue_id=$1 AND user_id=$2 AND work_date=$3::date', [ids.venue, ids.manager, day])).rows[0].count === 0, 'saving proposal does not create live schedule');
      check((await db.query('SELECT count(*)::int count FROM staff_schedule_requests WHERE venue_id=$1 AND actor_id=$2 AND request_key=$3', [ids.venue, ids.owner, patches[0].requestKey])).rows[0].count === 1, 'one save request receipt');
      await geometry(page); await page.screenshot({ path: path.join(artifacts, `planning-saved-read-failed-${width}.png`) });
      const patchCount = patches.length; await detail().locator('[data-draft-retry]').click(); await detail().locator('[data-edit-op="0"]').waitFor(); check(patches.length === patchCount, 'read retry never writes again');
      await detail().locator('[data-edit-op="0"]').click(); check(await editor().locator('[name=note]').inputValue() === note, 'actual saved note read back through editor'); await editor().locator('[data-close]').click(); await editor().waitFor({ state: 'detached' }); await page.unroute('**/api/staff/schedule/drafts/*', patchRoute);

      await detail().locator('[data-publish-preview]').click(); await publication().locator('[data-submit]').waitFor(); await publication().locator('[name=reason]').fill(`Локальная публикация ${width}`);
      const publishEndpoint = endpoint + '/publish', publications = []; let loseReply = true, publishStarted;
      const publishGate = new Promise(resolve => { releasePublish = resolve; }), publishBegan = new Promise(resolve => { publishStarted = resolve; });
      const publishRoute = async route => {
        if (new URL(route.request().url()).pathname !== publishEndpoint || route.request().method() !== 'POST') return route.continue();
        publications.push(route.request().postDataJSON());
        if (loseReply) { loseReply = false; publishStarted(); await publishGate; const committed = await route.fetch({ timeout: 10000 }); await capture(committed, `committed-response-lost-${width}`); assert.equal(committed.status(), 200, 'real publication committed before injected lost reply'); return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'schedule_unavailable' }) }); }
        const replay = await route.fetch({ timeout: 10000 }); await capture(replay, `replay-${width}`); return route.fulfill({ response: replay });
      };
      await page.route('**/api/staff/schedule/drafts/*/publish', publishRoute);
      await publication().locator('[data-submit]').click(); await bounded(publishBegan, 'publish POST');
      await publication().locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await frames(page); check(publications.length === 1 && await publication().locator('[name=reason]').isDisabled(), 'real publication singleflight'); releasePublish();
      await publication().locator('[data-error]').filter({ hasText: 'Сервис графика временно недоступен' }).waitFor();
      const committedDraft = (await db.query('SELECT state,version,published_by FROM staff_schedule_drafts WHERE id=$1', [draftId])).rows[0];
      check(committedDraft.state === 'published' && committedDraft.published_by === ids.owner, 'publication committed despite missing browser success response');
      const live = (await db.query('SELECT id,kind,note FROM staff_schedules WHERE venue_id=$1 AND user_id=$2 AND work_date=$3::date', [ids.venue, ids.manager, day])).rows;
      check(live.length === 1 && live[0].kind === 'day_off' && live[0].note === note, 'one exact live schedule exists before retry');
      check(await publication().locator('[name=reason]').inputValue() === `Локальная публикация ${width}`, 'lost reply retains publication reason');
      await geometry(page); await page.screenshot({ path: path.join(artifacts, `planning-committed-reply-lost-${width}.png`) });
      const replayedResponse = page.waitForResponse(response => new URL(response.url()).pathname === publishEndpoint && response.request().method() === 'POST');
      await publication().locator('[data-submit]').click(); check((await replayedResponse).status() === 200, 'same-key replay succeeds after draft state/version changed');
      assert.deepEqual(publications[1], publications[0], 'lost-reply retry preserves exact publish body/key'); await publication().waitFor({ state: 'detached' }); await detail().locator('[data-draft-content]').filter({ hasText: 'Опубликован' }).waitFor();
      assert.deepEqual(http.find(item => item.stage === `replay-${width}`).payload, http.find(item => item.stage === `committed-response-lost-${width}`).payload, 'replay returns the original committed response');
      check((await db.query('SELECT count(*)::int count FROM staff_schedule_requests WHERE venue_id=$1 AND actor_id=$2 AND request_key=$3', [ids.venue, ids.owner, publications[0].requestKey])).rows[0].count === 1, 'one publication receipt after replay');
      check((await db.query("SELECT count(*)::int count FROM staff_schedule_planning_events WHERE venue_id=$1 AND entity_id=$2 AND action='publish'", [ids.venue, draftId])).rows[0].count === 1, 'one planning publication audit after replay');
      check((await db.query('SELECT count(*)::int count FROM staff_schedule_events WHERE venue_id=$1 AND schedule_id=$2', [ids.venue, live[0].id])).rows[0].count === 1, 'one live schedule audit after replay');
      check((await db.query('SELECT count(*)::int count FROM staff_schedules WHERE venue_id=$1 AND user_id=$2 AND work_date=$3::date', [ids.venue, ids.manager, day])).rows[0].count === 1, 'no duplicate live row after replay');
      check((await db.query('SELECT version FROM staff_schedule_drafts WHERE id=$1', [draftId])).rows[0].version === committedDraft.version, 'replay does not increment draft version');
      await page.unroute('**/api/staff/schedule/drafts/*/publish', publishRoute); await page.reload(); await page.locator('[data-planning]').click(); await page.locator(`[data-draft="${draftId}"]`).click(); await detail().locator('[data-draft-content]').filter({ hasText: 'Опубликован' }).waitFor();
      check(await detail().locator('[data-new-op]').count() === 0 && await detail().locator('[data-publish-preview]').count() === 0, 'published readback has no editing/publication actions'); await geometry(page); await page.screenshot({ path: path.join(artifacts, `planning-published-reloaded-${width}.png`) });
      const afterReload = (await db.query(`SELECT
        (SELECT count(*)::int FROM staff_schedule_requests WHERE venue_id=$1 AND actor_id=$2 AND request_key=$3) AS receipts,
        (SELECT count(*)::int FROM staff_schedule_planning_events WHERE venue_id=$1 AND entity_id=$4 AND action='publish') AS planning_audits,
        (SELECT count(*)::int FROM staff_schedule_events WHERE venue_id=$1 AND schedule_id=$5) AS live_audits,
        (SELECT count(*)::int FROM staff_schedules WHERE venue_id=$1 AND user_id=$6 AND work_date=$7::date) AS live_rows`,
      [ids.venue, ids.owner, publications[0].requestKey, draftId, live[0].id, ids.manager, day])).rows[0];
      assert.deepEqual(afterReload, { receipts: 1, planning_audits: 1, live_audits: 1, live_rows: 1 }, 'exactly one receipt/audit/live row after browser reload');
    } finally { releasePatch?.(); releasePublish?.(); await context.close(); }
  }
}
