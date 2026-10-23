import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const CAPABILITY='employee_attributed_remaining_net_refund_v2';
const POLICY='reviewed_period_variable_pay_only_v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const select=async(page,selector,value)=>{
  const control=page.locator(selector),wrapper=control.locator('..'),trigger=wrapper.locator('.custom-select-trigger');
  if(await trigger.count()){await trigger.click();await wrapper.locator(`[data-value="${value}"]`).click();}
  else await control.selectOption(value);
};

// Import-safe helper for the parent's sole guarded local PG/browser runner.
// Requires fresh seedUnpaidSupersessionFixture({withTarget:true}) and a page
// already authenticated as that fixture's owner. Creates no server/database.
// Scheme setup and source returns use real fixture services; user financial
// actions (run creation, materialization, lifecycle and correction) use the UI.
export async function verifyRefundAwarePublicBrowser({page,pool,base,headers={},fixture,artifactDir,staffHeaders,foreignHeaders}={}) {
  assert.ok(page?.request&&pool?.query&&fixture?.targetSource&&fixture?.service);
  const {ids,owner,service,version,refund,targetSource}=fixture,origin=new URL(base).origin,api=page.request;
  assert.ok([ids?.venue,ids?.owner,ids?.employee,ids?.zeroEmployee,version?.versionId].every(v=>UUID.test(v||'')));
  assert.equal(owner.venueId,ids.venue);assert.equal(owner.userId,ids.owner);
  const dbName=(await pool.query('SELECT current_database() AS name')).rows[0].name;
  assert.match(dbName,/^orders_qa_[a-f0-9]{16}$/);assert.equal(dbName,process.env.LOCAL_FULL_PG_OWNED_DATABASE);
  const sessionHttp=await api.get(`${origin}/api/session`,{headers});assert.equal(sessionHttp.status(),200);
  const session=await sessionHttp.json();assert.equal(session.user?.id,ids.owner);assert.equal(session.user?.venueId,ids.venue);assert.equal(session.user?.role,'owner');
  assert.deepEqual(await page.evaluate(()=>{const user=JSON.parse(localStorage.getItem('crm_session_user')||'{}');return [user.id,user.venueId,user.role];}),[ids.owner,ids.venue,'owner']);
  const originalVersion=await service.getVersion(owner,version.versionId),sourcePolicies=originalVersion.sourcePolicies;
  assert.equal(sourcePolicies.schemaVersion,2);
  const period=(await service.getSavedRun(owner,fixture.run.runId)).period,targetPeriod=targetSource.nextPeriod;
  assert.ok(targetPeriod.from>period.to);assert.equal((await pool.query('SELECT count(*)::int n FROM payroll_entries WHERE venue_id=$1',[ids.venue])).rows[0].n,0);
  const directory=artifactDir||fileURLToPath(new URL(`../tmp/payroll-refund-aware-public-ui-qa/${Date.now()}-${process.pid}/`,import.meta.url));
  mkdirSync(directory,{recursive:true});const artifacts=[],errors=[],requests=[];const oldViewport=page.viewportSize();
  const onError=error=>errors.push(error.message);
  const onRequest=request=>{const u=new URL(request.url());if(u.origin===origin&&u.pathname.startsWith('/api/payroll/'))requests.push({path:u.pathname,method:request.method(),body:request.postData()});};
  const capture=async(label,locator)=>{
    for(const width of [1440,768,390,344]){
      await page.setViewportSize({width,height:1000});await locator.scrollIntoViewIfNeeded();
      const bounds=await locator.evaluate(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,body:document.documentElement.scrollWidth};});
      assert.ok(bounds.left>=-1&&bounds.right<=bounds.width+1,`${label} fits ${width}`);assert.ok(bounds.body<=bounds.width+1,`${label} no page overflow ${width}`);
      const output=path.join(directory,`${label}-${width}.png`);await page.screenshot({path:output});artifacts.push(output);
    }
    await page.setViewportSize({width:1440,height:1000});
  };
  const openSaved=async()=>{
    await page.goto(`${origin}/finance#payroll`,{waitUntil:'networkidle'});
    const settings=page.getByText('Настройки схем и проверка расчётов',{exact:true});
    if(!(await settings.locator('..').evaluate(node=>node.open)))await settings.click();
    await page.locator('button[data-scheme-workspace="saved"]').click();
    await page.locator(`[data-saved-run-version] option[value="${version.versionId}"]`).waitFor({state:'attached'});
  };
  const openRun=async runId=>{
    await openSaved();const button=page.locator(`[data-saved-run-open="${runId}"]`);
    for(let n=0;n<20;n++){
      await page.locator('[data-saved-run-list]').getByRole('table').waitFor();if(await button.count())break;
      const more=page.locator('[data-saved-run-more]');assert.equal(await more.isVisible(),true);
      const next=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/payroll/calculation-runs'&&r.request().method()==='GET');
      await more.click();const response=await next;assert.equal(response.status(),200);await response.finished();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    }
    const read=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/payroll/calculation-runs/${runId}`&&r.request().method()==='GET');
    await button.click();assert.equal((await read).status(),200);await page.locator('[data-saved-entry-reload]').waitFor();
    assert.equal(await page.locator('[data-saved-run-detail]').getAttribute('data-saved-run-capability'),CAPABILITY);
    assert.equal(await page.locator('[data-refund-review-panel]').count(),0,'v2 does not use legacy line-review actions');
  };
  const createRun=async(versionId,range,amount)=>{
    await openSaved();
    if(!await page.locator(`[data-saved-run-version] option[value="${versionId}"]`).count())
      await page.locator('[data-saved-run-reload]').click();
    await page.locator(`[data-saved-run-version] option[value="${versionId}"]`).waitFor({state:'attached'});
    await select(page,'[data-saved-run-version]',versionId);await page.locator('[data-saved-run-from]').fill(range.from);await page.locator('[data-saved-run-to]').fill(range.to);
    const metadata=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/payroll/versions/${versionId}`&&r.request().method()==='GET');
    const created=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/payroll/refund-aware-calculation-runs'&&r.request().method()==='POST');
    await page.locator('[data-saved-run-create]').click();assert.equal((await metadata).status(),200);
    const response=await created;assert.equal(response.status(),201,await response.text());
    const command=response.request().postDataJSON();assert.deepEqual(Object.keys(command).sort(),['idempotencyKey','periodFrom','periodTo','schemeVersionId']);
    assert.equal(command.schemeVersionId,versionId);assert.equal(command.periodFrom,range.from);assert.equal(command.periodTo,range.to);
    const result=await response.json();assert.equal(result.status,'ready');assert.equal(result.amountCents,amount);assert.ok(UUID.test(result.runId));
    await page.locator('[data-saved-entry-reload]').waitFor();return result;
  };
  const materialize=async(runId,employeeId,amount)=>{
    const button=page.locator(`[data-saved-entry-create="${employeeId}"]`);await button.waitFor({state:'visible'});
    const saved=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/payroll/calculation-runs/${runId}/entries`&&r.request().method()==='POST');
    await button.click();const response=await saved;assert.ok([200,201].includes(response.status()),await response.text());
    const body=await response.json(),entry=body.currentEntry||body.entry;
    assert.equal(entry.status,'draft');assert.equal(entry.amountCents,amount);assert.equal(entry.userId,employeeId);
    await page.locator(`[data-saved-entry-register="${entry.id}"]`).waitFor();return entry;
  };
  const registry=async(entryId,range,{check=true}={})=>{
    await page.goto(`${origin}/finance#payroll`,{waitUntil:'networkidle'});
    await page.locator('#payroll-filter-from').fill(range.from);await page.locator('#payroll-filter-to').fill(range.to);await page.locator('#payroll-reload').click();
    const row=page.locator(`[data-payroll-entry="${entryId}"]`);await row.waitFor();
    if(check)await row.locator('[data-payroll-linked-check]').click();return row;
  };
  const transition=async(entryId,action,range,amount)=>{
    const row=await registry(entryId,range),url=`${origin}/api/payroll/calculation-entries/${entryId}/transition`;
    if(action==='pay'){
      await row.locator('[data-payroll-action="pay"]').waitFor();await row.locator('[data-payroll-payment-date]').fill(range.to);
      if(amount===0)assert.equal(await row.locator('[data-payroll-payment-account],[data-payroll-payment-method]').count(),0);
      else{assert.equal(await row.locator('[data-payroll-payment-account]').inputValue(),ids.account);assert.equal(await row.locator('[data-payroll-payment-method]').inputValue(),'card');}
    }
    if(action==='cancel'){await row.locator('[data-payroll-cancel-open]').click();await row.locator('[data-payroll-cancel-reason]').fill('Owner releases the complete reviewed allocation');}
    const completed=page.waitForResponse(r=>r.url()===url&&r.request().method()==='POST');await row.locator(`[data-payroll-action="${action}"]`).click();
    const response=await completed;assert.equal(response.status(),200,await response.text());const result=await response.json();
    assert.equal(result.entry.status,{approve:'approved',pay:'paid',cancel:'cancelled'}[action]);assert.equal(result.entry.amountCents,amount);
    if(action==='pay'){assert.equal(result.entry.paymentDate,range.to);if(amount===0)assert.equal(result.entry.expenseId,null);else assert.ok(UUID.test(result.entry.expenseId));}
    return result;
  };
  const snapshot=async()=>{
    const result={};for(const table of ['payroll_entries','expenses','payroll_correction_claims','payroll_correction_batches','payroll_correction_events','payroll_correction_requests','payroll_refund_aware_paid_assessments'])
      result[table]=(await pool.query(`SELECT count(*)::int count,encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') hash FROM ${table} t WHERE venue_id=$1`,[ids.venue])).rows[0];
    return result;
  };
  const contextUrl=entryId=>`${origin}/api/payroll/calculation-entries/${entryId}/refund-aware-corrections`;
  const previewUrl=`${origin}/api/payroll/refund-aware-corrections/preview`,writeUrl=`${origin}/api/payroll/refund-aware-corrections`;
  const openCorrection=async(originalRun,originalEntry)=>{
    await openRun(originalRun);
    await page.locator(`[data-correction-original] option[value="${originalEntry}"]`).waitFor({state:'attached'});
    const loaded=page.waitForResponse(r=>r.url()===contextUrl(originalEntry)&&r.request().method()==='GET');
    await select(page,'[data-correction-original]',originalEntry);const response=await loaded;assert.equal(response.status(),200,await response.text());
    const context=await response.json();assert.equal(context.schemaVersion,3);assert.equal(context.policyCode,POLICY);
    await page.locator('[data-correction-preview]').waitFor();return context;
  };
  const previewCorrection=async(operation,targetEntryId)=>{
    if(operation==='waive')await select(page,'[data-correction-operation]','waive');
    else{assert.equal(await page.locator('[data-correction-target]').inputValue(),'','future target must be explicitly selected');
      await page.locator(`[data-correction-target] option[value="${targetEntryId}"]`).waitFor({state:'attached'});await select(page,'[data-correction-target]',targetEntryId);}
    const before=await snapshot(),responsePromise=page.waitForResponse(r=>r.url()===previewUrl&&r.request().method()==='POST');
    await page.locator('[data-correction-preview]').click();const response=await responsePromise;assert.equal(response.status(),200,await response.text());
    assert.deepEqual(await snapshot(),before,'period correction preview writes no payroll/claim/expense state');
    const plan=await response.json();assert.equal(plan.schemaVersion,3);assert.equal(plan.policyCode,POLICY);
    await page.locator('[data-correction-commit]').waitFor();return plan;
  };
  let interceptedError=null,routeHandler=null;
  const commitCorrection=async(originalEntry,operation,{lose=false}={})=>{
    await page.locator('[data-correction-reason]').fill(`Owner ${operation} whole period <script>escaped</script>`);
    let command,receipt,bytes;
    if(lose){
      routeHandler=async route=>{try{bytes=route.request().postData();command=route.request().postDataJSON();const response=await route.fetch({timeout:30000});
        assert.equal(response.status(),201,await response.text());receipt=await response.json();}catch(error){interceptedError=error;}finally{await route.abort('failed').catch(()=>{});}};
      await page.route(writeUrl,routeHandler,{times:1});await page.locator('[data-correction-commit]').click();
      await page.locator('[data-saved-run-status]').filter({hasText:'Результат запроса не подтверждён'}).waitFor();if(interceptedError)throw interceptedError;
      assert.ok(receipt?.batchId);const committed=await snapshot();
      await page.reload({waitUntil:'networkidle'});await openSaved();
      const replayResponse=page.waitForResponse(r=>r.url()===writeUrl&&r.request().method()==='POST');
      await page.locator(`[data-correction-retry="${originalEntry}"]`).click();const replay=await replayResponse;
      assert.equal(replay.status(),200,await replay.text());assert.equal(replay.request().postData(),bytes);
      assert.deepEqual(await replay.json(),{...receipt,replayed:true});assert.deepEqual(await snapshot(),committed,'reload exact retry creates no extra dispositions');
    }else{
      const written=page.waitForResponse(r=>r.url()===writeUrl&&r.request().method()==='POST');await page.locator('[data-correction-commit]').click();
      const response=await written;assert.equal(response.status(),201,await response.text());command=response.request().postDataJSON();receipt=await response.json();
    }
    assert.equal(receipt.schemaVersion,3);assert.equal(receipt.policyCode,POLICY);assert.equal(receipt.operation,operation);assert.equal(receipt.totalCents,500);
    const before=await snapshot(),replay=await api.post(writeUrl,{headers,data:command});assert.equal(replay.status(),200,await replay.text());
    assert.deepEqual(await replay.json(),{...receipt,replayed:true});assert.deepEqual(await snapshot(),before);
    return {command,receipt};
  };
  page.on('pageerror',onError);page.on('request',onRequest);
  try{
    const originalRun=await createRun(version.versionId,period,1000);
    const beforeDenied=await snapshot();
    for(const [deniedHeaders,status] of [[staffHeaders,403],[foreignHeaders,404]]) {
      if(!deniedHeaders)continue;
      const denied=await api.get(`${origin}/api/payroll/calculation-runs/${originalRun.runId}`,{headers:deniedHeaders});
      assert.equal(denied.status(),status,'v2 saved run stays owner/venue scoped');
      const createDenied=await api.post(`${origin}/api/payroll/refund-aware-calculation-runs`,{headers:deniedHeaders,
        data:{schemeVersionId:version.versionId,periodFrom:period.from,periodTo:period.to,idempotencyKey:`denied:${randomUUID()}`}});
      assert.equal(createDenied.status(),status===404?409:status,await createDenied.text());
      if(status===404)assert.equal((await createDenied.json()).error,'payroll_run_version_not_available');
    }
    assert.deepEqual(await snapshot(),beforeDenied);
    const original=await materialize(originalRun.runId,ids.employee,1000),zero=await materialize(originalRun.runId,ids.zeroEmployee,0);
    await transition(original.id,'approve',period,1000);const paid=await transition(original.id,'pay',period,1000);
    await transition(zero.id,'approve',period,0);await transition(zero.id,'pay',period,0);
    await capture('paid-zero',await registry(zero.id,period,{check:false}));
    const originalRow=(await pool.query('SELECT to_jsonb(t) data FROM payroll_entries t WHERE venue_id=$1 AND id=$2',[ids.venue,original.id])).rows[0].data;
    const originalSnapshot=await service.getSavedRun(owner,originalRun.runId);
    await refund('0.5',`public-v2-half-1:${randomUUID()}`);
    const zeroContext=await openCorrection(originalRun.runId,zero.id);assert.equal(zeroContext.remainingCents,0);
    const zeroPlan=await previewCorrection('waive',null);assert.equal(zeroPlan.waiveCents,0);assert.equal(await page.locator('[data-correction-commit]').isDisabled(),true);
    assert.match(await page.locator('[data-correction-plan]').innerText(),/новый долг не создаётся/);
    const targetVersion=(await service.createScheme(owner,{name:'Public v2 future five percent',
      payoutRiskAcknowledgement:{confirmed:true,policyCode:'payroll-own-revenue-ceiling-v1'},definition:{mode:'percent_only',currency:'RUB',
        effectiveFrom:targetPeriod.from,effectiveTo:targetPeriod.to,applyMilestones:false,roleParameters:{bar:{stableRateBps:500}},
        roleAssignments:[ids.employee,ids.zeroEmployee].map(employeeId=>({employeeId,roleId:'bar',effectiveFrom:targetPeriod.from,effectiveTo:targetPeriod.to})),
        employeeOverrides:[],itemRules:[],sourcePolicies}})).versions[0];
    await service.activateVersion(owner,targetVersion.versionId);
    const firstTargetRun=await createRun(targetVersion.versionId,targetPeriod,500),firstTarget=await materialize(firstTargetRun.runId,ids.employee,500);
    let context=await openCorrection(originalRun.runId,original.id);assert.equal(context.remainingCents,500);
    let plan=await previewCorrection('apply',firstTarget.id);assert.equal(plan.applyCents,500);assert.equal(plan.targetAfterCents,0);assert.equal(plan.residualReviewCents,0);
    await capture('period-apply',page.locator('[data-correction-plan]'));
    const csrf=await api.post(previewUrl,{headers:{...headers,origin:'https://foreign-origin.invalid'},data:{operation:'apply',originalEntryId:original.id,targetEntryId:firstTarget.id}});
    assert.equal(csrf.status(),403);
    const firstApply=await commitCorrection(original.id,'apply',{lose:true});
    await transition(firstTarget.id,'cancel',targetPeriod,0);
    context=await openCorrection(originalRun.runId,original.id);assert.equal(context.remainingCents,500);assert.deepEqual(context.history.map(row=>row.kind),['apply','release']);
    const firstHistorical=await api.post(writeUrl,{headers,data:firstApply.command});assert.equal(firstHistorical.status(),200);
    assert.equal((await firstHistorical.json()).batchId,firstApply.receipt.batchId);
    const nextTargetRun=await createRun(targetVersion.versionId,targetPeriod,500);assert.notEqual(nextTargetRun.runId,firstTargetRun.runId);
    const nextTarget=await materialize(nextTargetRun.runId,ids.employee,500);assert.notEqual(nextTarget.id,firstTarget.id);
    context=await openCorrection(originalRun.runId,original.id);assert.equal(context.remainingCents,500);
    plan=await previewCorrection('apply',nextTarget.id);assert.equal(plan.applyCents,500);assert.equal(plan.targetAfterCents,0);
    const secondApply=await commitCorrection(original.id,'apply');
    await transition(nextTarget.id,'approve',targetPeriod,0);await transition(nextTarget.id,'pay',targetPeriod,0);
    await capture('corrected-zero-paid',await registry(nextTarget.id,targetPeriod,{check:false}));
    await refund('0.5',`public-v2-half-2:${randomUUID()}`);
    context=await openCorrection(originalRun.runId,original.id);assert.equal(context.remainingCents,500);assert.equal(context.currentPotentialCents,1000);
    plan=await previewCorrection('waive',null);assert.equal(plan.waiveCents,500);assert.equal(plan.alreadyDisposedCents,500);assert.equal(plan.firstAssessedCents,500);
    await capture('period-waiver',page.locator('[data-correction-plan]'));const waiver=await commitCorrection(original.id,'waive');
    context=await openCorrection(originalRun.runId,original.id);assert.equal(context.remainingCents,0);assert.equal(context.currentPotentialCents,1000);
    assert.deepEqual(context.history.map(row=>row.kind),['apply','release','apply','waive']);
    assert.ok(context.history.every(row=>row.sourceKind==='period_v2'&&row.refundLineEventId===null));
    assert.doesNotMatch(await page.locator('[data-correction-context]').innerHTML(),/<script>/);
    const claims=(await pool.query(`SELECT assessed_cents::text,source_kind,refund_line_event_id,source_snapshot_line_id
      FROM payroll_correction_claims WHERE venue_id=$1 AND original_entry_id=$2`,[ids.venue,original.id])).rows;
    assert.deepEqual(claims,[{assessed_cents:'500',source_kind:'period_v2',refund_line_event_id:null,source_snapshot_line_id:null}]);
    assert.deepEqual((await pool.query('SELECT to_jsonb(t) data FROM payroll_entries t WHERE venue_id=$1 AND id=$2',[ids.venue,original.id])).rows[0].data,originalRow);
    assert.deepEqual(await service.getSavedRun(owner,originalRun.runId),originalSnapshot,'original 1000 run remains immutable');
    assert.equal((await service.replaySavedRun(owner,originalRun.runId)).verification.status,'matched');
    const expenses=(await pool.query('SELECT id,amount::text,payroll_calculation_entry_id FROM expenses WHERE venue_id=$1',[ids.venue])).rows;
    assert.deepEqual(expenses,[{id:paid.entry.expenseId,amount:'10.00',payroll_calculation_entry_id:original.id}]);
    const report=await api.get(`${origin}/api/finance/unified-report?from=${period.from}&to=${period.to}`,{headers});
    assert.equal(report.status(),200,await report.text());const finance=await report.json();
    const accruals=finance.items.payrollAccruals.filter(row=>row.payrollEntryId===original.id);
    const cash=finance.items.cashOutflows.filter(row=>row.id===paid.entry.expenseId);
    assert.equal(accruals.length,1);assert.equal(Number(accruals[0].recognizedInRange),10);
    assert.equal(cash.length,1);assert.equal(Number(cash[0].amount),10);
    for(const [deniedHeaders,status] of [[staffHeaders,403],[foreignHeaders,404]]) {
      if(!deniedHeaders)continue;
      const denied=await api.get(contextUrl(original.id),{headers:deniedHeaders});assert.equal(denied.status(),status);
      for(const [path,command] of [[previewUrl,{operation:'waive',originalEntryId:original.id,targetEntryId:null}],[writeUrl,waiver.command]]) {
        const refused=await api.post(path,{headers:deniedHeaders,data:command});assert.equal(refused.status(),status);
      }
    }
    assert.equal((await pool.query('SELECT status,amount::text FROM payroll_entries WHERE venue_id=$1 AND id=$2',[ids.venue,firstTarget.id])).rows[0].status,'cancelled');
    assert.deepEqual((await pool.query('SELECT status,amount::text,expense_id FROM payroll_entries WHERE venue_id=$1 AND id=$2',[ids.venue,nextTarget.id])).rows[0],{status:'paid',amount:'0.00',expense_id:null});
    assert.equal(requests.filter(row=>row.method==='POST'&&row.path==='/api/payroll/refund-aware-calculation-runs').length,3);
    assert.equal(requests.some(row=>row.path.startsWith('/api/payroll/reviewed-corrections')||/\/refund-reviews(?:\/|$)/.test(row.path)),false,'v2 never dispatches legacy correction/review APIs');
    assert.deepEqual(errors,[]);
    console.log(`PASS public v2 UI: create/materialize/positive+zero settlement, whole-period500 apply, lost-response exact reload, cancel/release, new target zero settlement, cumulative waiver500, stable claim/one expense/four widths; artifacts ${directory}`);
    return {status:'passed',originalRunId:originalRun.runId,originalEntryId:original.id,targetEntryId:nextTarget.id,
      expenseId:paid.entry.expenseId,firstApply,secondApply,waiver,artifacts};
  }finally{
    if(routeHandler)await page.unroute(writeUrl,routeHandler);page.off('pageerror',onError);page.off('request',onRequest);
    if(oldViewport)await page.setViewportSize(oldViewport);
  }
}
