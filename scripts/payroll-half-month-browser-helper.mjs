import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { seedUnpaidSupersessionFixture } from './payroll-unpaid-supersession-fixture.mjs';

const require = createRequire(import.meta.url);

// Only called by the isolated payroll browser runner. The source sale is 100 ₽
// on the 1st; one approved full shift pays 10 ₽. Its 10% monthly commission
// matures at month close, so both actual payments must be exactly 10 ₽.
export async function seedHalfMonthBrowser(pool, sourcePolicies) {
  const period = (await pool.query(`SELECT
    (date_trunc('month', CURRENT_DATE)-interval '2 months')::date::text AS "from",
    (date_trunc('month', CURRENT_DATE)-interval '1 month 1 day')::date::text AS "to"`)).rows[0];
  const firstEnd = period.from.slice(0, 8) + '14';
  const fixture = await seedUnpaidSupersessionFixture({pool, period, sourcePolicies, withSecondPositiveSale:true});
  const {ids, owner, service} = fixture;
  const schedule = require('../staff-schedule-service');
  const attendance = require('../payroll-attendance-manifest').makePayrollAttendanceManifestService(pool);
  const workDate = period.from;
  for (const employeeId of [ids.employee, ids.zeroEmployee]) {
    await schedule.save(pool, owner, {userId:employeeId, kind:'shift', workDate, breakMinutes:0,
      plannedStart:workDate+'T10:00:00Z', plannedEnd:workDate+'T18:00:00Z', requestKey:randomUUID(), reason:'Browser payroll QA'});
    await pool.query(`INSERT INTO staff_work_logs(venue_id,user_id,started_at,ended_at,source)
      VALUES($1,$2,$3,$4,'manual')`, [ids.venue,employeeId,workDate+'T10:00:00Z',workDate+'T18:00:00Z']);
  }
  for (const end of [firstEnd,period.to]) {
    const range = {periodFrom:period.from,periodTo:end};
    const evidence = await attendance.readCoverage(owner,range);
    await attendance.approveCoverage(owner,{...range,reason:'Confirmed half-month fixture',idempotencyKey:randomUUID(),sourceWatermark:evidence.sourceWatermark});
  }
  const scheme = await service.createScheme(owner,{name:'Оклад за смену и процент по итогу месяца',
    definition:{mode:'final_month_threshold',currency:'RUB',effectiveFrom:period.from,effectiveTo:period.to,
      applyMilestones:false,roleParameters:{bar:{perShiftCents:1000,bracketRatesBps:{0:1000}}},
      roleAssignments:[ids.employee,ids.zeroEmployee].map(employeeId=>({employeeId,roleId:'bar',effectiveFrom:period.from,effectiveTo:period.to})),
      employeeOverrides:[],itemRules:[],sourcePolicies},
    payoutRiskAcknowledgement:{confirmed:true,policyCode:'payroll-own-revenue-ceiling-v1'}});
  const versionId = scheme.versions[0].versionId;
  await service.activateVersion(owner,versionId);
  return {ids,period,firstEnd,versionId};
}

