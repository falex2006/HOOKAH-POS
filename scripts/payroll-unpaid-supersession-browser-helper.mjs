import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CAPABILITY = 'employee_attributed_remaining_net_refund_v2';
const TABLES = ['payroll_entries','expenses','payroll_calculation_runs','payroll_run_provenance','payroll_daily_snapshots',
  'payroll_daily_snapshot_lines','payroll_calculation_entry_transitions','payroll_calculation_entry_transition_requests',
  'payroll_calculation_entry_requests','payroll_run_supersession_requests','payroll_correction_events'];

// Parent owns DB creation, migrations, server/browser startup, login and teardown.
// fixture is a FRESH seedUnpaidSupersessionFixture result (no materializations or
// returns yet); page must already be logged in as its owner. This helper creates
// its two original drafts and half-return only after checking the isolated DB
// and authenticated tenant. openSaved({runId,versionId,period}) may just open the
// saved workspace; this helper selects the requested run itself. No auto-run.
export async function verifyUnpaidSupersessionBrowser({ page, base, pool, fixture, headers = {}, openSaved,
  artifactDir, staffHeaders, verifyCsrf = true } = {}) {
  assert.ok(page?.request && pool?.query && fixture?.service && typeof fixture.refund === 'function');
  const { ids, owner, service, run, version } = fixture;
  assert.ok([ids?.venue,ids?.owner,ids?.employee,ids?.zeroEmployee,run?.runId,version?.versionId].every(value=>UUID.test(value||'')));
  assert.equal(owner.venueId,ids.venue); assert.equal(owner.userId,ids.owner);
  const dbName = (await pool.query('SELECT current_database() AS name')).rows[0].name;
  assert.match(dbName,/^orders_qa_[a-f0-9]{16}$/); assert.equal(dbName,process.env.LOCAL_FULL_PG_OWNED_DATABASE);
  const origin = new URL(base).origin, api = page.request, runPath = `/api/payroll/calculation-runs/${run.runId}`;
  const previewUrl = `${origin}${runPath}/supersession/preview`, commitUrl = `${origin}${runPath}/supersession`;
  const sessionHttp = await api.get(`${origin}/api/session`,{headers}); assert.equal(sessionHttp.status(),200);
  const session = await sessionHttp.json();
  assert.equal(session.user?.id,ids.owner); assert.equal(session.user?.venueId,ids.venue); assert.equal(session.user?.role,'owner');
  const browserIdentity = await page.evaluate(() => {
    const user=JSON.parse(localStorage.getItem('crm_session_user')||'{}');return {id:user.id,venueId:user.venueId,role:user.role};
  });
  assert.deepEqual(browserIdentity,{id:ids.owner,venueId:ids.venue,role:'owner'});
  const oldSaved = await service.getSavedRun(owner,run.runId);
  assert.equal(oldSaved.amountCents,1000); assert.equal(oldSaved.capabilityVersion,CAPABILITY);
  const period = oldSaved.period;
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM payroll_entries WHERE venue_id=$1 AND calculation_run_id=$2',[ids.venue,run.runId])).rows[0].n,0,
    'browser helper requires its own untouched fixture');
  assert.equal((await service.checkSavedRunFreshness(owner,run.runId)).status,'current','fixture has no prior late return');
  for (const employeeId of [ids.employee,ids.zeroEmployee]) await service.materializeCalculationEntry(owner,run.runId,
    {employeeId,financeCategoryId:null,idempotencyKey:`unpaid-browser-initial:${employeeId}`});
  await fixture.refund('0.5',`unpaid-browser-half:${randomUUID()}`);

  const state = async () => {
    const values = {};
    for (const table of TABLES) values[table] = (await pool.query(`SELECT count(*)::int AS count,
      encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS hash
      FROM ${table} t WHERE venue_id=$1`,[ids.venue])).rows[0];
    return values;
  };
  const frozenOriginal = async () => {
    const values = {};
    for (const table of ['payroll_calculation_runs','payroll_run_provenance','payroll_daily_snapshots','payroll_daily_snapshot_lines']) {
      const key = table === 'payroll_calculation_runs' ? 'id' : 'run_id';
      values[table] = (await pool.query(`SELECT count(*)::int AS count,
        encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS hash
        FROM ${table} t WHERE venue_id=$1 AND ${key}=$2`,[ids.venue,run.runId])).rows[0];
    }
    return values;
  };
  const originalProof = await frozenOriginal(), before = await state();
  assert.equal(before.payroll_entries.count,2); assert.equal(before.payroll_run_supersession_requests.count,0);
  assert.equal(before.expenses.count,0);
  const directory = artifactDir || fileURLToPath(new URL(`../tmp/payroll-unpaid-supersession-ui-qa/${Date.now()}-${process.pid}/`,import.meta.url));
  mkdirSync(directory,{recursive:true});
  const artifacts=[],errors=[],writes=[];
  const oldViewport=page.viewportSize();
  const onError=error=>errors.push(error.message);
  const onRequest=request=>{
    const url=new URL(request.url());
    if(url.origin===origin&&url.pathname.startsWith('/api/payroll/')&&!['GET','HEAD','OPTIONS'].includes(request.method()))
      writes.push({method:request.method(),path:url.pathname,body:request.postData()});
  };
  const navigate = async targetRunId => {
    if(openSaved) await openSaved({runId:targetRunId,versionId:version.versionId,period});
    else {
      if (new URL(page.url()).origin !== origin || new URL(page.url()).pathname !== '/finance')
        await page.goto(`${origin}/finance#payroll`,{waitUntil:'networkidle'});
      const settings=page.getByText('Настройки схем и проверка расчётов',{exact:true});
      if(!(await settings.locator('..').evaluate(node=>node.open)))await settings.click();
      await page.locator('button[data-scheme-workspace="saved"]').click();
    }
    const button=page.locator(`[data-saved-run-open="${targetRunId}"]`);
    for(let n=0;n<20;n++) {
      await page.locator('[data-saved-run-list]').getByRole('table').waitFor({state:'visible'});
      if(await button.count())break;
      const more=page.locator('[data-saved-run-more]');assert.equal(await more.isVisible(),true,'requested run exists in saved list');
      const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/payroll/calculation-runs'&&r.request().method()==='GET');
      await more.click();const http=await response;assert.equal(http.status(),200);await http.finished();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    }
    const loaded=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/payroll/calculation-runs/${targetRunId}`&&r.request().method()==='GET');
    await button.click();const http=await loaded;assert.equal(http.status(),200);assert.equal((await http.json()).runId,targetRunId);
    await page.locator('[data-saved-run-detail] [data-supersession-preview]').waitFor({state:'visible'});
  };
  const capture = async (phase,locator) => {
    for(const width of [1440,768,390,344]) {
      await page.setViewportSize({width,height:1000});await locator.scrollIntoViewIfNeeded();
      const bounds=await locator.evaluate(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,viewport:innerWidth,bodyWidth:document.documentElement.scrollWidth};});
      assert.ok(bounds.left>=-1&&bounds.right<=bounds.viewport+1,`${phase} fits ${width}`);
      assert.ok(bounds.bodyWidth<=bounds.viewport+1,`${phase}: no horizontal page overflow at ${width}`);
      const artifact=path.join(directory,`${phase}-${width}.png`);await page.screenshot({path:artifact});artifacts.push(artifact);
    }
  };
  const oldEntries = async targetRunId => (await pool.query(`SELECT id,user_id,status,(amount*100)::bigint::text AS amount_cents
    FROM payroll_entries WHERE venue_id=$1 AND calculation_run_id=$2 ORDER BY user_id`,[ids.venue,targetRunId])).rows;
  const persistedOriginalEntries=await oldEntries(run.runId);
  let interceptionError=null,committedBody=null,command=null,commandBytes=null,intercepted=0;
  const loseCommit = async route => {
    try {
      assert.equal(route.request().method(),'POST');intercepted++;
      commandBytes=route.request().postData();command=route.request().postDataJSON();
      const response=await route.fetch({timeout:30000});assert.equal(response.status(),201,await response.text());
      committedBody=await response.json();
    } catch(error) {interceptionError=error;}
    finally {await route.abort('failed').catch(()=>{});}
  };
  page.on('pageerror',onError);page.on('request',onRequest);
  try {
    await navigate(run.runId);
    assert.equal(writes.length,0,'opening v2 run never autoPOSTs supersession or financial operations');
    const detail=page.locator('[data-saved-run-detail]');
    for(const selector of ['[data-saved-entry-create]','[data-correction-commit]','[data-payroll-action]'])
      assert.equal(await detail.locator(selector).count(),0,'unsupported individual financial actions remain absent');
    const previewResponse=page.waitForResponse(r=>r.url()===previewUrl&&r.request().method()==='POST');
    await detail.locator('[data-supersession-preview]').click();const previewHttp=await previewResponse;
    assert.equal(previewHttp.status(),200,await previewHttp.text());assert.deepEqual(previewHttp.request().postDataJSON(),{});
    const preview=await previewHttp.json();assert.equal(preview.oldEntries.length,2);assert.equal(preview.monetaryWrites,false);
    assert.deepEqual(preview.replacementAmounts.map(row=>[row.employeeId,row.amountCents]).sort(),[[ids.employee,500],[ids.zeroEmployee,0]].sort());
    const comparison=detail.locator('[data-supersession-content]');
    await comparison.locator('[data-supersession-commit]').waitFor({state:'visible'});
    assert.match(await comparison.innerText(),/Все сотрудники: 2/);
    const rows=comparison.locator('tbody tr');assert.equal(await rows.count(),2);
    for(const [employeeId,name,oldAmount,newAmount] of [[ids.employee,'Verified employee',1000,500],[ids.zeroEmployee,'Verified zeroEmployee',0,0]]) {
      const row=rows.filter({hasText:name});assert.equal(await row.count(),1);
      const cells=await row.locator('td').allTextContents();assert.equal(cells[1],'Черновик');assert.equal(cells[4],'Черновик');
      const moneyCents=text=>Math.round(Number(text.replace(/[^\d,.-]/g,'').replace(',','.'))*100);
      assert.equal(moneyCents(cells[2]),oldAmount,employeeId);assert.equal(moneyCents(cells[3]),newAmount,employeeId);
    }
    assert.deepEqual(await state(),before,'owner preview and saved employee pagination write no payroll/expense rows');
    await capture('preview',comparison);
    if(verifyCsrf) {
      const denied=await api.post(previewUrl,{headers:{...headers,origin:'https://foreign-origin.invalid'},data:{}});
      assert.equal(denied.status(),403,'preview requires same-origin owner intent');
    }
    if(staffHeaders) {
      const denied=await api.post(previewUrl,{headers:staffHeaders,data:{}});assert.equal(denied.status(),403,'staff cannot preview owner replacement');
    }
    await comparison.locator('[data-supersession-reason]').fill('Owner reviewed every employee');
    await comparison.locator('[data-supersession-commit]').click();
    await comparison.locator('[data-supersession-message]').filter({hasText:'Подтвердите замену всей ведомости'}).waitFor();
    assert.equal(writes.filter(row=>row.path===`${runPath}/supersession`).length,0,'checkbox required before POST');
    await comparison.locator('[data-supersession-confirm]').check();await comparison.locator('[data-supersession-reason]').fill('');
    await comparison.locator('[data-supersession-commit]').click();
    await comparison.locator('[data-supersession-message]').filter({hasText:'Укажите причину'}).waitFor();
    assert.equal(writes.filter(row=>row.path===`${runPath}/supersession`).length,0,'reason required before POST');
    assert.deepEqual(await state(),before,'client validation and denied preview never mutate persisted state');
    await comparison.locator('[data-supersession-reason]').fill('Browser owner confirms the complete unpaid cohort after half return');
    await page.route(commitUrl,loseCommit,{times:1});
    const submitted=page.waitForRequest(r=>r.url()===commitUrl&&r.method()==='POST');
    await comparison.locator('[data-supersession-commit]').click();await submitted;
    await page.locator('[data-saved-run-status]').filter({hasText:'Результат пересчёта не подтверждён'}).waitFor();
    if(interceptionError)throw interceptionError;
    assert.equal(intercepted,1);assert.ok(UUID.test(committedBody?.replacementRunId||''));
    assert.deepEqual(Object.keys(command).sort(),['expectedPlanHash','idempotencyKey','reason']);assert.equal(command.expectedPlanHash,preview.planHash);
    assert.equal(committedBody.replayed,false);assert.equal(committedBody.entries.length,2);
    const committedState=await state();assert.equal(committedState.payroll_entries.count,4);assert.equal(committedState.expenses.count,0);
    assert.equal(committedState.payroll_run_supersession_requests.count,1);assert.equal(committedState.payroll_calculation_runs.count,2);
    assert.deepEqual(await frozenOriginal(),originalProof,'original run, provenance and daily lines remain immutable after replacement');
    const cancelled=await oldEntries(run.runId),drafts=await oldEntries(committedBody.replacementRunId);
    assert.deepEqual(cancelled.map(row=>row.id),persistedOriginalEntries.map(row=>row.id));
    assert.ok(cancelled.every(row=>row.status==='cancelled'));assert.ok(drafts.every(row=>row.status==='draft'));
    assert.deepEqual(drafts.map(row=>[row.user_id,Number(row.amount_cents)]).sort(),[[ids.employee,500],[ids.zeroEmployee,0]].sort());
    assert.deepEqual(cancelled.map(row=>[row.user_id,Number(row.amount_cents)]).sort(),[[ids.employee,1000],[ids.zeroEmployee,0]].sort());
    await capture('recovery',page.locator('[data-supersession-pending]'));

    await page.reload({waitUntil:'networkidle'});await navigate(run.runId);
    assert.equal(writes.filter(row=>row.path===`${runPath}/supersession`).length,1,'reload does not resend the retained command automatically');
    const recover=page.locator(`[data-supersession-retry="${run.runId}"]`);await recover.waitFor({state:'visible'});
    const replayResponse=page.waitForResponse(r=>r.url()===commitUrl&&r.request().method()==='POST');
    const childLoaded=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/payroll/calculation-runs/${committedBody.replacementRunId}`&&r.request().method()==='GET');
    await recover.click();const replayHttp=await replayResponse;assert.equal(replayHttp.status(),200,await replayHttp.text());
    assert.equal(replayHttp.request().postData(),commandBytes,'reload retry preserves the exact body bytes and idempotency key');
    assert.deepEqual(await replayHttp.json(),{...committedBody,replayed:true});
    const childHttp=await childLoaded;assert.equal(childHttp.status(),200);assert.equal((await childHttp.json()).amountCents,500);
    await page.locator('[data-saved-run-status]').filter({hasText:'Новая ведомость сохранена'}).waitFor();
    await recover.waitFor({state:'detached'});
    await detail.locator('[data-supersession-preview]').waitFor({state:'visible'});
    assert.deepEqual(await state(),committedState,'recovered exact receipt creates no duplicate entry, run, ledger or expense');
    const again=await api.post(commitUrl,{headers,data:command});assert.equal(again.status(),200,await again.text());
    assert.deepEqual(await again.json(),{...committedBody,replayed:true});
    const changed=await api.post(commitUrl,{headers,data:{...command,reason:'Different reason with the same key'}});
    assert.equal(changed.status(),409);assert.deepEqual(await state(),committedState,'exact retry and conflicting key are write-free');
    assert.equal((await service.getSavedRun(owner,run.runId)).amountCents,1000);
    assert.equal((await service.getSavedRun(owner,committedBody.replacementRunId)).amountCents,500);
    await capture('replacement',detail.locator('[data-saved-entry-status]'));
    await navigate(run.runId);assert.equal((await service.replaySavedRun(owner,run.runId)).verification.status,'matched');
    assert.deepEqual(await frozenOriginal(),originalProof);assert.deepEqual(await state(),committedState);
    assert.equal(writes.filter(row=>row.path===`${runPath}/supersession/preview`).length,1);
    assert.equal(writes.filter(row=>row.path===`${runPath}/supersession`).length,2,'one lost-response commit and one explicit UI recovery');
    assert.ok(writes.every(row=>row.method==='POST'&&[`${runPath}/supersession/preview`,`${runPath}/supersession`].includes(row.path)),
      'browser made no unrelated financial write');
    assert.deepEqual(errors,[],'no page runtime errors');
    console.log(`PASS unpaid supersession browser: complete 500/0 cohort, no-write preview, required consent, lost-response/reload exact receipt, immutable 1000 original, 500 child, no expenses, four widths; artifacts ${directory}`);
    return {status:'passed',originalRunId:run.runId,replacementRunId:committedBody.replacementRunId,journalId:committedBody.journalId,
      command,artifacts,csrfChecked:verifyCsrf,staffChecked:Boolean(staffHeaders)};
  } finally {
    await page.unroute(commitUrl,loseCommit);page.off('pageerror',onError);page.off('request',onRequest);
    if(oldViewport)await page.setViewportSize(oldViewport);
  }
}
