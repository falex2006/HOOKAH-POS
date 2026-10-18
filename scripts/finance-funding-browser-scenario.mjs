import assert from 'node:assert/strict';

export async function verifyFundingBrowser({page,base,api,db,venueId,venueDate,bankId,selectPortalOption}) {
  const prefix=`QA funding ${process.pid}`;
  await page.goto(`${base}/finance/report`,{waitUntil:'networkidle'});
  const panel=page.locator('[data-finance-funding]');
  const before=(await db.query('SELECT count(*)::int AS count FROM expenses WHERE venue_id=$1',[venueId])).rows[0].count;
  async function create(kind,suffix,lose=false){
    const form=panel.locator('[data-funding-document]');
    await selectPortalOption(form.locator('[name="documentType"]'),kind);
    await form.locator('[name="counterpartyName"]').fill(`${prefix} ${suffix}`);
    await form.locator('[name="basis"]').fill(`${prefix} agreement`);
    if(kind==='loan'){
      await form.locator('[name="principalLimit"]').fill('10000000000000');
      const rejected=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/finance/funding-documents');
      await form.locator('[type="submit"]').click();assert.equal((await rejected).status(),400);
      await form.getByText('Документ отклонён. Исправьте поля и отправьте заново.',{exact:true}).waitFor();
      assert.equal(await form.locator('[name="principalLimit"]').isEnabled(),true);
      await form.locator('[name="principalLimit"]').fill('100');
    }
    const path='/api/finance/funding-documents';let lost=false;
    if(lose)await page.route(`**${path}`,async route=>{const response=await route.fetch();if(route.request().method()==='POST'&&!lost){lost=true;await route.fulfill({response,status:503,contentType:'application/json',body:JSON.stringify({error:'lost_funding_document_ack'})});}else await route.fulfill({response});});
    let response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===path);
    await form.locator('[type="submit"]').click();
    let result=await response;
    if(lose){assert.equal(result.status(),503);const key=await form.getAttribute('data-key');await page.reload({waitUntil:'networkidle'});assert.equal(await form.getAttribute('data-key'),key);assert.equal(await form.locator('[name="counterpartyName"]').inputValue(),`${prefix} ${suffix}`);response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===path);await form.locator('[type="submit"]').click();result=await response;assert.equal(result.status(),200);await page.unroute(`**${path}`);}else assert.equal(result.status(),201);
    const document=await result.json();
    await panel.locator(`[data-funding-event][data-document-id="${document.id}"]`).waitFor();
    return document.id;
  }
  async function event(id,type,amount,lose=false){
    const form=panel.locator(`[data-funding-event][data-document-id="${id}"]`);
    await selectPortalOption(form.locator('[name="eventType"]'),type);
    await form.locator('[name="amount"]').fill(amount);
    await form.locator('[name="eventDate"]').fill(venueDate);
    await selectPortalOption(form.locator('[name="financeAccountId"]'),bankId);
    await selectPortalOption(form.locator('[name="paymentMethod"]'),'bank_transfer');
    const path=`/api/finance/funding-documents/${id}/events`;let lost=false;
    if(lose)await page.route(`**${path}`,async route=>{const response=await route.fetch();if(route.request().method()==='POST'&&!lost){lost=true;await route.fulfill({response,status:503,contentType:'application/json',body:JSON.stringify({error:'lost_funding_event_ack'})});}else await route.fulfill({response});});
    let response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===path);
    const key=await form.getAttribute('data-key');
    await form.locator('[type="submit"]').click();let result=await response;
    if(lose){assert.equal(result.status(),503);await page.reload({waitUntil:'networkidle'});assert.equal(await form.getAttribute('data-key'),key);assert.equal(await form.locator('[name="amount"]').inputValue(),amount);response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===path);await form.locator('[type="submit"]').click();result=await response;assert.equal(result.status(),200);await page.unroute(`**${path}`);}else assert.equal(result.status(),201);
    await page.waitForFunction(({id,key})=>{const current=document.querySelector(`[data-funding-event][data-document-id="${id}"]`);return current&&current.dataset.key!==key&&!current.querySelector('[name="eventType"]').disabled;},{id,key});
    await page.reload({waitUntil:'networkidle'});
    return (await api(`/api/finance/funding-documents/${id}`)).body;
  }
  const contribution=await create('owner_contribution','owner');
  assert.equal((await event(contribution,'owner_contribution_received','500')).receivedAmount,'500.00');
  const loan=await create('loan','creditor',true);
  const received=await event(loan,'loan_principal_received','100',true);
  assert.equal(received.events.length,1);assert.equal(received.principalOutstanding,'100.00');
  const repaid=await event(loan,'loan_principal_repaid','40');
  assert.equal(repaid.events.length,2);assert.equal(repaid.principalOutstanding,'60.00');
  await panel.locator(`[data-funding-history="${loan}"] > summary`).click();
  await panel.locator(`[data-funding-history="${loan}"]`).getByText(/40/).first().waitFor();
  const report=await api(`/api/finance/unified-report?from=${venueDate}&to=${venueDate}&source=funding&q=${encodeURIComponent(prefix)}`);
  assert.equal(report.status,200,JSON.stringify(report.body));assert.equal(report.body.items.financingEvents.length,3);
  assert.ok(report.body.items.financingEvents.every(item=>item.pnlEffect==='none'));
  assert.equal((await db.query('SELECT count(*)::int AS count FROM expenses WHERE venue_id=$1',[venueId])).rows[0].count,before,'funding and loan repayment do not create operating expenses');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM finance_funding_documents WHERE venue_id=$1 AND counterparty_name LIKE $2',[venueId,prefix+'%'])).rows[0].count,2);
}