export async function verifyHalfMonthBrowser({page,base,pool,fixture}) {
  const {ids,period,firstEnd,versionId}=fixture;
  const post = async (url,click) => {
    const [response] = await Promise.all([page.waitForResponse(r=>r.url()===base+url && r.request().method()==='POST'), click()]);
    const text=await response.text();
    assert.ok(response.ok(),url+' returned '+response.status()+' '+text.slice(0,400));
    const body=JSON.parse(text);
    return {body,request:response.request().postDataJSON()};
  };
  const workspace = async () => {
    await page.goto(base+'/finance#payroll',{waitUntil:'networkidle'});
    const summary=page.getByText('Настройки схем и проверка расчётов',{exact:true});
    if (!await summary.locator('..').evaluate(node=>node.open)) await summary.click();
    await page.locator('[data-scheme-workspace="saved"]').click();
    const select=page.locator('[data-saved-run-version]');
    await select.locator('option[value="'+versionId+'"]').waitFor({state:'attached'});
    const wrapper=select.locator('..'), trigger=wrapper.locator('.custom-select-trigger');
    if (await trigger.count()) {
      await trigger.click(); await wrapper.locator('[data-value="'+versionId+'"]').click();
    } else await select.selectOption(versionId);
  };
  const payoutRows=async()=> (await pool.query(`SELECT id::text,(amount*100)::bigint::text AS cents
    FROM expenses WHERE venue_id=$1 AND source='payroll' ORDER BY id`,[ids.venue])).rows;
  assert.deepEqual(await payoutRows(),[]);
  const expenseIds=[];
  const colleagueId=ids.zeroEmployee;
  let colleagueDraft;
  const readColleagueEntries=async()=> (await pool.query(
    'SELECT id,status,payroll_half_kind AS half,expense_id FROM payroll_entries WHERE venue_id=$1 AND user_id=$2 ORDER BY id',
    [ids.venue,colleagueId])).rows;
  for (const first of [true,false]) {
    await workspace();
    await page.locator('[data-saved-run-from]').fill(period.from);
    await page.locator('[data-saved-run-to]').fill(first ? firstEnd : period.to);
    const url='/api/payroll/'+(first ? 'h1-calculation-runs' : 'refund-aware-calculation-runs');
    const {body:run}=await post(url,()=>page.locator(first?'[data-saved-h1-create]':'[data-saved-run-create]').click());
    assert.equal(run.status,'ready');
    await page.locator('[data-saved-run-open="'+run.runId+'"]').click();
    const cell=page.locator('[data-saved-entry-employee="'+ids.employee+'"]');
    const path='/api/payroll/calculation-runs/'+run.runId+'/'+(first?'h1-entries':'h2-entries');
    const colleague=page.locator('[data-saved-entry-employee="'+colleagueId+'"]');
    if (first) {
      const {body}=await post(path,()=>colleague.getByRole('button',{name:/черновик за 1–14 число/i}).click());
      const draft=Object.hasOwn(body,'currentEntry') ? body.currentEntry : body.entry;
      assert.equal(draft.userId,colleagueId);
      assert.equal(draft.amountCents,1000,'colleague has positive earned pay');
      assert.equal(draft.status,'draft');
      colleagueDraft=[{id:draft.id,status:'draft',half:'h1',expense_id:null}];
    } else {
      await colleague.locator('text=/утвердите начисление за 1–14 число/i').waitFor();
      assert.equal(await colleague.getByRole('button',{name:/за вторую половину/i}).count(),0);
    }
    const {body:materialized}=await post(path,()=>cell.getByRole('button',{name:first?/черновик за 1–14 число/i:/за вторую половину/i}).click());
    const entry=Object.hasOwn(materialized,'currentEntry') ? materialized.currentEntry : materialized.entry;
    assert.equal(entry.halfKind,first ? 'h1' : 'h2');
    assert.equal(entry.amountCents,1000);
    await page.goto(base+'/finance#payroll',{waitUntil:'networkidle'});
    await page.locator('#payroll-filter-from').fill(period.from);
    await page.locator('#payroll-filter-to').fill(period.to);
    await page.locator('#payroll-reload').click();
    const row=page.locator('[data-payroll-entry="'+entry.id+'"]'), transition='/api/payroll/calculation-entries/'+entry.id+'/transition';
    const checkAction = async action => {
      const stateUrl = base + transition.replace(/transition$/, 'state');
      const [response] = await Promise.all([
        page.waitForResponse(r => r.url() === stateUrl && r.request().method() === 'GET'),
        row.locator('[data-payroll-linked-check]').click()
      ]);
      const text = await response.text();
      assert.ok(response.ok(), stateUrl+' returned '+response.status()+' '+text.slice(0,400));
      const state = JSON.parse(text);
      assert.ok(state.allowedActions?.includes(action), JSON.stringify({
        half:entry.halfKind,action,allowed:state.allowedActions,sourceStatus:state.sourceStatus,
        reasons:state.blockedReason || state.reasons || state.blockers,entryStatus:state.entry?.status
      }));
    };
    await checkAction('approve');
    await post(transition,()=>row.locator('[data-payroll-action="approve"]').click());
    await checkAction('pay');
    await row.locator('[data-payroll-payment-date]').fill(period.to);
    // Lose only the response. The payment passes through the real HTTP handler.
    let firstPayment, command;
    await page.route(base+transition,async route=>{
      command=route.request().postDataJSON();
      const response=await route.fetch();
      assert.equal(response.status(),200,await response.text());
      firstPayment=await response.json();
      await route.abort('failed');
    },{times:1});
    await row.locator('[data-payroll-action="pay"]').click();
    await page.locator('#payroll-message').filter({hasText:'Ответ не подтверждён'}).waitFor();
    assert.equal(firstPayment.entry.status,'paid');
    expenseIds.push(firstPayment.entry.expenseId);
    await page.reload({waitUntil:'networkidle'});
    const retry=await post(transition,()=>page.locator('[data-payroll-linked-recovery] [data-payroll-linked-retry="'+entry.id+'"]').click());
    assert.deepEqual(retry.request,command);
    assert.equal(retry.body.replayed,true);
    assert.equal(retry.body.entry.expenseId,firstPayment.entry.expenseId);
    assert.deepEqual(await readColleagueEntries(),colleagueDraft,'payment and retry of A preserve B draft without expense or H2');
    const expenses=await payoutRows();
    assert.deepEqual(expenses.map(x=>x.id),[...expenseIds].sort());
    assert.deepEqual(expenses.map(x=>x.cents),expenseIds.map(()=>'1000'));
  }
  assert.equal(new Set(expenseIds).size,2);
  console.log('PASS real browser H1 10 ₽ + H2 10 ₽, exact pay retries, two linked PostgreSQL expenses; positive H1 of colleague remains a draft');
}
