'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { config, folder, options } = require('./staff-schedule-local-config.cjs');
const {Pool}=require('pg');
const {capturePolicy}=require('./staff-schedule-policy-fixture.cjs');
const {randomUUID}=require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_PATH || 'playwright');
async function main() {
  const c = config(), f = JSON.parse(fs.readFileSync(path.join(folder, 'fixtures.json'), 'utf8'));
  const base = `http://127.0.0.1:${c.appPort}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const pool=new Pool(options(c)),restorePolicy=await capturePolicy(pool,f.venues[0]);
  async function open(user) {
    const context = await browser.newContext({viewport:{width:1440,height:1000}});
    const response = await context.request.post(base+'/api/login',{data:{username:user.login,password:f.password}});
    assert.equal(response.status(),200);
    const session=await response.json();
    await context.addInitScript(({token,user})=>{localStorage.setItem('crm_session_token',token);localStorage.setItem('crm_session_user',JSON.stringify(user));},session);
    return {context,page:await context.newPage(),token:session.token};
  }
  try {
    await pool.query(`INSERT INTO staff_schedule_venue_policies(venue_id,max_weekly_minutes,created_by,updated_by) VALUES($1,1,$2,$2)
      ON CONFLICT(venue_id) DO UPDATE SET max_weekly_minutes=1,version=staff_schedule_venue_policies.version+1,updated_by=EXCLUDED.updated_by,updated_at=now()`,[f.venues[0],f.users[0].id]);
    const owner=await open(f.users[0]);
    await owner.page.goto(base+'/admin#staff-schedule');
    await owner.page.locator('[data-grants]:visible').waitFor();
    async function grant(user,access) {
      await owner.page.locator('[data-grants]').click();
      const select=owner.page.locator(`dialog [data-user="${user.id}"]`);
      await select.waitFor();
      if(await select.inputValue()!==access) {
        const response=owner.page.waitForResponse(r=>r.url().endsWith('/schedule/grants')&&r.request().method()==='PUT');
        await select.selectOption(access);
        assert.equal((await response).status(),200);
        await owner.page.locator('dialog [data-error]').filter({hasText:'Права сохранены'}).waitFor();
      }
      await owner.page.locator('dialog [data-close]').click();
    }
    for(const index of [1,2]) {
      const user=f.users[index]; await grant(user,'none');
      const actor=await open(user);
      await actor.page.goto(base+'/admin#staff-schedule');
      await actor.page.locator('#portal-session-guard').filter({hasText:'Доступ к этому разделу ограничен'}).waitFor();
      await grant(user,'view');
      await actor.page.reload(); await actor.page.locator('[data-context]').filter({hasText:'Asia/Yekaterinburg'}).waitFor({state:'attached'});
      assert.equal(await actor.page.locator('[data-create]').isVisible(),false);
      assert.equal(await actor.page.locator('[data-grants]').isVisible(),false);
      const readOnly=await actor.context.request.post(base+'/api/staff/schedule',{headers:{Authorization:`Bearer ${actor.token}`},data:{}});
      assert.equal(readOnly.status(),403);
      await grant(user,'manage');
      await actor.page.reload(); await actor.page.locator('[data-create]:visible').waitFor();
      assert.equal(await actor.page.locator('[data-grants]').isVisible(),false);
      const employee=randomUUID();
      await pool.query("INSERT INTO users(id,venue_id,organization_id,full_name,login,role) VALUES($1,$2,$3,'Role write QA',$4,'bartender')",[employee,f.venues[0],f.organizations[0],`${employee}@example.test`]);
      await actor.page.reload();await actor.page.locator('[data-context]').filter({hasText:'Asia/Yekaterinburg'}).waitFor({state:'attached'});
      await actor.page.locator('[data-create]').click(); await actor.page.locator('dialog[open]').waitFor();
      const dialog=actor.page.locator('dialog[open]'),day=await actor.page.locator('[data-date]').inputValue();
      await dialog.locator('[name=userId]').selectOption(employee);
      await dialog.locator('[name=start]').fill(day+'T10:00');await dialog.locator('[name=end]').fill(day+'T18:00');
      const rejected=actor.page.waitForResponse(r=>r.url().endsWith('/api/staff/schedule')&&r.request().method()==='POST'&&r.status()===409);
      await dialog.getByRole('button',{name:'Добавить в график',exact:true}).click();
      assert.equal((await rejected).status(),409);await dialog.locator('[name=reason]').fill('Подтверждение предупреждений role QA');await dialog.locator('[name=confirmWarnings]').check();
      const saved=actor.page.waitForResponse(r=>r.url().endsWith('/api/staff/schedule')&&r.request().method()==='POST'&&r.status()===201);await dialog.locator('form').evaluate(form=>form.requestSubmit());
      const response=await saved;assert.equal(response.status(),201);const record=await response.json();
      assert.equal((await pool.query('SELECT created_by FROM staff_schedules WHERE id=$1',[record.id])).rows[0].created_by,user.id);
      await actor.page.reload();
      try { await actor.page.locator(`[data-entry="${record.id}"]:visible`).waitFor(); }
      catch(error){await actor.page.screenshot({path:path.join(folder,`role-${user.role}-reload-failure.png`)});console.error(JSON.stringify({role:user.role,recordDate:record.workDate,date:await actor.page.locator('[data-date]').inputValue().catch(()=>null),status:await actor.page.locator('[data-status]').textContent().catch(()=>null),guard:await actor.page.locator('#portal-session-guard').textContent().catch(()=>null)}));throw error;}
      await grant(user,'none');
      const denied=await actor.context.request.get(base+'/api/staff/schedule/employees',{headers:{Authorization:`Bearer ${actor.token}`}});
      assert.equal(denied.status(),403);
      const writeDenied=await actor.context.request.patch(base+'/api/staff/schedule/'+record.id,{headers:{Authorization:`Bearer ${actor.token}`},data:{status:'cancelled',version:1,reason:'Denied after revoke',requestKey:randomUUID()}});
      assert.equal(writeDenied.status(),403);
      assert.equal((await pool.query('SELECT status FROM staff_schedules WHERE id=$1',[record.id])).rows[0].status,'planned');
      await actor.page.reload(); await actor.page.locator('#portal-session-guard').filter({hasText:'Доступ к этому разделу ограничен'}).waitFor();
      await actor.context.close();
      console.log(`SCHEDULE ROLE UI ${user.role}: PASS owner grants, actual form save201/DB author/reload; revoke denies same-token reads/writes with unchanged DB`);
    }
    await owner.context.close();
  } finally {await browser.close();await restorePolicy();await pool.end();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
