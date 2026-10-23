// Run only inside the caller's guarded, disposable PostgreSQL browser suite.
// Real logins and UI mutations; fault injection holds one request, not auth/identity.
import assert from 'node:assert/strict';
import path from 'node:path';

export async function attendanceApprovalJourney({ browser, db, base, ids, logins, password, artifacts, check, errors }) {
  const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const geometry = async page => {
    const boxes = await page.locator('.attendance-page, #staff-attendance-dialog .action-box').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, overflow: node.scrollWidth > node.clientWidth + 1 }; }));
    check(boxes.length > 0 && boxes.every(box => box.left >= -1 && box.right <= page.viewportSize().width + 1 && !box.overflow), 'actual attendance page/dialog content fits without clipped overflow');
  };
  const login = async (page, username) => {
    await page.goto(base + '/login'); await page.locator('#login-username').fill(username); await page.locator('#login-password').fill(password);
    await page.locator('#login-form button[type=submit]').click(); await page.waitForURL(url => url.pathname !== '/login');
  };
  async function hold(page, endpoint, fail = false) {
    let release, started; const waitStarted = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const requests = [];
    const handler = async route => {
      if (new URL(route.request().url()).pathname !== endpoint || route.request().method() !== 'POST') return route.continue();
      requests.push(route.request().postDataJSON()); started(); await gate;
      if (fail) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'attendance_unavailable' }) });
      return route.continue();
    };
    await page.route('**/api/staff/attendance/**', handler);
    return { started: waitStarted, requests, release, dispose: () => page.unroute('**/api/staff/attendance/**', handler) };
  }
  for (const width of [390, 1440]) {
    const owner = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'ru-RU', reducedMotion: 'reduce' });
    const manager = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'ru-RU', reducedMotion: 'reduce' });
    try {
      const admin = await owner.newPage(), personal = await manager.newPage();
      for (const page of [admin, personal]) page.on('pageerror', error => errors.push(error.message));
      await login(admin, logins.owner); await admin.goto(base + '/admin#staff-attendance');
      await admin.locator('[data-attendance-tab=settings]').click();
      await admin.locator('[data-attendance-policy] [name=mode]').selectOption('approval');
      await admin.locator('[data-attendance-policy] [name=preparationMinutes]').fill('0');
      await admin.locator('[data-attendance-policy] button[type=submit]').click();
      await admin.locator('[data-attendance-feedback]').filter({ hasText: 'Правила выхода сохранены' }).waitFor();
      check((await db.query('SELECT mode FROM staff_attendance_policies WHERE venue_id=$1', [ids.venue])).rows[0]?.mode === 'approval', 'owner UI policy enables actual approval mode');

      await login(personal, logins.manager); await personal.goto(base + '/#staff-attendance');
      const requestForm = personal.locator('#staff-attendance-dialog [data-attendance-request-form]'); await requestForm.waitFor();
      const reason = `Локальная проверка согласования ${width}`; await requestForm.locator('[name=reason]').fill(reason);
      const before = (await db.query('SELECT count(*)::int count FROM staff_attendance_requests WHERE venue_id=$1 AND user_id=$2', [ids.venue, ids.manager])).rows[0].count;
      const failed = await hold(personal, '/api/staff/attendance/requests', true);
      await requestForm.locator('button[type=submit]').click(); await failed.started;
      check(await requestForm.locator('[name=reason]').isDisabled(), 'actual personal reason locked during request');
      await requestForm.evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await frames(personal);
      check(failed.requests.length === 1, 'actual pending request has one POST');
      await geometry(personal); await personal.screenshot({ path: path.join(artifacts, `approval-request-pending-${width}.png`) }); failed.release();
      await personal.locator('[data-attendance-feedback]').filter({ hasText: 'Сервис временно недоступен' }).waitFor();
      check(await requestForm.locator('[name=reason]').inputValue() === reason && await requestForm.locator('[name=reason]').isEnabled(), 'failed POST preserves editable actual draft');
      check((await db.query('SELECT count(*)::int count FROM staff_attendance_requests WHERE venue_id=$1 AND user_id=$2', [ids.venue, ids.manager])).rows[0].count === before, 'injected failed POST created no SQL request');
      await failed.dispose();
      const posted = personal.waitForResponse(response => new URL(response.url()).pathname === '/api/staff/attendance/requests' && response.request().method() === 'POST');
      await requestForm.locator('button[type=submit]').click(); const created = await posted;
      check(created.status() === 201, 'retry request reaches real attendance API');
      check(created.request().postDataJSON().requestKey === failed.requests[0].requestKey, 'real retry uses the same request key');
      const rows = (await db.query('SELECT id,version,status,reason FROM staff_attendance_requests WHERE venue_id=$1 AND user_id=$2 AND reason=$3', [ids.venue, ids.manager, reason])).rows;
      check(rows.length === 1 && rows[0].status === 'pending', 'one real pending request persisted with exact reason'); const request = rows[0];

      await admin.reload(); const decision = admin.locator(`[data-attendance-decision="${request.id}"]`); await decision.waitFor();
      await decision.locator('[name=note]').fill('Согласовано для локальной проверки');
      const approvalPath = `/api/staff/attendance/requests/${request.id}/decision`, held = await hold(admin, approvalPath);
      await decision.locator('[data-decision=approved]').click(); await held.started;
      check(await decision.locator('[data-decision=rejected]').isDisabled() && await decision.locator('[name=note]').isDisabled(), 'actual approval locks opposing action and comment');
      await decision.evaluate(form => form.requestSubmit(form.querySelector('[data-decision=rejected]'))); await frames(admin);
      check(held.requests.length === 1 && held.requests[0].decision === 'approved', 'one real opposing-decision POST while pending');
      check((await db.query('SELECT status FROM staff_attendance_requests WHERE id=$1', [request.id])).rows[0].status === 'pending', 'held real decision has not changed SQL yet');
      await geometry(admin); await admin.screenshot({ path: path.join(artifacts, `approval-decision-pending-${width}.png`) });
      const decided = admin.waitForResponse(response => new URL(response.url()).pathname === approvalPath && response.request().method() === 'POST'); held.release();
      check((await decided).status() === 200, 'real approval API succeeded'); await held.dispose(); await decision.waitFor({ state: 'detached' });
      const saved = (await db.query('SELECT status,version,decided_by,decision_note FROM staff_attendance_requests WHERE id=$1', [request.id])).rows[0];
      check(saved.status === 'approved' && saved.version === request.version + 1 && saved.decided_by === ids.owner && saved.decision_note === 'Согласовано для локальной проверки', 'exact decision, actor, note and one version persisted');
      await admin.reload(); await admin.locator('[data-attendance-tab=overview]').waitFor(); check(await admin.locator(`[data-attendance-decision="${request.id}"]`).count() === 0, 'approved request absent from pending queue after reload');

      await personal.getByRole('button', { name: 'Обновить статус', exact: true }).click();
      await personal.locator('[data-attendance-approved-start]').click(); await personal.locator('[data-attendance-end]').waitFor();
      const sessions = (await db.query('SELECT id,basis,ended_at FROM staff_attendance_sessions WHERE venue_id=$1 AND user_id=$2 AND ended_at IS NULL', [ids.venue, ids.manager])).rows;
      check(sessions.length === 1 && sessions[0].basis === 'approved_exception', 'one actual session uses approved exception');
      check(Boolean((await db.query('SELECT consumed_at FROM staff_attendance_requests WHERE id=$1', [request.id])).rows[0].consumed_at), 'approval consumed by actual start');
      await personal.reload(); await personal.locator('[data-attendance-end]').waitFor();
      await geometry(personal); await personal.screenshot({ path: path.join(artifacts, `approval-running-reloaded-${width}.png`) });
      await personal.locator('[data-attendance-end]').click(); await personal.locator('[data-attendance-request-form]').waitFor();
      check(Boolean((await db.query('SELECT ended_at FROM staff_attendance_sessions WHERE id=$1', [sessions[0].id])).rows[0].ended_at), 'actual self end persisted');
      check((await db.query('SELECT count(*)::int count FROM staff_attendance_sessions WHERE venue_id=$1 AND user_id=$2 AND ended_at IS NULL', [ids.venue, ids.manager])).rows[0].count === 0, 'no active session remains');
      for (const page of [admin, personal]) check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'real portal/POS viewport fits');
    } finally { await manager.close(); await owner.close(); }
  }
}
